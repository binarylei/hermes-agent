# Hermes 工具搜索桥接分析

> 深入分析 `tools/tool_search.py`（800 行）的渐进式工具暴露机制——当 MCP 和插件工具膨胀到超出上下文窗口 10% 时，如何用 3 个桥接工具替换非核心工具，让模型按需检索和调用。同时覆盖 `model_tools.py` 的桥接调度层和 `tool_executor.py` 的解包层。

---

## 1. 问题背景

Hermes 有 60+ 内置工具，每个工具的 JSON Schema 平均几百字节。当启用多个 MCP 服务器时，工具 schema 可能膨胀到 20K~100K tokens。这会：

- 吃掉大量上下文窗口（模型上下文被工具定义挤占）
- 增加每轮 API 调用成本（工具列表每次都发送）
- 降低模型对核心工具的注意力（过多的选择稀释注意力）

**解决方案**：渐进式工具暴露（Progressive Tool Disclosure）——核心工具永远可见，非核心工具按需通过"桥接工具"检索和调用。

---

## 2. 核心设计：三元桥接

### 2.1 三个桥接工具

```python
# tools/tool_search.py:43-45
TOOL_SEARCH_NAME  = "tool_search"   # 搜索可用工具目录
TOOL_DESCRIBE_NAME = "tool_describe" # 查看某个工具的完整参数 schema
TOOL_CALL_NAME    = "tool_call"     # 实际调用被隐藏的工具
```

发给模型的工具列表被替换为：`[核心工具..., tool_search, tool_describe, tool_call]`。模型在 schema 描述中看到明确的调用顺序：

```
tool_search(query="create github issue")  → 找到候选工具名
tool_describe(name="github_create_issue") → 拿到完整参数 schema  
tool_call(name="github_create_issue", arguments={...}) → 真正执行
```

### 2.2 为什么是 3 步而不是 2 步

与 MCP 协议的 2 步设计（`tools/list` 含完整 schema → `tools/call`）不同，Hermes 有意多拆一步。这是面向**聚合场景**的优化：

| 方案 | `tool_search` 每次搜索消耗 |
|------|--------------------------|
| 一步到位（含完整 schema） | 5 个候选 × 500 tokens ≈ **2500 tokens** |
| 两步分离（仅 name + description） | 5 个候选 × 50 tokens ≈ **250 tokens** |

真正被调用的工具通常只有 1 个。一步到位等于为 4 个不需要的 schema 白白付费 **~2000 tokens**——而减少 token 消耗正是桥接机制的出发点，一步到位会让节省效果大打折扣。

**另外两个设计考量：**

- **搜索精度**：BM25 是纯文本匹配，schema 里的 `{"type": "object", "properties": {...}}` 是噪音。只索引 name + description 让检索更精准。
- **模型注意力**：5 个完整 schema 并行解析的认知负担远高于先看目录、再选一个详查。

### 2.3 与 MCP 协议的对比

```
MCP 协议（2 步）:
  tools/list  → [{name, description, inputSchema}]  ← 含完整 schema
  tools/call  → 执行

Hermes 桥接（3 步）:
  tool_search  → [{name, description}]              ← 仅目录卡片
  tool_describe → {name, inputSchema}               ← 按需拿 schema
  tool_call    → 执行
```

Hermes 把 MCP 的 `tools/list` 拆成了两步（搜索 + 按需查阅），用多一步 LLM turn 换每次搜索 ~90% 的 token 节省。对于聚合 50+ 工具的目录场景，这个权衡是合理的。

---

## 3. 激活决策

### 3.1 三步判断

```python
# tools/tool_search.py:234-258
def should_activate(config, deferrable_tokens, context_length) -> bool:
    if config.enabled == "off":       # 永不激活
        return False
    if deferrable_tokens <= 0:        # 无可延迟工具
        return False
    if config.enabled == "on":        # 强制激活
        return True
    # "auto" 模式
    threshold = int(context_length * config.threshold_pct / 100)
    return deferrable_tokens >= threshold
```

三种模式：

| 模式 | 行为 |
|------|------|
| `off` | 永不激活，所有工具直接暴露 |
| `on` | 强制激活（有可延迟工具时） |
| `auto`（默认） | 非核心工具 schema ≥ 上下文窗口 × 10% 时激活 |

