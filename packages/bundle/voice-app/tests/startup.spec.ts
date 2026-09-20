/**
 * Startup parsing: the voice profile's own flag family, including the Step
 * Plan channel switch and the realtime model override.
 *
 * @module dsh-voice-app/startup.spec
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import * as voiceStartup from '../src/startup.ts'
import { VOICE_STARTUP_SERVICE, type VoiceStartupValues } from '../src/startup.ts'

async function parseStartup(args: readonly string[]): Promise<VoiceStartupValues | undefined> {
  const ctx = new Context()
  let exitCode: number | undefined
  provideCmdline(ctx, { args, exit: (code) => { exitCode = code } })
  await ctx.plugin(voiceStartup)
  const values = ctx.get(VOICE_STARTUP_SERVICE) as VoiceStartupValues | undefined
  await ctx.fiber.dispose()
  return exitCode === 0 || exitCode === undefined ? values : undefined
}

describe('voice-startup options', () => {
  it('defaults to the standard channel with no model override', async () => {
    await expect(parseStartup([])).resolves.toEqual({
      sessionId: undefined,
      voice: undefined,
      stepPlan: false,
      realtimeModel: undefined,
    })
  })

  it('carries --step-plan, --realtime-model, --voice, and --session-id together', async () => {
    await expect(parseStartup([
      '--step-plan',
      '--realtime-model', 'stepaudio-2.5-realtime',
      '--voice', 'tongtong',
      '--session-id', 'session-42',
    ])).resolves.toEqual({
      sessionId: 'session-42',
      voice: 'tongtong',
      stepPlan: true,
      realtimeModel: 'stepaudio-2.5-realtime',
    })
  })

  it('rejects a blank --realtime-model', async () => {
    await expect(parseStartup(['--realtime-model', '  '])).resolves.toBeUndefined()
  })
})
