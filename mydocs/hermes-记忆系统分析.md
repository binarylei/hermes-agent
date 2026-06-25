# Hermes 记忆系统分析

> 前置阅读：[AIAgent 架构分析](hermes-AIAgent架构分析.md)（了解记忆管理在 10 环节流水线中的位置）、[工具系统分析](hermes-工具系统分析.md)（了解核心工具注册与分发机制）。

---

## 一、背景介绍

### 1.1 Agent 为什么需要记忆

LLM API 本质上是**无状态的函数调用**——每次请求都是一个独立的计算，服务端不保留任何历史。Agent 框架通过在每次请求时重发完整对话历史来"模拟"记忆，但这带来了三个根本性限制：

**问题一：跨会话遗忘。** 用户在会话 A 中花 30 分钟教 Hermes 自己的工作流偏好、项目路径、命名规范。一旦执行 `/new`，所有上下文归零，下次对话从"你好，我是 Hermes"重新开始。

**问题二：上下文窗口有限。** 每个模型有固定的上下文窗口（Claude Sonnet 200K、GPT-4o 128K、DeepSeek-V3 64K）。长对话超出窗口后，旧消息要么被截断（丢失信息），要么被压缩（丢失精度）。无论哪种方式，过去的细节都可能永久消失。

**问题三：多入口隔离。** Hermes 运行在 CLI、Telegram、Discord 等 20+ 平台上。用户在 Telegram 上说"我女儿叫小米，生日 3 月 15 号"，切换到 CLI 后 Hermes 一无所知——每个平台的 session 是独立的。

### 1.2 记忆的四个层次

从数据持久化的角度，Agent 的记忆需求可以拆分为四个递进的层次：

| 层次 | 范围 | 生命周期 | 核心问题 |
|------|------|---------|---------|
| **会话内上下文** | 当前 session 的对话历史 | 纯内存，API 调用时发送 | 窗口溢出后怎么办 |
| **会话归档** | 完整消息流水账 | SQLite 持久化，FTS5 全文索引 | 海量消息如何快速检索 |
| **跨会话记忆** | 跨 session 的用户知识和 agent 经验 | 向量库持久化，语义搜索召回 | 如何从历史中提取和召回相关信息 |
| **元认知记忆** | Agent 对自身和用户的显式建模 | 文件持久化，全量注入系统提示词 | 什么是"最重要"的信息 |

本文重点讨论后三层——LLM 上下文窗口之外、需要独立持久化和检索系统的"长期数据"。

### 1.3 业界怎么做的

在深入 Hermes 的方案之前，先看看业界其他 Agent 框架是如何处理记忆问题的。这能帮助我们理解 Hermes 设计决策背后的取舍。

#### Claude Code：索引 + 按需读取

Claude Code 使用基于文件的记忆系统。`MEMORY.md` 是一个**索引文件**，每行一个指针，指向 `memory/` 目录下的独立 `.md` 文件：

```markdown
# MEMORY.md（索引）
- [用户偏好](memory/user-prefs.md) — 用户偏好使用 pnpm 而不是 npm
- [项目路径](memory/project-paths.md) — 主项目位于 ~/code/myapp

# memory/user-prefs.md（实际内容，带 frontmatter 元数据）
---
name: user-prefs
description: 用户的包管理器和 TypeScript 偏好
metadata:
  type: user
---
用户偏好使用 pnpm 而不是 npm，TypeScript 严格模式
```

工作方式：会话启动时将索引全量加载到上下文，模型按需读取具体记忆文件。关键是，索引和按需读取发生在 **harness 层**（不进入被缓存的 system prompt），所以不会破坏 prompt cache。

#### LangMem（LangChain）

LangMem 提供三种记忆类型：
- **语义记忆**：提取用户事实到结构化 profile
- **程序性记忆**：记录操作步骤和工作流
- **情景记忆**：保存完整的对话片段

特点是每次 turn 后触发 LLM 提取调用（额外的 API 成本和延迟），提取结果存储为结构化 schema。缺点是不支持优雅降级——提取 LLM 失败则整轮阻塞。


#### 对比矩阵

| 维度                 | Claude Code | Hermes                | LangMem        |
| ------------------ | ----------- | --------------------- | -------------- |
| 自动记忆积累             | 手动为主        | ✅ 自动同步                | ✅ 每轮 LLM 提取    |
| 记忆组织结构             | 索引 + 按需读取   | 双轨（内置 + 外部向量库）        | 三类结构化 schema   |
| 语义搜索召回             | 索引全量加载      | ✅ prefetch 语义搜索       | ❌ 结构化查询        |
| 多后端可插拔             | ❌ 仅文件       | ✅ 8+ provider         | ❌ LangChain 生态 |
| 上下文压缩保护            | ❌           | ✅ on_pre_compress 钩子  | ❌              |
| 防 prompt injection | harness 层隔离 | ✅ threat scan + fence | ❌              |
| 提取不阻塞主循环           | N/A         | ✅ 后台线程                | ❌ 关键路径         |

---

## 二、核心逻辑

### 2.1 整体架构：三层分工与数据流

> **概念前置：Session / Turn / API call 的层级关系**
>
> | 层级 | 含义 | 生命周期 |
> |------|------|---------|
> | **Session** | 一次完整对话（`/new` 到下一次 `/new`） | 跨数天，包含 N 个 Turn |
> | **Turn** | 一次用户输入 → Agent 完整处理 → 最终响应 | `run_conversation()` 一次调用 |
> | **API call** | Turn 内的一次 LLM 推理请求 | 模型返回 text 则 Turn 结束，返回 tool_calls 则继续循环 |
> | **Tool call** | 一次工具执行 | 一次 API 调用可同时返回多个 tool_calls |
>
> 一个 Turn 内部的控制流：
> ```
> while not finished:
>     response = API.call(messages, tools)      ← 1 次 API call
>     if response.tool_calls:                    ← 可能 N 个 tool calls
>         execute_tools(response.tool_calls)
>         continue                               ← 继续循环，Turn 未结束
>     else:
>         return response.content                ← Turn 结束
> ```

