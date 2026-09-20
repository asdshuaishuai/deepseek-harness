/**
 * `StepFunSearchProvider`: a `WebSearchProvider` backed by the StepFun Search
 * API (`POST /v1/search`), the open-platform retrieval route the platform
 * recommends for `step-5-preview` (whose Chat Completions requests do not
 * accept a built-in `web_search` tool). Every result carries an index-derived
 * snippet, so entries keep their snippet and drop nothing but blank fields.
 * @module @deepseek-ai/dsh-web-search-stepfun/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { StepFunSearchErrorBody, StepFunSearchResponse, StepFunSearchResultItem } from './types.ts'

/** Stable id this provider registers under. */
export const STEPFUN_SEARCH_PROVIDER_ID = 'stepfun'

/** Default StepFun Search API endpoint; `/search` is the operation. */
export const STEPFUN_SEARCH_DEFAULT_BASE_URL = 'https://api.stepfun.com/v1'

/** Default result count sent as the API's `n` when a request carries no bound. */
export const STEPFUN_SEARCH_DEFAULT_NUM_RESULTS = 5

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** Resolved provider options (the plugin's `apply` supplies env-var and constant defaults). */
export interface StepFunSearchProviderOptions {
  /** Literal StepFun API key; when present it wins over {@link resolveApiKey}. */
  apiKey?: string
  /** Resolve the current StepFun API key for one search operation. */
  resolveApiKey?: () => Promise<string | undefined>
  /** Credential reference named by missing-credential diagnostics. */
  apiKeyEnv?: CredentialRef
  /** Endpoint base; `/search` is appended. */
  baseURL: string
  /** Default result count when a request carries no `maxResults`. */
  numResults: number
}

/**
 * Map one StepFun result record to a normalized source. An entry without a
 * usable URL cannot cite anything and is dropped; `title` and `snippet` are
 * omitted rather than emitted blank.
 * @param result - one entry of the response's `results[]`.
 * @returns the normalized source, or `undefined` when the entry has no URL.
 */
export function mapStepFunResult(result: StepFunSearchResultItem): WebSearchSource | undefined {
  const url = result.url
  if (typeof url !== 'string' || url.length === 0) return undefined
  return {
    url,
    ...typeof result.title === 'string' && result.title.trim().length > 0 ? { title: result.title } : {},
    ...typeof result.snippet === 'string' && result.snippet.trim().length > 0 ? { snippet: result.snippet } : {},
  }
}

/**
 * Map a Search API response envelope to a normalized search result.
 * @param response - the parsed `POST /search` response body.
 * @returns the normalized result; URL-less entries are dropped
 *   ({@link mapStepFunResult}).
 */
export function mapStepFunResponse(response: StepFunSearchResponse): WebSearchResult {
  const sources = (response.results ?? [])
    .map(mapStepFunResult)
    .filter((source): source is WebSearchSource => source !== undefined)
  // The API returns indexed records, no generated answer, so `content` is
  // omitted. The web service owns the final `maxResults` truncation, so this
  // provider reports `truncated: false`.
  return { sources, truncated: false }
}

/** The StepFun-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class StepFunSearchProvider implements WebSearchProvider {
  readonly id = STEPFUN_SEARCH_PROVIDER_ID

  constructor(private readonly resolveOptions: () => StepFunSearchProviderOptions) {}

  available(): boolean {
    const options = this.resolveOptions()
    return ((options.apiKey?.length ?? 0) > 0 || options.resolveApiKey !== undefined)
      && URL.canParse(options.baseURL)
      && isPositiveInteger(options.numResults)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    // One snapshot for the whole operation: credential resolution awaits, and a
    // settings write landing inside that await must not send the key resolved
    // from the old section to the endpoint named by the new one.
    const options = this.resolveOptions()
    const apiKey = options.apiKey ?? await options.resolveApiKey?.()
    if (apiKey === undefined || apiKey.length === 0) {
      throw new WebError(
        `no StepFun API key for web search; store ${options.apiKeyEnv ?? 'STEPFUN_API_KEY'}`
        + ' through the credentials service or export it in the launching environment',
        'WEB_PROVIDER_ERROR',
      )
    }
    // A per-request bound wins over the configured default.
    const numResults = request.maxResults ?? options.numResults
    let response: Response
    try {
      response = await fetch(`${options.baseURL}/search`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'authorization': `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify({ query: request.query, n: numResults }),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('StepFun search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`StepFun search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const status = response.status
      let message = `StepFun Search API error (HTTP ${status})`
      try {
        const parsed = await response.json() as StepFunSearchErrorBody
        const detail = firstMessage(parsed)
        if (detail !== undefined && detail.length > 0) message = detail
      } catch (error: unknown) {
        // An abort fired mid-body must surface as WEB_ABORTED, not be swallowed
        // into a generic HTTP-error message — cancellation is not a provider
        // error (the seam's cancellation contract).
        if (isAbortError(error)) throw new WebError('StepFun search aborted', 'WEB_ABORTED', { cause: error })
        // Otherwise: the HTTP status is already captured in `message` above; a
        // malformed/non-JSON error body (normal for gateway 5xx/429s) can only
        // cost a richer provider message, never the real error.
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    try {
      const payload = await response.json() as StepFunSearchResponse
      return mapStepFunResponse(payload)
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('StepFun search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`StepFun returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }
}

/** First usable error message out of a non-2xx body, if the body names one. */
function firstMessage(body: StepFunSearchErrorBody): string | undefined {
  for (const value of [body.message, body.error]) {
    if (typeof value === 'string' && value.trim().length > 0) return value
  }
  return undefined
}

/** True for a request limit that can be sent to the API (a positive whole number). */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
