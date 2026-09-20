/**
 * Duplex bridge tests: finalized realtime transcripts become agent tasks, the
 * turn's assistant text is spoken back through the realtime session, and
 * barge-in cancels the spoken response without touching the agent turn.
 *
 * @module dsh-voice-agent/conversation.spec
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import type {
  Agent,
  AgentHandle,
  AssistantStreamFrame,
  CreateAgentOptions,
  ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent'
import type { StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import { LlmAttemptId } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { Session } from '@deepseek-ai/dsh-session'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { RealtimeSession } from '@deepseek-ai/dsh-stepfun-realtime'
import type { ClientEvent, RealtimeSessionEvents, RealtimeTransport, RealtimeTransportFactory, ResponseCreateEvent, ServerEvent } from '@deepseek-ai/dsh-stepfun-realtime'
import { VoiceConversation, DEFAULT_ACKNOWLEDGEMENT, ACKNOWLEDGEMENT_INSTRUCTIONS } from '../src/conversation.ts'
import type { VoiceConversationEvents, VoiceState } from '../src/conversation.ts'

/** Transport double shared with the realtime package's own tests. */
class FakeTransport implements RealtimeTransport {
  readonly sent: string[] = []
  /** When set, sends throw the way a dead socket would. */
  failSend = false
  private frameListener: (frame: string) => void = () => {}
  private closeListener: (code: number, reason: string) => void = () => {}
  private errorListener: (error: unknown) => void = () => {}

  send(frame: string): void {
    if (this.failSend) throw new Error('socket send failed')
    this.sent.push(frame)
  }

  close(code?: number, reason?: string): void {
    this.closeListener(code ?? 1000, reason ?? '')
  }

  onFrame(listener: (frame: string) => void): void {
    this.frameListener = listener
  }

  onClose(listener: (code: number, reason: string) => void): void {
    this.closeListener = listener
  }

  onError(listener: (error: unknown) => void): void {
    this.errorListener = listener
  }

  /** Surface a transport failure the way a dying socket would. */
  fail(error: unknown): void {
    this.errorListener(error)
  }

  deliver(event: ServerEvent): void {
    this.frameListener(JSON.stringify(event))
  }

  sentEvents(): (ServerEvent | ClientEvent)[] {
    return this.sent.map(frame => JSON.parse(frame) as ServerEvent | ClientEvent)
  }
}

/** Resolve once the predicate holds; fails the test on timeout. */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise((resolve) => { setTimeout(resolve, 20) })
  }
}

interface Bench {
  ctx: Context
  conversation: VoiceConversation
  agent: () => Agent
  transport: () => FakeTransport
  states: () => VoiceState[]
  transcripts: () => string[]
  finals: () => string[]
  runTurn(transcript: string, answer: string): Promise<void>
  /** Deliver one transcript with nothing else — the real acceptance order. */
  deliverTranscript(transcript: string): void
  /** Emit one complete text turn from the agent and settle it. */
  emitAgentTurn(answer: string): void
  /**
   * Emit several agent turns inside ONE driver activation — consecutive
   * `start` frames with distinct turn numbers, one idle at the end.
   */
  emitAgentTurns(answers: string[]): void
  currentState(): VoiceState
  session(): Session
}

