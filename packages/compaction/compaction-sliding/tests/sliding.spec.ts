/** Sliding-window preset: 70% threshold, background compactor, main-model fallback. */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmError, LlmAdapter, createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { SlidingCompactionEngine, DEFAULT_SLIDING_THRESHOLD_RATIO, routedTarget } from '../src/index.ts'
import type { SlidingCompactionConfig } from '../src/index.ts'

const SIGNAL = new AbortController().signal
const MAIN_MODEL = 'step-5-preview'
const COMPACTOR_MODEL = 'step-3.7-flash'
const PROVIDER = 'stepfun-official'

/** Records every stream call by model; fails models in `failFor`. */
class RecordingAdapter extends LlmAdapter {
  readonly calls: string[] = []
  readonly windows: Readonly<Record<string, number>>
  failFor: ReadonlySet<string> = new Set()
  /** The LlmError code a failing model reports; abort exercises the rethrow arm. */
  failCode = 'PROVIDER'

  constructor(windows: Readonly<Record<string, number>> = { [MAIN_MODEL]: 1_000, [COMPACTOR_MODEL]: 256_000 }) {
    super()
    this.windows = windows
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...this.windows[model] === undefined ? {} : { context: { contextWindow: this.windows[model] } },
    })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options.model)
    if (this.failFor.has(options.model)) {
      throw new LlmError(`${options.model} cannot serve on this channel`, this.failCode)
    }
    yield { type: 'text-delta', index: 0, text: `checkpoint by ${options.model}` }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function createContext(
  windows: Readonly<Record<string, number>> = { [MAIN_MODEL]: 1_000, [COMPACTOR_MODEL]: 256_000 },
): { ctx: Context; adapter: RecordingAdapter } {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  const adapter = new RecordingAdapter(windows)
  ctx.llm.registerAdapter([PROVIDER], adapter)
  return { ctx, adapter }
}

/** Four closed fixture turns; the first carries the routed request header. */
function conversation(): Session {
  const text = 'fixture '.repeat(40).trim()
  const session = Session.create(SessionId('sliding-fixture'))
  for (let turn = 1; turn <= 4; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${text} user ${turn}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) {
      session.append('request/header', {
        header: { config: { provider: PROVIDER, model: MAIN_MODEL } },
        reason: 'initial',
      })
    }
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `${text} assistant ${turn}` }],
        source: { kind: 'model', provider: PROVIDER, model: MAIN_MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: 5 })
  return session
}

function engine(ctx: Context, config: SlidingCompactionConfig = {}): SlidingCompactionEngine {
  return new SlidingCompactionEngine(ctx, { auto: false, ...config })
}

describe('routedTarget', () => {
  it('reads the latest routed request header', () => {
    const session = conversation()
    expect(routedTarget({ session, options: {} } as never)).toEqual({
      provider: PROVIDER,
      model: MAIN_MODEL,
    })
  })

  it('returns undefined without a header or with blank fields', () => {
    const session = Session.create(SessionId('unrouted'))
    session.append('turn/start', { turn: 1 })
    expect(routedTarget({ session, options: {} } as never)).toBeUndefined()

    const blank = conversation()
    blank.append('request/header', {
      header: { config: { provider: '', model: '' } },
      reason: 'initial',
    })
    expect(routedTarget({ session: blank, options: {} } as never)).toBeUndefined()
  })
})

describe('sliding window configuration', () => {
  it('defaults the pressure threshold to 70% of the context window', () => {
    const { ctx } = createContext()
    const sliding = engine(ctx)
    expect(sliding.config.thresholdRatio).toBe(DEFAULT_SLIDING_THRESHOLD_RATIO)
    expect(sliding.config.thresholdRatio).toBe(0.7)
    expect(sliding.sliding.compactor).toEqual({ provider: PROVIDER, model: COMPACTOR_MODEL })
    expect(sliding.sliding.fallbackToMain).toBe(true)
  })

  it('honors explicit threshold and compactor overrides', () => {
    const { ctx } = createContext()
    const sliding = engine(ctx, {
      thresholdRatio: 0.6,
      compactorModel: 'step-router-v1',
      compactorFallbackToMain: false,
    })
    expect(sliding.config.thresholdRatio).toBe(0.6)
    expect(sliding.sliding.compactor.model).toBe('step-router-v1')
    expect(sliding.sliding.fallbackToMain).toBe(false)
  })
})