下面三条记忆写入路径的触发粒度正对应上述层级：

| 写入路径                   | 触发粒度        | 触发方式                                                                                                         |
| ---------------------- | ----------- | ------------------------------------------------------------------------------------------------------------ |
| MemoryStore（MEMORY.md） | 按需          | LLM 主动调用 `memory(action="add")`                                                                              |
| MemoryProvider（外部向量库）  | 每 Turn + 按需 | ① `sync_turn()` 后台线程，Turn 结束时自动触发（主路径，存原始对话）；<br>② `on_memory_write()` LLM 调用 `memory` 工具时触发（桥接路径，转发内置层写入事件） |
| SessionDB（SQLite 归档）   | 每 Turn      | `_persist_session()`，Turn 退出时触发                                                                              |

Hermes 的记忆系统采用"窄腰 + 可插拔边缘"的架构，分为三层：

```
AIAgent (run_agent.py)
  │
  ├── SessionDB           ← 第一层：完整会话归档 (SQLite WAL)
  │     └── 每次 Turn 结束时批量写入整轮消息，FTS5 全文索引
  │
  ├── MemoryStore         ← 第二层：精选事实记忆（本地文件）
  │     └── MEMORY.md + USER.md，全量注入系统提示词（冻结快照）
  │
  └── MemoryManager       ← 编排器：第三层入口
        ├── builtin provider           ← 始终存在
        └── external provider ×1       ← 可插拔（Honcho / Mem0 / Hindsight / ...）
              └── 语义搜索 / 向量召回 / 自动积累
```

**为什么是三层而非两层？** 每层解决不同层面的问题，互不替代：

- **SessionDB（归档层）**：忠实记录原始字节，不做语义理解。当上层的语义记忆"记错了"或"找不到"时，FTS5 全文索引是最终的真相来源。
- **MemoryStore（精选层）**：少量、精选、确定性。LLM 在系统提示词中直接看到，用于"用户叫小米"、"项目在 ~/code/myapp"这类高信号事实。
- **MemoryProvider（语义层）**：完整、可搜索、自动积累。LLM 通过工具按需查询，用于"三个月前讨论的微服务拆分方案"这类低频但重要的信息。

**三层之间的耦合度几乎为零**。SessionDB 不感知上层的记忆语义；MemoryStore 和 MemoryProvider 不依赖 SessionDB。唯一的共同点是：在同一个 Agent 生命周期中，三条写入路径并行执行，各写各的。

#### 完整数据流时序

下图展示了一次 Turn 的完整数据流。Step 4（SessionDB 写入）和 Step 5（MemoryProvider 同步）在 Turn 结束时触发，与 Turn 内发生了多少次 API 调用（tool call 循环）无关。

```用户: "我女儿叫小米，帮我写个生日提醒脚本"
  │
  ▼
┌─ Turn 开始 ───────────────────────────────────────────────────┐
│  Step 1: prefetch_all(query)                                  │
│          → 剥离 skill 脚手架                                   │
│          → provider.prefetch(clean_query) 从向量库召回          │
│          → 返回原始文本（不做围栏包装）                          │
└────────────────────────────────────────────────────────────────┘
  │
  ▼
┌─ API 调用构建 ────────────────────────────────────────────────┐
│  Step 2: build_memory_context_block(prefetch_result)          │
│          → 包装为 <memory-context>...</memory-context>         │
│          → 附带 System note 注释                               │
│  Step 3: 拼接到用户消息尾部（api_msg 浅拷贝，不污染持久化）      │
└────────────────────────────────────────────────────────────────┘
  │
  ▼
┌─ LLM 推理 ────────────────────────────────────────────────────┐
│  LLM 看到:                                                     │
│  - 系统提示词: MEMORY.md 快照（"用户偏好 ruff"）                 │
│  - 用户消息: "写生日提醒脚本"                                   │
│  - 记忆注入: <memory-context>女儿叫小米，生日 2025-03-15</>     │
│  - 可用工具: honcho_search, memory, ...                        │
└────────────────────────────────────────────────────────────────┘
  │
  ▼
┌─ 响应返回 + 后台写入 ─────────────────────────────────────────┐
│  Step 4: SessionDB 写入（完整消息归档，与记忆写入并行）          │
│  Step 5: sync_all(user, assistant) → 后台写向量库              │
│  Step 6: queue_prefetch_all(query) → 预热下一轮（详见 2.5.1 节）   │
└────────────────────────────────────────────────────────────────┘
```

### 2.2 第一层：SessionDB — 完整会话归档

SessionDB 是记忆系统的**地基**。它不做语义理解，只忠实记录每条消息的原始字节。当上层的语义记忆"记错了"或"找不到"时，FTS5 全文索引是最终的真相来源。

#### 2.2.1 数据模型与索引策略

**双 FTS5 全文索引**覆盖不同语言场景。`messages_fts` 使用 unicode61 tokenizer 处理英文等空格分隔语言，`messages_fts_trigram` 使用 trigram tokenizer 处理 CJK 无空格语言。两套索引都通过触发器自动同步，索引字段为 `content || tool_name || tool_calls`——搜索工具名或工具返回的 JSON 内容都能命中。

