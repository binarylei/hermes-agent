# Hermes Agent 整体架构分析

## 一、顶层架构：窄核心 + 广边缘

Hermes 采用 **"窄核心、广边缘"（Narrow Core, Wide Edge）** 的设计哲学。核心 Agent 循环保持精简，大部分能力通过边缘层扩展：

```
        ┌──────────────────────────────────────┐
        │        边缘层（Edge / Wide Rim）       │
        │  CLI / TUI / Gateway / Desktop / Web  │
        │  Plugins / Skills / MCP / Providers   │
        ├──────────────────────────────────────┤
        │        核心层（Core / Waist）          │
        │  AIAgent 循环 / 工具执行 / 状态管理    │
        └──────────────────────────────────────┘
```

---

## 二、目录结构与功能分层

### 第 1 层：核心引擎（~31K 行 Python）

| 文件 | 行数 | 职责 |
|---|---|---|
| `cli.py` | 13,974 | CLI 交互入口，命令路由，配置加载，Rich/prompt_toolkit 终端 UI |
| `run_agent.py` | 5,461 | **Agent 核心循环** — `AIAgent` 类，工具调用循环，对话管理，迭代预算控制 |
| `hermes_state.py` | 4,777 | **状态持久化** — `SessionDB` SQLite + FTS5 全文搜索，会话存储与检索 |
| `model_tools.py` | 1,231 | **工具编排** — `discover_builtin_tools()`、`handle_function_call()`、`get_tool_definitions()`，连接工具注册表与 Agent 循环 |
| `toolsets.py` | 912 | **工具集定义** — `TOOLSETS` 字典，30+ 个工具集（terminal、web、browser、memory 等），按平台组合启用 |
| `batch_runner.py` | 1,321 | 批量轨迹生成并行执行器 |
| `trajectory_compressor.py` | 1,579 | 轨迹压缩（训练数据准备） |
| `mcp_serve.py` | 897 | **MCP 服务器** — 内建 MCP 协议实现 |
| `hermes_constants.py` | 568 | 共享常量，`get_hermes_home()`、`display_hermes_home()` 多 profile 感知路径 |
| `hermes_logging.py` | 536 | 日志基础设施（agent.log / errors.log / gateway.log） |

### 第 2 层：Agent 子系统（`agent/`，116 文件，~65K 行）

| 模块 | 行数 | 职责 |
|---|---|---|
| `conversation_loop.py` | 4,421 | 对话循环 — 消息构建，API 调用，中断处理 |
| `auxiliary_client.py` | 5,950 | 辅助 LLM 客户端（curator、标题生成、搜索等非主循环调用的轻量 LLM 任务） |
| `chat_completion_helpers.py` | 2,682 | OpenAI chat/completions 格式处理 |
| `agent_init.py` | 1,716 | Agent 初始化参数装配（~60 个参数） |
| `agent_runtime_helpers.py` | 2,595 | 运行时辅助（工具调用、消息管理、schema 处理） |
| `context_compressor.py` | 2,426 | **上下文压缩器** — 继承自 `ContextEngine`，唯一允许"修改历史上下文"的机制 |
| `context_engine.py` | — | 上下文引擎基类（插件扩展点） |
| `credential_pool.py` | 2,184 | 凭证池 — 多 API key 轮转 |
| `model_metadata.py` | 2,085 | 模型元数据管理（上下文长度、定价等） |
| `curator.py` | 1,835 | 技能生命周期管理 — 自动归档、使用追踪 |
| `display.py` | 1,033 | CLI 显示动画（KawaiiSpinner 等） |
| `prompt_builder.py` | 1,630 | 系统提示词构建 |
| `tool_executor.py` | 1,428 | 工具执行器 |
| `transports/` | — | LLM 传输层抽象（HTTP、gRPC 等） |

**Provider 适配器**（与 LLM 交互的适配层）：

