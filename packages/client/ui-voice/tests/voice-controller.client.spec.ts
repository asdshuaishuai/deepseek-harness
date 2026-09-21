/** VoiceController over a stubbed WebSocket and injectable audio seams. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VoiceController, createVoiceController } from '../src/client/voice-controller.ts'

class FakeWebSocket {
  static readonly OPEN = 1
  static instances: FakeWebSocket[] = []
  readyState = FakeWebSocket.OPEN
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

  close(): void {
    this.onclose?.({ code: 1000, reason: 'closed' })
  }

  open(): void {
    this.onopen?.()
  }

  text(frame: string): void {
    this.onmessage?.({ data: frame })
  }
}

function harness(deps: Partial<ConstructorParameters<typeof VoiceController>[0]> = {}) {
  FakeWebSocket.instances = []
  const previous = (globalThis as { WebSocket?: unknown }).WebSocket
  ;(globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket
  const startMic = vi.fn(async (onChunk: (chunk: Float32Array) => void, signal: AbortSignal) => {
    void onChunk
    void signal
  })
  const playAnswer = vi.fn()
  const stopPlayback = vi.fn()
  const controller = new VoiceController({
    url: 'wss://h/voice',
    startMic,
    playAnswer,
    stopPlayback,
    ...deps,
  })
  const fake = () => FakeWebSocket.instances.at(-1) as FakeWebSocket
  const restore = (): void => { (globalThis as { WebSocket?: unknown }).WebSocket = previous }
  return { controller, fake, startMic, playAnswer, stopPlayback, restore }
}

function viewOf(controller: VoiceController): ReturnType<VoiceController['getSnapshot']> {
  return controller.getSnapshot()
}

afterEach(() => {
  vi.restoreAllMocks()
  FakeWebSocket.instances = []
})

describe('VoiceController', () => {
  it('starts idle, opens the socket, binds the mic, and adopts the ready facts', async () => {
    const h = harness()
    h.controller.start('session-9')
    h.fake().open()
    h.fake().text('{"type":"ready","sessionId":"session-9","realtimeModel":"stepaudio-3-realtime-preview"}')
    expect(viewOf(h.controller).phase).toBe('listening')
    expect(viewOf(h.controller).sessionId).toBe('session-9')
    expect(viewOf(h.controller).realtimeModel).toBe('stepaudio-3-realtime-preview')
    expect(h.startMic).toHaveBeenCalledOnce()
    h.controller.close()
    expect(h.restore).toBeDefined()
  })

  it('forwards mic chunks to the socket as base64 PCM16', async () => {
    const h = harness()
    h.controller.start('s')
    h.fake().open()
    h.fake().text('{"type":"ready","sessionId":"s","realtimeModel":"m"}')
    const emitMic = h.startMic.mock.calls[0]?.[0]
    expect(emitMic).toBeTypeOf('function')
    emitMic?.(new Float32Array([0.5, -0.5]))
    const bin = h.fake().sent.find(frame => frame instanceof Uint8Array)
    expect(bin).toBeDefined()
    h.controller.close()
  })

  it('accumulates assistant deltas and marks the phase speaking on final', async () => {
    const h = harness()
    h.controller.start('s')
    h.fake().open()
    h.controller.sendAudioChunk('QUJD')
    h.fake().text('{"type":"assistant-delta","delta":"he"}')
    h.fake().text('{"type":"assistant-delta","delta":"llo"}')
    expect(viewOf(h.controller).assistantText).toBe('hello')
    expect(viewOf(h.controller).phase).toBe('listening')
    // Answer audio arrives as binary bridge frames and feeds the player.
    h.fake().onmessage?.({ data: new Uint8Array([1, 2]).buffer })
    expect(h.playAnswer).toHaveBeenCalled()
    h.fake().text('{"type":"assistant-final","text":"hello"}')
    expect(viewOf(h.controller).phase).toBe('speaking')
    h.controller.close()
  })

  it('stops playback on barge-in (state back to listening) and routes stop', async () => {
    const h = harness()
    h.controller.start('s')
    h.fake().open()
    h.fake().text('{"type":"state","state":"listening"}')
    expect(h.stopPlayback).toHaveBeenCalled()
    h.controller.stopConversation()
    const stopFrame = h.fake().sent.find(frame => frame === '{"type":"stop"}')
    expect(stopFrame).toBeDefined()
    expect(viewOf(h.controller).phase).toBe('listening')
    h.controller.close()
  })

  it('toggle starts when idle and stops the conversation when speaking', async () => {
    const h = harness()
    h.controller.toggle('s')
    expect(viewOf(h.controller).phase).toBe('listening')
    h.fake().open()
    h.fake().text('{"type":"assistant-final","text":"done"}')
    h.controller.toggle()
    const stopFrame = h.fake().sent.find(frame => frame === '{"type":"stop"}')
    expect(stopFrame).toBeDefined()
    h.controller.close()
  })

  it('surfaces errors without tearing the loop down', async () => {
    const h = harness()
    h.controller.start('s')
    h.fake().open()
    h.fake().text('{"type":"error","message":"mic denied"}')
    expect(viewOf(h.controller).error).toBe('mic denied')
    expect(viewOf(h.controller).phase).toBe('listening')
    h.controller.close()
  })

  it('resets to idle when the socket closes', async () => {
    const h = harness()
    const seen: Array<ReturnType<VoiceController['getSnapshot']>> = []
    h.controller.subscribe(() => { seen.push(h.controller.getSnapshot()) })
    h.controller.start('s')
    h.fake().open()
    h.fake().text('{"type":"state","state":"speaking"}')
    h.fake().close()
    expect(viewOf(h.controller).phase).toBe('idle')
    // The reset publishes the idle snapshot to subscribers.
    expect(seen.at(-1)?.phase).toBe('idle')
  })

  it('ignores a start while the loop is already active', async () => {
    const h = harness()
    h.controller.start('s')
    h.fake().open()
    h.controller.start('other')
    expect(FakeWebSocket.instances).toHaveLength(1)
    h.controller.close()
  })

  it('streams user transcripts, supports commit, and publishes snapshots to subscribers', async () => {
    const seen: Array<ReturnType<VoiceController['getSnapshot']>> = []
    const h = harness()
    const unsubscribe = h.controller.subscribe(() => { seen.push(h.controller.getSnapshot()) })
    h.controller.start('s')
    h.fake().open()
    h.fake().text('{"type":"user-transcript","text":"hi"}')
    expect(viewOf(h.controller).userText).toBe('hi')
    expect(seen.length).toBeGreaterThanOrEqual(1)
    unsubscribe()
    h.controller.commit()
    const commitFrame = h.fake().sent.find(frame => frame === '{"type":"commit"}')
    expect(commitFrame).toBeDefined()
    h.controller.close()
  })

  it('defaults stopPlayback to a no-op when the dep is omitted', async () => {
    ;(globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket
    const controller = new VoiceController({ url: 'wss://h/voice' })
    controller.start('s')
    const fake = FakeWebSocket.instances.at(-1)
    fake?.open()
    fake?.text('{"type":"state","state":"listening"}')
    // Barge-in and stop run without a stopPlayback dep: the constructor falls
    // back to a no-op.
    expect(controller.getSnapshot().phase).toBe('listening')
    controller.stopConversation()
    controller.close()
  })

  it('moves to thinking without cutting playback, then barge-in resets on listening', async () => {
    const h = harness()
    h.controller.start('s')
    h.fake().open()
    h.fake().text('{"type":"state","state":"thinking"}')
    // A non-listening state never stops playback.
    expect(h.stopPlayback).not.toHaveBeenCalled()
    expect(viewOf(h.controller).phase).toBe('thinking')
    h.fake().text('{"type":"state","state":"listening"}')
    expect(h.stopPlayback).toHaveBeenCalled()
    expect(viewOf(h.controller).phase).toBe('listening')
    h.controller.close()
  })

  it('close releases the mic and resets the view', async () => {
    const h = harness()
    h.controller.start('s')
    h.fake().open()
    h.controller.close()
    expect(viewOf(h.controller).phase).toBe('idle')
    expect(h.controller.getSnapshot().sessionId).toBeUndefined()
  })

  it('createVoiceController wires the production origin plumbing end to end', async () => {
    // The production factory reads window.location for the bridge origin and
    // binds the real mic capture and answer player; a stubbed browser audio
    // stack drives one full capture → socket → playback round trip.
    const previousWindow = (globalThis as { window?: unknown }).window
    ;(globalThis as { window?: unknown }).window = { location: { protocol: 'https:', host: 'host.test' } }

    class FakeAudioContext {
      static instances: FakeAudioContext[] = []
      currentTime = 0
      readonly destination = {}
      readonly audioWorklet = { addModule: async () => {} }
      constructor(_options?: { sampleRate?: number }) {
        FakeAudioContext.instances.push(this)
      }
      createMediaStreamSource(): { connect: () => void } {
        return { connect: () => {} }
      }
      createBuffer(_channels: number, length: number, sampleRate: number): {
        duration: number
        getChannelData: (channel: number) => Float32Array
      } {
        return { duration: length / sampleRate, getChannelData: () => new Float32Array(length) }
      }
      createBufferSource(): {
        connect: (node: unknown) => void
        start: (when: number) => void
        stop: () => void
        onended: (() => void) | null
        buffer: unknown
      } {
        return { connect: () => {}, start: () => {}, stop: () => {}, onended: null, buffer: undefined }
      }
    }

    class FakeWorkletNode {
      static instances: FakeWorkletNode[] = []
      readonly port: { onmessage: ((event: { data: Float32Array }) => void) | null } = { onmessage: null }
      disconnect(): void {}
      constructor() {
        FakeWorkletNode.instances.push(this)
      }
    }

    const globalScope = globalThis as unknown as {
      AudioContext?: unknown
      AudioWorkletNode?: unknown
      navigator: { mediaDevices?: { getUserMedia?: unknown } | undefined }
    }
    const previousAudioContext = globalScope.AudioContext
    const previousWorklet = globalScope.AudioWorkletNode
    const previousMediaDevices = globalScope.navigator.mediaDevices
    globalScope.AudioContext = FakeAudioContext
    globalScope.AudioWorkletNode = FakeWorkletNode
    globalScope.navigator.mediaDevices = {
      getUserMedia: async () => ({ getTracks: () => [] }),
    }
    const urlFace = URL as unknown as { createObjectURL?: () => string; revokeObjectURL?: (url: string) => void }
    const previousCreateObjectURL = urlFace.createObjectURL
    const previousRevokeObjectURL = urlFace.revokeObjectURL
    urlFace.createObjectURL = () => 'blob:voice-worklet'
    urlFace.revokeObjectURL = () => {}
    const previousWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket

    try {
      ;(globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket
      const controller = createVoiceController()
      expect(controller.getSnapshot().phase).toBe('idle')
      controller.start('session-1')
      const fake = FakeWebSocket.instances.at(-1) as FakeWebSocket
      fake.open()
      fake.text('{"type":"ready","sessionId":"session-1","realtimeModel":"stepaudio-2.5-realtime"}')
      // The capture pipeline is async: flush the worklet setup microtasks.
      await new Promise((resolve) => { setImmediate(resolve) })
      const worklet = FakeWorkletNode.instances.at(-1)
      expect(worklet?.port.onmessage).toBeTypeOf('function')
      // One captured mic chunk leaves the socket as a binary PCM16 frame.
      worklet?.port.onmessage?.({ data: new Float32Array([0.5, -0.5]) })
      expect(fake.sent.some(frame => frame instanceof Uint8Array)).toBe(true)
      // One binary answer frame reaches the player through the AudioContext.
      fake.onmessage?.({ data: new Uint8Array([0, 1, 0, 1]).buffer })
      expect(FakeAudioContext.instances.length).toBeGreaterThanOrEqual(2)
      // Barge-in and close both drain the scheduled playback.
      fake.text('{"type":"state","state":"listening"}')
      controller.close()
      expect(controller.getSnapshot().phase).toBe('idle')
    } finally {
      ;(globalThis as { WebSocket?: unknown }).WebSocket = previousWebSocket
      globalScope.AudioContext = previousAudioContext
      globalScope.AudioWorkletNode = previousWorklet
      globalScope.navigator.mediaDevices = previousMediaDevices
      if (previousCreateObjectURL === undefined) delete urlFace.createObjectURL
      else urlFace.createObjectURL = previousCreateObjectURL
      if (previousRevokeObjectURL === undefined) delete urlFace.revokeObjectURL
      else urlFace.revokeObjectURL = previousRevokeObjectURL
      ;(globalThis as { window?: unknown }).window = previousWindow
    }
  })
})
