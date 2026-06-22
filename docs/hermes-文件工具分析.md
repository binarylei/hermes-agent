# Hermes 文件操作工具实现原理

> 本文档深入分析 Hermes Agent 的 4 个文件操作工具（read_file、write_file、patch、search_files）的实现原理。
> 这是 Hermes 体系中最核心的工具组之一，直接对应 Claude Code 的 Read/Write/Edit 三个工具。

---

## 1. 整体架构

文件工具分为三层：

```
┌─────────────────────────────────────────────────────┐
│ file_tools.py（编排层）                               │
│ - 4 个 handler 函数：_handle_read/write/patch/search │
│ - 4 个顶层入口：read_file_tool / write_file_tool /   │
│   patch_tool / search_tool                           │
│ - 路径解析、安全检查、结果格式化                       │
├─────────────────────────────────────────────────────┤
│ file_operations.py（抽象层）                          │
│ - FileOperations (ABC) 抽象接口                      │
│ - ShellFileOperations：通过 shell 命令实现所有操作    │
│ - 二进制检测、lint 检查、行号格式化                    │
├─────────────────────────────────────────────────────┤
│ fuzzy_match.py + patch_parser.py（算法层）            │
│ - 9 级模糊匹配策略链                                  │
│ - V4A 多文件补丁格式解析                              │
└─────────────────────────────────────────────────────┘
```

### 核心设计洞察

`file_operations.py` 的注释（原文）：

> *The key insight is that all file operations can be expressed as shell commands, so we wrap the terminal backend's execute() interface to provide a unified file API.*

所有文件操作最终都转化为 shell 命令，通过 `terminal_env.execute()` 执行。这意味着文件工具**天然支持所有终端后端**（local、Docker、Modal、SSH、Singularity、Daytona），无需为每个后端写独立的文件操作代码。

---

## 2. 工作路径管理 —— 三层递进式 CWD 解析

文件工具的核心前提是**正确解析文件路径**。Hermes 支持多种运行环境（本地、Docker、SSH、Modal、Daytona 等），每种环境的文件系统视图不同，因此 CWD 管理是一个三层递进式架构。

### 2.1 三层架构总览

```
┌──────────────────────────────────────────────────────────────┐
│ Layer 1: 配置层（config.yaml）                                │
│ terminal.cwd → 桥接 → $TERMINAL_CWD                          │
│ 来源：用户配置 / CLI os.getcwd() / gateway Path.home()        │
├──────────────────────────────────────────────────────────────┤
│ Layer 2: 运行时层（agent/runtime_cwd.py）                     │
│ resolve_agent_cwd() / resolve_context_cwd()                  │
│ 来源：_SESSION_CWD → $TERMINAL_CWD → os.getcwd()             │
├──────────────────────────────────────────────────────────────┤
│ Layer 3: 实时追踪层（BaseEnvironment.cwd）                    │
│ 每次命令后解析 __HERMES_CWD__ 标记更新 self.cwd              │
│ 来源：终端内 agent 执行 cd 的实际结果                          │
└──────────────────────────────────────────────────────────────┘
```

设计原则：**每一层都有自己的回退链，但绝不会跨边界污染。** 沙箱环境的路径永远不会错误地回退到宿主机的 `os.getcwd()`。

### 2.2 Layer 1: 配置层 —— `terminal.cwd` 桥接机制

用户通过 `config.yaml` 的 `terminal.cwd` 配置工作目录。该值通过**桥接机制**写入环境变量 `TERMINAL_CWD`，供下游所有组件读取。

#### CLI 模式（`cli.py` `load_cli_config()`）

```
本地后端：terminal.cwd 默认为 "." → 解析为 os.getcwd()
非本地后端：占位符值（"."/"auto"/"cwd"）被跳过，让终端后端使用沙箱默认值
桥接：将解析后的 cwd 写入 $TERMINAL_CWD
Worktree 模式：同时设置 $TERMINAL_CWD 和 $HERMES_CWD 指向 worktree 路径
```

#### Gateway 模式（`gateway/run.py`）

```
模块导入时读取 config.yaml 并桥接
占位符值回退到 Path.home()
始终导出 $TERMINAL_CWD
```

#### 关键差异