| 文件 | 行数 | 适配对象 |
|---|---|---|
| `anthropic_adapter.py` | 2,516 | Anthropic Claude API |
| `bedrock_adapter.py` | 1,325 | AWS Bedrock |
| `codex_responses_adapter.py` | 1,271 | OpenAI Codex Responses API |
| `gemini_native_adapter.py` | 1,001 | Google Gemini 原生 API |
| `gemini_cloudcode_adapter.py` | — | Gemini Cloud Code |
| `azure_identity_adapter.py` | — | Azure 托管身份 |

### 第 3 层：工具系统（`tools/`，103 文件）

**设计模式**：`registry.py` 提供中心注册表 `ToolRegistry`，每个工具文件通过 `registry.register()` 自注册，`model_tools.py` 自动发现和加载。

**工具分类**：

| 类别 | 关键文件 | 功能 |
|---|---|---|
| **终端** | `environments/`（11 文件） | 终端后端：本地、Docker、SSH、Modal、Daytona、Singularity |
| **浏览器** | `browser_tool.py`, `browser_cdp_tool.py`, `browser_camofox.py`, `browser_supervisor.py` | 浏览器自动化（CDP 协议 + Camofox 视觉模式） |
| **文件** | `file_tools.py`, `file_operations.py` | 文件读写操作 |
| **搜索** | `session_search_tool.py` | 会话搜索（FTS5） |
| **委托** | `delegate_tool.py` | 子代理委托（leaf/orchestrator 角色模型） |
| **MCP** | `mcp_tool.py`, `mcp_oauth.py`, `mcp_oauth_manager.py` | MCP 客户端集成 |
| **调度** | `cronjob_tools.py` | 定时任务 |
| **看板** | `kanban_tools.py` | 多代理工作队列 |
| **其他** | `code_execution_tool.py`, `image_generation_tool.py`, `homeassistant_tool.py` 等 | 代码执行、图像生成、智能家居等 40+ 工具 |

### 第 4 层：CLI 基础设施（`hermes_cli/`，174 文件，~129K 行）

| 模块 | 行数 | 职责 |
|---|---|---|
| `main.py` | 12,455 | CLI 子命令分发，profile 管理，`_apply_profile_override()` |
| `web_server.py` | 11,899 | Web 仪表盘服务器（FastAPI/uvicorn） |
| `auth.py` | 7,926 | OAuth 认证流程（多 provider） |
| `kanban_db.py` | 7,750 | Kanban SQLite 数据库层 |
| `gateway.py` | 7,048 | 网关启动/管理 CLI |
| `config.py` | 6,572 | 配置管理（DEFAULT_CONFIG、加载、合并、迁移） |
| `commands.py` | — | **斜杠命令注册表** — `COMMAND_REGISTRY`，所有命令的统一定义 |
| `plugins.py` | — | **插件管理器** — `PluginManager`，从 `~/.hermes/plugins/` 和 pip entry points 发现插件 |
| `skin_engine.py` | — | 皮肤/主题引擎 — 数据驱动的 CLI 外观定制 |
| `completion.py` | — | 自动补全（斜杠命令、路径） |
| `curses_ui.py` | — | Curses 交互菜单（工具配置等） |

### 第 5 层：消息网关（`gateway/`，68 文件，~32K 行）

| 模块 | 行数 | 职责 |
|---|---|---|
| `run.py` | 16,661 | **GatewayRunner** — 网关主循环，连接管理，消息分发 |
| `session.py` | 1,444 | 网关会话管理 |
| `config.py` | 2,139 | 网关配置加载 |
| `slash_commands.py` | 3,684 | 网关斜杠命令处理 |
| `stream_consumer.py` | 1,570 | 流式响应消费 |
| `status.py` | 1,049 | 平台连接状态 |

**平台适配器**（`gateway/platforms/`，32 个 Python 文件）：

```
telegram, discord, slack, whatsapp, whatsapp_cloud, signal, matrix,
mattermost, email, sms, dingtalk, wecom, weixin, feishu, qqbot,
bluebubbles, yuanbao, webhook, api_server, homeassistant, ...
```

### 第 6 层：插件系统（`plugins/`，137 文件）

