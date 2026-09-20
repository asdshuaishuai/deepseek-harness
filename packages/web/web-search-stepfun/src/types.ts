/**
 * Wire shapes of the StepFun Search API (`POST /v1/search`). The endpoint is a
 * direct retrieval service — no model involvement — so the response is plain
 * result records; unknown fields are ignored rather than rejected.
 * @module @deepseek-ai/dsh-web-search-stepfun/types
 */

/** One search result record. `url` is the portable key; the rest is advisory. */
export interface StepFunSearchResultItem {
  /** Result page URL. */
  url?: unknown
  /** Result page title, when the index supplies one. */
  title?: unknown
  /** Index-derived summary of the page content. */
  snippet?: unknown
}

/** The `POST /v1/search` response envelope. */
export interface StepFunSearchResponse {
  results?: StepFunSearchResultItem[]
}

/** A non-2xx error body; the API's exact error envelope is not load-bearing. */
export interface StepFunSearchErrorBody {
  message?: unknown
  error?: unknown
  code?: unknown
}
