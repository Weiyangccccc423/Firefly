---
title: "上下文压缩不是失忆：解读 Grok Build 的 Agent 交接实现"
published: 2026-07-24
description: "从工程实现解读 Grok Build 如何压缩 Coding Agent 上下文并完成下一轮模型续接。"
tags: ["AI Agent","上下文工程","Grok Build"]
category: "AI Agent"
---

<a id="answer"></a>

## 先给结论：交接的对象是什么

这里的“交接”不是迁移一个模型对象，更不是复制 Transformer 的 KV cache。对绝大多数 API 型大模型而言，每次调用都是近似无状态的：服务端接收一串带角色的消息、工具定义和采样参数，计算完成后返回一个新回复。

> **Grok Build 的交接本质是 prompt reconstruction（提示词重建）。**系统生成一段新的 `Vec<ConversationItem>`，替换会话中的旧历史。下一次推理把这段新历史发送给模型，模型因此看起来像“接上了上一位 Agent”。

```text
1. 旧对话用户、助手、工具调用、工具结果、系统提醒和元数据 2. 两类信息LLM 生成语义摘要；程序采样真实运行时状态 3. 新对话摘要 + 原任务 + 运行时提醒，被下一轮模型请求重新读取
```

入口是 `SessionActor::run_compact_inner()`。它位于 `crates/codegen/xai-grok-shell/src/session/compaction.rs`，负责协调摘要模型、工具运行时与 ChatState actor。

<a id="roles"></a>

## 运行时角色与数据边界

先把几个名字翻译成工程职责。Rust 的 *actor* 在这里可理解为“独占一份状态、通过消息队列串行修改它的组件”，不是一个大模型 Agent 本身。

| 组件 | 职责 | 关键边界 |
| --- | --- | --- |
| `SessionActor` | 编排一次 Agent 回合、工具和压缩流程。 | 决定何时压缩，调用摘要模型，收集 runtime 状态。 |
| `ChatStateActor` | 保存当前对话、token 账本和持久化历史。 | 只能通过 `ChatStateCommand` 改写；避免并发写坏会话。 |
| Compaction sampler | 向模型发起“请总结旧对话”的独立调用。 | 输出只是文本，不直接拥有会话状态。 |
| Tool bridge / MCP / 子 Agent 协调器 | 维护后台命令、TODO、连接的工具和活动子任务。 | 这些事实不应只依赖 LLM 摘要。 |

这个划分解决了一个根本问题：模型可以很好地浓缩“为什么要改这个函数”，但它无法可靠地知道 PID 对应的后台任务是否仍在跑，或 TODO 刚刚被其他组件更新。因此压缩实现同时使用生成式和确定性两条通道。

<a id="summary-input"></a>

## 第一步：旧历史如何喂给摘要模型

压缩不是把原始 `conversation` 原样再发一次。普通路径先构造一个“对摘要足够、对上下文更省”的副本。下面是原始实现的核心摘录：

```
// 原始摘录：xai-chat-state/src/compaction_utils.rs
pub fn prepare_conversation_for_summarization(
    conversation: Vec<ConversationItem>,
) -> Vec<ConversationItem> {
    strip_images(strip_reasoning_blocks(
        strip_tool_messages_for_conversation_item(conversation),
    ))
}
```

从内到外看，这三步分别是：

1. **压缩工具 I/O。**工具结果正文会被移除，工具调用会转为文本注记。比如几十页构建日志对“任务进展”有价值，但不值得在摘要请求里逐字重发。
2. **移除 reasoning 块。**某些后端的 reasoning / thinking 内容带签名；修改其周围内容后可能不再合法，甚至触发供应商的 400 错误。
3. **替换图片。**图片内容变为 `[image]` 占位，避免 data URL 的 base64 占据巨量 token。

> **这不是无损归档。**它的目的不是让摘要模型复现每一条工具输出，而是让它提取可继续工作的语义状态。项目另有可选的 verbatim 路径，允许保留更多工具 I/O；但两种路径的目标都是“生成摘要”，不是直接交给后续主模型。

接下来 `run_compact_inner()` 使用这个副本和专用提示词调用 `sample_full_replace_summary()`。实现有最多三次尝试；空响应、过短或退化摘要会重试，明确的鉴权、参数、上下文溢出等确定性错误则不会盲目重发同一请求。

