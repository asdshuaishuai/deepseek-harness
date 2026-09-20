---
description: "The duplex voice bridge binding one StepAudio 3 Realtime session to one durable Agent: transcripts become agent tasks, final answers are spoken back, and barge-in cancels only the speech."
kind: "package-reference"
---

# @deepseek-ai/dsh-voice-agent

English | [中文](README.zh.md)

## Summary

Hold a spoken conversation over a durable Agent: server VAD finalizes each utterance into a transcript, every transcript becomes an agent task executed by the configured main model, and the turn's final assistant text is spoken back through the same realtime session. While the agent works, the voice model briefly confirms the accepted task (Codex-style; `acknowledge: false` silences it, a string replaces the line). Barge-in cancels the spoken response while the agent turn runs to completion. Pass `sessionId` to resume; the durable session log keeps every voice-originated turn.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### When to choose it

Choose it when a composition wants voice conversations grounded in the ordinary agent loop — tools, session log, model selection — rather than raw realtime transport. The transport itself comes from `dsh-stepfun-realtime`; this bridge owns the pairing policy.

### Minimal configuration

```yaml
- id: voice-agent
  name: '@deepseek-ai/dsh-voice-agent'
```

| Field | Default | Meaning |
|---|---|---|
| `voice` | platform default | Passed through to the realtime session |
| `instructions` | consumer's | Realtime-side system instructions over the plugin default |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-voice-agent) is the exhaustive source for every accepted field.

The plugin provides `ctx.voiceAgent`; `createConversation({ sessionId?, realtime? }, events)` binds one realtime session to one Agent and returns the `VoiceConversation`: microphone frames go in through `sendAudio`, spoken answers come out as base64 PCM16 on `onAudio`, and callbacks report `state` (`listening`/`thinking`/`speaking`), user transcripts, caption deltas, and the final answer.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

`src/conversation.ts` wires `agent/assistant-stream` (accumulating the turn's text into caption deltas) and `agent/status` (idle marks the answer ready) around the realtime session: finalized transcripts enter through `agent.followup` — queue-safe while a turn is busy — the drain loop polls `whenIdle`, and the settled answer is spoken through `response.create` with barge-in cancelling only the speech. `src/index.ts` provides `ctx.voiceAgent` over the `stepfunRealtime`, `agents`, `sessions`, and `agentDefaultModel` services.

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-stepfun-realtime](../stepfun-realtime/README.md) — the transport this bridge consumes.
- [dsh-voice-app](../../bundle/voice-app/README.md) — the `voice` profile driving this service over a stdio bridge.
- [Agent loop](../../core/agent-loop/README.md) — the turn lifecycle the bridge submits tasks into.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

<a id="model-experience"></a>
## Model Experience

Indirectly, through the agent loop. A finalized transcript becomes an ordinary user message and the spoken answer is the turn's ordinary final text; the bridge adds no prompt prose or schema of its own. The realtime model's own session stays server-side.

#### KV Cache effect

Voice-originated turns reuse the agent's ordinary prefix; the bridge changes neither request assembly nor historical bytes.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- One conversation binds exactly one Agent and one realtime session; multiple simultaneous speakers or sessions are out of scope.
- Caption deltas stream the assembled turn text without reasoning blocks.

These limits define current package constraints, not a task backlog.
