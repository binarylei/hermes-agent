# Hermes 工具系统分析

> 本文档分析 Hermes Agent 的工具系统架构、设计原则，并与 Claude Code 进行对比。
> 重点关注核心工具的实现原理，用于学习研究。

---

## 1. Hermes vs Claude Code 工具对比

Claude Code 作为 IDE 内嵌的编码助手，只提供 **4 个基础工具**：

| Claude Code 工具 | 用途 |
|---|---|
| `Read` | 读取文件内容 |
| `Write` | 写入文件 |
| `Edit` | 精确字符串替换编辑 |
| `Bash` | 执行 shell 命令 |

这 4 个工具覆盖了编码场景的最小必需集——读代码、写代码、运行命令。设计极简，每个工具直接由 CLI 进程内的函数实现。

Hermes Agent 则提供了 **60+ 个工具**，面向更广泛的场景——不仅编码，还包括消息收发、浏览器自动化、语音合成、智能家居控制等。这也是 Hermes 定位为"个人 AI agent"而非"编码助手"的体现。

---

## 2. Hermes 工具全景图

Hermes 的工具按 **工具集（Toolset）** 组织，每个工具集对应一类能力：

### 2.1 核心工具清单（_HERMES_CORE_TOOLS）

所有平台的默认工具集都基于此列表（定义在 `toolsets.py:31-76`）：

| 分类 | 工具 | 说明 |
|---|---|---|
| **Web** | `web_search`, `web_extract` | 网页搜索与内容提取 |
| **终端** | `terminal`, `process` | 命令执行与进程管理 |
| **桌面终端** | `read_terminal` | 读取桌面 GUI 内嵌终端（桌面版专用） |
| **文件** | `read_file`, `write_file`, `patch`, `search_files` | 文件读写、模糊匹配补丁、内容搜索 |
| **视觉** | `vision_analyze` | 图片分析 |
| **图像生成** | `image_generate` | AI 图像生成 |
| **技能** | `skills_list`, `skill_view`, `skill_manage` | 技能系统的查看与管理 |
| **浏览器** | `browser_navigate/snapshot/click/type/scroll/back/press/get_images/vision/console/cdp/dialog` | 12 个浏览器自动化工具 |
| **语音** | `text_to_speech` | 文字转语音 |
| **规划** | `todo`, `memory` | 任务列表 + 持久记忆 |
| **会话搜索** | `session_search` | 跨会话历史搜索 |
| **澄清** | `clarify` | 向用户提澄清问题 |
| **代码执行** | `execute_code` | Python 沙箱执行（可调用其他工具） |
| **委托** | `delegate_task` | 生成子 agent 并行工作 |
| **定时任务** | `cronjob` | 定时任务管理 |
| **消息** | `send_message` | 跨平台消息发送（门控：gateway 运行时才暴露） |
| **智能家居** | `ha_list_entities/get_state/list_services/call_service` | Home Assistant 控制（门控：HASS_TOKEN） |
| **看板** | `kanban_show/list/complete/block/heartbeat/comment/create/link/unblock` | 多 agent 看板协调（门控：kanban worker 模式） |
| **计算机使用** | `computer_use` | macOS 桌面控制（门控：cua-driver） |

### 2.2 工具集分类（TOOLSETS）

工具集可以组合和继承，定义在 `toolsets.py:91-279`：

```python
TOOLSETS = {
    "web":        { "tools": ["web_search", "web_extract"] },
    "terminal":   { "tools": ["terminal", "process"] },
    "browser":    { "tools": [12 个浏览器工具 + web_search] },
    "file":       { "tools": ["read_file", "write_file", "patch", "search_files"] },
    "coding":     { "tools": [终端+文件+浏览器+技能+todo+memory+...], "posture": True },
    "kanban":     { "tools": [9 个看板工具] },
    "delegation": { "tools": ["delegate_task"] },
    "memory":     { "tools": ["memory"] },
    # ... 等 30+ 个工具集
}
```

### 2.3 场景化工具集

不同平台使用不同的工具集组合（`toolsets.py:377-479`）：

| 工具集 | 平台 | 特点 |
|---|---|---|
| `hermes-cli` | CLI / TUI | 全量核心工具 + cronjob |
| `hermes-telegram` | Telegram | 全量核心工具 |
| `hermes-discord` | Discord | 核心工具 + discord/discord_admin |
| `hermes-acp` | VS Code / Zed / JetBrains | 编码聚焦，无消息/音频/clarify |
| `hermes-api-server` | HTTP API | 全量但无交互式 UI 工具 |
| `hermes-cron` | 定时任务 | 同 CLI，但推送通过消息平台 |

