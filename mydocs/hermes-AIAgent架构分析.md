# Hermes AIAgent 架构与运行机制分析

> 本文档深入剖析 AIAgent 核心类的架构设计、完整运行机制、与 agent/tools 等模块的分工关系。是 [整体架构分析](hermes-整体架构分析.md) 中第 1-2 层（核心引擎 + agent 子系统）的展开版。

---

## 一、概述

### 1.1 AIAgent 在 Hermes 中的位置

AIAgent 是 Hermes 的**核心引擎**——所有与 LLM 的对话交互，无论入口是 CLI、Telegram、网页还是 TUI，最终都通过这个类完成。

```
cli.py ─────────────┐
gateway/run.py ─────┤
tui_gateway/ ───────┤
batch_runner.py ────┼──→ AIAgent ──→ LLM API
cron/scheduler.py ──┤
delegate_tool.py ───┤  (子代理)
kanban 分发器 ──────┘
        │
        ├──→ 工具执行 (model_tools → tools/)
        ├──→ 会话持久化 (hermes_state.py)
        ├──→ 技能/记忆注入 (skills/, memory_manager)
        └──→ 显示输出 (agent/display.py)
```

### 1.2 AIAgent 作为"中控台"

AIAgent 本身不定义工具、不存储会话、不解析 LLM 协议——它的角色是**编排者**：

```
组装工具 schema → 构建 system prompt → 调用 LLM → 解析响应
    → 分发工具调用 → 注入结果 → 压缩上下文 → 持久化 → 返回回复
```

---

## 二、AIAgent 功能全景

从用户发送一条消息到收到最终回复，AIAgent 内部经历 **10 个环节**：

```
用户消息 "帮我查一下今天的天气"
  │
  ▼
① 初始化 (agent_init.py)
  │  解析配置、凭证、模型、工具集，创建 OpenAI SDK 客户端
  │  agent.tools = get_tool_definitions(["messaging"])
  ▼
② 构建系统提示词 (system_prompt.py + prompt_builder.py)
  │  身份声明 + 技能列表 + 环境提示 + AGENTS.md/CLAUDE.md + 记忆
  ▼
③ 组装 API 调用 (conversation_loop.py)
  │  messages = [system_prompt, ...历史, user_message]
  │  api_kwargs = {model, messages, tools, max_tokens, ...}
  ▼
④ 发起 LLM 请求 (chat_completion_helpers.py)
  │  流式/非流式、中断检测、stale 超时、TTFB 看门狗
  ▼
⑤ 解析响应
  │
  ├── 纯文本 ──────────────────────────┐
  │                                     │
  └── tool_calls: [{terminal, web_search, ...}]  │
        │                               │
        ▼                               │
⑥ 执行工具调用 (tool_executor.py)      │
   串行/并行调度                        │
   审批检查 (write_approval)            │
   护栏检查 (tool_guardrails.py)        │
   结果注入 messages                    │
   回到步骤④（最多 90 轮）              │
        │                               │
        └─────────── 最终文本 ──────────┘
                     │
                     ▼
⑦ 记忆同步 (memory_manager.py)
  │  turn 消息写入记忆 provider
  ▼
⑧ 标题生成 (title_generator.py, 通过 AuxiliaryClient)
  │  新会话自动生成标题
  ▼
⑨ 持久化 (hermes_state.py + JSON 日志)
  │  消息历史 → SessionDB (SQLite FTS5)
  │  轨迹数据 → trajectory_samples.jsonl
  ▼
⑩ 返回最终回复 + 回调通知
```

---

## 三、分层架构——谁负责什么

### 3.1 架构总图