| | CLI | Gateway |
|---|---|---|
| CWD 默认值 | `os.getcwd()` | `Path.home()` |
| 桥接时机 | `load_cli_config()` 调用时 | 模块导入时 |
| 恢复行为 | `os.chdir()` + 设置 `TERMINAL_CWD` | N/A |

### 2.3 Layer 2: 运行时层 —— `agent/runtime_cwd.py`

这是所有 agent 代码的统一 CWD 入口，提供两个函数：

```python
# agent/runtime_cwd.py

def resolve_agent_cwd() -> Path:   # 永不返回 None
    if _SESSION_CWD.get():          # ContextVar，网关多会话隔离
        return Path(_SESSION_CWD.get())
    if os.environ.get("TERMINAL_CWD"):
        return Path(os.environ["TERMINAL_CWD"])
    return Path.cwd()               # 最终兜底

def resolve_context_cwd() -> Path | None:  # 可返回 None
    if _SESSION_CWD.get():
        return Path(_SESSION_CWD.get())
    if os.environ.get("TERMINAL_CWD"):
        return Path(os.environ["TERMINAL_CWD"])
    return None  # 无显式配置时返回 None，避免误用
```

`resolve_context_cwd()` 返回 `None` 的语义是"没有用户明确配置的工作目录"——这对 gateway 模式至关重要，避免把守护进程的安装目录当作上下文根目录。它被 `agent/system_prompt.py` 和 `agent/prompt_builder.py` 用于发现 `AGENTS.md` / `.cursorrules` 等上下文文件。

### 2.4 Layer 3: 实时追踪层 —— 终端环境 CWD

`BaseEnvironment`（`tools/environments/base.py`）在每次命令执行后，通过解析输出中的 `__HERMES_CWD__` 标记来追踪 agent 的实时工作目录。

#### 初始化会话（`init_session()`）

```python
# 伪代码
def init_session(self):
    # 发送 bash：cd 到配置的 cwd，执行 pwd -P
    # 输出中注入 __HERMES_CWD_{session}__ 标记
```

#### 每次命令后更新 CWD

```python
def _update_cwd(self, output):
    # 从 stdout 解析 __HERMES_CWD__ 标记
    # 更新 self.cwd
```

`LocalEnvironment` 额外从磁盘文件读取 CWD（兼容 Windows MSYS 路径转换，将 Git Bash 的 `/c/Users/x` 转为 `C:\Users\x`）。

#### 安全回退（`_resolve_safe_cwd`）

当配置的 cwd 被外部删除时，向上遍历目录树找到最近存在的祖先，最终回退到 `tempfile.gettempdir()`——防止 `Popen(cwd=...)` 抛 `FileNotFoundError`。

### 2.5 file_tools 路径解析 —— 文件工具如何获取工作路径

文件工具（`read_file`、`write_file`、`patch`、`search_files`）通过 `_resolve_path_for_task()` 统一解析路径：

```python
# tools/file_tools.py

def _resolve_path_for_task(filepath, task_id):
    if filepath 是绝对路径:
        return Path(filepath).expanduser().resolve()
    else:
        # 相对路径 → 基于 CWD 解析
        base = _resolve_base_dir(task_id)
        return (base / filepath).resolve()

def _resolve_base_dir(task_id) -> Path:
    # 1. Live terminal cwd（最优先 —— agent cd 到哪里了）
    live = _get_live_tracking_cwd(task_id)
    if live:
        return live

    # 2. $TERMINAL_CWD（仅当是绝对路径且非占位符）
    conf = _configured_terminal_cwd()
    if conf:
        return conf

    # 3. 最终兜底
    return Path.cwd()
```

#### Live CWD 获取（`_get_live_tracking_cwd`）

```python
def _get_live_tracking_cwd(task_id):
    # 检查 file_ops 缓存（ShellFileOperations 记录的 cwd）
    cache_entry = _file_ops_cache.get(task_id)
    if cache_entry and cache_entry.cwd:
        return cache_entry.cwd

    # 检查 _active_environments 注册表（终端环境的实时 cwd）
    from tools.environments.registry import _active_environments
    env_entry = _active_environments.get(task_id)
    if env_entry and hasattr(env_entry, 'cwd'):
        return env_entry.cwd

    return None
```