---

## 3. 工具系统设计原则

### 3.1 自注册模式（Self-Registration）

每个工具文件在模块级别调用 `registry.register()` 注册自己。这是 Hermes 工具系统最核心的设计决策。

```python
# tools/terminal_tool.py 末尾
registry.register(
    name="terminal",
    toolset="terminal",
    schema=TERMINAL_SCHEMA,          # OpenAI function-calling schema
    handler=_handle_terminal,        # 实际执行函数
    check_fn=check_terminal_requirements,  # 可用性检查
    emoji="💻",
    max_result_size_chars=100_000,   # 返回给模型的最大字符数
)
```

**注册参数说明：**

| 参数 | 作用 |
|---|---|
| `name` | 工具唯一标识名 |
| `toolset` | 所属工具集 |
| `schema` | OpenAI function-calling 兼容的 JSON Schema |
| `handler` | 工具调用处理函数 `(args, task_id, ...) -> str` |
| `check_fn` | 返回 bool 的可用性检查函数（如检查 Docker 是否安装） |
| `requires_env` | 所需环境变量列表 |
| `is_async` | handler 是否为 async 函数 |
| `emoji` | CLI 展示用的 emoji |
| `max_result_size_chars` | 返回结果截断阈值 |
| `dynamic_schema_overrides` | 运行时动态修改 schema 的回调（如 delegate_task 的并发数限制需要从配置读取） |

### 3.2 工具发现（AST 扫描 + 按需导入）

入口在 `tools/registry.py:57-74` 的 `discover_builtin_tools()`：

```python
def discover_builtin_tools(tools_dir=None):
    tools_path = Path(tools_dir) or Path(__file__).resolve().parent
    module_names = [
        f"tools.{path.stem}"
        for path in sorted(tools_path.glob("*.py"))
        if path.name not in {"__init__.py", "registry.py", "mcp_tool.py"}
        and _module_registers_tools(path)  # AST 预扫描
    ]
    for mod_name in module_names:
        importlib.import_module(mod_name)  # 导入触发 register() 调用
```

**关键优化：AST 预扫描。** 在 import 之前，先用 AST 解析检查模块是否包含顶层 `registry.register()` 调用。这避免了导入不相关的辅助模块（如 `binary_extensions.py`、`path_security.py` 等），减少启动时间。

### 3.3 门控机制（check_fn）

每个工具可以附带一个 `check_fn`，在工具 schema 发送给模型之前执行。如果返回 `False`，该工具从当前会话的可用工具列表中移除。

```python
# terminal_tool: 检查终端后端是否可用
def check_terminal_requirements():
    # 检查 Docker、Modal、SSH 等后端是否可用
    ...

# browser_tool: 检查 Playwright 是否安装
def check_browser_requirements():
    try:
        from playwright.sync_api import sync_playwright
        return True
    except ImportError:
        return False
```

**check_fn 缓存：** `registry.py:120-141` 实现了 30 秒 TTL 缓存。因为 check_fn 可能探测 Docker daemon、Modal SDK、Playwright 二进制等外部状态，在长生命周期进程中反复调用是纯粹浪费。

### 3.4 工具搜索（渐进式工具暴露）

`tools/tool_search.py` 实现了一个关键设计：当 MCP 和插件工具数量较多时，Hermes 不将所有工具一次性塞入系统提示词，而是用 3 个"桥接工具"替代：

- `tool_search` — 按关键词搜索可用工具
- `tool_describe` — 获取指定工具的详细 schema
- `tool_call` — 通过桥接调用工具（所有 guardrail 依旧生效）

**核心设计约束：**
1. `_HERMES_CORE_TOOLS` 中的核心工具 **永不延迟加载**
2. 当可延迟工具占模型上下文窗口不足 `threshold_pct`（默认 10%）时，工具搜索是 no-op
3. 目录是 **无状态** 的，每次组装工具数组时重建（避免了 OpenClaw 的 cron 回归问题 #84141）
4. 桥接工具路由经过 `model_tools.handle_function_call`，approval 流、插件 hook、结果截断全部完全一致

### 3.5 同步/异步桥接

`model_tools.py:38-173` 实现了精巧的 sync↔async 桥接：

- **主线程无事件循环时：** 使用持久化事件循环（避免 `asyncio.run()` 创建-销毁循环导致的 "Event loop is closed" 错误）
- **在 gateway 的 async 上下文中：** 在独立线程中运行协程，带 300 秒超时和取消传播
- **在工作线程中（并行工具执行）：** 使用线程本地持久化循环