```
┌──────────────────────────────────────────────────────────────┐
│  第一层：入口适配（不参与核心循环）                            │
│  cli.py  gateway/run.py  tui_gateway/  batch_runner  cron   │
│  "接收用户输入，构造参数，创建 AIAgent 实例"                    │
└─────────────────────┬────────────────────────────────────────┘
                      │ AIAgent(base_url=..., model=..., ...)
                      ▼
┌──────────────────────────────────────────────────────────────┐
│  第二层：AIAgent 壳（run_agent.py，~5500 行，持续瘦身）        │
│                                                              │
│  ★ 已拆出的 Forwarder 方法：                                   │
│     __init__            → agent/agent_init.py                │
│     run_conversation    → agent/conversation_loop.py         │
│     _execute_tool_calls → agent/tool_executor.py             │
│     _invoke_tool        → agent/agent_runtime_helpers.py    │
│     _build_system_prompt → agent/system_prompt.py            │
│     _compress_context   → agent/conversation_compression.py  │
│     _sanitize_*         → agent/agent_runtime_helpers.py    │
│                                                              │
│  ★ 仍在壳中的实现：                                            │
│     _create_openai_client    OpenAI SDK 客户端生命周期       │
│     _persist_session         会话持久化编排                    │
│     _build_api_kwargs        组装 API 请求参数                │
│     _interruptible_api_call  可中断的非流式调用                │
│     _emit_status/_notices    状态/警告/费用通知输出            │
│     _toolguard_*             工具护栏（防死循环）              │
│     _dispatch_delegate_task  delegate 参数解包                │
└──────────┬──────────────────────┬───────────────────────────┘
           │                      │
           ▼                      ▼
┌──────────────────────┐  ┌──────────────────────────┐
│  第三层：agent/ 包     │  │  第四层：工具层（独立）     │
│  (80+ 模块, 核心实现)  │  │                          │
│                      │  │  tools/registry.py         │
│  conversation_loop   │  │  tools/*.py (85+ 文件)      │
│  agent_init          │  │  toolsets.py (工具集定义)   │
│  tool_executor       │  │  model_tools.py (编排)      │
│  system_prompt       │  │    get_tool_definitions()  │
│  agent_runtime_helpers│  │    handle_function_call()  │
│  chat_completion_h.* │  │                          │
│  context_compressor  │  │                          │
│  memory_manager      │  │                          │
│  anthropic_adapter   │  │                          │
│  auxiliary_client    │  │                          │
│  ... (共 80+ 模块)    │  │                          │
└──────────┬───────────┘  └──────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────┐
│  第五层：基础设施（独立于 AIAgent）                              │
│  hermes_state.py (SessionDB)  hermes_constants.py            │
│  hermes_logging.py            hermes_cli/config.py           │
│  plugins/ (插件系统)          skills/ (技能系统)              │
│  gateway/ (消息网关)          hermes-cli/ (CLI 工具)          │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 第一层——入口适配

各入口模块负责**接收用户输入并创建 AIAgent**，不参与核心循环逻辑：

| 入口 | 文件 | AIAgent 创建方式 |
|---|---|---|
| CLI 交互 | [cli.py](../cli.py) | `HermesCLI` 构造 AIAgent 实例处理每次用户输入 |
| 消息网关 | [gateway/run.py](../gateway/run.py) | 每个 Telegram/Discord/Slack 会话一个 AIAgent |
| TUI | [tui_gateway/server.py](../tui_gateway/server.py) | JSON-RPC 后端驱动 AIAgent |
| 批量处理 | [batch_runner.py](../batch_runner.py) | 并行创建多个 AIAgent 生成轨迹 |
| 定时任务 | [cron/scheduler.py](../cron/scheduler.py) | cron 触发时创建 AIAgent |
| 子代理 | [tools/delegate_tool.py](../tools/delegate_tool.py) | `_build_child_agent()` 创建子 AIAgent |
| 看板 | [plugins/kanban/](../plugins/kanban/) | 分发器为每个任务创建 AIAgent |

### 3.3 第二层——AIAgent 壳

AIAgent 构造函数接收约 **60 个参数**，大致分为 7 类：

| 类别 | 参数 | 用途 |
|---|---|---|
| 模型/API | `base_url`, `api_key`, `provider`, `api_mode`, `model` | LLM 连接配置 |
| 工具 | `enabled_toolsets`, `disabled_toolsets`, `tool_delay` | 控制工具集可见性 |
| 会话 | `session_id`, `conversation_history`, `skip_memory` | 会话状态管理 |
| 回调 | `stream_delta_callback`, `tool_progress_callback`, `thinking_callback`, `event_callback` 等 10+ | 流式/进度/事件通知 |
| 平台 | `platform` (cli/telegram/discord/...), `user_id`, `chat_id` | 入口平台元数据 |
| 预算 | `max_iterations`, `iteration_budget`, `max_tokens` | 循环与 token 限制 |
| 安全 | `credential_pool`, `service_tier` | 凭证轮转与 tier 控制 |

AIAgent 内部方法分两类：

**已拆出的 Forwarder 方法**（委托给 agent/ 子模块）：

```python
# run_agent.py — 这些方法只是薄壳
def __init__(self, ...):          # → agent/agent_init.py::init_agent()
def run_conversation(self, ...):  # → agent/conversation_loop.py::run_conversation()
def chat(self, msg):              # → self.run_conversation(msg)["final_response"]
def _build_system_prompt(self):   # → agent/system_prompt.py
def _compress_context(self):      # → agent/conversation_compression.py
def _execute_tool_calls(self):    # → agent/tool_executor.py
def _invoke_tool(self):           # → agent/agent_runtime_helpers.py
def _repair_message_sequence(self): # → agent/agent_runtime_helpers.py
def _sanitize_api_messages(self): # → agent/agent_runtime_helpers.py
def _handle_max_iterations(self): # → agent/chat_completion_helpers.py
```

**仍在壳中**的方法（重建 OA 客户端、会话持久化、API 调用细节）：

```python
def _create_openai_client(self)      # OpenAI SDK 客户端创建/共享/复用
def _persist_session(self)           # 会话写入 SQLite + JSON
def _build_api_kwargs(self)          # API 请求参数组装
def _interruptible_api_call(self)    # 非流式 API 调用 + 中断检测
def _interruptible_streaming_api_call(self)  # 流式 API 调用 + 中断检测
def _emit_status/notice/warning(self) # 状态/警告/费用通知输出
def _toolguard_*(self)               # 工具护栏检查与响应
def _dispatch_delegate_task(self)    # delegate_task 参数解包与调用
```

### 3.4 第三层——agent/ 包（80+ 模块）

`agent/` 是真正承担核心逻辑的一层，按职责可分为 **12 个类别**：

#### 3.4.1 对话循环（~260K，最大的单模块）

| 模块 | 大小 | 职责 |
|---|---|---|
| [agent/conversation_loop.py](../agent/conversation_loop.py) | ~258K | **主对话循环**：消息组装 → API 调用 → 流式处理 → 响应解析 → 工具分发 → 重试 → fallback → 上下文压缩触发 |

#### 3.4.2 初始化

| 模块 | 大小 | 职责 |
|---|---|---|
| [agent/agent_init.py](../agent/agent_init.py) | ~91K | 60+ 参数处理、凭证解析、provider 自动检测、context engine 初始化、插件加载、工具脚手架注入 |

#### 3.4.3 运行时工具

| 模块 | 大小 | 职责 |
|---|---|---|
| [agent/agent_runtime_helpers.py](../agent/agent_runtime_helpers.py) | ~118K | 消息序列修复、surrogate 清理、API 消息过滤、OpenAI client 创建与复用、tool_call 参数修复 |
| [agent/chat_completion_helpers.py](../agent/chat_completion_helpers.py) | ~136K | Stream 处理（delta 合并）、reasoning 提取、Codex TTFB 看门狗、空响应恢复 |

#### 3.4.4 工具执行

| 模块                                                                  | 大小   | 职责                                              |
| ------------------------------------------------------------------- | ---- | ----------------------------------------------- |
| [agent/tool_executor.py](../agent/tool_executor.py)                 | ~72K | 工具串行/并行调度、审批流程、护栏检查、委托分发（delegate_task）、工具结果持久化 |
| [agent/tool_dispatch_helpers.py](../agent/tool_dispatch_helpers.py) | ~15K | 工具消息构建、多模态结果处理、破坏性命令检测                          |
| [agent/tool_guardrails.py](../agent/tool_guardrails.py)             | ~18K | 工具调用护栏：检测重复非进展调用、halt 决策                        |

#### 3.4.5 提示词构建

| 模块                                                    | 大小   | 职责                                      |
| ----------------------------------------------------- | ---- | --------------------------------------- |
| [agent/system_prompt.py](../agent/system_prompt.py)   | ~25K | 系统提示词组装：身份、环境 hint、平台感知覆盖               |
| [agent/prompt_builder.py](../agent/prompt_builder.py) | ~89K | 提示词组件：技能列表、AGENTS.md/CLAUDE.md 注入、上下文文件 |

#### 3.4.6 上下文管理

| 模块 | 大小 | 职责 |
|---|---|---|
| [agent/context_compressor.py](../agent/context_compressor.py) | ~119K | 旧消息摘要压缩、token 估算、压缩策略选择 |
| [agent/conversation_compression.py](../agent/conversation_compression.py) | ~45K | 压缩编排：判断触发时机、调用压缩器、结果集成 |

#### 3.4.7 记忆管理

| 模块 | 大小 | 职责 |
|---|---|---|
| [agent/memory_manager.py](../agent/memory_manager.py) | ~38K | 记忆同步：turn 结束后的消息写入、prefetch 预取、上下文注入 |
| [agent/memory_provider.py](../agent/memory_provider.py) | ~13K | MemoryProvider 抽象基类 |

#### 3.4.8 LLM 适配器

| 模块 | 大小 | 适配对象 |
|---|---|---|
| [agent/anthropic_adapter.py](../agent/anthropic_adapter.py) | ~113K | Anthropic Messages API（原生协议） |
| [agent/codex_responses_adapter.py](../agent/codex_responses_adapter.py) | ~63K | OpenAI Codex Responses API |
| [agent/bedrock_adapter.py](../agent/bedrock_adapter.py) | ~55K | AWS Bedrock（boto3） |
| [agent/gemini_native_adapter.py](../agent/gemini_native_adapter.py) | ~38K | Google Gemini 原生 API |
| agent/transports/ | - | 传输层抽象（chat_completions / codex_responses / anthropic_messages / gemini） |

#### 3.4.9 显示与 UI

| 模块 | 大小 | 职责 |
|---|---|---|
| [agent/display.py](../agent/display.py) | ~42K | CLI 显示动画：KawaiiSpinner、工具预览、emoji 映射 |

#### 3.4.10 错误与凭证

| 模块 | 大小 | 职责 |
|---|---|---|
| [agent/error_classifier.py](../agent/error_classifier.py) | ~57K | HTTP 错误分类：可重试 vs 永久、fallback 触发条件 |
| [agent/credential_pool.py](../agent/credential_pool.py) | ~102K | 多 API key 轮转、429 降级、no-credit 检测、从文件重载凭证 |
| [agent/credits_tracker.py](../agent/credits_tracker.py) | ~39K | Token 消耗统计、预算预警 |
| [agent/nous_rate_guard.py](../agent/nous_rate_guard.py) | ~11K | Nous Portal 速率限制门控 |

#### 3.4.11 辅助 LLM 客户端

| 模块 | 大小 | 职责 |
|---|---|---|
| [agent/auxiliary_client.py](../agent/auxiliary_client.py) | ~276K | 非主循环的轻量 LLM 调用：标题生成、视觉分析、上下文压缩、会话搜索、网页提取 |

与 AIAgent 的完整对话循环不同，AuxiliaryClient 是**单次 prompt → completion** 模式，不包含工具调用循环。

#### 3.4.12 其他子系统

| 模块 | 大小 | 职责 |
|---|---|---|
| [agent/model_metadata.py](../agent/model_metadata.py) | ~92K | 模型元数据：context 长度查询、价格、provider 识别 |
| [agent/curator.py](../agent/curator.py) | ~84K | 技能策展：自动审查、归档、备份（后台运行） |
| [agent/background_review.py](../agent/background_review.py) | ~38K | 后台审查：每轮后异步审查技能/记忆质量 |
| [agent/turn_finalizer.py](../agent/turn_finalizer.py) | ~20K | 轮次收尾：记忆同步、标题生成、session 持久化编排 |
| [agent/title_generator.py](../agent/title_generator.py) | ~6K | 对话标题自动生成 |
| [agent/message_sanitization.py](../agent/message_sanitization.py) | ~18K | surrogate 字符清理、消息格式修复 |
| [agent/redact.py](../agent/redact.py) | ~20K | 敏感信息（API key、密码、token）脱敏 |
| [agent/process_bootstrap.py](../agent/process_bootstrap.py) | ~5K | OpenAI 懒加载代理、安全 stdio |
| [agent/iteration_budget.py](../agent/iteration_budget.py) | ~2K | 迭代预算追踪 |
| [agent/coding_context.py](../agent/coding_context.py) | ~32K | 编码上下文（LSP、代码理解） |

### 3.5 第四层——工具层

工具层**完全独立于 AIAgent**——工具只需注册到 registry，不需要知道 AIAgent 的存在。

```
tools/registry.py  ← 注册中心
       ↑
