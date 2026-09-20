import { describe, expect, it } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import {
  PUBLIC_REALTIME_URL,
  REALTIME_MODEL,
  STEP_PLAN_REALTIME_URL,
  resolveRealtimeOptions,
} from '../src/index.ts'

/** A trusted-layer snapshot carrying only what each test supplies. */
function environment(values: Record<string, string> = {}): LaunchEnvironmentSnapshot {
  return {
    get: name => name in values ? { value: values[name] ?? '', source: 'process' } : undefined,
    getFrom: () => undefined,
  }
}

describe('resolveRealtimeOptions', () => {
  it('defaults to the standard endpoint and the preview realtime model', () => {
    const resolved = resolveRealtimeOptions({})
    expect(resolved.baseURL).toBe(PUBLIC_REALTIME_URL)
    expect(resolved.model).toBe(REALTIME_MODEL)
    expect(resolved.model).toBe('stepaudio-3-realtime-preview')
    expect(resolved.apiKeyEnv).toBe(credentialRef('STEPFUN_API_KEY'))
    expect(resolved.connectTimeoutMs).toBe(10_000)
  })

  it('switches the endpoint and default model to the Step Plan channel', () => {
    const resolved = resolveRealtimeOptions({ channel: 'step-plan' })
    expect(resolved.baseURL).toBe(STEP_PLAN_REALTIME_URL)
    // The plan does not list StepAudio 3 Realtime yet, so the plan channel
    // defaults to the subscription's StepAudio 2.5 Realtime.
    expect(resolved.model).toBe('stepaudio-2.5-realtime')
  })

  it('rejects an unknown channel and an empty model', () => {
    expect(() => resolveRealtimeOptions({ channel: 'franchise' as 'standard' })).toThrow(/channel must be one of/)
    expect(() => resolveRealtimeOptions({ model: '' })).toThrow(/model must be a non-empty/)
  })

  it('lets an explicit endpoint and model override the channel defaults', () => {
    const resolved = resolveRealtimeOptions({
      channel: 'step-plan',
      baseURL: 'wss://gateway.example.com/realtime',
      model: 'stepaudio-2.5-realtime',
    })
    expect(resolved.baseURL).toBe('wss://gateway.example.com/realtime')
    expect(resolved.model).toBe('stepaudio-2.5-realtime')
  })

  it('rejects non-WS schemes and private hosts', () => {
    expect(() => resolveRealtimeOptions({ baseURL: 'https://api.stepfun.com/realtime' })).toThrow()
    expect(() => resolveRealtimeOptions({ baseURL: 'ws://127.0.0.1:8765' })).toThrow(/loopback, private, or reserved/)
  })

  it('honors environment overrides from a trusted layer', () => {
    const resolved = resolveRealtimeOptions({}, environment({ STEPFUN_REALTIME_MODEL: 'stepaudio-2.5-realtime' }))
    expect(resolved.model).toBe('stepaudio-2.5-realtime')
    expect(resolved.baseURL).toBe(PUBLIC_REALTIME_URL)
  })
})
