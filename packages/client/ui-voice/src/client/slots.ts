/** Injected face for the voice dock (controller + locale namespace). */
import type { VoiceController, VoiceControllerFace } from './voice-controller.ts'
import type { VoiceKey } from './locales.ts'

export type { VoiceControllerFace, VoiceKey }

export interface VoiceDockInjected {
  controller: VoiceController
  t: (key: VoiceKey) => string
}
