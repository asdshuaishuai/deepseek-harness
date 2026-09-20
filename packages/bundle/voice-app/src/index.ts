/**
 * @deepseek-ai/dsh-voice-app — the duplex voice runner. The bundle patch rides
 * over dsh-base without Host, HTTP, or browser plugins; this runner binds one
 * StepAudio 3 Realtime session to one Agent through `ctx.voiceAgent` and
 * speaks the JSON-frame bridge: microphone frames arrive as JSON lines on
 * stdin, conversation events leave as JSON lines on stdout, and captions
 * mirror to stderr. The process owning the audio devices (an ffmpeg wrapper,
 * a native app, a web frontend) drives the actual capture and playback.
 *
 * @module @deepseek-ai/dsh-voice-app
 */

import type { Context } from '@deepseek-ai/cordis'
import type { VoiceStartupValues } from './startup.ts'
import { bridgeEvents, bridgeLine, bridgeStdin } from './stdio-bridge.ts'

/** Stable Cordis plugin name. */
export const name = 'voice-runner'

/** Services required before the conversation can start. */
export const inject = ['voiceAgent', 'voiceStartup']

/**
 * Mount the voice runner.
 * @param ctx - plugin context carrying the conversation service and run options.
 */
export function apply(ctx: Context): void {
  const startup = ctx.get('voiceStartup') as VoiceStartupValues | undefined
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('voice-runner: the launcher must provide ctx.appExit before the tree mounts')
  }
  if (startup === undefined) return
  void run(ctx, startup, (code) => { exit(code) }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`dsh: ${message}\n`)
    process.stdout.write(`${JSON.stringify({ type: 'error', message })}\n`)
    exit(1)
  })
}

/**
 * Run one voice conversation end to end over the stdio bridge: events flow out
 * as JSON lines, stdin frames flow into the conversation, and the run ends
 * when stdin closes or the launcher interrupts.
 * @param ctx - plugin context carrying the conversation service.
 * @param startup - parsed run options.
 * @param exit - the launcher's bounded exit request.
 */
async function run(ctx: Context, startup: VoiceStartupValues, exit: (code: number) => void): Promise<void> {
  const voiceAgent = ctx.get('voiceAgent')
  if (voiceAgent === undefined) throw new Error('voice-runner: the voiceAgent service is required')

  const conversation = await voiceAgent.createConversation(
    { ...startup.sessionId === undefined ? {} : { sessionId: startup.sessionId } },
    bridgeEvents((chunk) => { process.stdout.write(chunk) }),
  )
  // Captions mirror to stderr so the driver process keeps stdout a clean JSON
  // stream; the `ready` event below carries the durable session identity and
  // the effective realtime model (the channel-resolved id).
  const realtime = ctx.get('stepfunRealtime')
  process.stderr.write(`dsh: voice session ${String(conversation.id)}\n`)
  process.stdout.write(bridgeLine({
    type: 'ready',
    sessionId: String(conversation.id),
    ...realtime === undefined ? {} : { realtimeModel: realtime.options.model },
  }))
  await bridgeStdin(conversation, process.stdin as AsyncIterable<Buffer>)
  await conversation.close()
  exit(0)
}
