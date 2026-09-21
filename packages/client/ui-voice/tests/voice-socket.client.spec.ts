/** VoiceSocket state machine over a recorded WebSocket stand-in. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VoiceSocket, voiceUrl } from '../src/client/voice-socket.ts'
import type { VoiceSocketCallbacks } from '../src/client/voice-socket.ts'

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static instances: FakeWebSocket[] = []
  readyState = FakeWebSocket.CONNECTING
  binaryType = ''
  readonly sent: Array<string | Uint8Array> = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  send(frame: string | Uint8Array): void {
    this.sent.push(frame)
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3
    this.onclose?.({ code: code ?? 1000, reason: reason ?? '' })
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  text(frame: string): void {
    this.onmessage?.({ data: frame })
  }

  binary(bytes: ArrayBuffer): void {
    this.onmessage?.({ data: bytes })
  }
}

function stubGlobalWebSocket(): void {
  const previous = (globalThis as { WebSocket?: unknown }).WebSocket
  ;(globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket
  ;(globalThis as { __restore_ws__?: () => void }).__restore_ws__ = () => {
    if (previous === undefined) delete (globalThis as { WebSocket?: unknown }).WebSocket
    else (globalThis as { WebSocket?: unknown }).WebSocket = previous
  }
}

function restoreGlobalWebSocket(): void {
  ;(globalThis as { __restore_ws__?: () => void }).__restore_ws__?.()
}

describe('voiceUrl', () => {
  it('upgrades https origins to wss and http to ws', () => {
    expect(voiceUrl('https:', 'host.test')).toBe('wss://host.test/voice')
    expect(voiceUrl('http:', 'host.test')).toBe('ws://host.test/voice')
  })
})

describe('VoiceSocket', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    restoreGlobalWebSocket()
    FakeWebSocket.instances = []
  })

  function makeSocket(callbacks: VoiceSocketCallbacks = {}): { socket: VoiceSocket; fake: FakeWebSocket } {
    stubGlobalWebSocket()
    const socket = new VoiceSocket('wss://h/voice', callbacks)
    socket.start()
    const fake = FakeWebSocket.instances.at(-1) as FakeWebSocket
    fake.open()
    return { socket, fake }
  }

  it('sends start on open, with an optional session id', () => {
    const { socket, fake } = makeSocket()
    expect(fake.sent).toEqual(['{"type":"start"}'])
    expect(socket.active).toBe(true)
    socket.start('s-2')
    // A second start is ignored while the socket exists.
    expect(fake.sent).toHaveLength(1)
    socket.close()
  })

  it('routes JSON server events to callbacks', () => {
    const seen: Record<string, unknown[]> = {}
    const track = (key: string) => (value: unknown) => { (seen[key] ??= []).push(value) }
    const { socket, fake } = makeSocket({
      onReady: track('ready'),
      onState: track('state'),
      onUserTranscript: track('user'),
      onAssistantDelta: track('delta'),
      onAssistantFinal: track('final'),
      onError: track('error'),
      onClosed: track('closed'),
    })
    fake.text('{"type":"ready","sessionId":"s","realtimeModel":"m"}')
    fake.text('{"type":"state","state":"thinking"}')
    fake.text('{"type":"user-transcript","text":"hi"}')
    fake.text('{"type":"assistant-delta","delta":"a"}')
    fake.text('{"type":"assistant-final","text":"a"}')
    fake.text('{"type":"error","message":"boom"}')
    fake.text('{"type":"closed","reason":"x"}')
    // Unknown event kinds carry no consumer duty.
    fake.text('{"type":"something.new"}')
    expect(seen.ready).toEqual([{ sessionId: 's', realtimeModel: 'm' }])
    expect(seen.state).toEqual(['thinking'])
    expect(seen.user).toEqual(['hi'])
    expect(seen.delta).toEqual(['a'])
    expect(seen.final).toEqual(['a'])
    expect(seen.error).toEqual(['boom'])
    expect(seen.closed).toEqual(['x'])
    socket.close()
  })

  it('routes binary server frames to the audio callback as base64', () => {
    const audio: string[] = []
    const { socket, fake } = makeSocket({ onAudio: (b64) => { audio.push(b64) } })
    const bytes = new Uint8Array([65, 66, 67])
    fake.binary(bytes.buffer)
    expect(audio).toEqual([btoa('ABC')])
    socket.close()
  })

  it('routes binary frames that arrive as typed-array views, not ArrayBuffers', () => {
    const audio: string[] = []
    const { socket, fake } = makeSocket({ onAudio: (b64) => { audio.push(b64) } })
    fake.onmessage?.({ data: new Uint8Array([9, 8]) } as unknown as { data: string | ArrayBuffer })
    expect(audio).toEqual([btoa(String.fromCharCode(9, 8))])
    socket.close()
  })

  it('ignores control frames that are not JSON', () => {
    const { socket, fake } = makeSocket()
    expect(() =>{  fake.text('not-json') }).not.toThrow()
    expect(fake.sent).toEqual(['{"type":"start"}'])
    socket.close()
  })

  it('no-ops commit and stop while the socket is not open', () => {
    const { socket, fake } = makeSocket()
    fake.readyState = FakeWebSocket.CONNECTING
    socket.commit()
    socket.stop()
    expect(fake.sent).toEqual(['{"type":"start"}'])
    socket.close()
  })

  it('falls back to a code-based close reason when the server sends none', () => {
    const closed: string[] = []
    makeSocket({ onClosed: (reason) => { closed.push(reason) } })
    const fake = FakeWebSocket.instances.at(-1) as FakeWebSocket
    fake.onclose?.({ code: 1006, reason: '' })
    expect(closed).toEqual(['closed (1006)'])
  })

  it('sends commit, stop, audio, and close through the socket', () => {
    const { socket, fake } = makeSocket()
    socket.sendAudio('QUJD')
    socket.commit()
    socket.stop()
    const frames = fake.sent.map(frame => frame instanceof Uint8Array ? 'bin' : frame)
    expect(frames).toEqual(['{"type":"start"}', 'bin', '{"type":"commit"}', '{"type":"stop"}'])
    socket.close()
  })

  it('drops audio sent before the socket is open', () => {
    stubGlobalWebSocket()
    const socket = new VoiceSocket('wss://h/voice', {})
    socket.sendAudio('QUJD')
    expect(FakeWebSocket.instances.at(-1)?.sent ?? []).toEqual([])
  })
})
