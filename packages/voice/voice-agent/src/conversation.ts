/**
 * One duplex voice conversation: a StepAudio 3 Realtime session wired to a
 * durable harness Agent. The realtime model owns the ear and the voice —
 * server VAD finalizes each user utterance into a transcript — while every
 * transcript becomes an agent task executed by the configured main model
 * (step-5-preview in this composition); the turn's final assistant text is
 * spoken back through the same realtime session. Barge-in (the user speaking
 * while an answer plays) cancels the spoken response; the agent turn itself
 * runs to completion.
 *
 * @module @deepseek-ai/dsh-voice-agent/conversation
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { RealtimeSession } from '@deepseek-ai/dsh-stepfun-realtime'

/** Conversation phases surfaced to the consumer. */
export type VoiceState = 'listening' | 'thinking' | 'speaking'

/** Callbacks for one conversation; unset members are ignored. */
export interface VoiceConversationEvents {
  /** The conversation phase changed. */
  onState?: (state: VoiceState) => void
  /** A finalized user utterance. */
  onUserTranscript?: (text: string) => void
  /** Incremental caption text of the agent's current turn. */
  onAssistantDelta?: (delta: string) => void
  /** The agent turn finished with this final text (spoken unless barged in). */
  onAssistantFinal?: (text: string) => void
  /** One base64 PCM16 frame of the model's speech. */
  onAudio?: (base64: string) => void
  /** A recoverable failure on the voice path. */
  onError?: (message: string) => void
  /** The realtime connection closed. */
  onClose?: (event: { code: number; reason: string }) => void
}

/** Dependencies the conversation resolves from its plugin context. */
export interface VoiceConversationDeps {
  /** Plugin context carrying the agent registry, sessions, and realtime service. */
  ctx: Context
  /** Exact Session identity to adopt; a fresh random identity when omitted. */
  sessionId?: string
  /** Voice-model overrides for this conversation. */
  realtime: { voice?: string; instructions?: string }
}

/**
 * Drain cadence while parked: `whenIdle()` resolves immediately when the
 * agent is already quiescent, so the drain loop polls at this interval
 * between turns. 150 ms bounds caption-to-speech latency well under human
 * perception while costing nothing measurable.
 */
const DRAIN_POLL_MS = 150

/**
 * The live conversation. Exactly one realtime session and one Agent; the
 * consumer pipes microphone frames in through {@link VoiceConversation.sendAudio}
 * and plays {@link VoiceConversationEvents.onAudio} frames out.
 */
export class VoiceConversation {
  private readonly events: VoiceConversationEvents
  private readonly agent: Agent
  private readonly session: RealtimeSession
  private readonly ctx: Context
  private state: VoiceState = 'listening'
  /** Text accumulated for the agent turn currently streaming. */
  private turnText = ''
  /** A turn-finished text waiting to be spoken; `undefined` when none. */
  private pendingAnswer: string | undefined
  private draining = false
  /** Resolves the in-flight {@link speakAndWait}; barge-in and done share it. */
  private speechDone: (() => void) | undefined
  private closed = false
  private readonly disposers: (() => void)[] = []

