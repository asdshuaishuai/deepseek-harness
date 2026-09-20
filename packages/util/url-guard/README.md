---
description: "Public-endpoint URL validation for packages that issue server-side HTTP(S) or WS(S) requests, rejecting loopback, private, and reserved hosts before any connection."
kind: "package-library"
---

# @deepseek-ai/dsh-url-guard

English | [中文](README.zh.md)

## Summary

Validate a server-side request target before issuing it: HTTP(S) (or WS(S) for realtime upgrades) only, no credentials, query, or fragment, and a host that is not `localhost` or a loopback, private, link-local, multicast, or otherwise reserved IP literal. Callers guarding operator configuration use one assertion; callers connecting on behalf of untrusted input resolve first and re-check every answer with `isPublicHost`.

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

### When to use it

Reach for it from any package that builds a server-side request or socket from configuration: the StepFun LLM adapter validates its `baseURL`, the realtime client its WebSocket endpoint, and the StepSearch MCP mount its server URL through this guard.

### Entry point

```ts
import { assertPublicHttpUrl, isPublicHost } from '@deepseek-ai/dsh-url-guard'

assertPublicHttpUrl('https://api.stepfun.com/v1', 'my-plugin: baseURL') // ok
isPublicHost('127.0.0.1') // false
```

A violation throws with the caller-supplied owner prefix naming the config field; `assertPublicWebSocketUrl` is the WS(S) twin for realtime upgrades.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

Classification delegates to `ipaddr.js` ranges: only `unicast` passes, with IPv4-mapped IPv6 classified by its embedded address, and `localhost` plus its subdomains rejected by name. Non-literal hostnames pass the host check — they are operator configuration, not model-chosen URLs; the guard's contract is fail-closed on literals and names it can judge without DNS.

`src/index.ts` exports `isPublicHost(hostname)`, `assertPublicHttpUrl(value, owner)`, and `assertPublicWebSocketUrl(value, owner)`; `tests/url-guard.spec.ts` pins the accepted and rejected shapes.

-----

<a id="further-exploration"></a>
## Further Exploration

- [dsh-llm-stepfun](../../llm/llm-stepfun/README.md) — validates its endpoint through this guard at configuration resolution.
- [dsh-stepfun-realtime](../../voice/stepfun-realtime/README.md) — validates the WebSocket root before any connection.
- [dsh-mcp-stepfun-search](../../mcp/mcp-stepfun-search/README.md) — validates the StepSearch MCP endpoint before mounting the client.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

<a id="model-experience"></a>
## Model Experience

None, as the guard is a pure URL validation helper; it registers nothing model-facing and no validated value reaches prompts by itself.

#### KV Cache effect

None; the guard contributes no request content.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- Non-literal hostnames are not resolved: the guard judges operator configuration, and untrusted-input callers must resolve and re-check every answer themselves.

These limits define current package constraints, not a task backlog.