**未知上下文长度时的硬阈值**：如果 context_length 为 `None`，deferrable_tokens ≥ 20000 直接激活。

### 3.2 threshold_pct 默认值

```python
# tools/tool_search.py:102
threshold_pct: float = 10.0  # 上下文窗口的 10%
```

例子：
| 上下文 | 阈值 10% | 何时激活 |
|--------|---------|---------|
| 200K | 20K tokens | 非核心工具 schema ≥ 20K |
| 32K | 3.2K tokens | 非核心工具 schema ≥ 3.2K |
| 未知 | 20K（硬阈值） | 同上 |

### 3.3 Token 估算

```python
# tools/tool_search.py:217-231
def estimate_tokens_from_schemas(tool_defs) -> int:
    """字符数 / 4 规则——跨 provider 稳定，量级精度足够"""
    total_chars = sum(len(json.dumps(td, separators=(",", ":"))) for td in tool_defs)
    return int(math.ceil(total_chars / CHARS_PER_TOKEN))
```

不是精确值——数量级精度就足够判断要不要激活。

---

## 4. 可延迟工具分类

### 4.1 判断链

```python
# tools/tool_search.py:163-186
def is_deferrable_tool_name(name):
    if name in BRIDGE_TOOL_NAMES:          # 桥接工具自身不延迟
        return False
    if name in _core_tool_names():          # 核心工具永不延迟
        return False
    entry = registry.get_entry(name)        # 查注册表
    if entry.toolset.startswith("mcp-"):    # MCP 工具 → 可延迟
        return True
    return True                             # 插件工具 → 可延迟
```

**核心工具白名单**加载自 `toolsets.py` 的 `_HERMES_CORE_TOOLS`（terminal、read_file、web_search、browser_* 等约 40 个工具）。这些工具**在任意配置下都永远可见**，不存在被延迟的可能。

### 4.2 分类过程

```python
# tools/tool_search.py:189-209
def classify_tools(tool_defs) -> (visible, deferrable):
    for td in tool_defs:
        if is_deferrable_tool_name(td.name):
            deferrable.append(td)
        else:
            visible.append(td)
```

`assemble_tool_defs()` 调用 `classify_tools()` 切分后，如果激活开关生效，用 `visible + [3 个桥接工具]` 替换原始的 `visible + deferrable`。

---

## 5. BM25 检索目录

### 5.1 目录条目

```python
# tools/tool_search.py:266-278
@dataclass
class CatalogEntry:
    name: str            # "mcp-github_create_issue"
    description: str     # "Create a new GitHub issue..."
    schema: Dict         # 完整 JSON Schema（tool_describe 时返回）
    source: str          # "mcp" | "plugin"
    source_name: str     # "mcp-github"
    _tokens: List[str]   # 预分词缓存，供 BM25 搜索
```

### 5.2 搜索文本构建（关键设计）

```python
# tools/tool_search.py:289-304
def _entry_search_text(td):
    name = td.get("name", "")
    desc = td.get("description", "") or ""
    param_names = " ".join(params.keys())
    # 蛇形/点分/横线 → 空格拆词
    name_words = name.replace("_", " ").replace(".", " ").replace("-", " ").replace(":", " ")
    return f"{name_words} {desc} {param_names}"
```

**刻意不索引 schema 体**——schema 里的 `properties`、`type`、`required` 等通用字段是纯噪音，会污染 BM25 的词频统计。索引只包含：
- 工具名（拆成独立词——`github_create_issue` → `github create issue`）
- 描述文本
- 参数名列表

### 5.3 BM25 实现

```python
# tools/tool_search.py:347-375
def _bm25_score(query_tokens, doc_tokens, doc_lengths, avg_dl,
                doc_freq, n_docs, k1=1.5, b=0.75):
    # 自实现，无外部依赖（~30 行）
```

**降级方案**：当 BM25 无任何命分（例如所有工具名共享同一前缀，如 `github_*`，IDF 为零），回退到稳定的子串匹配：

```python
# tools/tool_search.py:378-427
def search_catalog(catalog, query, limit=5):
    # 1. BM25 → 2. 分子串匹配降级
    # 3. 固定排序（同名工具按 source_name 排序，确保确定性）
```

