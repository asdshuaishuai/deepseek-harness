/**
 * `StepFunAdapter`: fetch + SSE against the StepFun OpenAI-compatible
 * chat-completions endpoint, emitting harness StreamChunks. The adapter is
 * transport-only: connection facts arrive through a thunk resolved once per
 * operation and the bearer token through a per-request resolver, so the
 * registering plugin owns validation, layering, and credential policy. The
 * endpoint root was validated as a public HTTP(S) URL at configuration
 * resolution.
 *
 * @module dsh-llm-stepfun/adapter
 */

import { createRequire } from 'node:module'
import {
  attributionHeaders,
  contentHasImage,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmAdapter,
  LlmError,
  ProviderRequestId,
  QUOTA_EXCEEDED_CODE,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  PreparedAdapterCall,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type {
  AttachmentId,
  AttachmentStore,
  ImageAttachmentRef,
  RequestImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { catalogModelInfo, modelInfo } from './common/model-info.ts'
import { DEFAULT_REQUEST_IMAGE_MAX_BYTES } from './common/defaults.ts'
import type { StepFunAdapterOptions, StepFunCatalogModel, StepFunConnectionOptions } from './common/types.ts'
import { parseSse } from './protocol/sse.ts'
import { serializeRequest, serializeRequestWithImages } from './protocol/serialize.ts'
import { translate } from './protocol/translate.ts'
import type { WireError, WireRequest } from './protocol/types.ts'

const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

/** This adapter's public application identity sent as `User-Agent`. */
const STEP_IDENTITY = {
  product: 'stepfun-harness',
  version,
  url: 'https://platform.stepfun.com',
} as const

function collectImageRefs(
  content: readonly ContentBlock[],
  refs: Map<AttachmentId, ImageAttachmentRef>,
): void {
  for (const block of content) {
    if (block.type === 'image' && block.offloaded !== true) refs.set(block.attachment.attachmentId, block.attachment)
    else if (block.type === 'tool-result') collectImageRefs(block.content, refs)
  }
}

async function prepareRequestImages(
  options: GenerateOptions,
  attachments: AttachmentStore,
  model: StepFunCatalogModel,
  signal: AbortSignal,
): Promise<Map<AttachmentId, RequestImageAttachment>> {
  const refs = new Map<AttachmentId, ImageAttachmentRef>()
  for (const message of options.messages) collectImageRefs(message.content, refs)
  const orderedRefs = [...refs.values()]
  // One fixed deterministic target: the encoder never upscales past the
  // source, so generous dimensions keep detail while maxBytes bounds the
  // encoded ladder output actually sent. The fallback only guards direct
  // programmatic construction — plugin resolution always fills the field.
  const target = {
    width: 2048,
    height: 2048,
    maxBytes: model.imageMaxBytes ?? DEFAULT_REQUEST_IMAGE_MAX_BYTES,
  }
  const projected = await Promise.all(orderedRefs.map(
    ref => attachments.readImageRequest(ref, target, signal),
  ))
  return new Map(orderedRefs.map((ref, index) => (
    [ref.attachmentId, projected[index] as RequestImageAttachment]
  )))
}

function providerRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1_000
    return Number.isFinite(delay) && delay > 0 ? delay : undefined
  }
  const delay = Date.parse(value) - Date.now()
  return Number.isFinite(delay) && delay > 0 ? delay : undefined
}

function requestId(headers: Headers): ReturnType<typeof ProviderRequestId> | undefined {
  const value = headers.get('x-request-id') ?? headers.get('x-stepfun-request-id')
  return value === null || value.length === 0 ? undefined : ProviderRequestId(value)
}

/**
 * Map an HTTP status to a stable LlmError code.
 * @param status - status of a non-2xx provider response.
 * @param error - parsed provider error body, when available.
 * @returns the normalized harness error code.
 */
export function httpErrorCode(status: number, error?: WireError['error']): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 413) return 'INVALID_REQUEST'
  const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(' ')
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
    return 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/**
 * The StepFun chat-completions adapter. One instance serves every model name
 * it was registered under (the harness model name IS the wire model name).
 *
 * One stable signal reaches both initial fetch and body reads. Caller aborts
 * map to `ABORTED`; the configured per-read idle watchdog maps to `TIMEOUT`.
 */
