/** apply() unit coverage: route registration, missing-connection shutdown, and the upgrade gate. */
import { describe, expect, it, vi } from 'vitest'
import { apply, VOICE_BRIDGE_PATH } from '../src/index.ts'

function ctxWith(connection: unknown) {
  const upgrades: Array<{ path: string; handler: (req: unknown, socket: unknown, head: Buffer) => void }> = []
  const effects: Array<() => unknown> = []
  const ctx = {
    webServer: { registerUpgrade: (route: { path: string; handler: (req: unknown, socket: unknown, head: Buffer) => void }) => {
      upgrades.push(route)
      return () => {}
    } },
    connection,
    voiceAgent: { createConversation: () => Promise.reject(new Error('unused')) },
    stepfunRealtime: { options: { model: 'stepaudio-2.5-realtime' } },
    logger: { warn: vi.fn(), info: vi.fn() },
    effect: (fn: () => unknown) => { effects.push(fn) },
  }
  return { ctx: ctx as never, upgrades, effects }
}

describe('apply', () => {
  it('registers the /voice upgrade route', () => {
    const { ctx, upgrades } = ctxWith({ requestRejection: () => undefined })
    apply(ctx, {})
    expect(upgrades).toHaveLength(1)
    expect(upgrades[0]?.path).toBe(VOICE_BRIDGE_PATH)
  })

  it('shuts the route down when the connection service is absent', () => {
    const { ctx, upgrades } = ctxWith(undefined)
    apply(ctx, {})
    expect(upgrades).toEqual([])
  })

  it('rejects upgrades with 401 when the trust plane says so', () => {
    const { ctx, upgrades } = ctxWith({ requestRejection: () => 401 })
    apply(ctx, {})
    const writes: string[] = []
    const destroyed: boolean[] = []
    const socket = {
      write: (frame: string) => { writes.push(frame) },
      destroy: () => { destroyed.push(true) },
    }
    upgrades[0]?.handler({ headers: {} }, socket, Buffer.alloc(0))
    expect(writes.some(frame => frame.startsWith('HTTP/1.1 401'))).toBe(true)
    expect(destroyed).toEqual([true])
  })
})
