---
title: "Prompt Cache 不是加一个 Key：稳定上下文前缀的工程方法"
published: 2026-08-13
description: "从上下文分层、稳定前缀设计、MaaS 路由到 Usage 指标，系统解释 Agent 如何引入并验证 Prompt Cache 命中。"
tags: ["AI Agent","上下文工程","Prompt Cache","MaaS"]
category: "AI Agent"
---

<a id="answer"></a>

## 先给结论：缓存命中不是一个字段的功劳

团队给 Agent 接入 MaaS 平台后，常会遇到一个反直觉现象：连续两次请求看起来几乎一样，也传了 `prompt_cache_key`，第二次响应里的缓存 token 却仍然是 `0`。

问题通常不在某一个开关，而在整条请求链路。一次 Prompt Cache 命中至少依赖四件事同时成立：

1. Runtime 构造出了足够长、足够稳定的上下文前缀；
2. SDK 和 MaaS 网关没有丢弃缓存字段，也没有改写前缀；
3. 相同缓存族的请求被送到能够复用缓存的后端；
4. 供应商支持当前模型和请求形态，并在 Usage 中返回了实际读取量。

> **稳定前缀决定“有没有相同内容可复用”，缓存键和粘性路由决定“去哪里寻找它”，Usage 决定“是否真的找到了”。**三者互相配合，但不能彼此替代。