这个设计确保了 httpx/AsyncOpenAI 等异步客户端在 GC 时不会因事件循环已关闭而崩溃。

### 3.6 注册表代际（Generation Counter）

```python
class ToolRegistry:
    def __init__(self):
        self._generation: int = 0  # 单调递增计数器
```

每次 register/deregister/MCP 刷新时递增。外部调用者（如 `get_tool_definitions`）可以基于代际做 memoization——只要代际不变，缓存就有效。这是 MCP 动态工具刷新场景下的关键优化。

---

## 4. 工具执行全流程

本节以 `terminal` 工具为例，追踪从代码注册 → Schema 生成 → 模型调用 → 调度执行 → 结果返回的完整链路。

### 4.1 流程总图

```
┌─ 启动时：import ────────────────────────────────────────────┐
│  model_tools.py import                                       │
│    → discover_builtin_tools()  扫描 tools/*.py               │
│      → import tools/terminal_tool.py                         │
│        → registry.register(name="terminal", handler=...,     │
│            schema=..., check_fn=..., toolset="terminal")     │
│        存入 _tools["terminal"], _generation++                │
└──────────────────────────────────────────────────────────────┘
                           ↓
┌─ 会话开始：筛工具 ──────────────────────────────────────────┐
│  get_tool_definitions(enabled_toolsets)                      │
│    → resolve_toolset("hermes-cli") → 展开 _HERMES_CORE_TOOLS │
│    → registry.get_definitions(["terminal", "read_file",..])  │
│      → check_fn() 可用性检查 (30s TTL 缓存)                  │
│    → 返回 [{type: "function", function: {name:"terminal",..}}]│
└──────────────────────────────────────────────────────────────┘
                           ↓
┌─ Agent 循环：调用工具 ──────────────────────────────────────┐
│  while api_call_count < max_iterations:                      │
│    response = API.chat(messages, tools=tool_schemas)         │
│    if response.tool_calls:                                   │
│      for tc in tool_calls:                                   │
│        result = handle_function_call(tc.name, tc.args)       │
│        messages += {"role":"tool", "content":result}         │
│    else:                                                     │
│      return response.content   ← 对话结束                    │
└──────────────────────────────────────────────────────────────┘
                           ↓
┌─ handle_function_call 内部 ─────────────────────────────────┐
│  ① coerce_tool_args → 类型校正 (string→int 等)              │
│  ② apply_tool_request_middleware                             │
│  ③ pre_tool_call 插件钩子 (可拦截)                          │
│  ④ 安全门控 (tirith + dangerous command + 审批)             │
│  ⑤ registry.dispatch(name, args)                            │
│     → _tools[name].handler(args, task_id=...)                │
│       → terminal_tool(command=..., background=...)           │
│         → _get_env_config → 读 TERMINAL_ENV/TIMEOUT/CWD     │
│         → _create_environment → LocalEnvironment/Docker/... │
│         → _check_all_guards → 危险命令审批                  │
│         → env.execute(command, cwd=..., timeout=...)         │
│           → subprocess.Popen / 容器执行                      │
│           → 输出截断 + ANSI strip + 敏感信息脱敏            │
│         → return {"output":"...", "exit_code":0}             │
│  ⑥ post_tool_call 钩子                                      │
│  ⑦ transform_tool_result 插件钩子                           │
│  return result (JSON 字符串)                                 │
└──────────────────────────────────────────────────────────────┘
```

### 4.2 阶段详解

#### 阶段 0：模块 import 时自注册

每个 `tools/*.py` 文件底部有模块级 `registry.register()` 调用。以 `terminal_tool.py` 为例（第 2616-2684 行）：

```python
from tools.registry import registry

registry.register(
    name="terminal",           # 模型 function_call 的 name
    toolset="terminal",        # 所属工具集
    schema=TERMINAL_SCHEMA,    # OpenAI function-calling JSON Schema
    handler=_handle_terminal,  # 实际执行函数
    check_fn=check_terminal_requirements,  # 可用性检查
    emoji="💻",
    max_result_size_chars=100_000,
)
```

`registry` 是 `ToolRegistry` 的单例。`register()` 创建 `ToolEntry` 对象存入 `self._tools["terminal"]`，并递增 `_generation` 计数器（用于通知下游缓存失效）。

**handler 是薄包装**，将模型传入的扁平参数映射到实际函数：

