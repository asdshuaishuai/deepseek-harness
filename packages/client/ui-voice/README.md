---
description: "Voice surface for the Web GUI: the microphone toggle in the input dock that opens a duplex conversation with the pinned realtime model, with live captions; for users and maintainers of the browser voice experience."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-voice

English | [中文](README.zh.md)

## Summary

The Web GUI voice surface puts a microphone toggle in the input dock. One click opens a duplex voice conversation over the host's `/voice` bridge: the browser streams microphone audio (16 kHz PCM16 through an inline AudioWorklet), the pinned realtime model answers with 24 kHz audio and live captions, and speech on either side barge-ins the other. The controller is process-local to the browser tab; the durable session identity and the model id arrive from the host bridge, never from the client.

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

Mount this plugin alongside `ui-conversation`, the locale plugin, and `dsh-voice-web-bridge` on the host; the mic toggle appears in the composer dock (after the goal strip). Clicking it starts the loop for the current session: the phase chip shows `Listening`/`Thinking`/`Speaking`, the pinned realtime model id is displayed, and the caption line carries the latest transcript or answer. Clicking again stops the conversation while keeping the socket for a later start; navigating away or closing releases the microphone and the socket.

The dock speaks en/zh copy through the `voice` locale namespace, registered by this plugin.

### Phases and captions

`idle` shows only the mic button. Active phases show the strip: the phase chip, the pinned model, the caption line (assistant answer, else the latest user transcript, else a start hint), and any recoverable error inline. A barge-in (the host falls back to `listening` while an answer plays) drops still-buffered audio so playback never lags the interruption.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One `VoiceController` per browser tab owns the `/voice` socket, the microphone capture, and the answer player, and publishes an immutable view snapshot the dock subscribes to through `useSyncExternalStore`. Capture runs through an inline AudioWorklet that decimates the microphone stream to 16 kHz and emits ~100 ms float chunks; the codec converts them to base64 PCM16 for the bridge, and answer frames (base64 PCM16 at 24 kHz) are scheduled back-to-back on the audio clock. Everything touching devices or the network sits behind injected seams, so the state machine is testable in jsdom with a fake WebSocket and the production factory wires `getUserMedia`, `AudioContext`, and `window.location` at mount.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-voice-web-bridge](../../voice/voice-web-bridge/README.md) — the host side of the `/voice` socket this package speaks.
- [dsh-voice-agent](../../voice/voice-agent/README.md) — the conversation the bridge binds per socket.
- [Client package map](../README.md) — adjacent browser UI packages.

-----

<a id="model-experience"></a>
## Model Experience

None, as this surface renders the host-pinned voice conversation without adding model input.

#### KV Cache effect

None; the browser owns no request prefix. A new conversation resuming a durable `sessionId` restores its history host-side.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the browser voice surface is a poor fit. They are current package constraints.

- **One conversation per tab** — the controller is process-local; background tabs suspend audio worklets, so a second surface needs an explicit multiplexer.
- **No offline or half-open recovery** — a dropped socket resets the surface to idle; resuming by `sessionId` restores host-side history but not in-flight audio.
- **Permission-dependent start** — the first start fails inline when `getUserMedia` is denied; there is no settings deep-link yet.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above.

#### Future: voice-originated text entry

Captions are display-only today. Feeding finalized user transcripts into the composer draft (or offering a spoken prompt history) waits on a product decision about how voice turns should appear in the durable log.

</details>
