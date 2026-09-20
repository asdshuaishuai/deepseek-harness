import { describe, expect, it } from 'vitest'
import type { ClientEvent, ServerEvent } from '../src/types.ts'
import { RealtimeSession } from '../src/session.ts'
import type { RealtimeConnectOptions, RealtimeTransport, RealtimeTransportFactory } from '../src/transport.ts'

/** In-process transport double: captures sends, replays injected frames. */
class FakeTransport implements RealtimeTransport {
  readonly sent: string[] = []
  private frameListener: (frame: string) => void = () => {}
  private closeListener: (code: number, reason: string) => void = () => {}
  private errorListener: (error: unknown) => void = () => {}
  closed = false

  constructor(public readonly options: RealtimeConnectOptions) {}

  send(frame: string): void {
    this.sent.push(frame)
  }

  close(code?: number, reason?: string): void {
    this.closed = true
    this.closeListener(code ?? 1000, reason ?? '')
  }

  onFrame(listener: (frame: string) => void): void {
    this.frameListener = listener
  }

  onClose(listener: (code: number, reason: string) => void): void {
    this.closeListener = listener
  }

  onError(listener: (error: unknown) => void): void {
    this.errorListener = listener
  }

  /** Deliver one server event into the session. */
  deliver(event: ServerEvent): void {
    this.frameListener(JSON.stringify(event))
  }

  /** Deliver one raw, possibly malformed frame. */
  deliverRaw(frame: string): void {
    this.frameListener(frame)
  }

  fail(error: unknown): void {
    this.errorListener(error)
  }
}

/** One recording factory: every created transport lands in the holder. */
function recordingFactory(holder: { transport?: FakeTransport }): RealtimeTransportFactory {
  return (options) => {
    const transport = new FakeTransport(options)
    holder.transport = transport
    return transport
  }
}

function createSession(events: ConstructorParameters<typeof RealtimeSession>[1]): {
  session: RealtimeSession
  transport: FakeTransport
} {
  const holder: { transport?: FakeTransport } = {}
  const session = new RealtimeSession({
    url: 'wss://api.stepfun.com/v1/realtime?model=stepaudio-3-realtime-preview',
    authorization: 'Bearer test-key',
    connectTimeoutMs: 2_000,
    transport: recordingFactory(holder),
  }, events)
  return { session, transport: holder.transport ?? undefined as unknown as FakeTransport }
}

function lastClientEvent(transport: FakeTransport): ClientEvent {
  const raw = transport.sent.at(-1)
  if (raw === undefined) throw new Error('nothing sent')
  return JSON.parse(raw) as ClientEvent
}

describe('RealtimeSession.open', () => {
  it('sends session.update and resolves on session.created', async () => {
    const { session, transport } = createSession({})
    const opened = session.open()
    expect(lastClientEvent(transport)).toEqual({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        turn_detection: { type: 'server_vad' },
      },
    })
    transport.deliver({ type: 'session.created', session: {} })
    await expect(opened).resolves.toBeUndefined()
  })

  it('carries voice and instructions in the session configuration', async () => {
    const holder: { transport?: FakeTransport } = {}
    const session = new RealtimeSession({
      url: 'wss://api.stepfun.com/v1/realtime?model=stepaudio-3-realtime-preview',
      authorization: 'Bearer test-key',
      connectTimeoutMs: 2_000,
      transport: recordingFactory(holder),
      voice: 'tongtong',
      instructions: 'answer briefly',
    }, {})
    const opened = session.open()
    expect(lastClientEvent(holder.transport ?? undefined as unknown as FakeTransport)).toEqual({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        turn_detection: { type: 'server_vad' },
        voice: 'tongtong',
        instructions: 'answer briefly',
      },
    })
    holder.transport?.deliver({ type: 'session.created', session: {} })
    await expect(opened).resolves.toBeUndefined()
  })

  it('rejects on an error frame during the handshake and restores consumer callbacks', async () => {
    const errors: string[] = []
    const { session, transport } = createSession({ onError: (error) => { errors.push(error.message ?? '') } })
    const opened = session.open()
    transport.deliver({ type: 'error', error: { message: 'bad session' } })
    await expect(opened).rejects.toMatchObject({ code: 'TRANSPORT' })
  })
})

describe('RealtimeSession steady state', () => {
  it('maps server events onto typed callbacks', async () => {
    const seen: string[] = []
    const audio: string[] = []
    const { session, transport } = createSession({
      onSpeechStarted: () => { seen.push('started') },
      onSpeechStopped: () => { seen.push('stopped') },
      onUserTranscript: (text) => { seen.push(`user:${text}`) },
      onAssistantTranscriptDelta: (delta) => { seen.push(`text:${delta}`) },
      onAssistantAudioDelta: (delta) => { audio.push(delta) },
      onResponseDone: () => { seen.push('done') },
      onError: (error) => { seen.push(`error:${error.message ?? ''}`) },
    })
    await openQuietly(session, transport)
    transport.deliver({ type: 'input_audio_buffer.speech_started', audio_start_ms: 10 })
    transport.deliver({ type: 'input_audio_buffer.speech_stopped', audio_end_ms: 900 })
    transport.deliver({ type: 'conversation.item.input_audio_transcript.completed', transcript: 'hello' })
    transport.deliver({ type: 'response.audio_transcript.delta', delta: 'hi ' })
    transport.deliver({ type: 'response.audio_transcript.delta', delta: 'there' })
    transport.deliver({ type: 'response.audio.delta', delta: 'QUJD' })
    transport.deliver({ type: 'response.done' })
    transport.deliver({ type: 'error', error: { message: 'boom' } })
    expect(seen).toEqual([
      'started',
      'stopped',
      'user:hello',
      'text:hi ',
      'text:there',
      'done',
      'error:boom',
    ])
    expect(audio).toEqual(['QUJD'])
    session.close()
  })

  it('ignores malformed frames with an error callback', async () => {
    const errors: string[] = []
    const { session, transport } = createSession({ onError: (error) => { errors.push(error.message ?? '') } })
    await openQuietly(session, transport)
    transport.deliverRaw('{not json')
    expect(errors).toHaveLength(1)
    session.close()
  })

  it('sends audio appends, commits, speech requests, and cancels on the wire', async () => {
    const { session, transport } = createSession({})
    await openQuietly(session, transport)
    session.appendAudio('QUJD')
    expect(lastClientEvent(transport)).toEqual({ type: 'input_audio_buffer.append', audio: 'QUJD' })
    session.commit()
    expect(lastClientEvent(transport)).toEqual({ type: 'input_audio_buffer.commit' })
    session.speak('the answer', 'read it calmly')
    expect(lastClientEvent(transport)).toEqual({
      type: 'response.create',
      response: {
        modalities: ['text', 'audio'],
        input: [{ type: 'text', text: 'the answer' }],
        instructions: 'read it calmly',
      },
    })
    session.cancelResponse()
    expect(lastClientEvent(transport)).toEqual({ type: 'response.cancel' })
    session.close()
    expect(transport.closed).toBe(true)
    expect(() => session.appendAudio('after')).toThrow(/closed/)
  })
})

/** Open helper that acknowledges the handshake on the fake transport. */
async function openQuietly(session: RealtimeSession, transport: FakeTransport): Promise<void> {
  const opened = session.open()
  transport.deliver({ type: 'session.created', session: {} })
  await opened
}
