/** Pure audio conversion coverage: resampling, PCM16 clamping, base64 transport. */
import { describe, expect, it } from 'vitest'
import {
  answerBase64ToFloat, base64ToPcm16Bytes, captureChunkToBase64,
  downsampleTo16k, floatToPcm16Bytes, pcm16BytesToBase64, pcm16BytesToFloat,
} from '../src/client/voice-codec.ts'

describe('downsampleTo16k', () => {
  it('passes 16 kHz input through unchanged', () => {
    const input = new Float32Array([0.1, 0.2, 0.3])
    expect(downsampleTo16k(input, 16_000)).toBe(input)
  })

  it('halves the length for a 2:1 ratio picking the retained sample', () => {
    // Integer ratios degenerate to decimation: positions land exactly on
    // source samples, so the retained sample is the picked one.
    const out = downsampleTo16k(new Float32Array([0, 0.5, 1, 0.5]), 32_000)
    expect(out.length).toBe(2)
    expect(out[0]).toBe(0)
    expect(out[1]).toBe(1)
  })

  it('interpolates between samples for non-integer ratios', () => {
    const out = downsampleTo16k(new Float32Array([0, 1, 0]), 24_000)
    // 24000/16000 = 1.5: position 0 → sample 0; position 1.5 → midpoint of samples 1,2.
    expect(out.length).toBe(2)
    expect(out[1]).toBeCloseTo(0.5)
  })

  it('never returns an empty output for non-empty input', () => {
    expect(downsampleTo16k(new Float32Array([0.5]), 48_000).length).toBeGreaterThanOrEqual(1)
  })

  it('stays total for an empty input (indices clamp to -1)', () => {
    const out = downsampleTo16k(new Float32Array([]), 48_000)
    expect(out.length).toBe(1)
    expect(out[0]).toBe(0)
  })
})

describe('PCM16 conversion', () => {
  it('clamps and quantizes float32 to PCM16 bytes and back', () => {
    const round = (v: number): number => pcm16BytesToFloat(floatToPcm16Bytes(new Float32Array([v])))[0] ?? 0
    expect(round(0)).toBe(0)
    expect(round(1)).toBeCloseTo(1)
    expect(round(-1)).toBeCloseTo(-1)
    expect(round(2)).toBeCloseTo(1)
    expect(round(-2)).toBeCloseTo(-1)
  })

  it('base64 transport round-trips PCM16 bytes', () => {
    const bytes = new Uint8Array([1, 2, 254, 255])
    expect(base64ToPcm16Bytes(pcm16BytesToBase64(bytes))).toEqual(bytes)
  })
})

describe('capture and answer pipeline', () => {
  it('captureChunkToBase64 downsamples 48 kHz to 16 kHz PCM16', () => {
    const chunk = new Float32Array(4_800).fill(0.5)
    const base64 = captureChunkToBase64(chunk, 48_000)
    const bytes = base64ToPcm16Bytes(base64)
    // 48000/48000*1600 window? — chunk is 4800 samples at 48k = 1600 at 16k.
    expect(bytes.length).toBe(1_600 * 2)
  })

  it('answerBase64ToFloat decodes base64 PCM16 to float samples', () => {
    const float = answerBase64ToFloat(pcm16BytesToBase64(floatToPcm16Bytes(new Float32Array([0.25, -0.25]))))
    expect(float[0]).toBeCloseTo(0.25)
    expect(float[1]).toBeCloseTo(-0.25)
  })
})