这个设计保证了 agent 在终端里 `cd /some/deep/path` 之后，`read_file("config.ini")` 能正确找到 `/some/deep/path/config.ini`，而不是回到项目根目录去找。

#### 占位符哨兵机制

```python
_TERMINAL_CWD_SENTINELS = frozenset({"", ".", "./", "auto", "cwd"})
```

这些值在 `_configured_terminal_cwd()` 中被**拒绝**——因为它们是占位符，不代表实际路径。这个机制防止了 worktree-cwd 分歧 bug：在 worktree 模式下，占位符 `"."` 会指向错误的目录。

#### Worktree 分歧检测

当相对路径解析到工作区根目录之外时，`_path_resolution_warning()` 发出警告，提醒 agent 编辑可能落在了错误的 checkout 中。

### 2.6 file_operations —— ShellFileOperations 的 CWD 获取

`ShellFileOperations`（`tools/file_operations.py`）是文件操作的 shell 执行后端，其 CWD 管理分两级：

#### 初始化时

```python
class ShellFileOperations(FileOperations):
    def __init__(self, terminal_env, cwd=None):
        # 优先级：
        self.cwd = (cwd
                    or getattr(terminal_env, 'cwd', None)
                    or getattr(getattr(terminal_env, 'config', None), 'cwd', None)
                    or "/")  # 最后的绝对回退
```

#### 每次执行时（`_exec` 方法）

```python
def _exec(self, cmd, cwd=None, ...):
    # 优先级：
    if cwd:              # 调用方显式传入
        effective_cwd = cwd
    elif self.env.cwd:   # 终端环境的实时 cwd（追踪 cd 的结果）
        effective_cwd = self.env.cwd
    else:
        effective_cwd = self.cwd  # 初始化时的静态回退值

    # 重要：绝不回退到 os.getcwd()！
    # 宿主机的本地路径在容器/云端后端中根本不存在
```

注释明确警告：**"IMPORTANT: do NOT fall back to `os.getcwd()` -- that's the HOST's local path which doesn't exist inside container/cloud backends."**

### 2.7 沙箱环境的路径映射

当脚本在 Docker/SSH/沙箱中运行时，路径与宿主机项目根目录完全不同。Hermes 通过每个终端后端的专用逻辑处理路径映射。

#### Docker 环境（`tools/environments/docker.py`）

```
宿主机:  /home/user/my-project/
           ↓ auto_mount_cwd=True + bind mount
容器内:  /workspace/

启动容器: docker run -w /workspace ...
```

- 宿主机项目目录被 bind mount 到容器的 `/workspace`
- `host_cwd` 被记录在环境配置中，但传给容器的 cwd 被重写为 `/workspace`
- 容器重启时 `self.cwd` 被持久化，新容器用 `-w self.cwd` 恢复工作目录

#### SSH 远程环境

- 默认 cwd 为 `"~"`（而非 `os.getcwd()`）
- 连接后 `init_session()` 会 `cd` 到配置的 cwd 并执行 `pwd -P` 确认

#### 终端工具中的 CWD 解析（`tools/terminal_tool.py`）

```python
def _get_env_config():
    # 各后端默认 cwd：
    #   Local:     _safe_getcwd()
    #   SSH:       "~"
    #   Container: "/root"
    # 然后由 $TERMINAL_CWD 覆盖（如果已设置）

def _resolve_command_cwd(workdir):
    if workdir:              # 显式指定（来自工具调用参数）
        return workdir
    if env.cwd:              # 实时追踪（cd 的结果）
        return env.cwd
    return default_cwd       # 配置默认值
```

#### 容器 cwd 的特殊处理

```python
# 对于 Docker：auto_mount_cwd=True 时
# cwd 被重写为 /workspace，host_cwd 被记住
# 对于其他容器后端：拒绝宿主机的相对 TERMINAL_CWD 值
# 因为 /home/user/projects 在容器内不存在
```

### 2.8 完整调用链

