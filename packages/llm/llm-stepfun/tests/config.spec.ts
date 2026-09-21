import { describe, expect, it } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { resolveAdapterOptions, PUBLIC_BASE_URL, STEP_PLAN_BASE_URL } from '../src/config.ts'
import { DEFAULT_MODELS, STEP_PLAN_MODELS } from '../src/common/models.ts'

describe('resolveAdapterOptions', () => {
  it('defaults to the public endpoint, catalog, and bounds', () => {
    const resolved = resolveAdapterOptions({})
    expect(resolved.channel).toBe('standard')
    expect(resolved.baseURL).toBe(PUBLIC_BASE_URL)
    expect(resolved.apiKeyEnv).toBe(credentialRef('STEPFUN_API_KEY'))
    expect(resolved.models.map(model => model.id)).toEqual(['step-5-preview', 'step-3'])
    expect(resolved.maxTokens).toBe(65_536)
    expect(resolved.defaultContextWindow).toBe(1_000_000)
  })

  it('resolves the Step Plan channel endpoint and catalog', () => {
    const resolved = resolveAdapterOptions({ channel: 'step-plan' })
    expect(resolved.channel).toBe('step-plan')
    expect(resolved.baseURL).toBe(STEP_PLAN_BASE_URL)
    expect(resolved.models.map(model => model.id)).toEqual([
      'step-5-preview',
      'step-3.7-flash',
      'step-3.5-flash',
      'step-3.5-flash-2603',
      'step-router-v1',
    ])
  })

  it('rejects an unknown channel', () => {
    expect(() => resolveAdapterOptions({ channel: 'franchise' as 'standard' })).toThrow(/channel must be one of/)
  })

  it('lets an explicit endpoint and catalog override the channel defaults', () => {
    const resolved = resolveAdapterOptions({
      channel: 'step-plan',
      baseURL: 'https://gateway.example.com/step_plan/v1',
      models: [{ id: 'step-3.5-flash' }],
    })
    expect(resolved.baseURL).toBe('https://gateway.example.com/step_plan/v1')
    expect(resolved.models.map(model => model.id)).toEqual(['step-3.5-flash'])
  })

  it('honors a public custom endpoint and credential reference', () => {
    const resolved = resolveAdapterOptions({
      baseURL: 'https://gateway.example.com/v1',
      apiKeyEnv: 'MY_STEP_KEY',
    })
    expect(resolved.baseURL).toBe('https://gateway.example.com/v1')
    expect(resolved.apiKeyEnv).toBe(credentialRef('MY_STEP_KEY'))
  })

  it('rejects localhost, private, and reserved endpoints', () => {
    expect(() => resolveAdapterOptions({ baseURL: 'http://localhost:3000' }))
      .toThrow(/llm-stepfun: baseURL/)
    expect(() => resolveAdapterOptions({ baseURL: 'http://127.0.0.1:3000' }))
      .toThrow(/loopback, private, or reserved/)
    expect(() => resolveAdapterOptions({ baseURL: 'https://10.0.0.5/' }))
      .toThrow(/loopback, private, or reserved/)
  })

  it('rejects non-HTTP schemes, credentials, queries, and fragments', () => {
    expect(() => resolveAdapterOptions({ baseURL: 'wss://api.stepfun.com' })).toThrow()
    expect(() => resolveAdapterOptions({ baseURL: 'https://u:p@api.stepfun.com' })).toThrow(/credentials/)
    expect(() => resolveAdapterOptions({ baseURL: 'https://api.stepfun.com/?q=1' })).toThrow(/query or fragment/)
  })

  it('validates numeric bounds beyond the schema', () => {
    expect(() => resolveAdapterOptions({ maxTokens: 0 })).toThrow(/maxTokens/)
    expect(() => resolveAdapterOptions({ defaultContextWindow: -1 })).toThrow(/defaultContextWindow/)
    expect(() => resolveAdapterOptions({ streamIdleTimeoutMs: 0 })).toThrow(/streamIdleTimeoutMs/)
    expect(() => resolveAdapterOptions({
      imageOffloadByteQuantum: 100,
      maxRequestImageBytes: 10,
    })).toThrow(/must not exceed/)
  })

  it('validates the catalog: duplicates, empty ids, text-only image limits', () => {
    expect(() => resolveAdapterOptions({
      models: [{ id: 'a' }, { id: 'a' }],
    })).toThrow(/duplicate catalog model/)
    expect(() => resolveAdapterOptions({
      models: [{ id: '' }],
    })).toThrow(/non-empty/)
    expect(() => resolveAdapterOptions({
      models: [{ id: 'text-only', imageMaxBytes: 5 }],
    })).toThrow(/cannot declare image request limits/)
  })

  it('validates cataloged reasoning efforts: empty ids and duplicates reject', () => {
    expect(() => resolveAdapterOptions({
      models: [{ id: 'm', reasoningEfforts: ['low', ''] }],
    })).toThrow(/must not contain empty ids/)
    expect(() => resolveAdapterOptions({
      models: [{ id: 'm', reasoningEfforts: ['low', 'low'] }],
    })).toThrow(/must not contain duplicates/)
    // Schemastery normalizes an absent array to []; resolution reads that as
    // "no selectable efforts", not a catalog error.
    const resolved = resolveAdapterOptions({ models: [{ id: 'm', reasoningEfforts: [] }] })
    expect(resolved.models[0]?.reasoningEfforts).toBeUndefined()
  })

  it('keeps the documented efforts: flagship and 3.7 low/medium/high, 2603 low/high', () => {
    const byId = new Map(STEP_PLAN_MODELS.map(model => [model.id, model]))
    expect(byId.get('step-5-preview')?.reasoningEfforts).toEqual(['low', 'medium', 'high'])
    expect(byId.get('step-3.7-flash')?.reasoningEfforts).toEqual(['low', 'medium', 'high'])
    expect(byId.get('step-3.5-flash-2603')?.reasoningEfforts).toEqual(['low', 'high'])
    expect(byId.get('step-3.5-flash')?.reasoningEfforts).toBeUndefined()
    expect(byId.get('step-router-v1')?.reasoningEfforts).toBeUndefined()
  })

  it('fills image-capable entries with the per-image byte default', () => {
    const resolved = resolveAdapterOptions({
      models: [{ id: 'step-5-preview', inputModalities: ['text', 'image'] }],
    })
    expect(resolved.models[0]).toMatchObject({ id: 'step-5-preview', imageMaxBytes: 10 * 1024 * 1024 })
  })

  it('keeps the shipped catalog present, image-capable, and effort-selectable for the flagship', () => {
    const flagship = DEFAULT_MODELS.find(model => model.id === 'step-5-preview')
    expect(flagship).toMatchObject({
      contextWindow: 1_000_000,
      inputModalities: ['text', 'image'],
      reasoningEfforts: ['low', 'medium', 'high'],
    })
  })
})
