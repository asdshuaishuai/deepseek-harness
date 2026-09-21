/**
 * The process-local voice controller: owns the bridge socket, the microphone
 * capture, and the answer player for one browser tab, and publishes a single
 * immutable view snapshot the dock subscribes to (useSyncExternalStore).
 *
 * @module @deepseek-ai/dsh-client-ui-voice/voice-controller
 */

import { answerBase64ToFloat, captureChunkToBase64 } from './voice-codec.ts'
import { AnswerPlayer, MicCapture } from './voice-audio.ts'
import { VoiceSocket, voiceUrl } from './voice-socket.ts'

/** The visible voice phase. */
export type VoicePhase = 'idle' | 'listening' | 'thinking' | 'speaking'

/** The immutable view snapshot the dock renders. */
export interface VoiceView {
  readonly phase: VoicePhase
  /** The pinned realtime model id reported by the host ready frame. */
  readonly realtimeModel: string | undefined
  /** The durable session id, once the host has acknowledged the start. */
  readonly sessionId: string | undefined
  /** Latest finalized user utterance. */
  readonly userText: string
  /** Caption text of the answer currently streaming/playing. */
  readonly assistantText: string
  /** Latest recoverable failure. */
  readonly error: string | undefined
}

/** The controller face the dock consumes (subscribable view + verbs). */
export interface VoiceControllerFace {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => VoiceView
  toggle: (sessionId?: string) => void
  stopConversation: () => void
  commit: () => void
}

/** Test seams: everything touching devices or the network is replaceable. */
export interface VoiceControllerDeps {
  /** Bridge WebSocket URL. */
  readonly url: string
  /** WebSocket constructor; defaults to the global. */
  readonly WebSocketImpl?: typeof WebSocket
  /** Start the microphone; called when capture begins. */
  readonly startMic?: (onChunk: (chunk: Float32Array) => void, signal: AbortSignal) => Promise<void>
  /** Schedule one 24 kHz base64 PCM16 answer frame. */
  readonly playAnswer?: (base64: string) => void
  /** Stop every scheduled/playing answer frame (barge-in, stop, close). */
  readonly stopPlayback?: () => void
}

const IDLE_VIEW: VoiceView = {
  phase: 'idle',
  realtimeModel: undefined,
  sessionId: undefined,
  userText: '',
  assistantText: '',
  error: undefined,
}

/**
 * One controller per browser tab. `toggle(sessionId)` starts or stops the
 * voice loop; snapshots update through `subscribe` (useSyncExternalStore).
 */
export class VoiceController {
  private readonly listeners = new Set<() => void>()
  private view: VoiceView = IDLE_VIEW
  private socket: VoiceSocket | undefined
  private micAbort: AbortController | undefined
  private readonly stopPlayback: () => void

  constructor(private readonly deps: VoiceControllerDeps) {
    this.stopPlayback = deps.stopPlayback ?? (() => {})
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = (): VoiceView => this.view

  private set(partial: Partial<VoiceView>): void {
    this.view = { ...this.view, ...partial }
    for (const listener of this.listeners) listener()
  }

  /** Start the voice loop for one durable session. */
  start(sessionId?: string): void {
    if (this.socket !== undefined) return
    this.set({ phase: 'listening', userText: '', assistantText: '', error: undefined })
    this.socket = new VoiceSocket(this.deps.url, {
      onReady: ({ sessionId: id, realtimeModel }) => {
        this.set({ sessionId: id, realtimeModel })
        this.startMic()
      },
      onState: (state) => {
        this.set({ phase: state })
        // Barge-in: the host cancels the spoken response; the client drops
        // still-buffered audio so playback never lags the interruption.
        if (state === 'listening') this.stopPlayback()
      },
      onUserTranscript: (text) => { this.set({ userText: text }) },
      onAssistantDelta: (delta) => { this.set({ assistantText: this.view.assistantText + delta }) },
      onAssistantFinal: (text) => { this.set({ assistantText: text, phase: 'speaking' }) },
      onAudio: (base64) => {
        void answerBase64ToFloat(base64)
        this.deps.playAnswer?.(base64)
      },
      onError: (message) => { this.set({ error: message }) },
      onClosed: () => { this.reset() },
    })
    this.socket.start(sessionId)
  }

  /** End the conversation; the socket stays open for a later start. */
  stopConversation(): void {
    this.socket?.stop()
    this.stopPlayback()
    this.set({ phase: 'listening', assistantText: '' })
  }

  /** Toggle the loop for a durable session. */
  toggle(sessionId?: string): void {
    if (this.view.phase === 'idle') this.start(sessionId)
    else this.stopConversation()
  }

  /** Forward one captured microphone chunk (base64 PCM16) to the socket. */
  sendAudioChunk(base64: string): void {
    this.socket?.sendAudio(base64)
  }

  /** Force the utterance boundary. */
  commit(): void {
    this.socket?.commit()
  }

  /** Fully stop the loop and release the microphone. */
  close(): void {
    this.socket?.close()
    this.socket = undefined
    this.micAbort?.abort()
    this.micAbort = undefined
    this.stopPlayback()
    this.reset()
  }

  private startMic(): void {
    this.micAbort?.abort()
    this.micAbort = new AbortController()
    const signal = this.micAbort.signal
    void this.deps.startMic?.((chunk: Float32Array) => {
      this.sendAudioChunk(captureChunkToBase64(chunk, 48_000))
    }, signal)
  }

  private reset(): void {
    this.view = IDLE_VIEW
    for (const listener of this.listeners) listener()
  }
}

/** The production controller for the current origin. */
export function createVoiceController(): VoiceController {
  const player = new AnswerPlayer()
  const capture = new MicCapture()
  return new VoiceController({
    url: voiceUrl(window.location.protocol, window.location.host),
    startMic: (onChunk, signal) => capture.start(onChunk, signal),
    stopPlayback: () =>{  player.stopAll() },
    playAnswer: (base64) =>{  player.play(base64) },
  })
}

export { VoiceSocket, voiceUrl } from './voice-socket.ts'
export type { VoiceSocketCallbacks } from './voice-socket.ts'