async function bench(realtime: Record<string, unknown> = {}): Promise<Bench> {
  const ctx = new Context()
  const holder: { agent?: Agent; transport?: FakeTransport; session?: Session } = {}
  const states: VoiceState[] = []
  const transcripts: string[] = []
  const finals: string[] = []

  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'stepfun-official', model: 'step-5-preview' })

  let idle = Promise.resolve()
  ctx.agents.setFactory({
    async createAgent(ownerCtx: Context, createOptions: CreateAgentOptions): Promise<AgentHandle> {
      const session = ctx.sessions.create(createOptions.sessionId, {
        ...createOptions.meta === undefined ? {} : { meta: createOptions.meta },
      })
      holder.session = session
      const agent: Agent = {
        id: session.id,
        options: createOptions.agentOptions ?? {},
        session,
        inbox: createInboxStub(),
        status: 'idle',
        ctx: ownerCtx,
        cancel: () => {},
        runMaintenance: () => Promise.reject(new Error('not used')),
        send: () => {},
        followup: (message: UserMessage) => {
          agent.inbox.append('next-turn', message)
        },
        steer: () => {},
        inject: () => {},
        whenIdle: () => idle,
      }
      await createOptions.setup?.(ownerCtx, agent)
      await ctx.agents.register(agent)
      holder.agent = agent
      return { agent, dispose: () => Promise.resolve() }
    },
    async resume(_ownerCtx: Context, resumeOptions: ResumeAgentOptions): Promise<AgentHandle> {
      const session = ctx.sessions.get(resumeOptions.resumeSessionId)
      if (session === undefined) throw new Error(`no attached Session ${String(resumeOptions.resumeSessionId)}`)
      throw new Error('resume not exercised by this bench')
    },
  })

  const transportFactory: RealtimeTransportFactory = () => {
    const transport = new FakeTransport()
    holder.transport = transport
    return transport
  }
  ctx.provide('stepfunRealtime', {
    options: { baseURL: 'wss://api.stepfun.com/v1/realtime', apiKeyEnv: 'STEPFUN_API_KEY', connectTimeoutMs: 2_000 },
    async createSession(_overrides: unknown, events: RealtimeSessionEvents) {
      const session = new RealtimeSession({
        url: 'wss://api.stepfun.com/v1/realtime?model=stepaudio-3-realtime-preview',
        authorization: 'Bearer test-key',
        connectTimeoutMs: 2_000,
        transport: transportFactory,
      }, events)
      // The fake transport has no server behind it: open() installs its
      // handshake listener synchronously, so the ack can follow immediately.
      const opened = session.open()
      holder.transport?.deliver({ type: 'session.created', session: {} })
      await opened
      return session
    },
  } as never)

  const conversation = await VoiceConversation.start({ ctx, realtime }, {
    onState: (state) => { states.push(state) },
    onUserTranscript: (text) => { transcripts.push(text) },
    onAssistantFinal: (text) => { finals.push(text) },
  } satisfies VoiceConversationEvents)

  let frameIndex = 0
  const emit = (chunk: StreamChunk & { turn?: number }): void => {
    const agent = holder.agent
    if (agent === undefined) throw new Error('no agent')
    const attemptId = LlmAttemptId(`${String(agent.id)}:test`)
    const turn = chunk.turn ?? 1
    const frame: AssistantStreamFrame = chunk.type === 'text-delta'
      ? { type: 'chunk', attemptId, revision: 1, index: frameIndex++, time: Date.now(), chunk }
      : { type: 'start', attemptId, revision: 1, turn, step: 1 }
    agent.ctx.emit('agent/assistant-stream', { agent, frame })
  }

  const emitAgentTurn = (answer: string): void => {
    const agent = holder.agent
    if (agent === undefined) throw new Error('bench not ready')
    idle = (async () => {
      emit({ type: 'block-start', index: 0, blockType: 'text' })
      emit({ type: 'text-delta', index: 0, text: answer })
      agent.ctx.emit('agent/status', { agent, status: 'running' })
      agent.ctx.emit('agent/status', { agent, status: 'idle' })
    })()
  }

  const emitAgentTurns = (answers: string[]): void => {
    const agent = holder.agent
    if (agent === undefined) throw new Error('bench not ready')
    idle = (async () => {
      for (const [turn, answer] of answers.entries()) {
        emit({ type: 'block-start', index: 0, blockType: 'text', turn: turn + 1 })
        emit({ type: 'text-delta', index: 0, text: answer })
      }
      agent.ctx.emit('agent/status', { agent, status: 'running' })
      agent.ctx.emit('agent/status', { agent, status: 'idle' })
    })()
  }

  const runTurn = async (transcript: string, answer: string): Promise<void> => {
    const agent = holder.agent
    const transport = holder.transport
    if (agent === undefined || transport === undefined) throw new Error('bench not ready')
    const settle = new Promise<void>((resolve) => {
      idle = (async () => {
        emit({ type: 'block-start', index: 0, blockType: 'text' })
        emit({ type: 'text-delta', index: 0, text: answer })
        agent.ctx.emit('agent/status', { agent, status: 'running' })
        agent.ctx.emit('agent/status', { agent, status: 'idle' })
        resolve()
      })()
    })
    transport.deliver({ type: 'conversation.item.input_audio_transcript.completed', transcript })
    await settle
  }

  return {
    ctx,
    conversation,
    deliverTranscript: (transcript: string): void => {
      const transport = holder.transport
      if (transport === undefined) throw new Error('bench not ready')
      transport.deliver({ type: 'conversation.item.input_audio_transcript.completed', transcript })
    },
    emitAgentTurn,
    emitAgentTurns,
    currentState: () => conversation.currentState,
    agent: () => holder.agent ?? undefined as unknown as Agent,
    transport: () => holder.transport ?? undefined as unknown as FakeTransport,
    states: () => [...states],
    transcripts: () => [...transcripts],
    finals: () => [...finals],
    runTurn,
    session: () => holder.session ?? undefined as unknown as Session,
  }
}

