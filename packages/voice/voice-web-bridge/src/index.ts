/**
 * Host-side browser voice bridge: one WebSocket per duplex voice conversation.
 * The browser sends microphone frames (binary PCM16 16 kHz mono) and JSON
 * control frames (`start`/`commit`/`stop`); the bridge binds them to
 * `ctx.voiceAgent` — whose realtime session and agent live host-side, so the
 * API key never reaches the browser — and streams conversation events plus
 * 24 kHz PCM16 answer audio back as JSON text frames and binary frames.
 *
 * The realtime model is pinned host-side by the billing channel (the browser
 * cannot select one); the `ready` frame reports the resolved id.
 *
 * @module @deepseek-ai/dsh-voice-web-bridge
 */

import { WebSocketServer, type WebSocket } from 'ws'
import { Buffer } from 'node:buffer'
import type { Duplex } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
// Type-only: pulls the webServer service merge (ctx.webServer) and ctx.effect overloads.
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { VoiceConversation, VoiceConversationEvents } from '@deepseek-ai/dsh-voice-agent'
// Type-only: pulls the stepfunRealtime service merge (the pinned realtime model read).
// Type-only: pulls the stepfunRealtime service merge (the pinned realtime model read).
import type {} from '@deepseek-ai/dsh-stepfun-realtime'

/** Stable Cordis plugin name. */
export const name = 'voice-web-bridge'

/** Services the bridge binds: the transport, the trust plane, the conversation service, and the pinned model. */
export const inject = ['webServer', 'connection', 'voiceAgent', 'stepfunRealtime']

/** The exact upgrade path this bridge owns. */
export const VOICE_BRIDGE_PATH = '/voice'

/** Host → browser JSON control events. */
export type BridgeServerEvent =
  | { type: 'ready'; sessionId: string; realtimeModel: string }
  | { type: 'state'; state: 'listening' | 'thinking' | 'speaking' }
  | { type: 'user-transcript'; text: string }
  | { type: 'assistant-delta'; delta: string }
  | { type: 'assistant-final'; text: string }
  | { type: 'error'; message: string }
  | { type: 'closed'; reason: string }

/** Browser → host JSON control frames. */
export type BridgeClientFrame =
  | { type: 'start'; sessionId?: string }
  | { type: 'commit' }
  | { type: 'stop' }

/** Largest binary microphone frame accepted from the browser (256 KiB ≈ 8 s of 16 kHz PCM16). */
export const MAX_AUDIO_FRAME_BYTES = 256 * 1024

/** Encode one server control event as a socket text frame. */
export function encodeServerEvent(event: BridgeServerEvent): string {
  return JSON.stringify(event)
}

/**
 * Decode one client text frame. Malformed or unknown frames return
 * `undefined`; the caller reports and keeps the socket open.
 * @param raw - one socket text frame.
 */
export function decodeClientFrame(raw: string): BridgeClientFrame | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const type = (value as { type?: unknown }).type
  if (type === 'start') {
    const sessionId = (value as { sessionId?: unknown }).sessionId
    if (sessionId !== undefined && typeof sessionId !== 'string') return undefined
    return { type: 'start', ...typeof sessionId === 'string' && sessionId.length > 0 ? { sessionId } : {} }
  }
  if (type === 'commit') return { type: 'commit' }
  if (type === 'stop') return { type: 'stop' }
  return undefined
}

/** The narrow conversation surface the bridge drives. */
type BoundConversation = Pick<VoiceConversation, 'id' | 'sendAudio' | 'commitUtterance' | 'close'>

/** One conversation bound to one browser socket. */
export interface VoiceSocketSessionOptions {
  /**
   * Open a conversation, optionally adopting an existing Session identity.
   * The session wires its own events into the given callbacks — they are the
   * socket side of the duplex loop (state, transcripts, captions, audio).
   * The narrow conversation surface is what the bridge touches: the durable
   * identity, microphone frames in, the utterance boundary, and close.
   */
  openConversation(
    sessionId: string | undefined,
    events: VoiceConversationEvents,
  ): Promise<Pick<VoiceConversation, 'id' | 'sendAudio' | 'commitUtterance' | 'close'>>
  /** The pinned realtime model id reported in the `ready` frame. */
  realtimeModel: string
  /** Send one text frame to the browser. */
  sendText(frame: string): void
  /** Send one binary frame of 24 kHz PCM16 answer audio to the browser. */
  sendBinary(frame: Buffer): void
  /** Close the browser socket (conversation end or protocol failure). */
  closeSocket(): void
}

/**
 * Per-socket protocol state machine: at most one conversation per socket, at
 * most one in-flight `start`, binary frames only while a conversation exists,
 * and a `stop` that closes the conversation but keeps the socket open.
 */
export class VoiceSocketSession {
  private conversation: BoundConversation | undefined
  private starting = false
  private closed = false

  constructor(private readonly options: VoiceSocketSessionOptions) {}

  /** Whether a conversation is currently bound. */
  get bound(): boolean {
    return this.conversation !== undefined
  }

