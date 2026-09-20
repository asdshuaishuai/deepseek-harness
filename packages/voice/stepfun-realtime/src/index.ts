/**
 * `stepfun-realtime`: the StepAudio 3 Realtime duplex voice service. Opens
 * WebSocket sessions against the channel endpoint (`wss://api.stepfun.com/v1/realtime`
 * standard, `wss://api.stepfun.com/step_plan/v1/realtime` under a Step Plan
 * subscription) with the caller's credential, validates the endpoint against
 * the public-host guard, and hands back a transport-level {@link RealtimeSession}.
 * Conversation policy — pairing voice turns with an agent — belongs to consumers.
 *
 * @module @deepseek-ai/dsh-stepfun-realtime
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { assertUsableApiKey, LlmError } from '@deepseek-ai/dsh-llm'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type { LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { assertPublicWebSocketUrl } from '@deepseek-ai/dsh-url-guard'
import { RealtimeSession } from './session.ts'
import type { RealtimeSessionEvents } from './session.ts'
import { globalWebSocketTransport } from './transport.ts'
import type { RealtimeConnectOptions, RealtimeTransportFactory } from './transport.ts'

export { RealtimeSession } from './session.ts'
export type { RealtimeSessionEvents, RealtimeSessionOptions } from './session.ts'
export type { RealtimeConnectOptions, RealtimeTransport, RealtimeTransportFactory } from './transport.ts'
export { globalWebSocketTransport } from './transport.ts'
export type * from './types.ts'

/** Public realtime endpoint root of the standard channel; `?model=` selects the voice model. */
export const PUBLIC_REALTIME_URL = 'wss://api.stepfun.com/v1/realtime'

/** Realtime endpoint root of the Step Plan subscription channel. */
export const STEP_PLAN_REALTIME_URL = 'wss://api.stepfun.com/step_plan/v1/realtime'

/**
 * The standard-channel default realtime model: the free-preview name of
 * StepAudio 3 Realtime (the platform replaces it when the paid version
 * ships, so it stays configurable).
 */
export const REALTIME_MODEL = 'stepaudio-3-realtime-preview'

/**
 * The Step Plan channel's default realtime model: the subscription carries
 * StepAudio 2.5 Realtime and does not list StepAudio 3 Realtime yet, so the
 * plan endpoint defaults there unless a model is configured explicitly.
 */
export const STEP_PLAN_REALTIME_MODEL = 'stepaudio-2.5-realtime'

/**
 * Billing channel selecting the default realtime endpoint: the standard open
 * platform or the Step Plan subscription.
 */
export type StepFunChannel = 'standard' | 'step-plan'

/** Environment variable naming this provider's API key. */
const DEFAULT_API_KEY_ENV = 'STEPFUN_API_KEY'

/** Environment variable naming an alternate realtime endpoint. */
const REALTIME_URL_ENV = 'STEPFUN_REALTIME_URL'

/** Environment variable naming an alternate realtime model. */
const REALTIME_MODEL_ENV = 'STEPFUN_REALTIME_MODEL'

const CHANNELS: readonly StepFunChannel[] = ['standard', 'step-plan']

/** Cordis plugin name used by loader diagnostics. */
export const name = 'stepfun-realtime'

/** Plugin config: channel, endpoint, model, credential reference, voice, and handshake budget. */
export interface Config {
  /**
   * Billing channel selecting the default realtime endpoint: `standard`
   * (open platform, default) or `step-plan` (Step Plan subscription). An
   * explicit {@link Config.baseURL} still wins.
   */
  channel?: StepFunChannel
  /** Credential reference (environment-variable name) resolved per session; defaults to `STEPFUN_API_KEY`. */
  apiKeyEnv?: string
  /**
   * WS(S) realtime endpoint root, validated against the public-host guard
   * before any connection: local, loopback, private, and reserved hosts are
   * rejected. Falls back to $STEPFUN_REALTIME_URL, then the channel endpoint.
   */
  baseURL?: string
  /**
   * Realtime model id sent as `?model=`; defaults to $STEPFUN_REALTIME_MODEL,
   * then the channel's model: `stepaudio-3-realtime-preview` on the standard
   * channel, `stepaudio-2.5-realtime` under a Step Plan subscription (the
   * plan does not list StepAudio 3 Realtime yet).
   */
  model?: string
  /** Voice the model speaks with; the platform default applies when omitted. */
  voice?: string
  /** System instructions for the voice model's own turns. */
  instructions?: string
  /** Backtrack over speech onset in ms (server VAD); the platform default is 500. */
  vadPrefixPaddingMs?: number
  /** Silence that closes an utterance in ms (server VAD); the platform default is 100. */
  vadSilenceDurationMs?: number
  /** Energy wake threshold 0–5000 (server VAD); the platform default is 2500. */
  vadEnergyThreshold?: number
  /** Ceiling on the open handshake (`session.created`) wait (default ten seconds). */
  connectTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  channel: z.union([z.const('standard'), z.const('step-plan')]).default('standard'),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string(),
  model: z.string(),
  voice: z.string(),
  instructions: z.string(),
  vadPrefixPaddingMs: z.number().step(1).min(0),
  vadSilenceDurationMs: z.number().step(1).min(0),
  vadEnergyThreshold: z.number().step(1).min(0).max(5000),
  connectTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(10_000),
})

