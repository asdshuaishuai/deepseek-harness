---
description: "voice profile 层：在 dsh-base 之上经 stdio JSON 帧桥进行 StepAudio 3 Realtime 双工对话；--step-plan 一键把 chat 与 realtime 切到 Step Plan 通道。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-voice-app

[English](README.md) | 中文

## 概述

运行 `dsh --profile voice` 即可获得基于普通 agent 循环的双工语音对话：定稿转写变成 agent 任务，回答被读出，每个轮次都落入持久会话日志。runner 以 stdio JSON 帧桥与任意驱动进程对话。`--step-plan` 把整个 profile 切到 Step Plan 订阅端点；`--voice` 与 `--session-id` 选择音色并恢复会话。

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

### 安装进 profile

`voice` profile 已组合本 bundle；`dsh --profile voice` 从当前检出解析。bundle 补丁在 `dsh-base` 之上插入 startup、realtime、agent 与 runner 行，并覆盖 `llm-stepfun` 行——增删它会重塑整个语音面。

```text
dsh --profile voice
dsh --profile voice --voice tongtong
dsh --profile voice --step-plan
dsh --profile voice --realtime-model stepaudio-2.5-realtime
dsh --profile voice --session-id session-…
```

### 你会得到什么

一个在 stdin/stdout 上说换行分隔 JSON 的进程：输入帧为 `{"audio":"<base64 PCM16 16 kHz mono>"}` 与 `{"commit":true}`；输出事件为 `ready`（会话 id 与实际生效的 realtime 模型）、`state`、`user-transcript`、`assistant-delta`、`assistant-final`、`audio`（base64 PCM16 24 kHz mono）、`error` 与 `closed`。字幕镜像到 stderr，stdout 保持纯 JSON 流。

用拥有音频设备的进程包装它；ffmpeg 以 raw PCM16 16 kHz mono 采集麦克风并以 24 kHz mono 播放回答：

```sh
ffmpeg -f avfoundation -i ":0" -f s16le -ar 16000 -ac 1 pipe:1 | <把帧喂给 dsh --profile voice>
# 并播放 audio 事件： ffplay -nodisp -autoexit -f s16le -ar 24000 -ac 1 -i pipe:0
```

`--step-plan` 一键翻转两半：chat 请求发往 `https://api.stepfun.com/step_plan/v1`，realtime 会话连 `wss://api.stepfun.com/step_plan/v1/realtime`，说 plan 支持的 `stepaudio-3-realtime-preview`。无论哪种方式，设置里的 `llm-stepfun:` 分节仍可覆盖 chat 行。

-----

<a id="understand-the-implementation"></a>
## 理解实现

`cordis.patch.yml` 插入 `voice-startup`（把 profile 的旗标族解析进 `ctx.voiceStartup` 的 commander 程序）、`stepfun-realtime` 与 `voice-agent`（都注入 `voiceStartup`，让 `--voice`、通道与模型覆盖到达它们）以及 `voice-runner`；并以同一通道表达式覆盖 `llm-stepfun`。`src/startup.ts` 拥有旗标；`src/stdio-bridge.ts` 编解码 JSON 帧；`src/index.ts` 绑定一条会话并在 stdin 结束时退出。HMR 被禁用——桥进程单次运行。

-----

<a id="further-exploration"></a>
## 延伸阅读

- [dsh-voice-agent](../../voice/voice-agent/README.zh.md) — runner 驱动的会话桥。
- [dsh-stepfun-realtime](../../voice/stepfun-realtime/README.zh.md) — realtime 传输与通道选择。
- [Step Plan 总览](https://platform.stepfun.com/docs/zh/step-plan/overview) — `--step-plan` 背后的订阅通道。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

无。

</details>

<a id="model-experience"></a>
## Model Experience

间接，经由它挂载的行。bundle 是补丁列表载体；语音行安装的 persona 后缀（"回答会被读出"）与被挂载包的注册拥有全部模型可见效果。

#### KV Cache effect

persona 后缀只为 voice profile 改写系统提示；会话内部前缀照常稳定并可复用缓存。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- runner 不拥有音频设备：采集与播放属于包装桥的驱动进程。
- 一个桥进程持有一条会话；多会话路由是驱动的职责。

以上是当前包的约束，不是任务清单。
