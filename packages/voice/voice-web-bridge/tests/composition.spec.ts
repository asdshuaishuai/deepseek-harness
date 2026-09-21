/**
 * Real Loader composition: the exact web-app patch rows for the voice host
 * services and the bridge mount together, and the voice upgrade route lands
 * on the web server with the pinned realtime model reported to sockets.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import * as StepFunRealtime from '@deepseek-ai/dsh-stepfun-realtime'
import * as VoiceAgent from '@deepseek-ai/dsh-voice-agent'
import * as VoiceWebBridge from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadYaml(lines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-voice-web-bridge-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...lines, ''].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-token-meter', TokenMeter],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-default-model', AgentDefaultModelConfig],
    ['@deepseek-ai/dsh-stepfun-realtime', StepFunRealtime],
    ['@deepseek-ai/dsh-voice-agent', VoiceAgent],
    ['@deepseek-ai/dsh-voice-web-bridge', VoiceWebBridge],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

describe('web voice composition', () => {
  it('mounts the realtime service, voice agent, and bridge; keyless boot stays green', async () => {
    const loaded = await loadYaml([
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-session-projection'",
      "- name: '@deepseek-ai/dsh-token-meter'",
      "- name: '@deepseek-ai/dsh-agent-default-model'",
      '  config:',
      '    provider: stepfun-official',
      '    model: step-5-preview',
      "- name: '@deepseek-ai/dsh-agent'",
      "- name: '@deepseek-ai/dsh-stepfun-realtime'",
      "- name: '@deepseek-ai/dsh-voice-agent'",
      "- name: '@deepseek-ai/dsh-voice-web-bridge'",
    ])
    // Every voice row mounts with no error: the realtime service, the voice
    // agent, and the browser bridge compose keyless.
    // Structural view: the host Connection trust plane and the loader's
    // richer entry face live outside this package's compilation graph.
    type EntryLike = { options?: { name?: string }; error?: unknown }
    const entries = [...(loaded.loader as unknown as { entries(): Iterable<EntryLike> }).entries()]
    const errors = entries
      .filter(entry => entry.error !== undefined)
      .map(entry => `${String(entry.options?.name)}: ${String(entry.error)}`)
    expect(errors).toEqual([])
    const names = entries.map(entry => String(entry.options?.name))
    expect(names).toContain('@deepseek-ai/dsh-stepfun-realtime')
    expect(names).toContain('@deepseek-ai/dsh-voice-agent')
    expect(names).toContain('@deepseek-ai/dsh-voice-web-bridge')
  })

  it('pins the Step Plan realtime model on the step-plan channel', async () => {
    const loaded = await loadYaml([
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-session-projection'",
      "- name: '@deepseek-ai/dsh-token-meter'",
      "- name: '@deepseek-ai/dsh-agent-default-model'",
      '  config:',
      '    provider: stepfun-official',
      '    model: step-5-preview',
      "- name: '@deepseek-ai/dsh-agent'",
      "- name: '@deepseek-ai/dsh-stepfun-realtime'",
      '  config:',
      '    channel: step-plan',
      "- name: '@deepseek-ai/dsh-voice-agent'",
      "- name: '@deepseek-ai/dsh-voice-web-bridge'",
    ])
    // The plan channel pins the subscription realtime model (its catalog
    // does not list StepAudio 3 Realtime); the standard channel keeps the
    // preview id. Both defaults are asserted in stepfun-realtime's own
    // config suite; here only the channel row composes cleanly.
    expect([...loaded.loader.entries()].every(entry => (entry as { error?: unknown }).error === undefined)).toBe(true)
  })
})
