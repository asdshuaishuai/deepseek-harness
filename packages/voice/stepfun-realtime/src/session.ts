/**
 * One StepAudio 3 Realtime duplex session over a transport: opens the
 * WebSocket, applies the session configuration (server VAD, PCM16 both ways),
 * and maps server events onto typed callbacks. The session is transport-only;
 * conversation policy (who speaks when) belongs to the consumer.
 *
 * @module dsh-stepfun-realtime/session
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type {
  ClientEvent,
  RealtimeErrorEvent,
  ServerEvent,
  SessionConfig,
} from './types.ts'
import type { RealtimeConnectOptions, RealtimeTransport, RealtimeTransportFactory } from './transport.ts'

/** Typed callbacks for one live session; unset members are ignored. */
export interface RealtimeSessionEvents {
  /** The user started speaking (barge-in anchor). */
  onSpeechStarted?: (event: { audioStartMs: number }) => void
  /** The user stopped speaking; the utterance is being finalized. */
  onSpeechStopped?: (event: { audioEndMs: number }) => void
  /** A finalized user-utterance transcript arrived. */
  onUserTranscript?: (transcript: string) => void
  /** A user utterance could not be transcribed. */
  onUserTranscriptFailed?: (error: { message: string }) => void
  /** Incremental text of the model's spoken turn. */
  onAssistantTranscriptDelta?: (delta: string) => void
  /** Incremental base64 PCM16 audio of the model's turn. */
  onAssistantAudioDelta?: (delta: string) => void
  /** The model's response finished. */
  onResponseDone?: () => void
  /** The model's response was cancelled before finishing. */
  onResponseCancelled?: () => void
  /** A protocol or transport error arrived. */
  onError?: ((error: RealtimeErrorEvent['error']) => void) | undefined
  /** The connection closed; `code`/`reason` come from the close frame. */
  onClose?: ((event: { code: number; reason: string }) => void) | undefined
}

/** Options for {@link RealtimeSession}. */
export interface RealtimeSessionOptions extends RealtimeConnectOptions {
  /** Voice the model speaks with; the platform default applies when omitted. */
  voice?: string
  /** System instructions for the voice model's own turns. */
  instructions?: string
  /** Ceiling on the open handshake (`session.created`) wait. */
  connectTimeoutMs: number
  /** Transport factory; production uses the global WebSocket client. */
  transport: RealtimeTransportFactory
}

/**
 * The duplex voice session. `open()` resolves once the server acknowledges
 * the configuration; every later callback fires on the transport's receive
 * path. `close()` is idempotent.
 */
export class RealtimeSession {
  private readonly events: RealtimeSessionEvents
  private readonly transport: RealtimeTransport
  private readonly options: RealtimeSessionOptions
  private closed = false

  constructor(options: RealtimeSessionOptions, events: RealtimeSessionEvents) {
    this.options = options
    this.events = events
    this.transport = options.transport(options)
    this.transport.onFrame((frame) => { this.handleFrame(frame) })
    this.transport.onClose((code, reason) => {
      if (this.closed) return
      this.closed = true
      this.events.onClose?.({ code, reason })
    })
    this.transport.onError((error) => {
      this.events.onError?.({
        type: 'transport',
        message: error instanceof Error ? error.message : String(error),
      })
    })
  }

