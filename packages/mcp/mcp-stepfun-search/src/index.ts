/**
 * `stepfun-search-mcp`: mounts StepFun's official StepSearch MCP server —
 * the platform's default MCP, exposing `web_search` and `web_fetch` and
 * billed through the Step Plan subscription — as one `mcp-client` child over
 * Streamable HTTP. The bearer key resolves once at load from the credentials
 * service or the launching environment; without a key the plugin stays
 * quietly unmounted (the composition boots, the search tools are absent).
 *
 * The model-facing tool names are `mcp__<serverName>__web_search` and
 * `mcp__<serverName>__web_fetch`.
 *
 * @module @deepseek-ai/dsh-mcp-stepfun-search
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type { LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { credentialRef, type CredentialProvider, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { assertPublicHttpUrl } from '@deepseek-ai/dsh-url-guard'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import type { Config as McpClientConfig } from '@deepseek-ai/dsh-mcp-client'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'stepfun-search-mcp'

/** Services required before mount: the wrapper itself needs none eagerly. */
export const inject: string[] = []

/** StepSearch MCP endpoint; the only publicly documented StepFun MCP server. */
export const PUBLIC_SEARCH_MCP_URL = 'https://api.stepfun.com/step_plan/v1/mcp/web_search/mcp'

/** Default local namespace for the server's model-facing tool names. */
export const DEFAULT_SERVER_NAME = 'stepfun-search'

/** Environment variable naming this provider's API key. */
const DEFAULT_API_KEY_ENV = 'STEPFUN_API_KEY'

/** Environment variable naming an alternate StepSearch endpoint. */
const SEARCH_MCP_URL_ENV = 'STEPFUN_SEARCH_MCP_URL'

/** Default timeout for one MCP tool call, matching mcp-client's default. */
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000

/** Valid `serverName`, kept below the public tool-name budget (mcp-client's rule). */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** Plugin config: endpoint, credential reference, namespace, and mount behavior. */
export interface Config {
  /** Credential reference (environment-variable name) resolved once at load; defaults to `STEPFUN_API_KEY`. */
  apiKeyEnv?: string
  /**
   * StepSearch MCP endpoint, validated as a public HTTP(S) URL before any
   * connection: local, loopback, private, and reserved hosts are rejected.
   * Falls back to $STEPFUN_SEARCH_MCP_URL, then the public endpoint.
   */
  url?: string
  /**
   * Stable local namespace for the server's model-facing tool names
   * (`mcp__<serverName>__<rawName>`); defaults to `stepfun-search`.
   */
  serverName?: string
  /** Timeout per tool call in milliseconds (default 60,000). */
  toolCallTimeoutMs?: number
  /**
   * Fail this plugin when the initial MCP connection or tool synchronization
   * fails (default false: the supervisor logs and reconnects instead).
   */
  failOnStartupError?: boolean
}

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  url: z.string(),
  serverName: z.string().pattern(SERVER_NAME_PATTERN).default(DEFAULT_SERVER_NAME),
  toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
  failOnStartupError: z.boolean().default(false),
})

/** Validated mount facts produced by {@link resolveSearchOptions}. */
export interface ResolvedSearchOptions {
  /** MCP endpoint already validated as a public HTTP(S) URL. */
  readonly url: string
  /** Local tool-name namespace matching mcp-client's `serverName` rule. */
  readonly serverName: string
  /** Credential reference resolved once at load. */
  readonly apiKeyEnv: CredentialRef
  /** Timeout per tool call in milliseconds. */
  readonly toolCallTimeoutMs: number
  /** Whether an initial connection failure rejects the plugin. */
  readonly failOnStartupError: boolean
}

/**
 * The one explicit resolve step from raw config to validated mount facts.
 * Programmatic construction may bypass Schemastery normalization, so every
 * default and bound is re-judged here.
 * @param config - raw plugin config.
 * @param environment - this run's environment layers, or `undefined` outside the product CLI.
 * @returns validated endpoint, namespace, credential reference, and bounds.
 * @throws when the endpoint is not a public HTTP(S) URL, the namespace breaks
 *   mcp-client's rule, or the timeout is out of range.
 */
