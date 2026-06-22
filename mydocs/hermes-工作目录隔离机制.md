# Hermes 工作目录隔离机制分析

## 概述

Hermes 通过 **三层 cwd 管理机制** 实现不同粒度的进程/会话/任务级工作目录隔离。这三层从粗到细依次为：`TERMINAL_CWD` 环境变量（进程级）→ `_SESSION_CWD` ContextVar（会话级）→ `_task_env_overrides` 全局字典（任务级）。

---

## 三层机制全景

```
┌─────────────────────────────────────────────────────────────────┐
│                     第 1 层：进程级默认                            │
│                   TERMINAL_CWD 环境变量                           │
│  来源: config.yaml 中 terminal.cwd → 网关/cron 启动时桥接          │
│  作用: 所有终端/文件/代码执行工具的 fallback 默认 cwd                │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                   第 2 层：会话级覆盖                          │ │
│  │               _SESSION_CWD ContextVar                       │ │
│  │  作用: 多会话并发时，每个会话绑定独立 cwd，不互相覆盖            │ │
│  │  技术: contextvars 线程/协程安全，无需锁                       │ │
│  │                                                              │ │
│  │  ┌─────────────────────────────────────────────────────────┐ │ │
│  │  │                 第 3 层：任务级覆盖                        │ │ │
│  │  │         _task_env_overrides 全局字典                      │ │ │
│  │  │  作用: 单次任务/rollout 的环境注入（cwd + 容器镜像）         │ │ │
│  │  │  特点: 绕过 LLM prompt 上下文，零 token 开销                │ │ │
│  │  └─────────────────────────────────────────────────────────┘ │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

---

## 第 1 层：`TERMINAL_CWD` 环境变量

**位置**：`agent/runtime_cwd.py:39-50` — `resolve_agent_cwd()` 函数

**解析优先级**：
```python
def resolve_agent_cwd() -> Path:
    _SESSION_CWD     →  # 第 2 层覆盖
    TERMINAL_CWD     →  # 第 1 层默认
    os.getcwd()         # 兜底: 进程当前目录
```

**设置方和场景**：

| 设置方 | 场景 | 代码位置 |
|--------|------|---------|
| CLI 本地模式 | `hermes` 直接启动，**不设置** TERMINAL_CWD，兜底到启动目录 | — |
| 消息网关 | 网关启动时从 `config.yaml` 的 `terminal.cwd` 桥接 | `gateway/run.py:1128` |
| Cron 调度器 | 定时任务的 `workdir`，直接 `os.environ["TERMINAL_CWD"] = job.workdir` | `cron/scheduler.py:1558` |
| Delegate 子代理 | 从父代理继承 `TERMINAL_CWD` | `tools/delegate_tool.py:708` |

### 消息网关启动时的 TERMINAL_CWD 桥接

```python
# gateway/run.py:1126-1134
_terminal_cfg = _cfg.get("terminal", {})
_terminal_env_map = {
    "backend": "TERMINAL_ENV",
    "cwd": "TERMINAL_CWD",        # ← config.yaml 的 terminal.cwd
    "timeout": "TERMINAL_TIMEOUT",
    ...
}
```

当 `terminal.cwd` 未设置或为占位符（"."、"auto"、"cwd"）时，兜底到 Home 目录：

```python
# gateway/run.py:1331-1334
_configured_cwd = os.environ.get("TERMINAL_CWD", "")
if not _configured_cwd or _configured_cwd in {".", "auto", "cwd"}:
    _fallback = os.getenv("MESSAGING_CWD") or str(Path.home())
    os.environ["TERMINAL_CWD"] = _fallback
