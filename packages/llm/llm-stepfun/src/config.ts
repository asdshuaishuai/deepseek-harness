/** Plugin configuration and complete request-local resolution for StepFun. */
import z from '@deepseek-ai/schemastery'
import { resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { assertPublicHttpUrl } from '@deepseek-ai/dsh-url-guard'
import type { StepFunCatalogModel, StepFunChannel, StepFunConnectionOptions } from './common/types.ts'
import { DEFAULT_MODELS, STEP_PLAN_MODELS } from './common/models.ts'
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM,
  DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM,
  DEFAULT_MAX_IMAGES_PER_REQUEST,
  DEFAULT_MAX_REQUEST_IMAGE_BYTES,
  DEFAULT_MAX_TOKENS,
  DEFAULT_REQUEST_IMAGE_MAX_BYTES,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  STEP_PLAN_BASE_URL,
} from './common/defaults.ts'

const DEFAULT_API_KEY_ENV = 'STEPFUN_API_KEY'

const MODEL_MODALITIES = ['text', 'image'] as const

/** Provider route id for the open-platform endpoint (the shipped default). */
export const DEFAULT_PROVIDER = 'stepfun-official'

/** Provider route id for the Step Plan subscription endpoint. */
export const PLAN_PROVIDER = 'stepfun-plan'

/** Settings namespace for the open-platform route. */
export const DEFAULT_SETTINGS_NS = 'llm-stepfun'

/** Settings namespace for the Step Plan route. */
export const PLAN_SETTINGS_NS = 'llm-stepfun-plan'

/** Route identity: a non-empty provider id plus the settings section it owns. */
const PROVIDER_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/**
 * Resolve the route identity one instance registers: the provider id, the
 * settings namespace it owns, and the Models-page label.
 * @param config - raw plugin config or resolved settings snapshot.
 * @returns validated identity facts.
 * @throws when an explicit provider id or namespace breaks its shape.
 */
export function resolveRouteIdentity(config: Config): {
  provider: string
  settingsNs: string
  displayName: string
} {
  const provider = config.provider ?? DEFAULT_PROVIDER
  if (!PROVIDER_PATTERN.test(provider)) {
    throw new Error(`llm-stepfun: provider must match ${PROVIDER_PATTERN.toString()} (got "${provider}")`)
  }
  const settingsNs = config.settingsNs ?? DEFAULT_SETTINGS_NS
  if (settingsNs.length === 0) {
    throw new Error('llm-stepfun: settingsNs must be a non-empty namespace')
  }
  return { provider, settingsNs, displayName: config.displayName ?? 'StepFun' }
}

/**
 * Plugin config, validated by the same-named schemastery schema and doubling
 * as the `llm-stepfun` settings-section shape. Every field is optional in
 * yml: a missing API key resolves through {@link Config.apiKeyEnv} at each
 * request (a request without any key fails with `MISSING_CREDENTIAL`, not at
 * plugin load).
 */
export interface Config {
  /**
   * Billing channel selecting the default endpoint and catalog: `standard`
   * (open platform, default) or `step-plan` (Step Plan subscription, which
   * also hosts the StepSearch MCP and the plan realtime endpoint). An explicit
   * {@link Config.baseURL} or {@link Config.models} still wins over the
   * channel default.
   */
  channel?: StepFunChannel
  /**
   * Provider route id this instance registers. The two StepFun endpoints are
   * independent routes — the open platform (`stepfun-official`) and the Step
   * Plan subscription (`stepfun-plan`) each mount their own row, key, and
   * catalog — so a row names its own route.
   */
  provider?: string
  /**
   * Settings namespace this instance owns (the `llm-stepfun` /
   * `llm-stepfun-plan` sections the Models page edits). Each route owns its
   * own section so the two endpoints configure independently.
   */
  settingsNs?: string
  /** Selector label for the Models page and picker; defaults to `StepFun`. */
  displayName?: string
  /** Credential reference (environment-variable name) resolved per request; defaults to `STEPFUN_API_KEY`. */
  apiKeyEnv?: string
  /**
   * Endpoint base; falls back to $STEPFUN_BASE_URL from a trusted environment
   * layer, then the channel's public API. Validated as a public HTTP(S) root:
   * local, loopback, private, and reserved hosts are rejected before any
   * request.
   */
  baseURL?: string
  /** Default per-request output cap (default 65,536); a model's own cap and explicit request values win. */
  maxTokens?: number
  /** Positive context capacity used when the selected model has no exact value (default 1,000,000). */
  defaultContextWindow?: number
  /** Advisory models shown by discovery consumers; defaults to the channel's catalog. */
  models?: StepFunCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
  streamIdleTimeoutMs?: number
  /** Maximum accumulated base64 image payload per chat request (default 20 MiB). */
  maxRequestImageBytes?: number
  /** Maximum number of represented images per chat request (default 60, the platform's documented per-request maximum). */
  maxImagesPerRequest?: number
  /** Base64-byte removal step after the request exceeds its byte bound (default 5 MiB). */
  imageOffloadByteQuantum?: number
  /** Image-count removal step after the request exceeds its count bound (default 10). */
  imageOffloadCountQuantum?: number
  /** Provider-owned model-request retry policy; omission uses normal mode with five retries. */
  retryPolicy?: RetryPolicyConfig
}

