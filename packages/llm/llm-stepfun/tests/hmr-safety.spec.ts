/**
 * HMR-safety guard for the registry contribution: disposing the fiber that
 * registered the StepFun adapter removes its provider route, so a hot swap
 * (unload + reload) never leaves a stale adapter behind.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { LlmError } from '@deepseek-ai/dsh-llm'
import * as LlmStepFun from '../src/index.ts'

const PROVIDER = 'stepfun-official'

describe('llm-stepfun registry lifecycle', () => {
  it('unregisters the provider route when the contributing fiber disposes', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const fiber = await ctx.plugin(LlmStepFun)

    expect(ctx.llm.listProviders().some(entry => entry.id === PROVIDER)).toBe(true)
    await expect(ctx.llm.listModels(PROVIDER)).resolves.toHaveLength(2)

    await fiber.dispose()
    expect(ctx.llm.listProviders().some(entry => entry.id === PROVIDER)).toBe(false)
    const failure = await ctx.llm.listModels(PROVIDER).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(LlmError)
    expect((failure as LlmError).code).toBe('NO_ADAPTER')
    await ctx.fiber.dispose()
  })

  it('rejects a duplicate mount before anything registers', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmStepFun)
    const second = await ctx.plugin(LlmStepFun).then(() => undefined, (error: unknown) => error)
    // A second registration of the same route fails the later fiber; the
    // earlier mount keeps serving requests.
    expect(second).toBeInstanceOf(Error)
    expect(ctx.llm.listProviders().some(entry => entry.id === PROVIDER)).toBe(true)
    await ctx.fiber.dispose()
  })
})