```

---

## 第 2 层：`_SESSION_CWD` ContextVar

**位置**：`agent/runtime_cwd.py:20` — `ContextVar("HERMES_SESSION_CWD")`

**设计目的**：解决多会话并发问题。线程/协程安全的 contextvars 机制确保每个会话的 cwd 互不覆盖，无需加锁。

**核心 API**：

| 函数 | 位置 | 作用 |
|------|------|------|
| `set_session_cwd(cwd)` | `runtime_cwd.py:24` | 为当前上下文绑定 cwd |
| `clear_session_cwd()` | `runtime_cwd.py:28` | 清除绑定 |
| `resolve_agent_cwd()` | `runtime_cwd.py:39` | 解析最终 cwd（优先级：Session CWD > TERMINAL_CWD > os.getcwd） |
| `resolve_context_cwd()` | `runtime_cwd.py:53` | 返回 None（CLI 模式）或 Path（网关模式），用于上下文文件查找 |

**使用方**：

| 调用方        | 代码位置                                            | 场景                           |
| ---------- | ----------------------------------------------- | ---------------------------- |
| TUI 网关     | `tui_gateway/server.py`                         | TUI/桌面应用的每个 session 绑定独立 cwd |
| ACP 适配器    | `acp_adapter/session.py`                        | 编辑器的每个窗口 session 绑定项目根目录     |
| CLI resume | `cli.py`, `hermes_cli/cli_agent_setup_mixin.py` | 恢复历史会话时还原当时的 cwd             |
| 消息网关基础设施   | `gateway/session_context.py:135`                | ContextVar 管理框架              |

**关键发现：消息网关平台（飞书、Telegram 等）不使用 `_SESSION_CWD`**

`gateway/run.py` 中的 `set_session_vars()` 调用没有传递 `cwd` 参数：

```python
# gateway/run.py:11873 — cwd 参数默认为空字符串
return set_session_vars(
    platform=context.source.platform.value,
    chat_id=context.source.chat_id,
    ...
    # 注意：没有 cwd= 参数
)
```

这是有意设计 — 消息平台用户通常不与文件系统交互，所有用户共享同一个 `TERMINAL_CWD` 即可，无需 per-user cwd 隔离。

---

## 第 3 层：`_task_env_overrides` 全局字典

**位置**：`tools/terminal_tool.py:949`

**设计目的**：绕过 LLM prompt 上下文，在工具实现层面直接注入 per-task 的环境配置（工作目录、容器镜像），既不占用 prompt token，也不破坏 prompt 缓存。

**核心 API**：

| 函数 | 位置 | 作用 |
|------|------|------|
| `register_task_env_overrides(task_id, overrides)` | `terminal_tool.py:952` | 注册 per-task 环境覆盖 |
| `clear_task_env_overrides(task_id)` | `terminal_tool.py:993` | 任务完成后清理覆盖 |

**隔离键（触发独立容器）**：`frozenset({"docker_image", "modal_image", "singularity_image", "daytona_image", "env_type"})`

这些键在 `_resolve_container_task_id()` 中判断：如果 overrides 中只包含 cwd 而没有隔离键，task_id 折叠为 `"default"`（共享容器）；如果包含隔离键，task_id 保留不变（独立容器）。

```python
# terminal_tool.py:1002-1018
def _resolve_container_task_id(task_id):
    # CWD-only overrides → 折叠到 "default"（共享容器）
    # 包含隔离键的 overrides → 保留 task_id（独立容器）
