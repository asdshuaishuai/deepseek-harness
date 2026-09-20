---
description: "双工语音桥：把一条 StepAudio 3 Realtime 会话绑定到一个持久 Agent——转写变成 agent 任务，最终回答被读出，打断只取消语音。"
kind: "package-reference"
---

# @deepseek-ai/dsh-voice-agent

[English](README.md) | 中文

## 概述

在一个持久 Agent 上进行语音对话：服务端 VAD 把每句话定稿为转写，每条转写都成为由配置的主力模型执行的 agent 任务，该轮的最终 assistant 文本经由同一条 realtime 会话读出。打断（播放回答时用户开口）只取消语音，agent 轮本身照常跑完。传入 `sessionId` 可恢复会话；持久会话日志保留每个语音来源的轮次。

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

组合想要基于普通 agent 循环（工具、会话日志、模型选择）的语音对话时选择本包，而不是裸 realtime 传输。传输来自 `dsh-stepfun-realtime`；本桥拥有配对策略。

### 最小配置

```yaml
- id: voice-agent
  name: '@deepseek-ai/dsh-voice-agent'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `voice` | 平台默认 | 透传给 realtime 会话 |
| `instructions` | 消费方的 | 插件默认之上的 realtime 侧系统指令 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-voice-agent)是所有受支持字段的完整参考。

插件提供 `ctx.voiceAgent`；`createConversation({ sessionId?, realtime? }, events)` 把一条 realtime 会话绑定到一个 Agent 并返回 `VoiceConversation`：麦克风帧经 `sendAudio` 进入，语音回答以 base64 PCM16 从 `onAudio` 输出，回调报告 `state`（`listening`/`thinking`/`speaking`）、用户转写、字幕增量与最终回答。

-----

<a id="understand-the-implementation"></a>
## 理解实现

`src/conversation.ts` 围绕 realtime 会话接线 `agent/assistant-stream`（把该轮文本累积成字幕增量）与 `agent/status`（空闲标记回答就绪）：定稿转写经 `agent.followup` 进入——轮次忙碌时排队安全——排空循环轮询 `whenIdle`，定稿的回答经 `response.create` 读出，打断只取消语音。`src/index.ts` 在 `stepfunRealtime`、`agents`、`sessions`、`agentDefaultModel` 服务之上提供 `ctx.voiceAgent`。

-----

<a id="further-exploration"></a>
## 延伸阅读

- [dsh-stepfun-realtime](../stepfun-realtime/README.zh.md) — 本桥消费的传输。
- [dsh-voice-app](../../bundle/voice-app/README.zh.md) — 经 stdio 桥驱动本服务的 `voice` profile。
- [Agent loop](../../core/agent-loop/README.zh.md) — 本桥提交任务进入的轮次生命周期。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

无。

</details>

<a id="model-experience"></a>
## Model Experience

间接，经由 agent 循环。定稿转写成为普通的用户消息，读出的回答是该轮普通的最终文本；本桥不添加自己的提示文本或 schema。realtime 模型自己的会话留在服务端。

#### KV Cache effect

语音来源的轮次复用 agent 的普通前缀；本桥既不改变请求组装，也不改变历史字节。

## 已知限制与后续工作
<a id="known-limitations-and-deferred-work"></a>

- 一次会话恰好绑定一个 Agent 与一条 realtime 会话；多说话人或并发会话不在范围内。
- 字幕增量只流式输出该轮的组装文本，不含推理块。

以上是当前包的约束，不是任务清单。
