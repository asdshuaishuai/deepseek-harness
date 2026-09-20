/** Model capability projection from the catalog and connection facts. */
import { ReasoningEffortId, type LlmModelInfo, type LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type { StepFunCatalogModel, StepFunConnectionOptions } from './types.ts'

/** Selector label for one raw effort id: `low` shows as `Low`. */
function effortName(effort: string): string {
  return effort.charAt(0).toUpperCase() + effort.slice(1)
}

/**
 * Advertise one catalog entry.
 * @param provider - registered provider id.
 * @param model - advisory catalog entry.
 * @returns selector metadata.
 */
export function catalogModelInfo(provider: string, model: StepFunCatalogModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...model.description === undefined ? {} : { description: model.description },
    inputModalities: model.inputModalities ?? ['text'],
  }
}

/**
 * Resolve model capabilities against one configuration generation. Thinking is
 * automatic on the Step 5 family, so models without cataloged efforts
 * advertise none: the provider default always applies. Flash models that
 * accept `reasoning_effort` (Step 3.7 Flash, Step 3.5 Flash 2603) expose their
 * ids; the first cataloged id is not a default — the platform's own default
 * applies when the caller omits one.
 * @param connection - validated connection facts.
 * @param provider - registered provider id.
 * @param model - requested wire model id.
 * @returns effective model metadata for this operation.
 */
export function modelInfo(
  connection: StepFunConnectionOptions,
  provider: string,
  model: string,
): LlmResolvedModelInfo {
  const configured = connection.models.find(entry => entry.id === model)
  const contextWindow = configured?.contextWindow ?? connection.defaultContextWindow
  return {
    // An uncatalogued endpoint is safely treated as text-only: declaring an
    // unverified image capability would let the host persist input that the
    // endpoint may reject on every later turn.
    ...configured === undefined
      ? { provider, id: model, name: model, inputModalities: ['text' as const] }
      : catalogModelInfo(provider, configured),
    context: { contextWindow },
    defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
    ...configured?.reasoningEfforts === undefined ? {} : {
      reasoning: {
        efforts: configured.reasoningEfforts.map(effort => ({
          id: ReasoningEffortId(effort),
          name: effortName(effort),
        })),
      },
    },
  }
}
