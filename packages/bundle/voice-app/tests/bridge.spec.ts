/** The stdio JSON-frame bridge: line parsing and post-drop stdin tolerance. */
import { describe, expect, it } from 'vitest'
import type { VoiceConversation } from '@deepseek-ai/dsh-voice-agent'
import { bridgeLine, bridgeStdin, parseBridgeLine } from '../src/stdio-bridge.ts'

describe('parseBridgeLine', () => {
  it('decodes audio and commit frames', () => {
    expect(parseBridgeLine('{"audio":"QUJD"}')).toEqual({ audio: 'QUJD' })
    expect(parseBridgeLine('{"commit":true}')).toEqual({ commit: true })
  })

  it('treats blank lines as heartbeats and malformed lines as skips', () => {
    expect(parseBridgeLine('   ')).toBeUndefined()
    expect(parseBridgeLine('{not json')).toBeUndefined()
  })

  it('round-trips through bridgeLine', () => {
    const line = bridgeLine({ type: 'state', state: 'thinking' })
    expect(JSON.parse(line)).toEqual({ type: 'state', state: 'thinking' })
    expect(line.endsWith('\n')).toBe(true)
  })
})

describe('bridgeStdin', () => {
  /** Collect an async iterable into one call, the way stdin arrives. */
  async function pump(lines: string[], conversation: VoiceConversation): Promise<void> {
    async function* source(): AsyncIterable<Buffer> {
      yield Buffer.from(lines.join('\n'))
    }
    await bridgeStdin(conversation, source())
  }

  it('routes audio frames and commit requests to the conversation', async () => {
    const audio: string[] = []
    let commits = 0
    const conversation = {
      sendAudio: (frame: string) => { audio.push(frame) },
      commitUtterance: () => { commits += 1 },
    } as unknown as VoiceConversation
    await pump(['{"audio":"QQ=="}', '', '{"audio":"Qg==","commit":true}'], conversation)
    expect(audio).toEqual(['QQ==', 'Qg=='])
    expect(commits).toBe(1)
  })

  it('stops pumping cleanly when the voice channel died mid-stream', async () => {
    let pumped = 0
    const conversation = {
      sendAudio: () => {
        pumped += 1
        throw new Error('StepFun realtime session is closed')
      },
      commitUtterance: () => {},
    } as unknown as VoiceConversation
    // A driver that keeps writing after the transport dropped must not fail
    // the process: the bridge stops and the runner shuts down cleanly.
    await expect(pump(['{"audio":"QQ=="}', '{"audio":"Qg=="}'], conversation)).resolves.toBeUndefined()
    expect(pumped).toBe(1)
  })
})
