---
description: "Host-side browser voice bridge for ctx.voiceAgent: one WebSocket per duplex voice conversation at /voice, token-authenticated, with the realtime model pinned host-side."
kind: "package-reference"
---

# @deepseek-ai/dsh-voice-web-bridge

English | [中文](README.zh.md)

## Summary

`dsh-voice-web-bridge` carries the duplex voice conversation to the browser: one WebSocket per conversation at `/voice`, token-authenticated through the connection trust plane. The browser sends microphone frames (binary PCM16 16 kHz mono) and JSON control frames (`start`/`commit`/`stop`); the bridge binds them to `ctx.voiceAgent` host-side — the API key never reaches the browser — and streams state, transcripts, captions, final text, and 24 kHz answer audio back. The realtime model is pinned host-side by the billing channel; the `ready` frame reports the resolved id and the browser cannot select one.

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

Mount it in a composition that already loads the web server, the connection trust plane, `dsh-stepfun-realtime`, and `dsh-voice-agent` — the web profile's rows. A keyless deployment boots fine: the bridge owns `/voice` and reports the missing credential per connection instead of failing the composition.

| Field | Default | Meaning |
|---|---|---|
| `path` | `/voice` | Exact upgrade path the bridge owns |

### Wire contract

Browser → host: `{"type":"start","sessionId?":"..."}` (open, optionally resuming a durable Session), `{"type":"commit"}` (force the utterance boundary), `{"type":"stop"}` (end the conversation; the socket stays open), and binary frames of PCM16 16 kHz mono microphone audio (256 KiB per-frame cap).

Host → browser: `ready {sessionId, realtimeModel}`, `state` (`listening|thinking|speaking`), `user-transcript`, `assistant-delta`, `assistant-final`, binary 24 kHz PCM16 answer audio, `error`, and `closed`.

One socket carries one conversation: a second `start` is refused, `stop` allows a later `start`, and a socket drop closes the conversation (a resumed `sessionId` restores the durable transcript history).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The upgrade handler first asks the connection trust plane for a rejection (401/403), then hands the socket to `ws` and wraps it in a per-socket `VoiceSocketSession`: control frames drive the state machine, binary frames forward 1:1 into `conversation.sendAudio`, and conversation events stream back as JSON text frames or binary audio. A cancelled or dropped response emits `closed` and closes the socket, so the client reconnects into a fresh conversation (resuming by `sessionId` keeps the durable log).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Voice family map](../README.md) — the realtime client, the voice agent, and the CLI bridge.
- [dsh-voice-agent](../voice-agent/README.md) — the conversation this bridge binds per socket.
- [dsh-stepfun-realtime](../stepfun-realtime/README.md) — the pinned realtime models per billing channel.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-voice-agent`: the bridge forwards microphone bytes and conversation events verbatim, and the voice agent owns every model-visible request and spoken answer.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the bridge is a poor fit. They are current package constraints.

- **One conversation per socket** — simultaneous duplex conversations from one browser tab require a multiplexing layer above this bridge.
- **No resumption across host restarts** — a durable `sessionId` restores transcript history, but the realtime session itself restarts from silence.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above.

#### Future: per-frame backpressure

The bridge forwards audio frames 1:1 with a 256 KiB input cap and no host-side queue bound on the output direction; a slow browser client relies on WebSocket backpressure. A bounded send queue with drop-oldest policy waits on observed device variance.

</details>