/** One resolved realtime connection description. */
export interface ResolvedRealtimeOptions {
  /** Endpoint root already validated as a public WS(S) URL. */
  readonly baseURL: string
  /** Realtime model id; a non-empty string, attached as `?model=`. */
  readonly model: string
  /** Credential reference resolved per session. */
  readonly apiKeyEnv: CredentialRef
  /** Handshake ceiling in milliseconds. */
  readonly connectTimeoutMs: number
}

/**
 * The one explicit resolve step from raw config to validated connection
 * facts. Programmatic construction may bypass Schemastery normalization, so
 * every default and bound is re-judged here.
 * @param config - raw plugin config.
 * @param environment - this run's environment layers, or `undefined` outside the product CLI.
 * @returns validated connection facts plus the credential reference.
 * @throws when the channel is unknown, the model is empty, the endpoint is
 *   not a public WS(S) root, or the handshake budget is out of range.
 */
export function resolveRealtimeOptions(
  config: Config,
  environment?: LaunchEnvironmentSnapshot,
): ResolvedRealtimeOptions {
  const channel = config.channel ?? 'standard'
  if (!CHANNELS.includes(channel)) {
    throw new Error(`stepfun-realtime: channel must be one of ${CHANNELS.join(', ')} (got "${channel}")`)
  }
  const connectTimeoutMs = config.connectTimeoutMs ?? 10_000
  if (!Number.isFinite(connectTimeoutMs) || connectTimeoutMs <= 0 || connectTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`stepfun-realtime: connectTimeoutMs must be positive and no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  const baseURL = config.baseURL
    ?? environment?.get(REALTIME_URL_ENV)?.value
    ?? (channel === 'step-plan' ? STEP_PLAN_REALTIME_URL : PUBLIC_REALTIME_URL)
  assertPublicWebSocketUrl(baseURL, 'stepfun-realtime: baseURL')
  const model = config.model
    ?? environment?.get(REALTIME_MODEL_ENV)?.value
    ?? (channel === 'step-plan' ? STEP_PLAN_REALTIME_MODEL : REALTIME_MODEL)
  if (model.length === 0) {
    throw new Error('stepfun-realtime: model must be a non-empty realtime model id')
  }
  return {
    baseURL,
    model,
    apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
    connectTimeoutMs,
  }
}

/**
 * The service exposed as `ctx.stepfunRealtime`.
 */
export interface StepFunRealtimeService {
  /** The current validated connection facts. */
  readonly options: ResolvedRealtimeOptions
  /**
   * Open one duplex voice session.
   * @param overrides - per-session voice and instructions over the plugin config.
   * @param events - typed callbacks for the session's lifetime.
   * @returns the opened session; rejects when no key is available or the
   *   handshake fails.
   */
  createSession(
    overrides: { voice?: string; instructions?: string },
    events: RealtimeSessionEvents,
  ): Promise<RealtimeSession>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** StepAudio 3 Realtime duplex voice service. */
    stepfunRealtime: StepFunRealtimeService
  }
}

/** Resolve the endpoint URL with the model query attached. */
function endpointUrl(base: string, model: string): string {
  return `${base.replace(/\/$/, '')}?model=${model}`
}

export function apply(ctx: Context, config: Config): void {
  const { baseURL, model, apiKeyEnv, connectTimeoutMs } = resolveRealtimeOptions(
    config,
    launchEnvironmentOf(ctx),
  )

  const resolveApiKey = async (): Promise<string> => {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(apiKeyEnv)
      if (hit !== undefined) return assertUsableApiKey(hit.value, 'stepfun-realtime', apiKeyEnv)
    }
    const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv)
    if (ambient !== undefined && ambient.value.length > 0) {
      return assertUsableApiKey(ambient.value, 'stepfun-realtime', apiKeyEnv)
    }
    throw new LlmError(
      `stepfun-realtime: no API key; store ${apiKeyEnv} through the credentials service,`
      + ` or export ${apiKeyEnv} in the launching environment`,
      'MISSING_CREDENTIAL',
    )
  }

  const transport: RealtimeTransportFactory = (options: RealtimeConnectOptions) => globalWebSocketTransport(options)

  ctx.provide('stepfunRealtime', {
    options: { baseURL, model, apiKeyEnv, connectTimeoutMs },
    async createSession(overrides, events) {
      const authorization = await resolveApiKey()
      const session = new RealtimeSession({
        url: endpointUrl(baseURL, model),
        authorization,
        connectTimeoutMs,
        transport,
        ...config.voice === undefined ? {} : { voice: config.voice },
        ...config.instructions === undefined ? {} : { instructions: config.instructions },
        turnDetection: {
          ...config.vadPrefixPaddingMs === undefined ? {} : { prefixPaddingMs: config.vadPrefixPaddingMs },
          ...config.vadSilenceDurationMs === undefined ? {} : { silenceDurationMs: config.vadSilenceDurationMs },
          ...config.vadEnergyThreshold === undefined ? {} : { energyThreshold: config.vadEnergyThreshold },
        },
        // Per-session overrides win over the plugin defaults.
        ...overrides.voice === undefined ? {} : { voice: overrides.voice },
        ...overrides.instructions === undefined ? {} : { instructions: overrides.instructions },
      }, events)
      await session.open()
      return session
    },
  } satisfies StepFunRealtimeService)
}
