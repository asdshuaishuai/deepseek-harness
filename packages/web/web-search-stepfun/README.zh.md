---
description: "面向 ctx.web 的 StepFun Search API 搜索提供方：step-5-preview 的开放平台 web_search 路径，逐请求解析凭据并明示计费规则。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-stepfun

[English](README.md) | 中文

## 概述

通过 `dsh-web-search-stepfun`，harness 经由 StepFun Search API（`POST /v1/search`）搜索网络——这是 StepFun 官方文档为 `step-5-preview` 推荐的开放平台路径，因为该模型的 Chat Completions 请求不支持内置 `web_search` 工具。每条结果都是带 URL 与索引摘要的索引记录；没有生成式答案，因此结果不携带 `content`。没有可用 URL 的记录会被丢弃，因此单次调用返回的来源可能少于请求数量。面向模型的 `web_search` 工具位于 `dsh-tool-web`。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在已加载 web 服务的组合中挂载本提供方；它注册为 `stepfun` 搜索提供方，当它是唯一可用的搜索后端时 `ctx.web.search()` 会自动解析到它——也可以用 `searchProvider: stepfun` 显式指定。

### 何时选择它

持有开放平台 StepFun Key 的部署选择此后端：调用按开放平台网络搜索计价计费，与任何 Step Plan 订阅相互独立。持有 Step Plan 订阅时，[`dsh-mcp-stepfun-search`](../../mcp/mcp-stepfun-search/README.zh.md) 挂载提供同样的两项能力（`web_search` 每次 0.04 元、`web_fetch` 不单独计费），改从订阅的月度 Credit 中扣减——本 fork 的基础组合两条路径都随附，可按需删除任意一行。

### 最小配置

加载 web 服务与本提供方即可；密钥逐搜索解析——先查凭据服务（web 模型页写入 `STEPFUN_API_KEY`），再回退启动环境中的 `$STEPFUN_API_KEY`——其余设置都有安全默认值。

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-stepfun'
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | （未设置） | 字面密钥；优先使用 `apiKeyEnv`，避免密钥进入配置文件 |
| `apiKeyEnv` | `STEPFUN_API_KEY` | 每次搜索解析的凭据引用 |
| `baseURL` | `https://api.stepfun.com/v1` | 端点基址；追加 `/search`。配置缺省时应用 `$STEPFUN_SEARCH_BASE_URL` |
| `numResults` | `5` | 请求未带 `maxResults` 时作为 API `n` 发送的默认结果数 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-stepfun)是所有接受字段及其 JSDoc 的详尽来源。

### 搜索返回什么

每条结果记录映射为一个 `WebSearchSource`：`url`，以及记录中非空白的 `title` 与 `snippet`。没有可用 URL 的记录无法引用任何内容，会被丢弃。请求的 `maxResults` 优先于配置的 `numResults` 默认值，并作为 API 的 `n` 发送——最终上限由服务层执行，会截断并标记。

### 失败与恢复

无密钥的搜索会失败并抛出 `WebError` `WEB_PROVIDER_ERROR`，错误信息指明应存储的凭据引用。提供方失败——HTTP 错误、网络失败、无法解析或形状不符的响应体——都以 `WEB_PROVIDER_ERROR` 呈现；被取消的请求以 `WEB_ABORTED` 呈现。HTTP 重定向在联系 `Location` 目标之前即被拒绝。调用方按错误码路由；面向模型的 `web_search` 工具在自身的错误包装下把失败呈现给模型。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

本节解释提供方背后的设计决策；可观察行为已全部覆盖在[使用本包](#use-this-package)中。

### 设计理念

提供方是对直连检索端点的薄适配器，有两条刻意的规则：

- **索引记录保持为记录。** API 返回标题、URL 和摘要——没有模型生成的答案——因此省略 `content`，不虚构模型可能轻信的提供方文本。
- **密钥延迟解析。** 每次搜索都会快照设置分节并经其解析凭据，因此已提交的变更作用于下一次搜索而无需重新注册提供方，被拒绝的设置代也无法把它的密钥泄漏到上一个端点。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、凭据与环境解析、提供方注册 |
| [`src/provider.ts`](src/provider.ts) | `StepFunSearchProvider`：请求派发、取消分类、结果映射 |
| [`src/types.ts`](src/types.ts) | StepFun wire 类型：`StepFunSearchResponse`、`StepFunSearchResultItem`、`StepFunSearchErrorBody` |
| — | 不发布运行时不变量伴侣；除所属 seam 强制的契约外，本包不暴露独立的事件序列或可变数据关系。 |

### 请求与映射流程

`search()` 向 `{baseURL}/search` 发送查询与结果数量，并使用 `redirect: 'error'`，因此重定向会让请求失败而不接触目标。解析出的 `results[]` 逐条映射；无 URL 的条目丢弃，空白字段省略。取消——名为 `AbortError` 的 `DOMException`——变为 `WEB_ABORTED`；其余皆变为 `WEB_PROVIDER_ERROR`。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级契约不够用时阅读这些页面。它们从共享词汇延伸到服务、面向模型的工具与设计依据。

- [Web 子系统](../../../docs/subsystems/web.zh.md) — 详尽的搜索请求/结果词汇与错误码。
- [Web 包地图](../README.zh.md) — 包家族与各自职责。
- [dsh-web](../web/README.zh.md) — 本提供方注册进的 web 服务。
- [dsh-tool-web](../tool-web/README.zh.md) — 渲染本提供方来源的面向模型的 `web_search` 工具。
- [dsh-mcp-stepfun-search](../../mcp/mcp-stepfun-search/README.zh.md) — StepSearch MCP，同一厂商能力在 Step Plan 计费下的形态。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-stepfun) — 所有接受字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

通过 `dsh-tool-web` 间接影响模型体验。该工具保留本提供方的结果 URL、标题与 snippet；如果发生失败，则会在消费方的错误包装层内保留原样错误消息 `StepFun search aborted`、`StepFun search request failed: <error>` 和 `StepFun returned an unprocessable response body: <error>`。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明提供方在哪些情况下不合适。它们是当前包约束。

- **`query` 与 `n` 之外的 API 控制项未暴露** — 更新或限定域名的检索等待提供方中立的服务字段（[seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)）。
- **取消分类基于错误形状** — 只有名为 `AbortError` 的 `DOMException` 映射为 `WEB_ABORTED`；携带自定义原因的取消（如 `dsh-timeout` 的 `TimeoutReason`）以 `WEB_PROVIDER_ERROR` 呈现。
- **计费走开放平台而非 Step Plan** — 调用按开放平台网络搜索计价计费；希望走订阅额度的 Step Plan 部署应保留 StepSearch MCP 并删除本行。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与未定方向。它明确不具备权威性——已交付的行为、限制与依据以上文各节及链接的 Agent Notes 为准。

#### 未来：感知通路的搜索路由

本提供方不读取 `llm-stepfun` 的通路选择：在 `step-plan` 部署上，StepSearch MCP 覆盖订阅计费的搜索，而本行仍响应开放平台工具。按通路单向路由需要先有提供方中立的服务字段。

</details>