```python
def _handle_terminal(args, **kw):
    return terminal_tool(
        command=args.get("command"),
        background=args.get("background", False),
        timeout=args.get("timeout"),
        task_id=kw.get("task_id"),
        workdir=args.get("workdir"),
        pty=args.get("pty", False),
        notify_on_complete=args.get("notify_on_complete", False),
        watch_patterns=args.get("watch_patterns"),
    )
```

#### 阶段 1：模块 import 时工具发现

`model_tools.py` 模块级别调用（第 180 行）：

```python
discover_builtin_tools()   # registry.py:57-74
```

流程：
1. 扫描 `tools/*.py`（排除 `__init__.py`、`registry.py`、`mcp_tool.py`）
2. 用 **AST 预扫描** 检查每个文件是否含顶层 `registry.register(` 调用（避免导入不相关的辅助模块）
3. 对匹配的文件执行 `importlib.import_module("tools.terminal_tool")`
4. `import` 触发阶段 0 的 `register()`，工具条目入 registry
5. 同时触发 `discover_plugins()` 加载用户插件工具

#### 阶段 2：会话开始时筛工具

每次会话开始调用 `get_tool_definitions(enabled_toolsets)`（`model_tools.py:272`）：

```
步骤 1: resolve_toolset("hermes-cli")
  → 递归展开工具集定义（TOOLSETS["hermes-cli"]["tools"] = _HERMES_CORE_TOOLS）
  → 收集工具名集合 {"terminal", "read_file", "write_file", ...}
  → 再对每个工具集名调 registry.get_tool_names_for_toolset（工具集下自注册的）
  → 合并，去重

步骤 2: registry.get_definitions(tool_names)
  对每个工具名:
    → 取 ToolEntry
    → 调用 entry.check_fn()（30s TTL 缓存）
        → terminal: check_terminal_requirements()
            → TERMINAL_ENV=local → True
            → TERMINAL_ENV=docker → 探测 docker version 是否可执行
            → TERMINAL_ENV=modal → 检查 Modal SDK 或托管网关
    → 可用 → 加到 schema 列表
    → 不可用 → 静默排除（模型不会看到此工具）
    → 应用 dynamic_schema_overrides（如 delegate_task 的 max_concurrent_children）

步骤 3: 工具搜索渐进式展示判断
  → 核心工具（_HERMES_CORE_TOOLS 中的）永不延迟加载
  → MCP/插件工具超出上下文窗口 10% 阈值时替换为 3 个桥接工具
  → 返回最终 schema 列表（OpenAI 格式）
```

这一步决定了 **模型实际能看到哪些工具**。如果 Docker 不可用且 TERMINAL_ENV=docker，`terminal` 就不会出现在发给模型的 schema 中。

#### 阶段 3：Agent 循环中的模型调用

核心循环在 `agent/conversation_loop.py` 的 `run_conversation()`：

```python
while (api_call_count < max_iterations and iteration_budget.remaining > 0) \
        or _budget_grace_call:    # 最后一次"超预算宽限"调用
    if _interrupt_requested:
        break

    response = client.chat.completions.create(
        model=model,
        messages=messages,         # system + 历史对话 + 工具结果
        tools=tool_schemas,         # 阶段 2 筛出的工具 schema
    )

    if response.choices[0].message.tool_calls:
        # 模型要调工具
        for tc in tool_calls:
            result = agent._execute_tool_calls(...)   # → 阶段 4
            messages.append({
                "role": "tool",
                "content": result,
                "tool_call_id": tc.id
            })
        api_call_count += 1
        # 继续循环，把工具结果发回模型
    else:
        # 模型返回文本，对话结束
        return response.choices[0].message.content
```

角色交替约束：Hermes 严格保证 `system → user → assistant → tool → assistant → tool → ...` 的消息角色交替，绝不在中间插入同角色消息（否则破坏 prompt 缓存）。

#### 阶段 4：`handle_function_call` 调度前处理

`model_tools.py:876`，这是工具调度的中心枢纽，做 5 层前置处理后才真正执行：

```
① coerce_tool_args(name, args)            (第 917 行)
   → 对照 JSON Schema 做类型强制转换
   → 模型可能把 timeout 当成 "180" (string) 发来 → 转成 180 (int)
   → 防止 handler 因类型不匹配崩溃

② 工具搜索桥检查                            (第 928-995 行)
   → terminal 不是桥接工具，跳过

③ apply_tool_request_middleware             (第 998 行)
   → 运行中间件链，可修改参数或记录审计

④ pre_tool_call 插件钩子                     (第 1031 行)
   → 插件可拦截调用，返回 blocked/reason
   → 安全策略检查（tirith + dangerous command patterns）
   → blocked → 直接返回错误 JSON，不执行 handler

⑤ registry.dispatch(name, args, ...)       (第 1110 行)
   → 创建 _dispatch 闭包 → 包在 run_tool_execution_middleware 中
   → 真正执行工具 handler
```