export class StepFunAdapter extends LlmAdapter {
  constructor(private readonly config: StepFunAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    // Each route carries its own label: the open-platform route and the Step
    // Plan route are separate providers in selectors and diagnostics.
    return { id: provider, name: this.config.displayName() }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.config.options().retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.config.options().models.map(model => catalogModelInfo(provider, model)))
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve(modelInfo(this.config.options(), provider, model))
  }

  override prepareCall(provider: string, model: string, _signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const connection = this.config.options()
    return Promise.resolve({
      model: modelInfo(connection, provider, model),
      stream: options => this.streamWithConnection(options, connection),
    })
  }

  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamWithConnection(options, this.config.options())
  }

  private async * streamWithConnection(
    options: GenerateOptions,
    connection: StepFunConnectionOptions,
  ): AsyncIterable<StreamChunk> {
    // One resolution per stream call: connection facts and the credential
    // freeze here and hold for this whole request, so an in-flight stream
    // never observes a configuration change and the next call re-resolves.
    // The key resolves *from this snapshot*, so an endpoint and the secret
    // sent to it can never come from different configuration generations.
    let attachments: AttachmentStore | undefined
    if (options.messages.some(message => contentHasImage(message.content))) {
      const model = connection.models.find(entry => entry.id === options.model)
      if (model?.inputModalities?.includes('image') !== true) {
        throw new LlmError(
          `StepFun model "${options.model}" does not accept image input.`,
          'UNSUPPORTED_CONTENT',
        )
      }
      attachments = this.config.resolveAttachments?.()
      if (attachments === undefined) {
        throw new LlmError(
          'StepFun image conversion requires the durable attachment service.',
          'UNSUPPORTED_CONTENT',
        )
      }
    }
    const apiKey = await this.config.resolveApiKey(connection)
    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    using watchdog = idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE)
    const iterator = this.request(
      options,
      watchdog.signal,
      connection,
      apiKey,
      attachments,
      () => { watchdog.pulse() },
    )[Symbol.asyncIterator]()
    let exhausted = false
    try {
      while (true) {
        const result = await watchdog.next(iterator)
        if (result.done) {
          exhausted = true
          return
        }
        yield result.value
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(
          `StepFun stream idle timeout after ${connection.streamIdleTimeoutMs}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted) {
        throw new LlmError('StepFun request aborted by caller', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError(`StepFun API stream from ${connection.baseURL} failed`, 'TRANSPORT', { cause: error })
    } finally {
      consumer.abort('StepFun stream consumer stopped')
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return()
        } catch (_abortedTransportTeardown) {
          // The consumer controller already owns termination; a return-time abort cannot add a second outcome.
        }
      }
    }
  }

  private async * request(
    options: GenerateOptions,
    signal: AbortSignal,
    connection: StepFunConnectionOptions,
    apiKey: string,
    attachments: AttachmentStore | undefined,
    onActivity: () => void,
  ): AsyncIterable<StreamChunk> {
    const headers = {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      ...attributionHeaders(STEP_IDENTITY),
      ...options.sessionId !== undefined
        ? { 'x-stepfun-harness-session-id': String(options.sessionId) }
        : {},
    }

    const model = connection.models.find(entry => entry.id === options.model)
    let body: WireRequest
    if (attachments === undefined || model === undefined) {
      body = serializeRequest(options)
    } else {
      const requestImages = await prepareRequestImages(options, attachments, model, signal)
      body = await serializeRequestWithImages(options, {
        requestImages,
        ...this.config.resolveImageAccess === undefined ? {} : {
          resolveImageAccess: (ref: ImageAttachmentRef) => this.config.resolveImageAccess?.(attachments, ref),
        },
        maxRequestImageBytes: connection.maxRequestImageBytes,
        maxImagesPerRequest: connection.maxImagesPerRequest,
        byteQuantum: connection.imageOffloadByteQuantum,
        countQuantum: connection.imageOffloadCountQuantum,
      })
    }

    // TODO(http): adopt the Cordis HTTP service when shared transport configuration
    // outweighs its additional runtime dependencies.
    let response: Response
    try {
      response = await fetch(`${connection.baseURL}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      })
    } catch (error: unknown) {
      if (signal.aborted) throw error
      throw new LlmError(
        `StepFun API request to ${connection.baseURL} failed`,
        'TRANSPORT',
        { cause: error },
      )
    }

    if (!response.ok) {
      let message = `StepFun API error (HTTP ${response.status})`
      let providerError: WireError['error']
      const rawResponse = await response.text()
      try {
        const parsed = JSON.parse(rawResponse) as WireError
        providerError = parsed.error
        if (providerError?.message) message = providerError.message
      } catch {
        // The HTTP status remains authoritative when a gateway returns malformed JSON.
      }
      const delay = providerRetryAfterMs(response.headers.get('retry-after'))
      const id = requestId(response.headers)
      throw new LlmError(message, httpErrorCode(response.status, providerError), {
        cause: new Error(rawResponse.length > 0 ? rawResponse : `StepFun HTTP ${response.status}`),
        status: response.status,
        ...delay === undefined ? {} : { providerRetryAfterMs: delay },
        ...id === undefined ? {} : { requestId: id },
      })
    }
    if (!response.body) {
      throw new LlmError('StepFun API returned no response body', 'EMPTY_RESPONSE')
    }

    yield* translate(parseSse(response.body, onActivity))
  }
}