export function resolveSearchOptions(
  config: Config,
  environment?: LaunchEnvironmentSnapshot,
): ResolvedSearchOptions {
  const url = config.url
    ?? environment?.get(SEARCH_MCP_URL_ENV)?.value
    ?? PUBLIC_SEARCH_MCP_URL
  assertPublicHttpUrl(url, 'stepfun-search-mcp: url')
  const serverName = config.serverName ?? DEFAULT_SERVER_NAME
  if (!SERVER_NAME_PATTERN.test(serverName)) {
    throw new Error(`stepfun-search-mcp: serverName must match ${SERVER_NAME_PATTERN.toString()}`)
  }
  const toolCallTimeoutMs = config.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS
  if (!Number.isFinite(toolCallTimeoutMs) || toolCallTimeoutMs <= 0 || toolCallTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`stepfun-search-mcp: toolCallTimeoutMs must be positive and no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  return {
    url,
    serverName,
    apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
    toolCallTimeoutMs,
    failOnStartupError: config.failOnStartupError ?? false,
  }
}

/**
 * Resolve the bearer key once at load: the credentials service first, then a
 * trusted environment layer. Absence is not an error — the composition
 * without a StepFun key still boots, just without the search tools.
 * @param apiKeyEnv - credential reference to resolve.
 * @param credentials - mounted credentials service, if any.
 * @param environment - this run's environment layers.
 * @returns the usable key, or `undefined` when none is stored anywhere.
 */
export async function resolveSearchApiKey(
  apiKeyEnv: CredentialRef,
  credentials: CredentialProvider | undefined,
  environment: LaunchEnvironmentSnapshot,
): Promise<string | undefined> {
  if (credentials !== undefined) {
    const hit = await credentials.resolve(apiKeyEnv)
    if (hit !== undefined && hit.value.length > 0) return hit.value
  }
  const ambient = environment.get(apiKeyEnv)
  if (ambient !== undefined && ambient.value.length > 0) return ambient.value
  return undefined
}

/**
 * Build the mcp-client mount config for the resolved facts and key.
 * @param resolved - validated mount facts.
 * @param apiKey - bearer key resolved at load.
 * @returns a complete Streamable HTTP mcp-client config.
 */
export function buildSearchMcpConfig(resolved: ResolvedSearchOptions, apiKey: string): McpClientConfig {
  return {
    transport: 'streamable-http',
    serverName: resolved.serverName,
    url: resolved.url,
    headers: { Authorization: `Bearer ${apiKey}` },
    toolCallTimeoutMs: resolved.toolCallTimeoutMs,
    failOnStartupError: resolved.failOnStartupError,
  }
}

/**
 * Mount the StepSearch server behind one mcp-client child instance. Without
 * a stored key the plugin warns once and stays unmounted. The key is read at
 * load only: mcp-client's header set is static per connection generation, so
 * a rotated key needs a restart (or HMR reload) to take effect.
 * @param ctx - plugin context.
 * @param config - raw plugin config.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = resolveSearchOptions(config, launchEnvironmentOf(ctx))
  const apiKey = await resolveSearchApiKey(resolved.apiKeyEnv, ctx.get('credentials'), launchEnvironmentOf(ctx))
  if (apiKey === undefined) {
    ctx.logger.warn(
      'stepfun-search-mcp: no API key for %s; the StepSearch tools stay unmounted'
      + ' (store the key through the credentials service or export %s, then restart)',
      resolved.apiKeyEnv,
      resolved.apiKeyEnv,
    )
    return
  }
  ctx.plugin(
    { name: mcpClient.name, inject: mcpClient.inject, apply: mcpClient.apply },
    buildSearchMcpConfig(resolved, apiKey),
  )
}