const catalogModel: z<StepFunCatalogModel> = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  inputModalities: z.array(z.union(MODEL_MODALITIES)).min(1).default(['text']),
  imageMaxBytes: z.number().step(1).min(1),
  // No min(1): schemastery materializes an absent array as [], so the
  // presence-shape rules live in resolveModels, which also folds [] back to
  // absence.
  reasoningEfforts: z.array(z.string()),
})

export const Config: z<Config> = z.object({
  channel: z.union([z.const('standard'), z.const('step-plan')]).default('standard'),
  provider: z.string(),
  settingsNs: z.string(),
  displayName: z.string(),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string(),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  // No schema default on purpose: the settings layer materializes schema
  // defaults into every snapshot, which would freeze the standard catalog over
  // the channel's own. Resolution defaults by channel instead.
  models: z.array(catalogModel),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  maxRequestImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_REQUEST_IMAGE_BYTES),
  maxImagesPerRequest: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGES_PER_REQUEST),
  imageOffloadByteQuantum: z.number().step(1).min(1).default(DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM),
  imageOffloadCountQuantum: z.number().step(1).min(1).default(DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM),
  retryPolicy: RetryPolicySchema,
})

/** Public API default per channel; the internal endpoint comes from $STEPFUN_BASE_URL. */
export const PUBLIC_BASE_URL = 'https://api.stepfun.com/v1'

export { STEP_PLAN_BASE_URL } from './common/defaults.ts'

/** Environment variable naming this provider's endpoint, honored only from trusted layers. */
const BASE_URL_ENV = 'STEPFUN_BASE_URL'

const CHANNELS: readonly StepFunChannel[] = ['standard', 'step-plan']

/**
 * The one explicit resolve step from raw config to validated connection
 * facts. Programmatic construction may bypass Schemastery normalization, so
 * every default and bound is re-judged here — for the composition entry at
 * load (fail loud) and for each settings snapshot at its first use.
 * @param config - raw plugin config or resolved settings snapshot.
 * @param environment - this run's environment layers, or `undefined` outside the product CLI.
 * @returns validated connection facts plus the credential reference.
 * @throws when the channel is unknown, the endpoint is not a public HTTP(S)
 *   root without credentials, query, or fragment, or any numeric bound is out
 *   of range.
 */
