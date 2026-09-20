/**
 * Duplex bridge tests: finalized realtime transcripts become agent tasks, the
 * turn's assistant text is spoken back through the realtime session, and
 * barge-in cancels the spoken response without touching the agent turn.
 *
 * @module dsh-voice-agent/conversation.spec
 */

import { describe, expect, it } from 'vitest'
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
import type { RealtimeSessionEvents, RealtimeTransport, RealtimeTransportFactory, ServerEvent } from '@deepseek-ai/dsh-stepfun-realtime'
import { VoiceConversation } from '../src/conversation.ts'
import type { VoiceConversationEvents, VoiceState } from '../src/conversation.ts'

/** Transport double shared with the realtime package's own tests. */
class FakeTransport implements RealtimeTransport {
  readonly sent: string[] = []
  private frameListener: (frame: string) => void = () => {}
  private closeListener: (code: number, reason: string) => void = () => {}
  private errorListener: (error: unknown) => void = () => {}

  send(frame: string): void {
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

  sentEvents(): ReturnType<typeof JSON.parse>[] {
    return this.sent.map(frame => JSON.parse(frame) as ReturnType<typeof JSON.parse>)
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
  session(): Session
}

async function bench(): Promise<Bench> {
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

  const conversation = await VoiceConversation.start({ ctx, realtime: {} }, {
    onState: (state) => { states.push(state) },
    onUserTranscript: (text) => { transcripts.push(text) },
    onAssistantFinal: (text) => { finals.push(text) },
  } satisfies VoiceConversationEvents)

  let frameIndex = 0
  const emit = (chunk: StreamChunk): void => {
    const agent = holder.agent
    if (agent === undefined) throw new Error('no agent')
    const attemptId = LlmAttemptId(`${String(agent.id)}:test`)
    const frame: AssistantStreamFrame = chunk.type === 'text-delta'
      ? { type: 'chunk', attemptId, revision: 1, index: frameIndex++, time: Date.now(), chunk }
      : { type: 'start', attemptId, revision: 1, turn: 1, step: 1 }
    agent.ctx.emit('agent/assistant-stream', { agent, frame })
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
    const speak = transport.sentEvents().find(event => event.type === 'response.create')
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

/** Long enough for one drain poll to pass without a turn. */
const DRAIN_WAIT = 250