**WAL 模式 + 随机抖动写入**解决多进程并发写冲突。多个 Hermes 进程（gateway + CLI + worktree agent）共享一个 `state.db`。WAL 模式实现多读单写；应用层随机抖动重试（20-150ms 随机间隔，最多 15 次）防止 convoy effect——确定性重试间隔会让多个被拒绝的写入者在下一次再次同时撞上。

**身份追踪去重而非位置索引**。`_flush_messages_to_session_db()` 使用 Python `id()` 做身份追踪。`repair_message_sequence()` 可能收缩/合并消息列表，位置切片会因列表形变而漏写或重复；`id()` 追踪不受此影响。

**软删除支持回退操作**。消息标记 `active=0` 而非物理删除，支持 `/undo`、`/rewind` 等操作。上下文压缩产生新子会话时通过 `parent_session_id` 链维护会话族谱，不删除原消息。

**与业界的关键差异**：LangMem 和 Letta 都没有独立的消息归档层——它们的"记忆"都是从原始对话中提取后的二手数据。一旦提取出错或遗漏，原始信息就永久丢失了。SessionDB 保证了原始字节永远可查。

#### 2.2.2 持久化时机

`_persist_session()` 有 **30+ 个调用点**，分布在 3 个文件中，每个对应一条退出路径。背后是一个明确的工程决策：**无论从哪条路径退出，消息都不能丢**。

```
Turn 开始 → ① turn_context.py:260 落盘用户消息
  └─ LLM 调用循环（工具结果仅在内存）← ⚠️ 风险窗口
      └─ ② 错误路径落盘 或 ③ turn_finalizer.py:143 落盘完整 Turn
```

| 文件 | 调用点 | 触发时机 |
|------|--------|---------|
| `turn_context.py:260` | 1 | Turn 开始时——用户消息一进入即落盘 |
| `conversation_loop.py` | 22+ | 各种错误/退出路径（限流耗尽、API 错误、中断、上下文溢出等） |
| `turn_finalizer.py:143` | 1 | Turn 正常结束——唯一正常出口 |
| `cli.py:9715` | 1 | CLI 模式下 chat 返回后的补持久化 |

**为什么不在工具循环中每次都落盘？** 两个原因：

1. **语义正确性**：Turn 内部消息是"进行中的状态"，中途持久化后恢复会看到"半成品"——assistant 说"让我查一下"但 tool result 未写入，恢复价值有限。
2. **性能**：一个包含 8 次工具调用的 Turn，逐次写入累积延迟 120-400ms。

**设计合理性**：窗口时长有限（通常数秒到数分钟），进程崩溃概率远低于逻辑异常，最坏情况只丢一个 Turn（用户重说一遍即可）。相比在 90 次循环中逐次落盘，性能收益明确。

去重由 `id()` 身份追踪保证（参见 2.2.1 节）——同一 Turn 多次调用不产生重复数据，允许每条退出路径以防御性方式调用而不需跟踪"是否已保存过"。

**与 MemoryProvider 写回的差异**：MemoryProvider 的 `sync_turn()` 只在 Turn **正常结束**时触发一次（后台线程）。如果 Turn 因错误中断，MemoryProvider 不会收到本轮数据——语义记忆应该只存储"有意义的完整对话"。SessionDB 覆盖所有退出路径：归档层不能有遗漏，语义层可以有选择。

#### 2.2.3 子 Agent 委托场景

父子 Agent **共享**同一个 `SessionDB` 实例，但拥有**独立** `session_id`，消息写入各自 session 行：

```python
child = AIAgent(
    session_db=parent_agent._session_db,       # 共享实例（同一连接）
    parent_session_id=parent_agent.session_id, # 事后可追溯
    platform="subagent",                       # 列表中可过滤
    skip_memory=True,                          # 不触发 MemoryProvider
)
```

子 Agent 的持久化路径与主 Agent 完全相同（同样三个落盘点）。主 Agent 在 `_child_future.result(timeout=...)` 处同步阻塞。

| 崩溃场景 | 父会话 | 子会话 |
|---------|--------|--------|
| 子 Agent 异常/超时/线程崩溃 | 无损——父收到 error result | 已落盘消息安全 |
| 整个进程崩溃 | 当前 Turn 内存消息丢失 | 已落盘消息安全，`parent_session_id` 链完整 |

子 Agent 完成后 `finally` 块清理运行时资源（终端、浏览器、进程），但**不调用 `end_session`**——子 session 保持"未结束"状态，可通过 `parent_session_id` 事后追溯任务进度。

### 2.3 第二层：内置 MemoryStore — 精选事实记忆

MemoryStore 是 Hermes 记忆系统的"内置层"——不依赖任何外部服务，仅通过 `MEMORY.md` 和 `USER.md` 两个本地文件实现跨会话的持久化精选记忆。它的设计哲学是**以硬约束换取高信噪比**。

#### 容量硬限制的设计逻辑

MEMORY.md 上限 2200 字符，USER.md 上限 1375 字符。为什么是字符而非 token？因为同一份文件可能被 Claude、GPT、DeepSeek 等不同模型的会话共享，它们的 tokenizer 各不相同——字符数是模型无关的、确定性的度量。

2200 字符约等于 700 个汉字或 ~500 个英文单词，足够容纳 8-15 条精炼的事实条目。1375 字符约 450 个汉字，用户画像通常只需要 5-8 条核心信息。配合 LLM 的判断力做主动精炼，这个容量在"够用"和"不浪费上下文窗口"之间取得了平衡。

