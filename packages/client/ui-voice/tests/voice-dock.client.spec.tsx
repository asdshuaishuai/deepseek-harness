// @vitest-environment jsdom
/** VoiceDock view states over a scripted controller face. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VoiceDock } from '../src/client/VoiceDock.tsx'
import type { VoiceControllerFace, VoiceView } from '../src/client/voice-controller.ts'
import { zh } from '../src/client/locales.ts'

function controllerFace(phase: VoiceView['phase'], overrides: Partial<VoiceView> = {}): VoiceControllerFace {
  const view: VoiceView = {
    phase,
    realtimeModel: 'stepaudio-2.5-realtime',
    sessionId: 'session-1',
    userText: '',
    assistantText: '',
    error: undefined,
    ...overrides,
  }
  return {
    subscribe: () => () => {},
    getSnapshot: () => view,
    toggle: vi.fn(),
    stopConversation: vi.fn(),
    commit: vi.fn(),
  }
}

const t = (key: VoiceView extends never ? never : keyof typeof zh): string => {
  const table: Record<string, string> = {
    'dock.mic.label': zh['dock.mic.label'],
    'dock.stop.label': zh['dock.stop.label'],
    'state.idle': zh['state.idle'],
    'state.listening': zh['state.listening'],
    'state.thinking': zh['state.thinking'],
    'state.speaking': zh['state.speaking'],
    'captions.empty': zh['captions.empty'],
    'model.pinned': zh['model.pinned'],
    'error.prefix': zh['error.prefix'],
  }
  return table[key] ?? key
}

afterEach(cleanup)

describe('VoiceDock', () => {
  it('renders the mic toggle idle with no strip', () => {
    render(<VoiceDock controller={controllerFace('idle')} sessionId="session-1" t={t as never} />)
    const button = screen.getByRole('button', { name: zh['dock.mic.label'] })
    expect(button).toBeTruthy()
    expect(screen.queryByText(zh['state.listening'])).toBeNull()
  })

  it('toggles the loop through the controller on click', () => {
    const face = controllerFace('idle')
    render(<VoiceDock controller={face} sessionId="session-1" t={t as never} />)
    fireEvent.click(screen.getByRole('button'))
    expect(face.toggle).toHaveBeenCalledWith('session-1')
  })

  it('shows the phase, pinned model, and captions while speaking', () => {
    render(<VoiceDock controller={controllerFace('speaking', {
      assistantText: '答案文本',
      userText: '问题文本',
    })} sessionId="session-1" t={t as never} />)
    expect(screen.getByText(zh['state.speaking'])).toBeTruthy()
    expect(screen.getByText('答案文本')).toBeTruthy()
    expect(screen.getByText('stepaudio-2.5-realtime')).toBeTruthy()
  })

  it('shows the user transcript when no answer text exists', () => {
    render(<VoiceDock controller={controllerFace('thinking', { userText: '问题' })} sessionId="session-1" t={t as never} />)
    expect(screen.getByText('问题')).toBeTruthy()
  })

  it('shows the empty-caption hint when nothing has been said', () => {
    render(<VoiceDock controller={controllerFace('listening')} sessionId="session-1" t={t as never} />)
    expect(screen.getByText(zh['captions.empty'])).toBeTruthy()
  })

  it('surfaces errors beside the captions', () => {
    render(<VoiceDock controller={controllerFace('listening', { error: 'no STEPFUN_API_KEY' })} sessionId="session-1" t={t as never} />)
    expect(screen.getByText(/no STEPFUN_API_KEY/)).toBeTruthy()
  })

  it('routes the stop click through the controller toggle while bound', () => {
    const face = controllerFace('speaking')
    render(<VoiceDock controller={face} sessionId="session-1" t={t as never} />)
    fireEvent.click(screen.getByRole('button', { name: zh['dock.stop.label'] }))
    // While speaking the mic button acts as stop: the controller toggle owns
    // the routing (speaking → stopConversation).
    expect(face.toggle).toHaveBeenCalledWith('session-1')
  })
})
