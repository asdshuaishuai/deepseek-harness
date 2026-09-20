---
description: "Default MCP mount for StepFun's official StepSearch server (web_search and web_fetch over Streamable HTTP, Step Plan billing), resolving the bearer key from the credential plane at load."
kind: "package-reference"
---

# @deepseek-ai/dsh-mcp-stepfun-search

English | [中文](README.zh.md)

## Summary

Give the model StepFun's built-in web tools: the official StepSearch MCP server exposes `web_search` and `web_fetch`, mounted over Streamable HTTP. `web_search` bills 0.04 CNY per call and `web_fetch` is unbilled; both consume the Step Plan subscription's monthly credit (top-up packs apply, month-end reset), under the platform's QPM/QPH and concurrency limits. The wrapper resolves the endpoint and bearer key once at load — credentials service, then environment — and without a key it warns once and stays unmounted while the rest of the composition boots.

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

Choose it when the composition should search the web through the platform's own MCP instead of a seam-level search provider — the shipped `dsh-base` bundle mounts it by default. For arbitrary MCP servers, mount `dsh-mcp-client` directly; this wrapper only targets StepSearch.

### Minimal configuration

```yaml
- id: stepfun-search-mcp
  name: '@deepseek-ai/dsh-mcp-stepfun-search'
```

| Field | Default | Meaning |
|---|---|---|
| `apiKeyEnv` | `STEPFUN_API_KEY` | Credential reference resolved once at load |
| `url` | `$STEPFUN_SEARCH_MCP_URL`, then the public StepSearch endpoint | MCP endpoint; validated as a public HTTP(S) URL |
| `serverName` | `stepfun-search` | Local namespace for the `mcp__<serverName>__*` tool names |
| `toolCallTimeoutMs` | `60000` | Timeout per MCP tool call |
| `failOnStartupError` | `false` | Reject the plugin when the initial connection fails |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-mcp-stepfun-search) is the exhaustive source for every accepted field.

The model-facing tool names are `mcp__stepfun-search__web_search` and `mcp__stepfun-search__web_fetch`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

`src/index.ts` is composition glue over `dsh-mcp-client`: `resolveSearchOptions` validates the endpoint against the public-host guard and the namespace against the tool-name budget; `resolveSearchApiKey` reads the credentials service, then a trusted environment layer; `buildSearchMcpConfig` shapes the Streamable HTTP mount whose `Authorization: Bearer` header carries the key; and `apply` mounts one mcp-client child without blocking startup. The key is read at load only — mcp-client's header set is static per connection generation, so a rotated key needs a restart or an HMR reload.

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-mcp-client](../mcp-client/README.md) — the transport, reconnect policy, and tool registration underneath.
- [dsh-url-guard](../../util/url-guard/README.md) — the endpoint validation every mount passes.
- [StepSearch MCP guide](https://platform.stepfun.com/docs/zh/step-plan/integrations/search-mcp) — the platform's server documentation.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

<a id="model-experience"></a>
## Model Experience

Indirectly, through the MCP client. The server's own tool schemas, instructions, and result text reach the model verbatim; this wrapper adds no prompt section, schema, or result rendering of its own.

#### KV Cache effect

Tool results enter the conversation like any other tool output; an unchanged prefix including prior search results stays cache-eligible.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- Requires a Step Plan subscription; without one the initial connection fails and the supervisor's reconnect budget runs out, leaving the tools absent until restart.
- The bearer key resolves once at load; rotation needs a restart or an HMR reload, and the key travels inside the child's static header set.

These limits define current package constraints, not a task backlog.
