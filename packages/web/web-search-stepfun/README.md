---
description: "The StepFun Search API provider for ctx.web: the open-platform web_search route for step-5-preview, with per-request credentials and documented billing."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-stepfun

English | [中文](README.zh.md)

## Summary

With `dsh-web-search-stepfun`, the harness searches the web through the StepFun Search API (`POST /v1/search`), the open-platform route StepFun's own docs recommend for `step-5-preview` — whose Chat Completions requests reject a built-in `web_search` tool. Every result is an indexed record with a URL and an index-derived snippet; there is no generated answer, so results carry no `content`. A record without a usable URL is dropped, so a call can return fewer sources than requested. The model-facing `web_search` tool lives in `dsh-tool-web`.

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

Mount the provider in a composition that already loads the web service; it registers as the `stepfun` search provider, so `ctx.web.search()` resolves it automatically when it is the only usable search backend — or pin it with `searchProvider: stepfun`.

### When to choose it

Choose this backend for open-platform StepFun keys: the call bills per the open-platform web-search pricing, separate from any Step Plan subscription. For a Step Plan subscription, the [`dsh-mcp-stepfun-search`](../../mcp/mcp-stepfun-search/README.md) mount exposes the same two capabilities (`web_search` at 0.04 CNY per call plus `web_fetch` unbilled) against the subscription's monthly credit instead — the fork's base composition ships both routes, and either row can be dropped.

### Minimal configuration

Load the web service and the provider; the key resolves per search — the credentials service (the web Models page writes `STEPFUN_API_KEY`) first, then `$STEPFUN_API_KEY` from the launch environment — and all other settings have safe defaults.

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-stepfun'
```

| Field | Default | Meaning |
|---|---|---|
| `apiKey` | (unset) | Literal key; prefer `apiKeyEnv` so no secret enters configuration files |
| `apiKeyEnv` | `STEPFUN_API_KEY` | Credential reference resolved for each search |
| `baseURL` | `https://api.stepfun.com/v1` | Endpoint base; `/search` is appended. `$STEPFUN_SEARCH_BASE_URL` applies when config omits it |
| `numResults` | `5` | Default result count sent as the API's `n` when a request carries no `maxResults` |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-stepfun) is the exhaustive source for every accepted field and its JSDoc.

### What a search returns

Each result record maps to a `WebSearchSource`: `url` plus the record's `title` and `snippet` when non-blank. A record without a usable URL cannot cite anything and is dropped. A request's `maxResults` wins over the configured `numResults` default and is sent as the API's `n` — the final bound is enforced by the service, which truncates and flags.

### Failures and recovery

A keyless search fails with a `WebError` `WEB_PROVIDER_ERROR` whose message names the credential reference to store. Provider failures — HTTP errors, network failures, unparseable or wrong-shape bodies — surface as `WEB_PROVIDER_ERROR`; an aborted request surfaces as `WEB_ABORTED`. HTTP redirects are rejected before the `Location` target is contacted. Callers route on the code; the model-facing `web_search` tool surfaces failures to the model under its own error wrapper.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The provider is a thin adapter over a direct retrieval endpoint with two deliberate rules:

- **Indexed records stay records.** The API returns titles, URLs, and snippets — no model-generated answer — so `content` is omitted rather than fabricating provider prose the model might trust.
- **The key resolves late.** Every search snapshots the settings section and resolves the credential through it, so a committed change applies to the next search without re-registering the provider, and a rejected settings generation cannot leak its key onto the previous endpoint.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, credential and environment resolution, provider registration |
| [`src/provider.ts`](src/provider.ts) | The `StepFunSearchProvider`: request dispatch, abort classification, result mapping |
| [`src/types.ts`](src/types.ts) | StepFun wire types: `StepFunSearchResponse`, `StepFunSearchResultItem`, `StepFunSearchErrorBody` |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam. |

### Request and mapping flow

`search()` posts the query and result count to `{baseURL}/search` with `redirect: 'error'`, so a redirect fails the request without contacting the target. The parsed `results[]` are mapped one by one; URL-less entries drop and blank fields omit. An abort — a `DOMException` named `AbortError` — becomes `WEB_ABORTED`; anything else becomes `WEB_PROVIDER_ERROR`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared vocabulary to the service, the model-facing tools, and the design rationale.

- [Web subsystem](../../../docs/subsystems/web.md) — the exhaustive search request/result vocabulary and error codes.
- [Web package map](../README.md) — the package family and each role.
- [dsh-web](../web/README.md) — the web service this provider registers into.
- [dsh-tool-web](../tool-web/README.md) — the model-facing `web_search` tool that renders this provider's sources.
- [dsh-mcp-stepfun-search](../../mcp/mcp-stepfun-search/README.md) — the StepSearch MCP, the same vendor capability under Step Plan billing.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-stepfun) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-web`, which retains this provider's result URLs, titles, and snippets, or its exact `StepFun search aborted`, `StepFun search request failed: <error>`, and `StepFun returned an unprocessable response body: <error>` failures under the consumer's error wrapper.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the provider is a poor fit. They are current package constraints.

- **The API's controls beyond `query` and `n` are not exposed** — fresher or domain-scoped retrieval waits on provider-neutral service fields ([seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md)).
- **Abort classification is error-shape-based** — only a `DOMException` named `AbortError` maps to `WEB_ABORTED`; an abort carrying a custom reason (such as `dsh-timeout`'s `TimeoutReason`) surfaces as `WEB_PROVIDER_ERROR`.
- **Billing is the open platform's, not Step Plan's** — calls bill per the open-platform web-search pricing; a Step Plan deployment that wants subscription credit should keep the StepSearch MCP and drop this row.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above and the linked Agent Notes.

#### Future: channel-aware search routing

The provider does not read the `llm-stepfun` channel selection: on a `step-plan` deployment the StepSearch MCP covers subscription-billed search while this row still answers the open-platform tool. Routing one way or the other by channel needs a provider-neutral service field first.

</details>
