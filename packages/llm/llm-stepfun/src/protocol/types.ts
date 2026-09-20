/**
 * StepFun chat-completions wire format (OpenAI-compatible). Types only.
 *
 * Source of truth: the StepFun open-platform docs for `step-5-preview`
 * (`platform.stepfun.com/docs/zh/guides/models/step-5-preview`, 2026-09):
 * `POST {baseURL}/chat/completions` with base64 `image_url` parts for image
 * input; thinking is automatic, so the request carries no thinking toggle.
 *
 * @module dsh-llm-stepfun/protocol-types
 */

/** Request body for `POST {baseURL}/chat/completions`. */
export interface WireRequest {
  model: string
  messages: WireMessage[]
  stream: true
  stream_options: { include_usage: true }
  tools?: WireTool[]
  temperature?: number
  max_tokens?: number
  /** Stop sequences (OpenAI `stop`), mapped from the harness `stop` option. */
  stop?: string[]
  /**
   * Selected reasoning effort (Step 3.7 Flash / Step 3.5 Flash 2603 on the
   * Step Plan channel); omitted keeps the model's automatic default.
   */
  reasoning_effort?: string
}

/** System-role message: a single string of instructions. */
export interface WireSystemMessage {
  role: 'system'
  content: string
}

/** Text part inside a multimodal user message. */
export interface WireTextContentPart {
  type: 'text'
  text: string
}

/** Inline base64 data URL inside a multimodal user message. */
export interface WireImageUrlContentPart {
  type: 'image_url'
  image_url: { url: string }
}

/** Ordered input part accepted by a multimodal user message. */
export type WireUserContentPart = WireTextContentPart | WireImageUrlContentPart

/** User-role message: text-only string or ordered multimodal input. */
export interface WireUserMessage {
  role: 'user'
  content: string | WireUserContentPart[]
}

/** Tool-role message: the result of one tool call, keyed by its call id. */
export interface WireToolMessage {
  role: 'tool'
  tool_call_id: string
  content: string
}

/** One entry of the request `messages` array, discriminated on `role`. */
export type WireMessage =
  | WireSystemMessage
  | WireUserMessage
  | WireAssistantMessage
  | WireToolMessage

/**
 * Assistant-role history message. The harness replays `content: ""` (never
 * null) on turns that carried text or tool calls; null only when the turn
 * carried neither.
 */
export interface WireAssistantMessage {
  role: 'assistant'
  content: string | null
  /** Thinking-model CoT, replayed when the recorded turn carried reasoning. */
  reasoning_content?: string
  tool_calls?: WireToolCall[]
}

/** A completed tool call replayed on an assistant history message; `arguments` is the raw JSON string. */
export interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** One entry of the request `tools` array; `parameters` is a JSON Schema object. */
export interface WireTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** One parsed SSE `data:` payload (a chat.completion.chunk). */
export interface WireChunk {
  choices?: WireChoice[]
  /** Arrives attached to the finish chunk and/or as a trailing usage-only chunk. */
  usage?: WireUsage | null
}

/** One streamed choice (requests always ask for a single one); `finish_reason` is non-null only on its terminal chunk. */
export interface WireChoice {
  delta?: WireDelta
  finish_reason?: string | null
}

/** The incremental content of one streamed choice; any subset of fields may be present per chunk. */
export interface WireDelta {
  role?: string
  /** Visible text. Null/empty on reasoning/tool-call chunks. */
  content?: string | null
  /** Thinking-model CoT; the first chunk may carry an empty string. */
  reasoning_content?: string | null
  tool_calls?: WireToolCallDelta[]
}

/** A streamed fragment of one tool call; fragments sharing an `index` concatenate into one call. */
export interface WireToolCallDelta {
  /** Disambiguates parallel tool calls; stable across a call's deltas. */
  index: number
  /** Carried by the first delta of each call; `''`/`null` on continuations means "unchanged". */
  id?: string | null
  type?: 'function'
  function?: {
    /** Carried by the first delta of each call, with the same `''`/`null` repetition as {@link WireToolCallDelta.id}. */
    name?: string | null
    /** Argument JSON fragment (concatenate across deltas). */
    arguments?: string | null
  }
}

/**
 * Wire token accounting. `prompt_tokens` may include cache hits on
 * OpenAI-compatible endpoints; `mapUsage` subtracts the reported hit count to
 * keep the harness convention of disjoint counts.
 */
export interface WireUsage {
  prompt_tokens: number
  completion_tokens: number
  /** Provider-reported aggregate across prompt and completion tokens. */
  total_tokens?: number
  prompt_cache_hit_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

/** Non-2xx error body. */
export interface WireError {
  error?: { message?: string; type?: string; code?: string }
}
