/** Frame codec and per-socket protocol state machine over a recorded sink. */
import { describe, expect, it } from 'vitest'
import type { VoiceConversation, VoiceConversationEvents } from '@deepseek-ai/dsh-voice-agent'
import {
  MAX_AUDIO_FRAME_BYTES,
  VoiceSocketSession,
  decodeClientFrame,
  encodeServerEvent,
} from '../src/index.ts'

/** A conversation double whose calls the test records. */
interface ConversationDouble extends Pick<VoiceConversation, 'id' | 'sendAudio' | 'commitUtterance' | 'close'> {
  closed: boolean
  sent: string[]
  committed: number
  events: VoiceConversationEvents
}

function conversationDouble(): ConversationDouble {
  const double = {
    closed: false,
    sent: [] as string[],
    committed: 0,
    events: undefined as unknown as VoiceConversationEvents,
    id: 'session-1' as never,
    sendAudio: (base64: string) => { double.sent.push(base64) },
    commitUtterance: () => { double.committed += 1 },
    close: () => { double.closed = true; return Promise.resolve() },
  }
  return double as ConversationDouble
}

/** Harness: one session over a recorded sink with a programmable opener. */
function harness(openOutcome: 'ok' | 'throws' = 'ok') {
  const text: string[] = []
  const binary: Buffer[] = []
  const socketClosed: boolean[] = []
  const conversation = conversationDouble()
  const session = new VoiceSocketSession({
    realtimeModel: 'stepaudio-2.5-realtime',
    openConversation: (sessionId, events) => {
      if (openOutcome === 'throws') return Promise.reject(new Error('no STEPFUN_API_KEY stored'))
      conversation.events = events
      void sessionId
      return Promise.resolve(conversation)
    },
    sendText: (frame) => { text.push(frame) },
    sendBinary: (frame) => { binary.push(frame) },
    closeSocket: () => { socketClosed.push(true) },
  })
  return { session, text, binary, socketClosed, conversation }
}

describe('frame codec', () => {
  it('decodes the three control frames', () => {
    expect(decodeClientFrame('{"type":"start"}')).toEqual({ type: 'start' })
    expect(decodeClientFrame('{"type":"start","sessionId":"s-9"}')).toEqual({ type: 'start', sessionId: 's-9' })
    expect(decodeClientFrame('{"type":"commit"}')).toEqual({ type: 'commit' })
    expect(decodeClientFrame('{"type":"stop"}')).toEqual({ type: 'stop' })
  })

  it('rejects malformed, non-object, unknown, and wrong-typed frames', () => {
    expect(decodeClientFrame('{not json')).toBeUndefined()
    expect(decodeClientFrame('42')).toBeUndefined()
    expect(decodeClientFrame('null')).toBeUndefined()
    expect(decodeClientFrame('{"type":"detonate"}')).toBeUndefined()
    expect(decodeClientFrame('{"type":"start","sessionId":9}')).toBeUndefined()
  })

  it('encodes server events as single-line JSON', () => {
    expect(encodeServerEvent({ type: 'ready', sessionId: 's', realtimeModel: 'm' }))
      .toBe('{"type":"ready","sessionId":"s","realtimeModel":"m"}')
    expect(encodeServerEvent({ type: 'error', message: 'x' })).toContain('"type":"error"')
  })
})

describe('VoiceSocketSession', () => {
  it('start opens a conversation and reports the pinned model + session id', async () => {
    const h = harness()
    await h.session.handleFrame({ type: 'start' })
    expect(h.text[0]).toBe('{"type":"ready","sessionId":"session-1","realtimeModel":"stepaudio-2.5-realtime"}')
    expect(h.session.bound).toBe(true)
  })

  it('ignores binary audio until a conversation exists, then forwards frames 1:1', async () => {
    const h = harness()
    h.session.handleAudio(Buffer.from([1]))
    expect(h.text.some(frame => frame.includes('no active voice conversation'))).toBe(true)
    await h.session.handleFrame({ type: 'start' })
    h.session.handleAudio(Buffer.from([2, 3]))
    expect(h.conversation.sent).toEqual(['AgM='])
  })

  it('rejects oversized audio frames with the cap in the message', async () => {
    const h = harness()
    await h.session.handleFrame({ type: 'start' })
    h.session.handleAudio(Buffer.alloc(MAX_AUDIO_FRAME_BYTES + 1))
    expect(h.text.some(frame => frame.includes('byte cap'))).toBe(true)
  })

  it('routes commit to the conversation and stop to a clean close', async () => {
    const h = harness()
    await h.session.handleFrame({ type: 'start' })
    h.session.handleFrame({ type: 'commit' })
    expect(h.conversation.committed).toBe(1)
    await h.session.handleFrame({ type: 'stop' })
    expect(h.conversation.closed).toBe(true)
    expect(h.session.bound).toBe(false)
  })

  it('refuses a second start while a conversation is bound', async () => {
    const h = harness()
    await h.session.handleFrame({ type: 'start' })
    await h.session.handleFrame({ type: 'start', sessionId: 'other' })
    expect(h.text.some(frame => frame.includes('already active'))).toBe(true)
  })

  it('reports a failed conversation open and keeps the socket usable', async () => {
    const h = harness('throws')
    await h.session.handleFrame({ type: 'start' })
    expect(h.text.some(frame => frame.includes('no STEPFUN_API_KEY'))).toBe(true)
    // Recovery: the next start may succeed (the opener is programmable per test).
    await h.session.handleFrame({ type: 'start' })
    expect(h.session.bound).toBe(false)
  })

  it('emits closed and closes the socket when the conversation ends', async () => {
    const h = harness()
    await h.session.handleFrame({ type: 'start' })
    h.conversation.events.onClose?.({ code: 1006, reason: 'transport drop' })
    expect(h.text.some(frame => frame.includes('"type":"closed"'))).toBe(true)
    expect(h.socketClosed).toEqual([true])
    expect(h.session.bound).toBe(false)
  })

  it('streams state, transcripts, captions, and audio frames from conversation events', async () => {
    const h = harness()
    await h.session.handleFrame({ type: 'start' })
    h.conversation.events.onState?.('thinking')
    h.conversation.events.onUserTranscript?.('hello')
    h.conversation.events.onAssistantDelta?.('hi ')
    h.conversation.events.onAssistantFinal?.('hi there')
    h.conversation.events.onAudio?.('QUJD')
    const kinds = h.text.map(frame => (JSON.parse(frame) as { type: string }).type)
    expect(kinds).toContain('state')
    expect(kinds).toContain('user-transcript')
    expect(kinds).toContain('assistant-delta')
    expect(kinds).toContain('assistant-final')
    expect(h.binary.map(frame => frame.toString())).toEqual(['ABC'])
  })
})