#### 阶段 5：`registry.dispatch` → handler → 实际函数

```python
# registry.py:390
def dispatch(self, name, args, **kwargs):
    entry = self._tools.get(name)          # 取 ToolEntry
    if entry is None:
        return '{"error": "Unknown tool: ..."}'  # 未知工具
    try:
        result = entry.handler(args, **kwargs)    # 调 _handle_terminal
        return result
    except Exception as e:
        return json.dumps({"error": _sanitize_tool_error(str(e))})
        # 异常清洗：剥离 XML 标签、CDATA 片段、markdown 围栏
```

`terminal_tool()` 函数内部的关键执行步骤：

1. **读配置** → `_get_env_config()` 读 `TERMINAL_ENV`、`TERMINAL_TIMEOUT`、`TERMINAL_CWD` 等
2. **解析容器 task_id** → `_resolve_container_task_id(task_id)`，子 agent 默认共享父容器
3. **检查任务级覆盖** → benchmark 环境可注册自定义 Docker/Modal 镜像
4. **前台超时硬上限** → `background=false` 且 `timeout > 600s` → 直接拒绝
5. **长驻进程检测** → `npm dev`、`docker compose up` 等前台命令 → 提示改用 `background=true`
6. **取/建执行环境** → 缓存命中复用，否则 `_create_environment(env_type, ...)`
7. **危险命令审批** → `_check_all_guards(command, env_type)` → blocked/pending_approval/approved
8. **sudo 改写** → `_transform_sudo_command(command)` → `sudo` → `sudo -S -p ''` + 管道密码
9. **选择执行路径**：
   - `background=true` → `process_registry.spawn_local()` / `spawn_via_env()` → 返回 session_id
   - `background=false` → `env.execute(command, cwd, timeout)` → 阻塞等待 → 最多重试 3 次
10. **结果后处理** → 输出截断（head 40% + tail 60%）→ ANSI strip → 敏感信息脱敏 → exit_code 解读

#### 阶段 6：结果回传模型

```
terminal_tool → 返回 JSON 字符串
      ↓
_handle_terminal → 透传
      ↓
registry.dispatch → 透传
      ↓
handle_function_call:
  → post_tool_call 钩子 (可记录耗时/审计)
  → transform_tool_result 插件钩子 (可替换输出)
  → return result
      ↓
agent 循环:
  → 追加 {"role": "tool", "content": result} 到 messages
  → while 循环继续，带更新后的 messages 调 API
  → 模型看到工具结果 → 继续推理或再调工具
```

### 4.3 两种特殊的工具执行路径

#### Agent 级工具（绕过 registry.dispatch）

有 4 个工具不走 `registry.dispatch`，而是在 `handle_function_call` 中直接拦截处理：

| 工具 | 拦截位置 | 原因 |
|------|---------|------|
| `todo` | `run_agent.py` | 需要直接操作 agent 实例的内部 todo 列表 |
| `memory` | `run_agent.py` | 涉及记忆注入/过期等复杂生命周期 |
| `session_search` | `run_agent.py` | 需要访问代理的会话数据库 |
| `delegate_task` | `model_tools.py` | 需要做子 agent 数量限制、递归深度检查、配额耗尽提示 |

这些工具在 `_AGENT_LOOP_TOOLS` 集合中标记，`handle_function_call` 在通用 dispatch 路径之前检查。

#### MCP 工具（透明代理）

MCP 工具以 `mcp-<server_name>__<tool_name>` 为名注册。调度路径：

```
handle_function_call
  → 识别为 MCP 工具（名称前缀匹配 mcp-）
  → 通过 MCP 客户端发送 JSON-RPC 请求到外部 MCP 服务器
  → 等待响应
  → 返回结果（经过同样的截断/脱敏处理）
```

对模型来说 MCP 工具和内置工具的调用方式完全相同，无需感知差异。

### 4.4 关键设计决策总结

