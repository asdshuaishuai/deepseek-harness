import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AttachmentId, ImageVariantId } from '@deepseek-ai/dsh-attachment'
import {
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
  IMAGE_OFFLOAD_REQUIRED_CODE,
  LlmError,
  ReasoningEffortId,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { serializeMessages, serializeRequest, serializeRequestWithImages } from '../src/protocol/serialize.ts'

describe('serializeMessages', () => {
  it('maps a plain conversation onto wire messages', () => {
    expect(serializeMessages([
      createSystemMessage('be brief', 'test'),
      createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }),
      createAssistantMessage({
        content: [{ type: 'text', text: 'hi' }],
        source: { provider: 'stepfun-official', model: 'step-5-preview' },
      }),
    ])).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ])
  })

  it('expands tool results into role:tool messages with fallback content', () => {
    const result = createToolResultMessage({
      callId: brandString<ToolCallId>('call-1'),
      content: [{ type: 'text', text: '' }],
      isError: false,
    })
    expect(serializeMessages([result])).toEqual([
      { role: 'tool', tool_call_id: 'call-1', content: '(no output)' },
    ])
  })

  it('replays reasoning and tool calls on assistant history', () => {
    const message = createAssistantMessage({
      content: [
        { type: 'reasoning', text: 'thinking it through' },
        { type: 'tool-call', id: brandString<ToolCallId>('call-2'), name: 'bash', arguments: '{"cmd":"ls"}' },
      ],
      source: { provider: 'stepfun-official', model: 'step-5-preview' },
    })
    expect(serializeMessages([message])).toEqual([
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'thinking it through',
        tool_calls: [{ id: 'call-2', type: 'function', function: { name: 'bash', arguments: '{"cmd":"ls"}' } }],
      },
    ])
  })
})

describe('serializeRequest', () => {
  it('keeps text-only user content on the string form and omits empty optionals', () => {
    const options: GenerateOptions = {
      provider: 'stepfun-official',
      model: 'step-5-preview',
      system: 'sys',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
    }
    expect(serializeRequest(options)).toEqual({
      model: 'step-5-preview',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ],
      stream: true,
      stream_options: { include_usage: true },
    })
  })

  it('maps tools, sampling, and stop onto the wire', () => {
    const options: GenerateOptions = {
      provider: 'stepfun-official',
      model: 'step-5-preview',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      tools: [{ name: 'bash', description: 'run', parameters: { type: 'object' } }],
      temperature: 0.2,
      maxTokens: 128,
      stop: ['END'],
    }
    expect(serializeRequest(options)).toMatchObject({
      tools: [{ type: 'function', function: { name: 'bash', description: 'run', parameters: { type: 'object' } } }],
      temperature: 0.2,
      max_tokens: 128,
      stop: ['END'],
    })
  })

  it('carries a selected reasoning effort as reasoning_effort', () => {
    const options: GenerateOptions = {
      provider: 'stepfun-official',
      model: 'step-3.7-flash',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
      reasoningEffort: ReasoningEffortId('low'),
    }
    expect(serializeRequest(options)).toMatchObject({ model: 'step-3.7-flash', reasoning_effort: 'low' })
  })

  it('omits reasoning_effort when the caller selected none', () => {
    const options: GenerateOptions = {
      provider: 'stepfun-official',
      model: 'step-5-preview',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
    }
    expect(serializeRequest(options)).not.toHaveProperty('reasoning_effort')
  })
})

const attachmentId = brandString<AttachmentId>('att-1')

function imageVersion(bytes: number): RequestImageAttachment {
  return {
    variantId: brandString<ImageVariantId>('variant'),
    attachment: {
      attachmentId,
      mediaType: 'image/png',
      bytes,
      width: 4,
      height: 4,
    },
    data: new Uint8Array([1, 2, 3]),
    mediaType: 'image/png',
    bytes,
    width: 4,
    height: 4,
    depth: 'uchar',
    space: 'srgb',
    hasAlpha: false,
  }
}

describe('serializeRequestWithImages', () => {
  it('inlines a retained image as a base64 data-URL part', async () => {
    const options: GenerateOptions = {
      provider: 'stepfun-official',
      model: 'step-5-preview',
      messages: [createUserMessage({
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', attachment: { attachmentId, mediaType: 'image/png', bytes: 3, width: 4, height: 4 } },
        ],
        source: { kind: 'user' },
      })],
    }
    const wire = await serializeRequestWithImages(options, {
      requestImages: new Map([[attachmentId, imageVersion(3)]]),
      maxRequestImageBytes: 1024,
    })
    const parts = wire.messages[0]
    if (parts === undefined || parts.role !== 'user' || typeof parts.content === 'string') {
      throw new Error('expected multimodal user parts')
    }
    // The image expands into its request-preview handle text followed by the
    // inline data-URL part.
    expect(parts.content[0]).toEqual({ type: 'text', text: 'look' })
    expect(parts.content[2]).toEqual({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${Buffer.from(new Uint8Array([1, 2, 3])).toString('base64')}` },
    })
  })

  it('rejects retained images over the route budget with the offload count', async () => {
    const options: GenerateOptions = {
      provider: 'stepfun-official',
      model: 'step-5-preview',
      messages: [createUserMessage({
        content: [{ type: 'image', attachment: { attachmentId, mediaType: 'image/png', bytes: 3, width: 4, height: 4 } }],
        source: { kind: 'user' },
      })],
    }
    const caught = await serializeRequestWithImages(options, {
      requestImages: new Map([[attachmentId, imageVersion(4096)]]),
      maxRequestImageBytes: 1024,
    }).then(() => undefined, (error: unknown) => error)
    expect(caught).toBeInstanceOf(LlmError)
    const failure = caught as LlmError
    expect(failure.code).toBe(IMAGE_OFFLOAD_REQUIRED_CODE)
    expect(failure.failure.offloadImages).toBe(1)
  })

  it('refuses image content in non-user roles', async () => {
    const message: Message = createAssistantMessage({
      content: [{ type: 'image', attachment: { attachmentId, mediaType: 'image/png', bytes: 3, width: 4, height: 4 } }],
      source: { provider: 'stepfun-official', model: 'step-5-preview' },
    })
    const caught = await serializeRequestWithImages({
      provider: 'stepfun-official',
      model: 'step-5-preview',
      messages: [message],
    }, { requestImages: new Map(), maxRequestImageBytes: 1024 })
      .then(() => undefined, (error: unknown) => error)
    expect(caught).toBeInstanceOf(LlmError)
    expect((caught as LlmError).code).toBe('UNSUPPORTED_CONTENT')
  })
})
