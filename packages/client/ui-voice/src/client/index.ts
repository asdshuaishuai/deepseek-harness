/**
 * Voice surface plugin, browser half: the mic toggle in the input dock strip
 * bound to the process-local voice controller. The controller owns the
 * /voice socket, the microphone capture, and answer playback; the durable
 * session id and the pinned realtime model arrive from the host bridge.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the renderer-owned slots service (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the conversation input-dock slot.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { createVoiceController } from './voice-controller.ts'
import type { VoiceController, VoiceControllerFace } from './voice-controller.ts'
import { VoiceDock } from './VoiceDock.tsx'
import { en, zh, type VoiceKey } from './locales.ts'

export { VoiceDock } from './VoiceDock.tsx'
export { VoiceController, createVoiceController } from './voice-controller.ts'
export { VoiceSocket, voiceUrl } from './voice-socket.ts'
export * from './voice-codec.ts'
export type { VoiceKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The voice dock's copy. */
    voice: VoiceKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'voice'

/** Required services for the voice dock. */
export const inject = ['slots', 'sessions', 'locale', 'uiConversation']

/** The process-local controller: one per browser tab. */
let controller: VoiceController | undefined

/** Client plugin body: locale dictionaries and the input-dock mic toggle. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-voice: dictionaries')

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'voice',
    order: 20,
    locale: NS,
    inject: (sessionId: SessionId): { controller: VoiceControllerFace; sessionId: SessionId } => {
      controller ??= createVoiceController()
      return {
        controller,
        sessionId,
      }
    },
  }, VoiceDock))
}
