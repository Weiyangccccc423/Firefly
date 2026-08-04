---
title: "长期记忆不是聊天记录：解读 Grok Build 的持久化记忆系统"
published: 2026-07-24
description: "从 Grok Build 源码解读跨会话长期记忆的存储、索引、检索、注入与归并。"
tags: ["AI Agent","记忆系统","Grok Build"]
category: "AI Agent"
---

<a id="conclusion"></a>

## 先给结论：这是检索系统，不是对话回放

Grok Build 的跨会话记忆由 `xai-grok-memory` 提供核心能力，`xai-grok-shell` 在会话生命周期中编排它，`xai-grok-tools` 则把它暴露为只读工具。它保存的不是某个模型实例的内部状态，也不会在新会话开始时把历史聊天全文重新发送给模型。

> **设计的关键分层：**Markdown 文件保存可审阅、可手工编辑的知识；SQLite 的 FTS5 和可选向量表只保存检索副本；每次使用时按当前任务检索少量片段。删掉索引可以重建，删掉 Markdown 才是数据丢失。

```text
1. 提炼对话在 session end、预压缩或空闲时由模型归纳为结构化 Markdown。 2. 落盘全局偏好、项目知识与会话日志保存在用户 Grok Home 下。 3. 建索引按 Markdown 结构分块，写入 FTS5；可选生成 embedding 并写入 sqlite-vec。 4. 取回首轮、压缩恢复或模型工具调用以当前查询取回相关片段。
```

因此，它解决的是“未来会话如何找到此前有效的决策、约定和排障知识”，而不是“如何在同一个上下文窗口里继续一段对话”。后一个问题由上下文压缩负责，二者在预压缩 flush 和压缩后的记忆恢复处相连，但存储模型不同。

<a id="boundaries"></a>

## 三种“记忆”及其边界

代码中 `memory` 一词也会指进程内状态或性能指标。阅读时最重要的是先把持久化记忆与它们区分开。

| 概念 | 保存什么 | 生命周期 | 主要实现 |
| --- | --- | --- | --- |
| 当前会话上下文 | 本轮消息、工具调用、运行时状态。 | 一个会话；受上下文窗口限制。 | `xai-chat-state`、`session/compaction.rs` |
| 跨会话持久化记忆 | 全局偏好、项目知识、已提炼的会话摘要。 | 跨进程、跨会话；显式清理前保留。 | `xai-grok-memory` |
| Agent 专属记忆 | 某个自定义 Agent 的独立知识库。 | 取决于 `user`、`project` 或 `local` 作用域。 | `xai-grok-agent/src/config.rs` |

第三项复用同一套存储与检索机制，但目录是按 Agent 名称独立解析的：`user` 指向 `~/.grok/agent-memory/<name>/`；`project` 和 `local` 分别位于项目中的 `.grok/agent-memory/` 与 `.grok/agent-memory-local/`。这与普通记忆写入时的 `Global`/`Workspace` 选择是两种不同的 scope。

<a id="storage"></a>

## 持久化模型：Markdown 是事实源

`MemoryStorage` 默认根目录是 `~/.grok/memory/`。会话初始化时会创建目录和两个 `MEMORY.md` 模板，并枚举其中的 Markdown 文件建立索引。典型布局如下：

```
~/.grok/memory/
├── MEMORY.md                         # 跨项目的人工维护知识
└── widgets-a3f7b2c9/                 # 一个工作区
    ├── MEMORY.md                     # 项目长期知识，由 dream 归并
    ├── index.sqlite                  # 可删除、可重建的检索索引
    └── sessions/
        └── 2026-07-17-auth-1234abcd.md  # 提炼后的会话日志
```

工作区目录格式为 `{slug}-{hash8}`。若当前目录属于有 `origin` 的 Git 仓库，身份优先取规范化后的 `org/repo`，因此同一仓库的 clone 和 worktree 共享记忆；没有可用 remote 时，才以规范化后的文件系统路径作为 hash 输入。`slug` 只是可读性，8 位 BLAKE3 前缀负责区分。

| 来源标记 | 文件 | 语义 | 检索时效策略 |
| --- | --- | --- | --- |
| `global` | 根目录 `MEMORY.md` | 跨项目偏好和稳定约定。 | 视为常青知识，不做时间衰减。 |
| `workspace` | 工作区 `MEMORY.md` | 项目架构、关键决定和长期技巧。 | 视为常青知识，不做时间衰减。 |
| `session` | `sessions/*.md` | 单次或阶段性工作中提取的候选知识。 | 按半衰期降权，并在归并后可被清理。 |

