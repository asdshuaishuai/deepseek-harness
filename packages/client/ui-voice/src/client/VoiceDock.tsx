/**
 * VoiceDock: the microphone entry in the input dock strip. Idle shows a mic
 * button; active shows the phase, the pinned realtime model, the running
 * transcripts, and the caption line. All voice plumbing lives behind the
 * injected controller so the dock stays a pure view.
 */

import { useSyncExternalStore, type ReactNode } from 'react'
import { IconMicOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { VoiceController, VoiceControllerFace, VoiceView } from './voice-controller.ts'
import type { VoiceKey } from './locales.ts'
import css from './VoiceDock.module.css'

export type { VoiceControllerFace }

export interface VoiceDockInjected {
  controller: VoiceController | VoiceControllerFace
}

export type VoiceDockProps = InjectFace<{ controller: VoiceController | VoiceControllerFace }>
  & PropsLocale<'voice'>
  & { sessionId?: string | undefined }

/** The phase chip label keys. */
const PHASE_KEYS: Record<VoiceView['phase'], VoiceKey> = {
  idle: 'state.idle',
  listening: 'state.listening',
  thinking: 'state.thinking',
  speaking: 'state.speaking',
}

/**
 * Render the voice dock: a mic toggle plus, while active, the phase chip,
 * the pinned realtime model, and the live caption line.
 */
export function VoiceDock(props: VoiceDockProps): ReactNode {
  const { controller, sessionId, t } = props
  const view = useSyncExternalStore(
    listener => controller.subscribe(listener),
    () => controller.getSnapshot(),
  )
  const active = view.phase !== 'idle'

  return (
    <div className={css.root}>
      <button
        type="button"
        className={active ? `${css.mic} ${css.micActive}` : css.mic}
        aria-label={active ? t('dock.stop.label') : t('dock.mic.label')}
        title={active ? t('dock.stop.label') : t('dock.mic.label')}
        onClick={() =>{  controller.toggle(sessionId) }}
      >
        <IconMicOutline16 />
      </button>
      {active && (
        <div className={css.strip}>
          <span className={css.phase}>{t(PHASE_KEYS[view.phase])}</span>
          {view.realtimeModel !== undefined && (
            <span className={css.model}>{view.realtimeModel}</span>
          )}
          <span className={css.caption}>
            {view.assistantText !== '' ? view.assistantText
              : view.userText !== '' ? view.userText
                : t('captions.empty')}
          </span>
          {view.error !== undefined && (
            <span className={css.error}>{`${t('error.prefix')}: ${view.error}`}</span>
          )}
        </div>
      )}
    </div>
  )
}
