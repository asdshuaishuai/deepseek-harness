/**
 * Transport seam for the realtime WebSocket. Production uses the global
 * `WebSocket` client; tests substitute an in-process fake. The seam keeps the
 * session's protocol logic keyless and deterministic under test.
 *
 * @module dsh-stepfun-realtime/transport
 */

/** One established realtime connection. */
export interface RealtimeTransport {
  /** Send one JSON frame; throws after close. */
  send(frame: string): void
  /** Close the connection; subsequent sends throw. */
  close(code?: number, reason?: string): void
  /** Install the frame listener; replacing the previous one. */
  onFrame(listener: (frame: string) => void): void
  /** Install the close listener; replacing the previous one. */
  onClose(listener: (code: number, reason: string) => void): void
  /** Install the failure listener; replacing the previous one. */
  onError(listener: (error: unknown) => void): void
}

/** Connect options handed to the transport factory. */
export interface RealtimeConnectOptions {
  /** Validated public WS(S) endpoint already carrying the model query. */
  url: string
  /** Bearer token for the connection. */
  authorization: string
}

/** Factory shape for {@link RealtimeTransport}; overridable per test. */
export type RealtimeTransportFactory = (options: RealtimeConnectOptions) => RealtimeTransport

/** Adapter over the global WHATWG WebSocket client. */
class WebSocketTransport implements RealtimeTransport {
  private readonly socket: WebSocket
  private frameListener: (frame: string) => void = () => {}
  private closeListener: (code: number, reason: string) => void = () => {}
  private errorListener: (error: unknown) => void = () => {}

  constructor(options: RealtimeConnectOptions) {
    this.socket = new WebSocket(options.url)
    this.socket.binaryType = 'arraybuffer'
    this.socket.onmessage = (event: MessageEvent) => {
      const data = typeof event.data === 'string'
        ? event.data
        : new TextDecoder().decode(event.data as ArrayBuffer)
      this.frameListener(data)
    }
    this.socket.onclose = (event: CloseEvent) => {
      this.closeListener(event.code, event.reason)
    }
    this.socket.onerror = (event: Event) => {
      this.errorListener(event)
    }
  }

  send(frame: string): void {
    this.socket.send(frame)
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason)
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
}

/** Production transport factory over the global WebSocket client. */
export const globalWebSocketTransport: RealtimeTransportFactory = options => new WebSocketTransport(options)
