/** Unit coverage: result mapping, provider behaviors, and plugin registration. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import WebRuntime from '@deepseek-ai/dsh-web'
import { StepFunSearchProvider, mapStepFunResponse, mapStepFunResult, STEPFUN_SEARCH_PROVIDER_ID } from '../src/provider.ts'
import * as stepfunPlugin from '../src/index.ts'
import { apply, WEB_SEARCH_STEPFUN_SETTINGS_NAMESPACE } from '../src/index.ts'

const options = { baseURL: 'https://api.stepfun.test', numResults: 5, resolveApiKey: async () => 'sk-test' }

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('StepFun result mapping', () => {
  it('maps a full result entry', () => {
    expect(mapStepFunResult({ url: 'https://a.test', title: 'A', snippet: 'salient facts' }))
      .toEqual({ url: 'https://a.test', title: 'A', snippet: 'salient facts' })
  })

  it('drops an entry without a usable URL and omits blank optionals', () => {
    expect(mapStepFunResult({})).toBeUndefined()
    expect(mapStepFunResult({ url: '' })).toBeUndefined()
    expect(mapStepFunResult({ url: 42 })).toBeUndefined()
    expect(mapStepFunResult({ url: 'https://a.test', title: '', snippet: '  ' }))
      .toEqual({ url: 'https://a.test' })
    expect(mapStepFunResult({ url: 'https://a.test', title: '  ', snippet: 'kept' }))
      .toEqual({ url: 'https://a.test', snippet: 'kept' })
  })

  it('maps a response to a result with no content and filtered sources', () => {
    const result = mapStepFunResponse({
      results: [
        { url: 'https://a.test', title: 'A', snippet: 'one' },
        { url: 'https://b.test' },
        {},
      ],
    })
    expect(result).toEqual({
      sources: [
        { url: 'https://a.test', title: 'A', snippet: 'one' },
        { url: 'https://b.test' },
      ],
      truncated: false,
    })
    expect(result.content).toBeUndefined()
  })

  it('tolerates a missing results array', () => {
    expect(mapStepFunResponse({}).sources).toEqual([])
  })
})

describe('StepFunSearchProvider', () => {
  it('is available when a literal key or a resolver backs a parseable endpoint', () => {
    expect(new StepFunSearchProvider(() => ({ ...options })).available()).toBe(true)
    expect(new StepFunSearchProvider(() => ({ ...options, apiKey: 'sk' })).available()).toBe(true)
    expect(new StepFunSearchProvider(() => ({ baseURL: options.baseURL, numResults: options.numResults })).available()).toBe(false)
    expect(new StepFunSearchProvider(() => ({ ...options, baseURL: 'not a url' })).available()).toBe(false)
    expect(new StepFunSearchProvider(() => ({ ...options, numResults: 0 })).available()).toBe(false)
  })

  it('posts the query with the bearer key and the bound result count', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ results: [{ url: 'https://a.test', title: 'A', snippet: 'one' }] }))
    vi.stubGlobal('fetch', fetchMock)
    const provider = new StepFunSearchProvider(() => ({ ...options }))
    const result = await provider.search({ query: '上海最高的楼', maxResults: 3 })
    expect(result.sources).toEqual([{ url: 'https://a.test', title: 'A', snippet: 'one' }])
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.stepfun.test/search')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test')
    expect(JSON.parse(init.body as string)).toEqual({ query: '上海最高的楼', n: 3 })
  })

  it('falls back to the configured default count when the request carries no bound', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await new StepFunSearchProvider(() => ({ ...options })).search({ query: 'q' })
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ query: 'q', n: 5 })
  })

  it('fails loud when neither a literal key nor the resolver yields one', async () => {
    const provider = new StepFunSearchProvider(() => ({
      baseURL: 'https://api.stepfun.test',
      numResults: 5,
      apiKeyEnv: credentialRef('STEPFUN_API_KEY'),
      resolveApiKey: async () => undefined,
    }))
    await expect(provider.search({ query: 'q' })).rejects.toThrow(/no StepFun API key/)
  })

  it('prefers the literal key over the resolver and reports the reference in diagnostics', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const provider = new StepFunSearchProvider(() => ({
      ...options,
      apiKey: 'sk-literal',
      apiKeyEnv: credentialRef('CUSTOM_KEY'),
    }))
    await provider.search({ query: 'q' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-literal')
    await expect(new StepFunSearchProvider(() => ({
      baseURL: 'https://api.stepfun.test',
      numResults: 5,
      apiKeyEnv: credentialRef('CUSTOM_KEY'),
      resolveApiKey: async () => undefined,
    })).search({ query: 'q' })).rejects.toThrow(/CUSTOM_KEY/)
  })

  it('treats an empty resolved key like a missing one', async () => {
    const provider = new StepFunSearchProvider(() => ({
      baseURL: 'https://api.stepfun.test',
      numResults: 5,
      resolveApiKey: async () => '',
    }))
    await expect(provider.search({ query: 'q' })).rejects.toThrow(/no StepFun API key/)
  })

  it('keeps the status line when an error body carries only blank fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: '  ' }, { status: 403 })))
    await expect(new StepFunSearchProvider(() => ({ ...options })).search({ query: 'q' }))
      .rejects.toThrow('HTTP 403')
  })

  it('maps an error body message into the provider error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'invalid api key' }, { status: 401 })))
    await expect(new StepFunSearchProvider(() => ({ ...options })).search({ query: 'q' }))
      .rejects.toThrow('invalid api key')
  })

  it('maps an alternative error envelope field and keeps the status line otherwise', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'quota exceeded' }, { status: 429 })))
    await expect(new StepFunSearchProvider(() => ({ ...options })).search({ query: 'q' }))
      .rejects.toThrow('quota exceeded')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>gateway</html>', { status: 502 })))
    await expect(new StepFunSearchProvider(() => ({ ...options })).search({ query: 'q' }))
      .rejects.toThrow('HTTP 502')
  })

  it('surfaces network failures as provider errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('dns failure') }))
    await expect(new StepFunSearchProvider(() => ({ ...options })).search({ query: 'q' }))
      .rejects.toThrow('dns failure')
  })

  it('reports an unprocessable success body as a provider error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{not json', { status: 200, headers: { 'content-type': 'application/json' } })))
    await expect(new StepFunSearchProvider(() => ({ ...options })).search({ query: 'q' }))
      .rejects.toThrow('unprocessable response body')
  })

  it('propagates cancellation as WEB_ABORTED', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async () => {
      controller.abort()
      throw new DOMException('The operation was aborted.', 'AbortError')
    }))
    const provider = new StepFunSearchProvider(() => ({ ...options }))
    await expect(provider.search({ query: 'q' }, controller.signal)).rejects.toThrow('aborted')
  })

  it('surfaces aborts during success-body and error-body parse as WEB_ABORTED', async () => {
    const abortBody = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: true, status: 200 }
    vi.stubGlobal('fetch', vi.fn(async () => abortBody as unknown as Response))
    await expect(new StepFunSearchProvider(() => ({ ...options })).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    const abortErrorBody = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: false, status: 500 }
    vi.stubGlobal('fetch', vi.fn(async () => abortErrorBody as unknown as Response))
    await expect(new StepFunSearchProvider(() => ({ ...options })).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })
})

/** A credentials seam answering one stored key, mirroring the local backend. */
function withStoredKey(value: string | undefined) {
  return { resolve: async () => value === undefined ? undefined : { value } }
}

