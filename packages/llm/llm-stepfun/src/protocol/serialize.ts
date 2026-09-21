/**
 * Serialize harness messages into StepFun chat completions. Text-only requests
 * retain string user content; the image path inlines durable attachments as
 * base64 data-URL parts (StepFun exposes no Files API for chat images).
 * Tool-result images follow their string-only tool messages in a separate
 * user message.
 *
 * @module dsh-llm-stepfun/serialize
 */

import {
  contentHasImage,
  IMAGE_OFFLOAD_REQUIRED_CODE,
  LlmError,
  offloadedImageText,
  projectOffloadedImages,
  requestImageHandleText,
  requiredImageOffload,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, ImageAttachmentAccessResolver, Message } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { WireImageUrlContentPart, WireMessage, WireRequest, WireTextContentPart, WireTool, WireUserContentPart } from './types.ts'

/** Dependencies required only when the request contains image input. */
export interface ImageSerializationOptions {
  /** Request versions prepared for the conservatively retained normalized attachments, keyed by attachment id. */
  requestImages: ReadonlyMap<ImageAttachmentRef['attachmentId'], RequestImageAttachment>
  /** Resolve current tool access independently from deterministic request-image versions. */
  resolveImageAccess?: ImageAttachmentAccessResolver
  /** Positive bound on accumulated base64 image payload. */
  maxRequestImageBytes: number
  /** Maximum represented images in one request. */
  maxImagesPerRequest?: number
  /** Represented-byte removal step applied after the request exceeds its byte bound. */
  byteQuantum?: number
  /** Image-count removal step applied after the request exceeds its count bound. */
  countQuantum?: number
}

const TOOL_RESULT_IMAGE_TEXT = 'Attached image(s) from tool result:'

/** Wire content for an empty tool result: OpenAI-compatible endpoints reject empty strings. */
const EMPTY_TOOL_OUTPUT = '(no output)'

/** Resolve the prepared request version for one retained image occurrence. */
function preparedImageVersion(
  images: ImageSerializationOptions,
  attachmentId: ImageAttachmentRef['attachmentId'],
): RequestImageAttachment {
  const version = images.requestImages.get(attachmentId)
  if (version === undefined) {
    throw new LlmError(`StepFun request image ${attachmentId} was not prepared.`, 'INVALID_REQUEST')
  }
  return version
}

/** Join the text blocks of a message (used for user/tool-result content). */
function flattenText(blocks: ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Reject core image content before any text-flattening path can silently erase it. */
function assertTextOnly(blocks: readonly ContentBlock[]): void {
  if (contentHasImage(blocks)) {
    throw new LlmError('The StepFun chat-completions adapter does not support image content.', 'UNSUPPORTED_CONTENT')
  }
}

/** Reject roles whose StepFun history format cannot carry image input. */
function assertSupportedImageRoles(messages: readonly Message[]): void {
  for (const message of messages) {
    if (message.role !== 'user' && contentHasImage(message.content)) {
      throw new LlmError(
        `The StepFun chat-completions adapter cannot represent image content in a ${message.role} message.`,
        'UNSUPPORTED_CONTENT',
      )
    }
  }
}

/** Describe the exact request preview and its model-callable coordinate system. */
function imageHandle(
  ref: ImageAttachmentRef,
  version: RequestImageAttachment,
  resolveAccess: ImageAttachmentAccessResolver | undefined,
  precededByContent: boolean,
): WireTextContentPart {
  return {
    type: 'text',
    text: `${precededByContent ? '\n' : ''}${requestImageHandleText(ref, version, resolveAccess?.(ref))}`,
  }
}

/** Resolve one retained image occurrence into its handle text and inline base64 part. */
function imageParts(
  block: Extract<ContentBlock, { type: 'image' }>,
  images: ImageSerializationOptions,
  precededByContent: boolean,
): [WireTextContentPart, WireImageUrlContentPart] {
  const version = preparedImageVersion(images, block.attachment.attachmentId)
  const image: WireImageUrlContentPart = {
    type: 'image_url',
    image_url: { url: `data:${version.mediaType};base64,${Buffer.from(version.data).toString('base64')}` },
  }
  return [imageHandle(block.attachment, version, images.resolveImageAccess, precededByContent), image]
}

/** Convert user or nested tool-result blocks into ordered wire parts. */
function contentParts(
  blocks: readonly ContentBlock[],
  images: ImageSerializationOptions,
  nextImage: { value: number },
): WireUserContentPart[] {
  const parts: WireUserContentPart[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) parts.push({ type: 'text', text: block.text })
        break
      case 'image':
        nextImage.value += 1
        parts.push(...imageParts(block, images, parts.length > 0))
        break
      case 'tool-result':
        parts.push(...contentParts(block.content, images, nextImage))
        break
      default:
        // Other merge-extensible blocks are not StepFun user-input vocabulary.
        break
    }
  }
  return parts
}

