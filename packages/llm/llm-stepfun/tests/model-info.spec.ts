import { describe, expect, it } from 'vitest'
import { resolveAdapterOptions } from '../src/config.ts'
import { modelInfo } from '../src/common/model-info.ts'

const PROVIDER = 'stepfun-official'

describe('modelInfo', () => {
  it('advertises cataloged reasoning efforts with selector names', () => {
    const connection = resolveAdapterOptions({
      models: [{ id: 'step-3.7-flash', reasoningEfforts: ['low', 'medium', 'high'] }],
    })
    const info = modelInfo(connection, PROVIDER, 'step-3.7-flash')
    expect(info.reasoning?.efforts.map(effort => String(effort.id))).toEqual(['low', 'medium', 'high'])
    expect(info.reasoning?.efforts.map(effort => effort.name)).toEqual(['Low', 'Medium', 'High'])
    expect(info.reasoning?.defaultEffort).toBeUndefined()
  })

  it('advertises the flagship efforts and keeps uncataloged-effort models automatic', () => {
    const connection = resolveAdapterOptions({})
    expect(modelInfo(connection, PROVIDER, 'step-5-preview').reasoning?.efforts.map(effort => String(effort.id)))
      .toEqual(['low', 'medium', 'high'])
    expect(modelInfo(connection, PROVIDER, 'step-3').reasoning).toBeUndefined()
  })

  it('treats an uncatalogued model as text-only over the default context', () => {
    const connection = resolveAdapterOptions({})
    const info = modelInfo(connection, PROVIDER, 'step-9-preview')
    expect(info).toMatchObject({
      provider: PROVIDER,
      id: 'step-9-preview',
      name: 'step-9-preview',
      inputModalities: ['text'],
    })
    expect(info.context).toMatchObject({ contextWindow: 1_000_000 })
    expect(info.reasoning).toBeUndefined()
  })

  it('uses the cataloged context window and output cap when present', () => {
    const connection = resolveAdapterOptions({
      models: [{ id: 'step-3.5-flash', contextWindow: 262_144, maxTokens: 8_192 }],
    })
    const info = modelInfo(connection, PROVIDER, 'step-3.5-flash')
    expect(info.context).toMatchObject({ contextWindow: 262_144 })
    expect(info.defaultMaxTokens).toBe(8_192)
  })
})
