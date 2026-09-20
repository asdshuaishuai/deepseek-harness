import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import {
  PUBLIC_SEARCH_MCP_URL,
  apply,
  buildSearchMcpConfig,
  resolveSearchApiKey,
  resolveSearchOptions,
} from '../src/index.ts'

/** A trusted-layer snapshot carrying only what each test supplies. */
function environment(values: Record<string, string> = {}): LaunchEnvironmentSnapshot {
  return {
    get: name => name in values ? { value: values[name] ?? '', source: 'process' } : undefined,
    getFrom: () => undefined,
  }
}

describe('resolveSearchOptions', () => {
  it('defaults to the public StepSearch endpoint and namespace', () => {
    const resolved = resolveSearchOptions({}, environment())
    expect(resolved.url).toBe(PUBLIC_SEARCH_MCP_URL)
    expect(resolved.serverName).toBe('stepfun-search')
    expect(resolved.apiKeyEnv).toBe(credentialRef('STEPFUN_API_KEY'))
    expect(resolved.toolCallTimeoutMs).toBe(60_000)
    expect(resolved.failOnStartupError).toBe(false)
  })

  it('honors the environment endpoint over the public default', () => {
    const resolved = resolveSearchOptions({}, environment({ STEPFUN_SEARCH_MCP_URL: 'https://mcp.example.com/sse' }))
    expect(resolved.url).toBe('https://mcp.example.com/sse')
  })

  it('rejects non-public endpoints: loopback, private, and wrong scheme', () => {
    expect(() => resolveSearchOptions({ url: 'http://127.0.0.1:9420/mcp' }, environment()))
      .toThrow(/loopback, private, or reserved/)
    expect(() => resolveSearchOptions({ url: 'http://10.1.2.3/mcp' }, environment()))
      .toThrow(/loopback, private, or reserved/)
    expect(() => resolveSearchOptions({ url: 'wss://mcp.example.com' }, environment())).toThrow()
  })

  it('rejects server names that break the tool-name budget', () => {
    expect(() => resolveSearchOptions({ serverName: 'has spaces' }, environment())).toThrow(/serverName/)
    expect(() => resolveSearchOptions({ serverName: `x${'y'.repeat(32)}` }, environment())).toThrow(/serverName/)
  })

  it('rejects out-of-range timeouts', () => {
    expect(() => resolveSearchOptions({ toolCallTimeoutMs: 0 }, environment())).toThrow(/toolCallTimeoutMs/)
    expect(() => resolveSearchOptions({ toolCallTimeoutMs: Number.POSITIVE_INFINITY }, environment()))
      .toThrow(/toolCallTimeoutMs/)
  })
})

describe('resolveSearchApiKey', () => {
  const ref = credentialRef('STEPFUN_API_KEY')
  /** A test-only reference: values under real key names stay out of fixtures. */
  const ambientRef = credentialRef('TEST_AMBIENT_KEY')

  it('prefers the credentials service, then the environment', async () => {
    const store = { resolve: async () => ({ value: 'managed-key' }) }
    await expect(resolveSearchApiKey(ref, store as never, environment())).resolves.toBe('managed-key')
    await expect(resolveSearchApiKey(ambientRef, undefined, environment({ TEST_AMBIENT_KEY: 'ambient-key' })))
      .resolves.toBe('ambient-key')
  })

  it('returns undefined when nothing stores a key', async () => {
    await expect(resolveSearchApiKey(ref, undefined, environment())).resolves.toBeUndefined()
    const blank = { resolve: async () => ({ value: '' }) }
    await expect(resolveSearchApiKey(ref, blank as never, environment())).resolves.toBeUndefined()
  })
})

describe('buildSearchMcpConfig', () => {
  it('shapes a complete streamable-http mount with the bearer header', () => {
    const resolved = resolveSearchOptions(
      { serverName: 'search', toolCallTimeoutMs: 5_000, failOnStartupError: true },
      environment(),
    )
    expect(buildSearchMcpConfig(resolved, 'the-key')).toEqual({
      transport: 'streamable-http',
      serverName: 'search',
      url: PUBLIC_SEARCH_MCP_URL,
      headers: { Authorization: 'Bearer the-key' },
      toolCallTimeoutMs: 5_000,
      failOnStartupError: true,
    })
  })
})

describe('apply', () => {
  it('stays quietly unmounted when no key is stored anywhere', async () => {
    const ctx = new Context()
    const warnings: string[] = []
    ctx.logger.warn = ((message: string, ...args: unknown[]) => {
      warnings.push([message, ...args.map(arg => String(arg))].join(' '))
    }) as typeof ctx.logger.warn
    await apply(ctx, {})
    expect(warnings.join('\n')).toContain('StepSearch tools stay unmounted')
    await ctx.fiber.dispose()
  })
})