| 决策 | 机制 | 好处 |
|------|------|------|
| **import 时自注册** | 模块级的 `registry.register()` | 零配置，新增工具只需创建文件+注册 |
| **AST 预扫描** | `_module_registers_tools()` | 避免导入不相关的辅助模块，减少启动时间 |
| **check_fn 30s 缓存** | `_check_fn_cached` | 避免反复探测外部进程（Docker/Modal/Playwright）|
| **核心工具永不延迟** | `_HERMES_CORE_TOOLS` 白名单 | 保证基本能力始终可用 |
| **同步/异步桥接** | 持久化事件循环 + 线程安全 | 兼容各种运行环境（CLI/网关/线程池）|
| **代际计数器** | `registry._generation` | 支持无锁 memoization，MCP 动态刷新友好 |
| **统一错误处理** | `_sanitize_tool_error` | 所有工具的错误都经过清洗，不泄露内部细节 |
| **插件钩子可插拔** | pre/post + transform 三个拦截点 | 不修改核心代码即可扩展监控/审计/转换 |

---

## 5. 重点工具深度分析

### 5.1 terminal_tool — 命令执行工具

**文件：** `tools/terminal_tool.py`（121K，约 2700 行）

**定位：** Hermes 最核心、最强大、也最危险的工具。所有代码生成、测试运行、部署操作最终都通过它执行。

**支持的后端环境：**

| 后端 | 说明 |
|---|---|
| `local` | 直接在宿主机执行（默认，最快） |
| `docker` | Docker 容器内隔离执行 |
| `modal` | Modal 云端沙箱（直接或受管网关） |
| `ssh` | 远程 SSH 服务器 |
| `singularity` | Singularity 容器（HPC 场景） |
| `daytona` | Daytona 开发环境 |

**核心功能：**

1. **前台/后台执行：** `background=False` 阻塞等待结果；`background=True` 返回进程 ID，可通过 `process` 工具轮询
2. **超时控制：** 前台默认 180s，硬上限 600s（`FOREGROUND_MAX_TIMEOUT`），防止失控进程
3. **PTY 模式：** 支持伪终端，用于交互式 CLI 工具如 Codex、Claude Code、Python REPL
4. **通知机制：** `notify_on_complete` 和 `watch_patterns` 两种异步通知模式
5. **中断支持：** 通过 `tools/interrupt.py` 的全局中断事件，用户可以 Ctrl+C 终止长时间运行的子进程
6. **危险命令审批：** 通过 `tools/approval.py` 的审批队列，对 `rm -rf`、`sudo` 等危险命令进行确认
7. **sudo 密码缓存：** 会话级别的 sudo 密码缓存，避免反复输入

**Schema 参数：**

```json
{
  "command": "string (required)",
  "background": "boolean (default: false)",
  "timeout": "integer (default: 180, max foreground: 600)",
  "workdir": "string (absolute path)",
  "pty": "boolean (default: false)",
  "notify_on_complete": "boolean (default: false)",
  "watch_patterns": "array of strings"
}
```

**设计亮点：**

- **环境抽象层：** 所有后端（local/docker/modal/ssh/singularity/daytona）实现统一接口 `tools/environments/`，terminal_tool 不感知具体后端
- **进程注册表：** `tools/process_registry.py`（71K）管理所有后台进程的生命周期——输出缓冲（200KB 滚动窗口）、状态轮询、崩溃恢复（JSON checkpoint）
- **工作目录隔离：** 每个 task_id 拥有独立的工作目录，通过 `TERMINAL_CWD` 环境变量控制

### 5.2 delegate_tool — 子代理委托工具

**文件：** `tools/delegate_tool.py`（130K，约 2938 行）

**定位：** Hermes 最独特的工具，实现了"父 agent 生成子 agent 并行工作"的架构。这是 Hermes 区别于简单 chatbot 的核心能力。

**核心架构：**

```
父 Agent（拥有完整上下文和工具）
  │
  ├── delegate_task(goal="写前端组件", role="ui-dev")
  │   └── 子 Agent 1（隔离上下文，受限工具集）
  │        ├── 独立 terminal 会话
  │        ├── 独立文件操作缓存
  │        └── 返回摘要结果给父 Agent
  │
  ├── delegate_task(goal="写后端 API", role="api-dev")
  │   └── 子 Agent 2（与子 Agent 1 并行执行）
  │
  └── 汇总所有子 Agent 结果，继续工作
```

**子 Agent 的安全约束（DELEGATE_BLOCKED_TOOLS）：**

```python
DELEGATE_BLOCKED_TOOLS = frozenset([
    "delegate_task",  # 禁止递归委托
    "clarify",        # 禁止与用户交互
    "memory",         # 禁止写入共享 MEMORY.md
    "send_message",   # 禁止跨平台副作用
    "execute_code",   # 子 agent 应逐步推理而非写脚本
])
```

**审批回调机制：**

