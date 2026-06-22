# Hermes 上下文压缩机制分析

> 前置阅读：[整体架构分析](hermes-整体架构分析.md)（了解 `agent/` 子系统和 `context_compressor` 模块位置）、[AIAgent 架构分析](hermes-AIAgent架构分析.md)（了解第 ⑧ 环节在 10 环节流水线中的位置）。
>
> 本文深入分析 Hermes Agent 的上下文压缩（Context Compression）机制——它是 **唯一被允许修改历史上下文** 的机制，用于解决长对话超出 LLM 上下文窗口限制的问题。

---

## 一、问题定义：为什么需要上下文压缩

### 1.1 上下文窗口的硬限制

每个 LLM 都有固定的上下文窗口（context window），例如 Claude Sonnet 200K tokens、GPT-4o 128K tokens、DeepSeek-V3 64K tokens。Hermes Agent 的每次 API 调用都会将**完整的 message history** 发送给 LLM：

```
API 请求 = system_prompt + message_1 + message_2 + ... + message_N + tools_schema
```

随着对话进行，消息数 N 不断增长。当总 token 数超过模型的 `context_length`，API 会返回 400 错误，对话无法继续。

### 1.2 朴素方案的缺陷

| 方案 | 做法 | 问题 |
|------|------|------|
| 截断最早消息 | 只保留最近 K 条消息 | 丢失系统提示词中的关键设定、早期的用户偏好、技术决策 |
| 滑动窗口 | 固定窗口大小，旧消息逐出 | 模型"失忆"，无法引用之前的上下文 |
| 强制 `/new` | 开启新会话 | 打断工作流，丢失所有中间状态和已完成的步骤 |

### 1.3 Hermes 的设计约束

上下文压缩不是简单的"删旧消息"，Hermes 有以下硬约束：

1. **Prompt caching 不可侵犯**：修改历史上下文会破坏 LLM 的 prompt cache，导致每次 API 调用按全价计费。压缩是 Cache 规则的唯一例外。
2. **消息角色交替约束**：OpenAI API 要求 `user / assistant / tool` 角色严格交替，压缩后不能出现两个连续的 `user` 或 `assistant` 消息。
3. **tool_call / tool_result 配对完整性**：每个 `tool_call` 必须有对应的 `tool` 结果消息，孤立的配对会导致 API 返回 400 错误。
4. **辅助 LLM 可能不可用**：摘要生成依赖另一个 LLM，它可能未配置、挂掉、超时——必须有降级路径。

---

## 二、设计原理：两种压缩哲学

Hermes 和 Claude Code 面对同一个问题——长对话超出上下文窗口。但解法反映了两套不同的工程哲学。

### 2.1 Hermes：单入口 4 阶段

核心策略：**Head（头部保留）+ Summary（中间摘要）+ Tail（尾部保留）**，一次压缩到位。

```
原始消息列表（超长，~150K tokens）
┌──────────┬─────────────────────────────────┬──────────────┐
│   Head   │         Middle（压缩区）         │    Tail      │
│  保护前 3 │  200 条消息 → LLM 结构化摘要      │  按预算保护   │
│  条消息   │                                 │  最近 ~20K   │
│          │                                 │  tokens      │
└──────────┴─────────────────────────────────┴──────────────┘
                   │ 压缩
                   ▼
┌──────────┬──────────────────┬──────────────┐
│   Head   │  Summary（摘要）  │    Tail      │
│  原样保留 │  结构化上下文摘要  │   原样保留    │
│          │  ~2K-12K tokens  │              │
└──────────┴──────────────────┴──────────────┘
        压缩后 ~50K tokens
```

**4 阶段流水线**：

```
Phase 1: 工具结果裁剪（无 LLM 调用）→ Phase 2: 边界确定（Head/Tail）
→ Phase 3: LLM 摘要生成（结构化模板）→ Phase 4: 组装清理（角色交替 + 配对修复）
```

