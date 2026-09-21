/**
 * Browser side of the /voice bridge: one WebSocket, JSON control frames as
 * text, microphone audio as binary frames. Server events surface as typed
 * callbacks; the socket owns no audio logic.
 *
 * @module @deepseek-ai/dsh-client-ui-voice/voice-socket
 */

/** Server → browser events (JSON text frames). */
export type VoiceServerEvent =
  | { type: 'ready'; sessionId: string; realtimeModel: string }
  | { type: 'state'; state: 'listening' | 'thinking' | 'speaking' }
  | { type: 'user-transcript'; text: string }
  | { type: 'assistant-delta'; delta: string }
  | { type: 'assistant-final'; text: string }
  | { type: 'error'; message: string }
  | { type: 'closed'; reason: string }

/** Client callbacks; unset members are ignored. */
export interface VoiceSocketCallbacks {
  onReady?: (event: { sessionId: string; realtimeModel: string }) => void
  onState?: (state: 'listening' | 'thinking' | 'speaking') => void
  onUserTranscript?: (text: string) => void
  onAssistantDelta?: (delta: string) => void
  onAssistantFinal?: (text: string) => void
  onAudio?: (base64: string) => void
  onError?: (message: string) => void
  onClosed?: (reason: string) => void
  /** The socket itself reached the open state. */
  onOpen?: () => void
}

/** Compose the voice bridge URL for the current origin. */
export function voiceUrl(protocol: string, host: string): string {
  const secure = protocol === 'https:'
  return `${secure ? 'wss:' : 'ws:'}//${host}/voice`
}

/**
 * The browser voice socket. `start` opens the WebSocket and sends the start
 * frame once the socket opens; `sendAudio` forwards base64 PCM16 16 kHz
 * microphone frames; `stop` closes the conversation; `close` drops the
 * socket entirely.
 */
export class VoiceSocket {
  private socket: WebSocket | undefined
  private opened = false

  constructor(
    private readonly url: string,
    private readonly callbacks: VoiceSocketCallbacks,
  ) {}

  start(sessionId?: string): void {
    if (this.socket !== undefined) return
    const socket = new WebSocket(this.url)
    socket.binaryType = 'arraybuffer'
    this.socket = socket
    socket.onopen = () => {
      this.opened = true
      this.callbacks.onOpen?.()
      socket.send(JSON.stringify({ type: 'start', ...sessionId === undefined ? {} : { sessionId } }))
    }
    socket.onmessage = (event) => {
      const data: unknown = event.data
      if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        let binary = ''
        for (const byte of bytes) binary += String.fromCharCode(byte)
        this.callbacks.onAudio?.(btoa(binary))
        return
      }
      let parsed: VoiceServerEvent | undefined
      try {
        parsed = JSON.parse(data as string) as VoiceServerEvent
      } catch {
        return
      }
      switch (parsed.type) {
        case 'ready': return this.callbacks.onReady?.({ sessionId: parsed.sessionId, realtimeModel: parsed.realtimeModel })
        case 'state': return this.callbacks.onState?.(parsed.state)
        case 'user-transcript': return this.callbacks.onUserTranscript?.(parsed.text)
        case 'assistant-delta': return this.callbacks.onAssistantDelta?.(parsed.delta)
        case 'assistant-final': return this.callbacks.onAssistantFinal?.(parsed.text)
        case 'error': return this.callbacks.onError?.(parsed.message)
        case 'closed': return this.callbacks.onClosed?.(parsed.reason)
        default: return
      }
    }
    socket.onclose = (event) => {
      this.socket = undefined
      this.opened = false
      this.callbacks.onClosed?.(event.reason || `closed (${event.code})`)
    }
  }

  /** Whether the socket is open and the start frame has been sent. */
  get active(): boolean {
    return this.opened && this.socket !== undefined
  }

  /** Stream one base64 PCM16 16 kHz microphone frame. */
  sendAudio(base64: string): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return
    const bytes = new Uint8Array(base64.length)
    for (let i = 0; i < base64.length; i += 1) bytes[i] = base64.charCodeAt(i)
    this.socket.send(bytes)
  }

  /** Force the utterance boundary. */
  commit(): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return
    this.socket.send(JSON.stringify({ type: 'commit' }))
  }

  /** End the conversation; the socket stays open for a later start. */
  stop(): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return
    this.socket.send(JSON.stringify({ type: 'stop' }))
  }

  /** Drop the socket entirely. */
  close(): void {
    this.socket?.close(1000, 'client closed')
    this.socket = undefined
    this.opened = false
  }
}