当容量满时，处理方式不是静默截断，也不是 LRU 淘汰，而是**拒绝 + 返回全部现有条目**。LLM 在同一轮就能判断删除哪些、合并哪些，然后发一个 batch 调用把"腾空间 + 新写入"一步完成。这个设计把精炼的决策权交给 LLM，而非硬编码的淘汰策略。

#### 冻结快照与 prompt cache 的关系

MemoryStore 在会话启动时从磁盘加载内容并冻结为 `_system_prompt_snapshot`。整个会话期间，工具调用更新 `memory_entries` 并落盘（保证持久化），但系统提示词读的是冻结快照（保证缓存稳定）。下个会话 `load_from_disk()` 重新加载，快照自然刷新。

**为什么不实时更新系统提示词？** 每轮 API 调用中，Anthropic/OpenAI 会缓存 system prompt 的 KV 值。如果中途修改 system prompt 中的任何字节，整个 prefix cache 立即失效，后续每次 API 调用都按全价计费。这是 Hermes 设计原则中的硬约束：**system prompt 在一个会话内保持字节稳定**。

#### 条目格式：为什么是 § 而非 JSON

条目用 `§`（分节符号）分隔，文件内容类似：

```
用户偏好使用 ruff 做 linting，配置文件在 pyproject.toml
§
项目位于 ~/code/hermes-agent，Python 3.11+
§
用户习惯用中文回复
```

`§` 是 Unicode 通用符号，几乎不可能出现在用户的自然语言记忆中。条目可以包含换行（multiline），而空行分隔会产生歧义。分隔符本身就是文件格式的一部分，人类可以直接用编辑器查看，不需要解析。

#### 与 Claude Code 的路线分歧

这是理解 Hermes 内置记忆和 Claude Code 记忆机制差异的关键：

| 维度 | Claude Code | Hermes MemoryStore |
|------|------------|-------------------|
| MEMORY.md 角色 | **索引文件**（指针列表） | **内容本体**（§ 分隔的条目） |
| 实际存储 | `memory/` 目录下的独立 `.md` 文件 | MEMORY.md / USER.md 本身 |
| 加载方式 | 索引全量 + 按需读取具体文件 | 全量注入系统提示词（冻结快照） |
| 容量策略 | 无硬上限，文件级扩展 | 2200/1375 字符硬上限，强制精炼 |
| 条目粒度 | 一文件一事实 + frontmatter 元数据 | 扁平 § 分隔条目 |

**为什么 Hermes 不采用索引模式？** 两个硬约束决定了不同的路径：

1. **冻结快照要求一次性全量加载**。Hermes 的系统提示词在会话期间不可变。如果索引→按需读取，就需要会话中途动态修改系统提示词来加载记忆文件，直接破坏 prompt cache。Claude Code 的索引按需读取发生在 harness 层（不进入被缓存的 system prompt），而 Hermes 的记忆直接注入 LLM 的 system prompt。

2. **字符硬上限让索引不划算**。2200 字符的预算内，索引本身会占据可观比例。直接存事实比存指针更高效——没有索引开销，没有检索往返。大规模记忆的场景交给了外部 provider 处理。

### 2.4 第三层：外部 MemoryProvider — 语义向量记忆

外部 MemoryProvider 解决了内置 MemoryStore 的两个根本局限：容量太小装不下完整历史，且无法做语义搜索。

#### 可插拔架构与单 provider 限制

通过 MemoryProvider ABC 统一契约，系统支持 Honcho、Mem0、Hindsight、Supermemory 等 8+ 种后端，用户通过配置项 `memory.provider` 切换。新增一个 provider 只需实现 ABC，不需要修改 `run_agent.py`、`cli.py` 中的任何代码。

但系统**限制同时只能激活一个外部 provider**。原因有三：
- **工具 schema 膨胀**：每个外部 provider 注册 4-5 个工具，多个 provider 同时激活会显著增加每个 API 调用的 schema 负载
- **写入竞争**：同一段对话被存入多个后端，语义冲突时谁说了算
- **模型决策负担**：15 个记忆工具的 description 模型要逐一评估，增加错误调用概率

#### 异步解耦：核心路径零延迟

记忆系统最巧妙的设计是将"慢操作"和"快操作"拆成两步：

| 慢操作（后台线程） | 快操作（前台，LLM 等待） |
|-------------------|----------------------|
| `queue_prefetch()` → 向量检索 → 缓存 | `prefetch()` → 从缓存读取（O(1)） |
| `sync_turn()` → 写入向量库 | `return response` → 立即返回给用户 |

实现机制：单 worker 线程池（`max_workers=1`）保证写入顺序——turn N 一定在 turn N+1 之前落盘。关停时 5s 排水超时防止卡死。

这源于一次真实事故：一个配置错误的 Hindsight daemon 阻塞了 ~298s 才失败。如果写入在主线程上执行，CLI/TUI/gateway 都会将 Agent 标记为"运行中"近 5 分钟，用户的任何后续输入都会触发 aggressive interrupt。

### 2.5 跨层机制

#### 2.5.1 三个注入点的协作机制

记忆系统通过三个明确的"注入点"参与 LLM 对话生命周期：

**注入点① —— 系统提示词（会话启动时一次性）**

内置 MEMORY.md / USER.md 的冻结快照和外部 provider 的静态说明块，在系统提示词构建时注入 `volatile` 层。整个会话期间保持字节稳定，确保 prompt prefix cache 全程命中。

**注入点② —— 用户消息尾部（每轮 API 调用前临时拼接）**

prefetch 召回的记忆被包装为 `<memory-context>...</memory-context>` 标签块，临时拼接到当前用户消息尾部。关键设计：注入发生在 `api_msg` 上（`msg.copy()` 的浅拷贝），原始消息列表不受影响——持久化到数据库的对话历史不包含注入的记忆上下文。