  private constructor(agent: Agent, session: RealtimeSession, ctx: Context, events: VoiceConversationEvents) {
    this.agent = agent
    this.session = session
    this.ctx = ctx
    this.events = events

    // Captions and the speakable turn text both come from the assistant
    // stream; the durable session log remains the record of record.
    this.disposers.push(ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
      if (subject !== this.agent) return
      if (frame.type === 'start') {
        this.turnText = ''
        return
      }
      if (frame.type !== 'chunk') return
      if (frame.chunk.type === 'text-delta' && frame.chunk.text.length > 0) {
        this.turnText += frame.chunk.text
        this.events.onAssistantDelta?.(frame.chunk.text)
      }
    }))
    // A turn that converged with text owes that text to the speaker.
    this.disposers.push(ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject !== this.agent || status !== 'idle') return
      if (this.turnText.trim().length > 0) this.pendingAnswer = this.turnText
      this.turnText = ''
    }))

    // The duplex wiring: finalized user transcripts become agent tasks; the
    // spoken channel carries the turn's answer back; barge-in cancels speech.
    // Installed after construction through bindRealtime because the callbacks
    // close over `this`.
  }

  /**
   * Create and wire one conversation: the Agent first (so transcripts never
   * race a half-composed tool set), then the realtime session.
   * @param deps - context, session identity, and voice-model overrides.
   * @param events - consumer callbacks for the conversation's lifetime.
   * @returns the started conversation.
   */
  static async start(deps: VoiceConversationDeps, events: VoiceConversationEvents): Promise<VoiceConversation> {
    const { ctx } = deps
    // Loader siblings mount concurrently; await the complete application so
    // the Agent's scoped tools and adapters are not half-composed.
    await ctx.get('loader')?.await()
    const agents = ctx.get('agents')
    const defaultModel = ctx.get('agentDefaultModel')
    const sessions = ctx.get('sessions')
    const realtime = ctx.get('stepfunRealtime')
    if (agents === undefined || defaultModel === undefined || sessions === undefined || realtime === undefined) {
      throw new Error('voice-agent: core services (agents, agentDefaultModel, sessions, stepfunRealtime) are required')
    }
    const selection = defaultModel.currentSelection()
    const agentOptions = { provider: selection.provider, model: selection.model }
    const setup = (agentCtx: Context): void => {
      const selected: ModelSelectionRef = { current: selection, assembled: undefined }
      installModelSelection(agentCtx, selected)
    }
    const fs = ctx.get('fs')
    const cwd = fs === undefined ? process.cwd() : fs.processPath(await fs.resolve('.'))
    const sessionId = brandString<SessionId>(deps.sessionId ?? `session-${randomUUID()}`)
    const { agent } = await agents.create({
      sessionId,
      meta: { cwd },
      agentOptions,
      setup,
    })
    // The realtime callbacks dispatch through a holder so the events object
    // can be built before the conversation exists.
    const holder: { conversation?: VoiceConversation } = {}
    const session = await realtime.createSession(deps.realtime, {
      onSpeechStarted: () => { holder.conversation?.onBargeIn() },
      onUserTranscript: (transcript) => { holder.conversation?.onUserTranscript(transcript) },
      onUserTranscriptFailed: ({ message }) => { events.onError?.(message) },
      onAssistantTranscriptDelta: () => {},
      onAssistantAudioDelta: (delta) => { events.onAudio?.(delta) },
      onResponseDone: () => { holder.conversation?.onSpeechSettled(false) },
      onResponseCancelled: () => { holder.conversation?.onSpeechSettled(true) },
      onError: (error) => {
        events.onError?.(error.message ?? 'StepFun realtime error')
        // A failed spoken response must not wedge the drain loop waiting on
        // a `response.done` that will never arrive.
        holder.conversation?.onSpeechSettled(true)
      },
      onClose: (event) => {
        events.onClose?.(event)
        void holder.conversation?.close().catch(() => {})
      },
    })
    const conversation = new VoiceConversation(agent, session, ctx, events)
    holder.conversation = conversation
    conversation.drain()
    return conversation
  }

  /** The durable Session identity backing this conversation. */
  get id(): SessionId {
    return this.agent.id
  }

  /** The current conversation phase. */
  get currentState(): VoiceState {
    return this.state
  }

  /** Pipe one base64 PCM16 microphone frame into the realtime session. */
  sendAudio(base64: string): void {
    this.session.appendAudio(base64)
  }

  /** Force-close the input buffer as one complete utterance. */
  commitUtterance(): void {
    this.session.commit()
  }

  /** Stop the conversation, close the voice channel, and flush the session. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.speechDone?.()
    this.speechDone = undefined
    this.session.close()
    for (const dispose of this.disposers.splice(0)) dispose()
    const sessions = this.ctx.get('sessions')
    if (sessions !== undefined) await sessions.flush(this.agent.session)
  }

  /** One finalized user utterance became an agent task. */
  private onUserTranscript(transcript: string): void {
    this.events.onUserTranscript?.(transcript)
    if (transcript.trim().length === 0 || this.closed) return
    this.setState('thinking')
    this.agent.followup(createUserMessage({
      content: [{ type: 'text', text: transcript }],
      source: { kind: 'user' },
    }))
  }

  /** The user started speaking while an answer may be playing. */
  private onBargeIn(): void {
    // Barge-in cancels the spoken response only: the agent turn keeps running
    // to completion, and its text still reaches the durable session log.
    if (this.speechDone !== undefined) this.session.cancelResponse()
  }

  /** The spoken response settled (finished or cancelled). */
  private onSpeechSettled(cancelled: boolean): void {
    const done = this.speechDone
    this.speechDone = undefined
    if (done !== undefined) done()
    if (cancelled) this.setState('listening')
  }

  /**
   * The drain loop: one per conversation, converting converged agent turns
   * into spoken answers. `whenIdle()` resolves immediately while quiescent,
   * so the loop parks on the poll interval between turns; during a turn it
   * blocks on quiescence and wakes exactly at settlement.
   */
  private drain(): void {
    if (this.draining) return
    this.draining = true
    const poll = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, DRAIN_POLL_MS) })
    void (async () => {
      try {
        while (!this.closed) {
          await this.agent.whenIdle()
          const answer = this.pendingAnswer
          this.pendingAnswer = undefined
          if (answer === undefined) {
            this.setState('listening')
            await poll()
            continue
          }
          this.events.onAssistantFinal?.(answer)
          await this.speakAndWait(answer)
        }
      } catch (error: unknown) {
        this.events.onError?.(error instanceof Error ? error.message : String(error))
      } finally {
        this.draining = false
      }
    })()
  }

  /**
   * Speak one answer and wait for its spoken response to settle. Barge-in
   * cancels the response server-side, which resolves the wait.
   */
  private async speakAndWait(answer: string): Promise<void> {
    await new Promise<void>((resolve) => {
      this.speechDone = resolve
      this.setState('speaking')
      this.session.speak(answer)
      // A response that never settles (transport dropped mid-speech) must not
      // wedge the drain loop: the conversation's close() resolves the waiter.
    })
    this.setState('listening')
  }

  private setState(state: VoiceState): void {
    if (this.state === state) return
    this.state = state
    this.events.onState?.(state)
  }
}