```
config.yaml: terminal.cwd: "/home/user/project"
        ↓ 桥接
$TERMINAL_CWD = "/home/user/project"
        ↓
agent/runtime_cwd.py: resolve_agent_cwd() / resolve_context_cwd()
        ↓
tools/file_tools.py: _resolve_path_for_task("src/main.py", task_id)
        ↓
    1. _get_live_tracking_cwd(task_id)  → agent cd 到哪里了
    2. _configured_terminal_cwd()        → $TERMINAL_CWD（过滤占位符）
    3. os.getcwd()                       → 最终兜底
        ↓
tools/file_operations.py: ShellFileOperations._exec(cmd, ...)
        ↓
    1. 显式 cwd 参数
    2. terminal_env.cwd（实时追踪）
    3. 初始化时的静态 cwd
    4. "/"（最后绝对回退，不是 os.getcwd()！）
```

### 2.9 路径管理的核心不变量

1. **Live cwd 优先于配置 cwd。** agent 在终端里 `cd` 之后，文件工具必须跟随，否则模型的行为与工具的行为不一致。
2. **沙箱环境绝不回退到 `os.getcwd()`。** 宿主机的路径在容器/远程沙箱中不存在，回退只会产生错误。
3. **占位符值被哨兵机制过滤。** `"."`/`"./"`/`"auto"`/`"cwd"` 不是有效路径，必须被拒绝。
4. **worktree 模式显式设置 `TERMINAL_CWD`。** 避免文件操作落在原始 checkout 而非 worktree。
5. **每个 Profile 有独立的 `HERMES_HOME`。** 通过 `get_hermes_home()` 获取，绝不硬编码 `~/.hermes`。

---

## 3. read_file — 文件读取

### 3.1 Schema 定义

```python
READ_FILE_SCHEMA = {
    "name": "read_file",
    "parameters": {
        "path": "string (required)",
        "offset": "integer (1-indexed, default 1, min 1)",
        "limit": "integer (default 500, max 2000)"
    }
}
```

### 3.2 执行流程

```
read_file(path, offset=1, limit=500)
  │
  ├─ 1. 路径解析 _resolve_path_for_task()
  │     - 相对路径 → 基于终端 CWD 解析为绝对路径
  │     - 绝对路径 → expanduser + resolve
  │
  ├─ 2. 设备路径守卫 _is_blocked_device()
  │     - 禁止读取 /dev/zero、/dev/random、/dev/stdin 等
  │     - 禁止读取 /proc/*/fd/[0-2]、/proc/*/environ 等
  │     - 两层检查：路径字面量 + 符号链接解析
  │
  ├─ 3. 结构化文档提取（可选）
  │     - 对 .docx/.xlsx 等格式调用 extract_document_text()
  │     - 提取失败则回退到正常文本路径
  │
  ├─ 4. 二进制检测
  │     - 先查扩展名黑名单（has_binary_extension）
  │     - 再查内容（>30% 非可打印字符 → 二进制）
  │     - 图片文件（.png/.jpg 等）→ 返回 base64 编码
  │
  ├─ 5. 通过 ShellFileOperations.read_file() 读取
  │     - wc -c < path  → 获取文件大小
  │     - head -c 1000  → 采样检测二进制
  │     - sed -n {start},{end}p  → 分页读取
  │
  └─ 6. 输出格式化
       - 添加紧凑行号（{line}|{content} 格式）
       - 超大文件提示 offset+limit 分页读取
       - 文件名不存在时建议相似文件名
```

### 3.3 关键实现细节

**最大读取字符限制：**

```python
_DEFAULT_MAX_READ_CHARS = 100_000   # 可配置：file_read_max_chars
_LARGE_FILE_HINT_BYTES = 512_000    # 超过 512KB 提示分页
```

文件超过 100K 字符时在模型侧截断。截断处给出上下文提示，引导模型用 `offset`/`limit` 参数读取所需部分。这是对上下文窗口的保护——模型不应该一次性读取完整的大文件。

**紧凑行号格式：**

```python
# Hermes 使用紧凑格式：{line}|{content}
# 而非传统格式：   34|{content}（固定宽度填充）
#
# 理由：填充格式每行多消耗 ~48% token
# A/B 测试表明紧凑格式与填充格式功能等价（4/4）
# 但完全去掉行号导致模型手数行号时出现 off-by-one 错误（3/4）
```

**read_file_raw：** 额外提供无分页、无行号、无截断的原始读取模式。用于 `patch` 操作前获取文件完整内容（patch 前必须先读到真实文件内容作为模糊匹配的基准）。

**重复读取检测：** 每个 task_id 维护读取历史，检测连续 4 次相同参数读取时发出警告。

