/**
 * Register a StepFun Search API provider in `ctx.web`. It calls the platform's
 * retrieval endpoint (`POST /v1/search`) directly — the open-platform route
 * the StepFun docs recommend for `step-5-preview`, whose Chat Completions
 * requests reject a built-in `web_search` tool. The key resolves per search
 * from `STEPFUN_API_KEY` (credentials service first, environment fallback).
 * Billing follows the open-platform web-search pricing, in contrast to the
 * StepSearch MCP whose `web_search` consumes Step Plan credit.
 * @module @deepseek-ai/dsh-web-search-stepfun
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-web'
import {
  StepFunSearchProvider,
  STEPFUN_SEARCH_DEFAULT_BASE_URL,
  STEPFUN_SEARCH_DEFAULT_NUM_RESULTS,
} from './provider.ts'
import type { StepFunSearchProviderOptions } from './provider.ts'

export {
  StepFunSearchProvider,
  STEPFUN_SEARCH_DEFAULT_BASE_URL,
  STEPFUN_SEARCH_DEFAULT_NUM_RESULTS,
} from './provider.ts'
export { STEPFUN_SEARCH_PROVIDER_ID } from './provider.ts'
export type { StepFunSearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-stepfun'

/** The web seam this provider registers into. */
export const inject = ['web']

const DEFAULT_API_KEY_ENV = 'STEPFUN_API_KEY'

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** Literal StepFun API key; prefer {@link apiKeyEnv} so no secret enters configuration files. */
  apiKey?: string
  /** Credential reference resolved for each search; defaults to `STEPFUN_API_KEY`. */
  apiKeyEnv?: string
  /** Search endpoint base; `/search` is appended. Defaults to the public API. */
  baseURL?: string
  /** Default result count sent as the API's `n`. Defaults to 5. */
  numResults?: number
}

export const Config: z<Config> = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  // Declared here rather than only at the use site: a configuration surface
  // renders the resolved section, so a default the schema does not carry reads
  // there as no value at all.
  baseURL: z.string(),
  numResults: z.number().step(1).min(1).default(STEPFUN_SEARCH_DEFAULT_NUM_RESULTS),
})

/**
 * Auxiliary-search endpoint override, independent of the chat adapter's
 * `$STEPFUN_BASE_URL` (which carries `/v1` semantics of its own).
 */
const SEARCH_BASE_URL_ENV = 'STEPFUN_SEARCH_BASE_URL'

/** Settings namespace carrying this provider's endpoint and key reference. */
export const WEB_SEARCH_STEPFUN_SETTINGS_NAMESPACE = 'web-search-stepfun'

/**
 * Project one resolved section into the options the provider serves its next
 * search with. Environment fallbacks stay here rather than in the provider:
 * every value it reads is already fully defaulted.
 * @param ctx - plugin context supplying the credential and environment planes.
 * @param config - the currently authoritative section.
 * @returns options for one search.
 */
function resolveOptions(ctx: Context, config: Config): StepFunSearchProviderOptions {
  const apiKeyEnv = credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV)
  const literalApiKey = config.apiKey !== undefined && config.apiKey.length > 0
    ? config.apiKey
    : undefined
  return {
    ...literalApiKey === undefined ? {} : { apiKey: literalApiKey },
    resolveApiKey: async () => {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value
      // Without the seam the environment is the whole credential plane.
      const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv)
      return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
    },
    apiKeyEnv,
    baseURL: config.baseURL
      ?? launchEnvironmentOf(ctx).get(SEARCH_BASE_URL_ENV)?.value
      ?? STEPFUN_SEARCH_DEFAULT_BASE_URL,
    numResults: config.numResults ?? STEPFUN_SEARCH_DEFAULT_NUM_RESULTS,
  }
}

/** Register the StepFun search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, WEB_SEARCH_STEPFUN_SETTINGS_NAMESPACE, Config, config, {
      setSource: (source) => {
        current = source
      },
      // The registration carries no resolved value: the provider projects the
      // section per search, so a committed change needs no re-registration.
      onChange: () => {},
    })
  })
  ctx.web.registerSearchProvider(new StepFunSearchProvider(() => resolveOptions(ctx, current())))
}