  /**
   * Open the session and apply its configuration. Resolves on
   * `session.created`; rejects on handshake timeout, close, or error. The
   * consumer's steady-state callbacks are untouched: handshake interception
   * is installed around them and removed once the session exists.
   */
  open(): Promise<void> {
    const consumerError = this.events.onError
    const consumerClose = this.events.onClose
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const settle = (finish: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.events.onError = consumerError
        this.events.onClose = consumerClose
        finish()
      }
      const timer = setTimeout(
        () => {
          settle(() => {
            reject(new LlmError(
              `StepFun realtime handshake timed out after ${this.options.connectTimeoutMs}ms`,
              'TIMEOUT',
            ))
          })
        },
        this.options.connectTimeoutMs,
      )
      this.events.onError = (error) => {
        settle(() => {
          reject(new LlmError(error.message ?? 'StepFun realtime handshake failed', 'TRANSPORT'))
        })
      }
      this.events.onClose = (event) => {
        settle(() => {
          reject(new LlmError(
            `StepFun realtime connection closed during handshake (${event.code})`,
            'TRANSPORT',
          ))
        })
      }
      // Route only until acknowledged: handleFrame is re-installed on ack.
      this.transport.onFrame((frame) => {
        let event: ServerEvent
        try {
          event = JSON.parse(frame) as ServerEvent
        } catch {
          return
        }
        if (event.type === 'session.created') {
          this.transport.onFrame((nested) => { this.handleFrame(nested) })
          settle(() => { resolve() })
        } else if (event.type === 'error') {
          this.events.onError?.(event.error)
        }
      })
      this.send(this.sessionUpdate())
    })
  }

  /** The initial configuration: PCM16 both ways, server VAD, spoken turns. */
  private sessionUpdate(): ClientEvent {
    const session: SessionConfig = {
      modalities: ['text', 'audio'],
      input_audio_format: 'pcm16',
      output_audio_format: 'pcm16',
      turn_detection: { type: 'server_vad' },
      ...this.options.voice === undefined ? {} : { voice: this.options.voice },
      ...this.options.instructions === undefined ? {} : { instructions: this.options.instructions },
    }
    return { type: 'session.update', session }
  }

  /** Append one base64 PCM16 frame to the server input buffer. */
  appendAudio(base64: string): void {
    this.send({ type: 'input_audio_buffer.append', audio: base64 })
  }

  /** Manually commit the input buffer as a complete utterance. */
  commit(): void {
    this.send({ type: 'input_audio_buffer.commit' })
  }

  /** Drop un-committed input audio (after a barge-in cancel, for example). */
  clearInput(): void {
    this.send({ type: 'input_audio_buffer.clear' })
  }

  /**
   * Speak one text through the voice model: a `response.create` whose input is
   * the text and whose modalities include audio. The platform reads the text
   * aloud with the session voice; the consumer receives its audio through
   * {@link RealtimeSessionEvents.onAssistantAudioDelta}.
   * @param text - complete text to speak.
   * @param instructions - optional one-shot delivery instructions.
   */
  speak(text: string, instructions?: string): void {
    this.send({
      type: 'response.create',
      response: {
        modalities: ['text', 'audio'],
        input: [{ type: 'text', text }],
        ...instructions === undefined ? {} : { instructions },
      },
    })
  }

  /** Cancel the response currently streaming. */
  cancelResponse(): void {
    this.send({ type: 'response.cancel' })
  }

  /** Close the connection; later sends throw. Idempotent. */
  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.transport.close(1000, 'client closed')
    } catch {
      // A transport that already died has nothing left to close.
    }
  }

  private send(event: ClientEvent): void {
    if (this.closed) {
      throw new LlmError('StepFun realtime session is closed', 'TRANSPORT')
    }
    this.transport.send(JSON.stringify(event))
  }

  private handleFrame(frame: string): void {
    let event: ServerEvent
    try {
      event = JSON.parse(frame) as ServerEvent
    } catch {
      this.events.onError?.({ type: 'protocol', message: `malformed realtime frame: ${frame.slice(0, 120)}` })
      return
    }
    switch (event.type) {
      case 'session.created':
        return
      case 'input_audio_buffer.speech_started':
        return this.events.onSpeechStarted?.({ audioStartMs: event.audio_start_ms })
      case 'input_audio_buffer.speech_stopped':
        return this.events.onSpeechStopped?.({ audioEndMs: event.audio_end_ms })
      case 'conversation.item.input_audio_transcript.completed':
        return this.events.onUserTranscript?.(event.transcript)
      case 'conversation.item.input_audio_transcript.failed':
        return this.events.onUserTranscriptFailed?.({ message: event.error.message ?? 'transcription failed' })
      case 'response.audio_transcript.delta':
        return this.events.onAssistantTranscriptDelta?.(event.delta)
      case 'response.audio.delta':
        return this.events.onAssistantAudioDelta?.(event.delta)
      case 'response.done':
        return this.events.onResponseDone?.()
      case 'response.cancelled':
        return this.events.onResponseCancelled?.()
      case 'error':
        return this.events.onError?.(event.error)
      default:
        // Merge-extensible server vocabulary: unknown events carry no consumer duty yet.
        return
    }
  }
}