设计原则：**一次触发，全面处理**。压缩入口只有一个 `compress()`，内部走完 4 阶段，带着 7 层降级保护（防抖动、冷却期、确定性降级、abort 模式……），确保任何单点故障都不会导致对话卡死。

### 2.2 Claude Code vs Hermes

Claude Code 采用**层级递进**策略——四层依次升级，够用即止：

| 层级 | 策略 | Hermes 对应 | 关键差异 |
|------|------|------------|---------|
| **Layer 1: Snip** | 零成本整轮移除（空结果 turn、被拒工具调用） | Phase 1 去重 | CC 移除整 turn；Hermes 裁剪 content 级别 |
| **Layer 2: Microcompact** | 缓存感知精简——静默替换旧 tool_result 为通用占位符 | Phase 1 工具结果裁剪 | Hermes 为 18 类工具提供专用摘要格式；CC 用通用占位符 + Anthropic `cache_edits` API 服务端删除 |
| **Layer 3: Context Collapse** | 读时投影——创建 collapse store，`projectView()` 实时生成虚拟视图，原始消息不变 | Phase 2 边界确定 | CC **惰性投影**（类比 SQL VIEW）；Hermes **急切就地替换**（类比 MATERIALIZED VIEW） |
| **Layer 4: AutoCompact** | 全量 LLM 摘要（最贵），带熔断器（3 次失败永久禁用） | Phase 3 LLM 摘要 | CC 用**主模型**从零重写；Hermes 用**辅助模型**迭代更新，多层降级 |

> \* "Dreaming"（做梦）是第三方工具 `lossless-code` 的概念——从历史会话提取重复模式注入未来会话。不是 Claude Code 原生机制。在 Hermes 中对应 Memory 系统（跨会话记忆），而非压缩系统（本会话内空间回收）。

**架构哲学：**

> Claude Code 像**操作系统内核**——多层调度、缓存感知、静默运行，用户几乎无感，代价是深度绑定 Anthropic API。Hermes 像**应用层框架**——结构化模板、显式会话旋转、config.yaml 全量可配、logger 输出详情，牺牲一点静默换取完全可控和 provider 无关。

一句话：**Claude Code 追求"无感"，Hermes 追求"可控"。**

### 2.3 两层架构分工

Hermes 将上下文压缩分为**算法层**和**编排层**两个文件：

```
conversation_compression.py（编排层）
  │  会话生命周期管理、锁、旋转、通知
  │
  └──→ context_compressor.py（算法层）
        ContextCompressor(ContextEngine)
        4 阶段压缩算法、摘要生成、token 预算
```

**为什么要分开？**

`ContextCompressor` 继承自 `ContextEngine`——这是一个**插件扩展点**。第三方可以通过插件系统提供自己的上下文引擎（如 `hermes-lcm`），替换默认的压缩行为。算法与编排分离使得替换压缩引擎时，编排层（会话旋转、锁、通知）可以复用。

### 2.4 关键设计决策

| 决策           | 选择                              | 原因                                   |
| ------------ | ------------------------------- | ------------------------------------ |
| 摘要用哪个模型？     | **辅助模型**（auxiliary LLM，默认更便宜更快） | 降低压缩成本，不占用主模型的 token 预算              |
| 每次从头摘要还是增量？  | **迭代更新**                        | 保留之前压缩的信息，避免重复丢失                     |
| 压缩无效怎么办？     | **防抖动**（连续 2 次节省 < 10% 则停止）     | 避免每轮都在做无意义的压缩                        |
| LLM 摘要失败怎么办？ | **确定性降级 + 可选 abort**            | 先用本地规则生成降级摘要；配置可选的彻底中止               |
| 并发压缩怎么处理？    | **SQLite 锁**                    | 防止两个 Agent 实例同时压缩同一会话导致 session fork |

---

## 三、压缩算法（`context_compressor.py` 核心）

### 3.1 入口：`compress()` 方法

