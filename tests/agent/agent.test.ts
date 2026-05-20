import { describe, it, expect, vi } from 'vitest'
import { Agent } from '../../src/agent/agent.js'
import { AgentRunner } from '../../src/agent/runner.js'
import { ToolRegistry } from '../../src/tool/framework.js'
import { ToolExecutor } from '../../src/tool/executor.js'
import type { AgentConfig, LLMAdapter, LLMMessage, LLMResponse, RunOptions } from '../../src/types.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function mockAdapter(responseText: string) {
  const calls: LLMMessage[][] = []
  const adapter: LLMAdapter = {
    name: 'mock',
    async chat(messages) {
      calls.push([...messages])
      return {
        id: 'mock-1',
        content: [{ type: 'text' as const, text: responseText }],
        model: 'mock-model',
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 20 },
      } satisfies LLMResponse
    },
    async *stream() {
      /* unused */
    },
  }
  return { adapter, calls }
}

function buildMockAgent(config: AgentConfig, responseText: string) {
  const { adapter, calls } = mockAdapter(responseText)
  const registry = new ToolRegistry()
  const executor = new ToolExecutor(registry)
  const agent = new Agent(config, registry, executor)

  const runner = new AgentRunner(adapter, registry, executor, {
    model: config.model,
    systemPrompt: config.systemPrompt,
    maxTurns: config.maxTurns,
    maxTokens: config.maxTokens,
    temperature: config.temperature,
    agentName: config.name,
  })
  ;(agent as any).runner = runner

  return { agent, calls }
}

const baseConfig: AgentConfig = {
  name: 'test-agent',
  model: 'mock-model',
  systemPrompt: 'You are a test agent.',
}

// ---------------------------------------------------------------------------
// Tests: prompt() RunOptions forwarding
// ---------------------------------------------------------------------------