/** Keep text-only user messages on the compact string wire form. */
function userContent(parts: readonly WireUserContentPart[]): string | WireUserContentPart[] {
  const text: string[] = []
  for (const part of parts) {
    if (part.type !== 'text') return [...parts]
    text.push(part.text)
  }
  return text.join('')
}

/** Serialize one assistant message (text + reasoning + tool calls). */
function serializeAssistant(message: Message): WireMessage {
  const text = flattenText(message.content)
  const reasoning = message.content
    .filter(block => block.type === 'reasoning')
    .map(block => block.text)
    .join('')
  const toolCalls = message.content
    .filter(block => block.type === 'tool-call')
    .map(block => ({
      id: block.id,
      type: 'function' as const,
      function: { name: block.name, arguments: block.arguments },
    }))

  return {
    role: 'assistant',
    // Text-less turns send "" — never null: OpenAI-compatible endpoints reject
    // null-content/no-tool_calls assistant messages, and the message sits
    // durably in the session log, so a null here bricks every later turn.
    content: text,
    ...reasoning.length > 0 ? { reasoning_content: reasoning } : {},
    ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
  }
}

/**
 * Serialize the conversation. `tool-result` blocks become standalone
 * `{role: 'tool'}` messages; the harness puts each tool result in its own
 * user-role message, so a mixed user message contributes its text first and
 * its tool results as separate wire messages after.
 * @param messages - the harness conversation, in order.
 * @returns the wire messages; order preserved, each tool result expanded into its own entry.
 */
export function serializeMessages(messages: Message[]): WireMessage[] {
  const wire: WireMessage[] = []
  for (const message of messages) {
    assertTextOnly(message.content)
    if (message.role === 'system') {
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      wire.push(serializeAssistant(message))
      continue
    }
    // user role: tool results ride in user messages in the harness
    // vocabulary, but StepFun wants them as role:'tool' messages.
    const toolResults = message.content.filter(block => block.type === 'tool-result')
    const text = flattenText(message.content)
    if (text.length > 0 || toolResults.length === 0) {
      wire.push({ role: 'user', content: text })
    }
    for (const result of toolResults) {
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: flattenText(result.content) || EMPTY_TOOL_OUTPUT,
      })
    }
  }
  return wire
}

/**
 * Serialize image-capable history after resolving durable attachments.
 * Consecutive tool results keep string `tool` messages and share one following
 * user message containing their images.
 * @param messages - request history whose offloaded occurrences are already placeholder text.
 * @param images - prepared request versions, optional access resolver, and request bounds.
 * @returns ordered StepFun wire messages.
 */
export function serializeMessagesWithImages(
  messages: readonly Message[],
  images: ImageSerializationOptions,
): WireMessage[] {
  assertSupportedImageRoles(messages)
  const wire: WireMessage[] = []
  let pendingToolImages: WireImageUrlContentPart[] = []
  const flushToolImages = (): void => {
    if (pendingToolImages.length === 0) return
    wire.push({
      role: 'user',
      content: [{ type: 'text', text: TOOL_RESULT_IMAGE_TEXT }, ...pendingToolImages],
    })
    pendingToolImages = []
  }

  for (const message of messages) {
    const nextImage = { value: 0 }
    if (message.role === 'system') {
      flushToolImages()
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      flushToolImages()
      wire.push(serializeAssistant(message))
      continue
    }

    const regular = message.content.filter(block => block.type !== 'tool-result')
    const toolResults = message.content.filter((block): block is Extract<ContentBlock, { type: 'tool-result' }> => (
      block.type === 'tool-result'
    ))
    const content = userContent(contentParts(regular, images, nextImage))
    if (content.length > 0 || toolResults.length === 0) {
      flushToolImages()
      wire.push({ role: 'user', content })
    }
    for (const result of toolResults) {
      const parts = contentParts(result.content, images, nextImage)
      const imageParts = parts.filter((part): part is WireImageUrlContentPart => part.type !== 'text')
      const text = parts.filter(part => part.type === 'text').map(part => part.text).join('')
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: text || EMPTY_TOOL_OUTPUT,
      })
      pendingToolImages.push(...imageParts)
    }
  }
  flushToolImages()
  return wire
}