```python
def compress(self, messages, current_tokens=None, focus_topic=None, force=False):
    # Phase 1: 工具结果裁剪（无 LLM 调用）
    # Phase 2: 确定边界（Head / Tail）
    # Phase 3: LLM 摘要生成（中间部分）
    # Phase 4: 组装消息列表 + 清理
```

**触发条件**（`should_compress()`）：

```python
def should_compress(self, prompt_tokens=None) -> bool:
    tokens = prompt_tokens or self.last_prompt_tokens
    if tokens < self.threshold_tokens:        # 未达阈值
        return False
    if self._ineffective_compression_count >= 2:  # 防抖动
        return False
    return True
```

阈值计算：`threshold_tokens = max(context_length * 0.50, 64K)`，即默认在上下文窗口使用过半时触发。

### 3.2 Phase 1：工具结果裁剪（`_prune_old_tool_results()`）

**低成本预处理，不调用 LLM**。遍历旧工具结果，做三件事：

**Pass 1 — 去重**：同一个文件被多次 `read_file` 读取，保留最新的完整副本，旧副本替换为 `[Duplicate tool output — same content as a more recent call]`。使用 MD5 hash（前 12 位）判断内容相同。

**Pass 2 — 摘要化**：超过 200 字符的旧工具结果，替换为一行为结构化的摘要。每个工具类型有专门的摘要函数（`_summarize_tool_result()`）：

```
输入（原始 tool 结果，3,400 字符的 JSON）:
  {"success": true, "stdout": "...47 lines...", "exit_code": 0}

输出（1 行摘要）:
  [terminal] ran `npm test` -> exit 0, 47 lines output
```

支持的工具摘要格式：

| 工具 | 摘要格式 |
|------|----------|
| `terminal` | `[terminal] ran 'command' -> exit X, N lines output` |
| `read_file` | `[read_file] read path from line N (X,XXX chars)` |
| `write_file` | `[write_file] wrote to path (N lines)` |
| `search_files` | `[search_files] content search for 'pattern' in path -> N matches` |
| `browser_navigate` 等 | `[browser_navigate] url (X,XXX chars)` |
| `delegate_task` | `[delegate_task] 'goal...' (X,XXX chars result)` |

**Pass 3 — 参数截断**：过大的工具调用参数（如 `write_file` 带了 50KB 内容）在 assistant 消息中截断。使用 JSON 解析后收缩长字符串值再重新序列化，**保持 JSON 有效性**——不规范的截断会导致下游 provider 返回 400。

**边界保护**：使用 token 预算决定哪些消息属于"旧"而需要裁剪。向后累积 token 直到达到 `tail_token_budget`，同时保证至少保护 `min(protect_last_n, 8)` 条消息。

> 💡 **对比 Claude Code Microcompact**：两者都在零 LLM 成本下精简工具结果。区别在于 Hermes 为 18 类工具提供了专用摘要格式（保留语义信息），Claude Code 使用通用占位符（更简单但丢失更多信息）。此外 Claude Code 的 Cached Microcompact 通过 `cache_edits` API 从 Anthropic 服务端删除缓存条目——这是 API 独占能力，Hermes 的 provider 无关架构无法使用。

### 3.3 Phase 2：边界确定

#### Head 保护（`_protect_head_size()`）

```python
def _protect_head_size(self, messages):
    head = 0
    if messages and messages[0].get("role") == "system":
        head = 1  # system prompt 隐式保护
    return head + self.protect_first_n  # 默认 +3，即保护前 4 条消息
```

- System prompt（索引 0）**始终保护**——它包含身份声明、技能列表、CLAUDE.md 等核心上下文
- `protect_first_n` 默认 3，即额外保护前 3 条非 system 消息（通常是第一轮对话）

#### Tail 保护（`_find_tail_cut_by_tokens()`）

核心逻辑：**从消息列表末尾向前走，累计 token 直到达到预算**：

```
tail_token_budget = threshold_tokens * summary_target_ratio
                 = (context_length * 0.50) * 0.20
                 ≈ context_length * 0.10
```

对于 200K 上下文的模型，tail 预算约 20K tokens。