**插件类型**：

| 目录 | 说明 |
|---|---|
| `memory/` | 记忆后端（honcho、mem0、supermemory、byterover、hindsight、holographic、openviking、retaindb — 8 个） |
| `model-providers/` | 模型提供商（alibaba、anthropic、deepseek、gemini、gmi、nvidia、openrouter、xai 等 28 个） |
| `context_engine/` | 上下文引擎插件 |
| `image_gen/` | 图像生成提供商 |
| `kanban/` | 看板 Web UI + systemd 服务 |
| `hermes-achievements/` | 成就系统 |
| `observability/` | 指标/追踪/日志 |
| `spotify/`、`browser/`、`security-guidance/` 等 | 其他扩展 |

### 第 7 层：用户界面（多形态前端）

| 目录 | 技术栈 | 说明 |
|---|---|---|
| `ui-tui/`（346 文件） | TypeScript + Ink（React）+ JSON-RPC | **终端 UI** — `hermes --tui`，Node 渲染界面，Python 运行 Agent |
| `apps/desktop/`（441 文件） | Electron + React + nanostore | **桌面应用** — `@assistant-ui/react`，独立聊天界面 |
| `web/`（98 文件） | React + xterm.js | **Web 仪表盘** — 嵌入 TUI 的 PTY WebSocket 流 |

**TUI 进程模型**：

```
hermes --tui
  └─ Node (Ink React)  ──stdio JSON-RPC──  Python (tui_gateway/)
       │                                         └─ AIAgent + tools + sessions
       └─ 渲染 transcript、composer、activity
```

### 第 8 层：技能系统（`skills/` + `optional-skills/`）

| 目录 | 说明 |
|---|---|
| `skills/`（18 个类别） | 内置技能，默认激活（github、devops、mlops、research 等） |
| `optional-skills/`（18 个类别） | 可选技能，需手动安装（blockchain、security、gaming 等） |

### 第 9 层：基础设施

| 目录 | 职责 |
|---|---|
| `cron/` | 内置定时任务调度器（jobs.py + scheduler.py） |
| `providers/`（2 文件） | Provider 插件注册框架（`register_provider()` + `_discover_providers()`） |
| `acp_adapter/` | ACP 协议适配器（VS Code / Zed / JetBrains 集成） |
| `tests/` | Pytest 测试套件（~17K 测试，~900 文件，子进程隔离） |
| `docs/` | 项目文档（设计、看板、中间件等） |
| `scripts/` | 构建/发布/测试脚本 |
| `website/` | Docusaurus 文档站点 |

---

## 三、核心数据流

```
用户输入（CLI / TUI / Gateway / Desktop）
        │
        ▼
┌───────────────────────────────────────┐
│  HermesCLI / GatewayRunner / TUI GW   │  ← 入口层：命令路由、会话选择
└───────────────────┬───────────────────┘
                    │
                    ▼
┌───────────────────────────────────────┐
│         AIAgent.run_conversation()     │  ← 核心循环
│  while iterations < max:              │
│    response = LLM.chat(messages)      │  ← agent/conversation_loop.py
│    if tool_calls:                     │
│      result = handle_function_call()  │  ← model_tools.py
│      messages.append(result)          │
│    else: return response.content      │
└───────┬───────────────────────────────┘
        │                    │
        ▼                    ▼
┌──────────────┐   ┌───────────────────┐
│  LLM 适配层  │   │  工具系统          │
│  anthropic/  │   │  registry.dispatch│
│  openai/     │   │  ├─ terminal      │
│  gemini/     │   │  ├─ browser       │
│  bedrock/    │   │  ├─ file_tools    │
│  ... 28个    │   │  ├─ delegate      │
│              │   │  ├─ mcp           │
│  transports/ │   │  └─ ... 40+ tools │
└──────────────┘   └───────────────────┘
        │
        ▼
┌───────────────────────────────────────┐
│    hermes_state.py — SessionDB        │
│    SQLite + FTS5 全文索引              │
└───────────────────────────────────────┘
```

