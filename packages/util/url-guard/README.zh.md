---
description: "面向发起服务端 HTTP(S) 或 WS(S) 请求的包的公网端点 URL 校验：在任何连接之前拒绝环回、私网与保留地址。"
kind: "package-library"
---

# @deepseek-ai/dsh-url-guard

[English](README.md) | 中文

## 概述

在发出服务端请求之前先校验目标：只接受 HTTP(S)（实时语音升级为 WS(S)），不允许携带凭据、query 或 fragment，且主机不能是 `localhost` 或环回、私网、链路本地、多播等保留 IP 字面量。守卫操作者配置的调用方使用一次断言；代表不可信输入发起连接的调用方先做 DNS 解析，再用 `isPublicHost` 逐个复查解析结果。

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

### 何时使用

任何根据配置构造服务端请求或套接字的包都应使用：StepFun LLM 适配器校验 `baseURL`，实时语音客户端校验 WebSocket 端点，StepSearch MCP 挂载校验服务器 URL，走的都是这个守卫。

### 入口

```ts
import { assertPublicHttpUrl, isPublicHost } from '@deepseek-ai/dsh-url-guard'

assertPublicHttpUrl('https://api.stepfun.com/v1', 'my-plugin: baseURL') // 通过
isPublicHost('127.0.0.1') // false
```

违例时抛出的错误带有调用方提供的前缀，指明是哪个配置字段；`assertPublicWebSocketUrl` 是实时语音升级用的 WS(S) 孪生断言。

-----

<a id="understand-the-implementation"></a>
## 理解实现

地址分类委托给 `ipaddr.js` 的范围判断：只有 `unicast` 通过，IPv4 映射的 IPv6 按其内嵌地址分类，`localhost` 及其子域按名字拒绝。非字面量主机名通过主机检查——它们是操作者配置而非模型选择的 URL；守卫的契约是对无需 DNS 即可判断的字面量和名字保持失败关闭。

`src/index.ts` 导出 `isPublicHost(hostname)`、`assertPublicHttpUrl(value, owner)` 与 `assertPublicWebSocketUrl(value, owner)`；`tests/url-guard.spec.ts` 固定了接受与拒绝的形状。

-----

<a id="further-exploration"></a>
## 延伸阅读

- [dsh-llm-stepfun](../../llm/llm-stepfun/README.md) — 在配置解析阶段通过本守卫校验端点。
- [dsh-stepfun-realtime](../../voice/stepfun-realtime/README.md) — 在任何连接之前校验 WebSocket 根地址。
- [dsh-mcp-stepfun-search](../../mcp/mcp-stepfun-search/README.md) — 挂载客户端之前校验 StepSearch MCP 端点。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

无。

</details>

<a id="model-experience"></a>
## Model Experience

无。守卫是纯 URL 校验辅助；它不注册任何模型可见内容，校验值本身也不会进入提示词。

#### KV Cache effect

无；本包不贡献任何请求内容。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 非字面量主机名不做 DNS 解析：守卫只判断操作者配置，代表不可信输入的调用方必须自行解析并复查每个结果。

以上是当前包的约束，不是任务清单。