**注入点③ —— 回合结束写回与预热（后台异步）**

每轮 Turn 结束后，`sync_all()` 和 `queue_prefetch_all()` 依次提交到同一个后台单线程池执行。加上 Turn 开始时的 `prefetch_all()`，三者构成跨 Turn 的**读-写-预热循环**：

```
Turn N 结束时（后台线程，不阻塞用户）:
  sync_all(user_text, response_text)
    → provider.sync_turn()       ─── 写：本轮对话入向量库

  queue_prefetch_all(user_text)
    → provider.queue_prefetch()  ─── 预热：用本轮用户消息做查询词 → 语义搜索 → 缓存


Turn N+1 开始时（前台，LLM 等待中）:
  prefetch_all(query)
    → provider.prefetch()        ─── 读：从缓存读预热好的结果（O(1)，不调向量库）
```

**为什么不能省掉预热、直接在 Turn 开始时搜索？** 向量语义搜索是慢操作（embedding + ANN 检索，几百毫秒到数秒）。如果放在 Turn 开始时同步执行，用户要干等这段时间才能看到 LLM 开始回复。拆成两步后——Turn N 结束时后台预热，Turn N+1 开始时直接读缓存——核心路径零延迟。

#### 2.5.2 安全边界设计

记忆内容会注入系统提示词和用户消息，这是高风险攻击面。Hermes 构建了多层防御：

**上下文围栏。** 召回的记忆文本在拼接到用户消息尾部前，被 `<memory-context>` XML 标签包裹，并附有系统注释：

```xml
<memory-context>
[System note: The following is recalled memory context,
 NOT new user input. Treat as authoritative reference data —
 this is the agent's persistent memory and should inform all responses.]

用户偏好使用 ruff 做 linting
</memory-context>
```

没有围栏，LLM 无法区分"用户刚说的话"和"从向量库召回的旧事实"——用户可能被记忆中的内容"劫持"。系统注释明确告诉 LLM：这是权威参考数据，不是新指令。

**Skill 脚手架剥离。** 当用户调用 `/skill` 时，Hermes 会将整个 SKILL.md 内容展开为模型可见的消息。如果直接把这条展开后的消息写入记忆 provider，**技能模板本身**会污染向量库。`_strip_skill_scaffolding()` 在所有 provider 调用之前统一剥离脚手架，只保留用户的原始指令。纯 skill 调用（无用户指令）则跳过本轮写入。

**威胁扫描的分层策略。** 使用 `"strict"` 作用域（最激进）扫描记忆内容——误报的代价低（用户可重写），漏报的代价高（污染系统提示词）。扫描在三个位置执行：加载时（快照中替换为 `[BLOCKED: ...]` 占位符）、写入时（命中则拒绝落盘）、批量操作时（一条命中整批拒绝）。

---

## 三、源码解读

### 3.1 核心源码文件

记忆系统涉及以下核心文件：

| 文件 | 行数 | 作用 |
|------|------|------|
| [tools/memory_tool.py](../tools/memory_tool.py) | ~1020 | 内置 MemoryStore——文件驱动精选记忆，CRUD、安全扫描、漂移检测、并发控制 |
| [agent/memory_manager.py](../agent/memory_manager.py) | ~950 | 编排器中枢——provider 注册、后台调度、围栏包装、优雅降级 |
| [agent/memory_provider.py](../agent/memory_provider.py) | ~300 | MemoryProvider ABC——外部记忆后端的统一抽象契约（三层方法体系） |
| [hermes_state.py](../hermes_state.py) | ~4500 | SessionDB 实现——SQLite 会话归档、双 FTS5 全文索引、WAL 并发控制 |
| [agent/agent_runtime_helpers.py](../agent/agent_runtime_helpers.py) | — | 工具执行拦截层——`invoke_tool()` 拦截 `memory` 调用，注入 agent 私有状态、桥接外部 provider |
| [plugins/memory/honcho/__init__.py](../plugins/memory/honcho/__init__.py) | ~1400 | Honcho Provider 完整实现——四种 recall_mode、prefetch 两层上下文、sync_turn 异步落盘 |

### 3.2 完整调用流程

在深入各段源码之前，先以一条 `memory(action="add")` 调用串起**工具调用链**，再补充 Turn 退出时独立运行的 **SessionDB 完整归档路径**——前者写入精选事实，后者记录全部消息流水账，两条路径在同一个 Agent 生命周期中并行执行，互不感知。

