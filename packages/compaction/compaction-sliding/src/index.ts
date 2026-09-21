/**
 * Sliding-window compaction: a `BasicCompactionEngine` preset where a
 * background compactor model condenses history on its own — the conversation's
 * main model never participates. Pressure triggers at 70% of the routed
 * model's context window by default, and the compactor defaults to
 * `step-3.7-flash` on the StepFun Step Plan channel. When the compactor
 * cannot serve (wrong channel, unknown model, provider refusal), the
 * summarization falls back to the conversation's main model for that pass and
 * the compactor is disabled for the process lifetime. The post-compaction
 * surface is the sliding window itself: one checkpoint user message
 * condensing the older range, followed by the most recent conversation tail
 * retained verbatim.
 *
 * @module @deepseek-ai/dsh-compaction-sliding
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LlmError } from '@deepseek-ai/dsh-llm'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import { resolveTargetPolicy } from '@deepseek-ai/dsh-compaction-basic/config'
import { summarizeWithLlm } from '@deepseek-ai/dsh-compaction-basic/summarizer'
import type { SummarizationInput, SummaryResult } from '@deepseek-ai/dsh-compaction-basic/summarizer'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** Default threshold of the routed model's context window (the "70%" trigger). */
export const DEFAULT_SLIDING_THRESHOLD_RATIO = 0.7

/** Default background compactor: the Step Plan channel's flash reasoning model. */
export const DEFAULT_COMPACTOR_PROVIDER = 'stepfun-official'
export const DEFAULT_COMPACTOR_MODEL = 'step-3.7-flash'

/** The basic backend's config, plus the fields this preset owns. */
export interface SlidingCompactionConfig extends BasicCompactionConfig {
  /** Provider route of the background compactor. Defaults to `stepfun-official`. */
  compactorProvider?: string
  /** Background compactor model. Defaults to `step-3.7-flash` (Step Plan channel). */
  compactorModel?: string
  /**
   * Fall back to the conversation's main model when the compactor cannot
   * serve. Defaults to true; `false` surfaces the compactor error instead.
   */
  compactorFallbackToMain?: boolean
}

/** Resolved sliding preset. */
export interface ResolvedSlidingConfig {
  /** The compactor target the preset drives in the background. */
  readonly compactor: { readonly provider: string; readonly model: string }
  /** Whether a failed compactor falls back to the conversation's main model. */
  readonly fallbackToMain: boolean
  /** The underlying basic backend configuration this preset forwards. */
  readonly basic: SlidingCompactionConfig
}

/**
 * The routed main model a conversation currently talks to, when known.
 * Header-only: compaction never runs before a routed request exists, and the
 * summarize fallback's agent-options arm is the basic engine's own logic.
 */
export function routedTarget(agent: Agent): { provider: string; model: string } | undefined {
  const routed = agent.session.requestHeader()?.config
  if (routed !== undefined && routed.provider.length > 0 && routed.model.length > 0) {
    return { provider: routed.provider, model: routed.model }
  }
  return undefined
}

/** Validate the preset's own fields into their resolved form. */
function resolveSlidingConfig(config: SlidingCompactionConfig): ResolvedSlidingConfig {
  const compactorProvider = config.compactorProvider ?? DEFAULT_COMPACTOR_PROVIDER
  const compactorModel = config.compactorModel ?? DEFAULT_COMPACTOR_MODEL
  if (compactorProvider.length === 0 || compactorModel.length === 0) {
    throw new Error('compaction-sliding: compactorProvider and compactorModel must be non-empty')
  }
  return {
    compactor: { provider: compactorProvider, model: compactorModel },
    fallbackToMain: config.compactorFallbackToMain ?? true,
    basic: config,
  }
}

/**
 * The sliding-window engine. Everything except the summarizer target is the
 * basic backend's fixed replay strategy: pressure is measured by the shared
 * token meter against 70% of the routed model's window, the retained tail
 * keeps the most recent conversation verbatim, and the checkpoint replacement
 * carries the condensed older range into every following request.
 */