因此，`prompt_cache_key` 相同不等于命中，连续落到同一个渠道不等于命中，应用保存了一份 Context Snapshot 也不等于命中。唯一可靠的运行时证据，是供应商返回的缓存读取 token，例如 OpenAI 的 `cached_tokens`、Anthropic 的 `cache_read_input_tokens` 或 Google 的 `cachedContentTokenCount`。字段名和计费规则因供应商而异，必须按实际协议解释。[[1]](#ref1)[[2]](#ref2)[[3]](#ref3)

本文先建立一套供应商无关的系统模型，再进入稳定前缀设计、MaaS 接入、指标验证和逐层排障。

<a id="four-layers"></a>

## 先分清四层状态

Prompt Cache 最容易被误解，是因为工程里有好几种都被叫作“上下文”或“缓存”的东西。

| 层次 | 保存或控制什么 | 解决的问题 | 能否证明 Prompt Cache 命中 |
| --- | --- | --- | --- |
| 业务状态 | Conversation、Run、审批、草稿、记忆和任务进度 | Agent 如何跨请求继续工作 | 不能 |
| 模型上下文 | 本轮真正发给模型的 instructions、messages、tools 和检索材料 | 模型本轮能看到什么 | 不能，但它决定可缓存内容 |
| 路由粘性 | 某个稳定键与 MaaS 渠道、区域或后端的映射 | 相似请求尽量回到相同缓存位置 | 不能 |
| 供应商 Prompt Cache | 模型预填充阶段可复用的前缀计算结果 | 降低重复输入的延迟和费用 | 能，但要看供应商 Usage |

Context Snapshot 属于前两层之间的审计产物。它可以记录“当时准备了哪些消息和引用”，便于重试、回放与追责，但把 JSON 存进数据库不会自动让 GPU 复用此前的计算。

路由粘性也只是必要条件之一。网关可以依据 `prompt_cache_key` 把请求持续送往同一个渠道；如果请求前缀每次都变，后端仍然找不到可复用条目。反过来，一些供应商即使没有显式键也会自动路由和缓存，但命中具有更强的偶然性。

还要排除另一种常见混淆：**结果缓存**保存的是整个 API 输出，命中后通常不再调用模型；Prompt Cache 复用的是输入前缀的中间计算，模型仍会生成新的输出，因此相同请求不保证得到相同回答。OpenAI 的官方文档也明确说明，Prompt Cache 不改变输出生成过程。[[1]](#ref1)

<a id="data-flow"></a>

## 一次命中经过哪些组件

把完整链路展开，缓存不是 Agent Runtime 内部的一次本地查表，而是多个组件共同完成的结果：

```text
业务状态 / Context Snapshot
          │
          ▼
Context Builder
  ├─ 稳定前缀：指令、示例、工具 schema、共享知识
  └─ 动态尾部：记忆、检索结果、近期消息、当前问题
          │
          ▼
Agent SDK / 模型适配器
  ├─ 序列化请求
  ├─ 附加 prompt_cache_key 或缓存断点
  └─ 选择 Responses / Chat / Messages 等协议
          │
          ▼
MaaS 网关
  ├─ 校验并透传字段
  ├─ 按缓存族做渠道粘性
  └─ 转换供应商协议
          │
          ▼
模型供应商
  ├─ 路由与缓存查找
  ├─ 未命中时执行 prefill 并可能写入缓存
  └─ 命中时读取已有前缀计算
          │
          ▼
Usage → 网关归一化 → 应用日志、指标与账单
```

这条链路给出了排障顺序：先检查“发了什么”，再检查“经过网关后还剩什么”，最后检查“供应商返回了什么”。只盯着应用里的缓存键，无法覆盖后面几层。

<a id="prefix-model"></a>

## Prompt Cache 缓存的到底是什么

对自动前缀缓存，可以先用一个简化模型理解：

```text
请求 A = [A B C D E] [x]
请求 B = [A B C D E] [y]
                    ↑
              最长稳定前缀
```

如果供应商缓存了 `[A B C D E]`，请求 B 就可能复用这段前缀，然后只处理动态尾部 `[y]`。一旦前面发生变化，公共前缀会在变化点提前结束：

```text
请求 A = [A B C D E] [x]
请求 C = [A B Z D E] [y]
              ↑
        前缀在这里失配
```

这里的“相同”不是业务语义相似，而是供应商渲染后可精确匹配的 prompt 前缀相同。下面这些变化即使不影响人类理解，也可能破坏复用：

- 在开头插入当前时间、请求 ID、trace ID 或随机 UUID；
- 同一组 JSON 字段使用不稳定的遍历顺序；
- 工具定义顺序、描述、参数 schema 或结构化输出 schema 发生变化；
- 每轮把不同的检索结果和用户记忆放到 system/developer 消息最前面；
- 图片地址、base64 内容或图像 detail 参数改变；
- SDK 升级后改变了角色映射、默认字段或 prompt 渲染方式。

OpenAI 要求命中精确前缀，并建议把静态内容放在开头、动态内容放在结尾；工具和图像也必须保持一致。满足条件的请求才会进入缓存候选范围，而且最低 token 门槛随模型代际和供应商变化。[[1]](#ref1) Google 的隐式缓存同样建议把大块公共内容放在开头，并在较短时间内发送相似前缀。[[3]](#ref3)

> **语义稳定不等于序列化稳定，序列化稳定也不保证供应商渲染稳定。**工程上必须同时记录本地前缀指纹和供应商 Usage，前者用于解释输入，后者用于确认结果。

<a id="stable-prefix"></a>

## 用“稳定前缀 + 动态尾部”构造上下文

稳定前缀不是把所有长期数据都塞进 system prompt。它是一段经过版本治理、会被许多请求重复使用，并且在业务上适合共享的模型输入。

推荐把 Context Builder 拆成五层：

```text
┌──────────────────────────────────────────────┐
│ 1. Agent 基础指令：角色、边界、输出原则      │  稳定
├──────────────────────────────────────────────┤
│ 2. 能力契约：工具 schema、输出 schema        │  稳定
├──────────────────────────────────────────────┤
│ 3. 版本化共享上下文：规则、示例、核心知识包  │  稳定或低频变化
╞══════════════ Prompt Cache 边界 ═════════════╡
│ 4. 本轮选择上下文：检索片段、用户记忆、状态  │  动态
├──────────────────────────────────────────────┤
│ 5. 对话尾部：近期消息、工具结果、当前问题    │  动态
└──────────────────────────────────────────────┘
```

### 第一层：基础指令必须版本化

不要在运行时用字符串拼接随意改写基础指令。把它作为正式制品管理，例如 `support-agent:v7`，并让变更经过评审和回归测试。环境名、请求时间和用户姓名不应混入这一层。

不同语言、租户策略或实验组确实需要不同指令时，应把它们视为不同的“缓存族”，显式进入版本标识，而不是假装所有请求共享一个前缀。

### 第二层：工具 schema 要确定性生成

工具列表常被忽略，但供应商通常会把它纳入模型输入。应做到：

- 工具按稳定键排序；
- JSON Schema 使用规范化序列化；
- 描述文本和枚举顺序固定；
- 权限组合映射为少量版本化工具包，而不是每个请求临时删改；
- 工具变更后提升 `tool_bundle_version`。

权限仍然必须由 Runtime 在执行时强制校验。不能为了缓存命中，把用户无权使用的工具暴露给模型；合理做法是按权限档位形成多个稳定工具包。

### 第三层：只放真正共享的知识

产品规则、风格指南、固定 few-shot 示例和经过发布治理的核心知识适合进入前缀。查询相关的 RAG 片段、实时库存和用户偏好通常不适合，因为它们会随问题变化。

如果某个租户拥有独立且长期稳定的大型知识包，可以为其建立专属缓存族。此时版本必须绑定知识快照，例如 `policy_pack:2026-08-01`；知识更新后切换新版本，让旧缓存自然淘汰。

### 第四、五层：接受动态，但不要让它们污染前缀

当前问题、短期记忆、检索结果、工具调用 ID 和工具输出本来就会变化。优化目标不是消灭变化，而是把变化尽量推到缓存边界之后。

对于多轮 Agent，还要警惕“完整历史持续 append”。历史越长，前几轮虽然可能复用，但新增工具调用、动态引用和不稳定元数据也会不断扩大尾部。上下文压缩解决窗口增长，Prompt Cache 解决重复计算；两者目标不同，应分别设计。

<a id="determinism"></a>

## 稳定构造不是靠约定，而是靠确定性

一个可维护的 Context Builder 应该输出两样东西：模型请求，以及描述稳定部分的 `CacheProfile`。下面是讲解伪代码：

```python
# 讲解伪代码：字段名不绑定具体 SDK
def build_model_request(state, model):
    profile = CacheProfile(
        agent_version="support-agent:v7",
        tool_bundle_version="support-tools:v3",
        policy_pack_version="policy:2026-08-01",
        locale=state.locale,
        model_family=model.cache_family,
    )

    stable_prefix = [
        load_versioned_instructions(profile.agent_version),
        canonical_tool_schemas(profile.tool_bundle_version),
        load_policy_pack(profile.policy_pack_version),
    ]

    dynamic_tail = [
        select_user_memory(state),
        retrieve_relevant_evidence(state.current_query),
        recent_messages(state),
        state.current_query,
    ]

    return ModelRequest(
        input=stable_prefix + dynamic_tail,
        cache_key=sha256(canonical_json(profile)).hexdigest(),
        cache_boundary=len(stable_prefix),
    )
```

这里有四个重要设计点。

第一，缓存键描述的是**前缀等价类**，不是单次请求。若把 `request_id`、当前问题的 hash 或随机 UUID 放进键，每个请求都会成为新缓存族。

第二，键应由版本标识生成，而不是包含原始 Prompt、邮箱或用户隐私。缓存键不是授权凭证，也不能替代租户隔离。

第三，`canonical_json()` 必须定义明确的字段顺序、空值策略、Unicode 和数字格式。仅仅调用语言默认的 `str(dict)`，跨进程或跨语言时并不可靠。

第四，本地还应计算 `stable_prefix_fingerprint`。它只用于日志和回归测试，帮助判断两次请求是否真的生成了同一前缀；不要误把它当成供应商命中证据。

建议让下面这些字段都成为可观测元数据：

| 字段 | 用途 |
| --- | --- |
| `agent_version` | 定位基础指令变化 |
| `tool_bundle_version` | 定位工具 schema 变化 |
| `policy_pack_version` | 定位共享知识变化 |
| `cache_key_fingerprint` | 关联同一缓存族，不记录原始键 |
| `stable_prefix_fingerprint` | 对比本地稳定前缀是否一致 |
| `stable_prefix_tokens` | 判断是否达到供应商最低门槛 |
| `dynamic_tail_tokens` | 判断动态内容是否侵入前缀 |

<a id="cache-key"></a>

## `prompt_cache_key`、断点和粘性路由各做什么

以 OpenAI 协议为例，`prompt_cache_key` 会与前缀 hash 一起参与路由，帮助共享长前缀的请求靠近同一缓存位置。它不会把不同前缀强行变成同一个缓存条目。官方还建议控制单个 key 的请求速率；高并发场景要稳定分片，而不是让所有流量挤进一个 key。[[1]](#ref1)

在 GPT-5.6 及后续模型家族中，OpenAI 进一步引入显式 `prompt_cache_breakpoint`。默认隐式断点位于最新的 user 或 tool 消息；如果动态内容已经进入该断点，即使前面共享了数千 token，也可能得到 `cached_tokens = 0`。此时应在稳定内容末尾设置显式断点，并让共享该前缀的请求复用同一个 key。[[1]](#ref1)

下面是一个缩减后的 OpenAI 请求形状。它用于说明字段位置，不代表所有 MaaS 平台都支持这些参数：

```json
{
  "model": "gpt-5.6",
  "prompt_cache_key": "support-agent-v7-shard-03",
  "prompt_cache_options": {
    "mode": "explicit"
  },
  "messages": [
    {
      "role": "system",
      "content": [
        {
          "type": "text",
          "text": "这里是足够长且版本固定的指令、规则与示例……",
          "prompt_cache_breakpoint": {
            "mode": "explicit"
          }
        }
      ]
    },
    {
      "role": "user",
      "content": "这里是每次变化的当前问题"
    }
  ]
}
```

老模型、其他供应商以及 OpenAI 兼容 MaaS 未必接受 `prompt_cache_options` 或断点字段。兼容接口只说明请求外形相似，不等于缓存能力、路由实现、保留时长和 Usage 语义完全一致。接入前必须做能力探测。

网关侧的 channel affinity 则是另一层机制：

```text
prompt_cache_key
      │
      ▼
MaaS affinity map ──→ channel 12 ──→ provider cache location
```

它能提高请求回到同一渠道的概率，却不能证明渠道内部选中了同一模型实例，也不能证明前缀匹配。排障时应分别记录 affinity 是否使用、最终 channel/region、供应商缓存读取量，不能把三者合成一个布尔值。

<a id="sdk-maas"></a>

## SDK 接入 MaaS 时最容易断在哪里

Agent 框架经常替开发者封装模型调用，但“自动生成缓存键”可能带条件。以 OpenAI Agents SDK `0.19.4` 为例，Responses 与 Chat Completions 适配器只有在客户端指向官方 `api.openai.com` 时，才声明支持默认缓存键；自定义 MaaS `base_url` 不满足这个判断。随后，resolver 还会检查调用方是否已在 `ModelSettings` 中显式提供 key，并使用 `conversation_id`、Session、`group_id` 或本次 Run 作为分组来源。缺少跨调用分组标识时，自动 key 只保证在当前 Run 内复用。[[4]](#ref4)

这不是所有 SDK 的统一规则，却说明了一个普遍风险：切换到兼容端点后，SDK 可能保守关闭只为官方端点验证过的能力。接入时必须检查当前版本的实际出站请求，必要时显式传入 key 或使用框架提供的扩展点，不能依据类名中有 “OpenAI” 就推断行为完全一致。

这类故障的典型链路是：

```text
1. Runtime 没有传稳定 conversation/session/group 标识
2. 自定义 MaaS 模型没有声明“支持默认 prompt_cache_key”
3. SDK 因此不生成 key
4. 请求体到达网关时没有 prompt_cache_key
5. 网关的 affinity 规则没有取值，跳过粘性路由
6. 请求仍能正常生成答案，但缓存局部性下降
7. 应用只保存 input/output/total tokens，又看不到 cached tokens
```

这解释了为什么“模型能正常回答”不能证明缓存链路完整。兼容性测试至少要捕获 SDK 发出的最终请求体，而不是只看 Runtime 调用参数。

对每一种 SDK、协议和 MaaS 渠道，建立一张能力表：

| 能力 | 要验证的问题 |
| --- | --- |
| 字段生成 | SDK 会自动生成 key，还是必须通过 `extra_args` 显式传入 |
| 字段透传 | 网关 DTO、参数过滤和协议转换是否保留 key、断点与 retention |
| 稳定分组 | key 能否跨同一会话、同一缓存族复用 |
| 模型支持 | 当前模型是否支持自动缓存、显式断点和所需 TTL |
| 路由局部性 | 同一 key 是否稳定落到相同渠道、区域或部署 |
| Usage 回传 | 流式和非流式响应是否都保留缓存读写 token |

<a id="provider-differences"></a>

## 不同供应商的实现不能强行抹平

截至 2026 年 8 月，主流接口表达同一目标的方式并不相同：

| 实现 | 如何指定可复用内容 | 读取命中证据 | 工程注意点 |
| --- | --- | --- | --- |
| OpenAI Prompt Caching | 自动精确前缀；新模型可配 key 与显式 breakpoint | `cached_tokens`；新模型另有 `cache_write_tokens` | key 参与路由但不替代前缀匹配；模型代际行为不同 |
| Anthropic Prompt Caching | 请求级自动缓存或内容块 `cache_control` 断点 | `cache_read_input_tokens`，写入看 `cache_creation_input_tokens` | 默认短 TTL，可按能力选择更长 TTL；工具、system、messages 的顺序影响前缀 |
| Google Context Caching | 隐式自动缓存，或创建显式 Context Cache 并按资源名引用 | `cachedContentTokenCount` | 显式缓存有独立资源生命周期和存储成本；最低 token 门槛随模型变化 |

Anthropic 官方 Cookbook 展示了请求级 `cache_control`、内容块断点，以及独立的创建和读取 token 统计。[[2]](#ref2) Google 则明确区分隐式与显式缓存：后者需要创建、引用、更新 TTL 或删除一个 Context Cache 资源。[[3]](#ref3)

因此，网关的统一指标可以叫 `cache_read_tokens` 和 `cache_write_tokens`，但必须同时保存：

- 原始供应商和模型；
- 原始 Usage 字段；
- 归一化规则版本；
- 当前输入 token 口径是否包含缓存读取 token；
- retention、区域和缓存模式。

没有这些维度，一个跨供应商的“命中率 42%”很可能没有可比意义。

<a id="verification"></a>

## 如何证明缓存真的命中了

不要只发送两次完全相同的短请求，然后凭第二次更快就宣布成功。网络抖动、排队和模型负载都会影响延迟；太短的输入还可能根本达不到缓存门槛。

建议准备一个超过当前模型最低门槛的固定前缀，并运行下面的最小实验矩阵：

| 实验 | key | 稳定前缀 | 动态尾部 | 预期用途 |
| --- | --- | --- | --- | --- |
| A：冷启动 | K1 | P1 | Q1 | 观察首次写入或未命中 |
| B：同族复用 | K1 | P1 | Q2 | 验证尾部变化时仍能读取 P1 |
| C：前缀突变 | K1 | P2 | Q2 | 验证 key 相同也不能掩盖前缀变化 |
| D：错误分组 | K2 | P1 | Q2 | 验证换 key 或路由后局部性是否下降 |
| E：过期重试 | K1 | P1 | Q3 | 验证 TTL/淘汰后的行为 |

对于支持显式断点的模型，再增加两组：只修改断点后的内容，以及修改断点前的内容。前者应该仍能复用稳定段，后者应该失配。

每组不要只跑一次。缓存通常是 best-effort 系统，应在受控速率下重复多轮，并记录以下原始证据：

```text
request_id
provider / model / API mode
agent_version / tool_bundle_version / policy_pack_version
cache_key_fingerprint / stable_prefix_fingerprint
stable_prefix_tokens / total_input_tokens
affinity_rule / selected_channel / region
cache_mode / breakpoint / retention
cache_read_tokens / cache_write_tokens
time_to_first_token / total_latency
raw_usage_schema_version
```

核心指标至少包括：

```text
缓存读取率 = cache_read_tokens / input_tokens
写后复用率 = 后续 cache_read_tokens / 先前 cache_write_tokens
证据覆盖率 = 带缓存 Usage 的合格请求数 / 合格请求总数
```

第一项回答“本次输入有多少被复用”，第二项帮助判断写缓存是否值得，第三项防止监控系统把“字段丢失”错误计算成“确定未命中”。不同供应商的 input token 口径可能不同，归一化前要先核对协议。

冷请求也可能命中已有缓存，热请求也可能因淘汰、分流或后端负载而未命中。验收标准应写成多轮统计和证据链，而不是“第一次必须为 0、第二次必须大于 0”的脆弱断言。

<a id="troubleshooting"></a>

## 从 `cached_tokens = 0` 开始逐层排障

排障顺序应与数据流一致。

### 第一步：确认请求有资格被缓存

- 模型和 API 模式是否支持 Prompt Cache；
- 稳定前缀是否达到当前模型的最低 token 门槛；
- retention 是否已过期；
- 测试速率是否触发同一 key 的分流；
- 显式断点是否放在受支持的内容块上。

### 第二步：比较真正的前缀

- 两次请求的 `stable_prefix_fingerprint` 是否一致；
- system/developer 指令是否包含时间、ID 或动态引用；
- tools 和 response schema 是否同序、同版本；
- RAG、memory、近期消息是否被放到了稳定段之前；
- 图片、文件和 SDK 渲染方式是否变化。

不要只对比用户输入文本。最终模型请求还包含指令、工具和适配器生成的内容。

### 第三步：检查 SDK 的最终出站请求

- key 是自动生成、显式传入，还是根本没有；
- 同一 Runner 内稳定，是否也能跨下一次 Runner 调用稳定；
- 自定义 `base_url` 是否改变了模型能力判断；
- 流式和非流式路径是否使用了不同适配器；
- SDK 升级前后请求结构是否发生漂移。

### 第四步：检查 MaaS 网关

- 请求 DTO 是否声明并保留缓存字段；
- 参数白名单、override 和协议转换是否删除或重命名字段；
- affinity 规则实际从哪个 path/header 取值；
- 缺少 key 时是跳过、生成默认值，还是按其他字段路由；
- 重试是否切换了 channel、region 或供应商；
- 网关是否把 Usage 细节裁剪成只有 total tokens。

### 第五步：检查供应商返回的原始 Usage

- 原始响应中缓存读取字段是否存在；
- 值为 `0`，还是字段在网关转换后消失；
- 是否只有写入 token，没有后续读取；
- 流式完成事件是否包含最终 Usage；
- 账单口径是否与 API Usage 一致。

如果原始供应商响应已经显示读取大于 `0`，故障就在 Usage 归一化或应用持久化层；如果供应商为 `0`，再回头检查前缀、路由和资格。这样能避免在无证据时反复调整 TTL 或缓存键。

<a id="anti-patterns"></a>

## 六个常见反模式

### 1. 用会话 ID 解决所有缓存问题

会话 ID 可以提高同一会话多轮请求的局部性，但它会把原本跨会话共享的基础指令切成许多缓存族。应先确定复用范围：同一 Agent 版本、同一租户策略，还是仅同一会话。

### 2. 缓存键包含当前请求 hash

这看似“精确”，实际上让每次请求拥有新 key。键应表示稳定前缀版本，不应表示动态尾部。

### 3. 把 RAG 结果放在最前面

检索结果随查询变化，会让公共前缀在很早的位置失配。共享规则在前，查询相关证据在缓存边界后，通常更合理。

### 4. 为了稳定工具列表而放松权限

缓存优化不能越过安全边界。按权限档位生成稳定工具包，并在执行器再次鉴权；不要让无权用户仅靠 Prompt 约束获得工具入口。

### 5. 只存 total tokens

这样既无法证明命中，也无法核算节省。缓存读写 token、原始 Usage 和归一化版本都应进入日志或指标系统。

### 6. 用延迟下降代替 Usage 证据

TTFT 下降是有价值的结果指标，但不是缓存命中的唯一解释。正确做法是同时看前缀指纹、路由、Usage、TTFT 和成本。

<a id="rollout"></a>

## 在现有 Agent 中逐步引入

不必一次重写整个上下文系统，可以按下面的顺序推进。

第一阶段只做观测：捕获最终出站请求的结构摘要，记录基础指令、工具包和共享知识的版本，保存缓存 Usage。此时不要急着改 Prompt。

第二阶段建立确定性：规范化工具和 schema 的排序，移除前缀里的时间戳与随机 ID，为基础指令和共享知识建立版本号，并增加前缀指纹回归测试。

第三阶段接入缓存控制：按供应商能力显式传 key、断点或 Context Cache 引用；让 MaaS 网关透传字段，并按合理粒度做 affinity。缓存族映射应稳定且可灰度。

第四阶段做受控实验：用固定长前缀跑冷、热、突变、换 key 和过期矩阵，对比读取 token、写入 token、TTFT 与费用。先在单模型单渠道证明，再扩大范围。

第五阶段建立持续治理：Prompt、工具、知识包或 SDK 升级时，自动运行前缀稳定性测试和缓存实验；仪表盘按 provider、model、agent version、channel 和 cache family 分组。

<a id="tests"></a>

## 应该补哪些自动化测试

### Context Builder 单元测试

```text
同一版本 + 不同当前问题 → stable_prefix_fingerprint 相同
基础指令升级             → fingerprint 改变
工具输入顺序不同         → 规范化后 fingerprint 相同
权限档位不同             → tool_bundle_version 与 fingerprint 改变
动态 memory/RAG 变化     → 只改变 dynamic tail
```

### SDK 与网关契约测试

```text
显式 prompt_cache_key → 最终出站请求仍存在
缓存断点             → 协议转换后位置和内容不变
同一 cache family    → affinity 选择一致
渠道重试             → 日志明确记录是否丢失局部性
供应商 Usage         → 原始字段和归一化字段同时保存
```

### 凭证化在线探测

离线契约测试只能证明代码“会发送字段”，不能证明 MaaS 和供应商真的支持。CI 或发布门禁还需要一组使用受限凭证的在线探测，运行长前缀实验矩阵，并把供应商原始 Usage 作为制品保存。无法运行在线探测时，应把结论写成“离线兼容”，不能写成“缓存已命中”。

<a id="checklist"></a>

## 上线检查表

- [ ] 明确区分业务状态、模型上下文、路由粘性和供应商 Prompt Cache；
- [ ] 基础指令、工具包和共享知识均有稳定版本；
- [ ] 动态 memory、RAG、时间戳、UUID 和当前问题位于缓存边界之后；
- [ ] 工具与 JSON Schema 使用确定性排序和规范化序列化；
- [ ] 缓存键代表前缀等价类，不含原始隐私和单次请求 ID；
- [ ] SDK 的最终出站请求已确认带有所需字段；
- [ ] MaaS 网关会透传字段，并记录 affinity 与最终渠道；
- [ ] 当前模型、协议、最低 token、断点和 TTL 已做能力探测；
- [ ] 应用保存供应商原始 Usage、缓存读写 token 和归一化版本；
- [ ] 长前缀实验覆盖冷启动、复用、前缀突变、换 key 和过期；
- [ ] 验收以多轮 Usage 证据为准，不以单次延迟或 key 相同为准；
- [ ] 在线探测与离线契约测试的结论明确分开。

最后把整篇文章压缩成一句工程原则：

> **先把上下文构造成可重复的稳定前缀，再用缓存键和路由提高局部性，最后用供应商 Usage 证明命中。没有证据链的“缓存优化”，只是一个尚未验证的配置。**

<a id="references"></a>

## 参考资料

<a id="ref1"></a>

1. OpenAI, [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching). 本文核对日期：2026-08-13。

<a id="ref2"></a>

2. Anthropic, [Prompt caching cookbook](https://github.com/anthropics/claude-cookbooks/blob/main/misc/prompt_caching.ipynb). 本文核对日期：2026-08-13。

<a id="ref3"></a>

3. Google Cloud, [Context caching overview](https://cloud.google.com/vertex-ai/generative-ai/docs/context-cache/context-cache-overview). 本文核对日期：2026-08-13。

<a id="ref4"></a>

4. OpenAI Agents SDK `0.19.4`, [Prompt cache key resolver](https://github.com/openai/openai-agents-python/blob/v0.19.4/src/agents/run_internal/prompt_cache_key.py)、[OpenAI endpoint detection](https://github.com/openai/openai-agents-python/blob/v0.19.4/src/agents/models/openai_client_utils.py)、[Responses adapter](https://github.com/openai/openai-agents-python/blob/v0.19.4/src/agents/models/openai_responses.py) 与 [Chat Completions adapter](https://github.com/openai/openai-agents-python/blob/v0.19.4/src/agents/models/openai_chatcompletions.py)。本文核对日期：2026-08-13。