```
═══════════════════════════════════════════════════════════════════════
阶段一：memory 工具调用链（LLM 主动触发，按需执行）
═══════════════════════════════════════════════════════════════════════

LLM 响应 tool_calls: [{name: "memory", args: {action: "add", content: "用户偏好 ruff"}}]
  │
  ▼
run_agent.py: _invoke_tool("memory", args, ...)          ← 入口
  │
  ▼
agent/agent_runtime_helpers.py: invoke_tool()             ← 拦截层
  │
  ├─ 通用调度器: function_name in _AGENT_LOOP_TOOLS → stub error ❌
  │   （memory 属于 agent loop 专属工具，通用调度器拒绝执行）
  │
  └─ ★ 拦截: function_name == "memory"
      │
      ├─ ① pre_tool_call 插件钩子
      ├─ ② _apply_write_gate() → 写入审批门控（allow/staged/blocked）
      ├─ ③ memory_tool(store=agent._memory_store)       ← tools/memory_tool.py
      │     ├─ MemoryStore.add()
      │     │     ├─ 防线1: 空内容拒绝
      │     │     ├─ 防线2: _scan_memory_content() → 威胁扫描（tools/threat_patterns.py）
      │     │     ├─ 防线3: _file_lock() → 文件锁（fcntl/msvcrt 跨平台）
      │     │     ├─ 防线4: _reload_target() → 写前重读 + 外部漂移检测
      │     │     ├─ 防线5: 精确去重
      │     │     ├─ 防线6: 预算检查（超额 → 拒绝 + 返回全部现有条目）
      │     │     └─ save_to_disk() → 临时文件 + os.replace() 原子替换
      │     └─ 返回 JSON 结果（刻意不返回完整条目列表，抑制 thrash）
      │
      ├─ ④ agent._memory_manager.on_memory_write()      ← agent/memory_manager.py
      │     └─ 桥接到外部 provider.sync_turn()（如 Honcho），后台线程执行
      │
      └─ ⑤ post_tool_call 插件钩子

  ...（agent 循环继续，可能多次 tool call，最终 LLM 返回 text 或达到终止条件）...


═══════════════════════════════════════════════════════════════════════
阶段二：Turn 退出时 SessionDB 归档（每次 turn 结束必然触发，30+ 个出口路径）
═══════════════════════════════════════════════════════════════════════

  会话持久化有两个触发维度——"何时触发"和"在哪个 session 中写入"。

  ── 维度一：主 Agent 路径（三个时间节点）──────────────────────────

  【落盘点① - Turn 开始前】agent/turn_context.py:260
  │
  ├─ _persist_session(messages, conversation_history)
  │     └─ 用户消息一进入即落盘——崩溃韧性："至少用户消息不会丢"
  │
  ▼
  ... LLM 调用循环（tool_calls 执行期间不落盘，消息仅存内存）...

  【落盘点② - 错误/中断路径】agent/conversation_loop.py（22+ 个调用点）
  │
  ├─ _persist_session(messages, conversation_history)
  │     └─ 限流耗尽、API 错误、中断、上下文溢出、无效工具调用等场景
  │
  ▼
  【落盘点③ - 正常路径】agent/turn_finalizer.py:143
  │
  └─ _persist_session(messages, conversation_history)

  ── 维度二：子 Agent 委托分支（独立 session_id，共享 state.db）──

  agent/tools/delegate_tool.py: _run_single_child()
  │
  ├─ 父 Agent 阻塞在 _child_future.result(timeout=child_timeout)
  │
  └─ 子 Agent 独立执行 run_conversation()
        │
        └─ 子 Agent 内部走同样的三个落盘点（①→②→③）
              └─ 消息写入子 Agent 自己的 session_id
                    └─ parent_session_id = 父 Agent session_id

  ── 落盘函数内部流程 ─────────────────────────────────────────────
  │
  ▼
agent/turn_finalizer.py: _persist_session(messages, conversation_history)
  │
  ├─ _drop_trailing_empty_response_scaffolding(messages)  ← 先移除临时脚手架
  │     （空响应恢复标记 _empty_recovery_synthetic、_empty_terminal_sentinel）
  │
  ├─ _save_session_log(messages)                          ← 可选 JSON 快照
  │     └─ 门控: sessions.write_json_snapshots（默认 False）→ 无开销
  │
  └─ _flush_messages_to_session_db(messages, conversation_history)  ← hermes_state.py
        │
        ├─ _ensure_db_session() → 首次调用时惰性创建 session 行
        │     └─ 失败则重试（_session_db_created 保持 False），不阻塞
        │
        ├─ 身份追踪去重: 用 Python id() 而非位置索引
        │     │  repair_message_sequence() 可能收缩/合并消息列表，
        │     │  位置切片会漏写或重复；id() 追踪不受列表形变影响
        │     │
        │     └─ conversation_history 中的 dict 按 id 排除（跳过已归档的历史）
        │
        ├─ 多模态处理: base64 图片 → "[screenshot]" 占位符
        │     content 列表 → 保留 text 部分、标记 image 部分
        │
        └─ SessionDB.append_message(session_id, role, content, ...)
              ├─ INSERT INTO messages (...)                    ← WAL 模式
              ├─ UPDATE sessions SET message_count += 1
              ├─ FTS5 触发器自动同步双全文索引 (unicode61 + trigram)
              └─ 异常 → logger.warning（不抛异常，不阻塞 Agent 主循环）
```

调用链涉及七个关键环节，对应后续源码分析和第二节设计论述：

| 环节                          | 所在文件                      | 对应章节                         |
| --------------------------- | ------------------------- | ---------------------------- |
| ③--memory_tool CRUD 执行      | `tools/memory_tool.py`    | 3.3 双态设计、3.4 原子批处理、3.5 漂移检测  |
| ④-- on_memory_write<br>围栏包装 | `agent/memory_manager.py` | 3.6 StreamingContextScrubber |
| ④ --on_memory_write<br>后台调度 | `agent/memory_manager.py` | 3.7 优雅降级链                    |
| Turn 退出归档（含多调用点、崩溃韧性、子 Agent 委托） | `hermes_state.py`         | 2.2-2.5 SessionDB 设计逻辑           |

以下从源码中摘选 5 个设计最精巧的部分，逐一分析。

### 3.3 MemoryStore 的双态设计 —— 用最少代码解决 prompt cache 与持久化的矛盾

**调用链位置**：环节 ③ —— `tools/memory_tool.py`，MemoryStore 初始化与系统提示词注入阶段。

这是整个 MemoryStore 最精妙的结构决策。`MemoryStore` 内部维护**两套并行状态**：