**文件状态追踪：** `tools/file_state.py` 记录每个 task_id 已读取的文件列表和文件修改时间，用于后续 `write_file`/`patch` 时检测外部并发修改。

---

## 4. write_file — 文件写入

### 4.1 Schema 定义

```python
WRITE_FILE_SCHEMA = {
    "name": "write_file",
    "parameters": {
        "path": "string (required)",
        "content": "string (required)",
        "cross_profile": "boolean (default false)"
    }
}
```

### 4.2 执行流程

```
write_file(path, content)
  │
  ├─ 1. 敏感路径检查 _check_sensitive_path()
  │     - 禁止写入 /etc/、/boot/、/usr/lib/systemd/
  │     - 禁止写入 /var/run/docker.sock
  │     - 禁止写入 ~/.hermes/config.yaml（防止修改审批模式）
  │
  ├─ 2. 跨 Profile 软守卫 _check_cross_profile_path()
  │     - 检测写入目标是否属于另一个 Hermes profile
  │     - 检测沙箱镜像目录写入（Docker/Daytona 场景）
  │     - 可通过 cross_profile=True 覆盖
  │
  ├─ 3. 内部状态文本检测
  │     - 拒绝将 read_file 状态文本误写成文件内容
  │
  ├─ 4. 写入前准备
  │     - 保存写入前内容（用于 lint-delta 和 LSP 行移位）
  │     - 检测原始文件换行风格（\n vs \r\n）并保持一致
  │     - 检测原始文件 BOM 标记并保持一致
  │
  ├─ 5. ShellFileOperations.write_file()
  │     - mkdir -p $(dirname path)  → 创建父目录
  │     - cat > path  ← 通过 stdin 管道写入内容
  │       （内容不进入命令行字符串，绕过 ARG_MAX 限制）
  │
  └─ 6. 写入后校验
       ├─ Shell linter（.py→py_compile, .js→node --check）
       ├─ LSP 语义诊断（delta 模式：仅此编辑引入的新错误）
       └─ 外部漂移检测：对比写入前后文件内容
```

### 4.3 关键设计：lint-delta 模式

```python
# 伪代码
def _check_lint_delta(path, pre_content, post_content):
    post_errors = lint(post_content)   # 总是检查新内容
    if is_clean(post_errors):
        return "clean"                 # O(1) — 只检查了新内容
    pre_errors = lint(pre_content)     # 仅在 post 有错误时检查
    new_errors = post_errors - pre_errors  # 仅返回本次编辑引入的错误
    return new_errors
```

这个设计避免了 agent 被文件中已存在的 lint 错误干扰——只报告本次写入**新引入**的问题。

**LSP 层 delta 模式更精细：** 不仅比较错误文本，还通过行移位映射将基线诊断重映射到编辑后坐标，做严格的 range-aware delta。

### 4.4 换行符保留

```python
def _detect_line_ending(sample: str) -> Optional[str]:
    head = sample[:4096]
    if "\r\n" in head:
        return "\r\n"  # Windows
    if "\n" in head:
        return "\n"    # Unix
    return None

def _normalize_line_endings(text: str, target: str) -> str:
    lf_normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    if target == "\r\n":
        return lf_normalized.replace("\n", "\r\n")
    return lf_normalized
```

Hermes 自动检测目标文件的换行风格并保持一致，避免 agent 的工具调用参数（通常为裸 LF）在 Windows 文件上产生混合换行符。

---

## 5. patch — 精确文本替换（最复杂的工具）

### 5.1 双模式设计

patch 工具支持两种模式：

| 模式 | 参数 | 用途 |
|---|---|---|
| `replace` | `path` + `old_string` + `new_string` + `replace_all` | 单文件精确替换 |
| `patch` | `patch`（V4A 格式） | 多文件批量修改 |

### 5.2 replace 模式执行流程

```
patch(mode="replace", path, old_string, new_string)
  │
  ├─ 1. 安全守卫（same as write_file）
  │
  ├─ 2. 读取目标文件完整内容（cat）
  │     - 剥离 UTF-8 BOM（让模糊匹配器处理干净内容）
  │     - 保存原始换行风格
  │
  ├─ 3. fuzzy_find_and_replace(content, old_string, new_string)
  │     这是整篇文档中最精妙的部分，详见 §6
  │
  ├─ 4. 比较新旧内容
  │     - 相同 → 返回空 diff（告诉模型无需编辑）
  │     - 不同 → 通过管道写入新内容（cat > file）
  │
  └─ 5. 生成 unified diff 返回给模型
       - lint-delta 检查
       - LSP 语义诊断
```