  /** Handle one decoded control frame. */
  async handleFrame(frame: BridgeClientFrame): Promise<void> {
    if (this.closed) return
    switch (frame.type) {
      case 'start': {
        if (this.conversation !== undefined || this.starting) {
          this.sendError('a voice conversation is already active on this socket')
          return
        }
        this.starting = true
        try {
          this.conversation = await this.options.openConversation(frame.sessionId, {
            onState: (state) => { this.options.sendText(encodeServerEvent({ type: 'state', state })) },
            onUserTranscript: (text) => { this.options.sendText(encodeServerEvent({ type: 'user-transcript', text })) },
            onAssistantDelta: (delta) => { this.options.sendText(encodeServerEvent({ type: 'assistant-delta', delta })) },
            onAssistantFinal: (text) => { this.options.sendText(encodeServerEvent({ type: 'assistant-final', text })) },
            onAudio: (base64) => { this.options.sendBinary(Buffer.from(base64, 'base64')) },
            onError: (message) => { this.options.sendText(encodeServerEvent({ type: 'error', message })) },
            onClose: (event) => {
              this.conversation = undefined
              this.options.sendText(encodeServerEvent({ type: 'closed', reason: event.reason }))
              this.options.closeSocket()
            },
          })
        } catch (error: unknown) {
          this.starting = false
          this.sendError(error instanceof Error ? error.message : String(error))
          return
        }
        this.starting = false
        this.options.sendText(encodeServerEvent({
          type: 'ready',
          sessionId: String(this.conversation.id),
          realtimeModel: this.options.realtimeModel,
        }))
        return
      }
      case 'commit': {
        this.conversation?.commitUtterance()
        return
      }
      case 'stop': {
        await this.endConversation()
        return
      }
    }
  }

  /** Handle one binary microphone frame; bytes are forwarded 1:1 host-side. */
  handleAudio(frame: Buffer): void {
    if (this.closed) return
    if (frame.byteLength === 0) return
    if (frame.byteLength > MAX_AUDIO_FRAME_BYTES) {
      this.sendError(`audio frame exceeds the ${MAX_AUDIO_FRAME_BYTES}-byte cap`)
      return
    }
    if (this.conversation === undefined) {
      this.sendError('no active voice conversation: send start first')
      return
    }
    this.conversation.sendAudio(frame.toString('base64'))
  }

  /** The conversation closed (socket drop or voice-channel loss): end cleanly. */
  handleConversationClosed(reason: string): void {
    this.options.sendText(encodeServerEvent({ type: 'closed', reason }))
    this.options.closeSocket()
  }

  /** End the conversation and keep the socket open for a later `start`. */
  async endConversation(): Promise<void> {
    const conversation = this.conversation
    this.conversation = undefined
    if (conversation === undefined) return
    await conversation.close().catch((error: unknown) => {
      this.sendError(error instanceof Error ? error.message : String(error))
    })
  }

  private sendError(message: string): void {
    this.options.sendText(encodeServerEvent({ type: 'error', message }))
  }

  /** Internal: the socket is gone — drop the conversation without socket writes. */
  internalAbandon(): void {
    this.closed = true
    void this.conversation?.close().catch(() => {})
    this.conversation = undefined
  }
}

/** Plugin config. */
export interface Config {
  /** Upgrade path to own. Defaults to `/voice`. */
  path?: string
}

export const Config: z<Config> = z.object({
  path: z.string(),
})

/** Plugin body: register the voice upgrade route with the web server. */
export function apply(ctx: Context, config: Config): void {
  const path = config.path ?? VOICE_BRIDGE_PATH
  const server = new WebSocketServer({ noServer: true })
  // Structural view of the host Connection trust plane: the merge lives in
  // the client-connection host module, which is not part of this package's
  // compilation graph.
  const trust = (ctx as { connection?: unknown }).connection as
    | { requestRejection(request: { headers: IncomingMessage['headers'] }): 401 | 403 | undefined }
    | undefined
  if (trust === undefined) {
    ctx.logger.warn('voice-web-bridge: no connection service; the voice upgrade route stays closed')
    return
  }
  const route: WebUpgradeRoute = {
    path,
    handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const rejection = trust.requestRejection({ headers: req.headers })
      if (rejection !== undefined) {
        socket.write(`HTTP/1.1 ${rejection} Rejected\r\nConnection: close\r\n\r\n`)
        socket.destroy()
        return
      }
      server.handleUpgrade(req, socket, head, (websocket) => {
        bindSocket(ctx, websocket)
      })
    },
  }
  const unregister = ctx.webServer.registerUpgrade(route)
  ctx.effect(() => async () => {
    unregister()
    server.close()
  })
}

/** Bind one upgraded browser socket to one protocol state machine. */
function bindSocket(ctx: Context, websocket: WebSocket): void {
  websocket.binaryType = 'nodebuffer'
  const session = new VoiceSocketSession({
    // The realtime model is pinned host-side by the billing channel; the
    // browser only learns which one is live from the ready frame.
    realtimeModel: ctx.stepfunRealtime.options.model,
    openConversation: (sessionId, events) => ctx.voiceAgent.createConversation(
      { ...sessionId === undefined ? {} : { sessionId }, realtime: {} },
      events,
    ),
    sendText: (frame) => {
      if (websocket.readyState === websocket.OPEN) websocket.send(frame)
    },
    sendBinary: (frame) => {
      if (websocket.readyState === websocket.OPEN) websocket.send(frame)
    },
    closeSocket: () => { websocket.close(1000, 'voice conversation ended') },
  })

  websocket.on('message', (data: Buffer[] | Buffer, isBinary: boolean) => {
    const payload = Array.isArray(data) ? Buffer.concat(data) : data as Buffer
    if (isBinary) {
      session.handleAudio(payload)
      return
    }
    const frame = decodeClientFrame(payload.toString('utf8'))
    if (frame === undefined) {
      websocket.send(encodeServerEvent({ type: 'error', message: 'unrecognized control frame' }))
      return
    }
    void session.handleFrame(frame)
  })

  websocket.on('close', () => {
    session.internalAbandon()
  })

  websocket.on('error', () => {
    session.internalAbandon()
  })
}
