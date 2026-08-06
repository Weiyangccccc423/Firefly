---
title: "Agent Runtime 到底是什么：看一个 Agent 如何真的把事做完"
published: 2026-08-05
updated: 2026-08-06
description: "从一次部署排障任务出发，逐步拆解 Agent Runtime 如何调用模型、执行工具、保存状态并在中断后继续。"
tags: ["AI Agent", "Agent Runtime", "系统设计"]
category: "AI Agent"
---

<a id="run-once"></a>

## 先别背定义：看它实际跑一次

假设你对一个运维 Agent 说：

> 查明支付服务刚才为什么发布失败。如果需要回滚，先让我审批；回滚后再确认服务恢复。

如果应用只调用一次大模型，模型可能回答：

> 我需要先查询发布记录和错误日志。

这句话看起来很聪明，但任务没有前进。日志还没有被查询，回滚也没有发生。模型只是**提出了下一步**。

现在加入一段程序，让同一个任务继续运行：

```text
1. 程序保存用户目标，并创建 run_01
2. 程序调用模型
3. 模型提出：get_deployment("payments")
4. 程序检查权限，真正调用部署平台
5. 程序把查询结果交给模型
6. 模型提出：query_logs(...)
7. 程序执行查询，再把日志交给模型
8. 模型判断需要回滚，并提出 rollback_deployment(...)
9. 程序发现该动作必须审批，于是保存现场并暂停
```

两小时后，你点击批准：

```text
10. 另一台 Worker 读取 run_01 的现场
11. 程序确认批准的仍是同一次回滚、同一组参数
12. 程序执行回滚并记录外部操作 ID
13. 程序再次调用模型，模型提出健康检查
14. 程序执行检查，把结果交给模型
15. 模型生成结论，程序将 run_01 标记为成功
```

第 2、3、6、8、13、15 步里，模型在判断“下一步做什么”。其余那些让任务继续、暂停、恢复和结束的步骤，就是 Runtime 在工作。

> **Agent Runtime 是让模型能够连续行动的运行程序。**它反复调用模型，接住模型提出的动作，校验并执行工具，把结果写回状态，再决定继续、暂停还是结束。

如果只记一句话，可以记这一句：

> **模型决定下一步想做什么；Runtime 负责让这一步安全地发生，并把结果带进下一步。**

