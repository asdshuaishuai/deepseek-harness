---
description: "StepFun 官方 StepSearch 服务器的默认 MCP 挂载（Streamable HTTP 上的 web_search 与 web_fetch，Step Plan 计费），加载时从凭据面解析 Bearer 密钥。"
kind: "package-reference"
---

# @deepseek-ai/dsh-mcp-stepfun-search

[English](README.md) | 中文

## 概述

把 StepFun 内置的网络工具交给模型：官方 StepSearch MCP 服务器提供 `web_search` 与 `web_fetch`，经 Streamable HTTP 挂载。`web_search` 每次调用 0.04 元、`web_fetch` 不单独计费；两者消耗 Step Plan 订阅的月度 Credit（可用加油包补充、月末清零），并受平台的 QPM／QPH 与并发限流约束。包装插件在加载时解析一次端点与 Bearer 密钥——先凭据服务、后环境——没有密钥时告警一次并保持不挂载，组合的其余部分照常启动。

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

组合要通过平台自己的 MCP（而非 seam 层搜索供应商）联网搜索时选择本包——随附的 `dsh-base` 组合默认挂载。需要任意 MCP 服务器时直接挂 `dsh-mcp-client`；本包装只面向 StepSearch。

### 最小配置

```yaml
- id: stepfun-search-mcp
  name: '@deepseek-ai/dsh-mcp-stepfun-search'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiKeyEnv` | `STEPFUN_API_KEY` | 加载时解析一次的凭据引用 |
| `url` | `$STEPFUN_SEARCH_MCP_URL`，然后是 StepSearch 公网端点 | MCP 端点；按公网 HTTP(S) URL 校验 |
| `serverName` | `stepfun-search` | `mcp__<serverName>__*` 工具名的本地命名空间 |
| `toolCallTimeoutMs` | `60000` | 单次 MCP 工具调用超时 |
| `failOnStartupError` | `false` | 初始连接失败时是否让插件报错 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-mcp-stepfun-search)是所有受支持字段的完整参考。

模型可见的工具名为 `mcp__stepfun-search__web_search` 与 `mcp__stepfun-search__web_fetch`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

`src/index.ts` 是 `dsh-mcp-client` 之上的组合胶水：`resolveSearchOptions` 按公网主机守卫校验端点、按工具名预算校验命名空间；`resolveSearchApiKey` 先读凭据服务、再读可信环境层；`buildSearchMcpConfig` 构造 Streamable HTTP 挂载，其 `Authorization: Bearer` 头携带密钥；`apply` 挂载一个 mcp-client 子实例且不阻塞启动。密钥只在加载时读取——mcp-client 的头集合按连接代次固定，轮换密钥需要重启或 HMR 重载。

-----

<a id="further-exploration"></a>
## 延伸阅读

- [dsh-mcp-client](../mcp-client/README.zh.md) — 底下的传输、重连策略与工具注册。
- [dsh-url-guard](../../util/url-guard/README.zh.md) — 每次挂载都要通过的端点校验。
- [StepSearch MCP 指南](https://platform.stepfun.com/docs/zh/step-plan/integrations/search-mcp) — 平台的服务器文档。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

无。

</details>

<a id="model-experience"></a>
## Model Experience

间接，经由 MCP 客户端。服务器自己的工具 schema、指令与结果文本原样到达模型；本包装不添加自己的提示分节、schema 或结果渲染。

#### KV Cache effect

工具结果像其他工具输出一样进入对话；包含历史搜索结果的未变化前缀仍可复用缓存。

## 已知限制与后续工作
<a id="known-limitations-and-deferred-work"></a>

- 需要 Step Plan 订阅；没有订阅时初始连接失败，监管器的重连预算耗尽后工具缺席，直到重启。
- Bearer 密钥只在加载时解析一次；轮换需要重启或 HMR 重载，且密钥位于子实例的静态头集合内。

以上是当前包的约束，不是任务清单。
