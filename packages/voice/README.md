---
description: "The voice package group: duplex voice conversation over the StepFun realtime WebSocket — the transport client, the agent bridge, and the profile layer."
kind: "package-group"
---

# Voice

English | [中文](README.zh.md)

## Summary

The `voice/` group holds the duplex voice conversation stack: one StepAudio 3 Realtime WebSocket session transcribes speech server-side, every finalized transcript becomes an ordinary agent task, and the turn's final answer is spoken back through the same session. The transport package owns the protocol; the agent package owns the pairing policy; the bundle layer exposes the `voice` profile.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

The transport client and the conversation bridge compose; the bundle layer mounts both for the CLI profile.

| Package | What it provides |
|---|---|
| [`stepfun-realtime/`](stepfun-realtime/README.md) | The realtime WebSocket client (standard and Step Plan channels) with typed events and an injectable transport |
| [`voice-agent/`](voice-agent/README.md) | The bridge binding one realtime session to one durable Agent |
| [`voice-web-bridge/`](voice-web-bridge/README.md) | Browser voice bridge: one `/voice` WebSocket per conversation, binding mic frames to `ctx.voiceAgent` | owns the `/voice` upgrade route |

-----

<a id="related-documentation"></a>
## Related documentation

- [Voice subsystem reference](../../docs/subsystems/voice.md) — the subsystem's services and event vocabulary.
- [dsh-voice-app](../bundle/voice-app/README.md) — the `voice` profile layer over `dsh-base`.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