describe('VoiceConversation', () => {
  it('routes a finalized transcript through the agent and speaks the answer back', async () => {
    const bench_ = await bench()
    await bench_.runTurn('list the files', 'six files live here')
    const transport = bench_.transport()
    await waitFor(() => transport.sentEvents().some(event => event.type === 'response.create'))
    const speak = transport.sentEvents().find((event): event is ResponseCreateEvent => event.type === 'response.create')
    expect(speak).toEqual({
      type: 'response.create',
      response: {
        modalities: ['text', 'audio'],
        input: [{ type: 'text', text: 'six files live here' }],
      },
    })
    expect(bench_.transcripts()).toEqual(['list the files'])
    expect(bench_.finals()).toEqual(['six files live here'])
    expect(bench_.states()).toEqual(['thinking', 'speaking'])
    transport.deliver({ type: 'response.done' })
    await waitFor(() => bench_.states().includes('listening'))
    await bench_.conversation.close()
  })

  it('cancels the spoken response on barge-in', async () => {
    const bench_ = await bench()
    await bench_.runTurn('hello', 'hi there')
    const transport = bench_.transport()
    await waitFor(() => transport.sentEvents().some(event => event.type === 'response.create'))
    // The user starts speaking again while the answer plays.
    transport.deliver({ type: 'input_audio_buffer.speech_started', audio_start_ms: 1 })
    await waitFor(() => transport.sentEvents().some(event => event.type === 'response.cancel'))
    transport.deliver({ type: 'response.cancelled' })
    await waitFor(() => bench_.states().includes('listening'))
    await bench_.conversation.close()
  })
  it('ignores blank transcripts', async () => {
    const bench_ = await bench()
    const transport = bench_.transport()
    transport.deliver({ type: 'conversation.item.input_audio_transcript.completed', transcript: '   ' })
    await new Promise((resolve) => { setTimeout(resolve, DRAIN_WAIT) })
    const agent = bench_.agent()
    expect(agent.inbox.nextTurn).toHaveLength(0)
    expect(bench_.states()).toEqual([])
    await bench_.conversation.close()
  })
})

describe('VoiceConversation failure survival and multi-turn answers', () => {
  /** Settle the currently speaking response so the drain loop advances. */
  function settleSpeech(transport: FakeTransport): void {
    transport.deliver({ type: 'response.done' })
  }

  it('speaks every answer of one driver activation without losing the first', async () => {
    const bench_ = await bench()
    bench_.deliverTranscript('first question')
    bench_.deliverTranscript('second question')
    // One activation: two consecutive turns under a single idle transition.
    bench_.emitAgentTurns(['answer one', 'answer two'])
    const transport = bench_.transport()
    // Ack first.
    await waitFor(() => transport.sentEvents().some(event => event.type === 'response.create'))
    settleSpeech(transport)
    // Then both answers, in completion order, none lost.
    await waitFor(() => bench_.finals().includes('answer one'))
    settleSpeech(transport)
    await waitFor(() => bench_.finals().includes('answer two'))
    settleSpeech(transport)
    const spoken = transport.sentEvents()
      .filter((event): event is ResponseCreateEvent => event.type === 'response.create')
      .map(event => event.response?.input?.[0]?.text)
    expect(spoken).toEqual([DEFAULT_ACKNOWLEDGEMENT, 'answer one', 'answer two'])
    expect(bench_.finals()).toEqual(['answer one', 'answer two'])
    await bench_.conversation.close()
  })

  it('survives a speak failure and keeps serving later answers', async () => {
    const bench_ = await bench()
    const transport = bench_.transport()
    // Force the acknowledgement's response.create to fail the way a dead
    // socket would.
    transport.failSend = true
    bench_.deliverTranscript('hello')
    await new Promise((resolve) => { setTimeout(resolve, DRAIN_WAIT) })
    // The failed ack never reached the wire; the drain loop survived.
    expect(transport.sentEvents().filter(event => event.type === 'response.create')).toHaveLength(0)
    transport.failSend = false
    bench_.emitAgentTurn('recovered answer')
    await waitFor(() => bench_.finals().includes('recovered answer'))
    await waitFor(() => transport.sentEvents().some(event => event.type === 'response.create'))
    await bench_.conversation.close()
  })

  it('does not report listening for a stray error while the agent works', async () => {
    const bench_ = await bench()
    bench_.deliverTranscript('working question')
    const transport = bench_.transport()
    await waitFor(() => transport.sentEvents().some(event => event.type === 'response.create'))
    // The acknowledgement settles; the agent is still working on the task.
    settleSpeech(transport)
    await waitFor(() => bench_.currentState() === 'thinking')
    transport.deliver({ type: 'error', error: { message: 'stray' } })
    await new Promise((resolve) => { setTimeout(resolve, DRAIN_WAIT) })
    // No spoken wait is in flight: the phase must stay honest.
    expect(bench_.states()).not.toContain('listening')
    expect(bench_.currentState()).toBe('thinking')
    bench_.emitAgentTurn('the answer')
    await waitFor(() => bench_.finals().includes('the answer'))
    settleSpeech(transport)
    await waitFor(() => bench_.currentState() === 'listening')
    await bench_.conversation.close()
  })

  it('lets a second close await the first close flush instead of racing it', async () => {
    const bench_ = await bench()
    const flushSpy = vi.spyOn(bench_.ctx.sessions as unknown as { flush: (session: Session) => Promise<void> }, 'flush')
    const first = bench_.conversation.close()
    const second = bench_.conversation.close()
    await Promise.all([first, second])
    expect(flushSpy).toHaveBeenCalledTimes(1)
  })
})

