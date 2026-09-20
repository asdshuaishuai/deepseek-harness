---
description: "The voice profile layer: a duplex StepAudio 3 Realtime conversation over dsh-base through a stdio JSON-frame bridge, with --step-plan switching chat and realtime to the Step Plan channel."
kind: "package-bundle"
---

# @deepseek-ai/dsh-voice-app

English | [中文](README.zh.md)

## Summary

Run `dsh --profile voice` for a duplex voice conversation grounded in the ordinary agent loop: finalized transcripts become agent tasks, answers are spoken back, and every turn lands in the durable session log. The runner speaks a stdio JSON-frame bridge any driver process can own. `--step-plan` switches the whole profile to the Step Plan subscription endpoints; `--voice` and `--session-id` pick the voice and resume a session; `--no-ack` silences the short task acknowledgement the runner speaks when a transcript is accepted.

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

### Install into a profile

The `voice` profile already composes this bundle; `dsh --profile voice` resolves it from the checkout. The bundle patch inserts the startup, realtime, agent, and runner rows over `dsh-base` and overlays the `llm-stepfun` row, so adding or removing it reshapes the whole voice surface.

```text
dsh --profile voice
dsh --profile voice --voice tongtong
dsh --profile voice --step-plan
dsh --profile voice --realtime-model stepaudio-2.5-realtime
dsh --profile voice --session-id session-…
```

### What you get

A process speaking newline-delimited JSON on stdin/stdout: frames in are `{"audio":"<base64 PCM16 16 kHz mono>"}` and `{"commit":true}`; events out are `ready` (session id and effective realtime model), `state`, `user-transcript`, `assistant-delta`, `assistant-final`, `audio` (base64 PCM16 24 kHz mono), `error`, and `closed`. Captions mirror to stderr so stdout stays a clean JSON stream.

Wrap it with the process owning the audio devices; ffmpeg captures the microphone as raw PCM16 16 kHz mono and plays answers at 24 kHz mono:

```sh
ffmpeg -f avfoundation -i ":0" -f s16le -ar 16000 -ac 1 pipe:1 | <feed frames to dsh --profile voice>
# and play the audio events through: ffplay -nodisp -autoexit -f s16le -ar 24000 -ac 1 -i pipe:0
```

`--step-plan` flips both halves in one switch: chat requests go to `https://api.stepfun.com/step_plan/v1` and the realtime session to `wss://api.stepfun.com/step_plan/v1/realtime`, defaulting to the plan-supported `stepaudio-2.5-realtime` (the plan does not list StepAudio 3 Realtime yet). A settings `llm-stepfun:` section still overlays the chat row either way.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

`cordis.patch.yml` inserts `voice-startup` (the commander program parsing the profile's flag family into `ctx.voiceStartup`), `stepfun-realtime` and `voice-agent` (both injecting `voiceStartup` so `--voice`, the channel, and the model override reach them), and `voice-runner`; it also overlays `llm-stepfun` with the same channel expression. `src/startup.ts` owns the flags; `src/stdio-bridge.ts` encodes and decodes the JSON frames; `src/index.ts` binds one conversation and exits when stdin ends. HMR is disabled — the bridge process is single-run.

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-voice-agent](../../voice/voice-agent/README.md) — the conversation bridge the runner drives.
- [dsh-stepfun-realtime](../../voice/stepfun-realtime/README.md) — the realtime transport and channel selection.
- [Step Plan overview](https://platform.stepfun.com/docs/zh/step-plan/overview) — the subscription channel behind `--step-plan`.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

<a id="model-experience"></a>
## Model Experience

Indirectly, through the rows it mounts. The bundle is a patch-list carrier; the persona suffix the voice rows install ("answers are read aloud") and the mounted packages' registrations own every model-facing effect.

#### KV Cache effect

The persona suffix rewrites the system prompt for the voice profile only; within a session the prefix is stable and cache-eligible as usual.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- The runner owns no audio devices: capture and playback belong to the driver process wrapping the bridge.
- One bridge process holds one conversation; multi-session routing is the driver's job.

These limits define current package constraints, not a task backlog.
