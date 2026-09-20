/**
 * The bundle's substance is its patch file: the voice profile's channel
 * wiring — `--step-plan` must flip both the realtime row and the llm-stepfun
 * overlay in the same direction.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { evaluate } from '@deepseek-ai/cordis-plugin-loader'

type Row = {
  id?: string
  insert?: Row[]
  inject?: string[]
  config?: Record<string, unknown>
}

function patchRows(): Row[] {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const parsed = yaml.load(readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'), {
    schema: entryListSchema,
  })
  if (!Array.isArray(parsed)) throw new TypeError('voice bundle patch must parse to a patch list')
  return parsed as Row[]
}

/** Every row the patch names, flattened over its insert blocks. */
function allRows(rows: Row[]): Row[] {
  return rows.flatMap(row => [row, ...allRows(row.insert ?? [])])
}

function jsExpr(value: unknown): string {
  const expression = (value as { __jsExpr?: string } | undefined)?.__jsExpr
  if (expression === undefined) throw new TypeError('expected a !!js expression')
  return expression
}

describe('dsh-voice-app bundle', () => {
  it('wires --step-plan to both the realtime row and the llm-stepfun overlay', () => {
    const rows = allRows(patchRows())
    const realtime = rows.find(row => row.id === 'stepfun-realtime')
    if (realtime === undefined) throw new Error('voice patch must mount stepfun-realtime')
    expect(realtime.inject).toContain('voiceStartup')

    const planOn = { ctx: { voiceStartup: { stepPlan: true } } }
    const planOff = { ctx: { voiceStartup: { stepPlan: false } } }
    expect(evaluate(planOn, jsExpr(realtime.config?.['channel']))).toBe('step-plan')
    expect(evaluate(planOff, jsExpr(realtime.config?.['channel']))).toBe('standard')

    const llm = patchRows().find(row => row.id === 'llm-stepfun')
    if (llm === undefined) throw new Error('voice patch must overlay the llm-stepfun row')
    expect(llm.inject).toContain('voiceStartup')
    expect(evaluate(planOn, jsExpr(llm.config?.['channel']))).toBe('step-plan')
    expect(evaluate(planOff, jsExpr(llm.config?.['channel']))).toBe('standard')
  })

  it('passes --realtime-model through as an explicit override', () => {
    const realtime = allRows(patchRows()).find(row => row.id === 'stepfun-realtime')
    if (realtime === undefined) throw new Error('voice patch must mount stepfun-realtime')
    const scope = { ctx: { voiceStartup: { realtimeModel: 'stepaudio-2.5-realtime' } } }
    expect(evaluate(scope, jsExpr(realtime.config?.['model']))).toBe('stepaudio-2.5-realtime')
    expect(evaluate({ ctx: { voiceStartup: {} } }, jsExpr(realtime.config?.['model']))).toBeUndefined()
  })
})