<a id="prompt"></a>

## 第二步：摘要提示词在要求什么

提示词源文件是 `crates/common/xai-grok-compaction/src/code_compaction/templates/full_replace_summary_prompt.txt`。以下是其中文意译，保留了结构、约束与含义；`{user_context_section}` 是运行时插入的额外用户上下文。

**任务：**请忠实且简洁地总结到目前为止的对话，使得先前回合被丢弃后，后继助手仍能无缝继续工作。后继助手会看到用户的原始请求和这份总结。请捕获继续工作所需的信息：用户的明确要求、最近的操作、关键技术细节、文件路径、命令、配置和架构决策；但要节制，优先使用紧凑叙述和短引用，避免冗长原文。

**跨多次压缩：**若更早的对话包含已有压缩总结（例如 `<conversation_summary>` 或“此会话正在继续”前言），它是早期历史的权威来源；仍然相关的信息必须继续带入新总结，防止逐次压缩遗忘。

**输出形式：**先在私有推理中思考，不要输出单独的分析块。只输出一个 `<summary>...</summary>`，并且无论内容是否为空都保留下面九个编号标题：

1. 主要请求与意图：所有明确请求、隐含目标、约束、范围和偏好。
2. 关键技术概念：涉及的语言、框架、库、工具和模式。
3. 文件与代码区段：每个读过、创建或修改的文件；说明原因和相关代码。对真正改过的代码要保留最新完整片段。
4. 错误与修复：发生过的错误、失败命令或测试失败，根因和精确修复方式。
5. 问题解决进展：已解决的问题、正在诊断的问题和仍待验证的假设。
6. 全部用户消息：按顺序列出所有真正的用户消息，不包含本次系统生成的总结指令。
7. 待办任务：只列出用户明确要求、但尚未完成的任务。
8. 当前工作：压缩发生前正在做什么，精确到最新文件、命令和状态。
9. 可选下一步：只给出最直接的一个下一步；若已完成且无明确后续，要求先向用户确认。该项需要引用最近用户原话以防止意图漂移。

这是一个相当务实的摘要 schema：它不是让模型写漂亮的散文，而是让模型替下一位执行者维护一个工作日志。第 3、4、6、8 项看似重复，实际上分别保护代码事实、失败历史、用户意图和断点恢复。

### 输出不是可信结构化数据

尽管提示词使用 XML 风格标签，代码并没有把它解析成强类型对象。模型返回的是 `String`，随后由 `format_compact_summary()` 做防御性清洗：剥离泄漏的 `<analysis>`，抽出 `<summary>` 内文，并把回显的控制标签去活化，避免它们在下一轮被当作新的压缩指令。

```
// 讲解伪代码：省略字符串边界处理
raw = sampler.call(simplified_conversation, summary_prompt)
clean = remove_leading_analysis(raw)
clean = extract_summary_body_if_present(clean)
clean = neutralize_control_tags(clean)
handoff_summary = "This session is being continued...\n\nSummary:\n" + clean
```

“讲解伪代码”表达控制流；完整的 tag 清洗边界条件请见源码中的 `format_compact_summary()`。

<a id="runtime-state"></a>

## 第三步：程序如何重建可信运行时状态

摘要文本只回答“此前发生了什么”。然而 Agent 续接还需要回答“现在系统里还活着什么”。这部分由 `CompactionStateContext` 表示：

```
// 原始结构的字段摘录，注释转为中文
pub struct CompactionStateContext {
    pub recent_messages: Vec<ConversationItem>,
    pub last_user_query: Option<String>,
    pub agent_edited_paths: Vec<String>,
    pub running_tasks: Vec<BackgroundTaskSummary>,
    pub running_subagents: Vec<RunningSubagentSummary>,
    pub connected_mcp_servers: Vec<CompactionServerSummary>,
    pub todos: Vec<TodoSummary>,
}
```

这些字段不是从摘要中“解析回来”的。`SessionActor` 在压缩点向各自的权威来源读取：编辑路径来自 ChatState，后台任务和 TODO 来自 ToolBridge，子 Agent 列表来自协调事件通道，MCP 服务来自会话连接状态。随后 `to_system_reminder()` 把它们渲染为一个 `<system-reminder>`。