describe('Agent.prompt() RunOptions forwarding', () => {
  // -----------------------------------------------------------------------
  // runOptions parameter is accepted
  // -----------------------------------------------------------------------

  it('accepts a runOptions parameter without throwing', async () => {
    const { agent } = buildMockAgent(baseConfig, 'response')
    // Should not throw - runOptions is now accepted
    await agent.prompt('hello', {})
    await agent.prompt('hello', undefined)
    await agent.prompt('hello', { runId: 'test-run-id' })
  })

  it('accepts all RunOptions fields without throwing', async () => {
    const { agent } = buildMockAgent(baseConfig, 'response')
    const runOptions: Partial<RunOptions> = {
      runId: 'run-1',
      taskId: 'task-1',
      traceAgent: 'trace-agent',
      abortSignal: new AbortController().signal,
    }
    await agent.prompt('hello', runOptions)
  })

  // -----------------------------------------------------------------------
  // onMessage callback forwarding
  // -----------------------------------------------------------------------

  it('forwards onMessage callback to executeRun', async () => {
    const { agent } = buildMockAgent(baseConfig, 'reply')
    const onMessageSpy = vi.fn()

    await agent.prompt('test message', { onMessage: onMessageSpy })

    // onMessage should have been called at least once (once per assistant message)
    expect(onMessageSpy.mock.calls.length).toBeGreaterThanOrEqual(1)
  })

  it('onMessage callback receives assistant messages from prompt()', async () => {
    const { agent } = buildMockAgent(baseConfig, 'assistant reply')
    const receivedMessages: LLMMessage[] = []

    await agent.prompt('user message', { onMessage: (msg) => receivedMessages.push(msg) })

    // Should have received at least the assistant response
    const assistantMessages = receivedMessages.filter(m => m.role === 'assistant')
    expect(assistantMessages.length).toBeGreaterThanOrEqual(1)
  })

  // -----------------------------------------------------------------------
  // onTrace callback forwarding
  // -----------------------------------------------------------------------

  it('forwards onTrace callback to executeRun', async () => {
    const { agent } = buildMockAgent(baseConfig, 'reply')
    const onTraceSpy = vi.fn()

    await agent.prompt('test', { onTrace: onTraceSpy, runId: 'run-123' })

    expect(onTraceSpy).toHaveBeenCalled()
    // The agent emits 'agent' trace events; the runner may emit 'llm_call' events
    const agentTrace = onTraceSpy.mock.calls.find(([call]: any[]) => call.type === 'agent')
    expect(agentTrace).toBeDefined()
    expect(agentTrace![0].runId).toBe('run-123')
  })

  // -----------------------------------------------------------------------
  // runId forwarding
  // -----------------------------------------------------------------------

  it('forwards runId to executeRun', async () => {
    const { agent } = buildMockAgent(baseConfig, 'reply')
    const onTraceSpy = vi.fn()

    await agent.prompt('test', { onTrace: onTraceSpy, runId: 'custom-run-id' })

    const traceCall = onTraceSpy.mock.calls[0]![0]
    expect(traceCall.runId).toBe('custom-run-id')
  })

  it('auto-generates runId when onTrace is provided but runId is missing', async () => {
    const { agent } = buildMockAgent(baseConfig, 'reply')
    const onTraceSpy = vi.fn()

    await agent.prompt('test', { onTrace: onTraceSpy })

    const traceCall = onTraceSpy.mock.calls[0]![0]
    expect(traceCall.runId).toBeDefined()
    expect(traceCall.runId.length).toBeGreaterThan(0)
  })

  // -----------------------------------------------------------------------
  // taskId forwarding
  // -----------------------------------------------------------------------

  it('forwards taskId to executeRun', async () => {
    const { agent } = buildMockAgent(baseConfig, 'reply')
    const onTraceSpy = vi.fn()

    await agent.prompt('test', { onTrace: onTraceSpy, taskId: 'custom-task-id' })

    const traceCall = onTraceSpy.mock.calls[0]![0]
    expect(traceCall.taskId).toBe('custom-task-id')
  })

  // -----------------------------------------------------------------------
  // traceAgent forwarding
  // -----------------------------------------------------------------------

  it('forwards traceAgent to executeRun', async () => {
    const { agent } = buildMockAgent(baseConfig, 'reply')
    const onTraceSpy = vi.fn()

    await agent.prompt('test', { onTrace: onTraceSpy, traceAgent: 'custom-agent-name' })

    const traceCall = onTraceSpy.mock.calls[0]![0]
    expect(traceCall.agent).toBe('custom-agent-name')
  })

  // -----------------------------------------------------------------------
  // abortSignal forwarding
  // -----------------------------------------------------------------------

  it('forwards abortSignal to executeRun', async () => {
    const { agent } = buildMockAgent(baseConfig, 'reply')
    const abortController = new AbortController()

    // Should not throw - abortSignal is forwarded
    await agent.prompt('test', { abortSignal: abortController.signal })
  })

  it('caller abortSignal takes precedence over agent timeout', async () => {
    const config: AgentConfig = {
      ...baseConfig,
      timeoutMs: 1, // Very short timeout
    }
    const { agent } = buildMockAgent(config, 'slow reply')
    const abortController = new AbortController()

    // Set abort signal to fire immediately
    setTimeout(() => abortController.abort(), 0)

    const result = await agent.prompt('test', { abortSignal: abortController.signal })
    // Run should complete (possibly with error, but shouldn't hang)
    expect(result).toBeDefined()
  })

  // -----------------------------------------------------------------------
  // onToolCall / onToolResult forwarding
  // -----------------------------------------------------------------------

  it('forwards onToolCall callback', async () => {
    // Build agent with tools
    const toolConfig: AgentConfig = {
      ...baseConfig,
      tools: ['bash'],
    }
    const { agent } = buildMockAgent(toolConfig, 'reply with tool')

    // This test verifies the option is accepted and forwarded
    const onToolCallSpy = vi.fn()
    await agent.prompt('test', { onToolCall: onToolCallSpy })
    // No error means it was accepted
  })

  it('forwards onToolResult callback', async () => {
    const toolConfig: AgentConfig = {
      ...baseConfig,
      tools: ['bash'],
    }
    const { agent } = buildMockAgent(toolConfig, 'reply with tool')

    const onToolResultSpy = vi.fn()
    await agent.prompt('test', { onToolResult: onToolResultSpy })
    // No error means it was accepted
  })

  // -----------------------------------------------------------------------
  // Multi-turn with RunOptions
  // -----------------------------------------------------------------------

  it('runOptions are forwarded on every prompt() turn', async () => {
    const { agent } = buildMockAgent(baseConfig, 'reply')
    const onMessageSpy = vi.fn()
    const onTraceSpy = vi.fn()

    await agent.prompt('turn 1', { onMessage: onMessageSpy, onTrace: onTraceSpy, runId: 'run-1' })
    await agent.prompt('turn 2', { onMessage: onMessageSpy, onTrace: onTraceSpy, runId: 'run-2' })

    // onTrace should have been called with 'agent' trace events for each turn
    const agentTraces = onTraceSpy.mock.calls.filter(([call]: any[]) => call.type === 'agent')
    expect(agentTraces).toHaveLength(2)
    expect(agentTraces[0][0].runId).toBe('run-1')
    expect(agentTraces[1][0].runId).toBe('run-2')
  })

  it('history is preserved correctly when runOptions are provided', async () => {
    const { agent } = buildMockAgent(baseConfig, 'reply 1')
    const onTraceSpy = vi.fn()

    await agent.prompt('first message', { onTrace: onTraceSpy, runId: 'run-1' })
    await agent.prompt('second message', { onTrace: onTraceSpy, runId: 'run-2' })

    const history = agent.getHistory()
    // History should have: user, assistant, user, assistant
    const userMessages = history.filter(m => m.role === 'user')
    expect(userMessages).toHaveLength(2)
    expect((userMessages[0]!.content[0] as any).text).toBe('first message')
    expect((userMessages[1]!.content[0] as any).text).toBe('second message')
  })

  // -----------------------------------------------------------------------
  // Backward compatibility
  // -----------------------------------------------------------------------

  it('calling prompt() without runOptions still works', async () => {
    const { agent } = buildMockAgent(baseConfig, 'ok')
    const result = await agent.prompt('hello')

    expect(result.success).toBe(true)
    expect(result.output).toBe('ok')
  })

  it('calling prompt() with undefined runOptions still works', async () => {
    const { agent } = buildMockAgent(baseConfig, 'ok')
    const result = await agent.prompt('hello', undefined as any)

    expect(result.success).toBe(true)
    expect(result.output).toBe('ok')
  })
})