/** Assemble request fields shared by text-only and image-capable conversion. */
function requestWithMessages(options: GenerateOptions, messages: WireMessage[]): WireRequest {
  const tools: WireTool[] | undefined = options.tools?.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    ...options.temperature !== undefined ? { temperature: options.temperature } : {},
    ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
    ...options.stop !== undefined ? { stop: options.stop } : {},
    // Effort arrives only when the selected model advertises selectable
    // efforts; models with automatic thinking never set the field.
    ...options.reasoningEffort === undefined ? {} : { reasoning_effort: String(options.reasoningEffort) },
  }
}

/**
 * Build the full wire request. Always streaming (`stream: true`, usage
 * reporting on); optional fields are omitted rather than sent as null, so
 * provider defaults apply. Thinking is automatic on the Step 5 family; a
 * `reasoning_effort` field appears only when the caller selected one on a
 * model that advertises selectable efforts.
 * @param options - the harness request (model, history, system, tools, sampling).
 * @returns the chat-completions request body.
 */
export function serializeRequest(options: GenerateOptions): WireRequest {
  const messages: WireMessage[] = []
  if (options.system !== undefined) {
    messages.push({ role: 'system', content: options.system })
  }
  messages.push(...serializeMessages(options.messages))
  return requestWithMessages(options, messages)
}

/**
 * Reject a request whose retained occurrences, at their exact request-version
 * byte lengths under the base64 representation, still exceed the route budget.
 * The failure names how many more oldest retained occurrences need durable
 * omission before the request can be retried.
 */
function assertRetainedImagesFit(messages: readonly Message[], images: ImageSerializationOptions): void {
  const offloadImages = requiredImageOffload(messages, {
    representation: 'base64',
    maxBytes: images.maxRequestImageBytes,
    ...images.maxImagesPerRequest === undefined ? {} : { maxImages: images.maxImagesPerRequest },
    ...images.byteQuantum === undefined ? {} : { byteQuantum: images.byteQuantum },
    ...images.countQuantum === undefined ? {} : { countQuantum: images.countQuantum },
  }, (block) => preparedImageVersion(images, block.attachment.attachmentId).bytes)
  if (offloadImages > 0) {
    throw new LlmError(
      `StepFun base64 request images exceed the route budget; ${offloadImages} more oldest occurrence(s) must be offloaded.`,
      IMAGE_OFFLOAD_REQUIRED_CODE,
      { offloadImages },
    )
  }
}

/**
 * Build one image-capable request while keeping durable bytes out of session
 * messages. Offloaded occurrences become per-image text; retained occurrences
 * must fit the route budget at their exact request-version byte lengths.
 * @param options - harness request containing image-capable user content.
 * @param images - request versions, optional current access resolver, and request bounds.
 * @returns the fully materialized StepFun request body.
 */
// oxlint-disable-next-line typescript/require-await -- async preserves the awaited rejection contract its tests pin.
export async function serializeRequestWithImages(
  options: GenerateOptions,
  images: ImageSerializationOptions,
): Promise<WireRequest> {
  assertSupportedImageRoles(options.messages)
  assertRetainedImagesFit(options.messages, images)
  const requestMessages = projectOffloadedImages(
    options.messages,
    ref => offloadedImageText(ref, images.resolveImageAccess?.(ref)),
  )
  const messages: WireMessage[] = []
  if (options.system !== undefined) {
    messages.push({ role: 'system', content: options.system })
  }
  messages.push(...serializeMessagesWithImages(requestMessages, images))
  return requestWithMessages(options, messages)
}
