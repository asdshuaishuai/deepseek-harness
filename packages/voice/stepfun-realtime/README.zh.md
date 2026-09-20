---
description: "StepAudio 3 Realtime 双工语音 WebSocket 客户端（标准与 Step Plan 通道，stepaudio-3-realtime-preview），带公网端点校验与可注入传输。"
kind: "package-reference"
---

# @deepseek-ai/dsh-stepfun-realtime

[English](README.md) | 中文

## 概述

面向 StepFun realtime WebSocket 打开一条双工语音会话：服务端 VAD 把话语切分为转写，语音回答以 PCM16 音频帧返回，事件词汇以带类型的回调呈现。通过配置选择标准通道或 Step Plan 订阅端点；两者都说 `stepaudio-3-realtime-preview`，可用 `model` 覆盖。会话策略——把语音轮次与 agent 配对——属于 `dsh-voice-agent` 这类消费方。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [Model Experience](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 何时选择

组合需要裸 realtime 会话时选择本包——转写语音、播报文本、打断时取消语音回答。若要把该会话绑定到持久的 harness Agent，改挂消费本服务的 `dsh-voice-agent`。

### 最小配置

```yaml
- id: stepfun-realtime
  name: '@deepseek-ai/dsh-stepfun-realtime'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `channel` | `standard` | `standard`（`wss://api.stepfun.com/v1/realtime`）或 `step-plan`（`wss://api.stepfun.com/step_plan/v1/realtime`） |
| `apiKeyEnv` | `STEPFUN_API_KEY` | 逐会话解析的凭据引用 |
| `baseURL` | 通道端点，或 `$STEPFUN_REALTIME_URL` | WS(S) 根地址；任何连接前按公网端点校验 |
| `model` | `stepaudio-3-realtime-preview`，或 `$STEPFUN_REALTIME_MODEL` | 以 `?model=` 发送的实时模型 id |
| `voice` | 平台默认 | 模型说话使用的音色 |
| `connectTimeoutMs` | `10000` | `session.created` 握手上限 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-stepfun-realtime)是所有受支持字段的完整参考。

插件提供 `ctx.stepfunRealtime`；`createSession(overrides, events)` 打开会话并返回传输层的 `RealtimeSession`（`appendAudio`、`commit`、`speak`、`cancelResponse`、`close`）。

-----

<a id="understand-the-implementation"></a>
## 理解实现

`src/session.ts` 拥有谨慎的 `open()` 握手——跨 settle 捕获消费方回调、在 `session.created` 应答上重装 `session.update`——以及轮次词汇；`src/transport.ts` 是可注入的 `RealtimeTransportFactory`（测试替身它；生产用全局 WebSocket）；`src/index.ts` 把通道、端点、模型与凭据解析进 `ctx.stepfunRealtime`。音频为 PCM16：输入 16 kHz、输出 24 kHz；服务端拥有 VAD，并为打断发出 `speech_started`/`speech_stopped`。

-----

<a id="further-exploration"></a>
## 延伸阅读

- [dsh-voice-agent](../voice-agent/README.zh.md) — 消费本服务的会话桥。
- [dsh-voice-app](../../bundle/voice-app/README.zh.md) — 通过 `--step-plan` 接线通道的 `voice` profile。
- [StepAudio 3 Realtime 指南](https://platform.stepfun.com/docs/zh/guides/models/stepaudio-3-realtime) — 平台的 realtime 协议文档。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

无。

</details>

<a id="model-experience"></a>
## Model Experience

间接，经由会话桥。realtime 模型本身在服务端运行，其转写与语音不直接进入 agent 请求；`dsh-voice-agent` 负责把定稿转写变成 agent 任务、把 assistant 文本变成语音。

#### KV Cache effect

对 agent 请求无影响；realtime 轮次是独立的供应商会话，有自己的服务端状态。

## 已知限制与后续工作
<a id="known-limitations-and-deferred-work"></a>

- `stepaudio-3-realtime-preview` 是限免期模型 id；付费版本上线后平台会更换名称——届时用 `model` 或 `$STEPFUN_REALTIME_MODEL` 覆盖。
- 会话仅限传输层：转写持久化、排队与 agent 配对都不在本包。

以上是当前包的约束，不是任务清单。