export class SlidingCompactionEngine extends BasicCompactionEngine {
  static override Config: z<SlidingCompactionConfig> = z.object({
    thresholdRatio: z.number(),
    retainRatio: z.number(),
    retainTokens: z.number().step(1).min(0),
    summarizationProvider: z.string(),
    summarizationModel: z.string(),
    maxTokens: z.number().step(1).min(1),
    compactionRetries: z.number().step(1).min(0),
    maxOverflowRetries: z.number().step(1).min(0),
    modelPolicies: z.array(z.object({
      provider: z.string().required(),
      model: z.string().required(),
      thresholdRatio: z.number(),
      retainRatio: z.number(),
      retainTokens: z.number().step(1).min(0),
      summarizationProvider: z.string(),
      summarizationModel: z.string(),
      maxTokens: z.number().step(1).min(1),
      compactionRetries: z.number().step(1).min(0),
      maxOverflowRetries: z.number().step(1).min(0),
    })),
    auto: z.boolean(),
    compactorProvider: z.string(),
    compactorModel: z.string(),
    compactorFallbackToMain: z.boolean(),
  })

  /** The resolved sliding preset. */
  readonly sliding: ResolvedSlidingConfig

  /** Compactor routes that failed once and are disabled for this process. */
  private readonly disabledCompactors = new Set<string>()

  constructor(ctx: Context, config: SlidingCompactionConfig = {}) {
    // Validate before super: a bad compactor config must not half-register
    // the compaction service. The sliding window's defining fact is the 70%
    // threshold — not the basic backend's 80% low-friction default.
    const sliding = resolveSlidingConfig(config)
    const { compactorProvider: _provider, compactorModel: _model, compactorFallbackToMain: _fallback, ...basic } = config
    super(ctx, { ...basic, thresholdRatio: basic.thresholdRatio ?? DEFAULT_SLIDING_THRESHOLD_RATIO })
    this.sliding = sliding
  }

  /**
   * Summarize through the background compactor first; on failure fall back to
   * the routed main model for this pass and disable the compactor for the
   * process lifetime ("no 3.7-flash available" is durable, not transient).
   * Abort never falls back — cancellation wins.
   */
  protected override async summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    // An explicitly configured summarizer (config or the routed model's own
    // policy) outranks the preset: the owner chose the model deliberately.
    const routed = routedTarget(agent)
    const policy = routed === undefined ? undefined : resolveTargetPolicy(this.config, routed)
    if (policy !== undefined && policy.summarizationModel.length > 0) {
      return super.summarize(input, agent, signal)
    }

    const { compactor, fallbackToMain } = this.sliding
    const compactorKey = `${compactor.provider}/${compactor.model}`
    const compactorIsMain = routed !== undefined
      && routed.provider === compactor.provider && routed.model === compactor.model
    if (compactorIsMain || this.disabledCompactors.has(compactorKey)) {
      return super.summarize(input, agent, signal)
    }

    try {
      const result = await summarizeWithLlm(
        this.ctx,
        {
          summarizationProvider: compactor.provider,
          summarizationModel: compactor.model,
          maxTokens: this.config.maxTokens,
        },
        input,
        agent,
        signal,
      )
      this.ctx.logger.info(
        `compaction-sliding: background compactor ${compactorKey} wrote the checkpoint`,
      )
      return result
    } catch (error: unknown) {
      console.log('SLIDING-DEBUG caught:', error instanceof LlmError, (error as { code?: string }).code, (error as Error).message)
      if (signal?.aborted === true
        || (error instanceof LlmError && error.code === 'ABORTED')) {
        throw new LlmError(`compaction-sliding: aborted compaction (${String(error)})`, 'ABORTED', { cause: error })
      }
      if (!fallbackToMain) throw error
      this.disabledCompactors.add(compactorKey)
      const message = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(
        `compaction-sliding: background compactor ${compactorKey} failed (${message});`
        + ' falling back to the conversation main model for this and future passes',
      )
      return super.summarize(input, agent, signal)
    }
  }
}

export default SlidingCompactionEngine