```python
class MemoryStore:
    def __init__(self, memory_char_limit: int = 2200, user_char_limit: int = 1375):
        self.memory_entries: List[str] = []       # 实时状态（工具操作的目标）
        self.user_entries: List[str] = []          # 实时状态（工具操作的目标）
        # 冻结快照 —— 在 load_from_disk() 时设定，之后永不改变
        self._system_prompt_snapshot: Dict[str, str] = {"memory": "", "user": ""}
```

两套状态的生命周期：

```
load_from_disk()
  │
  ├─ memory_entries ← 从磁盘解析（实时状态，随工具调用变化）
  ├─ user_entries   ← 从磁盘解析（实时状态，随工具调用变化）
  │
  └─ _system_prompt_snapshot ← 安全扫描后冻结（此后整个会话不再变化）
         │
         └─ format_for_system_prompt() 永远返回这个快照
```

**为什么必须分两套？** 这是一个从 prompt cache 硬约束推导出的必然设计。如果工具调用修改了系统提示词，LLM 的 prompt prefix cache 会在下一轮 API 调用时立即失效。Hermes 的解决方案是：工具调用更新 `memory_entries` 并落盘（保证持久化），但系统提示词读的是 `_system_prompt_snapshot`（保证缓存稳定）。下个会话 `load_from_disk()` 重新加载，快照自然刷新。

**优秀之处**：用 `List[str]` + `Dict[str, str]` 这两个最简单的数据结构，解决了一个看似矛盾的需求——"写入必须实时生效（持久化）"和"读取必须保持不变（缓存）"。没有引入写时复制、版本号、或双缓冲等复杂模式。两套状态的边界极其清晰：`memory_entries` 属于工具调用域，`_system_prompt_snapshot` 属于系统提示词域。

### 3.4 MemoryStore.apply_batch() 的原子批处理 —— 三个来自实战教训的设计

**调用链位置**：环节 ③ —— `tools/memory_tool.py`，MemoryStore CRUD 批量操作阶段。

`apply_batch()` 允许 LLM 在一次调用中执行多个增删改操作。三个设计决策每个都来自真实使用中的教训：

**决策一：预算仅在最终状态检查。**

```python
# 阶段 1: 在工作副本上顺序应用所有操作
working = list(self._entries_for(target))
for op in operations:
    if act == "add":    working.append(content)
    if act == "remove": working.pop(matches[0])

# 阶段 2: 仅在最终状态检查预算（中间溢出无所谓）
new_total = len(ENTRY_DELIMITER.join(working))
if new_total > limit:
    return error_with_current_entries  # 拒绝，返回实时条目
```

`[remove A, remove B, add C]` 这样的批量操作，即使 remove 之前已满、add 之前也满，只要最终结果在预算内就接受。这让"腾空间"成为可能——单次调用中先删后写。如果中间状态也检查预算，这类合法的批量操作会被错误拒绝。

**决策二：全或无语义。** 任何一步失败（匹配不到、歧义、超预算），整个批次回滚——不落盘、不部分提交。这避免了"删了 A 但 B 没加上"的半完成状态，LLM 收到错误后可以调整参数重试整个批次。

**决策三：`_success_response()` 刻意不返回完整条目列表。**

```python
def _success_response(self, target, message=None):
    resp = {
        "success": True, "done": True, "target": target,
        "usage": f"{pct}% — {current:,}/{limit:,} chars",
        "entry_count": len(entries),
    }
    resp["note"] = "Write saved. This update is complete — do not repeat it."
    return resp
    # 注意：不返回 entries 列表！
```

注释中解释了原因："dumping it invites the model to 'find more to fix' and re-issue the same operations (observed thrash: the correct batch on call 1, then 5 redundant repeats)。"这是一个从真实使用中观察到的行为模式——模型在成功后看到完整列表会忍不住"再检查一下"然后重复操作。不返回列表，配合 `"note": "...do not repeat it"` 的提示，有效抑制了这种 thrash 行为。

**优秀之处**：三个决策都体现了"面向 LLM 的行为特征做设计"的思路——不是把 LLM 当作普通的函数调用者，而是理解它的"心理"（看到完整列表就想再检查、看到错误会调整重试）。这是 Agent 框架设计和传统 API 设计的本质区别。

### 3.5 外部漂移检测 —— 一个真实 Bug 驱动的防御设计

**调用链位置**：环节 ③ —— `tools/memory_tool.py`，`_reload_target()` 写前重读阶段。

这个机制解决的是 Issue #26045 报告的一个真实数据丢失 bug：

**场景**：用户通过 `patch` 工具、shell append 或手动编辑，在 MEMORY.md 中追加了大段自由格式内容。然后 LLM 调用 `memory(action="replace", ...)` 修改其中一条。MemoryStore 的 `_write_file()` 会把整个文件重写为 `§` 分隔的条目列表，导致那些不符合 `§` 格式的外部内容**被静默截断为单条条目**，原始数据丢失。

**检测逻辑**用两个信号判断漂移：

```python
def _detect_external_drift(self, target):
    raw = path.read_text(encoding="utf-8")
    parsed = [e.strip() for e in raw.split(ENTRY_DELIMITER) if e.strip()]

    # 信号 1: round-trip 不匹配 —— 重新解析再序列化不等于原始字节
    roundtrip = ENTRY_DELIMITER.join(parsed)

    # 信号 2: 条目大小溢出 —— 任何单条条目超过整个 store 的字符上限
    # （工具不可能写出这么大的单个条目）
    max_entry_len = max((len(e) for e in parsed), default=0)

    drift_detected = (raw.strip() != roundtrip) or (max_entry_len > char_limit)
```

两个信号互补：round-trip 不匹配捕获格式漂移（外部文本不符合 `§` 分隔规则），条目大小溢出捕获内容漂移（外部一次性写入了超大内容）。