> **临时工作目录不会产生工作区记忆。**`MemoryStorage` 对 `/tmp`、`/var/tmp` 和 macOS 临时目录标记为 ephemeral；工作区的初始化、追加和会话日志写入会跳过。这样不会为短命 worktree 和子任务留下大量孤儿目录。

<a id="write"></a>

## 写入与归并：flush 和 dream 做了什么

系统不直接把原始聊天记录写进记忆文件，而是让模型产出结构化摘要，再用多层检查决定是否持久化。这里有两条不同粒度的写入路径。

### 1. Flush：在上下文变满前保住本次发现

`session/helpers/memory_flush.rs` 会在压缩阈值之前预留 headroom 触发 flush。默认 headroom 是 4000 tokens，且同一次 compaction 只允许 flush 一次。它向模型发送专用提示词，要求仅记录未来会话真正有用的决策、技术上下文、排障方法和问题解法，明确排除瞬时进度及操作系统、shell、编辑器等用户偏好。

```
// 讲解伪代码：run_memory_flush 的关键路径
recent = select_recent_messages_at_a_user_boundary(conversation)
summary = model.call(FLUSH_SYSTEM_PROMPT, recent)

if summary != NO_REPLY and has_markdown_headers(summary):
    if not exact_duplicate(summary) and not semantic_duplicate(summary):
        append sessions/YYYY-MM-DD-{trigger}-{sid8}.md
        reindex_and_embed(the_written_file)
```

输出为空、等同 `NO_REPLY`、或缺少 Markdown 标题时不会写入；默认最长只接受 8000 个字符。精确去重使用 chunk 内容的 BLAKE3 hash；若 embedding 和向量索引可用，还会做近邻检索，将余弦相似度高于阈值的近似重复内容跳过。默认相似度阈值为 0.92。

### 2. Dream：把会话日志提炼成项目知识

`dream.rs` 将多个 session 日志和既有项目 `MEMORY.md` 交给一次专用模型调用，要求合并、去重、淘汰过时内容，并输出可维护的 Markdown。成功后它会**覆盖工作区的** `MEMORY.md`，再只删除确实被该次归并读取且不在最近 5 分钟内修改过的 session 文件。

> **默认 gate：**dream 必须启用、距离上次归并至少 4 小时、并且至少积累 3 个合格 session。输入总量最多 32000 个字符，已有长期记忆最多占一半；输出最多 16000 个字符且必须带 Markdown 标题。锁文件阻止并发归并，过期锁才会被回收。

这个两阶段设计很实用：flush 优先保证“即将压缩的会话别丢新发现”，而 dream 则将噪声较多、带时效的日志变成较短的项目长期知识。二者都可返回 `NO_REPLY`，因此“没有值得记住的内容”也是正常结果，而不是写入失败。

<a id="index"></a>

## 索引和外部编辑如何保持一致

`index.sqlite` 有三层数据：`chunks` 保存路径、行号、正文、hash、来源和访问记录；`chunks_fts` 是 contentless FTS5 虚表；当 sqlite-vec 可加载时，会额外创建 `chunks_vec` 存 embedding。向量扩展不可用、没有配置 embedding model、或 embedding 请求失败时，系统仍可正常以 FTS-only 工作。

### Markdown 感知的分块

索引不是按固定字节窗口切开。`chunk_markdown()` 先按 Markdown 标题栈分节，再在段落和行边界拆分大段，连续块会带上父标题上下文和前一块的尾部重叠文本。默认上限为 1600 字符、overlap 为 320 字符；字符数仅作为 token 数的近似。

```
## Authentication
### Token refresh
...

分块后的 continuation：
[Context: ## Authentication]

### Token refresh
...
```

每块保留源文件的 0-based 行范围，因而检索结果可以指向具体文件和行号；`memory_get` 还会以 1-based 行号返还指定范围的完整正文。

### 手工编辑不会让索引永久过期

用户可以直接修改 Markdown。`MemoryFileWatcher` 递归监听 memory 根目录下的 `.md` 创建、修改和删除事件，并将脏路径累积在无锁读取的集合中。下一次 `memory_search` 才实际同步：新增或修改文件重建索引，已删除文件从 chunks、FTS 和向量表中在同一个事务内移除。

