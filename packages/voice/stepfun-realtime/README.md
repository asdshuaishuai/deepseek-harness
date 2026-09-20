---
description: "The StepAudio 3 Realtime duplex voice WebSocket client (standard and Step Plan channels, stepaudio-3-realtime-preview) with public-endpoint validation and an injectable transport."
kind: "package-reference"
---

# @deepseek-ai/dsh-stepfun-realtime

English | [中文](README.zh.md)

## Summary

Open one duplex voice session against StepFun's realtime WebSocket: server-side VAD finalizes utterances into transcripts, spoken answers return as PCM16 audio frames, and the event vocabulary arrives as typed callbacks. Pick the standard channel or the Step Plan subscription endpoint through config; both speak `stepaudio-3-realtime-preview`, overridable by `model`. Conversation policy — pairing voice turns with an agent — belongs to consumers such as `dsh-voice-agent`.

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

Choose it when a composition needs the raw realtime session — transcribe speech, speak text, cancel a spoken response on barge-in. To bind that session to a durable harness Agent instead, mount `dsh-voice-agent`, which consumes this service.

### Minimal configuration

```yaml
- id: stepfun-realtime
  name: '@deepseek-ai/dsh-stepfun-realtime'
```

| Field | Default | Meaning |
|---|---|---|
| `channel` | `standard` | `standard` (`wss://api.stepfun.com/v1/realtime`) or `step-plan` (`wss://api.stepfun.com/step_plan/v1/realtime`) |
| `apiKeyEnv` | `STEPFUN_API_KEY` | Credential reference resolved per session |
| `baseURL` | channel endpoint, or `$STEPFUN_REALTIME_URL` | WS(S) root; validated as a public endpoint before any connection |
| `model` | `stepaudio-3-realtime-preview`, or `$STEPFUN_REALTIME_MODEL` | Realtime model id sent as `?model=` |
| `voice` | platform default | Voice the model speaks with |
| `connectTimeoutMs` | `10000` | Ceiling on the `session.created` handshake |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-stepfun-realtime) is the exhaustive source for every accepted field.

The plugin provides `ctx.stepfunRealtime`; `createSession(overrides, events)` opens the session and returns the transport-level `RealtimeSession` (`appendAudio`, `commit`, `speak`, `cancelResponse`, `close`).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

`src/session.ts` owns the careful `open()` handshake — consumer callbacks captured across the settle, `session.update` re-installed on the `session.created` ack — and the turn vocabulary; `src/transport.ts` is the injectable `RealtimeTransportFactory` (tests double it; production uses the global WebSocket); `src/index.ts` resolves channel, endpoint, model, and credential into `ctx.stepfunRealtime`. Audio is PCM16: 16 kHz in, 24 kHz out; the server owns VAD and emits `speech_started`/`speech_stopped` for barge-in.

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-voice-agent](../voice-agent/README.md) — the conversation bridge consuming this service.
- [dsh-voice-app](../../bundle/voice-app/README.md) — the `voice` profile wiring channels through `--step-plan`.
- [StepAudio 3 Realtime guide](https://platform.stepfun.com/docs/zh/guides/models/stepaudio-3-realtime) — the platform's realtime protocol documentation.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

<a id="model-experience"></a>
## Model Experience

Indirectly, through the conversation bridge. The realtime model itself runs server-side and its transcripts and spoken audio never enter agent requests directly; `dsh-voice-agent` owns turning finalized transcripts into agent tasks and assistant text into speech.

#### KV Cache effect

None for agent requests; realtime turns are a separate provider session with its own server-side state.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- `stepaudio-3-realtime-preview` is the free-preview model id; the platform replaces the name when the paid version ships — override with `model` or `$STEPFUN_REALTIME_MODEL` then.
- The session is transport-only: no transcript persistence, queueing, or agent pairing lives here.

These limits define current package constraints, not a task backlog.
