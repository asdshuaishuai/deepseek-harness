/**
 * Pure audio conversions for the browser voice loop: float32 ↔ PCM16 and the
 * base64 transport encoding, plus the 48 kHz → 16 kHz capture resampler.
 * No browser APIs — everything here is unit-testable in Node.
 *
 * @module @deepseek-ai/dsh-client-ui-voice/voice-codec
 */

/** Downsample float32 samples from `sourceRate` to 16 kHz by linear interpolation. */
export function downsampleTo16k(input: Float32Array, sourceRate: number): Float32Array {
  const targetRate = 16_000
  if (sourceRate === targetRate) return input
  const ratio = sourceRate / targetRate
  const outLength = Math.max(1, Math.floor(input.length / ratio))
  const out = new Float32Array(outLength)
  let outIndex = 0
  for (let i = 0; i < outLength; i += 1) {
    const position = i * ratio
    const left = Math.min(Math.floor(position), input.length - 1)
    const right = Math.min(left + 1, input.length - 1)
    const weight = position - left
    // An empty input clamps both indices to -1; the falls back keep the
    // interpolator total instead of reading out of bounds.
    const leftValue = input[left] ?? 0
    const rightValue = input[right] ?? leftValue
    out[outIndex] = leftValue * (1 - weight) + rightValue * weight
    outIndex += 1
  }
  return out
}

/** Convert float32 samples (−1..1) to little-endian PCM16 bytes. */
export function floatToPcm16Bytes(input: Float32Array): Uint8Array {
  const pcm = new Int16Array(input.length)
  let pcmIndex = 0
  for (const sample of input) {
    const clamped = Math.max(-1, Math.min(1, sample))
    pcm[pcmIndex] = Math.round(clamped * 0x7fff)
    pcmIndex += 1
  }
  return new Uint8Array(pcm.buffer)
}

/** Convert little-endian PCM16 bytes to float32 samples (−1..1). */
export function pcm16BytesToFloat(bytes: Uint8Array): Float32Array {
  const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2))
  const out = new Float32Array(pcm.length)
  let outIndex = 0
  for (const sample of pcm) {
    out[outIndex] = sample / 0x7fff
    outIndex += 1
  }
  return out
}

/** Encode PCM16 bytes as base64 for the bridge transport. */
export function pcm16BytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Decode bridge audio base64 back to PCM16 bytes. */
export function base64ToPcm16Bytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Float32 microphone chunk → base64 PCM16 at 16 kHz, ready for the bridge socket. */
export function captureChunkToBase64(input: Float32Array, sourceRate: number): string {
  return pcm16BytesToBase64(floatToPcm16Bytes(downsampleTo16k(input, sourceRate)))
}

/** Bridge answer audio (base64 PCM16 at 24 kHz) → float32 samples for playback. */
export function answerBase64ToFloat(base64: string): Float32Array {
  return pcm16BytesToFloat(base64ToPcm16Bytes(base64))
}
