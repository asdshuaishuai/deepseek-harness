---
description: "StepFun chat-completions 适配器（step-5-preview 主力、Step Plan 订阅通道、flash 系列可选推理力度），逐请求解析凭据并校验公网端点。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-stepfun

[English](README.md) | 中文

## 概述

在 StepFun 的 OpenAI 兼容 Chat Completions API 上运行 agent 轮次：`step-5-preview` 支持文本与图像输入、1M token 上下文与自动思考；Step Plan 订阅通道提供 flash 系列与可选推理力度。端点、凭据与模型目录逐请求从 `llm-stepfun:` 设置分节解析；端点在任何请求前都会先通过公网 HTTP(S) 根校验。图像以内联 base64 data-URL 形式发送，受路由字节与数量预算约束。

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

在已注册 `llm` 服务的组合中挂载本适配器；随附的 `dsh-base` 组合已将其作为唯一供应商引入。

### 何时选择

面向 StepFun 平台时选择本包——默认按开放平台计费，或通过 `channel: step-plan` 走 Step Plan 订阅。需要其他供应商时改挂对应适配器；本 fork 的组合只随附 StepFun。

### 最小配置

```yaml
- id: llm-stepfun
  name: '@deepseek-ai/dsh-llm-stepfun'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `channel` | `standard` | `standard`（开放平台）或 `step-plan`（订阅端点与目录） |
| `apiKeyEnv` | `STEPFUN_API_KEY` | 逐请求解析的凭据引用 |
| `baseURL` | 通道公网 API，或 `$STEPFUN_BASE_URL` | chat-completions 根地址；按公网 HTTP(S) 根校验 |
| `maxTokens` | `65536` | 默认逐请求输出上限 |
| `models` | 通道目录 | 面向发现消费方的建议模型目录 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-llm-stepfun)是所有受支持字段的完整参考。

Step Plan 目录：`step-5-preview`（1M，文本 + 图像，自动思考）、`step-3.7-flash`（256K，文本 + 图像，力度 `low`/`medium`/`high`）、`step-3.5-flash`、`step-3.5-flash-2603`（力度 `low`/`high`）与 `step-router-v1`（按任务复杂度把每一轮路由给 `step-5-preview` 或 `step-3.5-flash`）。

-----

<a id="understand-the-implementation"></a>
## 理解实现

`src/adapter.ts` 以 SSE 流式调用 `POST {baseURL}/chat/completions`（`[DONE]` 哨兵），带归因头、空闲看门狗与供应商错误映射；`src/config.ts` 拥有 `resolveAdapterOptions`——从原始配置到已校验连接事实的唯一显式解析步骤（边界在 schema 之外再次判定）。`src/protocol/` 把 harness 消息序列化上线——assistant 历史回放 `reasoning_content` 与 `tool_calls`，工具结果以 `role: 'tool'` 消息承载，图像在确定性卸载之后以 base64 data-URL 内联——`src/common/` 承载目录与 model-info 投影。设置分节热更新，出错时保留上一份可用配置。

-----

<a id="further-exploration"></a>
## 延伸阅读

- [dsh-url-guard](../../util/url-guard/README.zh.md) — 每个请求目标都要通过的公网端点校验。
- [dsh-stepfun-realtime](../../voice/stepfun-realtime/README.zh.md) — 共享同一凭据面的双工语音客户端。
- [Step Plan 总览](https://platform.stepfun.com/docs/zh/step-plan/overview) — 订阅通道的模型与 MCP 文档。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

无。

</details>

<a id="model-experience"></a>
## Model Experience

### StepFun chat-completions 请求

#### What the model sees

选定的 StepFun 模型收到 harness 系统提示、消息历史、工具 schema、停止序列与调用配置（`maxTokens`、`reasoningEffort`、`temperature`），不含适配器自撰的提示文本。推理以 `reasoning_content` 增量产出的 `reasoning` 块呈现；请求不携带思考开关——Step 5 系列为自动思考，flash 系列选定的力度序列化为 `reasoning_effort`。支持图像的模型收到保留的用户与工具结果图像（base64 data-URL，附 attachment 句柄与请求预览尺寸），被卸载的出现替换为占位文本。

#### Token effect

供应商分词决定精确文本输入；适配器报告流式 `usage` 并以其为准。卸载决策确定性地把最旧的图像出现替换为占位文本，压力下的重复请求每次计价一致。

#### KV Cache effect

未变化的已组装前缀有资格复用供应商缓存。确定性的请求图像字节并不使整个前缀不可变：执行环境路径变化会改写历史描述文本，卸载决策也会在后续轮次把图像部分替换为占位文本。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 未实现 Anthropic 兼容的 `/step_plan` Messages 协议；Step Plan 通道走 OpenAI 兼容的 `/step_plan/v1` 根。
- 无 Files API：chat 图像以 base64 data-URL 内联，受路由预算约束。
- Step 5 系列没有可选推理力度；请求不为其携带思考字段。

以上划定了适配器的边界与后续工作起点。它们是当前包的约束，不是泛泛的 StepFun 对比或任务清单。