tools/*.py (85+ 文件)  ← 每个文件 register() 1-N 个工具
       ↑
model_tools.py  ← get_tool_definitions() + handle_function_call()
       ↑
toolsets.py  ← 工具集定义（messaging/cli/webhook/kanban...）
       ↑
AIAgent  ← 消费者：拿 schema 传给 LLM，分发结果
```

**AIAgent 使用工具的完整链路**：

```
1. tools/terminal_tool.py → registry.register("terminal", schema, handler)
2. toolsets.py             → "messaging" 工具集包含 "terminal"
3. model_tools.py          → get_tool_definitions(["messaging"]) 返回 schema
4. AIAgent                 → agent.tools = [{"name": "terminal", ...}, ...]
5. AIAgent                 → client.chat.completions.create(tools=agent.tools)
6. LLM 返回                → tool_calls: [{name: "terminal", args: {cmd: "ls"}}]
7. model_tools.py          → handle_function_call("terminal", {cmd: "ls"})
8. tools/terminal_tool.py  → handler → "file1.py\nfile2.py\n"
```

**核心工具集**（[toolsets.py:31-74](../toolsets.py#L31-L74)）：

```python
_HERMES_CORE_TOOLS = [
    # Web
    "web_search", "web_extract",
    # 终端 + 进程
    "terminal", "process",
    # 文件
    "read_file", "write_file", "patch", "search_files",
    # 视觉 + 图像生成
    "vision_analyze", "image_generate",
    # 技能
    "skills_list", "skill_view", "skill_manage",
    # 浏览器 (12 个工具)
    "browser_navigate", "browser_snapshot", "browser_click",
    "browser_type", "browser_scroll", "browser_back",
    "browser_press", "browser_get_images", "browser_vision",
    "browser_console", "browser_cdp", "browser_dialog",
    # 语音
    "text_to_speech",
    # 规划 + 记忆
    "todo", "memory",
    # 会话搜索
    "session_search",
    # 澄清
    "clarify",
    # 代码执行 + 委托
    "execute_code", "delegate_task",
    # 定时任务
    "cronjob",
    # 智能家居 (门控)
    "ha_list_entities", "ha_get_state", "ha_list_services", "ha_call_service",
    # 看板 (门控)
    "kanban_show", "kanban_list", "kanban_complete", "kanban_block",
    "kanban_heartbeat", "kanban_comment", "kanban_create", "kanban_link",
    "kanban_unblock",
    # 计算机使用 (门控, macOS)
    "computer_use",
]
```

**工具集按平台裁剪**：

| 工具集 | 场景 | 与核心工具集的关系 |
|---|---|---|
| `cli` | 命令行 | 核心工具集 - 门控工具 |
| `messaging` | Telegram/Discord/Slack | 核心工具集 - terminal - browser - code_execution |
| `webhook` | Webhook 事件 | 仅 4 个安全工具（web_search, web_extract, vision_analyze, clarify） |
| `kanban` | 看板分发 worker | 核心工具集 + kanban_* 生命周期工具 |

### 3.6 第五层——基础设施

这些模块独立于 AIAgent，提供底层服务：

| 模块 | 职责 | 与 AIAgent 的关系 |
|---|---|---|
| [hermes_state.py](../hermes_state.py) | SessionDB — SQLite + FTS5 全文搜索，会话存储与检索 | 被 `_persist_session()` 调用 |
| [hermes_constants.py](../hermes_constants.py) | `get_hermes_home()`、`display_hermes_home()` 多 profile 感知路径 | 全局使用 |
| [hermes_cli/config.py](../hermes_cli/config.py) | 配置加载、DEFAULT_CONFIG 合并 | 初始化时读取 |
| [hermes_cli/env_loader.py](../hermes_cli/env_loader.py) | `.env` 文件加载 | 模块导入时自动执行 |
| plugins/ | 插件系统 | 初始化时加载 |
| skills/ | 技能系统 | system_prompt 构建时注入 |

---

## 四、核心对话循环详解

### 4.1 完整流程（8 步）

核心循环实现在 [agent/conversation_loop.py](../agent/conversation_loop.py)（~258K），驱动一轮用户消息到最终回复。

```
run_conversation(user_message, system_message, history, task_id)
  │
  ├─ 1. 准备
  │   messages = 构建初始消息列表 [system, ...历史, user]
  │   初始化: api_call_count, _interrupt_requested, _executing_tools
  │   agent.valid_tool_names = [t["function"]["name"] for t in agent.tools]
  │
  ├─ 2. 循环入口 (while api_call_count < max_iterations)
  │   │
  │   │  检查中断: if _interrupt_requested → break
  │   │
  │   ├─ 3. 消息预处理
  │   │   修复 tool_call 参数 (sanitize_tool_call_arguments)
  │   │   清理 strict API 不兼容字段 (_sanitize_tool_calls_for_strict_api)
  │   │   thinking-only 消息清理 (Anthropic 兼容)
  │   │
  │   ├─ 4. 组装 API 调用参数 (_build_api_kwargs)
  │   │   api_kwargs = {model, messages, tools, stream, max_tokens, ...}
  │   │   注入 prompt_cache 断点 (anthropic_prompt_cache_policy)
  │   │   注入 reasoning_config / service_tier / request_overrides
  │   │
  │   ├─ 5. 发起 LLM API 调用
  │   │   │
  │   │   ├── 流式 (_interruptible_streaming_api_call)
  │   │   │   逐 token 推送 delta_callback
  │   │   │   TTFB 看门狗 (Codex)
  │   │   │   stale 超时检测
  │   │   │   stream 掉落检测
  │   │   │
  │   │   └── 非流式 (_interruptible_api_call)
  │   │       单次请求-响应
  │   │       中断标志位轮询
  │   │
  │   ├─ 6. 解析响应
  │   │   │
  │   │   │  处理 incomplete scratchpad (reasoning 被截断)
  │   │   │  处理 Codex "incomplete" finish_reason
  │   │   │  提取 reasoning_content / thinking blocks
  │   │   │  触发 post_api_request 插件 hook
  │   │   │
  │   │   ├── 有 tool_calls ──────────────────┐
  │   │   │                                      │
  │   │   │   验证 tool name 合法性                │
  │   │   │   修复不匹配的 tool name               │
  │   │   │   执行工具调用 (_execute_tool_calls)  │
  │   │   │     ├── 串行 (1-2 个工具)              │
  │   │   │     └── 并行 (独立工具批量)            │
  │   │   │   每个工具:                             │
  │   │   │     → pre_tool_call hook              │
  │   │   │     → 护栏检查 (重复调用检测)           │
  │   │   │     → 审批检查 (write_approval)        │
  │   │   │     → handler 执行                     │
  │   │   │     → post_tool_call hook             │
  │   │   │     → 护栏观察 (append guardrail 提示) │
  │   │   │   注入 tool result 到 messages          │
  │   │   │   api_call_count += 1                  │
  │   │   │   回到步骤 2                            │
  │   │   │                                      │
  │   │   └── 纯文本 (无 tool_calls) ─────────────┘
  │   │       最终回复 = assistant_message.content
  │   │       break (退出循环)
  │   │
  │   └─ 压缩检查
  │       如果 messages 接近 context 上限
  │         → _compress_context ()  → 摘要替换旧消息
  │         → break 当前循环，让用户在新上下文继续
  │
  └─ 7. 收尾 (turn_finalizer.py)
      记忆同步 → memory_manager.sync_turn()
      标题生成 → title_generator (AuxiliaryClient)
      持久化 → _persist_session() → SessionDB + JSON

返回值: {"final_response": str, "messages": list, "api_calls": int, ...}
```

### 4.2 关键状态变量

| 变量 | 作用 | 默认值 |
|---|---|---|
| `self.max_iterations` | 每轮用户消息的最大 tool-calling 循环次数 | 90 |
| `self._iteration_budget` | 跨轮次的迭代预算追踪 | IterationBudget 实例 |
| `self._interrupt_requested` | 中断标志，网关发送 /stop 时设置 | False |
| `self._budget_grace_call` | 预算耗尽后的一次额外调用允许 | True |
| `self.valid_tool_names` | 当前会话可用的工具名列表 | 由 get_tool_definitions 填充 |
| `self._executing_tools` | 是否正在执行工具（控制输出） | False |
| `self._incomplete_scratchpad_retries` | reasoning 被截断时的重试次数 | 最多 2 次 |

### 4.3 错误恢复机制

AIAgent 有三层错误恢复策略：

**第一层：工具调用级修复**
- 空/空白的 tool name → 回退为文本请求（不进入死循环）
- 模型幻觉出的非法 tool name → `_repair_tool_call()` 模糊匹配修复
- 损坏的 JSON arguments → `sanitize_tool_call_arguments()` 尝试修复
- 最多重试 3 次无效工具调用

**第二层：API 调用级恢复**
- HTTP 400/422 → 消息清理后重试（去掉 call_id 等非标准字段）
- HTTP 402 (no credit) → `credential_pool.rotate()` 换 key
- HTTP 429 (rate limit) → jittered 退避重试
- HTTP 5xx → 指数退避重试，最多 5 次
- Stream 中途断开 → 非流式降级重试
- Stale 超时（超过配置的响应时间上限） → 中止 + 重试

**第三层：Provider 级 fallback**
- 当前 provider 反复失败 → 切换到 fallback_model（配置中的备选模型）
- 凭证池全部 exhausted → `FailoverReason.EXHAUSTED_CREDENTIALS` 优雅退出
- 所有 provider 不可用 → 返回部分结果（partial=True）

---

## 五、模块间依赖关系

### 5.1 正式依赖链

```
run_agent.py ──import──→ agent/ ──import──→ tools/ ──import──→ tools/registry.py
     │                      │
     │   (无模块级循环导入)   │
     └──────────────────────┘
```

从 import 角度看，依赖是单向的：

1. `tools/registry.py` — 无内部依赖（最底层）
2. `tools/*.py` — import `tools.registry`
3. `model_tools.py` — import `tools.registry` + `tools.*`
4. `run_agent.py` — import `model_tools` + `agent/*`
5. `agent/*.py` — import 其他 `agent/` 子模块 + `tools/` + `hermes_cli/`
6. `cli.py`, `gateway/run.py`, ... — import `run_agent`

### 5.2 `_ra()` 懒引用模式

**6 个** `agent/` 模块使用了 `_ra()` 懒引用模式：

```python
# agent/agent_init.py  (以及 conversation_loop, system_prompt,
#  agent_runtime_helpers, chat_completion_helpers, tool_executor)
def _ra():
    """Lazy reference to run_agent."""
    import run_agent
    return run_agent
```

**为什么需要这个模式？**

AIAgent 的大规模拆分产生了两个冲突需求：

1. **代码物理迁移**：把 `__init__` 和 `run_conversation` 的 3900+ 行代码搬到 `agent/` 子模块
2. **测试兼容**：~140 个测试文件使用 `mock.patch("run_agent.OpenAI")` / `mock.patch("run_agent.handle_function_call")` 等做 monkeypatch

如果 `agent/` 模块在顶部 `from run_agent import AIAgent`，会拿到模块级的本地引用快照，后续 `mock.patch` 无法生效。`_ra()` 在运行时动态查找 `run_agent` 模块，确保 patch 透传。

```python
# agent/conversation_loop.py — 实际用法
from agent.agent_runtime_helpers import repair_message_sequence  # 正常导入

def run_conversation(agent, user_message, ...):
    # 需要 run_agent 模块级别的符号时
    handle_fn = _ra().handle_function_call      # 运行时查找，patch 透传
    interrupt = _ra()._set_interrupt
```

**它不造成循环导入**，因为 `import run_agent` 在 `_ra()` 函数体内，只在运行时调用时执行——此时 `run_agent.py` 早已加载完毕。

### 5.3 从 God-file 到模块化的演进

重构仍在进行中，分三个阶段：

| 阶段 | 状态 | 描述 |
|---|---|---|
| 1. 物理拆分 | ✅ 基本完成 | 将 ~250K 行从 `run_agent.py` 挪到 `agent/*.py`，保持向后兼容 |
| 2. Forwarder + _ra() | 🔄 当前状态 | AIAgent 方法变薄壳，agent/ 通过 `_ra()` 引用 run_agent 符号 |
| 3. 协议解耦 | ❌ 未开始 | 定义 `ConversationContext` 等协议，让 `agent/` 完全不依赖 `run_agent` |

**当前仍存的耦合问题**：

```python
# ❌ agent/ 模块直接访问 AIAgent 的所有内部属性
def run_conversation(agent, user_message, ...):
    base_url = agent._base_url             # 私有属性
    callback = agent._tool_progress_callback
    session_id = agent.session_id
    model = agent.model
    # ... 几十个属性访问
```

**理想的目标状态**：

```python
# ✅ agent/ 只依赖显式协议，不知道 AIAgent 存在
class ConversationContext(Protocol):
    base_url: str
    model: str
    session_id: str
    tool_progress_callback: Callable | None
    ...

def run_conversation(ctx: ConversationContext, user_message, ...):
    base_url = ctx.base_url
    ...
```

### 5.4 依赖关系图

```
cli.py
gateway/run.py ─────┐
tui_gateway/ ───────┤
batch_runner.py ────┼──→ AIAgent (run_agent.py)
cron/scheduler.py ──┤       │
delegate_tool.py ───┘       ├──→ agent/agent_init.py (__init__)
                            ├──→ agent/conversation_loop.py (主循环)
                            ├──→ agent/system_prompt.py (提示词)
                            ├──→ agent/tool_executor.py (工具执行)
                            ├──→ agent/context_compressor.py (压缩)
                            ├──→ agent/memory_manager.py (记忆)
                            ├──→ agent/auxiliary_client.py (辅助 LLM)
                            ├──→ agent/credential_pool.py (凭证)
                            ├──→ model_tools.py (工具编排)
                            │       └──→ tools/registry.py
                            │           └──→ tools/*.py
                            └──→ hermes_state.py (持久化)
                            
agent/ 模块通过 _ra() 反向引用 run_agent (仅运行时, 非模块级)
```

---

## 六、与其他系统的集成点

### 6.1 LLM Provider 集成

AIAgent 通过 `agent/transports/` 传输层与 LLM 交互：

```
AIAgent
  └─ _interruptible_api_call()
       └─ _create_request_openai_client()
            └─ OpenAI SDK (chat_completions 协议, 16+ provider 共用)
       └─ (流式) _interruptible_streaming_api_call()
            └─ anthropic_adapter.py (Anthropic Messages API 原生协议)
            └─ codex_responses_adapter.py (Codex Responses API)
            └─ bedrock_adapter.py (AWS Bedrock)
            └─ gemini_native_adapter.py (Google Gemini 原生)
```

> 详细分析见 [hermes-LLM客户端分析.md](hermes-LLM客户端分析.md)

### 6.2 工具系统集成

AIAgent 是工具的**消费者**，不定义工具。工具链路的完整流转：

```
注册: tools/terminal_tool.py → registry.register("terminal", ...)
编组: toolsets.py → "messaging" 包含 "terminal"
获取: model_tools.py → get_tool_definitions(["messaging"])
传递: AIAgent → client.chat.completions.create(tools=agent.tools)
执行: model_tools.py → handle_function_call("terminal", {cmd: "ls"})
结果: handler → JSON string → 注入 messages → 继续循环
```

> 详细分析见 [hermes-工具系统分析.md](hermes-工具系统分析.md)

### 6.3 技能系统集成

技能通过 `prompt_builder.py` 注入到系统提示词中：

```
agent/agent_init.py
  └─ agent/prompt_builder.py::build_skills_system_prompt()
       └─ 扫描 ~/.hermes/skills/ 下已安装的技能 SKILL.md
       └─ 格式化技能名称 + 描述 + 使用说明
       └─ 注入到 system prompt 的技能段
```

此过程在 **AI 说话者初始化时** 完成，在一个 session 生命周期中保持不变——这是 "prompt 缓存不可侵犯" 原则的体现。

> 详细分析见 [hermes-技能执行分析.md](hermes-技能执行分析.md)

### 6.4 会话状态集成

AIAgent 通过 [hermes_state.py](../hermes_state.py) 持久化会话：

```python
# 初始化时
self._session_db.create_session(session_id, source="cli", ...)

# 每轮消息后
self._persist_session(messages) → _flush_messages_to_session_db()
  → session_db.append_messages(session_id, new_messages)

# 会话搜索（通过 session_search 工具）
session_db.search(query) → FTS5 全文搜索
```

### 6.5 `hermes_bootstrap.py` — Windows UTF-8 引导

[hermes_bootstrap.py](../hermes_bootstrap.py) 在**所有入口点最顶部**被导入（在 `run_agent.py` 第 26 行），解决 Windows 平台的两个编码问题：

1. 控制台编码页限制（`cp1252` → `print("café")` 崩溃 `UnicodeEncodeError`）
2. 子进程不继承 UTF-8 设置（`subprocess` 启动的沙箱/子代理继承 cp1252）

修复方式：
- `os.environ["PYTHONUTF8"] = "1"` — 所有子进程默认 UTF-8
- `os.environ["PYTHONIOENCODING"] = "utf-8"` — 双保险
- `sys.stdout.reconfigure(encoding="utf-8")` — 当前进程立即生效

Linux/macOS 上不做任何事。

---

## 七、设计特点

### 7.1 窄核心宽边缘

AIAgent 本身保持精简——**每个新增工具都会增加 API 调用成本**（所有工具 schema 随每次请求发送）。Hermes 通过以下方式扩展能力而不膨胀核心：

| 扩展方式 | 代价 | 示例 |
|---|---|---|
| CLI 命令 + 技能 | 零核心开销 | `hermes webhook`, `hermes cron` |
| 服务门控工具 (`check_fn`) | 仅在满足条件时出现 | Home Assistant 工具（需 `HASS_TOKEN`） |
| 插件 | 零核心开销 | memory providers, context engines |
| MCP 服务器 | 零核心开销 | 外部 MCP 工具 |
| 新核心工具 | 每次 API 调用的永久成本 | terminal, browser_navigate 等 |

### 7.2 Prompt 缓存不可侵犯

系统提示词和工具 schema 在会话期间**必须保持字节级不变**。任何中途修改（切换工具集、重载技能、重建提示词）都会导致下游 prompt 缓存失效，使用户的 API 成本倍增。

AIAgent 严格遵守此原则：
- 工具集在 `__init__` 时确定，会话内不变
- 技能列表在 session 开始时注入 system prompt，中途不重载
- 上下文压缩是**唯一**允许修改历史上下文的机制（且压缩后需要重建缓存断点）

### 7.3 Forwarder + `_ra()` 过渡模式

整个 `run_agent.py` 正在从 God-file 向干净分层架构演进。当前使用的 Forwarder + `_ra()` 懒引用模式是过渡态模式，优点是：

- **零行为变化**：拆分不改变任何运行时行为
- **测试兼容**：140+ 个测试的 mock.patch 不受影响
- **渐进式**：可以逐个方法拆出，不需要一次性重构全部

代价是 `agent/` 对 `run_agent` 仍然存在语义耦合（通过 `agent.xxx` 访问 AIAgent 的所有私有属性）。最终需要定义协议接口来消除这种耦合。

### 7.4 AuxiliaryClient 双路径设计

AIAgent 只负责需要工具调用的完整对话循环。对于不需要工具的单次 LLM 调用，Hermes 有独立的 `AuxiliaryClient` 路径：

| 维度 | AIAgent | AuxiliaryClient |
|---|---|---|
| 复杂度 | 完整对话循环 + 工具调用 | 单次 prompt → completion |
| 工具 | 40+ 工具 schema | 无 |
| 配置段 | `config.yaml → model` | `config.yaml → auxiliary.<task>` |
| 使用场景 | 所有用户对话 | 标题生成、视觉分析、压缩、搜索、嵌入 |

两条路径使用相同的 provider 解析链（OpenRouter → Nous Portal → Anthropic → 自定义 → 直接 API），但互不依赖——AuxiliaryClient 不需要 AIAgent 的任何组件。

---

## 相关文档

| 文档 | 关系 |
|---|---|
| [整体架构分析](hermes-整体架构分析.md) | 本文档的上级索引——9 层全景架构 |
| [LLM 客户端分析](hermes-LLM客户端分析.md) | AIAgent 调用的 LLM SDK 与 Provider 体系 |
| [工具系统分析](hermes-工具系统分析.md) | AIAgent 消费的工具的定义、注册与 schema |
| [技能执行分析](hermes-技能执行分析.md) | AIAgent 系统提示词中技能注入的完整链路 |
| [工作目录隔离机制](hermes-工作目录隔离机制.md) | AIAgent 子进程/沙箱的工作目录管理 |
