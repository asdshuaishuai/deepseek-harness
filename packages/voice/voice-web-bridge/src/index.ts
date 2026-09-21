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
// Type-only: pulls the stepfunRealtime service merge (the pinned realtime model read).
import type {} from '@deepseek-ai/dsh-stepfun-realtime'
import { VoiceSocketSession, decodeClientFrame, encodeServerEvent } from './protocol.ts'

export * from './protocol.ts'

/** Stable Cordis plugin name. */
export const name = 'voice-web-bridge'

/** Services the bridge binds: the transport, the trust plane, the conversation service, and the pinned model. */
export const inject = ['webServer', 'connection', 'voiceAgent', 'stepfunRealtime']

/** The exact upgrade path this bridge owns. */
export const VOICE_BRIDGE_PATH = '/voice'

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
  ctx.effect(() => () => {
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
    const payload = Array.isArray(data) ? Buffer.concat(data) : data
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