/** Long enough for one drain poll to pass without a turn. */
const DRAIN_WAIT = 250

describe('VoiceConversation task acknowledgement', () => {
  it('speaks a brief acknowledgement before the agent answer in real acceptance order', async () => {
    const bench_ = await bench()
    // The real order: the transcript lands first, the agent works, the answer
    // converges later.
    bench_.deliverTranscript('fix the failing test')
    const transport = bench_.transport()
    await waitFor(() => transport.sentEvents().some(event => event.type === 'response.create'))
    const ack = transport.sentEvents().find((event): event is ResponseCreateEvent => event.type === 'response.create')
    expect(ack).toMatchObject({
      type: 'response.create',
      response: {
        modalities: ['text', 'audio'],
        input: [{ type: 'text', text: DEFAULT_ACKNOWLEDGEMENT }],
        instructions: ACKNOWLEDGEMENT_INSTRUCTIONS,
      },
    })
    expect(bench_.states()).toContain('speaking')
    // The acknowledgement settles, the agent keeps working, and the answer
    // follows in the same speaker queue.
    transport.deliver({ type: 'response.done' })
    await waitFor(() => bench_.states().includes('thinking'))
    bench_.emitAgentTurn('fixed three assertions')
    await waitFor(() => transport.sentEvents().filter(event => event.type === 'response.create').length >= 2)
    const answer = transport.sentEvents().filter((event): event is ResponseCreateEvent => event.type === 'response.create')[1]
    expect(answer).toMatchObject({
      response: { input: [{ type: 'text', text: 'fixed three assertions' }] },
    })
    await waitFor(() => bench_.finals().includes('fixed three assertions'))
    await bench_.conversation.close()
  })

  it('does not acknowledge a task accepted while the speaker is busy', async () => {
    const bench_ = await bench()
    bench_.deliverTranscript('first task')
    const transport = bench_.transport()
    await waitFor(() => transport.sentEvents().some(event => event.type === 'response.create'))
    // A second transcript lands while the acknowledgement is still speaking:
    // the speaker is busy, so no second acknowledgement may queue.
    bench_.deliverTranscript('second task')
    await new Promise((resolve) => { setTimeout(resolve, DRAIN_WAIT) })
    const acks = transport.sentEvents().filter((event): event is ResponseCreateEvent => event.type === 'response.create')
      .filter(event => event.response?.input?.[0]?.text === DEFAULT_ACKNOWLEDGEMENT)
    expect(acks).toHaveLength(1)
    await bench_.conversation.close()
  })

  it('omits the acknowledgement when disabled', async () => {
    const bench_ = await bench({ acknowledge: false })
    bench_.deliverTranscript('plain question')
    bench_.emitAgentTurn('plain answer')
    await waitFor(() => bench_.finals().includes('plain answer'))
    const transport = bench_.transport()
    const creates = transport.sentEvents().filter((event): event is ResponseCreateEvent => event.type === 'response.create')
    expect(creates).toHaveLength(1)
    expect(creates[0]).toMatchObject({
      response: { input: [{ type: 'text', text: 'plain answer' }] },
    })
    await bench_.conversation.close()
  })

  it('speaks a custom acknowledgement line when one is configured', async () => {
    const bench_ = await bench({ acknowledge: '收到。' })
    bench_.deliverTranscript('do the thing')
    const transport = bench_.transport()
    await waitFor(() => transport.sentEvents().some(event => event.type === 'response.create'))
    const ack = transport.sentEvents().find((event): event is ResponseCreateEvent => event.type === 'response.create')
    expect(ack).toMatchObject({ response: { input: [{ type: 'text', text: '收到。' }] } })
    await bench_.conversation.close()
  })
})