describe('background compactor selection', () => {
  it('drives the compactor model in the background before the main model is touched', async () => {
    const { ctx, adapter } = createContext()
    const result = await engine(ctx).compactIfNeeded(agent(conversation()), 'pressure', SIGNAL)
    expect(result).not.toBeNull()
    // The background compactor wrote the checkpoint; the main model's
    // history was never asked to summarize itself.
    expect(adapter.calls[0]).toBe(COMPACTOR_MODEL)
    expect(adapter.calls).not.toContain(MAIN_MODEL)
  })

  it('falls back to the routed main model when the compactor cannot serve', async () => {
    const { ctx, adapter } = createContext()
    adapter.failFor = new Set([COMPACTOR_MODEL])
    const result = await engine(ctx).compactIfNeeded(agent(conversation()), 'pressure', SIGNAL)
    expect(result).not.toBeNull()
    expect(adapter.calls).toEqual([COMPACTOR_MODEL, MAIN_MODEL])
  })

  it('sticks to the main model after a compactor failure for the process lifetime', async () => {
    const { ctx, adapter } = createContext()
    adapter.failFor = new Set([COMPACTOR_MODEL])
    const sliding = engine(ctx)
    const first = await sliding.compactIfNeeded(agent(conversation()), 'pressure', SIGNAL)
    expect(first).not.toBeNull()
    adapter.calls.length = 0
    // A later compaction (same engine, fresh session) does not retry the
    // known-unavailable compactor.
    const second = await sliding.compactIfNeeded(agent(conversation()), 'pressure', SIGNAL)
    expect(second).not.toBeNull()
    expect(adapter.calls).toEqual([MAIN_MODEL])
  })

  it('surfaces the compactor error when fallback is disabled', async () => {
    const { ctx, adapter } = createContext()
    adapter.failFor = new Set([COMPACTOR_MODEL])
    await expect(engine(ctx, { compactorFallbackToMain: false }).compactIfNeeded(agent(conversation()), 'pressure', SIGNAL))
      .rejects.toThrow(/cannot serve on this channel/)
    expect(adapter.calls).toEqual([COMPACTOR_MODEL])
  })

  it('never loops the compactor when the routed model IS the compactor', async () => {
    const { ctx, adapter } = createContext({ [COMPACTOR_MODEL]: 1_000 })
    // Rewire the routed header to the compactor model itself.
    const routed = Session.create(SessionId('sliding-routed-compactor'))
    const text = 'fixture '.repeat(40).trim()
    for (let turn = 1; turn <= 4; turn += 1) {
      routed.append('turn/start', { turn })
      routed.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `${text} user ${turn}` }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      routed.append('step/start', { turn, step: 1 })
      if (turn === 1) {
        routed.append('request/header', {
          header: { config: { provider: PROVIDER, model: COMPACTOR_MODEL } },
          reason: 'initial',
        })
      }
      routed.append('assistant/message', {
        stream: [],
        turn,
        step: 1,
        message: createMessage({
          role: 'assistant',
          content: [{ type: 'text', text: `${text} assistant ${turn}` }],
          source: { kind: 'model', provider: PROVIDER, model: COMPACTOR_MODEL },
        }),
      }, { surfaceOp: 'append' })
      routed.append('step/end', { turn, step: 1 })
      routed.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
    routed.append('turn/start', { turn: 5 })
    const result = await engine(ctx).compactIfNeeded(agent(routed), 'pressure', SIGNAL)
    expect(result).not.toBeNull()
    expect(adapter.calls).toEqual([COMPACTOR_MODEL])
  })

  it('rejects an empty compactor provider or model without registering the service', () => {
    expect(() => engine(createContext().ctx, { compactorProvider: '' })).toThrow(/must be non-empty/)
    expect(() => engine(createContext().ctx, { compactorModel: '' })).toThrow(/must be non-empty/)
  })

  it('rethrows an aborted compaction and does not sticky-disable the compactor', async () => {
    const { ctx, adapter } = createContext()
    adapter.failFor = new Set([COMPACTOR_MODEL])
    adapter.failCode = 'ABORTED'
    const sliding = engine(ctx)
    // Phase 1: the aborted compactor attempt rethrows — cancellation wins.
    await expect(sliding.compactIfNeeded(agent(conversation()), 'pressure', SIGNAL))
      .rejects.toThrow(/aborted compaction/)
    // Phase 2, same engine: the abort must not have stickily disabled the
    // compactor — the next compaction attempts it first, then falls back to
    // the main model for the pass.
    adapter.failCode = 'PROVIDER'
    const second = await sliding.compactIfNeeded(agent(conversation()), 'pressure', SIGNAL)
    expect(second).not.toBeNull()
    expect(adapter.calls.slice(-2)).toEqual([COMPACTOR_MODEL, MAIN_MODEL])
  })

  it('defers to an explicitly configured summarization model', async () => {
    const { ctx, adapter } = createContext()
    const result = await engine(ctx, {
      summarizationProvider: PROVIDER,
      summarizationModel: 'custom-summarizer',
    }).compactIfNeeded(agent(conversation()), 'pressure', SIGNAL)
    expect(result).not.toBeNull()
    expect(adapter.calls).toEqual(['custom-summarizer'])
  })
})

function agent(session: Session): Parameters<SlidingCompactionEngine['compactIfNeeded']>[0] {
  return { session, options: {} } as unknown as Parameters<SlidingCompactionEngine['compactIfNeeded']>[0]
}
