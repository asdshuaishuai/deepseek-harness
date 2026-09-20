# Voice（语音）

[English](voice.md) | 中文

基于 StepFun realtime WebSocket 的双工语音对话：realtime 模型拥有耳朵与嗓音，每条定稿转写都成为由配置的主力模型执行的普通 agent 任务。[`dsh-stepfun-realtime`](../../packages/voice/stepfun-realtime/README.zh.md) 拥有传输——每条会话一个 WebSocket 连接，指向通道端点（标准 `wss://api.stepfun.com/v1/realtime`，Step Plan `wss://api.stepfun.com/step_plan/v1/realtime`），服务端 VAD、双向 PCM16 音频、类型化协议事件——而 [`dsh-voice-agent`](../../packages/voice/voice-agent/README.zh.md) 拥有配对策略：转写 → `agent.followup` → 最终回答 → `response.create` 语音，打断只取消语音。[`voice` profile](../../packages/bundle/voice-app/README.zh.md) 经 stdio JSON 帧桥暴露该栈，并以 `--step-plan` 一键把两半切到 Step Plan 通道。

Source: [`packages/voice/stepfun-realtime/src/index.ts`](../../packages/voice/stepfun-realtime/src/index.ts), [`packages/voice/voice-agent/src/index.ts`](../../packages/voice/voice-agent/src/index.ts)

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