具体步骤：

1. **soft_ceiling = budget * 1.5**：允许超过预算最多 50%，避免在超大消息（如长文件读取结果）中间切断
2. **min_tail 硬地板**：至少保护 3-8 条最近消息
3. **边界对齐**：`_align_boundary_backward()` 确保不切断 `assistant(tool_calls) → tool(result)` 配对组
4. **用户消息锚定**：`_ensure_last_user_message_in_tail()` —— 修复 [#10896](https://github.com/NousResearch/hermes-agent/issues/10896)，确保最新用户消息始终在 tail 中（否则活跃任务会丢失）
5. **助手消息锚定**：`_ensure_last_assistant_message_in_tail()` —— 修复 [#29824](https://github.com/NousResearch/hermes-agent/issues/29824)，确保最新助手回复不被压缩进摘要（否则 WebUI/TUI 中用户看到的最后回复会突然变成 `[CONTEXT COMPACTION]` 块）

#### 为什么需要两个锚定？

```
压缩前（WebUI 视角）：
  User: "帮我重构 auth 模块"
  Assistant: "好的，我来分析..."（← 用户正在阅读的回复）
  Tool: [read_file 结果]
  Tool: [search_files 结果]
  ...（更多工具调用）

如果只锚定 user 消息，assistant 的可见回复可能掉入压缩区 →
  WebUI 显示变成：
  User: "帮我重构 auth 模块"
  [CONTEXT COMPACTION — REFERENCE ONLY] ...  ← 用户困惑："我刚刚看到的回复去哪了？"
```

> 💡 **对比 Claude Code Context Collapse**：这是两种系统在边界处理上最大的哲学分歧。Claude Code 的 Context Collapse 采用"读时投影"——不修改原始消息，创建 collapse store 记录 `{range, summary}`，每次组装 API 请求时通过 `projectView()` 实时生成虚拟视图。Hermes 则选择**急切就地替换**——直接修改消息列表并创建新的 SQLite 子会话。前者像数据库的 VIEW（不占存储，查询时计算），后者像 MATERIALIZED VIEW（一次性替换，后续直接使用）。各有利弊：惰性投影允许撤销和迭代，急切替换保证后续 API 调用的 cache 一致性。

### 3.4 Phase 3：LLM 摘要生成（`_generate_summary()`）

#### 3.4.1 结构化模板

摘要不是自由文本，而是包含以下固定段落的**结构化上下文快照**：

| 段落 | 用途 | 关键设计 |
|------|------|----------|
| `Historical Task Snapshot` | 用户最新未完成的输入（原样保留） | **最重要的字段**。包含显式任务、问题、待决策项。反向信号（stop/undo）必须覆盖旧任务 |
| `Goal` | 用户整体目标 | |
| `Constraints & Preferences` | 编码风格、约束、偏好 | |
| `Completed Actions` | 编号列表：每步操作、工具、结果 | 格式：`N. ACTION target — outcome [tool: name]` |
| `Active State` | 当前工作目录、分支、修改的文件、测试状态 | |
| `Historical In-Progress State` | 压缩时正在进行的操作 | |
| `Blocked` | 未解决的错误/障碍（含完整错误信息） | |
| `Key Decisions` | 关键技术决策及原因 | |
| `Resolved Questions` | 已回答的问题（含答案，避免重复） | |
| `Historical Pending User Asks` | 未回答的历史问题 | **标记为 STALE**——仅参考，不执行 |
| `Relevant Files` | 涉及的文件列表 | |
| `Historical Remaining Work` | 剩余工作 | **标记为 STALE**——仅参考，不执行 |
| `Critical Context` | 必须保留的值、错误信息、配置细节 | 绝不包含 API key |

#### 3.4.2 SUMMARY_PREFIX：防止模型"续做旧任务"

摘要消息前会追加一个强约束前言（`SUMMARY_PREFIX`），核心语义：

> 这是历史参考，不是活动指令。**不要回答摘要中提到的问题**，它们已经被处理过了。**只响应此摘要之后的最新用户消息**。即使主题重叠，最新消息也胜出。反向信号（stop、undo、rollback）必须立即终止摘要中描述的任何进行中的工作。

这个前言经历了 3 个版本迭代：

| 版本 | 问题 | 修复 |
|------|------|------|
| v1（pre-#35344） | "resume exactly from Active Task"与"只响应最新消息"自相矛盾 | 移除 resume 指令 |
| v2（carveout 时代） | "if latest message is consistent, you may use summary as background"让模型在主题重叠时续做旧任务 | 移除 carveout 许可 |
| v3（当前） | 彻底：即使主题重叠，最新消息也胜出 | 添加 `HISTORICAL_REMAINING_WORK_HEADING` 等段落标题明确标记为"仅参考" |

#### 3.4.3 两个路径：首次压缩 vs 迭代更新

**首次压缩**：将中间消息序列化为标注文本（`_serialize_for_summary()`），发送给辅助 LLM 生成全新的结构化摘要。

**迭代更新**（`_previous_summary` 非空时）：将已有摘要 + 新消息一起发给 LLM：
```
PREVIOUS SUMMARY:
{已有摘要}

NEW TURNS TO INCORPORATE:
{新消息}

更新摘要：保留仍相关的信息，将完成的操作移到 Completed Actions，更新 Active State...
```

这保证了多次压缩之间的信息连续性。

#### 3.4.4 焦点引导压缩

支持 `/compress <focus>` 指定焦点主题。摘要 LLM 会将 60-70% 的 token 预算分配给该主题相关内容：

```python
FOCUS TOPIC: "auth module refactoring"
对于与 "auth module refactoring" 相关的内容，保留完整细节。
对于不相关的内容，更激进地压缩（一行摘要或省略）。
```

如果用户未指定焦点，系统自动从最近 3 条用户消息中提取（`_derive_auto_focus_topic()`）。

#### 3.4.5 辅助模型降级策略

摘要 LLM 失败时的处理链：

```
1. 辅助模型返回 404/503（模型不存在）
   → 回退到主模型重试（_fallback_to_main_for_compression）

2. 辅助模型超时（408/429/502/504）
   → 回退到主模型重试

3. 辅助模型返回非 JSON（代理返回 HTML 502）
   → 回退到主模型重试

4. 主模型也失败 / 没有配置辅助 provider
   → 进入冷却期（30-600 秒）

5. 冷却期内再次触发压缩
   → 若 abort_on_summary_failure=true：中止压缩，返回原消息
   → 若 abort_on_summary_failure=false：使用确定性降级摘要
```

> 💡 **对比 Claude Code AutoCompact**：两者都是最昂贵的压缩层。关键差异：(1) Hermes 用**辅助模型**（默认更便宜），Claude Code 用**主模型**（质量可能更高）；(2) Hermes **迭代更新**已有摘要（信息连续性），Claude Code 每次从零重写（但 Context Collapse 层可叠加实现类似效果）；(3) 降级策略——Hermes 多层降级（辅助→主模型→冷却→确定性降级），Claude Code 熔断器（连续 3 次失败永久禁用该会话的 AutoCompact）。

### 3.5 Phase 4：组装与清理

#### 3.5.1 消息角色选择

摘要消息需要选择 `role`（`user` 或 `assistant`），并且**不能与前后消息产生连续同角色**：

```python
if last_head_role in {"assistant", "tool"}:
    summary_role = "user"
else:
    summary_role = "assistant"

# 如果与 tail 第一条碰撞，尝试翻转
if summary_role == first_tail_role:
    flipped = "assistant" if summary_role == "user" else "user"
    if flipped != last_head_role:
        summary_role = flipped
    else:
        _merge_summary_into_tail = True  # 无解时合并到 tail 第一条
```

#### 3.5.2 结束标记

摘要末尾追加明确的结束边界（`_SUMMARY_END_MARKER`）：

```
--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---
```

防止弱模型将摘要中的 `## Active Task` 引用当作新的用户输入（#11475, #14521），或将 `role="assistant"` 的摘要直接当作自己的输出重复（#33256）。

#### 3.5.3 清理孤立的 tool 配对（`_sanitize_tool_pairs()`）

压缩后可能产生两种孤儿：

1. **孤儿 tool 结果**：`tool_call_id` 对应不上任何 assistant 的 tool_call → 删除
2. **孤儿 tool 调用**：assistant 的 tool_call 找不到对应的 tool 结果 → 插入 stub 结果 `[Result from earlier conversation — see context summary above]`

#### 3.5.4 移除历史图片（`_strip_historical_media()`）

找到**最后一个包含图片的 user 消息**，将该消息之前的**所有图片部分**替换为文本占位符 `[Attached image — stripped after compression]`。

不处理的话，旧消息中的多 MB base64 图片会随每次 API 调用重复发送，永久占据带宽。

### 3.6 关键安全机制汇总

| 机制 | 实现 | 作用 |
|------|------|------|
| **防抖动** | `_ineffective_compression_count >= 2` → 停止压缩 | 避免每轮只节省 1-2 条消息的无意义压缩循环 |
| **冷却期** | `_summary_failure_cooldown_until` | 摘要 LLM 失败后暂时跳过，避免连续失败 |
| **确定性降级** | `_build_static_fallback_summary()` | LLM 不可用时用本地规则构建降级摘要 |
| **abort 模式** | `abort_on_summary_failure=True` | 摘要失败时完全不压缩，返回原消息（保守策略） |
| **内容安全** | `redact_sensitive_text()` | 摘要生成前后双向脱敏，防止 API key 泄露到摘要中 |

---

## 四、编排层（`conversation_compression.py` 核心）

### 4.1 启动探针：`check_compression_model_feasibility()`

在 **首次压缩时**（而非 Agent 初始化时）执行，节省 ~400ms 冷启动：

```python
# 懒加载：大多数短会话永远不会触发压缩
if not getattr(agent, "_compression_feasibility_checked", False):
    check_compression_model_feasibility(agent)
    agent._compression_feasibility_checked = True
```

探针检查：

1. 辅助 LLM provider 是否可用（如 OpenRouter）
2. 辅助模型的上下文长度
3. 若辅助模型上下文 < 主模型压缩阈值 → **自动降低压缩阈值**
4. 若辅助模型上下文 < 64K（`MINIMUM_CONTEXT_LENGTH`）→ **拒绝启动**

### 4.2 压缩编排：`compress_context()` 完整流程

```
compress_context(agent, messages, system_message)
  │
  ├─ 1. 懒加载可行性检查（首次调用）
  │
  ├─ 2. 获取压缩锁（SQLite-based，按 old session_id）
  │     │  失败 → 返回原消息（另一个路径正在压缩）
  │     └─ 成功 →
  │
  ├─ 3. 通知内存管理器（memory_manager.on_pre_compress）
  │     压缩前同步外部记忆（Honcho/Mem0 等）
  │
  ├─ 4. 调用压缩引擎
  │     compressed = context_compressor.compress(messages)
  │
  ├─ 5. 如果压缩中止（_last_compress_aborted）
  │     → 释放锁，返回原消息，发出警告
  │
  ├─ 6. 注入 todo 快照
  │     compressed.append({"role": "user", "content": todo_snapshot})
  │
  ├─ 7. 重建系统提示词
  │     agent._invalidate_system_prompt()
  │     new_system_prompt = agent._build_system_prompt(system_message)
  │
  ├─ 8. 会话旋转（SessionDB）
  │     ├─ 传播标题（保留旧会话标题，自动编号）
  │     ├─ 提交记忆（commit_memory_session）
  │     ├─ 刷新消息到旧会话（_flush_messages_to_session_db）
  │     ├─ end_session(old_id, "compression")
  │     ├─ 生成新 session_id
  │     ├─ create_session(new_id, parent_session_id=old_id)
  │     └─ update_system_prompt(new_id, new_system_prompt)
  │
  ├─ 9. 通知上下文引擎（on_session_start, boundary_reason="compression"）
  │
  ├─ 10. 通知内存管理器（on_session_switch, reason="compression"）
  │
  ├─ 11. 发出 session:compress 事件
  │
  ├─ 12. 清除文件读取去重缓存（reset_file_dedup）
  │
  └─ 13. 释放压缩锁 → 返回 (compressed, new_system_prompt)
```

#### 4.2.1 压缩锁机制

两个共享同一 `session_id` 的 Agent 实例（最常见的是父 agent 和其 `background_review` fork）可能同时调用 `compress()`。没有锁会导致双方都成功压缩、都旋转会话——产生**孤儿子会话**。

```python
_lock_acquired = _lock_db.try_acquire_compression_lock(_lock_sid, _lock_holder)
if not _lock_acquired:
    # 另一个路径正在压缩，放弃本轮
    return messages, _existing_sp  # 返回原消息，不旋转
```

锁在**旧 session_id** 上获取，在旋转完成后释放。锁失败时优雅降级（`AttributeError` 等兼容性问题不阻塞压缩）。

#### 4.2.2 会话旋转

压缩不只是修改消息列表——它实际上**在 SQLite 中结束当前会话并创建一个新的子会话**：

```
旧会话（session_id: 20260622_140530_a1b2c3）
  标题: "重构 auth 模块"
  状态: ended (reason="compression")
    │
    │ parent_session_id
    ▼
新会话（session_id: 20260622_143025_d4e5f6）
  标题: "重构 auth 模块 (2)"  ← 自动编号
  状态: active
  系统提示词: 重新构建（包含压缩标记）
```

这样设计的好处：
- 每个"压缩段"是一个独立的数据库记录，支持搜索和回溯
- 标题传播保持会话连续性
- 父会话链接保留完整 lineage

### 4.3 图片恢复：`try_shrink_image_parts_in_messages()`

当 API 因图片过大（如 Anthropic 5MB 限制）返回错误时，此函数尝试将 `data:image/...;base64,...` 重新编码为更小的尺寸：

- 目标字节数：4MB（留有 1MB 余量）
- 目标尺寸：可配置（默认 8000px，Anthropic 限制）
- 使用 Pillow 的 `_resize_image_for_vision()` 进行重编码
- 如果字节缩小了但尺寸仍超标 → 标记为 unshrinkable，不浪费重试
- 全部成功缩小才返回 True（调用方可以安全重试）

---

## 五、完整数据流示例

以一个 500 条消息的编码对话为例，展示压缩全过程：

```
初始状态:
  session_id: "20260622_100000_abc123"
  messages: [system_prompt, msg1, msg2, ..., msg500]
  估算 tokens: ~180,000（超过 200K 模型的 50% 阈值 100K）

━━━━━━━━━━━━━━━ 触发压缩 ━━━━━━━━━━━━━━━

Phase 1 — 工具结果裁剪:
  msg3:  [read_file auth.py, 8,000 chars] → [read_file] read auth.py from line 1 (8,000 chars)
  msg7:  [terminal npm test, 12,000 chars] → [terminal] ran 'npm test' -> exit 0, 180 lines output
  msg12: [read_file auth.py, 8,000 chars] → [Duplicate tool output — ...]（去重）
  msg45: [write_file 50KB 内容] → 参数截断为 200 字符头 + ...[truncated]
  ...共裁剪 120 条工具结果

Phase 2 — 边界确定:
  head: 保留 msg1-msg3（system prompt + 第一轮对话，protect_first_n=3）
  tail: 从 msg500 向前累积 ~20K tokens → cut_idx = msg470
  middle: msg4-msg469（466 条消息）

Phase 3 — LLM 摘要生成:
  辅助模型: gpt-4o-mini (通过 OpenRouter)
  输入: 序列化后的 466 条消息（已脱敏）
  输出: ~3,500 tokens 的结构化摘要

Phase 4 — 组装:
  compressed = [
    msg1 (system prompt + 压缩标记),
    msg2,
    msg3,
    {"role": "user", "content": "[CONTEXT COMPACTION...]\n## Historical Task Snapshot\n...",
     "_compressed_summary": true},
    msg470, msg471, ..., msg500
  ]
  清理: 移除 2 个孤立的 tool 结果

会话旋转:
  old: "20260622_100000_abc123" → ended
  new: "20260622_103000_def456" → active, 标题 "重构 auth 模块 (2)"

结果:
  messages: 35 条（500 → 35）
  tokens: ~180,000 → ~48,000
  节省: ~73%
```

---

## 六、总结

### 6.1 设计亮点

1. **分层架构**：算法（`ContextCompressor`）与编排（`compress_context`）分离。算法层是 ContextEngine 插件扩展点，第三方可替换；编排层提供锁、旋转、通知等通用生命周期管理。

2. **防御性设计**：多层降级路径——辅助模型不可用时回退主模型 → 主模型也失败时冷却 → 冷却后的确定性本地降级 → 可选的彻底中止。任何单点故障都不会导致对话卡死。

3. **缓存友好**：压缩虽然修改消息历史，但发生在 API 调用之间，不破坏正在进行中的 prompt cache。

4. **细节打磨**：消息角色交替、tool_call/result 配对修复、历史图片清理、防抖动——都是在实际使用中发现并修复的问题。

5. **与 Claude Code 的哲学分野**：Hermes 追求"可控"——结构化摘要、显式旋转、config.yaml 全量可配；Claude Code 追求"无感"——四层递进、缓存感知、静默运行。两者在各自生态中都是最优解，详见[二、设计原理](#二设计原理两种压缩哲学)。

### 6.2 关键约束

| 约束 | 影响 |
|------|------|
| 压缩是有损的 | 每次压缩丢失中间细节，多次压缩后精度下降（Hermes 会在 ≥2 次压缩时警告） |
| 依赖辅助 LLM | 需要额外配置 API key，增加了部署复杂度 |
| 摘要质量依赖模型能力 | 弱模型可能产出低质量摘要，导致上下文断裂 |

---

## 附录：配置项参考

### `config.yaml` 中 compression 段

```yaml
compression:
  threshold: 0.50          # 触发阈值（上下文使用比例），默认 50%
  target_ratio: 0.20       # tail 保护比例（相对阈值），默认 20%
  protect_first_n: 3       # 头部保护消息数（system prompt 之外的）
  protect_last_n: 20       # 尾部最小保护消息数
  abort_on_summary_failure: false  # 摘要失败时是否彻底中止压缩
  summary_model: ""        # 摘要模型覆盖（空=使用 auxiliary.compression 配置）
```

### `config.yaml` 中 auxiliary.compression 段

```yaml
auxiliary:
  compression:
    provider: openrouter   # 摘要 LLM provider
    model: gpt-4o-mini     # 摘要模型（应选择便宜、快速的模型）
    base_url: ""           # 可选的 base URL 覆盖
    timeout: 60            # 摘要调用超时（秒）
```

### 关键常量

| 常量 | 值 | 说明 |
|------|----|------|
| `_MIN_SUMMARY_TOKENS` | 2,000 | 摘要的最小 token 预算 |
| `_SUMMARY_RATIO` | 0.20 | 摘要预算占被压缩内容的比例 |
| `_SUMMARY_TOKENS_CEILING` | 12,000 | 摘要 token 的绝对上限 |
| `_SUMMARY_FAILURE_COOLDOWN_SECONDS` | 600 | LLM 不可用时的冷却时间 |
| `_FALLBACK_SUMMARY_MAX_CHARS` | 8,000 | 确定性降级摘要的最大字符数 |
| `_IMAGE_TOKEN_ESTIMATE` | 1,600 | 每张图片的估算 token 成本 |
| `MINIMUM_CONTEXT_LENGTH` | 64K | 辅助模型的最小上下文要求 |