### 5.4 搜索返回格式

```python
# tools/tool_search.py:595-602
def _format_search_hit(entry):
    return {
        "name": entry.name,        # "mcp-github_create_issue"
        "source": "mcp",           # mcp | plugin
        "source_name": "mcp-github",
        "description": entry.description[:400],  # 截断长描述
    }
```

完整 schema 不返回——模型在看到搜索结果后，需要调用 `tool_describe` 去拿特定工具的完整参数定义。

---

## 6. 双层调度与解包

当模型通过 `tool_call(name="xxx")` 调用被隐藏的工具时，需要把桥接调用**解包**为对底层工具的直接调用。这个过程发生在两个层面。

### 6.1 层面一：model_tools.py 的桥接调度

```python
# model_tools.py:955-984
if function_name == TOOL_SEARCH_NAME:
    return dispatch_tool_search(args, current_tool_defs=current_defs)

if function_name == TOOL_DESCRIBE_NAME:
    return dispatch_tool_describe(args, current_tool_defs=current_defs)

if function_name == TOOL_CALL_NAME:
    # ① 解包：提取 name + arguments
    underlying_name, underlying_args, err = resolve_underlying_call(args)

    # ② 会话范围门控
    scoped_deferrable = scoped_deferrable_names(current_defs)
    if underlying_name not in scoped_deferrable:
        return error  # 不在当前 enable/disable 工具集范围内

    # ③ 递归：以底层工具名直接调用 handler
    return handle_function_call(
        function_name=underlying_name,   # "mcp-github_create_issue"
        function_args=underlying_args,   # {title: "bug", ...}
        ...
    )
```

### 6.2 层面二：tool_executor.py 的解包

并发路径和串行路径各有一次解包入口：

```python
# tool_executor.py:298-314（并发路径预飞行阶段）
if function_name == "tool_call":
    underlying, underlying_args, err = resolve_underlying_call(function_args)
    if not err and underlying:
        if underlying in _tool_search_scoped_names(agent):
            function_name = underlying   # 替换！
            function_args = underlying_args
        else:
            block_result = {"error": "not available in this session."}
```

串行路径的工具循环中有完全相同的逻辑（`tool_executor.py:806-819`）。

**为什么要两次门控？** model_tools 调度层做了一次，executor 再做一次——因为 executor 的解包绕过 `handle_function_call` 的 bridge 分支，直接 dispatch 到底层 handler。并发路径尤其必须自己做权限校验。

### 6.3 resolve_underlying_call 的校验链

```python
# tools/tool_search.py:680-710
def resolve_underlying_call(args) -> (name, args, error):
    ① 提取 name 参数 → "mcp-github_create_issue"
    ② 提取 arguments 参数 → {title: "...", body: "..."}
    ③ 校验 name 不是桥接工具自身
    ④ 校验 name 确实是 deferrable 工具
    ⑤ arguments 必须是合法 JSON/dict
```

### 6.4 权限门控的缓存机制

```python
# tool_executor.py:135-181
def _tool_search_scoped_names(agent) -> frozenset:
    cache_key = (
        registry._generation,        # MCP 重连时递增 → 缓存失效
        frozenset(agent.enabled_toolsets),
        frozenset(agent.disabled_toolsets),
    )
    if cached and cached[0] == cache_key:
        return cached[1]   # 缓存命中

    # 未命中 → get_tool_definitions(skip_tool_search_assembly=True)
    #         → scoped_deferrable_names()
    #         → 写入 agent._tool_search_scope_cache
```

缓存 key 包含 `registry._generation`——MCP 服务器重连时代际递增，缓存自动失效。正常路径（代际未变）就是一次 frozenset 查找。

---

## 7. 完整运行时流程