子 agent 在 ThreadPoolExecutor 工作线程中运行。CLI 的交互式审批回调存储在 `threading.local()` 中，工作线程不会继承。为防止死锁（子 agent 调用 `input()` 阻塞父 TUI），Hermes 提供了两种策略：

- `_subagent_auto_deny`（默认）：自动拒绝危险命令，子 agent 可恢复
- `_subagent_auto_approve`（YOLO 模式）：自动批准，用于 cron/batch 场景

**动态 Schema：**

```python
dynamic_schema_overrides=_build_dynamic_schema_overrides
```

delegate_task 的 schema 描述中包含了 `max_concurrent_children` 和 `max_spawn_depth` 等运行时配置值。每次 `get_tool_definitions()` 调用时，回调读取最新配置并覆盖 schema。这确保了模型看到的限制永远是最新的。

### 5.3 memory_tool — 持久记忆工具

**文件：** `tools/memory_tool.py`（34K，约 810 行）

**定位：** 实现 Hermes 的"跨会话学习"核心能力。这是 Hermes 区别于无状态 chatbot 的关键。

**双存储模型：**

| 文件 | 用途 |
|---|---|
| `MEMORY.md` | Agent 的笔记：环境事实、项目约定、工具特性、学到的经验 |
| `USER.md` | Agent 对用户的认知：偏好、沟通风格、期望、工作流习惯 |

**核心设计——冻结快照模式：**

```
会话开始 → 读取 MEMORY.md/USER.md → 注入系统提示词 → 冻结（不再修改提示词）
   │                                                      │
   │                                           保护 prompt 缓存不被破坏
   │
会话中 write → 立即写入磁盘（持久化）
   │
下一会话 → 读取最新文件 → 新快照
```

这是 Hermes 设计原则"**Per-conversation prompt caching is sacred**"的典型体现。中途修改系统提示词会使缓存的 prompt 前缀失效，导致用户的 API 成本翻倍。

**条目格式：**
- 分隔符：`§`（章节符号）
- 字符限制而非 token 限制（模型无关）
- `replace`/`remove` 使用短子串匹配（非全文匹配或 ID）

**安全扫描：**

```python
from tools.threat_patterns import first_threat_message

def _scan_memory_content(content: str) -> Optional[str]:
    return _first_threat_message(content, scope="strict")
```

记忆内容在写入前和注入系统提示词前都经过注入/泄露模式扫描（`scope="strict"` 使用最宽泛的模式集），防止恶意技巧通过记忆条目持久化到会话中。

**外部漂移检测：**

如果用户通过 patch 工具、shell 追加、手动编辑等方式修改了 MEMORY.md，导致文件内容无法通过 § 分隔符解析器往返，memory_tool 会拒绝写入并保存 `.bak.<timestamp>` 快照。这防止了并发会话或外部工具破坏记忆文件的一致性。

### 5.4 execute_code — Python 代码执行工具

**文件：** `tools/code_execution_tool.py`（77K，约 1837 行）

**定位：** 允许 agent 编写 Python 脚本，脚本内部可以通过 RPC 调用其他 Hermes 工具。将多步工具调用流水线折叠为**零上下文开销**的单个 turn。

**核心价值：**

```
无 execute_code：      有 execute_code：
Turn 1: 读文件 A        Turn 1: execute_code("""
Turn 2: 读文件 B             data_a = tool("read_file", {"file_path": "A"})
Turn 3: 分析 + 写文件 C      data_b = tool("read_file", {"file_path": "B"})
                          → 分析 + 写文件 C
                          """)
                          → 1 个 turn 完成
```

**安全沙箱：**
- Python 代码在受限命名空间中执行
- 通过 RPC 调用工具，而非直接访问
- 工具调用的审批流依然生效

### 5.5 browser_tool — 浏览器自动化工具

**文件：** `tools/browser_tool.py`（168K，约 3866 行）

**定位：** 提供完整的浏览器自动化能力，包括导航、交互、截图分析、控制台访问。

**12 个子工具：**

```python
browser_navigate     # 导航到 URL
browser_snapshot     # 获取页面可访问性树快照
browser_click        # 点击元素（通过 ref 引用）
browser_type         # 输入文本
browser_scroll       # 滚动页面
browser_back         # 后退
browser_press        # 按键
browser_get_images   # 提取页面图片
browser_vision       # 截图 + AI 视觉分析
browser_console      # 读取/执行 JS 控制台
browser_cdp          # Chrome DevTools Protocol 原生调用
browser_dialog       # 处理浏览器对话框
```

