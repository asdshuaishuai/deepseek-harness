---
description: "面向 ctx.voiceAgent 的主机侧浏览器语音桥：每条双工语音会话一条 /voice WebSocket，经令牌认证，realtime 模型固定在主机侧。"
kind: "package-reference"
---

# @deepseek-ai/dsh-voice-web-bridge

[English](README.md) | 中文

## 概述

`dsh-voice-web-bridge` 把双工语音对话带到浏览器：每条会话一条 `/voice` WebSocket，经连接信任面做令牌认证。浏览器发送麦克风帧（二进制 PCM16 16 kHz 单声道）与 JSON 控制帧（`start`/`commit`/`stop`）；桥在主机侧把它们绑定到 `ctx.voiceAgent`——API Key 永远不会到达浏览器——并把状态、转写、字幕、最终文本与 24 kHz PCM16 音频流回。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [Model Experience](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在已加载 web 服务、连接信任面、`dsh-stepfun-realtime` 与 `dsh-voice-agent` 的组合中挂载——即 web profile 的行。无密钥部署照常启动：桥持有 `/voice` 并按连接报告缺失的凭据，而不是让组合失败。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `path` | `/voice` | 本桥持有的精确升级路径 |

### 线协议

浏览器 → 主机：`{"type":"start","sessionId?":"..."}`（打开，可选恢复持久 Session）、`{"type":"commit"}`（强制话语边界）、`{"type":"stop"}`（结束对话；socket 保持打开），以及 PCM16 16 kHz 单声道麦克风音频二进制帧（单帧上限 256 KiB）。

主机 → 浏览器：`ready {sessionId, realtimeModel}`、`state`（`listening|thinking|speaking`）、`user-transcript`、`assistant-delta`、`assistant-final`、二进制 24 kHz PCM16 回答音频、`error`、`closed`。

一条 socket 承载一条对话：第二个 `start` 会被拒绝；`stop` 之后允许新的 `start`；socket 断开会关闭对话（以 `sessionId` 恢复可保留持久转写历史）。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

升级处理器先向连接信任面请求拒绝（401/403），再把 socket 交给 `ws` 并包进每 socket 一个的 `VoiceSocketSession`：控制帧驱动状态机，二进制帧 1:1 进入 `conversation.sendAudio`，对话事件以 JSON 文本帧或二进制音频回流。取消或掉线的响应会发出 `closed` 并关闭 socket，客户端重连进入新对话（以 `sessionId` 恢复持久日志）。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [语音家族地图](../README.zh.md) — realtime 客户端、语音 agent 与 CLI 桥。
- [dsh-voice-agent](../voice-agent/README.zh.md) — 本桥每 socket 绑定的对话。
- [dsh-stepfun-realtime](../stepfun-realtime/README.zh.md) — 按计费通道固定的 realtime 模型。

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-voice-agent`: the bridge forwards microphone bytes and conversation events verbatim, and the voice agent owns every model-visible request and spoken answer.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明本桥不适用的场景。它们是当前包约束。

- **每 socket 一条对话** —— 同一浏览器标签页的多路双工对话需要本桥之上的多路复用层。
- **主机重启后无法恢复实时会话** —— 持久 `sessionId` 恢复转写历史，但 realtime 会话本身从静默重新开始。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与未定方向。它明确不具备权威性——已交付的行为、限制与依据以上文各节为准。

#### 未来：按帧背压

本桥 1:1 转发音频帧，输入端有 256 KiB 上限，输出方向没有主机侧队列上限；慢速浏览器客户端依赖 WebSocket 背压。有界发送队列加丢最旧策略等待设备差异的观察结果。

</details>
