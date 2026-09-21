---
description: "面向 ctx.compaction 的滑动窗口压缩预设：后台压缩模型在 70% 上下文压力时凝练历史，失败时回退主模型。"
kind: "package-reference"
---

# @deepseek-ai/dsh-compaction-sliding

[English](README.md) | 中文

## 概述

`dsh-compaction-sliding` 是基础压缩后端之上的滑动窗口预设：所用模型上下文达到其窗口的 70% 时，较早历史经后台压缩模型（StepFun Step Plan 通道的 `step-3.7-flash`）凝练为结构化检查点，主模型从不为压缩花费自己的轮次。压缩模型无法服务时，同一轮压缩回退到主模型，且压缩模型在进程生命周期内被禁用。压缩之后，后续每个请求看到的就是检查点加逐字保留的最近对话尾部。

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

在组合中以本包替代 `dsh-compaction-basic` 挂载（两者都提供 `ctx.compaction`；两个引擎会冲突）。默认值即预设：阈值 0.7、压缩模型 `stepfun-official`/`step-3.7-flash`、开启回退。

```yaml
- name: '@deepseek-ai/dsh-compaction-sliding'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `compactorProvider` | `stepfun-official` | 后台压缩模型的提供方路由 |
| `compactorModel` | `step-3.7-flash` | 压缩模型；后台摘要请求的目标 |
| `compactorFallbackToMain` | `true` | `false` 时直接上抛压缩器错误而非回退 |
| （所有 `dsh-compaction-basic` 字段） | 基础默认值 | `thresholdRatio` 在此处默认为 `0.7`；其余原样透传 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-compaction-sliding)是所有接受字段及其 JSDoc 的详尽来源。

### 滑动窗口行为

压力由共享 token meter 按 `thresholdRatio × contextWindow`（默认 70%）对照所用模型度量。越过后先运行可选的工具结果修剪器，再把最老的可行区间凝练为检查点，同时保留策略使最近的对话逐字保留——窗口向前滑动。辅助摘要调用是经 `ctx.llm.stream`、以 `purpose: 'compaction'` 发起的一次性后台调用：对话模型从不参与，检查点事件会持久记录是哪个压缩模型写了摘要。

### 压缩模型回退

每次压缩都会先尝试压缩模型。除取消之外的任何失败，同一轮压缩立即改由路由主模型完成，并且该压缩模型在进程生命周期内被禁用——「没有 3.7-flash」（例如开放平台标准通道）是持久事实而非瞬态。`compactorFallbackToMain: false` 时直接上抛压缩器错误。显式配置的 `summarizationModel`（配置或路由模型自身的策略）永远优先于本预设。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

本节解释预设背后的设计决策；可观察行为已全部覆盖在[使用本包](#use-this-package)中。

### 设计理念

- **除目标之外一切都是基础后端。** 触发、保留、摘要格式与持久化事件协议是基础引擎固定的重放策略；本包只拥有一个决策——由哪个模型写摘要。
- **回退是持久的，而非按次。** 失败过一次的压缩模型（通道上未知的模型、提供方拒绝）在进程生命周期内禁用，因此没有 flash 模型的部署只为这次失败付出一次尝试代价，而不是每次压缩都重试。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `SlidingCompactionEngine`：预设默认值、压缩器尝试、回退策略 |

摘要调用、检查点框架、区间选择与事件均为 `dsh-compaction-basic` 所有，并在其文档中说明。

### 请求与回退流程

`summarize()` 在显式配置了摘要模型（配置或路由模型自身的策略——所有者的刻意选择优先于预设）或路由模型本身就是压缩模型时直接让路。否则它经 `summarizeWithLlm` 驱动压缩模型；失败（取消除外）会将压缩模型标记为禁用，并把同一输入重新交给基础引擎的路由模型路径。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [压缩家族地图](../README.zh.md) — 四包家族与各自职责。
- [dsh-compaction](../compaction/README.zh.md) — 共享的凝练契约与摘要事件协议。
- [dsh-compaction-basic](../compaction-basic/README.zh.md) — 本预设扩展的后端：触发、保留与检查点框架。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-compaction-sliding) — 所有接受字段及其源声明。

-----

<a id="model-experience"></a>
## Model Experience

通过 `dsh-tool-web` 间接影响模型体验的说法不适用于本包：压缩检查点与压缩器请求都是模型可见输入，因此本包携带与 `dsh-compaction-basic` 相同结构的两条模型上下文条目。

### Conversation history

#### What the model sees

After a successful step crosses 70% of the routed model's window, oversized tool results are first rewritten when the optional pruner is loaded. If summarization remains necessary, the next request receives the checkpoint preamble below, a blank line, `<compacted-summary>`, the data-dependent summary, and `</compacted-summary>`, followed by the most recent conversation tail retained verbatim. Overflow recovery rebuilds the immediate retry from whatever replacement advanced the surface.

##### Conversation checkpoint preamble

```markdown
This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.
```

#### Token effect

The replacement reduces future input history rather than appending a second copy: the compacted older range becomes one bounded checkpoint, and the retained recent tail stays verbatim. A checkpoint remains until a later compaction replaces it.

#### KV Cache effect

Replacing rather than append-only. Each checkpoint invalidates reuse from the first replaced history token; the unchanged request prefix before that range remains reusable.

### Background compactor request

#### What the model sees

The compactor model receives the conversation replayed verbatim — the same system prompt, tool schemas, and messages the last routed request sent for the shadowed region — followed by one final user message: the compaction instruction. The conversation model never sees this private request or its reasoning; only returned text is stored.

##### Compaction instruction (final user message)

```markdown
You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.
```

#### Token effect

One bounded auxiliary request per compaction, capped by `maxTokens`; the durable checkpoint event records the compactor's provider, model, and reported usage so the one-shot request is reconstructable from the log.

#### KV Cache effect

Cache-reusing by construction: the auxiliary call replays the routed request's exact prefix (system prompt, tools, messages) and appends only the compaction instruction, so the provider's warm prefix cache serves the replay instead of a cold re-read.

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明预设不适用的场景。它们是当前包约束。

- **压缩器尝试绕过按模型的摘要策略** —— 路由模型的策略摘要器只作用于回退路径；策略里命名了不同摘要器（设置了 `summarizationModel`）会整体关闭本预设。
- **压缩器失败是进程级粘性** —— 瞬态拒绝（限流）会让部署永久切换为主模型压缩，直到重启；按次重试窗口等待提供方中立的服务字段。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与未定方向。它明确不具备权威性——已交付的行为、限制与依据以上文各节及链接的 Agent Notes 为准。

#### 未来：感知通路的压缩模型默认值

默认压缩模型 id（`step-3.7-flash`）是 Step Plan 目录模型。在开放平台标准通道上，首次压缩会付出一次失败尝试后才回退。读取 chat 适配器的通路来播种默认值（或在彼处提供 flash 模型）需要先有提供方中立的模型可用性字段。

</details>