**设计特点：**

1. **Playwright 驱动：** 底层使用 Playwright，支持 Chromium
2. **Camofox 隐身模式：** `browser_camofox.py`（29K）实现浏览器指纹隐藏
3. **监督器模式：** `browser_supervisor.py`（63K）管理浏览器生命周期
4. **CDP 原生访问：** `browser_cdp_tool.py` 提供 Chrome DevTools Protocol 的直接调用能力

---

## 6. 工具基础设施

### 6.1 注册表（registry.py）

```python
class ToolRegistry:
    """单例注册表，从工具文件收集 schema + handler"""
    
    def register(name, toolset, schema, handler, check_fn, ...)
    def deregister(name)
    def dispatch(name, args, task_id)  # 调用工具的 handler
    def get_tool_definitions()         # 返回可用工具的 OpenAI schema 列表
```

### 6.2 审批系统（approval.py - 82K）

```python
# 危险命令审批流程
terminal_tool → prompt_dangerous_approval(command)
              → CLI: 通过 prompt_toolkit 弹窗询问用户
              → Gateway: 通过消息平台发送确认按钮
              → cron/子agent: 自动拒绝（默认）或自动批准（配置）
```

### 6.3 安全扫描（tirith_security.py + threat_patterns.py）

- Tirith 安全引擎：命令执行前的多层安全检查
- 威胁模式：注入攻击、路径遍历、凭证泄露检测
- URL 安全：`url_safety.py` 检查 URL 是否为已知恶意地址

### 6.4 工具结果存储（tool_result_storage.py）

工具调用的结果可以通过内容寻址存储，支持跨会话引用（减少重复计算）。

### 6.5 MCP 集成（mcp_tool.py - 177K）

Hermes 可以作为 MCP 客户端连接外部 MCP 服务器，将其工具透明地集成到自己的工具注册表中。MCP 工具以 `mcp-<server_name>` 为 toolset 前缀注册。

---

## 7. 设计模式总结

| 模式 | 说明 | 体现位置 |
|---|---|---|
| **自注册** | 工具模块在 import 时自动注册到中央注册表 | 每个 `tools/*.py` 末尾 |
| **门控检查** | check_fn 决定工具是否对当前会话可用 | terminal_tool, browser_tool, ha_* |
| **冻结快照** | 系统提示词在会话开始时冻结，保护 prompt 缓存 | memory_tool, skills_tool |
| **桥接代理** | 大工具集用 search/describe/call 桥接按需暴露 | tool_search.py |
| **环境抽象** | 统一接口下隐藏多种执行后端 | terminal 的 6 种后端 |
| **线程安全闭锁** | 所有共享状态（注册表、进程表、审批队列）都有线程锁保护 | registry._lock, _active_subagents_lock |
| **代际缓存** | 单调递增计数器支持无锁的 memoization | registry._generation |
| **安全纵深** | 多层防御：schema 层 + check_fn + 审批 + Tirith + 威胁模式 | approval.py + tirith_security.py |
| **上下文隔离** | 子 agent 拥有独立的上下文、文件缓存、终端会话 | delegate_tool |

---

## 8. 与 Claude Code 工具设计的本质差异

| 维度 | Claude Code | Hermes Agent |
|---|---|---|
| 工具数量 | 4 个 | 60+ 个 |
| 注册方式 | 硬编码在 harness 中 | 自注册 + AST 发现 + 插件系统 |
| 可用性控制 | 无（始终可用） | check_fn + 工具集开关 + MCP 动态刷新 |
| 作用域 | 单文件 + 单命令 | 多平台、多会话、跨平台消息 |
| 安全模型 | 用户确认对话框 | 多层：pattern 扫描 + 审批队列 + 安全引擎 |
| 扩展性 | 无插件机制 | 插件 + MCP + 技能系统三层扩展 |
| 记忆 | 无持久记忆（单会话） | MEMORY.md + USER.md + session_search |
| 并发 | 无 | delegate_task 并行子 agent |
| 调度 | 无 | 内置 cron 引擎 |

Hermes 的 4 个"仅有的"工具本质上等于 Claude Code 的 4 个工具（read_file ≈ Read，write_file + patch ≈ Write + Edit，terminal ≈ Bash），但 Hermes 在此之上多出了 50+ 个工具。这个差距来自两个项目的不同定位：Claude Code 是 IDE 内嵌编码助手，Hermes 是全能个人 agent。

---

> 生成日期：2026-06-15
> 分析范围：tools/ 目录全部 .py 文件，model_tools.py，toolsets.py