describe('web-search-stepfun plugin', () => {
  it('registers the provider into ctx.web and resolves the key through the credentials seam', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: [{ url: 'https://a.test', snippet: 'one' }] })))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: STEPFUN_SEARCH_PROVIDER_ID })
    ctx.provide('credentials', withStoredKey('sk-stored'))
    apply(ctx, {})
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({
      sources: [{ url: 'https://a.test', snippet: 'one' }],
      truncated: false,
    })
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in stepfunPlugin).toBe(false)
  })

  it('keeps working when the credentials seam is absent and the environment carries the key', async () => {
    const prev = process.env.STEPFUN_API_KEY
    process.env.STEPFUN_API_KEY = 'sk-env'
    try {
      vi.stubGlobal('fetch', vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ results: [] })))
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: STEPFUN_SEARCH_PROVIDER_ID })
      apply(ctx, {})
      await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ sources: [] })
    } finally {
      if (prev === undefined) delete process.env.STEPFUN_API_KEY
      else process.env.STEPFUN_API_KEY = prev
    }
  })

  it('names the credential reference when a search runs without any key', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: STEPFUN_SEARCH_PROVIDER_ID })
    apply(ctx, {})
    // A resolver-backed provider reads as available (the check is local-only),
    // so the keyless deployment surfaces at search time with a diagnostic that
    // names where the key must live.
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    await expect(ctx.web.search({ query: 'q' })).rejects.toThrow(/STEPFUN_API_KEY/)
  })

  it('honors the settings section over the environment endpoint and the composition entry', async () => {
    const prevBase = process.env.STEPFUN_SEARCH_BASE_URL
    const prevKey = process.env.STEPFUN_API_KEY
    process.env.STEPFUN_SEARCH_BASE_URL = 'https://env-search.test'
    delete process.env.STEPFUN_API_KEY
    try {
      vi.stubGlobal('fetch', vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ results: [] })))
      const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ results: [] }))
      vi.stubGlobal('fetch', fetchMock)
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: STEPFUN_SEARCH_PROVIDER_ID })
      ctx.provide('credentials', withStoredKey('sk-stored'))
      apply(ctx, { baseURL: 'https://section.test' })
      await ctx.web.search({ query: 'q' })
      expect(fetchMock.mock.calls[0]?.[0]).toBe('https://section.test/search')
    } finally {
      if (prevBase === undefined) delete process.env.STEPFUN_SEARCH_BASE_URL
      else process.env.STEPFUN_SEARCH_BASE_URL = prevBase
      if (prevKey !== undefined) process.env.STEPFUN_API_KEY = prevKey
    }
  })
})

/** The smallest real provider: one in-memory document, always writable. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

describe('web-search-stepfun settings section', () => {
  async function boot(entry: Record<string, unknown>): Promise<{ ctx: Context; settingsFiber: Fiber; pluginFiber: Fiber }> {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: STEPFUN_SEARCH_PROVIDER_ID })
    const settingsFiber = ctx.plugin(MemorySettings)
    await settingsFiber.await()
    ctx.provide('credentials', withStoredKey('sk-stored'))
    const pluginFiber = ctx.plugin(stepfunPlugin, { apiKey: 'sk-entry', baseURL: 'https://entry.test', ...entry })
    await pluginFiber.await()
    return { ctx, settingsFiber, pluginFiber }
  }

  it('serves a stored key, reference, and endpoint to the next search without re-registering', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const bench = await boot({})
    await bench.ctx.settings.update(WEB_SEARCH_STEPFUN_SETTINGS_NAMESPACE, {
      apiKey: 'sk-stored-secret',
      apiKeyEnv: 'CUSTOM_KEY',
      baseURL: 'https://stored.test',
    })
    await bench.ctx.web.search({ query: 'q' })
    const [url, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit]
    expect(url).toBe('https://stored.test/search')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-stored-secret')
    await bench.ctx.fiber.dispose()
  })
})