**检测到漂移后的处理**：先做备份（`.bak.<timestamp>`），然后**拒绝写入**，返回清晰的修复指南——备份路径 + 如何将内容重新导入 `memory add` 的指引。

**优秀之处**：体现了"不静默丢数据"的务实态度。与其尝试智能合并（可能出错），不如明确拒绝并给出恢复路径。两个检测信号也设计得精妙——不依赖 checksum、不存储额外元数据、不需要理解内容的语义，仅用纯文本的 round-trip 性质和条目大小就能判断。零维护成本。

### 3.6 StreamingContextScrubber 状态机 —— 解决流式输出中标签跨 chunk 断裂问题

**调用链位置**：环节 ④ —— `agent/memory_manager.py`，流式输出的围栏标签擦除阶段。

这是一个 150+ 行的状态机，专门处理流式输出中围栏标签被 chunk 边界切断的问题。

**问题场景**：LLM 流式响应的文本是分 chunk 传输的：

```
Chunk 1: "根据记忆，"
Chunk 2: "用户偏好使用 blac"
Chunk 3: "<memory-con"              ← 标签被切断！
Chunk 4: "text>用户女儿叫小米</memory-context>"
Chunk 5: "k 格式化代码。"
```

如果只用正则 `re.sub(r'<memory-context>.*?</memory-context>', '', text)`，Chunk 3 和 Chunk 4 各自都不包含完整的标签对，正则无法匹配——围栏内容泄漏到 UI。

**状态机的处理流程**：

```
[正常输出]
    │
    │ 检测到 <memory-context> 开始标签（要求完整标签出现在块边界）
    ▼
[屏蔽中] ──── 丢弃所有内容（包括 [System note: ...] 注释行）
    │
    │ 检测到 </memory-context> 结束标签
    ▼
[正常输出] ──── 恢复输出
```

关键细节：如果 chunk 尾部是标签的前缀（如 `<memory-con`），则**缓存这段尾巴**，等下一个 chunk 拼起来再判断。`flush()` 时如果仍处于未闭合的屏蔽状态，**丢弃残留**——宁可漏掉一条记忆，也不能泄漏到 UI。

**优秀之处**：用经典的状态机模式解决了一个非经典的问题（流式文本中 XML 标签的跨 chunk 匹配）。四个状态的转换逻辑清晰，边界条件（chunk 边界恰好在标签中间）处理完善。这比引入完整的 XML 流式解析器轻量得多，又比纯正则健壮得多。

### 3.7 MemoryManager 的优雅降级链 —— "best-effort"哲学的工程实现

**调用链位置**：环节 ④ —— `agent/memory_manager.py`，后台线程调度与关停排水阶段。

MemoryManager 中每个可能失败的节点都有降级路径：

```
MemoryProvider 初始化失败     → Agent 正常启动，无记忆功能
sync_turn() 抛异常            → 记录日志，不影响其他 provider
executor 创建失败             → 回退到内联执行（"慢但正确"）
executor 已关闭（teardown 竞态）→ 回退到内联执行
shutdown() 排水超时 5s        → daemon 线程随进程退出
provider 注册被拒绝            → 静默跳过，Agent 正常启动
```

关键实现细节：

**懒加载 executor，零线程开销**：

```python
def _submit_background(self, fn) -> None:
    executor = self._get_sync_executor()   # 懒加载，首次使用时创建
    if executor is None:
        fn()  # ← 优雅降级：executor 创建失败 → 内联执行
        return
    try:
        executor.submit(fn)
    except RuntimeError:
        fn()  # ← 再次优雅降级：executor 已关闭 → 内联执行
```

如果没有外部 provider（只有内置的），executor 永远不会被创建——零线程开销。降级策略是"慢但正确"而非"快但丢失数据"。

**5 秒排水超时**：

```python
def _drain_sync_executor(self):
    executor.shutdown(wait=False, cancel_futures=True)
    drainer = threading.Thread(target=..., daemon=True)
    drainer.start()
    drainer.join(timeout=5.0)  # ← 最多等 5 秒
    # 超时后 daemon 线程随进程退出
```

为什么不是无限等待？一个僵死的 provider（网络不通 + 无超时设置）会永久阻塞 shutdown()。5 秒是底线——给正常 provider 足够时间完成最后的写入，但不允许僵死的 provider 阻止进程退出。

**优秀之处**：每个降级决策都体现了"记忆是 best-effort"的工程判断——记忆系统不应该阻止 Agent 的核心功能（对话 + 工具执行）。静默拒绝而非抛异常、回退到内联而非丢弃数据、超时放弃而非永久等待，都是这个原则的具体体现。

---

## 四、参考文献

### 4.1 设计文档

- AGENTS.md：Footprint Ladder（新增能力决策阶梯）和 prompt cache 保护原则
- [hermes-AIAgent架构分析](hermes-AIAgent架构分析.md)：记忆系统在 10 环节流水线中的位置
- [hermes-工具系统分析](hermes-工具系统分析.md)：核心工具注册与分发机制（含 `_AGENT_LOOP_TOOLS` 拦截模式）

### 4.2 外部参考

- Claude Code MEMORY.md 机制（Anthropic 官方文档）
- LangMem：LangChain 记忆管理库（`langmem` 包文档）
- Mem0：向量嵌入 + 图记忆系统（Mem0 白皮书）
- Letta（原 MemGPT）：OS 虚拟内存类比记忆管理（Letta 论文）
- SQLite FTS5 文档：全文索引 tokenizer 与触发器机制
- WAL 模式文档：SQLite Write-Ahead Log 的并发语义