OpenAI Agents SDK 把这个核心过程称为 runner loop：调用模型；遇到工具调用就执行并把结果追加回去；遇到 handoff 就切换 Agent；得到最终输出或超过轮数才结束。[[1]](#ref1) 不同框架的名称会变化，但这个循环是理解 Runtime 的起点。

<a id="what-is-it"></a>

## 它到底是一种什么“东西”

Runtime 不是一种模型，也不一定是一款独立产品。它首先是**真实运行的代码**。

在小型应用里，它可能只是后端进程中的一个函数：

```text
app/
├── agent_definition.ts   # 指令、模型、工具和输出格式
├── run_agent.ts          # 循环调用模型与工具
└── tools/
```

在生产系统里，它可能扩展成一组服务：

```text
runtime/
├── runner               # 推进每一轮
├── state_store          # 保存 Run 与检查点
├── tool_executor        # 执行工具
├── policy_engine        # 权限、审批和预算
├── scheduler            # 排队、超时、取消和重试
└── trace_exporter       # 记录整条执行轨迹
```

规模不同，职责没有变。Runtime 总是位于模型和真实世界之间。

| 角色 | 在部署排障例子中做什么 |
| --- | --- |
| 模型 | 阅读当前信息，提出查发布、查日志、回滚或结束。 |
| Agent 定义 | 规定使用哪个模型、有哪些工具、回答应是什么格式。 |
| Runtime | 推进循环，执行策略，保存状态，处理暂停、恢复和终止。 |
| 工具 | 把结构化调用映射成部署平台、日志系统等真实操作。 |
| 外部系统 | 保存发布版本、日志、回滚结果等业务事实。 |

“Agent”这个词常被用来指整套系统，因此容易造成混淆。本文把“指令 + 模型 + 工具集合”称为 **Agent 定义**，把真正推动一次任务运行的程序称为 **Runtime**，把两者连同状态库和外部系统组成的整体称为 **Agent 应用**。

<a id="minimum-loop"></a>

## 它的核心确实只是一个循环

先把审批、恢复和并发全部拿掉，一个最小 Runtime 可以写成下面的概念伪代码：

```text
state = create_run(user_goal)

while not state.finished:
    model_input = build_context(state)
    decision = call_model(model_input)

    if decision is final_answer:
        state.finish(decision)
        break

    action = validate_tool_call(decision)
    result = execute_tool(action)
    state.append(action, result)
```

这段循环完成了四件事：

1. 把当前任务状态整理成模型输入；
2. 让模型选择下一步；
3. 把选择变成真实工具调用；
4. 把新事实放回状态，再问模型一次。

因此，Agent 并不是模型在一次请求里“连续思考了很久”。从系统视角看，它通常是多次彼此独立的模型调用，中间穿插程序执行的工具调用。连续性来自 Runtime 保存并重建输入，而不是来自某个一直存活的模型对象。

到这里，Agent Runtime 的主体已经解释完了：**它就是控制这个循环的程序。**

真正的工程问题来自下一句：如果这个循环要操作生产系统，而且可能运行几分钟、几小时甚至几天，只写一个 `while` 就不够了。

<a id="why-runtime"></a>

## 为什么一个 `while` 循环很快就不够了

继续看 `run_01`，四个很普通的事件会迫使 Runtime 长出更多能力。

### 事件一：模型提出了危险动作

模型输出：

```text
rollback_deployment(
  service = "payments",
  target_revision = "rev-184"
)
```

这只是一份候选动作，不是授权。Runtime 必须检查当前用户、目标环境、工具参数和审批规则。需要人工确认时，它保存调用 ID 与完整参数，把 Run 置为 `WAITING_APPROVAL`，然后释放 Worker。

OpenAI Agents SDK 的 HITL 流程也是在 runner 收到工具调用后评估审批要求；暂停状态可以序列化，随后从保存的 `RunState` 恢复。[[2]](#ref2) MCP 工具规范同样建议让用户能够看见并拒绝工具调用。[[4]](#ref4)

**所以 Runtime 需要策略和审批。**Prompt 里写“请谨慎操作”只是给模型的建议，程序里的权限检查才是执行边界。

### 事件二：用户两小时后才批准

一个进程不应该占着内存等两小时。Runtime 需要把以下事实保存下来：

- 当前 Run 是谁发起的；
- 模型已经看过哪些结果；
- 等待批准的是哪个工具调用；
- 当时的完整参数和证据是什么；
- 使用的是哪一版 Agent、Prompt 和工具 schema。

批准到来后，任何兼容 Worker 都能从检查点继续，而不是要求原进程还活着。LangGraph 的 checkpointer 会按 `thread_id` 保存图状态，并在执行步骤边界建立可恢复检查点。[[5]](#ref5)

**所以 Runtime 需要持久状态和调度。**

### 事件三：回滚成功后，进程突然崩溃

最危险的时间线是：

```text
Runtime → 部署平台：回滚 rev-185
部署平台 → Runtime：回滚成功
Runtime 在写入“成功”之前崩溃
```

恢复后的 Worker 只看到“这一步还没有完成”。如果它直接重试，可能重复创建回滚任务。

Temporal 用持久 Event History 让 Worker 通过 replay 恢复控制流。[[6]](#ref6) 但它也明确指出，Activity 可能已经在外部完成，却在回报完成前崩溃，因此 Activity 仍可能被再次执行；推荐做法是让副作用幂等。[[7]](#ref7)

Agent 工具调用也一样。Runtime 应给动作一个稳定身份，例如：

```text
idempotency_key = run_id + tool_call_id + action_version
```

恢复时先向外部系统查询这个动作是否已经发生，再决定接回已有结果还是重新执行。

**所以 Runtime 需要检查点、幂等和外部事实核对。**“能够恢复”不等于“绝不重复执行”。

### 事件四：模型一直找不到答案

模型可能反复查询相同日志，或者不断拆出新子任务。Runtime 必须在模型之外强制限制：

- 最大模型轮数与工具次数；
- token 和金额预算；
- 总时长、单步超时与重试预算；
- 并发数和子 Agent 深度；
- 用户取消后的传播方式。

**所以 Runtime 需要预算、超时、背压和终止条件。**否则循环只是把模型的不确定性放大成无界成本。

<a id="run-state"></a>

## Runtime 保存的是 Run，不只是聊天记录

聊天记录只说明“模型和用户说过什么”。Runtime 还必须保存“系统实际上做到了哪里”。

`run_01` 至少包含四类状态：

| 状态 | 例子 | 为什么不能只放在消息里 |
| --- | --- | --- |
| 对话状态 | 用户目标、模型输出、工具调用与结果。 | 需要保持调用顺序，但可以压缩。 |
| 执行状态 | 当前步骤、预算、审批、重试和取消标记。 | 决定 Run 下一步从哪里继续。 |
| 产物 | 日志证据、诊断报告、补丁和附件引用。 | 大对象需要独立版本与来源。 |
| 外部事实 | rev-184 是否已经部署、服务是否健康。 | 只能以部署平台等业务系统为准。 |

这也是为什么模型说“回滚完成”不能作为最终证据。Runtime 必须读取部署平台的状态，并把验证结果记录下来。

一次 Run 通常有显式生命周期：

```text
QUEUED
  ↓
RUNNING ──→ WAITING_INPUT ──→ RUNNING
  │
  ├────→ WAITING_APPROVAL ──→ RUNNING
  ├────→ RETRYING ──────────→ RUNNING
  ├────→ SUCCEEDED
  ├────→ FAILED
  ├────→ CANCELED
  └────→ EXPIRED
```

`WAITING_APPROVAL` 不是成功，也不是失败；它表示 Runtime 已经保存现场，正在等一个外部事件。`CANCELED` 也只表示 Runtime 不再推进新步骤，不代表已经发生的外部动作会自动撤销。

A2A 的 Task 生命周期同样区分 `input-required`、`auth-required` 等中断状态和 `completed`、`failed`、`canceled` 等终态。[[8]](#ref8) 这里的重要直觉是：**Conversation 是交流上下文，Run 才是有开始、有状态、有终点的工作单元。**

<a id="whole-picture"></a>

## 把模型放回整张图里

现在可以完整地画出 Runtime 的位置：

```text
                         ┌─────────────────────┐
用户目标 ───────────────→│    Agent Runtime    │
                         │                     │
                         │  1. 读取 Run 状态   │←────→ 状态库 / 检查点
                         │  2. 构建本轮上下文  │
                         │  3. 调用模型        │←────→ 模型 API
                         │  4. 校验候选动作    │
                         │  5. 执行或暂停      │←────→ 策略 / 人工审批
                         │  6. 记录结果并循环  │←────→ 工具网关
                         └─────────────────────┘          │
                                                        ↓
                                            数据库 / 浏览器 / 云平台
```

模型从来没有直接“伸手”进入数据库或云平台。它返回的是结构化建议；Runtime 决定这个建议能否成为动作，并控制动作使用什么身份、预算和超时。

工具结果也不能自动升级成指令。网页、工单和代码注释都可能包含提示注入文本。Runtime 与 context builder 应保留来源边界，把这些内容作为外部数据交给模型，而不是当成系统规则。

如果底层使用 replay 型工作流引擎，模型调用、网络请求、当前时间等非确定性操作还应放在可记录的 Activity 边界中。Temporal 明确把 API、LLM 和数据库调用归到 Activity，而要求 Workflow 控制代码保持可确定性重放。[[14]](#ref14) 恢复时应重放已经记录的模型结果，而不是重新调用模型并期待它再次生成同一个计划。

<a id="nearby-concepts"></a>

## MCP、A2A 和工作流引擎都不是 Runtime

理解了上面的循环，这三个概念就容易放置了。

| 组件 | 它回答的问题 | 在图中的位置 |
| --- | --- | --- |
| MCP | Runtime 怎样发现和调用工具、资源与 Prompt？ | 连接 Runtime/Host 与工具。 |
| A2A | 一个 Agent 怎样把长期任务交给另一个 Agent？ | 连接两个各自拥有 Runtime 的系统。 |
| 工作流引擎 | 步骤怎样可靠排队、等待、重试和恢复？ | 可以承载 Runtime 的持久执行骨架。 |
| 模型 API | 给定当前输入，下一步建议是什么？ | Runtime 循环中的一个依赖。 |

MCP 规范把 LLM 编排、权限、上下文聚合和用户授权放在 Host 一侧；Server 只暴露受控能力。[[3]](#ref3) 因此，接入 MCP 不会自动得到运行循环、检查点或审批。

A2A 则面向内部不透明、能够维持任务状态的远端 Agent。[[9]](#ref9) 官方比较把 MCP 描述为连接工具和资源，把 A2A 描述为连接能够推理并协作的独立 Agent。[[10]](#ref10) 远端 Agent 内部怎样调用模型和工具，仍由它自己的 Runtime 负责。

工作流引擎最接近 Runtime 的执行底座，但两者关注点不同：工作流引擎擅长可靠执行已定义步骤；Agent Runtime 还要在每一轮让模型动态决定下一步。实践中常见的组合是“工作流引擎负责持久调度，Agent Runtime 负责模型循环和动作边界”。

<a id="production"></a>

## Runtime 怎样把 Agent 变成生产系统

回到 `run_01`，生产要求最终可以归结为两件事：**每一步都必须受控，每一步都必须可追踪。**

### 安全：模型只提议，系统才授权

| 风险 | Runtime 的控制方式 |
| --- | --- |
| 提示注入 | 区分系统指令与外部数据，限制本轮可见工具。 |
| 过度授权 | 按用户、租户、工具和 Run 注入最小权限凭据。 |
| 参数被替换 | 审批绑定工具版本、规范化参数、环境和过期时间。 |
| 重复副作用 | 幂等键、去重、外部状态核对和补偿。 |
| 数据泄露 | 日志字段白名单、脱敏、访问控制和保留期。 |
| 无限执行 | 轮数、成本、时间、并发和递归深度预算。 |

凭据不应进入模型上下文。模型只需要看见 `query_logs` 的用途和参数 schema；Runtime 在真正执行时，才为工具注入受限凭据。MCP 的安全文档明确把 token passthrough 视为反模式，并要求 Server 拒绝不是签发给自己的 token。[[13]](#ref13)

### 可观测性：不只看答案，还要看过程

一次有用的 trace 应能还原 `run_01`：

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

OpenAI Agents SDK 会把 runner、模型生成、工具调用、guardrail 和 handoff 记录为不同 span。[[12]](#ref12) OpenTelemetry 的 GenAI 语义约定也定义了 `invoke_agent`、`plan` 和 `execute_tool` 等操作。[[11]](#ref11)

但 trace 不应该默认收集所有 Prompt 和工具结果正文。OpenTelemetry 将输入消息、输出消息、系统指令和工具定义列为 Opt-In 字段。[[11]](#ref11) 生产环境更适合默认记录调用 ID、模型、工具、耗时、token、状态码和内容哈希，只在明确的数据政策下采集正文。

<a id="when-needed"></a>

## 什么情况下才需要 Agent Runtime

不是所有大模型功能都需要 Runtime。

| 需求 | 更简单的实现 |
| --- | --- |
| 文本分类、抽取、翻译或改写 | 单次模型调用，加输出 schema 校验。 |
| 步骤固定、分支明确 | 普通函数或工作流/DAG。 |
| 只查一次数据再总结 | 应用代码先查询，再调用模型总结。 |
| 高风险动作无法建立验证边界 | 保持人工执行，让模型只给建议。 |

当下面三件事同时出现时，Runtime 才真正有价值：

1. 模型会根据中间结果动态选择下一步；
2. 任务会读取或改变外部系统；
3. 任务需要跨多轮、跨进程或跨人工等待继续。

如果任务只是 `input → model → output`，不必先建一套 Runtime。如果任务已经变成 `model → tool → model → approval → tool → recovery → model`，那套负责推进箭头的程序，其实就是 Runtime。

<a id="self-check"></a>

## 用三个问题检查自己是否理解了

### 1. 删除模型，还剩下什么？

还剩状态库、工具执行器、权限、调度和 trace，但系统失去了在开放问题中选择下一步的能力。

### 2. 删除 Runtime，还剩下什么？

模型仍能写出计划和工具调用，但没有程序负责真正执行、保存结果、等待审批、崩溃恢复和判断终止。

### 3. Runtime 最终交付什么？

不只是最后一段回答。它交付的是一个有身份、有过程、有外部结果、有明确终态的 Run。

<a id="conclusion"></a>

## 结语：Runtime 是 Agent 的执行者

Agent Runtime 并不神秘。它是位于用户目标、模型和外部系统之间的控制程序。

它先把当前状态交给模型，让模型提出下一步；再由程序检查权限、执行工具、保存结果，并决定继续、暂停还是结束。为了让这个循环进入生产环境，它又需要持久状态、审批、幂等、预算、取消、版本和 trace。

所以最准确的理解不是“Runtime 给模型增加了智能”，而是：

> **Runtime 把模型一次次不确定的建议，组织成一项能够真正完成、能够中断恢复、也能够追责的工作。**

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
