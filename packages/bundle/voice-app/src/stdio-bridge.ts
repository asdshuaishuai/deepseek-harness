/**
 * The `--stdio` JSON-frame bridge: audio in as `{"audio": "<base64>"}` lines
 * on stdin, conversation events out as JSON lines on stdout. Any frontend or
 * native wrapper owning real audio devices drives the conversation through
 * this contract.
 *
 * @module @deepseek-ai/dsh-voice-app/stdio-bridge
 */

import type { VoiceConversation, VoiceConversationEvents } from '@deepseek-ai/dsh-voice-agent'

/** One outbound bridge event, newline-delimited on stdout. */
export type BridgeEvent =
  | { type: 'ready'; sessionId: string; realtimeModel?: string }
  | { type: 'state'; state: 'listening' | 'thinking' | 'speaking' }
  | { type: 'user-transcript'; text: string }
  | { type: 'assistant-delta'; delta: string }
  | { type: 'assistant-final'; text: string }
  | { type: 'audio'; audio: string }
  | { type: 'error'; message: string }
  | { type: 'closed'; code: number; reason: string }

/** One inbound bridge frame, newline-delimited on stdin. */
export interface BridgeInput {
  /** One base64 PCM16 microphone frame. */
  audio?: string
  /** Force-commit the input buffer as a complete utterance. */
  commit?: boolean
}

/**
 * Encode one outbound event as its bridge line.
 * @param event - the event to encode.
 */
export function bridgeLine(event: BridgeEvent): string {
  return `${JSON.stringify(event)}\n`
}

/**
 * Decode one inbound bridge line. A blank line is a no-op heartbeat; a
 * malformed line is named and skipped.
 * @param line - one stdin line without its terminator.
 */
export function parseBridgeLine(line: string): BridgeInput | undefined {
  const trimmed = line.trim()
  if (trimmed === '') return undefined
  try {
    return JSON.parse(trimmed) as BridgeInput
  } catch {
    return undefined
  }
}

/**
 * The conversation callbacks that mirror every event onto the bridge output.
 * @param write - outbound sink (expects the exact bytes to emit).
 */
export function bridgeEvents(write: (chunk: string) => void): VoiceConversationEvents {
  return {
    onState: (state) => { write(bridgeLine({ type: 'state', state })) },
    onUserTranscript: (text) => { write(bridgeLine({ type: 'user-transcript', text })) },
    onAssistantDelta: (delta) => { write(bridgeLine({ type: 'assistant-delta', delta })) },
    onAssistantFinal: (text) => { write(bridgeLine({ type: 'assistant-final', text })) },
    onAudio: (audio) => { write(bridgeLine({ type: 'audio', audio })) },
    onError: (message) => { write(bridgeLine({ type: 'error', message })) },
    onClose: (event) => { write(bridgeLine({ type: 'closed', code: event.code, reason: event.reason })) },
  }
}

/**
 * Pump stdin into one conversation: each JSON line's audio frame is appended
 * and `commit` requests force the utterance boundary. Resolves when stdin
 * ends.
 * @param conversation - the started conversation.
 * @param stdin - raw stdin chunks; the bridge splits lines.
 */
export async function bridgeStdin(
  conversation: VoiceConversation,
  stdin: AsyncIterable<Buffer>,
): Promise<void> {
  let buffer = ''
  for await (const chunk of stdin) {
    buffer += chunk.toString('utf8')
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      const input = parseBridgeLine(line)
      if (input?.audio !== undefined) conversation.sendAudio(input.audio)
      if (input?.commit === true) conversation.commitUtterance()
      newline = buffer.indexOf('\n')
    }
  }
}
