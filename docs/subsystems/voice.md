# Voice

English | [中文](voice.zh.md)

Duplex voice conversation over the StepFun realtime WebSocket: the realtime model owns the ear and the voice, and every finalized transcript becomes an ordinary agent task executed by the configured main model. [`dsh-stepfun-realtime`](../../packages/voice/stepfun-realtime/README.md) owns the transport — one WebSocket session per conversation against the channel endpoint (standard `wss://api.stepfun.com/v1/realtime`, Step Plan `wss://api.stepfun.com/step_plan/v1/realtime`), server VAD, PCM16 audio both ways, typed protocol events — while [`dsh-voice-agent`](../../packages/voice/voice-agent/README.md) owns the pairing policy: transcript → `agent.followup` → final answer → `response.create` speech, with barge-in cancelling only the spoken response. The [`voice` profile](../../packages/bundle/voice-app/README.md) exposes the stack through a stdio JSON-frame bridge and switches both halves to the Step Plan channel with `--step-plan`.

Source: [`packages/voice/stepfun-realtime/src/index.ts`](../../packages/voice/stepfun-realtime/src/index.ts), [`packages/voice/voice-agent/src/index.ts`](../../packages/voice/voice-agent/src/index.ts)

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxstepfunrealtime--stepfunrealtimeservice"></a>

### `ctx.stepfunRealtime` — `StepFunRealtimeService`

The service exposed as `ctx.stepfunRealtime`.

```ts cordis-catalog
/**
 * Open one duplex voice session.
 * @param overrides - per-session voice and instructions over the plugin config.
 * @param events - typed callbacks for the session's lifetime.
 * @returns the opened session; rejects when no key is available or the
 *   handshake fails.
 */
createSession( overrides: { voice?: string; instructions?: string }, events: RealtimeSessionEvents, ): Promise<RealtimeSession>
```

Source: [`packages/voice/stepfun-realtime/src/index.ts`](../../packages/voice/stepfun-realtime/src/index.ts)

<a id="ctxvoiceagent--voiceagentservice"></a>

### `ctx.voiceAgent` — `VoiceAgentService`

The service exposed as `ctx.voiceAgent`.

```ts cordis-catalog
/**
 * Start one duplex voice conversation.
 * @param options - session identity and voice overrides.
 * @param events - consumer callbacks for the conversation's lifetime.
 * @returns the started conversation.
 */
createConversation( options: CreateConversationOptions, events: VoiceConversationEvents, ): Promise<VoiceConversation>
```

Source: [`packages/voice/voice-agent/src/index.ts`](../../packages/voice/voice-agent/src/index.ts)
<!-- END GENERATED cordis-surface -->