多个进程可能同时搜索同一工作区。索引通过 `meta.reindex_claim` 的原子更新抢占一次 reindex 权，默认 60 秒后才可回收失效 claim。这样编辑同步不需要一个常驻的全局写锁，也避免所有会话在下一次搜索时重复建索引。

<a id="search"></a>

## 混合检索如何排序

`hybrid_search()` 的结果不是简单的向量最近邻。它先取 FTS5 BM25 候选和全局/工作区常青来源的补充候选；若向量可用，再为查询生成 embedding 并做 KNN；最后按 chunk ID 合并、排序、筛选和截断。候选数是目标返回数的三倍，降低后处理过早截断的风险。

```text
score = base_relevance × temporal_decay × source_weight × access_boost
```

`base_relevance` 由归一化的 BM25 和向量相似度给出。两者同时命中时按可配置权重合成，默认文本 0.3、向量 0.7，但结果不会低于纯 FTS 分数；只有 FTS 命中的块也不会因为缺向量而被降成 0.3 倍。这样在模型 embedding 未配置或新块尚未嵌入时，关键词检索仍然可用。

- **时间衰减：**默认只对 `session` 应用 7 天半衰期的指数衰减；`global` 和 `workspace` 保持常青。
- **来源权重：**可分别调整三类来源的优先级，默认都为 1.0。
- **访问提升：**被反复取用的块有很小的 `ln(1 + access_count)` 加成，不会替代相关性本身。
- **MMR 去重：**默认关闭；开启后用 snippet 的 Jaccard 相似度重排，减少结果列表中多个近似片段占满名额。
- **内容过滤：**只有标题、空白或已知初始化模板的块不会进入结果，避免新建的 `MEMORY.md` 变成无意义上下文。

session 结果超过 1 天会在工具输出中提示验证，超过 7 天会明确标为 stale；常青来源不显示这类警告。时效提醒并不阻止模型使用结果，它提醒模型把旧会话信息作为待验证线索，而不是当前事实。

<a id="use"></a>

## 模型怎样使用记忆

系统没有把所有记忆自动注入每一轮。当前实现提供三条回流路径，每条都有不同的成本和触发条件。

| 路径 | 查询 | 注入/输出 | 目的 |
| --- | --- | --- | --- |
| 首轮自动注入 | 最后一个真实用户请求；问候或短文本时退化为项目约定查询。 | 最多 6 条、每条最多 500 字符的 `<memory-context>`。 | 让新会话快速获得与任务相关的历史。 |
| 压缩后恢复 | 压缩后的最后真实用户请求。 | 作为 runtime `<system-reminder>` 的一部分。 | 上下文压缩后重新找到跨会话知识。 |
| 模型主动工具调用 | `memory_search` 的具体技术查询。 | 带分数、来源、文件和行范围的结果；再用 `memory_get` 读取全文。 | 按需深入，不把不相关历史提前塞入 prompt。 |

首轮路径还会检测现有 conversation 的 leading system message 中是否已有 `<memory-context>`。若存在便复用而不是再次检索，因为重新排序的块会改变 system prompt 前缀，从而破坏下游模型的 prompt/KV cache。这个细节说明“检索正确”之外，稳定的 prompt 形状也是性能约束。

```
// 模型可见的典型工具序列
memory_search({ query: "authentication middleware patterns" })
  -> 结果含文件路径、行范围、片段、来源、分数

memory_get({ path: ".../MEMORY.md", from: 24, lines: 40 })
  -> 带 1-based 行号的完整上下文
```

两个工具都声明为只读。`memory_search` 使用后端配置的默认结果数与阈值；`memory_get` 在读取前 canonicalize 请求路径和记忆根目录，只有规范化后仍位于记忆目录树内的路径才允许读取。这使模型不能借由该工具读取任意本地文件。

<a id="safety"></a>

## 并发、安全和生命周期细节

长期记忆最容易在边界条件上失真，当前实现中有几处值得借鉴的防线：

