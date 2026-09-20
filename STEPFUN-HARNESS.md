# StepFun Harness (stepfun-harness branch)

This branch forks DeepSeek Harness (`dsh`) into a StepFun-only composition: the main model is fully adapted to the StepFun platform (standard API **and** the Step Plan subscription channel, including the platform's official MCP), and a complete duplex voice interaction mode is added on top. All external (non-StepFun) model providers are removed from the shipped composition for now.

## What changed

### Main model: `step-5-preview` (`packages/llm/llm-stepfun`)

A new `llm-stepfun` adapter speaks the OpenAI-compatible Chat Completions protocol against `https://api.stepfun.com/v1`:

- provider route `stepfun-official`; `step-5-preview` is the default main model (1M-token context, text + image input, reasoning surfaced as blocks with selectable efforts `low`/`medium`/`high` serialized as `reasoning_effort`), with `step-3` as the text-only catalog fallback;
- credentials and endpoint resolve per request (`STEPFUN_API_KEY`, `STEPFUN_BASE_URL`) through the credentials service and the `llm-stepfun:` settings section — the web Models page writes the same section;
- images inline as base64 data-URL parts with route byte/count budgets and deterministic offload;
- the endpoint is validated as a public HTTP(S) root at configuration resolution (see [dsh-url-guard](packages/util/url-guard/README.md)): local, loopback, private, and reserved hosts are rejected before any request.

### Step Plan channel (subscription API + default MCP + plan voice)

Beyond the standard API, the harness speaks the [Step Plan subscription channel](https://platform.stepfun.com/docs/zh/step-plan/overview):

- **Chat** — `channel: step-plan` (config or the `llm-stepfun:` settings section) moves chat to `https://api.stepfun.com/step_plan/v1` and swaps the advisory catalog to the plan family: `step-5-preview`, `step-3.7-flash` (256K, text+image, `reasoning_effort` low/medium/high), `step-3.5-flash`, `step-3.5-flash-2603` (efforts low/high), and `step-router-v1` (complexity routing). Efforts serialize as the OpenAI-style `reasoning_effort` field — on the flagship and the flash family alike; models without cataloged efforts leave the field off.
- **Default MCP** — [`dsh-mcp-stepfun-search`](packages/mcp/mcp-stepfun-search/README.md) mounts StepFun's official **StepSearch** MCP server (`https://api.stepfun.com/step_plan/v1/mcp/web_search/mcp`, Streamable HTTP, Step Plan billing) by default in `dsh-base`. The model gets `mcp__stepfun-search__web_search` and `mcp__stepfun-search__web_fetch`; the bearer key resolves at load from the credentials service or `STEPFUN_API_KEY`, and without a key (or subscription) the tools simply stay unmounted while the composition boots.
- **Voice under Step Plan** — `dsh --profile voice --step-plan` switches the whole profile in one flag: chat requests and the realtime WebSocket both move to the `step_plan` endpoints. The plan's realtime catalog carries `stepaudio-2.5-realtime` (it does not list StepAudio 3 Realtime yet), so the plan channel defaults there while the standard channel keeps `stepaudio-3-realtime-preview`; the realtime protocol is otherwise identical. `--realtime-model` overrides the id explicitly, e.g. `--realtime-model stepaudio-3-realtime-preview` on the standard channel.

### Duplex voice: StepAudio 3 Realtime + the agent executor (`packages/voice/`)

Full-duplex voice interaction where the realtime voice model and the agent model split the work — the realtime session transcribes speech and speaks answers, while every finalized transcript is executed as a task by `step-5-preview`:

- [`dsh-stepfun-realtime`](packages/voice/stepfun-realtime/README.md) — the WebSocket realtime client (`wss://api.stepfun.com/v1/realtime?model=stepaudio-3-realtime-preview`): server VAD with configurable prefix-padding/silence/energy thresholds, PCM16 both ways, typed protocol events tolerant of both shipped transcript-event spellings, injectable transport, and per-channel endpoint + model defaults (`step-plan` → `wss://api.stepfun.com/step_plan/v1/realtime` with `stepaudio-2.5-realtime`);
- [`dsh-voice-agent`](packages/voice/voice-agent/README.md) — the bridge: transcript → agent task → final answer → `response.create` speech → barge-in cancels the spoken response only; every voice turn lands in the durable session log;
- [`dsh-voice-app`](packages/bundle/voice-app/README.md) — the `voice` profile: a stdio JSON-frame bridge (`{"audio": base64}` in, typed events and PCM16 audio out) for any driver process owning the audio devices (ffmpeg wrapper, native app, web frontend).

Run it:

```sh
export STEPFUN_API_KEY=sk-...
pnpm dsh --profile voice                          # JSON-frame bridge on stdin/stdout
pnpm dsh --profile voice --voice tongtong         # pick the speaking voice
pnpm dsh --profile voice --session-id session-…   # resume an existing Session by voice
pnpm dsh --profile voice --step-plan              # Step Plan endpoints, chat + realtime
pnpm dsh --profile voice --step-plan --realtime-model stepaudio-3-realtime-preview   # plan default is 2.5; force 3 explicitly
```

### Web client surfaces follow the fork

The web client's Models page and first-run onboarding now speak the fork's composition instead of pinning the upstream DeepSeek route:

- the Models page renders the `llm-stepfun` card as a curated family — key, endpoint (placeholder shows the resolved default), and the editable model catalog with its endpoint hint stating the public HTTP(S)-only restriction;
- first-run onboarding targets the adapter's own root-namespaced route whatever its id (`stepfun-official` in `llm-stepfun` here), so a fresh deployment is asked for the StepFun key with provider-aware copy instead of silently skipping the step;
- the `/model` popup localizes the built-in `step-5-preview`/`step-3` catalog descriptions.

### Removed from the composition (StepFun-only, for now)

The `dsh-base` bundle no longer mounts: `llm-deepseek`, `llm-pi-ai` (the multi-provider OpenAI/Anthropic/Google/… twin), `deepseek-llm-api-extensions`, `session-log-deepseek`, `plugin-package-inventory-deepseek`, and `web-search-deepseek`. Web search reaches the model through two StepFun routes: the StepSearch MCP above (`mcp__stepfun-search__web_search`/`web_fetch`, billed against the Step Plan subscription's monthly credit — 0.04 CNY per `web_search`, `web_fetch` unbilled) and the seam-level [`dsh-web-search-stepfun`](packages/web/web-search-stepfun/README.md) provider (`web_search` over the open-platform `POST /v1/search`, the route the platform recommends for `step-5-preview`, billed per the open-platform web-search pricing); `web_fetch` stays on the provider-neutral HTTP fetcher. OTel telemetry is switched off by default (its exporter endpoint is an external service this fork does not ship). The packages remain in the repository — they are only unmounted — so upstream merges stay cheap.

## Compatibility notes

- Package names keep the `@deepseek-ai/dsh-*` scope on this branch; rescoping the entire workspace is deliberately out of scope until the fork stabilizes.
- Upstream snapshot/expected-output suites that pin the DeepSeek composition are not updated on this branch; run the new packages' unit suites (`packages/util/url-guard`, `packages/llm/llm-stepfun`, `packages/voice/*`, `packages/mcp/mcp-stepfun-search`, `packages/bundle/voice-app`) for the changed surfaces.
