---
description: "The StepFun chat-completions adapter (step-5-preview flagship with selectable reasoning efforts, Step Plan subscription channel) with per-request credentials and public-endpoint validation."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-stepfun

English | [中文](README.zh.md)

## Summary

Run agent turns on StepFun's OpenAI-compatible Chat Completions API: `step-5-preview` with text and image input over a 1M-token context and selectable reasoning efforts (`low`/`medium`/`high` via `reasoning_effort`), plus the Step Plan subscription channel's flash family. Endpoint, credential, and catalog resolve per request from the `llm-stepfun:` settings section; the endpoint is validated as a public HTTP(S) root before any request. Images inline as base64 data-URL parts under route byte and count budgets.

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

Mount the adapter where a composition already registers the `llm` service; the shipped `dsh-base` bundle includes it as the only provider.

### When to choose it

Choose it for the StepFun platform — standard open-platform billing by default, or the Step Plan subscription through `channel: step-plan`. For another provider, mount that provider's adapter instead; this fork's composition ships StepFun only.

### Minimal configuration

```yaml
- id: llm-stepfun
  name: '@deepseek-ai/dsh-llm-stepfun'
```

| Field | Default | Meaning |
|---|---|---|
| `channel` | `standard` | `standard` (open platform) or `step-plan` (subscription endpoints and catalog) |
| `apiKeyEnv` | `STEPFUN_API_KEY` | Credential reference resolved per request |
| `baseURL` | channel's public API, or `$STEPFUN_BASE_URL` | Chat-completions root; validated as a public HTTP(S) root |
| `maxTokens` | `65536` | Default per-request output cap |
| `models` | channel catalog | Advisory model catalog for discovery consumers |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-llm-stepfun) is the exhaustive source for every accepted field.

The Step Plan catalog: `step-5-preview` (1M, text + image, efforts `low`/`medium`/`high`), `step-3.7-flash` (256K, text + image, efforts `low`/`medium`/`high`), `step-3.5-flash`, `step-3.5-flash-2603` (efforts `low`/`high`), and `step-router-v1`, which routes each turn to `step-5-preview` or `step-3.5-flash` by task complexity.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

`src/adapter.ts` streams `POST {baseURL}/chat/completions` (SSE, `[DONE]` sentinel) with attribution headers, an idle watchdog, and provider error mapping; `src/config.ts` owns `resolveAdapterOptions`, the one explicit resolve step from raw config to validated connection facts (bounds re-judged beyond the schema). `src/protocol/` serializes harness messages onto the wire — assistant history replays `reasoning_content` and `tool_calls`, tool results ride as `role: 'tool'` messages, images inline as base64 data-URL parts after deterministic offload — and `src/common/` holds the catalog and model-info projection. The settings section hot-reloads with last-good-keep error handling.

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-url-guard](../../util/url-guard/README.md) — the public-endpoint validation every request target passes.
- [dsh-stepfun-realtime](../../voice/stepfun-realtime/README.md) — the duplex voice client sharing the same credential plane.
- [Step Plan overview](https://platform.stepfun.com/docs/zh/step-plan/overview) — the subscription channel's model and MCP documentation.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

<a id="model-experience"></a>
## Model Experience

### StepFun chat-completions request

#### What the model sees

The selected StepFun model receives the harness system prompt, message history, tool schemas, stop sequences, and call config (`maxTokens`, `reasoningEffort`, `temperature`) without adapter-authored prompt prose. Reasoning surfaces as `reasoning` blocks from `reasoning_content` deltas; the request carries no thinking toggle — a selected effort serializes as `reasoning_effort`, and models without cataloged efforts leave the field off entirely. Image-capable models receive retained user and tool-result images as base64 data-URL parts beside attachment handles and request-preview dimensions, with offloaded occurrences replaced by their placeholder text.

#### Token effect

Provider tokenization governs exact text input; the adapter reports the stream's `usage` as authoritative. Offload decisions replace the oldest image occurrences with placeholder text deterministically, so a repeated request under pressure prices the same on every attempt.

#### KV Cache effect

An unchanged assembled prefix is eligible for provider cache reuse. Deterministic request-image bytes do not make the full prefix immutable: a changed execution-world path rewrites historical descriptor text, and an offload decision replaces image parts with placeholders on later turns.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- The Anthropic-compatible `/step_plan` Messages protocol is not implemented; the Step Plan channel rides the OpenAI-compatible `/step_plan/v1` root.
- No Files API: chat images inline as base64 data-URL parts under route budgets.
- Chat input ships text and images only: the platform also accepts video input (URL, base64, or Files API references), which the harness attachment pipeline does not carry yet.

These limits define where the adapter stops and future work begins. They are current package constraints, not a general StepFun comparison or a task backlog.