```

### 4 个调用方

| 调用方 | 代码位置 | 注册内容 | 场景 |
|--------|---------|---------|------|
| ACP 适配器 | `acp_adapter/session.py:134` | `{"cwd": project_root}` | 编辑器项目根目录同步 |
| batch_runner | `batch_runner.py:303-312` | `{docker_image, modal_image, ..., cwd}` | RL 训练数据生成，多容器隔离 |
| TUI 网关（会话） | `tui_gateway/server.py:1134` | `{"cwd": session_cwd}` | TUI/桌面会话 cwd 绑定 |
| TUI 网关（子代理预览） | `tui_gateway/server.py:6869` | `{"cwd": preview_cwd}` | 子代理预览模式 cwd 传递 |

### 3 个消费者

| 工具 | 代码位置 | 读取内容 | 用途 |
|------|---------|---------|------|
| `terminal_tool.py` | 多处 | cwd + 容器镜像 | 终端命令 cwd 解析 + 容器创建决策 |
| `file_tools.py` | `:661-670` | `docker_image`, `singularity_image` 等 | 文件操作需要知道在哪个容器中执行 |
| `code_execution_tool.py` | `:636-641` | `docker_image`, `singularity_image` 等 | 代码执行需要一致的环境隔离 |

---

## Cron 的 `workdir` — 独立路径

Cron 不使用 `register_task_env_overrides`，而是直接设置环境变量：

```python
# cron/scheduler.py:1547-1558
_job_workdir = (job.get("workdir") or "").strip() or None
if _job_workdir:
    os.environ["TERMINAL_CWD"] = _job_workdir
```

**原因**：Cron 的 workdir 作业串行执行（`cron/scheduler.py:169`），不存在并发冲突，直接改环境变量比 ContextVar 或 per-task overrides 更简单直接。

---

## 完整场景矩阵

```
使用场景                     cwd 机制              隔离粒度      并发安全      备注
───────────────────────────────────────────────────────────────────────────────────
CLI 本地 (hermes)           TERMINAL_CWD(空)→cwd   进程级        N/A           单用户本地使用
TUI / 桌面应用              _SESSION_CWD           会话级        ContextVar ✓   Node + Python 双进程
ACP 编辑器集成              _task_env_overrides    编辑器窗口级  全局字典 ✓      cwd-only，共享容器
消息网关 (飞书/Telegram等)  TERMINAL_CWD           网关进程级    单值（共享）    多用户共享 cwd
batch_runner RL训练         _task_env_overrides    rollout级    全局字典 ✓      含容器隔离键
Cron 定时任务               TERMINAL_CWD 直接赋值   任务级       串行执行（安全） workdir 字段
Delegate 子代理             继承父 TERMINAL_CWD     子代理级     同步等待（安全） 父等子完成
Kanban 工作队列             TERMINAL_CWD(继承)      看板进程级    单值（共享）    独立 profile 隔离
```

---

## 设计规律

1. **单用户交互场景**（CLI/TUI/Desktop/ACP）→ 需要 per-session cwd 隔离，因为同一个用户可能同时操作多个项目
2. **多用户消息场景**（飞书/Telegram/Discord 等 32 个平台）→ 共享 cwd，消息平台用户通常不涉及文件系统操作
3. **批量自动化场景**（batch_runner/cron）→ 需要 per-task cwd + 容器镜像隔离，每条 prompt 可能需要不同的软件环境
4. **子代理场景**（delegate/kanban）→ 继承父环境，同步执行不需要额外隔离

## 核心文件索引

| 文件 | 角色 |
|------|------|
| `tools/terminal_tool.py` | `_task_env_overrides` 定义 + `register_task_env_overrides` + `_resolve_container_task_id` |
| `agent/runtime_cwd.py` | `_SESSION_CWD` ContextVar + `resolve_agent_cwd()` |
| `gateway/run.py` | 消息网关 TERMINAL_CWD 桥接 + `set_session_vars()` |
| `gateway/session_context.py` | ContextVar 会话管理基础设施 |
| `acp_adapter/session.py` | ACP 调用 `register_task_env_overrides` |
| `batch_runner.py` | RL 批量训练调用 `register_task_env_overrides` |
| `tui_gateway/server.py` | TUI 调用 `register_task_env_overrides` + `_SESSION_CWD` |
| `cron/scheduler.py` | Cron workdir → TERMINAL_CWD 直接赋值 |
| `tools/delegate_tool.py` | 子代理继承 TERMINAL_CWD |
| `tools/file_tools.py` | 消费 `_task_env_overrides`（容器镜像） |
| `tools/code_execution_tool.py` | 消费 `_task_env_overrides`（容器镜像） |
