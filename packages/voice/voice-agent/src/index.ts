/**
 * `voice-agent`: the duplex voice conversation service. Consumers call
 * `ctx.voiceAgent.createConversation(...)` to bind one StepAudio 3 Realtime
 * session to one durable Agent (the configured main model), pipe microphone
 * frames in, and play spoken answers out. The plugin owns conversation
 * construction; conversation policy lives in the conversation itself.
 *
 * @module @deepseek-ai/dsh-voice-agent
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-stepfun-realtime'
import { VoiceConversation } from './conversation.ts'
import type { VoiceConversationEvents } from './conversation.ts'

export { VoiceConversation } from './conversation.ts'
export type {
  VoiceConversationDeps,
  VoiceConversationEvents,
  VoiceState,
} from './conversation.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'voice-agent'

/** Core services required before a conversation can start. */
export const inject = ['stepfunRealtime', 'agents', 'sessions', 'agentDefaultModel']

/** Plugin config: the voice-model defaults every conversation may override. */
export interface Config {
  /** Voice the model speaks with; the platform default applies when omitted. */
  voice?: string
  /** System instructions for the voice model's own turns. */
  instructions?: string
}

export const Config: z<Config> = z.object({
  voice: z.string(),
  instructions: z.string(),
})

/** Options for {@link VoiceAgentService.createConversation}. */
export interface CreateConversationOptions {
  /** Exact durable Session identity to adopt; a fresh identity when omitted. */
  sessionId?: string
  /** Per-conversation voice-model overrides over the plugin defaults. */
  realtime?: { voice?: string; instructions?: string }
}

/** The service exposed as `ctx.voiceAgent`. */
export interface VoiceAgentService {
  /**
   * Start one duplex voice conversation.
   * @param options - session identity and voice overrides.
   * @param events - consumer callbacks for the conversation's lifetime.
   * @returns the started conversation.
   */
  createConversation(
    options: CreateConversationOptions,
    events: VoiceConversationEvents,
  ): Promise<VoiceConversation>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Duplex voice conversation service over StepAudio 3 Realtime. */
    voiceAgent: VoiceAgentService
  }
}

export function apply(ctx: Context, config: Config): void {
  ctx.provide('voiceAgent', {
    async createConversation(options, events) {
      const defaults = {
        ...config.voice === undefined ? {} : { voice: config.voice },
        ...config.instructions === undefined ? {} : { instructions: config.instructions },
      }
      const realtime = { ...defaults, ...options.realtime }
      return await VoiceConversation.start(
        { ctx, ...options.sessionId === undefined ? {} : { sessionId: options.sessionId }, realtime },
        events,
      )
    },
  } satisfies VoiceAgentService)
}