1. **索引可重建。**Markdown 是事实源，SQLite 失败或向量扩展缺失只会降级检索，不会抹掉知识原文。
2. **删除也会同步。**watcher 不只处理 create/modify；文件不存在时显式删除其旧 chunks，避免已删知识持续被模型检索。
3. **写入有质量门。**flush 和 dream 都拒绝空响应、`NO_REPLY` 和缺标题的文本；flush 还有精确及语义去重。
4. **归并不删除活跃日志。**dream 成功后仅删除实际参与输入、且超过 5 分钟未修改的文件；近期修改意味着可能有并发会话仍在追加。
5. **网络文件系统考虑。**索引打开经由 `xai-sqlite-journal` 选择 journal mode，代码特别避免在网络挂载上 mmap 旧 WAL 的 `-shm` 文件。
6. **垃圾回收保守。**启动时只清理空的、过期的工作区目录；有 session 内容的普通工作区不会被 GC。默认空目录保留期为 30 天，`tmp*` 目录单独按 7 天策略处理。

> **工程上的取舍：**外部编辑的同步延迟到下一次搜索，而不是在文件事件回调中立即写 SQLite。这让 watcher 保持轻量，同时在实际需要答案时保证索引最新。代价是第一次搜索需要承担该次 reindex 成本。

<a id="config"></a>

## 关键配置与默认行为

完整聚合配置位于 `xai-grok-shell/src/config/mod.rs`，具体值类型在 `xai-grok-config-types/src/memory.rs`。记忆默认关闭，可通过 `--experimental-memory`、`GROK_MEMORY=1` 或配置启用；`--no-memory` 和 `GROK_MEMORY=0` 用于显式禁用。以下示例只展示最常需要调整的项：

```
[memory]
enabled = true

[memory.index]
max_chunk_chars = 1600
chunk_overlap_chars = 320

[memory.embedding]
# model 未设置时保持 FTS-only；设置后才会尝试 embedding 和向量检索
model = "your-embedding-model"
dimensions = 1024

[memory.search]
max_results = 6
min_score = 0.35
vector_weight = 0.7
text_weight = 0.3

[memory.search.temporal_decay]
enabled = true
half_life_days = 7.0

[memory.initial_injection]
enabled = true

[memory.dream]
enabled = true
min_hours = 4
min_sessions = 3

[compaction.memory_flush]
enabled = true
soft_threshold_tokens = 4000
max_flush_write_chars = 8000
```

首轮自动注入默认开启，且没有显式 `min_score` 时沿用 0.0 的历史行为，优先保证新会话有可用的项目线索；模型主动 `memory_search` 则默认采用 `memory.search.min_score = 0.35`。两条路径的差异是刻意的：前者服务于初始化，后者服务于精确的按需检索。

> **不要把 embedding 看成系统前提。**默认 embedding model 为未设置状态，sqlite-vec 也可能无法加载。检索代码明确设计为 FTS-first 的优雅降级，配置 embedding 是提高语义召回，不是让记忆功能从无到有的开关。

<a id="sources"></a>

## 源码索引

按“存储事实源 - 建索引 - 检索 - 会话编排”的顺序阅读，最容易建立完整心智模型：

- `crates/codegen/xai-grok-memory/src/storage.rs`
   目录布局、工作区身份、Markdown 读写、临时目录跳过和 GC。
- `crates/codegen/xai-grok-memory/src/chunker.rs`
   Markdown 标题、段落和行边界感知的分块实现。
- `crates/codegen/xai-grok-memory/src/schema.rs` 与 `index.rs`
   SQLite 表、FTS5、sqlite-vec、增量 reindex、删除和 claim 协调。
- `crates/codegen/xai-grok-memory/src/search.rs`、`mmr.rs`、`backend.rs`
   混合召回、时间衰减、来源权重、MMR 和 FTS-only 降级。
- `crates/codegen/xai-grok-memory/src/dream.rs` 与 `dream_lock.rs`
   长期归并的 gate、输入/输出上限、锁和安全清理。
- `crates/codegen/xai-grok-shell/src/session/helpers/memory_flush.rs`
   预压缩 flush 的阈值、质量检查和语义去重。
- `crates/codegen/xai-grok-shell/src/session/acp_session_impl/spawn.rs`、`memory_dream.rs`、`turn.rs`
   会话启动、后台索引、flush/dream 调用和首轮记忆注入。
- `crates/codegen/xai-grok-tools/src/implementations/memory/`
   `memory_search` 与 `memory_get` 的只读工具接口。
- `crates/codegen/xai-grok-agent/src/config.rs`
   Agent 专属记忆的 `user`/`project`/`local` 目录解析。