### 5.3 patch 模式（V4A 格式）

V4A 是一种多头补丁格式，支持在同一段 patch 文本中修改多个文件：

```
*** Begin Patch
*** Update File: src/main.py
@@ fix import @@
 import os
-from old_module import deprecated
+from new_module import current

*** Add File: src/new_util.py
+#!/usr/bin/env python3
+def helper():
+    return 42

*** Delete File: src/old_util.py
*** Move File: tests/test_old.py -> tests/test_new.py
*** End Patch
```

`patch_parser.py` 将其解析为 `List[PatchOperation]`，然后逐个应用到对应文件。支持 4 种操作类型：Update、Add、Delete、Move。

**安全注意：** V4A 的路径从 patch 内容中提取（非显式参数），攻击面更大。因此对 V4A 路径头做 `..` 遍历拒绝检查——合法的多文件 patch 应使用绝对路径或单层相对路径。

---

## 6. fuzzy_match.py — 9 级模糊匹配策略链

这是 Hermes 文件工具中最精巧的部分。LLM 生成的 `old_string` 经常带有细微的空白/缩进/转义差异，纯精确匹配会导致大量失败。9 级策略链从严格到宽松，逐步放宽匹配条件：

### 6.1 策略链

```
1. exact                → 直接字符串比较
2. line_trimmed         → 逐行去除首尾空白
3. whitespace_normalized→ 将多个空格/tab 折叠为单个空格
4. indentation_flexible → 完全忽略缩进差异
5. escape_normalized    → 将字面量 \n 转换为实际换行
6. trimmed_boundary     → 仅去除首尾行的空白
7. unicode_normalized   → 将智能引号、em dash 等转为 ASCII
8. block_anchor         → 匹配首行+末行，中间用相似度判断
9. context_aware        → 50% 行相似度阈值
```

### 6.2 匹配逻辑

```python
for strategy_name, strategy_fn in strategies:
    matches = strategy_fn(content, old_string)
    if matches:
        if len(matches) > 1 and not replace_all:
            return error("找到 {n} 处匹配，请提供更多上下文")
        
        # 1. 转义漂移检测
        drift_err = _detect_escape_drift(...)
        
        # 2. 缩进重新对齐
        effective_new = _maybe_unescape_new_string(...)
        # 如果匹配策略非 exact，将 new_string 的缩进锚定到文件的真实缩进
        
        # 3. 应用替换
        new_content = _apply_replacements(...)
        return new_content, match_count, strategy_name, None
```

### 6.3 缩进重新对齐（indentation re-anchoring）

当匹配策略不是 `exact` 时（意味着文件中的真实缩进与 LLM 传入的 old_string 不同），`_reindent_replacement()` 自动调整 new_string：

```python
def _reindent_replacement(file_region, old_string, new_string):
    # 1. 找到 old_string 的第一行有意义内容 → LLM 的基准缩进
    old_indent = _leading_whitespace(old_first)
    # 2. 找到文件匹配区域的第一行 → 文件的真实基准缩进
    file_indent = _leading_whitespace(file_first)
    # 3. 计算缩进 delta，将 new_string 的每行缩进重映射
    for line in new_string.split("\n"):
        line_indent = _leading_whitespace(line)
        if line_indent.startswith(old_indent):
            remainder = line[len(old_indent):]
            out_lines.append(file_indent + remainder)
```

### 6.4 转义漂移检测

LLM 在 JSON 工具调用中经常将 `\t` 发送为字面量两个字符 `\t`（反斜杠 + t），而非真正的 tab 字节。Hermes 的处理策略：

- 仅当文件中**实际包含对应控制字符**时，才将 new_string 中的 `\t`/`\r` 转换为真正的控制字符
- 文件中如果有真正的 tab → 转换；如果文件中是字面量 `\t`（如 Python 字符串常量 `sep = "\t"`）→ 不转换

