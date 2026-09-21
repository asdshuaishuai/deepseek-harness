---
description: "Web GUI 的语音面：输入坞中的麦克风开关，一键与固定实时模型开启双工对话并显示实时字幕；面向浏览器语音体验的用户与维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-voice

[English](README.md) | 中文

## 概述

Web GUI 语音面在输入坞中放置一个麦克风开关。单击即可通过宿主的 `/voice` 桥接开启双工语音对话：浏览器通过内联 AudioWorklet 采集麦克风音频（16 kHz PCM16）上行，固定的实时模型以 24 kHz 音频与实时字幕应答，双方说话即可互相打断。控制器进程局限于浏览器标签页；持久会话身份与模型 id 一律来自宿主桥接，而非客户端。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将本插件与 `ui-conversation`、locale 插件以及宿主侧的 `dsh-voice-web-bridge` 一同挂载；麦克风开关即出现在输入坞（目标条之后）。点击后为当前会话启动语音循环：阶段徽标显示 `正在听`/`思考中`/`回答中`，同时展示固定的实时模型 id，字幕行滚动最新的转写或回答。再次点击结束对话但保留套接字供下次开启；离开页面或关闭时释放麦克风与套接字。

坞面文案通过本插件注册的 `voice` locale 命名空间提供中英文双语。

### 阶段与字幕

`空闲` 只显示麦克风按钮。激活后显示条带：阶段徽标、固定模型、字幕行（优先助手回答，其次最新用户转写，否则显示开始提示），以及可恢复错误的内联提示。打断（回答播放期间宿主回落到 `正在听`）会丢弃尚未播放的缓冲音频，播放永远不落后于打断。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

每个浏览器标签页一个 `VoiceController`，持有 `/voice` 套接字、麦克风采集与回答播放器，并向通过 `useSyncExternalStore` 订阅的坞面发布不可变的视图快照。采集由内联 AudioWorklet 将麦克风流降采样到 16 kHz 并按约 100 ms 的浮点块输出；编解码层将其转为 base64 PCM16 发往桥接，回答帧（24 kHz base64 PCM16）按顺序排在音频时钟上播放。所有触及设备或网络的环节都藏在可注入的接缝之后，因此状态机可以在 jsdom 中用假 WebSocket 测试；生产工厂在挂载时接入 `getUserMedia`、`AudioContext` 与 `window.location`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [dsh-voice-web-bridge](../../voice/voice-web-bridge/README.zh.md) — 本包所对话的 `/voice` 套接字的宿主侧。
- [dsh-voice-agent](../../voice/voice-agent/README.zh.md) — 桥接为每个套接字绑定的对话。
- [客户端包地图](../README.zh.md) — 相邻的浏览器 UI 包。

-----

<a id="model-experience"></a>
## 模型体验

无；此面只呈现宿主固定的语音对话，不向模型输入添加内容。

#### KV 缓存影响

无；浏览器不持有请求前缀。通过持久 `sessionId` 恢复的新对话由宿主侧还原历史。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义了浏览器语音面何时不是合适的选择。它们是当前包的既有约束。

- **每个标签页一场对话** — 控制器进程局限；后台标签页会挂起音频 worklet，第二个语音面需要显式的多路复用层。
- **无离线或半开恢复** — 套接字断开将界面重置为空闲；按 `sessionId` 恢复只还原宿主侧历史，不还原在途音频。
- **依赖权限的启动** — `getUserMedia` 被拒绝时首次启动会内联报错；尚无设置页深链。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与未定方向。它明确不具权威性——已发布的行为、限制与理由见上文各节。

#### 未来：语音起源的文本输入

字幕目前仅作展示。把定稿的用户转写灌入输入框草稿（或提供口述提示历史）有待产品决策：语音轮次应以何种形态进入持久日志。

</details>
