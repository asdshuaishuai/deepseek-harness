---
description: "Sliding-window compaction preset for ctx.compaction: a background compactor model condenses history at 70% context pressure, falling back to the main model."
kind: "package-reference"
---

# @deepseek-ai/dsh-compaction-sliding

English | [中文](README.zh.md)

## Summary

Sliding-window compaction over the basic backend: when the routed model's context reaches 70% of its window, older history condenses into a structured checkpoint through a background compactor model — `step-3.7-flash` on the StepFun Step Plan channel — so the main model never spends its own turn on compaction. If the compactor cannot serve, the pass falls back to the main model and the compactor is disabled for the process lifetime. Every following request sees the checkpoint plus the retained recent conversation tail.

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

Mount it in place of `dsh-compaction-basic` (both provide `ctx.compaction`; two engines would collide). The defaults are the preset: threshold 0.7, compactor `stepfun-official`/`step-3.7-flash`, fallback on.

```yaml
- name: '@deepseek-ai/dsh-compaction-sliding'
```

| Field | Default | Meaning |
|---|---|---|
| `compactorProvider` | `stepfun-official` | Provider route of the background compactor |
| `compactorModel` | `step-3.7-flash` | Compactor model; the background summarizer's target |
| `compactorFallbackToMain` | `true` | `false` surfaces the compactor error instead of falling back |
| (all `dsh-compaction-basic` fields) | basic defaults | `thresholdRatio` defaults to `0.7` here; the rest pass through unchanged |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-compaction-sliding) is the exhaustive source for every accepted field and its JSDoc.

### Sliding-window behavior

Pressure is measured by the shared token meter against `thresholdRatio × contextWindow` of the routed model (70% by default). Crossing it first runs the optional tool-result pruner, then condenses the oldest compactable range into the checkpoint while the configured retention keeps the most recent conversation verbatim — the window slides forward. The auxiliary summarization call is a background one-shot through `ctx.llm.stream` with `purpose: 'compaction'`: the conversation model never participates, and the checkpoint event durably records which compactor model wrote it.

### Compactor fallback

The compactor attempt happens first on every compaction. If it fails for any reason other than cancellation, the same pass immediately retries through the routed main model and the compactor is disabled for the process lifetime — "no 3.7-flash available" (the standard open-platform channel, for example) is durable, not transient. `compactorFallbackToMain: false` surfaces the compactor error instead. An explicitly configured `summarizationModel` (config or the routed model's policy) always outranks the preset.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the preset; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **Everything but the target is the basic backend.** Triggering, retention, the summary format, and the durable event protocol are the basic engine's fixed replay strategy; this package owns exactly one decision — which model writes the summary.
- **Fallback is durable, not per-call.** A compactor that failed once (unknown model on the channel, provider refusal) is disabled for the process lifetime, so a deployment without the flash model pays the failed attempt once, not on every compaction.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `SlidingCompactionEngine`: preset defaults, compactor attempt, fallback policy |

— The summarization call, checkpoint framing, region selection, and events are `dsh-compaction-basic`'s and are documented there.

### Request and fallback flow

`summarize()` first defers when an explicit summarizer is configured (config or the routed model's policy — the owner's choice outranks the preset) or when the routed model already IS the compactor. Otherwise it drives the compactor through `summarizeWithLlm`; a failure — cancellation excepted — marks the compactor disabled and re-runs the same input through the basic engine's routed-model path.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Compaction family map](../README.md) — the four-package family and each role.
- [dsh-compaction](../compaction/README.md) — the shared condensation contract and summary event protocol.
- [dsh-compaction-basic](../compaction-basic/README.md) — the backend this preset extends: triggers, retention, and checkpoint framing.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-compaction-sliding) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Conversation history

#### What the model sees

After a successful step crosses 70% of the routed model's window, oversized tool results are first rewritten when the optional pruner is loaded. If summarization remains necessary, the next request receives the checkpoint preamble below, a blank line, `<compacted-summary>`, the data-dependent summary, and `</compacted-summary>`, followed by the most recent conversation tail retained verbatim. Overflow recovery rebuilds the immediate retry from whatever replacement advanced the surface.

##### Conversation checkpoint preamble

```markdown
This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.
```

#### Token effect

The replacement reduces future input history rather than appending a second copy: the compacted older range becomes one bounded checkpoint, and the retained recent tail stays verbatim. A checkpoint remains until a later compaction replaces it.

#### KV Cache effect

Replacing rather than append-only. Each checkpoint invalidates reuse from the first replaced history token; the unchanged request prefix before that range remains reusable.

### Background compactor request

#### What the model sees

The compactor model receives the conversation replayed verbatim — the same system prompt, tool schemas, and messages the last routed request sent for the shadowed region — followed by one final user message: the compaction instruction. The conversation model never sees this private request or its reasoning; only returned text is stored.

##### Compaction instruction (final user message)

```markdown
You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.
```

#### Token effect

One bounded auxiliary request per compaction, capped by `maxTokens`; the durable checkpoint event records the compactor's provider, model, and reported usage so the one-shot request is reconstructable from the log.

#### KV Cache effect

Cache-reusing by construction: the auxiliary call replays the routed request's exact prefix (system prompt, tools, messages) and appends only the compaction instruction, so the provider's warm prefix cache serves the replay instead of a cold re-read.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the preset is a poor fit. They are current package constraints.

- **The compactor preset bypasses per-model summarization policies for its own attempt** — a routed model's policy summarizer applies only to the fallback path; a policy that names a different summarizer is honored only when it sets `summarizationModel` (which disables the preset entirely).
- **The compactor failure is process-sticky** — a transient compactor refusal (rate limit) permanently switches the deployment to main-model compaction until restart; per-call retry windows wait on provider-neutral service fields.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above and the linked Agent Notes.

#### Future: channel-aware compactor default

The default compactor id (`step-3.7-flash`) is a Step Plan catalog model. On the standard open-platform channel the first compaction pays one failed attempt before falling back. Reading the chat adapter's channel to seed the default (or expose the flash model there) needs a provider-neutral model-availability field first.

</details>
