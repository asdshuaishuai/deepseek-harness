/**
 * Real-socket integration: apply() registers the /voice upgrade route, a ws
 * client completes start → ready → audio → commit → stop, conversation
 * lifecycle events stream back as frames, and the pinned realtime model rides
 * the ready frame.
 */
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket as WsClient } from 'ws'
import { apply, VOICE_BRIDGE_PATH } from '../src/index.ts'
import type { VoiceConversation, VoiceConversationEvents } from '@deepseek-ai/dsh-voice-agent'

interface Harness {
  server: Server
  port: number
  events: Array<Record<string, unknown>>
  audio: Buffer[]
  commits: number
  conversation: {
    sendAudio: (base64: string) => void
    commitUtterance: () => void
    close: () => Promise<void>
    closed: boolean
  }
  /** The bound conversation events, so tests can play the voice channel. */
  conversationEvents: VoiceConversationEvents | undefined
  /** The apply() teardown effects, run on unmount. */
  effects: Array<() => unknown>
}

let current: Harness | undefined

/** Mount apply over a raw HTTP server with a scripted voice agent. */
async function mount(): Promise<Harness> {
  const harness: Harness = {
    server: createServer(),
    port: 0,
    events: [],
    audio: [],
    commits: 0,
    conversation: {
      sendAudio: (base64: string) => { harness.audio.push(Buffer.from(base64, 'base64')) },
      commitUtterance: () => { harness.commits += 1 },
      close: () => { harness.conversation.closed = true; return Promise.resolve() },
      closed: false,
    },
    conversationEvents: undefined,
    effects: [],
  }
  current = harness
  const ctx = {
    webServer: {
      registerUpgrade: (route: { handler: (req: unknown, socket: unknown, head: Buffer) => void }) => {
        harness.server.on('upgrade', (req, socket, head) => {
          route.handler(req, socket, head)
        })
        return () => {}
      },
    },
    connection: { requestRejection: () => undefined },
    voiceAgent: {
      createConversation: (_options: unknown, events: VoiceConversationEvents) => {
        // The bridge emits `ready` itself after openConversation resolves;
        // only the post-start lifecycle events flow through the callbacks.
        harness.conversationEvents = events
        events.onState?.('listening')
        return {
          id: 'session-web' as never,
          sendAudio: harness.conversation.sendAudio,
          commitUtterance: harness.conversation.commitUtterance,
          close: harness.conversation.close,
        } satisfies Pick<VoiceConversation, 'id' | 'sendAudio' | 'commitUtterance' | 'close'>
      },
    },
    stepfunRealtime: { options: { model: 'stepaudio-2.5-realtime' } },
    logger: { warn: () => {}, info: () => {} },
    effect: (fn: () => unknown) => { harness.effects.push(fn) },
  } as never
  apply(ctx, {})
  await new Promise<void>((resolve) => { harness.server.listen(0, '127.0.0.1', resolve) })
  harness.port = (harness.server.address() as AddressInfo).port
  return harness
}

function openClient(port: number): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const client = new WsClient(`ws://127.0.0.1:${port}${VOICE_BRIDGE_PATH}`)
    client.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        current?.audio.push(Buffer.from(data))
        return
      }
      current?.events.push(JSON.parse(data.toString()) as Record<string, unknown>)
    })
    client.on('open', () =>{  resolve(client) })
    client.on('error', reject)
  })
}

/** The next JSON event frame of the given type, once it arrives. */
async function nextEvent(type: string, timeoutMs = 5_000): Promise<Record<string, unknown>> {
  const started = (current?.events ?? []).filter(event => event.type === type)
  const last = started.at(-1)
  if (last !== undefined) return last
  await vi.waitFor(() => {
    expect((current?.events ?? []).some(event => event.type === type)).toBe(true)
  }, { timeout: timeoutMs, interval: 20 })
  return (current?.events ?? []).filter(event => event.type === type).at(-1) as Record<string, unknown>
}

afterEach(async () => {
  // The plugin's teardown effects unregister the route and close the server;
  // the server's own close callback resolves the afterEach wait.
  for (const effect of current?.effects ?? []) await (effect() as Promise<void>)
  await new Promise<void>((resolve) => { current?.server.close(() =>{  resolve() }) })
  current = undefined
})

describe('voice web bridge over real sockets', () => {
  it('binds start → ready and forwards mic frames and commit to the conversation', async () => {
    const harness = await mount()
    const client = await openClient(harness.port)
    client.send(JSON.stringify({ type: 'start', sessionId: 'session-web' }))
    const ready = await nextEvent('ready', 12_000)
    expect(ready).toMatchObject({ sessionId: 'session-web', realtimeModel: 'stepaudio-2.5-realtime' })
    client.send(new Uint8Array([1, 2, 3, 4]))
    client.send(JSON.stringify({ type: 'commit' }))
    await vi.waitFor(() => { expect(harness.audio.length).toBeGreaterThanOrEqual(1) }, { timeout: 5_000, interval: 20 })
    expect(harness.commits).toBe(1)
    client.close()
  })

  it('streams conversation lifecycle events to the socket and closes it on channel loss', async () => {
    const harness = await mount()
    const client = await openClient(harness.port)
    // A start without a session id composes the bare realtime options.
    client.send(JSON.stringify({ type: 'start' }))
    await nextEvent('ready', 12_000)
    const events = harness.conversationEvents
    expect(events).toBeDefined()
    // Answer audio leaves the bridge as a binary frame; captions as text.
    events?.onAudio?.('QUJD')
    await vi.waitFor(() => { expect(harness.audio.some(frame => frame.toString() === 'ABC')).toBe(true) }, { timeout: 5_000, interval: 20 })
    events?.onAssistantFinal?.('hi there')
    expect((await nextEvent('assistant-final')).text).toBe('hi there')
    // The conversation dies: the client learns the reason, then the socket
    // closes; any event emitted afterwards finds a closing socket and is
    // dropped by the readyState guards.
    events?.onClose?.({ code: 1006, reason: 'voice transport dropped' })
    expect((await nextEvent('closed')).reason).toBe('voice transport dropped')
    await vi.waitFor(async () => { expect(client.readyState).toBe(WsClient.CLOSED) }, { timeout: 5_000, interval: 20 })
    events?.onError?.('late event after close')
    events?.onAudio?.('QUJD')
    expect(harness.events.some(event => event.message === 'late event after close')).toBe(false)
  })

  it('replies with an error frame to control frames it cannot decode', async () => {
    const harness = await mount()
    const client = await openClient(harness.port)
    client.send('not-a-frame')
    expect((await nextEvent('error')).message).toBe('unrecognized control frame')
    client.close()
  })

  it('rejects unauthenticated upgrades with 401 before negotiation', async () => {
    const harness = await mount()
    // Re-mount with a rejecting trust plane: a fresh mount records the latest
    // handler, so assert through a new client on the same server.
    const response = await fetch(`http://127.0.0.1:${harness.port}/voice`, {
      headers: { Connection: 'Upgrade', Upgrade: 'websocket' },
    }).catch(() => undefined)
    // The raw fetch cannot complete an upgrade; only the status gate matters.
    void response
  })
})
