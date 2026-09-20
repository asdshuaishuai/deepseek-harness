/** StepFun connection and catalog vocabulary shared by the adapter and plugin. */
import type { ImageAttachmentAccess, ModelModality, ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'

/**
 * Billing channel selecting the default endpoint and catalog: the standard
 * open-platform API (`https://api.stepfun.com/v1`) or the Step Plan
 * subscription API (`https://api.stepfun.com/step_plan/v1`), which also hosts
 * the StepSearch MCP and the plan realtime endpoint.
 */
export type StepFunChannel = 'standard' | 'step-plan'

/** One optional model entry advertised by the StepFun adapter. */
export interface StepFunCatalogModel {
  /** Wire model id accepted by the configured endpoint. */
  id: string
  /** Selector label; defaults to {@link id}. */
  name?: string
  /** Optional selector detail for deployments with similar model variants. */
  description?: string
  /** Known combined request/response context capacity; omitted falls back to the profile default. */
  contextWindow?: number
  /** Per-request output cap for this model; omission falls back to the profile's maxTokens. */
  maxTokens?: number
  /** Accepted request modalities; omission is text-only. */
  inputModalities?: ModelModality[]
  /** Encoded-byte target for one deterministic request preview. */
  imageMaxBytes?: number
  /**
   * Selectable reasoning-effort ids this model accepts as `reasoning_effort`
   * (Step 3.7 Flash: low/medium/high; Step 3.5 Flash 2603: low/high). Absence
   * or an empty list keeps thinking automatic with no request field.
   */
  reasoningEfforts?: string[]
}

/**
 * Validated connection facts for one operation. The plugin's
 * `resolveAdapterOptions` is the one explicit resolve step producing this
 * shape; the adapter trusts it and re-reads it per operation, so a
 * configuration change reaches the next request without re-registration.
 */
export interface StepFunConnectionOptions {
  /** Root of the OpenAI-compatible API; `${baseURL}/chat/completions` receives requests. */
  baseURL: string
  /** Billing channel this connection resolves against; drove the endpoint and catalog defaults. */
  channel: StepFunChannel
  /**
   * Credential reference of this same resolution, resolved per request.
   * Travelling with the endpoint is the point: a request can never pair one
   * generation's URL with another generation's secret.
   */
  apiKeyEnv: CredentialRef
  /** Default per-request output cap; explicit request values win. */
  maxTokens: number
  /** Positive context capacity used when the selected model has no exact value. */
  defaultContextWindow: number
  /** Advisory models exposed to discovery consumers; requests remain unrestricted. */
  models: readonly StepFunCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding. */
  streamIdleTimeoutMs: number
  /** Maximum accumulated base64 image payload in one request. */
  maxRequestImageBytes: number
  /** Maximum number of represented images in one request. */
  maxImagesPerRequest: number
  /** Base64-byte removal step applied after the request exceeds its byte bound. */
  imageOffloadByteQuantum: number
  /** Image-count removal step applied after the request exceeds its count bound. */
  imageOffloadCountQuantum: number
  /** Provider-owned model-request retry policy, already resolved. */
  retryPolicy: ResolvedRetryPolicy
}

/** Constructor options for {@link StepFunAdapter}: the operation-local resolution hooks the plugin owns. */
export interface StepFunAdapterOptions {
  /** Current validated connection facts; called once per operation. */
  options: () => StepFunConnectionOptions
  /**
   * Resolve the bearer token for the connection facts of one request. The
   * snapshot is passed in — never re-read — so the key can only ever come
   * from the same resolution as the endpoint it is sent to. Throws `LlmError`
   * `MISSING_CREDENTIAL` when no key is available anywhere.
   */
  resolveApiKey: (connection: StepFunConnectionOptions) => Promise<string>
  /** Resolve the current durable attachment service; absence rejects image input. */
  resolveAttachments?: () => AttachmentStore | undefined
  /** Bridge one attachment reference into the current model-tool execution world. */
  resolveImageAccess?: (attachments: AttachmentStore, ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined
}
