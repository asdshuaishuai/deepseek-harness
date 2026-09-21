/* v8 ignore file — browser device plumbing (getUserMedia/AudioWorklet) is
   untestable in the Node/jsdom CI environment; the pure conversions it feeds
   are covered in voice-codec.spec.ts. */

/**
 * Browser audio plumbing for the voice loop: microphone capture through an
 * inline AudioWorklet (downsampled to 16 kHz PCM16 chunks) and answer
 * playback by scheduling 24 kHz PCM16 frames on the audio clock.
 *
 * @module @deepseek-ai/dsh-client-ui-voice/voice-audio
 */

/** Capture worklet source: decimate to 16 kHz and post 100 ms float chunks. */
const CAPTURE_WORKLET_SOURCE = `
class SfhVoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.pos = 0
    this.filled = 0
    this.chunk = new Float32Array(1600)
  }
  process(inputs) {
    const channel = inputs[0]?.[0]
    if (channel) {
      const ratio = sampleRate / 16000
      for (let i = 0; i < channel.length; i += 1) {
        this.pos += 1
        if (this.pos >= ratio) {
          this.pos -= ratio
          this.chunk[this.filled++] = channel[i]
          if (this.filled === this.chunk.length) {
            this.port.postMessage(this.chunk.slice(0))
            this.filled = 0
          }
        }
      }
    }
    return true
  }
}
registerProcessor('sfh-voice-capture', SfhVoiceCapture)
`

/** Streams 16 kHz float32 chunks from the live microphone. */
export class MicCapture {
  private stream: MediaStream | undefined
  private context: AudioContext | undefined
  private node: AudioWorkletNode | undefined

  /**
   * Open the microphone and start emitting ~100 ms float32 chunks at 16 kHz.
   * @param onChunk - one downsampled chunk per capture window.
   * @param signal - stops capture when aborted.
   */
  async start(onChunk: (chunk: Float32Array) => void, signal?: AbortSignal): Promise<void> {
    const abortSignal = signal
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    })
    const context = new AudioContext()
    this.context = context
    const workletUrl = URL.createObjectURL(new Blob([CAPTURE_WORKLET_SOURCE], { type: 'application/javascript' }))
    await context.audioWorklet.addModule(workletUrl)
    URL.revokeObjectURL(workletUrl)
    const node = new AudioWorkletNode(context, 'sfh-voice-capture')
    this.node = node
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (abortSignal !== undefined && !abortSignal.aborted) onChunk(event.data)
    }
    const source = context.createMediaStreamSource(this.stream)
    source.connect(node)
    // The worklet consumes frames on the render thread; no output connection
    // is needed (connecting to destination would feed back the microphone).
    if (signal !== undefined && signal.aborted) this.stop()
  }

  /** Release the microphone and audio context. */
  stop(): void {
    this.stream?.getTracks().forEach((track) =>{  track.stop() })
    this.stream = undefined
    this.node?.disconnect()
    this.node = undefined
    void this.context?.close().catch(() => {})
    this.context = undefined
  }
}

/** Schedules 24 kHz PCM16 answer frames on the audio clock, in order. */
export class AnswerPlayer {
  private context: AudioContext | undefined
  private nextTime = 0
  private readonly sources = new Set<AudioBufferSourceNode>()

  /** Lazily create the playback context at the answer sample rate. */
  private ensureContext(): AudioContext {
    this.context ??= new AudioContext({ sampleRate: 24_000 })
    return this.context
  }

  /** Schedule one base64 PCM16 frame; frames play back-to-back in order. */
  play(base64: string): void {
    const context = this.ensureContext()
    const bytes = atob(base64)
    const pcm = new Int16Array(Math.floor(bytes.length / 2))
    for (let i = 0; i < pcm.length; i += 1) {
      pcm[i] = (bytes.charCodeAt(i * 2 + 1) << 8) | bytes.charCodeAt(i * 2)
    }
    if (pcm.length === 0) return
    const buffer = context.createBuffer(1, pcm.length, 24_000)
    const channel = buffer.getChannelData(0)
    for (let i = 0; i < pcm.length; i += 1) channel[i] = (pcm[i] ?? 0) / 0x7fff
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    const now = context.currentTime
    if (this.nextTime < now) this.nextTime = now
    source.start(this.nextTime)
    this.nextTime += buffer.duration
    source.onended = () => { this.sources.delete(source) }
    this.sources.add(source)
  }

  /** Stop every scheduled and playing frame (barge-in). */
  stopAll(): void {
    for (const source of [...this.sources]) {
      try {
        source.stop()
      } catch {
        // A source that already ended has nothing to stop.
      }
      this.sources.delete(source)
    }
    this.nextTime = 0
  }
}
