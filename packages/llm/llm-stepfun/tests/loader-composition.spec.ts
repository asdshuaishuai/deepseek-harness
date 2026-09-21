/**
 * Real-composition guard: LlmRuntime, settings-file, credentials-local, and
 * llm-stepfun boot from a test-only cordis.yml through the actual Loader +
 * Include path, the advertised catalog follows an external settings edit into
 * the Step Plan channel, an invalid snapshot keeps the last good facts, and a
 * keyless request fails `MISSING_CREDENTIAL` before any network I/O.
 *
 * Unlike the upstream llm-deepseek composition suite this fork's URL guard
 * rejects loopback endpoints, so there is no local mock server: wire-level
 * behavior is covered by the unit protocol suites, and this file owns the
 * boot, registration, settings, credential, and fail-loud surfaces.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { LlmError, createUserMessage } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import * as LlmStepFun from '../src/index.ts'

const PROVIDER = 'stepfun-official'
const NS = 'llm-stepfun'
const KEY_REF = credentialRef('STEPFUN_API_KEY')

const STANDARD_CATALOG = ['step-5-preview', 'step-3']
const PLAN_CATALOG = ['step-5-preview', 'step-3.7-flash', 'step-3.5-flash', 'step-3.5-flash-2603', 'step-router-v1']

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllEnvs()
})

async function loadComposition(
  rows: readonly string[],
): Promise<{ ctx: Context; settingsPath: string; credentialsPath: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-stepfun-composition-'))
  vi.stubEnv('DSH_HOME', root)
  const settingsPath = join(root, 'settings.yaml')
  const credentialsPath = join(root, '.credentials.yaml')
  await writeFile(settingsPath, '# personal settings\n')
  await writeFile(credentialsPath, 'version: 1\nrefs: {}\n', { mode: 0o600 })

  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, rows
    .map(row => row
      .replace('"SETTINGS_PATH"', JSON.stringify(settingsPath))
      .replace('"CREDENTIALS_PATH"', JSON.stringify(credentialsPath)))
    .join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-settings-file', FileSettingsProvider],
    ['@deepseek-ai/dsh-credentials-local', LocalCredentialProvider],
    ['@deepseek-ai/dsh-llm-stepfun', LlmStepFun],
  ])
  // The custom importer bypasses Node resolution; mirror the package manifests
  // a deployed cordis.yml has beside its declared dependencies.
  await Promise.all([...modules.keys()].map(async (packageName) => {
    const packageDir = join(root!, 'node_modules', ...packageName.split('/'))
    await mkdir(packageDir, { recursive: true })
    await writeFile(join(packageDir, 'package.json'), `${JSON.stringify({ name: packageName, version: '0.1.0', type: 'module' })}\n`)
  }))
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await ctx.loader.await()
  return { ctx, settingsPath, credentialsPath }
}

const DYNAMIC_ROWS = [
  '- id: llm',
  "  name: '@deepseek-ai/dsh-llm'",
  '- id: settings',
  "  name: '@deepseek-ai/dsh-settings-file'",
  '  config:',
  '    path: "SETTINGS_PATH"',
  '    debounceMs: 10',
  '- id: credentials',
  "  name: '@deepseek-ai/dsh-credentials-local'",
  '  config:',
  '    path: "CREDENTIALS_PATH"',
  '    debounceMs: 10',
  '- id: llm-stepfun',
  "  name: '@deepseek-ai/dsh-llm-stepfun'",
] as const

describe('llm-stepfun real composition', () => {
  it('boots from cordis.yml on entry config alone and advertises the standard catalog', async () => {
    vi.stubEnv('STEPFUN_API_KEY', '')
    const { ctx } = await loadComposition([
      '- id: llm',
      "  name: '@deepseek-ai/dsh-llm'",
      '- id: llm-stepfun',
      "  name: '@deepseek-ai/dsh-llm-stepfun'",
    ])
    expect(ctx.get('settings')).toBeUndefined()
    expect(ctx.get('credentials')).toBeUndefined()
    expect(ctx.llm.listProviders().some(entry => entry.id === PROVIDER)).toBe(true)
    expect(await ctx.llm.listModels(PROVIDER)).toEqual([
      expect.objectContaining({ provider: PROVIDER, id: 'step-5-preview', inputModalities: ['text', 'image'] }),
      expect.objectContaining({ provider: PROVIDER, id: 'step-3' }),
    ])
  })

  it('follows an external settings edit into the Step Plan channel, then keeps the last good facts on an invalid snapshot', { timeout: 20_000 }, async () => {
    vi.stubEnv('STEPFUN_API_KEY', '')
    const { ctx, settingsPath } = await loadComposition(DYNAMIC_ROWS)
    expect(ctx.get('settings')!.describe().map(entry => entry.ns)).toEqual([NS])
    expect((await ctx.llm.listModels(PROVIDER)).map(model => model.id)).toEqual(STANDARD_CATALOG)

    // External edit, exactly as a user or the web UI would leave it on disk.
    await writeFile(settingsPath, 'llm-stepfun:\n  channel: step-plan\n')
    await vi.waitFor(() => {
      expect((ctx.get('settings')!.get(NS) as { channel?: string }).channel).toBe('step-plan')
    }, { timeout: 5000 })
    await vi.waitFor(async () => {
      expect((await ctx.llm.listModels(PROVIDER)).map(model => model.id)).toEqual(PLAN_CATALOG)
    }, { timeout: 5000 })

    // Schema-valid but beyond-bounds: the adapter keeps serving the plan facts.
    await writeFile(settingsPath, 'llm-stepfun:\n  channel: step-plan\n  imageOffloadByteQuantum: 100\n  maxRequestImageBytes: 10\n')
    await vi.waitFor(() => {
      expect((ctx.get('settings')!.get(NS) as { imageOffloadByteQuantum?: number }).imageOffloadByteQuantum).toBe(100)
    }, { timeout: 5000 })
    await expect(ctx.llm.listModels(PROVIDER)).resolves.toHaveLength(PLAN_CATALOG.length)
  })

  it('fails a keyless request with MISSING_CREDENTIAL before any network I/O', async () => {
    vi.stubEnv('STEPFUN_API_KEY', '')
    const { ctx } = await loadComposition(DYNAMIC_ROWS)
    // The runtime normalizes an adapter throw into a terminal finish chunk.
    let finish: unknown
    for await (const chunk of ctx.llm.stream({
      provider: PROVIDER,
      model: 'step-5-preview',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })],
    })) {
      if (typeof chunk === 'object' && chunk !== null && 'reason' in chunk) finish = chunk
    }
    expect(finish).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
    const failure = (finish as { reason: { kind: string; failure?: { code?: string } } }).reason.failure
    expect(failure?.code).toBe('MISSING_CREDENTIAL')
  })

  it('resolves the request credential from the managed document after a UI-style store', async () => {
    vi.stubEnv('STEPFUN_API_KEY', '')
    const { ctx } = await loadComposition(DYNAMIC_ROWS)
    await ctx.get('credentials')!.set(KEY_REF, 'stored-by-ui')
    await expect(ctx.get('credentials')!.resolve(KEY_REF)).resolves.toEqual({
      value: 'stored-by-ui',
      source: 'file',
    })
  })

  it('refuses to register the provider on a loopback endpoint', async () => {
    vi.stubEnv('STEPFUN_API_KEY', '')
    // The loader boot settles even when a row's apply throws; the observable
    // is the rolled-back registration: the guard keeps the route absent.
    const { ctx } = await loadComposition([
      '- id: llm',
      "  name: '@deepseek-ai/dsh-llm'",
      '- id: llm-stepfun',
      "  name: '@deepseek-ai/dsh-llm-stepfun'",
      '  config:',
      '    baseURL: http://127.0.0.1:9420/v1',
    ])
    expect(ctx.llm.listProviders().some(entry => entry.id === PROVIDER)).toBe(false)
    const failure = await ctx.llm.listModels(PROVIDER).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(LlmError)
    expect((failure as LlmError).code).toBe('NO_ADAPTER')
  })
})