```
启动阶段（每次 get_tool_definitions 时）:
┌────────────────────────────────────────────────────────────┐
│ assemble_tool_defs(context_length=200K, threshold_pct=10)   │
│                                                             │
│ ① 解析所有工具 → 60+ 个 tool_defs                           │
│ ② classify_tools():                                         │
│    visible    = [terminal, read_file, web_search, ...]      │
│    deferrable = [mcp-github_*, mcp-jira_*, ...]           │
│ ③ estimate_tokens_from_schemas(deferrable) = 25K            │
│ ④ should_activate(): 25K ≥ 200K × 10% = 20K → True         │
│ ⑤ 替换: visible + [tool_search, tool_describe, tool_call]   │
│ ⑥ 构建内存目录 (build_catalog + BM25 索引)                   │
│ → 发给 LLM 的 tools = 核心工具 + 3 个桥接工具                │
└────────────────────────────────────────────────────────────┘

运行时（模型调用时）:
  Turn 1: model → tool_search(query="github issue")
          model_tools → dispatch_tool_search()
          结果: {matches: [{name:"mcp-github_create_issue", desc:"...", source:"mcp"}, ...]}

  Turn 2: model → tool_describe(name="mcp-github_create_issue")
          model_tools → dispatch_tool_describe()
          结果: {name:"mcp-github_create_issue", parameters: {type:"object", properties: {...}}}

  Turn 3: model → tool_call(name="mcp-github_create_issue", arguments={title:"bug", ...})
          ↓
          executor 解包:
            ① resolve_underlying_call → name="mcp-github_create_issue", args={...}
            ② _tool_search_scoped_names 检查权限 → 通过
            ③ function_name 替换为 "mcp-github_create_issue"
            ④ 后续所有处理（guardrail、checkpoint、dispatch）看到的是底层工具
          → registry.dispatch("mcp-github_create_issue", {title:"bug", ...})
          → 就像直接调用一样
```

**解包发生在 executor 入口**——这意味着所有后处理（护栏检查、审批流、插件钩子、检查点快照、结果截断）看到的工具名都是底层工具名，而非 `tool_call`。桥接对后处理链完全透明。

---

## 8. 设计约束与精妙之处

### 8.1 无状态目录，每次重建

```python
# tools/tool_search.py:529-583
def assemble_tool_defs(tool_defs, *, context_length, config):
    # 每次都从头分类、构建目录
    # 不缓存：工具列表可能在 turn 之间变化
```

OpenClaw 项目曾因在 cron 上下文中缓存工具目录导致回归 bug（#84141）——cron 的工具集和常规会话不同，但缓存返回了旧结果。Hermes 的木匾是**每次装配时重建**，避免这类跨会话状态污染。

### 8.2 桥接工具走完整审批/护栏链

`tool_call` 解包后 dispatch 到底层工具的 handler，走的是**与直接调用完全相同的路径**：approval 流、插件 hook、结果截断、guardrail 检测——全都生效。

### 8.3 显示层看到真实工具名

解包在 executor 入口完成，所有回调（`tool_progress_callback`、`tool_complete_callback`）和活动日志（`_touch_activity`）显示的都是底层工具名。用户看到的是 `mcp-github_create_issue` 而不是 `tool_call`。

### 8.4 受限会话的双重权限门控

子 agent、kanban worker、受限网关会话的工具集被裁剪过。它们不能通过 `tool_call` 越权调用超出范围的工具，因为两道门各守一边：

| 门控层 | 位置 | 作用 |
|--------|------|------|
| 调度层 | `model_tools.py:972` | `scoped_deferrable_names(current_defs)` |
| 执行层 | `tool_executor.py:303` | `_tool_search_scoped_names(agent)` |

任一不通过就返回 error 信息，不会走到实际的 handler。

### 8.5 核心工具永不可延迟

`_HERMES_CORE_TOOLS` 是硬编码白名单，不随配置变化。即使某核心工具被 MCP 同名工具"影子注册"，`is_deferrable_tool_name()` 中的核心工具检查在前，永远不会被误分类为可延迟。

---

## 9. 与相关文档的关系

| 文档 | 关系 |
|------|------|
| [工具系统分析](hermes-工具系统分析.md) | 上游——它的 §3.4 概述了桥接概念，本文是完整展开 |
| [工具执行引擎分析](hermes-工具执行引擎分析.md) | 下游——它的 §7 覆盖 executor 层解包，本文补全调度层全景 |
| [AIAgent架构分析](hermes-AIAgent架构分析.md) | 上层——桥接在 10 环节流水线中位于步骤③（组装 schema）和步骤⑥（执行工具）之间 |
