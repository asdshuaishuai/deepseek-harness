/** The node half: ui-voice registers the dock slot and locale dictionaries. */
import { describe, expect, it, vi } from 'vitest'
import { apply as nodeApply } from '../src/index.ts'
import { apply } from '../src/client/index.ts'

function ctxWith() {
  const dockRegistrations: Array<{ name: string; id: string; order: number; inject: unknown }> = []
  const locales: Array<[string, unknown]> = []
  const effects: Array<() => unknown> = []
  const ctx = {
    slots: {
      register: (registration: { name: string; id: string; order: number; inject: unknown }) => registration,
      inject: (name: string, register: () => unknown) => {
        dockRegistrations.push(register() as { name: string; id: string; order: number; inject: unknown })
        void name
      },
    },
    locale: {
      register: (ns: string, dict: unknown) => { locales.push([ns, dict]) },
      t: (_ns: string, key: string) => key,
    },
    effect: (fn: () => unknown) => { effects.push(fn) },
    uiConversation: { events: { register: vi.fn() } },
  }
  return { ctx: ctx as never, dockRegistrations, locales, effects }
}

describe('ui-voice node half', () => {
  it('registers the voice dock in the input strip and the locale dictionaries', () => {
    const { ctx, dockRegistrations, locales, effects } = ctxWith()
    apply(ctx)
    for (const effect of effects) effect()
    // The dock's per-session inject face binds a lazily created controller.
    ;(globalThis as { window?: unknown }).window = { location: { protocol: 'https:', host: 'host.test' } }
    const face = dockRegistrations[0]?.inject as (sessionId: string) => {
      controller: { getSnapshot: () => { phase: string } }
      sessionId: string
    }
    const face0 = face('session-1')
    expect(face0.sessionId).toBe('session-1')
    expect(face0.controller.getSnapshot().phase).toBe('idle')
    expect(dockRegistrations).toMatchObject([{ name: 'conversation.input.dock', id: 'voice', order: 20 }])
    const dictionaryShape = { en: expect.any(Object) as object, zh: expect.any(Object) as object }
    expect(locales).toEqual([['voice', expect.objectContaining(dictionaryShape)]])
  })

  it('node half is a pure surface plugin with no host behavior', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})
