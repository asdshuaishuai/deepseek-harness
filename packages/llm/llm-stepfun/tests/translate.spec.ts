import { describe, expect, it } from 'vitest'
import { BlockAssembler, EMPTY_RESPONSE_CODE } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { DONE } from '../src/protocol/sse.ts'
import { mapFinishReason, mapUsage, translate } from '../src/protocol/translate.ts'

async function* feed(...payloads: (string | object)[]): AsyncGenerator<string> {
  for (const payload of payloads) {
    yield typeof payload === 'string' ? payload : JSON.stringify(payload)
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

describe('translate: text', () => {
  it('streams a text block and defers finish to DONE', async () => {
    const chunks = await collect(translate(feed(
      { choices: [{ delta: { role: 'assistant', content: null } }] },
      { choices: [{ delta: { content: 'Hel' } }] },
      { choices: [{ delta: { content: 'lo' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } },
      DONE,
    )))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Hel' },
      { type: 'text-delta', index: 0, text: 'lo' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } },
      { type: 'usage', usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('assembles into the message BlockAssembler expects', async () => {
    const assembler = new BlockAssembler()
    for await (const chunk of translate(feed(
      { choices: [{ delta: { content: 'hi' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      DONE,
    ))) {
      assembler.push(chunk)
    }
    expect(assembler.message().content).toEqual([{ type: 'text', text: 'hi' }])
    expect(assembler.finish).toEqual({ kind: 'stop' })
  })
})

describe('translate: reasoning', () => {
  it('does NOT open a reasoning block for the empty first-chunk signature', async () => {
    const chunks = await collect(translate(feed(
      { choices: [{ delta: { role: 'assistant', content: null, reasoning_content: '' } }] },
      { choices: [{ delta: { reasoning_content: 'step' } }] },
      { choices: [{ delta: { content: 'answer' } } ], finish_reason: undefined },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      DONE,
    )))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'step' },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'answer' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'step' } },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'answer' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })
})

describe('translate: tool calls', () => {
  it('assembles parallel calls by wire index and defers them to DONE', async () => {
    const chunks = await collect(translate(feed(
      {
        choices: [{
          delta: {
            tool_calls: [
              { index: 0, id: 'a', type: 'function', function: { name: 'bash', arguments: '{"x":' } },
              { index: 1, id: 'b', type: 'function', function: { name: 'read', arguments: '' } },
            ],
          },
        }],
      },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      DONE,
    )))
    expect(chunks.filter(chunk => chunk.type === 'block-end').map(chunk => (
      chunk.type === 'block-end' ? chunk.block : undefined
    ))).toEqual([
      { type: 'tool-call', id: 'a', name: 'bash', arguments: '{"x":1}' },
      { type: 'tool-call', id: 'b', name: 'read', arguments: '' },
    ])
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })
})

describe('translate: degenerate and malformed streams', () => {
  it('maps a stop with no blocks to an EMPTY_RESPONSE error finish', async () => {
    const chunks = await collect(translate(feed(
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      DONE,
    )))
    expect(chunks).toEqual([
      {
        type: 'finish',
        reason: { kind: 'error', failure: { message: expect.any(String), code: EMPTY_RESPONSE_CODE } },
      },
    ])
  })

  it('aborts a malformed JSON payload', async () => {
    await expect(collect(translate(feed('{not json', DONE)))).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })

  it('aborts when the payload source ends before DONE', async () => {
    await expect(collect(translate(feed('{ "choices": [] }')))).rejects.toMatchObject({ code: 'STREAM_CLOSED' })
  })
})

describe('mapFinishReason', () => {
  it('maps the closed vocabulary and uppercases the rest', () => {
    expect(mapFinishReason('stop')).toEqual({ kind: 'stop' })
    expect(mapFinishReason('tool_calls')).toEqual({ kind: 'tool-calls' })
    expect(mapFinishReason('length')).toEqual({ kind: 'max-tokens' })
    expect(mapFinishReason('content_filter')).toEqual({
      kind: 'error',
      failure: { message: 'model stopped: content_filter', code: 'CONTENT_FILTER' },
    })
  })
})

describe('mapUsage', () => {
  it('subtracts reported cache hits from the input count', () => {
    expect(mapUsage({
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      prompt_tokens_details: { cached_tokens: 40 },
      completion_tokens_details: { reasoning_tokens: 4 },
    })).toEqual({
      inputTokens: 60,
      outputTokens: 10,
      totalTokens: 110,
      cacheReadTokens: 40,
      reasoningTokens: 4,
    })
  })

  it('omits the total when the wire total disagrees with the counters', () => {
    expect(mapUsage({ prompt_tokens: 2, completion_tokens: 3, total_tokens: 99 })).toEqual({
      inputTokens: 2,
      outputTokens: 3,
    })
  })
})
