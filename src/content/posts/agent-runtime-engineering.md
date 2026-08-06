---
title: "Agent Runtime 不是模型外壳：从循环、状态到可靠执行"
published: 2026-08-05
description: "从一次 Agent Run 的完整数据流出发，解释运行循环、状态持久化、工具边界、恢复、安全与可观测性。"
tags: ["AI Agent", "Agent Runtime", "系统设计"]
category: "AI Agent"
---

<a id="answer"></a>

## 先给结论：Runtime 管的不是“聪明”，而是“把事情做完”

大模型可以根据上下文生成文字，也可以生成一段形如“调用 `query_metrics`，参数是过去 30 分钟”的结构化请求。但它不会因为输出了这段请求，就自动获得数据库权限、真正执行查询、等待结果、处理超时，更不会在进程重启后记得任务停在哪里。

这些职责属于 **Agent Runtime（智能体运行时）**。

> **一个实用定义：**Agent Runtime 是围绕模型运行的控制层。它接收目标，组装上下文，调用模型，解释模型提出的动作，执行或拒绝这些动作，把结果写回状态，然后重复这个过程，直到任务成功、失败、取消、超时或等待外部输入。

这个定义是对多个工程实现的归纳，不是某一家的产品命名。OpenAI Agents SDK 把核心过程明确写成 runner loop：调用模型；若得到最终输出则结束；若得到 handoff 则切换 Agent；若得到工具调用则执行工具、追加结果并再次调用模型；超过 `max_turns` 则报错。[[1]](#ref1)

```text
用户目标
  ↓
创建 Run 与权限上下文
  ↓
组装模型输入 → 调用模型 → 解析候选动作
     ↑                         ↓
     └── 写回工具结果 ← 策略检查 ← 执行工具
                                  ↓
                    完成 / 失败 / 等待 / 取消
```

所以，“Agent = 模型 + Prompt + Tools”只描述了它拥有什么，没有描述它如何可靠地运行。真正进入生产环境后，难点通常不在下一次模型调用，而在下面这些问题：

- 谁决定工具调用是否允许执行？
- 工具已经成功，但进程在记录结果前崩溃，重试会不会重复扣款？
- 等待人工审批两天后，怎样从原位置继续？
- 一个 Run 调了多少次模型、哪个工具最慢、为什么最终失败？
- Prompt、工具 schema 或模型升级后，旧 Run 还能否恢复？

本文研究日期为 **2026-08-05**。重点是通用运行时架构，不把任一 SDK、协议或云产品当作 Agent Runtime 的唯一标准。

<a id="boundary"></a>

## 先划清边界：模型、Agent 与 Runtime 分别是什么

最容易产生误解的地方，是把模型的“推理能力”和系统的“执行能力”混在一起。可以把整个系统拆成六层：

| 层 | 负责什么 | 不负责什么 |
| --- | --- | --- |
| 模型 | 根据输入预测下一段内容，提出回答、工具调用或计划。 | 不直接拥有生产权限，也不天然持久化 Run。 |
| Agent 定义 | 指令、模型选择、工具集合、输出 schema、handoff 关系。 | 不保证循环一定推进，也不保证副作用安全。 |
| Runtime | 循环、状态机、调度、工具分发、策略、恢复和终止。 | 不替模型判断所有语义，也不替业务系统保存事实。 |
| 工具网关 | 把结构化调用映射为数据库、API、Shell 或浏览器操作。 | 不应自行决定 Agent 的长期目标。 |
| 状态与记忆 | 保存消息、检查点、产物、审批和可检索知识。 | 不等于模型内部参数，也不等于外部系统当前状态。 |
| 外部系统 | 订单、工单、云资源、代码仓库等业务事实源。 | 不知道 Runtime 内部的推理过程。 |

这里有三个重要的“不是”：

1. **Runtime 不是模型服务。**模型 API 可以只做一次生成；Runtime 需要推进一个有生命周期的 Run。
2. **Runtime 不是工具协议。**MCP 规定 Host、Client 与 Server 如何发现和调用能力；其规范反而把 LLM 编排、权限、上下文聚合和用户授权放在 Host 一侧。[[3]](#ref3)
3. **Runtime 也不等于通用工作流引擎。**工作流引擎擅长可靠调度确定性步骤；Agent Runtime 还要处理模型在运行中动态选择下一步、生成参数和改变路径。二者可以组合，后文会解释组合时的边界。

<a id="loop"></a>

## 一次 Agent Run 到底怎样推进

一次 Run 不是“一问一答”，而是一连串受控状态迁移。最小可用循环可以分成七步。

### 1. 接纳任务

Runtime 先创建 `run_id`，绑定调用者身份、租户、Agent 版本、预算、截止时间和初始输入。此时就应确定：

- 最多允许多少次模型调用与工具调用；
- 哪些工具对当前身份可见；
- 哪些动作必须审批；
- 取消信号和总超时怎样传播；
- 这次 Run 使用哪一版 Prompt、模型和工具 schema。

如果这些信息只存在 Prompt 里，它们只是给模型看的文字，不是系统可以强制执行的约束。

### 2. 构建上下文

Context builder 从多个来源拼出本轮模型输入：系统指令、当前目标、短期消息、检索到的长期记忆、工具定义、上轮工具结果，以及剩余预算等运行时提醒。

这一步同时负责裁剪和隔离。MCP 的架构原则要求 Server 只收到必要上下文，完整对话留在 Host，各 Server 之间由 Host 隔离。[[3]](#ref3) 这比“把整段聊天复制给每个工具”更接近正确的权限边界。

### 3. 调用模型

模型得到的是当前状态的一份序列化视图。它可能返回：

- 最终回答；
- 一个或多个工具调用；
- handoff 或子任务；
- 无法满足要求的说明；
- 不符合 schema 的无效输出。

Runtime 不能假设模型输出永远有效。它需要做 schema 校验、工具名解析、参数规范化和错误分类。无效动作可以作为结构化错误反馈给模型重试，也可以直接终止，取决于预算和风险。

### 4. 执行策略检查

模型生成工具调用，只代表**提出动作**，不代表动作已经获准。策略层至少要检查：

- 当前用户和 Agent 是否有权调用这个工具；
- 参数是否落在允许范围；
- 调用是只读、可逆还是高风险副作用；
- 是否命中人工审批、双人复核或时间窗口；
- 是否超过成本、并发、速率或数据边界。

OpenAI Agents SDK 的 HITL 流程展示了这条边界：模型发出调用后，runner 才评估审批规则；需要审批时 Run 暂停，决策写入可序列化的 `RunState`，之后再从原顶层 Agent 恢复。[[2]](#ref2) MCP 工具规范同样建议让人能够拒绝调用，并在 UI 中明确展示暴露了哪些工具、正在执行什么操作。[[4]](#ref4)

### 5. 执行工具

工具网关使用受限凭据在独立边界内执行调用。它应设置超时、重试策略、输出上限和审计字段，并为有副作用的动作生成幂等键。

工具结果也不是可信指令。网页、工单或代码注释都可能包含提示注入文本；Runtime 应把它标成“外部数据”，而不是悄悄提升成系统指令。

### 6. 提交结果与检查点

Runtime 把工具结果、错误、消耗、状态变化和产物引用原子地关联到当前 Run，然后再进入下一轮。对于长任务，还应在可恢复边界保存检查点。

LangGraph 的 checkpointer 会在每个 superstep 保存图状态，并用 `thread_id` 组织检查点；同一步中其他节点已经成功写出的结果也可作为 pending writes 保存，恢复时不必重跑那些节点。[[5]](#ref5) 具体实现可以不同，但原则相同：**恢复依据必须来自持久状态，而不是让模型凭摘要猜测执行到了哪里。**

### 7. 判断终止条件

Run 至少要区分这些终止原因：

- 模型给出符合输出契约的最终结果；
- 达到最大轮数、成本或时间；
- 用户取消；
- 不可重试错误；
- 策略拒绝且没有替代路径；
- 等待输入或审批，此时是暂停而非完成。

下面是概念伪代码，不对应某个 SDK：

```text
run = create_run(goal, identity, agent_version, budgets)
checkpoint(run)

while not run.is_terminal:
    enforce_limits(run)
    model_input = build_context(run)
    decision = call_model(model_input)
    record_model_turn(run, decision)

    if decision.is_final:
        finish(run, validate_output(decision))
        break

    for action in validate_actions(decision):
        verdict = authorize(action, run.identity, run.policy)

        if verdict.needs_human:
            pause_and_checkpoint(run, action)
            return

        result = execute_with_idempotency(action, run.id)
        commit_result_and_checkpoint(run, action, result)
```

<a id="state"></a>

## 状态不是一段聊天记录

许多原型把 `messages[]` 当成系统的全部状态。这样做在演示中很方便，在恢复、审计和并发场景中很快会失效。

一个可靠 Runtime 至少要区分四类状态：

| 状态 | 典型内容 | 一致性要求 |
| --- | --- | --- |
| 对话状态 | 用户消息、模型输出、工具调用与结果。 | 保持协议顺序和调用 ID 配对，可做压缩。 |
| 执行状态 | 当前步骤、尝试次数、审批、预算、取消标记、检查点。 | 必须可恢复，更新要防并发覆盖。 |
| 产物与记忆 | 报告、补丁、附件、长期知识、检索索引。 | 大对象用引用，保留版本与来源。 |
| 外部事实 | 订单是否已退款、部署是否已回滚、邮件是否已发送。 | 以业务系统为准，恢复后必须重新核对。 |

对话可以说“回滚成功”，但真正的部署平台可能没有收到请求；反过来，平台可能已经回滚成功，只是 Runtime 在写入结果前崩溃了。因此，**消息历史不是外部世界的事务日志。**

### Run 应当是一台显式状态机

下面是一组通用状态，不要求所有实现使用相同名称：

```text
QUEUED
  ↓
RUNNING ──→ WAITING_INPUT ──→ RUNNING
  │              │
  ├────→ WAITING_APPROVAL ──→ RUNNING
  │
  ├────→ RETRYING ──────────→ RUNNING
  │
  ├────→ SUCCEEDED
  ├────→ FAILED
  ├────→ CANCELED
  └────→ EXPIRED
```

A2A 的 Task 生命周期也明确区分 `input-required`、`auth-required` 等中断状态，以及 `completed`、`canceled`、`rejected`、`failed` 等终态；已经进入终态的 Task 不再重启，后续修订会在同一 `contextId` 下创建新 Task。[[8]](#ref8) 这提供了一个很有用的设计原则：**Run 是可追踪、可终结的工作单元；Conversation 只是把多个工作单元联系起来的上下文。**

<a id="durability"></a>

## “可以恢复”不等于“绝不重复执行”

持久执行最容易让人产生一个危险错觉：既然 Runtime 有检查点，工具副作用就能做到 exactly once。分布式系统没有这么简单。

Temporal 用持久 Event History 记录 Workflow 的命令和事件。Worker 崩溃后，新 Worker 通过 replay 重建崩溃前状态并继续。[[6]](#ref6) 但它的文档也明确指出：Activity 可能已经在外部完成，Worker 却在把完成结果报告给服务端之前崩溃；服务端看不到完成记录，只能再次调度，所以 Activity 可能执行多次。推荐的防线是让 Activity 幂等，并使用跨重试稳定、跨 Run 唯一的幂等键。[[7]](#ref7)

Agent 工具调用完全可能遇到同一问题：

```text
Runtime → 支付 API：退款订单 42
支付 API → Runtime：200 OK
Runtime 在提交工具结果前崩溃
Runtime 恢复后看到“该步骤未完成”
Runtime → 支付 API：再次退款订单 42
```

正确做法不是要求模型记住“好像退过了”，而是给副作用一个稳定身份，例如：

```text
idempotency_key = run_id + tool_call_id + action_version
```

恢复时先查询外部系统：该键是否已有结果？如果有，就把已有结果接回 Run；如果没有，才执行。对不支持幂等键的旧系统，需要业务唯一约束、outbox/inbox、补偿事务或人工核对。

### 把非确定性放在可记录的边界外

若底层使用 replay 型工作流引擎，模型调用、网络请求、当前时间和随机数都不应直接混入需要确定性重放的控制代码。Temporal 的 Workflow Definition 文档直接把 API、LLM/AI、数据库查询等非确定性操作列为 Activity 的职责；Activity 在 replay 路径之外执行。[[14]](#ref14) 工作流只记录“发起模型 Activity”和“收到结果”这些事件，真正的模型调用在 Activity 或任务处理器中执行。

原因是模型输出本身并不确定。即使 Prompt 一样，模型版本、采样、服务端实现和外部信息也可能变化。恢复时应重放**已经记录的模型结果**，而不是再次调用模型并期待得到同一个计划。

<a id="example"></a>

## 一个完整例子：诊断失败部署并在审批后回滚

假设用户给运维 Agent 一个目标：

> 查明支付服务刚才发布失败的原因；如果回滚能恢复服务，先让我审批，再执行回滚并验证。

这次 Run 可以这样推进。

### 第 1 轮：只读调查

Runtime 创建 `run_01`，绑定用户身份、生产环境只读权限、最长 12 次模型调用和 15 分钟主动执行预算。Context builder 提供三个工具：

- `get_deployment`：读取发布记录；
- `query_logs`：查询受限日志窗口；
- `rollback_deployment`：有副作用，必须审批。

模型先提出 `get_deployment(service="payments")`。策略层确认这是允许的只读调用，工具返回新版本健康检查失败。模型再查询对应时间窗的日志，得到“缺少数据库迁移”的证据。

### 第 2 轮：提出高风险动作

模型生成：

```text
rollback_deployment(
  service = "payments",
  target_revision = "rev-184",
  reason = "rev-185 requires a migration that was not applied"
)
```

Runtime 校验目标版本确实是上一个健康版本，但策略规定生产回滚必须人工确认。于是它：

1. 固定显示工具名、环境、目标版本和原因；
2. 保存当前消息、调用 ID、参数、证据引用和 Agent 版本；
3. 将 Run 置为 `WAITING_APPROVAL`；
4. 释放 Worker，不占用一个进程等待用户。

这里模型没有权限自行“觉得应该回滚就回滚”。审批是 Runtime 的控制平面能力。

### 第 3 轮：跨进程恢复

两小时后用户批准。原 Worker 已经不存在，新 Worker 从检查点加载 `run_01`，核对审批绑定的仍是同一个工具调用和参数，而不是只读取一句“用户同意了”。OpenAI Agents SDK 的 `RunState` 流程也支持把暂停状态序列化，之后在另一个进程恢复；文档特别提醒，应把 Agent/SDK 版本与长期等待的状态一起保存，避免定义变化导致不兼容。[[2]](#ref2)

Runtime 用 `run_01:call_07:rollback-v1` 作为幂等键执行回滚，写入外部操作 ID，再检查部署状态和错误率。即使验证步骤失败并触发恢复，重复的回滚请求也能命中同一外部操作，而不是再创建一次回滚。

### 第 4 轮：形成可审计结论

最后一次模型调用拿到的是结构化事实：失败版本、日志证据、审批人、回滚操作 ID、验证结果和剩余风险。模型负责把这些事实组织成人能读的报告；Runtime 则把 Run 标成 `SUCCEEDED`，并把报告保存为产物。

整条链路的关键不是模型“想得够久”，而是每次边界都由系统明确拥有：

```text
模型：提出下一步
策略层：允许、拒绝或暂停
工具网关：执行受限动作
状态存储：记录可恢复事实
外部系统：保存业务真相
模型：解释结果并继续
```

<a id="protocols"></a>

## MCP、A2A 与工作流引擎放在哪里

这些组件经常与 Agent Runtime 同时出现，但它们解决的是不同问题。

| 组件 | 主要问题 | 与 Runtime 的关系 |
| --- | --- | --- |
| MCP | 怎样发现并调用工具、资源和 Prompt。 | Runtime/Host 通过它连接能力，仍负责循环、权限与上下文。 |
| A2A | 独立、内部不透明的 Agent 怎样交换消息和长期 Task。 | Runtime 可用它委派子任务、跟踪远端状态和产物。 |
| 工作流引擎 | 怎样可靠调度、重试、等待和恢复确定性业务步骤。 | 可承载 Runtime 的持久执行骨架，但模型调用应放在活动边界。 |
| 模型 API | 怎样生成文本、结构化输出或工具调用。 | 是 Runtime 循环中的一个依赖。 |

A2A 官方文档把差异概括得很直接：MCP 面向输入输出清晰、通常较离散的工具和资源；A2A 面向会推理、会使用多个工具、能维持长期状态和多轮协作的独立 Agent。[[10]](#ref10) A2A 的 `Task`、`Message`、`Artifact` 和 `contextId` 适合跨 Agent 边界传递工作状态，但远端 Agent 内部怎样调用模型、检查权限和恢复，仍由它自己的 Runtime 负责。[[9]](#ref9)

所以，接入 MCP 并不会自动获得可靠 Agent，支持 A2A 也不会自动获得安全调度。协议让边界可互操作，Runtime 才让边界内的工作向前推进。

<a id="security"></a>

## 安全边界：把模型输出当建议，把权限留在系统里

Agent 的特殊风险来自两件事同时存在：模型会受非可信文本影响，工具又能改变真实世界。Runtime 必须在两者之间形成不可绕过的执行边界。

| 风险 | 典型错误 | Runtime 控制 |
| --- | --- | --- |
| 提示注入 | 把网页中的“忽略此前规则”当系统指令。 | 标注来源、隔离指令与数据、限制可见工具。 |
| 过度授权 | 所有工具共用管理员令牌。 | 每工具、每租户、每 Run 的最小权限凭据。 |
| 参数漂移 | 审批的是预览，执行时参数已变化。 | 审批绑定调用 ID、规范化参数与版本。 |
| 重复副作用 | 超时后重复发邮件、退款或删除。 | 幂等键、去重、外部状态核对和补偿。 |
| 数据泄露 | Prompt、工具结果和 trace 全量进入日志。 | 分类、脱敏、字段白名单、保留期与访问控制。 |
| 无界执行 | Agent 无限循环、并发调用或递归委派。 | 轮数、成本、时间、深度、并发和速率预算。 |

### 凭据不应进入模型上下文

模型只需要知道“有一个 `query_orders` 工具”和它的参数 schema，不需要看到数据库密码。工具网关根据 Runtime 已验证的身份，在执行时注入短期、限定 audience 和 scope 的凭据。

MCP 的安全文档明确把 token passthrough 视为反模式：Server 必须拒绝不是专门签发给自己的 token，也不能把收到的 token 原样转发给下游；规范还单独讨论 confused deputy、SSRF 和本地 Server 命令执行风险。[[13]](#ref13) 这些不是协议细节上的洁癖，而是在阻止“Agent 有一个令牌，于是所有下游都默认信任它”的权限扩散。

### 审批不是一个通用的“同意”按钮

有效审批应该绑定：

- 工具名与版本；
- 完整、规范化参数；
- 调用者、执行身份和目标环境；
- 风险说明与证据摘要；
- 过期时间；
- 审批人和审批策略版本。

如果参数、目标环境或工具实现发生变化，旧审批应失效。否则攻击者可以先让用户批准一个无害预览，再在执行前替换参数。

<a id="observability"></a>

## 可观测性：不仅要看到答案，还要看到轨迹

普通 API 监控一个请求的延迟和状态码，Agent Runtime 还要回答：**它走了哪条路径，为什么走到这里？**

一条有用的 trace 应能表达这样的父子关系：

```text
invoke_agent run_01
├── model_turn 1
├── execute_tool get_deployment
├── model_turn 2
├── execute_tool query_logs
├── approval_wait rollback_deployment
├── execute_tool rollback_deployment
├── execute_tool verify_deployment
└── model_turn 3
```

OpenAI Agents SDK 默认把 runner、模型生成、工具调用、guardrail 和 handoff 记录为不同 span。[[12]](#ref12) OpenTelemetry 的 GenAI 语义约定也分别定义了 `invoke_agent`、`invoke_workflow`、`plan` 和 `execute_tool` 等操作，并提供 Agent、Conversation、模型、token 和错误属性。[[11]](#ref11)

但“可观测”不等于“把所有内容全量上报”。OpenTelemetry 当前把输入消息、输出消息、系统指令和工具定义列为 **Opt-In** 字段，而且 Agent 相关语义约定仍标记为 Development。[[11]](#ref11) 生产系统应默认记录元数据和哈希，只有在明确的数据政策、脱敏和访问控制下才采集正文。

建议至少监控四组指标：

1. **结果：**成功、失败、取消、超时、策略拒绝和等待中 Run 数。
2. **效率：**端到端时长、主动执行时长、等待时长、模型轮数、工具调用数、token 与成本。
3. **可靠性：**重试、checkpoint 失败、恢复次数、恢复成功率、幂等命中和补偿次数。
4. **安全：**审批率、拒绝率、越权调用、参数校验失败、敏感数据拦截和预算熔断。

只看最终回答质量，会漏掉一种常见退化：Agent 仍然答对，但从 3 轮变成 15 轮、重复调用同一个工具，并把延迟和成本放大五倍。轨迹与结果必须一起评估。

<a id="production"></a>

## 一个生产 Runtime 还需要哪些工程能力

核心循环跑通以后，真正决定稳定性的往往是外围机制。

### 预算与背压

同时限制模型轮数、工具次数、token、金额、墙钟时间、并发数和子任务深度。调度器要能在依赖服务变慢时排队或拒绝，而不是让 Agent 递归创建更多工作压垮系统。

### 超时、重试与错误分类

区分可重试的网络错误、需要模型换方案的业务错误、需要用户补充信息的输入错误，以及必须立即停止的权限错误。重试应有退避、抖动和总预算，不能把同一无效参数机械重发。

### 取消传播

取消 Run 时，要停止未开始的工具，向正在执行的任务发送取消信号，阻止新的模型轮次，并标记那些无法取消、仍可能在外部完成的动作。`CANCELED` 不应被误解成“外部世界已经回滚到初始状态”。

### 并发与子 Agent

每个子任务都应有独立 ID、父 Run、权限、预算和终态。父 Run 取消时怎样处理子任务，子任务失败是局部降级还是整体失败，都应由显式策略决定，而不是依赖模型临场描述。

### 版本化恢复

长期暂停状态至少要记录 Agent 定义、Prompt、工具 schema、Runtime 和模型版本。恢复时可以：

- 路由到兼容的旧 Worker；
- 运行显式状态迁移；
- 使旧审批失效并重新确认；
- 无法兼容时以可解释原因终止。

直接用新代码解释几周前的检查点，可能比不恢复更危险。

<a id="when-not-needed"></a>

## 什么情况下不需要 Agent Runtime

Runtime 的价值来自不确定路径、外部动作和长期状态；它不是所有 LLM 功能的默认答案。

| 需求 | 更简单的选择 |
| --- | --- |
| 一次文本分类、抽取或改写 | 单次模型调用 + 输出 schema 校验。 |
| 步骤完全固定、失败策略明确 | 普通函数或工作流/DAG。 |
| 只需一次只读工具查询 | 应用代码直接调用工具，再让模型总结。 |
| 高风险动作无法定义可验证边界 | 保持人工操作，让模型只提供建议。 |
| 延迟和成本要求极严 | 预先编排的有限路径，而不是开放循环。 |

A2A 也区分即时、无状态的 `Message` 与需要长期跟踪的有状态 `Task`。[[8]](#ref8) 这是很好的判断方法：如果工作不需要循环选择、暂停恢复、工具副作用或动态路径，就没有必要先引入完整 Runtime。

反过来，当需求同时出现下面三项时，Runtime 往往已经不可避免：

- 模型会动态决定下一步；
- 动作会读取或改变外部系统；
- 任务需要跨多轮、跨进程或跨人工等待继续。

<a id="checklist"></a>

## 设计检查清单

在把 Agent 放进生产环境前，可以用这组问题快速检查 Runtime 是否真的存在：

1. Run 是否有独立 ID、明确终态和取消语义？
2. 循环的继续与停止由谁执行，是否有硬预算？
3. 模型输出是否经过 schema、权限和策略校验？
4. 高风险审批是否绑定精确参数并可过期？
5. 进程在任意工具调用前后崩溃，能否判断下一步？
6. 外部副作用是否有幂等键、去重或补偿方案？
7. Conversation、Run、Artifact 和外部事实是否分开存储？
8. Prompt、工具和状态 schema 是否版本化？
9. Trace 能否串起模型、工具、审批、handoff 和错误？
10. 日志与 trace 是否默认避免记录敏感正文？

如果这些问题的答案仍是“让模型自己判断”或“看聊天记录应该能恢复”，系统拥有的是一个会调用工具的模型，而不是一个可靠的 Agent Runtime。

## 结语

Agent Runtime 的核心价值，是把概率性的模型决策嵌入一个可约束、可恢复、可审计的执行系统。

模型负责在开放问题中选择下一步；Runtime 负责让这一步具备身份、权限、预算、状态和后果。MCP 可以标准化工具边界，A2A 可以标准化 Agent 间任务，工作流引擎可以提供持久调度，但最终仍需要一个控制层把它们组织成完整生命周期。

理解这个边界以后，许多架构问题会变得清楚：Prompt 不能替代授权，聊天记录不能替代检查点，重试不能替代幂等，日志不能替代 trace，模型说“完成了”也不能替代对外部事实的验证。

<a id="references"></a>

## 参考资料

<a id="ref1"></a>

1. OpenAI, *OpenAI Agents SDK: Running agents*. https://openai.github.io/openai-agents-python/running_agents/

<a id="ref2"></a>

2. OpenAI, *OpenAI Agents SDK: Human-in-the-loop*. https://openai.github.io/openai-agents-python/human_in_the_loop/

<a id="ref3"></a>

3. Model Context Protocol, *Architecture (2026-07-28)*. https://modelcontextprotocol.io/specification/2026-07-28/architecture

<a id="ref4"></a>

4. Model Context Protocol, *Tools (2026-07-28)*. https://modelcontextprotocol.io/specification/2026-07-28/server/tools

<a id="ref5"></a>

5. LangChain, *LangGraph Checkpoint*. https://github.com/langchain-ai/langgraph/tree/main/libs/checkpoint

<a id="ref6"></a>

6. Temporal, *Event History*. https://docs.temporal.io/encyclopedia/event-history

<a id="ref7"></a>

7. Temporal, *Error handling: Design Activities for idempotence*. https://docs.temporal.io/best-practices/error-handling#idempotence

<a id="ref8"></a>

8. A2A Protocol, *Life of a Task*. https://a2a-protocol.org/latest/topics/life-of-a-task/

<a id="ref9"></a>

9. A2A Protocol, *Core Concepts and Components in A2A*. https://a2a-protocol.org/latest/topics/key-concepts/

<a id="ref10"></a>

10. A2A Protocol, *A2A and MCP: Detailed Comparison*. https://a2a-protocol.org/latest/topics/a2a-and-mcp/

<a id="ref11"></a>

11. OpenTelemetry, *Semantic Conventions for GenAI agent and framework spans*. https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/

<a id="ref12"></a>

12. OpenAI, *OpenAI Agents SDK: Tracing*. https://openai.github.io/openai-agents-python/tracing/

<a id="ref13"></a>

13. Model Context Protocol, *Security Best Practices (2026-07-28)*. https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices

<a id="ref14"></a>

14. Temporal, *Workflow Definition: Deterministic constraints*. https://docs.temporal.io/workflow-definition#deterministic-constraints