| 信息 | 为何不能只信摘要 | 当前实现的权威来源 |
| --- | --- | --- |
| 编辑过的文件 | 模型可能漏记或误记。 | ChatState 的 `agent_edited_paths` 集合。 |
| 后台 shell 任务 | 任务可能在摘要过程中结束或仍在运行。 | ToolBridge 的任务注册表。 |
| TODO 状态 | 其状态可由工具单独更新。 | `TodoState` 资源。 |
| 子 Agent | 它们是独立并发实体，不属于主模型的文本记忆。 | 子 Agent 协调器的活动列表。 |
| MCP 服务 | 是否连接及可用工具数是运行时事实。 | 当前会话的连接摘要。 |

这里还有一个容易忽略的细节：提取“最后一个用户请求”时不会简单找最后一条 `User` 消息。系统提醒、自动继续命令和启动元数据也可能在协议上表现为 user-like 消息。源码通过 `is_real_user_turn` 判断真实人类输入，避免把“请继续”之类的合成消息错误地当成任务边界。

<a id="assembly"></a>

## 第四步：如何拼出实际交接包

真正组装发生在 `build_compacted_history(CompactedHistoryInput)`。它是一个没有 I/O 的纯函数：输入已经准备好的 system prompt、用户元数据、项目指令、摘要和运行时提醒，输出一个新的 `Vec<ConversationItem>`。这种设计使组装逻辑可以被单元测试，而不需要启动模型或 shell。

```text
1. 原始 system prompt保留 Agent 的基本行为、工具规则和运行环境约束。 2. 新鲜 user/workspace 元数据重新生成，而不是照搬过期的启动前缀。 3. 重新注入的 AGENTS.md 项目指令保证仓库局部约定不会因压缩丢失。 4. 最后一个真实用户请求包进 <user_query>，作为任务锚点。 5. 续接摘要以 user-meta 形式放入历史，包含“会话正在续接”的前言。 6. 运行时 system reminder编辑文件、TODO、后台任务、子 Agent、MCP、skills 与可选记忆检索结果。
```

```
// 讲解伪代码：对应 build_compacted_history 的正常分支
history = [original_system, fresh_user_prefix]
history += project_instructions_if_any
history += wrap_as_user_query(last_real_user_query)
history += continuation_preamble_and_clean_summary
history += system_reminder_from_runtime_state
return history
```

> **关于 recent_messages 的一个实现细节：**通用的 `build_compacted_history()` 支持把最后一个用户请求之后的 assistant/tool 尾部消息也带入新历史。但当前 `run_compact_inner()` 传入的是 `state_context.for_compaction()`，该方法将 `recent_messages` 置为空。因此当前 shell 路径的有效交接包不保留逐条尾部工具记录，而是依赖“最后用户请求 + 摘要 + 运行时提醒”。看通用构造函数的能力不足以判断真实行为，必须追到调用点。

为什么仍要显式放入“最后真实用户请求”？因为摘要会遗漏或扭曲重点。即使摘要提示词要求列出用户意图，原始任务仍以独立、规范化的锚点存在。它还用于压缩后的记忆检索查询。

<a id="validation"></a>

## 第五步：为什么还要校验与持久化

压缩后的历史必须不仅“读起来合理”，还要满足供应商的消息协议。最典型的不变量是：

```
每一个 ToolResult，都必须在它之前找到
具有同一 tool_call_id 的 Assistant.tool_calls。
```

如果只保留一个工具结果，而丢掉它对应的助手工具调用，许多模型 API 会直接返回 400。项目使用一次从左到右的扫描收集已见的 tool call ID，删除找不到前驱的 `ToolResult`；再做一次验证。如果仍有违规，则回退到不含尾部消息的最小压缩历史。

通过校验后，代码先写入 compaction checkpoint，再向 ChatState actor 发送 `ReplaceConversation { is_compaction: true }`。actor 内部执行的顺序可以概括为：

1. 持久化新的 history；
2. 重新估计压缩后 token；
3. 用新 `Vec<ConversationItem>` 替换内存会话；
4. 清空本轮本地估计增量，重置基准；
5. 发出 `ConversationReset` 与 `TokensUpdated` 事件。

值得注意的是，token 账本不会天真地把压缩后的字符数当成唯一真相。代码会将先前供应商总 token 与本地基准估计的比例带到新的基准上，并且限制压缩后的数值不得超过压缩前。这样既能保留模型/工具定义等协议开销的校准，又不会让“压缩”在监控中反而显得更贵。

