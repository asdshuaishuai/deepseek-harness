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
import type {} from '@deepseek-ai/dsh-agent-default-model'
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
  realtime: {
    voice?: string
    instructions?: string
    /**
     * Codex-style task acknowledgement: when a transcript is accepted while
     * the speaker is idle, the voice model briefly confirms the task before
     * the agent's answer is due. `false` disables the acknowledgement; a
     * string replaces the default line.
     */
    acknowledge?: string | false
  }
}

/**
 * Drain cadence while parked: `whenIdle()` resolves immediately when the
 * agent is already quiescent, so the drain loop polls at this interval
 * between turns. 150 ms bounds caption-to-speech latency well under human
 * perception while costing nothing measurable.
 */
const DRAIN_POLL_MS = 150

/** Default Codex-style acknowledgement spoken when a task is accepted. */
export const DEFAULT_ACKNOWLEDGEMENT = '好的，我开始处理，请稍等。'

/** One-shot delivery instructions carried by the acknowledgement. */
export const ACKNOWLEDGEMENT_INSTRUCTIONS =
  '只需简短确认收到任务并开始处理，不要回答任务内容；语气自然，一句话说完。'

/** One item waiting for the speaker. */
interface SpeechItem {
  text: string
  /** Why this item exists; the drain loop sets the follow-up phase from it. */
  kind: 'ack' | 'answer'
  /** Optional one-shot delivery instructions. */
  instructions?: string
}

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
  /** The turn number whose text {@link turnText} accumulates; detects turn boundaries. */
  private activeTurn: number | undefined = undefined
  /**
   * Converged answers waiting for the speaker, in completion order. A list —
   * not a slot — because one driver activation can run several queued
   * transcripts back-to-back under a single `idle` transition.
   */
  private readonly answers: string[] = []
  /** Speech items waiting for the speaker, in acceptance order. */
  private readonly speechQueue: SpeechItem[] = []
  /** The acknowledgement line, or `undefined` when disabled. */
  private readonly acknowledgement: string | undefined
  /**
   * Transcripts accepted as tasks whose answers have not converged yet.
   * `listening` is only honest once this drains — an accepted-but-unanswered
   * task keeps the phase at `thinking` even between spoken items.
   */
  private acceptedTasks = 0
  private draining = false
  /** Resolves the in-flight {@link speakAndWait}; barge-in and done share it. */
  private speechDone: (() => void) | undefined
  private closed = false
  private closePromise: Promise<void> | undefined
  private readonly disposers: (() => void)[] = []

  private constructor(
    agent: Agent,
    session: RealtimeSession,
    ctx: Context,
    events: VoiceConversationEvents,
    acknowledgement: string | undefined,
  ) {
    this.agent = agent
    this.session = session
    this.ctx = ctx
    this.events = events
    this.acknowledgement = acknowledgement

    // Captions and the speakable turn text both come from the assistant
    // stream; the durable session log remains the record of record.
    this.disposers.push(ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
      if (subject !== this.agent) return
      if (frame.type === 'start') {
        // One driver activation runs queued transcripts back-to-back under a
        // single idle transition: a start whose turn differs from the one
        // this text belongs to closes that turn out as its own answer, so a
        // rapid second transcript can never overwrite the first answer.
        if (frame.turn !== this.activeTurn && this.turnText.trim().length > 0) {
          this.answers.push(this.turnText)
          this.turnText = ''
        }
        this.activeTurn = frame.turn
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
      if (this.turnText.trim().length > 0) this.answers.push(this.turnText)
      this.turnText = ''
      this.activeTurn = undefined
      // One activation consumes every transcript queued on it.
      this.acceptedTasks = 0
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
    // The loader is an optional boot capability; the rest are required seams.
    // Local structural types keep the reads honest regardless of how the
    // ambient service declarations reach this compilation.
    const loader = ctx.get('loader') as { await(): Promise<void> } | undefined
    await loader?.await()
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
    const acknowledgement = deps.realtime.acknowledge === false
      ? undefined
      : deps.realtime.acknowledge ?? DEFAULT_ACKNOWLEDGEMENT
    const conversation = new VoiceConversation(agent, session, ctx, events, acknowledgement)
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
  close(): Promise<void> {
    // Memoize: a transport-initiated close racing the consumer's close must
    // let the second caller await the first close's still-pending flush.
    this.closePromise ??= this.closeNow()
    return this.closePromise
  }

  private async closeNow(): Promise<void> {
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
    this.acceptedTasks += 1
    // Codex-style acknowledgement: confirm the accepted task only while the
    // speaker has nothing queued or in flight, so busy-queue follow-ups and
    // post-answer speech never double up against it.
    if (
      this.acknowledgement !== undefined
      && this.speechQueue.length === 0
      && this.answers.length === 0
      && this.speechDone === undefined
    ) {
      this.speechQueue.push({
        text: this.acknowledgement,
        kind: 'ack',
        instructions: ACKNOWLEDGEMENT_INSTRUCTIONS,
      })
    }
    this.agent.followup(createUserMessage({
      content: [{ type: 'text', text: transcript }],
      source: { kind: 'user' },
    }))
  }

  /** The user started speaking while an answer may be playing. */
  private onBargeIn(): void {
    // Barge-in cancels the spoken response only: the agent turn keeps running
    // to completion, and its text still reaches the durable session log. The
    // cancel rides the transport's dispatch path, so a dying socket must not
    // turn it into an uncaught exception.
    if (this.speechDone === undefined) return
    try {
      this.session.cancelResponse()
    } catch (error: unknown) {
      this.events.onError?.(error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * The spoken response settled (finished or cancelled). Only an in-flight
   * wait counts: a stray error while the agent works must not report
   * `listening` for an answer that is still owed.
   */
  private onSpeechSettled(cancelled: boolean): void {
    const done = this.speechDone
    this.speechDone = undefined
    if (done === undefined) return
    done()
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
          // Queued acknowledgements speak ahead of the parked wait: an ack
          // accepted while the agent works must not wait for its completion.
          const queued = this.speechQueue.shift()
          if (queued !== undefined) {
            await this.speakAndWait(queued)
            // The accepted task is still running behind the acknowledgement.
            this.setState('thinking')
            continue
          }
          await this.agent.whenIdle()
          const answer = this.answers.shift()
          if (answer === undefined) {
            // An accepted task still converging keeps the phase honest.
            this.setState(this.acceptedTasks > 0 ? 'thinking' : 'listening')
            await poll()
            continue
          }
          this.events.onAssistantFinal?.(answer)
          await this.speakAndWait({ text: answer, kind: 'answer' })
        }
      } catch (error: unknown) {
        this.events.onError?.(error instanceof Error ? error.message : String(error))
      } finally {
        this.draining = false
      }
    })()
  }

  /**
   * Speak one queued item and wait for its spoken response to settle. Barge-in
   * cancels the response server-side, which resolves the wait.
   */
  private async speakAndWait(item: SpeechItem): Promise<void> {
    try {
      await new Promise<void>((resolve) => {
        this.speechDone = resolve
        this.setState('speaking')
        this.session.speak(item.text, item.instructions)
        // A response that never settles (transport dropped mid-speech) must
        // not wedge the drain loop: the conversation's close() resolves the
        // waiter, and a speak() that throws settles it right here — the loop
        // survives to serve the rest of the queue.
      })
    } catch (error: unknown) {
      this.speechDone?.()
      this.speechDone = undefined
      this.events.onError?.(error instanceof Error ? error.message : String(error))
    } finally {
      if (item.kind === 'answer') this.setState('listening')
    }
  }

  private setState(state: VoiceState): void {
    if (this.state === state) return
    this.state = state
    this.events.onState?.(state)
  }
}
