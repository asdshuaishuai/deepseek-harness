# SFH Web Voice Plan (fork document)

How the browser surface gains the duplex voice conversation that the `voice`
profile already has on the CLI. This is a fork planning document, not upstream
documentation: it names the exact packages to touch, the wire contract to add,
the tests each stage owes, and what is explicitly out of scope.

## Status and decision (2026-09-21)

**This document is the implementation plan, to be carried out elsewhere.** The
browser voice surface is deliberately not built in this branch: the plan is
written here as the handoff, self-contained on purpose — exact packages, wire
contract, per-stage test obligations, and risks — so another session, task, or
team can implement it without re-deriving the design. Until that happens the
CLI `voice` profile remains this branch's voice surface, and it already drives
the pinned realtime models end to end.

The stages are ordered to land bottom-up (Stage 1 composition → Stage 2
transport → Stage 3 audio → Stage 4 panel), each one green before the next
begins.

## Goal

`dsh web` gets a Voice panel: press the microphone button, speak, hear the
answer — with the same architecture the CLI profile already uses. The realtime
model owns the ear and the voice; every finalized transcript becomes an
ordinary agent task executed by the selected chat model; the turn's final text
is spoken back; barge-in cancels only the speech.

Non-goals: replacing the CLI `voice` profile, background listening, voice for
the SDK/ACP surfaces, or a second realtime vendor.

## Fixed facts this plan builds on (already shipped)

- `dsh-stepfun-realtime` exposes `ctx.stepfunRealtime.createSession()`, and its
  model is pinned per billing channel: `stepaudio-3-realtime-preview` on the
  open-platform channel, `stepaudio-2.5-realtime` on the Step Plan channel.
- `dsh-voice-agent` exposes `ctx.voiceAgent.createConversation()`, pairing one
  realtime session with one durable Agent; it consumes the realtime service,
  so the channel-pinned model drives the voice agent with no extra wiring.
- The web profile composes `dsh-web-app` over `dsh-base`; the voice packages
  are mounted only by the CLI `voice` bundle today.
- Browser audio is untouched: no `getUserMedia`, `AudioContext`, or
  `MediaRecorder` exists anywhere under `packages/client`.

## Architecture

```
browser tab                          host process
┌──────────────────────────┐        ┌────────────────────────────────────┐
│ ui-voice (new)           │        │ voice-bridge (new host plugin)     │
│  mic → AudioWorklet()    │  ws    │  session/audio frames              │
│  16 kHz PCM16 frames     ├───────►│   ├─► ctx.voiceAgent conversation  │
│  speaker ← 24 kHz PCM16  │◄───────┤   │      ├─ agent task (chat model)│
│  state / transcripts /   │  ws    │   │      └─ response.create speech │
│  caption deltas          │        │   └─► back to browser (24 kHz)     │
└──────────────────────────┘        └────────────────────────────────────┘
```

The realtime WebSocket lives on the HOST (the API key never reaches the
browser), exactly as the CLI profile does. The browser adds only two things the
CLI bridge does not have: device capture/playback and a UI.

## Stages

### Stage 1 — host: mount the voice services in the web layer

- New rows in `packages/bundle/web-app/cordis.patch.yml`: `stepfun-realtime`
  and `voice-agent` (the same two rows the voice bundle mounts), so
  `ctx.stepfunRealtime` / `ctx.voiceAgent` exist under `dsh web`.
- Gate them on `credentials` being present (the existing optional-service
  pattern) so a keyless deployment keeps booting.
- Tests: extend `apps/cli/tests/profiles/web/*` boot coverage to assert both
  services exist and the composition still starts without a key.

Effort: small. Risk: none beyond composition drift; both services are already
profile-tested by the voice profile.

### Stage 2 — host: the browser voice bridge

New package `packages/voice/voice-web-bridge` (host face only):

- Registers one WebSocket route on the existing web server
  (`ctx.webServer` route, the `web-server.md` contract) for the voice channel.
