---
description: "voice 包组：基于 StepFun realtime WebSocket 的双工语音对话——传输客户端、agent 桥与 profile 层。"
kind: "package-group"
---

# Voice（语音）

[English](README.md) | 中文

## 概述

`voice/` 组承载双工语音对话栈：一条 StepAudio 3 Realtime WebSocket 会话在服务端转写语音，每条定稿转写都成为普通的 agent 任务，该轮的最终回答经同一会话读出。传输包拥有协议；agent 包拥有配对策略；bundle 层暴露 `voice` profile。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

传输客户端与会话桥组合使用；bundle 层为 CLI profile 同时挂载两者。

| 包 | 提供什么 |
|---|---|
| [`stepfun-realtime/`](stepfun-realtime/README.zh.md) | realtime WebSocket 客户端（标准与 Step Plan 通道），带类型化事件与可注入传输 |
| [`voice-agent/`](voice-agent/README.zh.md) | 把一条 realtime 会话绑定到一个持久 Agent 的桥 |

-----

<a id="related-documentation"></a>
## 相关文档

- [Voice 子系统参考](../../docs/subsystems/voice.zh.md) — 该子系统的服务与事件词汇。
- [dsh-voice-app](../bundle/voice-app/README.zh.md) — `dsh-base` 之上的 `voice` profile 层。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

无。

</details>
