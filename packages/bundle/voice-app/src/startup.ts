/**
 * The voice app's command-line provider: it parses `--session-id`, `--voice`,
 * `--step-plan`, `--realtime-model`, and `--help`, then publishes
 * {@link VOICE_STARTUP_SERVICE}. The runner is an ordinary consumer whose
 * lazy config waits for that service.
 *
 * @module @deepseek-ai/dsh-voice-app/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'voice-startup'

/** Services required before the run options can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this plugin and injected by the runner and adapters. */
export const VOICE_STARTUP_SERVICE = 'voiceStartup'

/** What the runner rows read from {@link VOICE_STARTUP_SERVICE}. */
export interface VoiceStartupValues {
  /** Exact Session identity to adopt; absent for a fresh random identity. */
  sessionId: string | undefined
  /** Voice the model speaks with; the platform default applies when omitted. */
  voice: string | undefined
  /**
   * Run the whole voice profile on the Step Plan subscription channel: the
   * agent's chat requests and the realtime session both switch endpoints
   * (and the realtime model becomes the plan-supported id).
   */
  stepPlan: boolean
  /**
   * Explicit realtime model id over the channel default; e.g.
   * `stepaudio-2.5-realtime` under a Step Plan subscription.
   */
  realtimeModel: string | undefined
  /** `false` disables the Codex-style task acknowledgement; absent keeps it. */
  ack: false | undefined
}

/**
 * This app's command: its options and help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function voiceCommand(): Command {
  return new Command()
    .name('dsh --profile voice')
    .description('Hold a duplex voice conversation over the stdio JSON-frame bridge.')
    .helpOption('-h, --help', 'show this help')
    .option('--session-id <id>', 'adopt the persisted Session with this id; an unknown id is an error')
    .option('--voice <name>', 'voice the model speaks with')
    .option('--step-plan', 'run on the Step Plan subscription channel (chat and realtime endpoints)')
    .option('--realtime-model <id>', 'realtime model id over the channel default')
    .option('--no-ack', 'do not speak a short acknowledgement when a task is accepted')
    .addHelpText('after', `
The bridge speaks newline-delimited JSON on stdin and stdout. Send frames in:
  {"audio":"<base64 PCM16 16 kHz mono>"}   append one microphone frame
  {"commit":true}                          force the utterance boundary
Receive events out: ready, state, user-transcript, assistant-delta,
assistant-final, audio (base64 PCM16 24 kHz mono), error, closed.

Wrap it with the process that owns the audio devices; ffmpeg captures the
microphone as raw PCM16 16 kHz mono and plays answers at 24 kHz mono:
  ffmpeg -f avfoundation -i ":0" -f s16le -ar 16000 -ac 1 pipe:1
  ffplay -nodisp -autoexit -f s16le -ar 24000 -ac 1 -i pipe:0

Examples:
  dsh --profile voice                          bridge on stdin/stdout
  dsh --profile voice --voice tongtong         pick the speaking voice
  dsh --profile voice --step-plan              Step Plan channel endpoints
  dsh --profile voice --realtime-model stepaudio-2.5-realtime
  dsh --profile voice --session-id session-…   resume an existing Session
`)
}

/**
 * Parse and provide the run options as an ordinary Cordis service.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = voiceCommand()
  program.action(() => {
    const options = program.opts<{ sessionId?: string; voice?: string; stepPlan?: boolean; realtimeModel?: string; ack?: boolean }>()
    const sessionId = options.sessionId
    if (sessionId !== undefined && sessionId.trim() === '') {
      program.error('error: --session-id requires a non-empty session id')
    }
    const realtimeModel = options.realtimeModel
    if (realtimeModel !== undefined && realtimeModel.trim() === '') {
      program.error('error: --realtime-model requires a non-empty model id')
    }
    ctx.provide(VOICE_STARTUP_SERVICE, {
      sessionId,
      voice: options.voice,
      stepPlan: options.stepPlan === true,
      realtimeModel,
      // commander's --no-ack flag yields ack === false only when passed.
      ack: options.ack === false ? false : undefined,
    } satisfies VoiceStartupValues)
  })
  parseCmdline(ctx, program)
}