<a id="successor"></a>

## “新 Agent”究竟怎样接收上下文

在这个 compaction 路径中，**通常没有一个新建的、带内部记忆的 Agent 实例**。提示词中所谓 *successor assistant* 是逻辑上的后继模型调用：

1. 旧 `ChatState.conversation` 被替换为交接包；
2. 用户下一次输入，或系统的自动继续机制，触发一个新的 sampling 请求；
3. 请求序列化当前 `conversation`、工具定义和采样配置；
4. 模型从这段重建后的文本上下文推断“我正在继续此前任务”。

> **因此，压缩解决的是“有限上下文窗口内的会话续接”。**真正跨会话、跨进程的长期记忆是另一套系统：持久化、索引、检索和再注入。当前压缩路径可在生成运行时 reminder 时按最后用户请求检索最多几条历史记忆，但这不是把整段旧对话永久塞回上下文。

也要区分真正的并发子 Agent：子 Agent 的启动与消息协议是另一路 runtime；主会话压缩时只把“有哪些子 Agent 仍在运行、怎样查询或终止它们”重新告知主模型。它们自己的对话和生命周期并不通过这段 summary 直接复制。

<a id="lessons"></a>

## 可复用的实现原则

如果你要开发自己的 Agent，上面的实现可以提炼成几条比“写一个总结 prompt”更重要的规则。

1. **把语义状态和操作状态分开。**用 LLM 概括意图、推理过程和变更脉络；从数据库、任务注册表和文件系统重新获取可验证事实。
2. **让摘要可累积。**压缩提示词必须要求携带仍然有效的旧摘要，否则多次压缩会产生渐进式遗忘。
3. **保留一个规范任务锚点。**不要只让模型从摘要中猜当前目标；单独保存最后一个真实用户请求或当前任务 ID。
4. **区分真实用户消息与系统注入。**自动继续、system reminder、工具协议消息都可能污染“最后一条用户消息”的朴素逻辑。
5. **交接包必须通过协议校验。**工具调用 ID、role 顺序、附件格式、图片大小都可能比摘要质量更早导致请求失败。
6. **组装写成纯函数，替换写进串行状态机。**前者容易测试，后者避免压缩与正在写入的工具结果发生读改写竞争。
7. **把摘要视为不可信文本。**清除模型泄露的分析块和控制标签；不要让摘要内的“指令”改变下一轮系统行为。
8. **观测压缩质量。**记录触发时 token、摘要长度、重试次数、压缩后 token 和恢复失败率。没有这些数据，就无法判断是阈值、提示词还是状态装配出了问题。

> **一个可操作的最小设计：**维护 `task_anchor`、`semantic_summary` 和 `runtime_snapshot` 三个独立字段。压缩时只让模型更新前两者中的摘要，让程序更新运行时快照；请求模型前再由一个纯函数统一渲染为消息数组。这样可以把“模型记错”和“系统状态失真”隔离开。

<a id="sources"></a>

## 源码索引

下面是本文涉及的主要实现位置，适合按“编排 - 纯函数 - 状态提交”的顺序阅读：

- `crates/codegen/xai-grok-shell/src/session/compaction.rs`
   压缩编排入口 `run_compact_inner()`；摘要调用、运行时状态采集、交接包构造、checkpoint 与替换。
- `crates/codegen/xai-chat-state/src/compaction_utils.rs`
   摘要输入归一化、真实用户消息识别、`CompactionStateContext`、摘要清洗、交接历史构造与工具结果校验。
- `crates/common/xai-grok-compaction/src/code_compaction/templates/full_replace_summary_prompt.txt`
   全量替换式压缩所使用的英文摘要提示词原文。
- `crates/codegen/xai-grok-shell/src/session/helpers/compaction_context.rs`
   将运行时状态和可选记忆检索结果渲染为 `<system-reminder>`。
- `crates/codegen/xai-chat-state/src/actor/mutations.rs`
   `replace_conversation()`：持久化历史、按压缩语义重估 token，并发送 reset 事件。
- `crates/codegen/xai-chat-state/src/actor/state.rs`
   会话状态和 token 估计的基础实现；适合在理解交接包后继续阅读。