```python
def _maybe_unescape_new_string(new_string, content, matches):
    matched_regions = "".join(content[start:end] for start, end in matches)
    if "\\t" not in new_string and "\\r" not in new_string:
        return new_string  # 快速路径
    out = new_string
    if "\t" in matched_regions:   # 文件中有真正的 tab
        out = out.replace("\\t", "\t")
    if "\r" in matched_regions:   # 文件中有真正的回车
        out = out.replace("\\r", "\r")
    return out
```

### 6.5 转义漂移（Escape Drift）

另一个常见问题：LLM 传入的 `old_string` 和 `new_string` 中可能包含 `\'` 或 `\"`（字面量反斜杠+引号），但这些字符不在目标文件中。这是传输层序列化引入的伪影。

```python
def _detect_escape_drift(content, matches, old_string, new_string):
    for suspect in ("\\'", '\\"'):
        if suspect in new_string and suspect in old_string and suspect not in matched_regions:
            return error("Escape-drift detected: ... "
                         "Re-read the file and pass without backslash-escaping.")
    return None  # 无漂移，继续
```

---

## 7. search_files — 文件搜索

### 7.1 Schema 定义

```python
SEARCH_FILES_SCHEMA = {
    "parameters": {
        "pattern": "string (required) — regex for content, glob for files",
        "target": "enum: content, files (default: content)",
        "path": "string (default: .)",
        "file_glob": "string — file pattern filter, e.g. '*.py'",
        "limit": "integer (default 50, max 200)",
        "offset": "integer (default 0)",
        "output_mode": "enum: content, files_with_matches, count",
        "context": "integer — lines of surrounding context"
    }
}
```

### 7.2 两种搜索模式

**content 模式（grep）：** 使用 `rg`（ripgrep，优先）/ `grep -rn`（回退）搜索文件内容：

```python
if target == "content":
    if has_rg:
        cmd = "rg -n --no-heading --color never -e {pattern} {path}"
    else:
        cmd = "grep -rn {pattern} {path}"
```

**files 模式（find）：** 使用 `find` + glob 匹配文件名：

```python
if target == "files":
    cmd = "find {path} -type f -name '{file_glob}'"
```

### 7.3 结果解析

搜索结果行按格式 `path:line:content` 解析，区分真正的匹配行和 ripgrep 的诊断信息（如 "Permission denied"）：

```python
def _split_tool_diagnostics(output):
    for line in output.split('\n'):
        if line.startswith("rg: ") or line.startswith("grep: "):
            diagnostics.append(line)   # 工具诊断 → 不当作匹配
        elif line == "--" or _SEARCH_OUTPUT_RE.match(line):
            payload.append(line)       # 匹配行或分隔符 → 保留
        else:
            diagnostics.append(line)   # 其余归入诊断
```

### 7.4 重复搜索检测

类似 read_file，search_files 也检测连续重复搜索（相同参数 >= 4 次），触发后提示 agent 调整搜索策略：

```python
search_key = ("search", pattern, target, str(path), file_glob, limit, offset)
if task_data["last_key"] == search_key:
    task_data["consecutive"] += 1
    if task_data["consecutive"] >= 4:
        return warning("Same search repeated N times. "
                       "Try a different pattern or approach.")
```

---

## 8. 安全纵深防线

文件工具的安检从外到内共 5 层：

```
Layer 1: Schema 层
  └─ 参数类型校验（必须是 string/int/bool）

Layer 2: 路径守卫
  ├─ _BLOCKED_DEVICE_PATHS — 禁止读取设备文件
  ├─ _check_sensitive_path — 禁止写入系统路径
  └─ _check_cross_profile_path — 跨 Profile 软拦截

Layer 3: 写拒绝列表
  └─ build_write_denied_paths() — 凭证文件、SSH key 等

Layer 4: 内容扫描
  ├─ _is_internal_file_status_text — 防止误写 read_file 输出
  └─ threat_patterns.first_threat_message — 注入/泄露模式

Layer 5: 外部漂移检测
  └─ 写入前记录文件 mtime/size/hash，写入后对比
     如果并发修改丢失 → 警告并保存原始内容快照
```

---

## 9. 为什么没有 edit_file？

Hermes 没有单独的 `edit_file` 工具，它将"编辑文件"的能力合并到了 `patch` 工具中。

### 9.1 命名差异