- Protocol (JSON control frames + binary audio frames on one socket):
  - browser → host: `start { sessionId? }`, `stop`, binary `ArrayBuffer`
    = PCM16 16 kHz mono microphone frames; `commit`;
  - host → browser: `ready { sessionId, realtimeModel }`, `state`
    (`listening | thinking | speaking`), `user-transcript`, `assistant-delta`,
    `assistant-final`, binary frames = PCM16 24 kHz mono answer audio,
    `error`, `closed`.
- Internally: `start` calls `ctx.voiceAgent.createConversation({ sessionId })`
  and pipes events both ways; audio frames map 1:1 onto
  `conversation.sendAudio` / the conversation's `onAudio`.
- Security: the route inherits the web server's token authentication; frames
  are size-capped; no client input reaches a URL (the realtime endpoint is
  host configuration).
- Tests: a REAL composition test that boots the web profile, opens the voice
  route with a token, sends synthetic PCM frames, and asserts the
  conversation's durable session records a voice turn; plus unit tests for the
  frame codec (JSON/binary demultiplexing, caps).

Effort: medium. This is the load-bearing stage; it is also the only one that
touches the transport, so it lands first and alone.

### Stage 3 — client: capture and playback

New client package `packages/client/ui-voice` (browser face):

- `getUserMedia({ audio: { channelCount: 1, echoCancellation: true } })`;
  an AudioWorklet downsamples to 16 kHz PCM16 and posts frames to the bridge
  socket; a second worklet consumes 24 kHz frames from a ring buffer and
  schedules them on the audio clock for playback (no `AudioContext` per
  frame).
- Barge-in: the server VAD's `speech_started` already cancels speech host
  side; the client additionally stops scheduling buffered audio so playback
  does not lag the interruption.
- No audio ever goes to the model as text: only the finalized transcript does
  (host side).
- Tests: worklet codec unit tests (resample/round-trip), a jsdom-side state
  test for the socket client with a fake `AudioWorkletNode`, and a manual QA
  checklist (single microphone, echo cancellation on, headphones).

Effort: medium-large; the resampling/ring-buffer path is where the sharp edges
are (Windows audio stack, sample-rate drift, device switching).

### Stage 4 — client: the Voice panel

In `packages/client/ui-voice` as well:

- A sidebar/dock entry with the microphone button, live state, running
  transcripts, and the caption stream (reuse the conversation caption
  rendering where possible).
- Failure surfaces: permission denied, no microphone, keyless deployment
  (the panel states which credential is missing and links the Models page),
  Step Plan channel indicator (the panel shows which pinned realtime model is
  active).
- i18n: `en` + `zh` dictionaries, following the existing client locale
  pattern.
- Tests: component tests for each state, snapshot for the panel chrome.

Effort: medium. Mostly UI states and copy.

## Cross-cutting decisions

- **One socket per conversation.** Reconnect closes the host conversation and
  opens a fresh realtime session; a resumed `sessionId` keeps the transcript
  history in the same durable session.
- **The panel is per-Session.** Opening it in a session binds the
  conversation to that session; closing it stops the realtime session (no
  background listening).
- **No new credentials path.** The host resolves the same `STEPFUN_API_KEY`
  the chat path uses; the browser never sees it.
- **Model pinning stays host-side.** The browser displays the resolved
  realtime model; it cannot select one (the billing channel decides).

## Verification

1. `pnpm dsh web` with a key: the Voice panel starts a conversation, the turn
   appears in the session log, and the answer plays.
2. Barge-in: speaking over the answer stops audio within one frame batch and
   the agent turn completes.
3. Keyless boot: the panel reports the missing credential; the rest of the
   web surface is unaffected.
4. Step Plan switch: flipping the channel on the Models page changes the
   pinned realtime model reported by the panel on the next conversation.
5. Regression: `voice` CLI profile tests stay green (the bridge is additive).

## Risks

- **Audio device variance** is the main unknown (sample-rate drift, Bluetooth
  devices, Windows exclusive mode). Mitigation: resample on both directions
  and a manual QA matrix; keep the ring buffer generous.
- **Echo** without headphones. Mitigation: enable browser echo cancellation
  and document headphones as the supported path (the CLI profile does the
  same).
- **Compaction/steering while speaking**: a long agent turn keeps the state
  `thinking`; the panel must show it rather than appearing stuck.
