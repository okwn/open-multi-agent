import { describe, it, expect } from 'vitest'
import { SharedMemory } from '../src/memory/shared.js'
import { Team } from '../src/team/team.js'
import type { MemoryEntry, MemoryStore } from '../src/types.js'

describe('SharedMemory', () => {
  // -------------------------------------------------------------------------
  // Write & read
  // -------------------------------------------------------------------------

  it('writes and reads a value under a namespaced key', async () => {
    const mem = new SharedMemory()
    await mem.write('researcher', 'findings', 'TS 5.5 ships const type params')

    const entry = await mem.read('researcher/findings')
    expect(entry).not.toBeNull()
    expect(entry!.value).toBe('TS 5.5 ships const type params')
  })

  it('returns null for a non-existent key', async () => {
    const mem = new SharedMemory()
    expect(await mem.read('nope/nothing')).toBeNull()
  })

  // -------------------------------------------------------------------------
  // Namespace isolation
  // -------------------------------------------------------------------------

  it('isolates writes between agents', async () => {
    const mem = new SharedMemory()
    await mem.write('alice', 'plan', 'plan A')
    await mem.write('bob', 'plan', 'plan B')

    const alice = await mem.read('alice/plan')
    const bob = await mem.read('bob/plan')
    expect(alice!.value).toBe('plan A')
    expect(bob!.value).toBe('plan B')
  })

  it('listByAgent returns only that agent\'s entries', async () => {
    const mem = new SharedMemory()
    await mem.write('alice', 'a1', 'v1')
    await mem.write('alice', 'a2', 'v2')
    await mem.write('bob', 'b1', 'v3')

    const aliceEntries = await mem.listByAgent('alice')
    expect(aliceEntries).toHaveLength(2)
    expect(aliceEntries.every((e) => e.key.startsWith('alice/'))).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Overwrite
  // -------------------------------------------------------------------------

  it('overwrites a value and preserves createdAt', async () => {
    const mem = new SharedMemory()
    await mem.write('agent', 'key', 'first')
    const first = await mem.read('agent/key')

    await mem.write('agent', 'key', 'second')
    const second = await mem.read('agent/key')

    expect(second!.value).toBe('second')
    expect(second!.createdAt.getTime()).toBe(first!.createdAt.getTime())
  })

  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------

  it('stores metadata alongside the value', async () => {
    const mem = new SharedMemory()
    await mem.write('agent', 'key', 'val', { priority: 'high' })

    const entry = await mem.read('agent/key')
    expect(entry!.metadata).toMatchObject({ priority: 'high', agent: 'agent' })
  })

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------

  it('returns empty string for an empty store', async () => {
    const mem = new SharedMemory()
    expect(await mem.getSummary()).toBe('')
  })

  it('produces a markdown summary grouped by agent', async () => {
    const mem = new SharedMemory()
    await mem.write('researcher', 'findings', 'result A')
    await mem.write('coder', 'plan', 'implement X')

    const summary = await mem.getSummary()
    expect(summary).toContain('## Shared Team Memory')
    expect(summary).toContain('### researcher')
    expect(summary).toContain('### coder')
    expect(summary).toContain('findings: result A')
    expect(summary).toContain('plan: implement X')
  })

  it('truncates long values in the summary', async () => {
    const mem = new SharedMemory()
    const longValue = 'x'.repeat(300)
    await mem.write('agent', 'big', longValue)

    const summary = await mem.getSummary()
    // Summary truncates at 200 chars → 197 + '…'
    expect(summary.length).toBeLessThan(longValue.length)
    expect(summary).toContain('…')
  })

  it('filters summary to only requested task IDs', async () => {
    const mem = new SharedMemory()
    await mem.write('alice', 'task:t1:result', 'output 1')
    await mem.write('bob', 'task:t2:result', 'output 2')
    await mem.write('alice', 'notes', 'not a task result')

    const summary = await mem.getSummary({ taskIds: ['t2'] })
    expect(summary).toContain('### bob')
    expect(summary).toContain('task:t2:result: output 2')
    expect(summary).not.toContain('task:t1:result: output 1')
    expect(summary).not.toContain('notes: not a task result')
  })

  // -------------------------------------------------------------------------
  // listAll
  // -------------------------------------------------------------------------

  it('listAll returns entries from all agents', async () => {
    const mem = new SharedMemory()
    await mem.write('a', 'k1', 'v1')
    await mem.write('b', 'k2', 'v2')

    const all = await mem.listAll()
    expect(all).toHaveLength(2)
  })

  // -------------------------------------------------------------------------
  // Custom MemoryStore injection (issue #156)
  // -------------------------------------------------------------------------

  describe('custom MemoryStore injection', () => {
    /** Recording store that forwards to an internal map and tracks every call. */
    class RecordingStore implements MemoryStore {
      readonly data = new Map<string, MemoryEntry>()
      readonly setCalls: Array<{ key: string; value: string }> = []

      async get(key: string): Promise<MemoryEntry | null> {
        return this.data.get(key) ?? null
      }
      async set(
        key: string,
        value: string,
        metadata?: Record<string, unknown>,
      ): Promise<void> {
        this.setCalls.push({ key, value })
        this.data.set(key, { key, value, metadata, createdAt: new Date() })
      }
      async list(): Promise<MemoryEntry[]> {
        return Array.from(this.data.values())
      }
      async delete(key: string): Promise<void> {
        this.data.delete(key)
      }
      async clear(): Promise<void> {
        this.data.clear()
      }
    }

    it('routes writes through an injected MemoryStore', async () => {
      const store = new RecordingStore()
      const mem = new SharedMemory(store)
      await mem.write('alice', 'plan', 'v1')

      expect(store.setCalls).toEqual([{ key: 'alice/plan', value: 'v1' }])
    })

    it('preserves `<agent>/<key>` namespace prefix on the underlying store', async () => {
      const store = new RecordingStore()
      const mem = new SharedMemory(store)
      await mem.write('bob', 'notes', 'hello')

      const entry = await store.get('bob/notes')
      expect(entry?.value).toBe('hello')
    })

    it('getSummary reads from the injected store', async () => {
      const store = new RecordingStore()
      const mem = new SharedMemory(store)
      await mem.write('alice', 'k', 'val')

      const summary = await mem.getSummary()
      expect(summary).toContain('### alice')
      expect(summary).toContain('k: val')
    })

    it('getStore returns the injected store', () => {
      const store = new RecordingStore()
      const mem = new SharedMemory(store)
      expect(mem.getStore()).toBe(store)
    })

    it('Team wires `sharedMemoryStore` into its SharedMemory', async () => {
      const store = new RecordingStore()
      const team = new Team({
        name: 'injection-team',
        agents: [{ name: 'alice', model: 'claude-sonnet-4-6' }],
        sharedMemoryStore: store,
      })

      const sharedMem = team.getSharedMemoryInstance()
      expect(sharedMem).toBeDefined()
      await sharedMem!.write('alice', 'fact', 'committed')

      expect(store.setCalls).toEqual([{ key: 'alice/fact', value: 'committed' }])
    })

    it('Team: `sharedMemoryStore` takes precedence over `sharedMemory: false`', () => {
      const store = new RecordingStore()
      const team = new Team({
        name: 'override-team',
        agents: [{ name: 'alice', model: 'claude-sonnet-4-6' }],
        sharedMemory: false,
        sharedMemoryStore: store,
      })

      // Custom store wins: memory is enabled even though the boolean is false.
      expect(team.getSharedMemoryInstance()).toBeDefined()
      expect(team.getSharedMemory()).toBe(store)
    })

    it('Team: neither flag → no shared memory (backward compat)', () => {
      const team = new Team({
        name: 'no-memory-team',
        agents: [{ name: 'alice', model: 'claude-sonnet-4-6' }],
      })
      expect(team.getSharedMemoryInstance()).toBeUndefined()
    })

    it('Team: `sharedMemory: true` only → default InMemoryStore (backward compat)', () => {
      const team = new Team({
        name: 'default-memory-team',
        agents: [{ name: 'alice', model: 'claude-sonnet-4-6' }],
        sharedMemory: true,
      })
      expect(team.getSharedMemoryInstance()).toBeDefined()
      expect(team.getSharedMemory()).toBeDefined()
    })

    // -----------------------------------------------------------------------
    // Shape validation — defends against malformed `sharedMemoryStore`
    // (e.g. plain objects from untrusted JSON) reaching SharedMemory.
    // -----------------------------------------------------------------------

    it('SharedMemory throws when store is a plain object missing methods', () => {
      const plain = { foo: 'bar' } as unknown as MemoryStore
      expect(() => new SharedMemory(plain)).toThrow(TypeError)
      expect(() => new SharedMemory(plain)).toThrow(/MemoryStore interface/)
    })

    it('SharedMemory throws when store is missing a single method', () => {
      const partial = {
        get: async () => null,
        set: async () => undefined,
        list: async () => [],
        delete: async () => undefined,
        // `clear` missing
      } as unknown as MemoryStore
      expect(() => new SharedMemory(partial)).toThrow(TypeError)
    })

    it('SharedMemory throws when store is null (cast)', () => {
      expect(() => new SharedMemory(null as unknown as MemoryStore)).toThrow(TypeError)
    })

    it('Team throws early on malformed `sharedMemoryStore`', () => {
      const bogus = { not: 'a store' } as unknown as MemoryStore
      expect(
        () =>
          new Team({
            name: 'bad-team',
            agents: [{ name: 'alice', model: 'claude-sonnet-4-6' }],
            sharedMemoryStore: bogus,
          }),
      ).toThrow(TypeError)
    })

    it('Team throws on falsy-but-present sharedMemoryStore (null)', () => {
      // `null` is falsy but present; a truthy gate would silently drop it.
      // The `!== undefined` gate routes it through SharedMemory's shape check
      // so config bugs fail fast instead of being silently downgraded.
      expect(
        () =>
          new Team({
            name: 'null-store-team',
            agents: [{ name: 'alice', model: 'claude-sonnet-4-6' }],
            sharedMemoryStore: null as unknown as MemoryStore,
          }),
      ).toThrow(TypeError)
    })

    it('Team: omitting sharedMemoryStore entirely still honors sharedMemory: true', () => {
      // Sanity check that the `!== undefined` gate does not accidentally
      // enable memory when the field is absent.
      const team = new Team({
        name: 'absent-store-team',
        agents: [{ name: 'alice', model: 'claude-sonnet-4-6' }],
        sharedMemory: true,
      })
      expect(team.getSharedMemoryInstance()).toBeDefined()
    })
  })

  describe('turn-TTL (writeExpiring + advanceTurn)', () => {
    it('writeExpiring entries are readable until the turn counter reaches expiry', async () => {
      const mem = new SharedMemory()
      await mem.writeExpiring('alice', 'short-lived', 'still here', 2)

      // turn 0: readable
      expect(await mem.read('alice/short-lived')).not.toBeNull()
      mem.advanceTurn()
      // turn 1: readable
      expect(await mem.read('alice/short-lived')).not.toBeNull()
      mem.advanceTurn()
      // turn 2: expired (currentTurn 2 >= expiresAtTurn 2)
      expect(await mem.read('alice/short-lived')).toBeNull()
    })

    it('write (no TTL) entries persist regardless of turn count', async () => {
      const mem = new SharedMemory()
      await mem.write('alice', 'permanent', 'forever')
      for (let i = 0; i < 100; i++) mem.advanceTurn()
      expect(await mem.read('alice/permanent')).not.toBeNull()
    })

    it('listAll / listByAgent / getSummary all filter expired entries', async () => {
      const mem = new SharedMemory()
      await mem.write('alice', 'kept', 'alive')
      await mem.writeExpiring('alice', 'dropped', 'gone', 1)
      mem.advanceTurn() // expires the second entry

      expect(await mem.listAll()).toHaveLength(1)
      expect(await mem.listByAgent('alice')).toHaveLength(1)
      const summary = await mem.getSummary()
      expect(summary).toContain('kept')
      expect(summary).not.toContain('dropped')
    })

    it('writeExpiring degrades to plain set when the store lacks setWithExpiry', async () => {
      // Custom stores satisfying only the required MemoryStore methods (no
      // setWithExpiry) still work — the entry persists indefinitely instead
      // of expiring. Documented behaviour, exercised here.
      const data = new Map<string, MemoryEntry>()
      const customStore: MemoryStore = {
        async get(key) { return data.get(key) ?? null },
        async set(key, value, metadata) {
          data.set(key, { key, value, metadata, createdAt: new Date() })
        },
        async list() { return Array.from(data.values()) },
        async delete(key) { data.delete(key) },
        async clear() { data.clear() },
      }
      const mem = new SharedMemory(customStore)
      await mem.writeExpiring('alice', 'ttl-ignored', 'still here', 1)
      mem.advanceTurn()
      // Custom store didn't record expiry, so the entry is still readable.
      expect(await mem.read('alice/ttl-ignored')).not.toBeNull()
    })

    it('getTurnCount reflects advanceTurn calls', async () => {
      const mem = new SharedMemory()
      expect(mem.getTurnCount()).toBe(0)
      mem.advanceTurn()
      mem.advanceTurn()
      mem.advanceTurn()
      expect(mem.getTurnCount()).toBe(3)
    })

    it('writeExpiring throws RangeError on non-positive-integer ttlTurns', async () => {
      const mem = new SharedMemory()
      for (const bad of [0, -1, 1.5, NaN, Infinity]) {
        await expect(
          mem.writeExpiring('alice', 'k', 'v', bad),
        ).rejects.toThrow(RangeError)
      }
    })

    it('expired entries remain in the underlying store (no destructive cleanup on read)', async () => {
      // Race-safe: in distributed stores (Redis/Postgres), deleting on read
      // would stomp on a concurrent write. SharedMemory only filters; store
      // impls do their own GC. Regression guard for the original review.
      const mem = new SharedMemory()
      const store = mem.getStore()
      await mem.writeExpiring('alice', 'gone', 'soon', 1)
      mem.advanceTurn() // expires it

      // SharedMemory hides the expired entry from callers...
      expect(await mem.read('alice/gone')).toBeNull()
      expect(await mem.listAll()).toHaveLength(0)
      expect(await mem.getSummary()).toBe('')

      // ...but the underlying store still has it (didn't get deleted).
      expect(await store.get('alice/gone')).not.toBeNull()
      expect(await store.list()).toHaveLength(1)
    })

    it('expiresAtTurn is set correctly at write time', async () => {
      const mem = new SharedMemory()
      await mem.writeExpiring('alice', 't1', 'v1', 3)
      // turnCount is 0, expiresAtTurn should be 0 + 3 = 3
      const entry = await mem.getStore().get('alice/t1')
      expect(entry?.expiresAtTurn).toBe(3)

      mem.advanceTurn()
      await mem.writeExpiring('bob', 't2', 'v2', 2)
      // turnCount is now 1, expiresAtTurn should be 1 + 2 = 3
      const bobEntry = await mem.getStore().get('bob/t2')
      expect(bobEntry?.expiresAtTurn).toBe(3)
    })

    it('multiple tasks in same batch share initial turn count', async () => {
      // Simulate a parallel batch: all tasks see turnCount=0 when they write.
      // Task A (alice) writes with ttlTurns=2 -> expires at turn 2
      // Task B (bob)   writes with ttlTurns=2 -> expires at turn 2
      // Task C (carol) writes with ttlTurns=1 -> expires at turn 1
      const mem = new SharedMemory()
      mem.advanceTurn() // turn = 1 (first advanceTurn in orchestrator loop)

      // Simulate two tasks writing before their results complete:
      // This is the key parallel semantics issue: if tasks run concurrently
      // and complete in a different order than they started, the turn counter
      // advances per completed task, not per started task.
      await mem.writeExpiring('alice', 't1', 'v1', 1) // expires at turn 2
      await mem.writeExpiring('bob', 't2', 'v2', 1) // expires at turn 2

      // Both should be readable at turn 1
      expect(await mem.read('alice/t1')).not.toBeNull()
      expect(await mem.read('bob/t2')).not.toBeNull()

      // First completion advances turn to 2 — both expire simultaneously
      mem.advanceTurn()
      expect(await mem.read('alice/t1')).toBeNull()
      expect(await mem.read('bob/t2')).toBeNull()
    })

    it('faster task completing first advances turn before slower task reads', async () => {
      // Document the race: if Task A (fast) and Task B (slow) run in parallel,
      // Task A completes first -> turn advances to 1 -> Task B's TTL entry
      // may expire sooner than expected if Task B started at turn 0 and uses ttlTurns=1.
      const mem = new SharedMemory()
      // Initial state: turn = 0

      // Task A (alice): writes entry with ttl=1, expires at turn 1
      await mem.writeExpiring('alice', 't1', 'v1', 1)

      // Task B (bob): writes entry with ttl=2, expires at turn 2
      await mem.writeExpiring('bob', 't2', 'v2', 2)

      // Simulate Task A completing first (advanceTurn called once)
      mem.advanceTurn() // turn = 1

      // alice/t1 is now expired (turn >= expiresAtTurn)
      expect(await mem.read('alice/t1')).toBeNull()

      // bob/t2 is still live (turn 1 < expiresAtTurn 2)
      expect(await mem.read('bob/t2')).not.toBeNull()

      // Second completion (Task B) advances turn to 2
      mem.advanceTurn() // turn = 2
      expect(await mem.read('bob/t2')).toBeNull()
    })

    it('concurrent writeExpiring calls produce correct individual expiresAtTurn values', async () => {
      // Even though writeExpiring calls happen in sequence (JS is single-threaded),
      // they all observe the same initial turnCount. Subsequent advanceTurn calls
      // may then expire them out of order.
      const mem = new SharedMemory()
      expect(mem.getTurnCount()).toBe(0)

      await mem.writeExpiring('a', 'k1', 'v1', 2) // expires at turn 2
      await mem.writeExpiring('b', 'k2', 'v2', 2) // expires at turn 2
      await mem.writeExpiring('c', 'k3', 'v3', 1) // expires at turn 1

      // All written at turn 0, so expiresAtTurn is absolute (not relative)
      const entry1 = await mem.getStore().get('a/k1')
      const entry2 = await mem.getStore().get('b/k2')
      const entry3 = await mem.getStore().get('c/k3')

      expect(entry1?.expiresAtTurn).toBe(2)
      expect(entry2?.expiresAtTurn).toBe(2)
      expect(entry3?.expiresAtTurn).toBe(1)

      // Advance once: only k3 expires
      mem.advanceTurn()
      expect(await mem.read('a/k1')).not.toBeNull()
      expect(await mem.read('b/k2')).not.toBeNull()
      expect(await mem.read('c/k3')).toBeNull()

      // Advance twice: k1 and k2 expire
      mem.advanceTurn()
      expect(await mem.read('a/k1')).toBeNull()
      expect(await mem.read('b/k2')).toBeNull()
    })

    it('writeExpiring then overwrite with write() removes expiresAtTurn', async () => {
      const mem = new SharedMemory()
      await mem.writeExpiring('alice', 'key', 'ttl-value', 1)
      expect((await mem.getStore().get('alice/key'))?.expiresAtTurn).toBe(1)

      // Overwrite without TTL
      await mem.write('alice', 'key', 'permanent-value')
      const entry = await mem.getStore().get('alice/key')
      expect(entry?.expiresAtTurn).toBeUndefined()
      expect(entry?.value).toBe('permanent-value')

      mem.advanceTurn() // would have expired the TTL version
      expect(await mem.read('alice/key')).not.toBeNull() // permanent, never expires
    })

    it('writeExpiring then overwrite with writeExpiring updates expiresAtTurn', async () => {
      const mem = new SharedMemory()
      await mem.writeExpiring('alice', 'key', 'v1', 1)
      expect((await mem.getStore().get('alice/key'))?.expiresAtTurn).toBe(1)

      mem.advanceTurn() // turn = 1, entry now expired from alice's perspective

      await mem.writeExpiring('alice', 'key', 'v2', 2) // new expires at turn 3

      const entry = await mem.getStore().get('alice/key')
      expect(entry?.value).toBe('v2')
      expect(entry?.expiresAtTurn).toBe(3)
      // Still readable (turn 1 < 3)
      expect(await mem.read('alice/key')).not.toBeNull()

      mem.advanceTurn() // turn = 2
      expect(await mem.read('alice/key')).not.toBeNull()

      mem.advanceTurn() // turn = 3
      expect(await mem.read('alice/key')).toBeNull()
    })

    it('very short ttl (1 turn) expires correctly', async () => {
      const mem = new SharedMemory()
      await mem.writeExpiring('alice', 'one-turn', 'value', 1)
      expect(await mem.read('alice/one-turn')).not.toBeNull()

      mem.advanceTurn() // turn = 1, now equals expiresAtTurn
      expect(await mem.read('alice/one-turn')).toBeNull()
    })

    it('ttl with large value does not affect expiration logic', async () => {
      const mem = new SharedMemory()
      const largeValue = 'x'.repeat(100_000)
      await mem.writeExpiring('alice', 'big', largeValue, 1)

      expect(await mem.read('alice/big')).not.toBeNull()
      mem.advanceTurn()
      expect(await mem.read('alice/big')).toBeNull()
    })
  })
})