| | Claude Code | Hermes |
|---|---|---|
| 工具名 | `Edit` | `patch` |
| 操作模式 | `old_string` → `new_string` | `mode="replace"` 下的 `old_string` → `new_string` |

两者做的是同一件事：**在文件中查找一段文本，替换为另一段文本**。只是命名不同。

### 9.2 为什么叫 patch 而不是 edit？

**1. 强调 diff 返回。** `patch` 的核心设计是"执行替换后返回 unified diff"——让 agent 明确知道自己改了什么。`edit` 这个名字暗示"随便改"，而 `patch` 暗示"精确修改、可审计、可回退"。

**2. 双模式合一。** Hermes 的 `patch` 不只做单文件替换，还支持 V4A 多文件补丁格式。用一个工具覆盖两种场景：

```python
# replace 模式 — 等价于 Claude Code Edit
patch(mode="replace", path="foo.py", old_string="x = 1", new_string="x = 2")

# patch 模式 — V4A 多文件批量修改，Edit 做不到
patch(mode="patch", patch="*** Begin Patch\n*** Update File: foo.py\n...")
```

**3. 生态兼容。** V4A（"Version 4 Agent"）格式是 codex、cline 等 agent 工具链的通用补丁格式。命名为 `patch` 使得 Hermes 能与此生态互通——其他 agent 生成的 V4A patch 可以直接喂给 Hermes 执行。

### 9.3 为什么不用 Claude Code 的 Edit 模型？

Claude Code 的 `Edit` 工具签名很简洁：

```
Edit(file_path, old_string, new_string)
```

但它依赖两个前提：
- **精确匹配：** old_string 必须与文件内容逐字符一致
- **调用方负责唯一性：** 如果 old_string 在文件中出现多次，行为未定义

Hermes 的 `patch` 解决了这两个问题：
- **9 级模糊匹配：** 容忍缩进差异、空白差异、unicode 变体、转义序列等
- **显式唯一性检查：** 如果匹配到多处且未设置 `replace_all=true`，返回明确错误告诉 agent 需要更多上下文

### 9.4 工具数量设计哲学

最后，这是一个设计哲学问题：**是提供更多精准的小工具，还是用更少的工具覆盖更多场景？**

| | Claude Code | Hermes |
|---|---|---|
| 工具数 | 4 个 | 60+ 个 |
| 文件操作 | Read + Write + Edit（3 个） | read_file + write_file + patch + search_files（4 个） |
| 设计哲学 | 极简，每个工具做一件事 | 每个工具更强大，减少 agent 的心智负担 |

Claude Code 选择 3 个极简文件工具。Hermes 虽然整体工具多，但文件操作也只用了 4 个——其中 `patch` 用一个工具覆盖了 Claude Code 的 `Edit` 功能，还额外提供了 V4A 多文件补丁能力。

---

## 10. 与 Claude Code 的对应关系

| Claude Code | Hermes | Hermes 额外能力 |
|---|---|---|
| `Read` | `read_file` | 二进制检测、图片 base64、文档提取(.docx/.xlsx)、重复读取检测、相似文件建议、紧凑行号 |
| `Write` | `write_file` | 写入前后 lint-delta、换行符保留、BOM 保留、LSP 语义诊断、跨 Profile 守卫 |
| `Edit` | `patch` | 9 级模糊匹配、缩进重新对齐、转义漂移检测、V4A 多头补丁、replace_all 批量替换 |
| (无直接对应) | `search_files` | ripgrep 内容搜索 + find 文件搜索、重复搜索检测 |

**本质差异：** Claude Code 的文件工具直接操作本地文件系统；Hermes 的文件工具通过 shell 命令操作**终端后端的文件系统**——这意味着同一套代码支持在本地、Docker 容器、远程 SSH、Modal 云端沙箱中执行文件操作，且安全模型也随之转移（例如在 Docker 后端中，敏感路径检查针对的是容器内路径而非宿主机路径）。

---

> 生成日期：2026-06-15
> 分析范围：tools/file_tools.py、tools/file_operations.py、tools/fuzzy_match.py、tools/patch_parser.py、tools/file_state.py、tools/binary_extensions.py、agent/runtime_cwd.py、tools/terminal_tool.py、tools/environments/base.py、tools/environments/docker.py、tools/environments/local.py、gateway/run.py、cli.py