---

## 四、关键类与入口点

| 类/函数 | 位置 | 职责 |
|---|---|---|
| `AIAgent` | `run_agent.py:320` | 核心 Agent 类，~60 个初始化参数 |
| `HermesCLI` | `cli.py:3187` | CLI 交互主类，继承 `CLIAgentSetupMixin` + `CLICommandsMixin` |
| `GatewayRunner` | `gateway/run.py:2086` | 网关主类，继承 `GatewayAuthorizationMixin` + `GatewayKanbanWatchersMixin` + `GatewaySlashCommandsMixin` |
| `SessionDB` | `hermes_state.py:657` | SQLite 会话数据库 |
| `ToolRegistry` | `tools/registry.py:151` | 工具注册表 |
| `ContextCompressor` | `agent/context_compressor.py:593` | 上下文压缩器（继承 `ContextEngine`） |
| `ChatConsole` | `cli.py:2914` | 终端聊天控制台 |
| `PluginManager` | `hermes_cli/plugins.py` | 插件发现与管理 |
| `load_cli_config()` | `cli.py:356` | CLI 配置加载 |
| `get_tool_definitions()` | `model_tools.py:272` | 获取当前工具集 schema 列表 |
| `handle_function_call()` | `model_tools.py:876` | 工具调用分发 |
| `discover_plugins()` | `hermes_cli/plugins.py` | 插件自动发现 |
| `discover_builtin_tools()` | `tools/registry.py:57` | 内置工具自动发现 |
| `_discover_providers()` | `providers/__init__.py:140` | LLM Provider 自动发现 |

---

## 五、文件依赖链

```
tools/registry.py  （无依赖 — 被所有工具文件导入）
       ↑
tools/*.py  （每个文件调用 registry.register() 自注册）
       ↑
model_tools.py  （导入 tools/registry + 触发工具发现）
       ↑
run_agent.py, cli.py, batch_runner.py, environments/
```

---

## 六、关键设计特点

1. **Prompt 缓存不侵犯** — 整个对话生命周期内，系统提示词、工具集、消息历史保持字节级稳定（仅 `ContextCompressor` 可修改历史上下文）

2. **工具自动发现** — `tools/*.py` 中任何调用 `registry.register()` 的文件自动被导入，无需手动维护导入列表；但启用工具集仍需在 `toolsets.py` 的 `TOOLSETS` 字典中显式声明

3. **窄腰原则** — 新增核心工具的代价极高（每次 API 调用都发送全量工具 schema），新能力优先走：扩展现有代码 → CLI 命令+技能 → 服务门控工具 → 插件 → MCP 服务器 → 核心工具（最后手段）

4. **Profile 多实例隔离** — 每个 profile 拥有独立的 `HERMES_HOME` 目录，完全隔离配置、API key、会话、技能、网关；`get_hermes_home()` 和 `display_hermes_home()` 自动感知

5. **插件不碰核心** — 插件通过 `ctx.register_tool()`、钩子回调（`pre_tool_call`、`post_llm_call` 等）、ABC 接口扩展，不得修改 `run_agent.py`、`cli.py`、`gateway/run.py` 等核心文件

6. **Provider 插件化** — 28 个 LLM 提供商全部作为插件安装在 `plugins/model-providers/`，`last-writer-wins` 注册策略允许第三方覆盖内置配置

7. **单进程同步循环** — Agent 核心循环是同步的 `while` 循环，通过中断标志 `_interrupt_requested` 和预算控制 `iteration_budget` 管理生命周期

8. **委托是同步的** — `delegate_task` 父代理等待子代理完成后继续；想超越当前 turn 生命周期的工作用 `cronjob` 或 `terminal(background=True)`

9. **缓存感知的斜杠命令** — 修改系统提示词状态的命令默认延迟生效（下次会话），可选 `--now` 立即失效

10. **子进程隔离测试** — 每个测试在独立 Python 子进程中运行（`multiprocessing.get_context("spawn")`），防止模块级状态泄漏