export function resolveAdapterOptions(
  config: Config,
  environment?: LaunchEnvironmentSnapshot,
): StepFunConnectionOptions {
  const channel = config.channel ?? 'standard'
  if (!CHANNELS.includes(channel)) {
    throw new Error(`llm-stepfun: channel must be one of ${CHANNELS.join(', ')} (got "${channel}")`)
  }
  if (config.defaultContextWindow !== undefined
    && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) {
    throw new Error('llm-stepfun: defaultContextWindow must be a positive integer')
  }
  if (config.maxTokens !== undefined
    && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) {
    throw new Error('llm-stepfun: maxTokens must be a positive safe integer')
  }
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isFinite(streamIdleTimeoutMs)
    || streamIdleTimeoutMs <= 0
    || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `llm-stepfun: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  const maxRequestImageBytes = config.maxRequestImageBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES
  if (!Number.isSafeInteger(maxRequestImageBytes) || maxRequestImageBytes <= 0) {
    throw new Error('llm-stepfun: maxRequestImageBytes must be a positive safe integer')
  }
  const maxImagesPerRequest = config.maxImagesPerRequest ?? DEFAULT_MAX_IMAGES_PER_REQUEST
  if (!Number.isSafeInteger(maxImagesPerRequest) || maxImagesPerRequest <= 0) {
    throw new Error('llm-stepfun: maxImagesPerRequest must be a positive safe integer')
  }
  const imageOffloadByteQuantum = config.imageOffloadByteQuantum ?? DEFAULT_IMAGE_OFFLOAD_BYTE_QUANTUM
  if (!Number.isSafeInteger(imageOffloadByteQuantum) || imageOffloadByteQuantum <= 0) {
    throw new Error('llm-stepfun: imageOffloadByteQuantum must be a positive safe integer')
  }
  if (imageOffloadByteQuantum > maxRequestImageBytes) {
    throw new Error('llm-stepfun: imageOffloadByteQuantum must not exceed maxRequestImageBytes')
  }
  const imageOffloadCountQuantum = config.imageOffloadCountQuantum ?? DEFAULT_IMAGE_OFFLOAD_COUNT_QUANTUM
  if (!Number.isSafeInteger(imageOffloadCountQuantum) || imageOffloadCountQuantum <= 0) {
    throw new Error('llm-stepfun: imageOffloadCountQuantum must be a positive safe integer')
  }
  if (imageOffloadCountQuantum > maxImagesPerRequest) {
    throw new Error('llm-stepfun: imageOffloadCountQuantum must not exceed maxImagesPerRequest')
  }
  const baseURL = config.baseURL
    ?? environment?.get(BASE_URL_ENV)?.value
    ?? (channel === 'step-plan' ? STEP_PLAN_BASE_URL : PUBLIC_BASE_URL)
  assertPublicHttpUrl(baseURL, 'llm-stepfun: baseURL')
  // Schemastery materializes an absent array as []; empty reads as "operator
  // did not choose", so the channel's own catalog applies.
  const configuredModels = config.models !== undefined && config.models.length > 0
    ? config.models
    : channel === 'step-plan' ? STEP_PLAN_MODELS : DEFAULT_MODELS
  return {
    baseURL,
    channel,
    apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    models: resolveModels(configuredModels),
    streamIdleTimeoutMs,
    maxRequestImageBytes,
    maxImagesPerRequest,
    imageOffloadByteQuantum,
    imageOffloadCountQuantum,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-stepfun: retryPolicy'),
  }
}

/** Resolve, validate, and detach the advisory model catalog. */
function resolveModels(models: readonly StepFunCatalogModel[]): StepFunCatalogModel[] {
  const seen = new Set<string>()
  return models.map((model) => {
    if (model.id.length === 0) throw new Error('llm-stepfun: catalog model ids must be non-empty')
    if (model.name !== undefined && model.name.length === 0) {
      throw new Error(`llm-stepfun: catalog model "${model.id}" has an empty name`)
    }
    if (model.contextWindow !== undefined
      && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
      throw new Error(
        `llm-stepfun: catalog model "${model.id}" contextWindow must be a positive integer`,
      )
    }
    if (model.maxTokens !== undefined
      && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
      throw new Error(
        `llm-stepfun: catalog model "${model.id}" maxTokens must be a positive integer`,
      )
    }
    const inputModalities = model.inputModalities ?? ['text']
    if (inputModalities.length === 0) {
      throw new Error(`llm-stepfun: catalog model "${model.id}" inputModalities must not be empty`)
    }
    if (inputModalities.some(modality => !(MODEL_MODALITIES as readonly string[]).includes(modality))) {
      throw new Error(
        `llm-stepfun: catalog model "${model.id}" inputModalities must contain only "text" and "image"`,
      )
    }
    if (new Set(inputModalities).size !== inputModalities.length) {
      throw new Error(`llm-stepfun: catalog model "${model.id}" inputModalities must not contain duplicates`)
    }
    const hasImage = inputModalities.includes('image')
    if (!hasImage && model.imageMaxBytes !== undefined) {
      throw new Error(`llm-stepfun: text-only catalog model "${model.id}" cannot declare image request limits`)
    }
    if (model.imageMaxBytes !== undefined
      && (!Number.isSafeInteger(model.imageMaxBytes) || model.imageMaxBytes <= 0)) {
      throw new Error(`llm-stepfun: catalog model "${model.id}" imageMaxBytes must be a positive safe integer`)
    }
    if (seen.has(model.id)) throw new Error(`llm-stepfun: duplicate catalog model "${model.id}"`)
    seen.add(model.id)
    // An empty list and absence mean the same thing — thinking stays
    // automatic with no request field — because the settings schema
    // materializes an absent array as [].
    const reasoningEfforts = model.reasoningEfforts === undefined || model.reasoningEfforts.length === 0
      ? undefined
      : model.reasoningEfforts
    if (reasoningEfforts !== undefined) {
      const effortSeen = new Set<string>()
      for (const effort of reasoningEfforts) {
        if (effort.length === 0) {
          throw new Error(`llm-stepfun: catalog model "${model.id}" reasoningEfforts must not contain empty ids`)
        }
        if (effortSeen.has(effort)) {
          throw new Error(`llm-stepfun: catalog model "${model.id}" reasoningEfforts must not contain duplicates`)
        }
        effortSeen.add(effort)
      }
    }
    return {
      id: model.id,
      ...model.name === undefined ? {} : { name: model.name },
      ...model.description === undefined ? {} : { description: model.description },
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
      inputModalities: [...inputModalities],
      ...hasImage
        ? { imageMaxBytes: model.imageMaxBytes ?? DEFAULT_REQUEST_IMAGE_MAX_BYTES }
        : {},
      ...reasoningEfforts === undefined ? {} : { reasoningEfforts: [...reasoningEfforts] },
    }
  })
}
