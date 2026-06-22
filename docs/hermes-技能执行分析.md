# Hermes 技能执行分析

本文档深入分析 Hermes Agent 中技能（Skill）的完整生命周期，从安装播种、运行时加载、消息构建、脚本使用到执行环境，覆盖全链路。

## 1. 核心概念

### 1.1 Skill 不是程序，是操作手册

**Skill 本身不被"执行"——它被加载为 Agent 的上下文指令。** Hermes 中没有 skill runner 或执行引擎。Skill 的 SKILL.md 内容经过预处理后，作为用户消息注入 Agent 的对话上下文，由 LLM 读取指令后自行决定如何使用终端工具、调用脚本等。

### 1.2 渐进式信息披露（Progressive Disclosure）

Skill 采用三层信息披露架构，最小化 token 消耗：

| 层级 | 内容 | 暴露方式 | Token 消耗 |
|------|------|---------|-----------|
| **Tier 1** | 名称 + 描述（name ≤64 字符, description ≤1024 字符） | 系统提示词索引 + `skills_list` | 极低 |
| **Tier 2** | SKILL.md 完整指令 | `skill_view(name)` 或 `/skill-name` | 中等 |
| **Tier 3** | 链接文件（references/templates/scripts/assets） | `skill_view(name, file_path)` | 按需 |

## 2. 生命周期全景：播种者与收割者

技能的生命周期分为两个独立阶段——**安装时播种**和**运行时收割**——两者通过 `~/.hermes/skills/` 文件系统解耦，互不调用，互不感知。

### 2.1 架构图

```
┌──────────────────────────────────────────────────────────────────┐
│                     INSTALL / UPDATE 阶段                         │
│                                                                  │
│  repo: skills/  ──sync_skills()──▶  ~/.hermes/skills/           │
│  (内置技能源)     manifest 追踪        (用户技能目录)              │
│                                                                  │
│  触发时机:                                                        │
│    - hermes 首次启动 (hermes_cli/main.py:727)                     │
│    - gateway 启动 (gateway/run.py:16323)                         │
│    - hermes update (hermes_cli/main.py:2094)                     │
│    - hermes skills install (从 hub 安装)                          │
│    - hermes profile create (seed_profile_skills)                 │
└──────────────────────────────────────────────────────────────────┘
        │
        │  写入文件到磁盘
        ▼
┌──────────────────────────────────────────────────────────────────┐
│              ~/.hermes/skills/  (唯一共享状态)                     │
│              .bundled_manifest  (来源追踪)                        │
└──────────────────────────────────────────────────────────────────┘
        │                           │
  扫描/读取                          │  扫描/读取
        ▼                           ▼
┌───────────────────┐     ┌──────────────────────────┐
│ skill_commands.py │     │ prompt_builder.py        │
│ scan_skill_       │     │ build_skills_system_     │
│ commands()        │     │ prompt()                 │
│ → /skill-name 映射 │     │ → 系统提示词技能索引       │
└───────────────────┘     └──────────────────────────┘
```

### 2.2 sync_skills：播种者

`sync_skills()` ([tools/skills_sync.py:454](../tools/skills_sync.py#L454)) 负责将仓库中的内置技能安全地同步到用户目录。核心机制是通过 `.bundled_manifest` 文件（v2 格式：`skill_name:origin_hash`）追踪每个技能的来源哈希，实现智能增量更新。

**四种分类处理逻辑**（[tools/skills_sync.py:496-632](../tools/skills_sync.py#L496-L632)）：

| 情况 | manifest | 磁盘 | 判定 | 处理 |
|------|----------|------|------|------|
| **A. 新技能** | 无记录 | — | 首次出现 | 复制到用户目录，记录 origin hash |
| **B. 存量未修改** | 有记录 | 存在，`user_hash == origin_hash` | 用户未定制 | 若内置源有更新则安全覆盖（先备份再复制） |
| **C. 用户已修改** | 有记录 | 存在，`user_hash != origin_hash` | 用户定制过 | **跳过，永久保护** |
| **D. 用户已删除** | 有记录 | 不存在 | 用户主动删除 | 尊重选择，不重新添加 |

**原子更新机制**（[tools/skills_sync.py:586-623](../tools/skills_sync.py#L586-L623)）：
```
复制前:  dest (旧版本)
         ↓ shutil.move()
         dest.bak (备份)
         ↓ shutil.copytree()
         dest (新版本)
         ↓ 成功 → 删除 dest.bak
         ↓ 失败 → 清除不完整的 dest → dest.bak 移回 dest
```

此外还有**孤儿备份恢复**：若上次更新中断留下 `dest.bak` 而 `dest` 丢失，先恢复备份再分类。

**额外过滤**：
- **Curator 抑制列表**（`.curator_suppressed`）：Curator 以 `prune_builtins` 模式归档的内置技能不会被复活
- **退出标记**（`.no-bundled-skills`）：profile 可完全跳过内置技能播种
- **v1 manifest 迁移**：旧版无哈希的 manifest 以用户当前副本为基线，保守不覆盖

### 2.3 运行时：收割者

运行时两个独立子系统从 `~/.hermes/skills/` 读取数据：

| 子系统                       | 入口函数                           | 产出                             | 缓存策略             |
| ------------------------- | ------------------------------ | ------------------------------ | ---------------- |
| `agent/skill_commands.py` | `scan_skill_commands()`        | `/skill-name` → skill_info 映射表 | 进程级 dict，平台切换时重建 |
| `agent/prompt_builder.py` | `build_skills_system_prompt()` | 系统提示词中的技能索引                    | 两级：LRU(8) + 磁盘快照 |

**热重载**（`/reload-skills`）：运行时扫描新技能而不需重启。只更新斜杠命令映射表（`_skill_commands` dict），**不清除系统提示词缓存**——保护 prompt cache 是硬约束。

## 3. 运行时执行流程：7 个关键过程

### 3.1 过程 1：Skill 发现与斜杠命令注册

**入口：** `scan_skill_commands()` [agent/skill_commands.py:263-330](../agent/skill_commands.py#L263-L330)

```python
# 模块级缓存，进程生命周期内有效
_skill_commands: Dict[str, Dict[str, Any]] = {}
```

第一次调用 `get_skill_commands()` 时**懒加载**触发扫描，经过 5 层过滤：

```
文件系统遍历 (~/.hermes/skills/ + external_dirs)
  │
  ├─ 过滤 1: 排除特殊目录 (.git, .github, .archive, .venv, node_modules, ...)
  │     → agent/skill_utils.py:27  EXCLUDED_SKILL_DIRS
  │
  ├─ 过滤 2: 平台兼容性 (platforms: [macos, linux])
  │     → agent/skill_utils.py:128  skill_matches_platform()
  │
  ├─ 过滤 3: 运行时环境 (kanban/docker/s6) — 相关性门控，显式加载可绕过
  │     → agent/skill_utils.py:187  skill_matches_environment()
  │
  ├─ 过滤 4: 同名去重 (本地目录优先于 external_dirs)
  │
  └─ 过滤 5: 用户禁用列表 (skills.disabled in config.yaml)
```

**名称规范化**（[行 315-317](../agent/skill_commands.py#L315-L317)）：

```python
cmd_name = name.lower().replace(' ', '-').replace('_', '-')
cmd_name = _SKILL_INVALID_CHARS.sub('', cmd_name)  # 去掉 +, / 等
cmd_name = _SKILL_MULTI_HYPHEN.sub('-', cmd_name).strip('-')
```

这是为了兼容 Telegram（BotCommand 禁止连字符，只允许下划线）。`/claude-code` 和 `/claude_code` 被统一处理。

### 3.2 过程 2：系统提示词中的技能索引

**入口：** `build_skills_system_prompt()` [agent/prompt_builder.py:1127](../agent/prompt_builder.py#L1127)

**两级缓存**设计：

```
Layer 1: 进程内 LRU 缓存（max 8 entries）
  key = (skills_dir, external_dirs, tools, toolsets, platform, disabled, compact)
  └─ 命中 → 直接返回（零文件 IO）
     未命中 ↓

Layer 2: 磁盘快照 (.skills_prompt_snapshot.json)
  验证：mtime/size manifest → 失效时回退全量扫描
  └─ 命中 → 从 JSON 反序列化，写入 Layer 1
     未命中 ↓

全量文件系统扫描（cold path）
  → 遍历 SKILL.md → parse_frontmatter() → 按 category 分组
  → 生成快照写入磁盘 + 写入 Layer 1
```

**缓存保护的原因**：根据 CLAUDE.md 的设计原则——"Per-conversation prompt caching is sacred"。技能索引在系统提示词中只是一个紧凑列表（`name: description`），约占几百 tokens。

### 3.3 过程 3：斜杠命令分发（两条路径的分叉）

#### CLI 路径

[cli.py:7734-7744](../cli.py#L7734-L7744)：

```python
elif base_cmd in skill_commands:
    user_instruction = cmd_original[len(base_cmd):].strip()
    msg = build_skill_invocation_message(
        base_cmd, user_instruction, task_id=self.session_id
    )
    if msg:
        self._pending_input.put(msg)  # 注入到待处理队列
```

`_pending_input` 是 `queue.Queue()`，由 `process_loop()` [cli.py:12926](../cli.py#L12926) 消费，送入 Agent 循环处理。

#### Gateway 路径

[gateway/run.py:7718-7723](../gateway/run.py#L7718-L7723)：

```python
msg = build_skill_invocation_message(cmd_key, user_instruction, task_id=_quick_key)
if msg:
    event.text = msg   # 直接替换消息文本
    # Fall through to normal message processing
```

Gateway 比 CLI 多一层**平台级禁用检查**（[行 7710-7716](../gateway/run.py#L7710-L7716)），因为 `get_skill_commands()` 的缓存是进程全局的，而一个 gateway 进程可能同时服务多个平台（各自有不同的 `skills.platform_disabled` 配置）。

#### 命令分发优先级

```
1. 内置命令 (/help, /reset, /model, ...)
2. 插件命令
3. Skill 捆绑包 (bundles) — 赢过同名单个 skill
4. 单个 Skill
5. 前缀匹配 (CLI only) — 唯一前缀展开
6. 不可用技能提示 (Gateway only) — 已知但已禁用/未安装的技能
```

### 3.4 过程 4：消息构建（`_build_skill_message`）

**入口：** [agent/skill_commands.py:160-260](../agent/skill_commands.py#L160-L260)

这是整个流程中**逻辑最密集**的函数。调用链：

```
build_skill_invocation_message(cmd_key, user_instruction, task_id)
  │
  ├─ get_skill_commands()[cmd_key]  → skill_info
  ├─ _load_skill_payload(skill_dir)  → skill_view() 返回 JSON
  │     ├─ 绝对路径 → 在受信根目录下解析相对路径（支持符号链接）
  │     └─ 相对路径 → 直接传给 skill_view()
  │
  └─ _build_skill_message(loaded_skill, skill_dir, activation_note, ...)
```

**6 步组装流程**：

```
Step 1: 模板变量替换
  ${HERMES_SKILL_DIR} → 技能目录绝对路径
  ${HERMES_SESSION_ID} → 当前 session ID
  默认开启 (skills.template_vars: true)

Step 2: 内联 Shell 展开
  !`date +%Y-%m-%d` → 命令的实际输出
  默认关闭 (skills.inline_shell: false)
  超时 10s，输出上限 4000 字符
  失败返回 [inline-shell error: ...] 标记

Step 3: 注入技能目录绝对路径
  [Skill directory: /home/user/.hermes/skills/gif-search]
  Resolve any relative paths in this skill against that directory...

Step 4: 注入配置值
  [Skill config (from ~/.hermes/config.yaml):
    gif_search.api_provider = tenor
    gif_search.max_results = 20]

Step 5: 注入 setup 提示
  密钥缺失 → [Skill setup note: Setup needed...]
  Gateway 非交互 → gateway_setup_hint

Step 6: 扫描并列出支持文件
  [This skill has supporting files:]
  - scripts/search.py  ->  /abs/path/scripts/search.py
  - references/api.md  ->  /abs/path/references/api.md
```

**最终消息格式**：

```text
[IMPORTANT: The user has invoked the "gif-search" skill, indicating they want
you to follow its instructions. The full skill content is loaded below.]

<SKILL.md 全文（已预处理）>

[Skill directory: /home/user/.hermes/skills/gif-search]
Resolve any relative paths in this skill against that directory, then run them
with the terminal tool using the absolute path.

[This skill has supporting files:]
- scripts/search.py  ->  /home/user/.hermes/skills/gif-search/scripts/search.py

Load any of these with skill_view(name="gif-search", file_path="<path>"),
or run scripts directly by absolute path
(e.g. `python /home/user/.hermes/skills/gif-search/scripts/search.py`).

The user has provided the following instruction alongside the skill invocation: find cat gifs
```

### 3.5 过程 5：`skill_view()` 工具调用（LLM 主动加载）

**入口：** [tools/skills_tool.py:859-1488](../tools/skills_tool.py#L859-L1488)

当 LLM 通过 tool call 自行加载技能时使用，与斜杠命令不同——这是 LLM 的主动行为：

```
skill_view(name, file_path=None, preprocess=True)
  │
  ├─ 安全验证: _skill_lookup_path_error(name)
  │     ├─ 拒绝绝对路径 (POSIX: /..., Windows: C:\...)
  │     └─ 拒绝路径穿越 (..)
  │
  ├─ 插件技能分发 (name 中包含 ':')
  │     ├─ 解析 namespace:bare
  │     ├─ 检查插件是否禁用
  │     ├─ 读取 SKILL.md
  │     ├─ 平台兼容性 + 注入扫描
  │     ├─ 注入 bundle context（兄弟技能列表）
  │     └─ 预处理（模板 + 内联 shell）
  │
  ├─ 本地技能查找（3 种策略 + 冲突检测）
  │     ├─ Strategy 1: 直接路径 (search_dir / name / SKILL.md)
  │     ├─ Strategy 1b: 分类回退 (plugin fall-through → category/skill)
  │     ├─ Strategy 2: 递归目录名 + frontmatter name 字段
  │     ├─ Strategy 3: 遗留扁平 .md 文件
  │     └─ 多候选冲突 → 拒绝 + 列出所有匹配路径
  │
  ├─ file_path 参数处理
  │     ├─ 路径穿越检测 → 拒绝
  │     ├─ 目录外访问 → validate_within_dir() 拒绝
  │     ├─ 文件不存在 → 列出可用文件（按类型分组）
  │     └─ 二进制文件 → 返回元信息
  │
  ├─ 环境变量检查与密钥捕获
  │     ├─ 收集 required_environment_variables（多源合并）
  │     ├─ 检查 .env + os.getenv() 是否已设置
  │     └─ _capture_required_environment_variables()（三层回退）
  │
  ├─ 沙箱环境变量透传注册
  │     └─ register_env_passthrough() → Docker/SSH/Modal 可访问
  │
  ├─ 凭证文件注册
  │     └─ register_credential_files() → 远程后端挂载
  │
  └─ 返回 JSON
       {success, name, content, description, tags, linked_files,
        setup_needed, readiness_status, ...}
```

**使用量追踪**：`skill_view` 注册为 `_skill_view_with_bump`（[行 1584-1616](../tools/skills_tool.py#L1584-L1616)）。每次成功调用触发 `bump_use()` 和 `bump_view()`，写入 `~/.hermes/skills/.usage.json`。这是 Curator（技能生命周期管理系统）判断技能是否 stale 的数据来源。

### 3.6 过程 6：密钥捕获与环境变量注入

**入口：** `_capture_required_environment_variables()` [tools/skills_tool.py:335-410](../tools/skills_tool.py#L335-L410)

**三层回退机制**：

```
skill_view() 加载 skill
  │
  ├─ 解析 required_environment_variables（多源合并）:
  │     - metadata.hermes.required_environment_variables (新标准)
  │     - prerequisites.env_vars (旧版兼容)
  │     - setup.collect_secrets (交互式收集)
  │
  ├─ 检查是否已设置:
  │     _is_env_var_persisted() → load_env() 读 .env + os.getenv()
  │
  └─ 缺失时的处理:
        │
        ├─ Gateway + 非交互 (HERMES_INTERACTIVE 未设置)
        │     → 返回 gateway_setup_hint
        │       "在 CLI 中加载此 skill 以进行设置，或手动添加到 .env"
        │
        ├─ 无 secret_capture_callback
        │     → 标记为 setup_needed，返回 missing_names
        │
        └─ 有 callback（交互式表面如 TUI/Desktop）
              └─ 逐个弹出密钥输入提示
                    ├─ success → 继续
                    └─ skipped → 加入 remaining_names
```

**沙箱透传**：已设置的技能环境变量通过 `register_env_passthrough()` 注册（[行 1384-1393](../tools/skills_tool.py#L1384-L1393)），确保 Docker/SSH/Modal 等远程后端也能访问。凭证文件通过 `register_credential_files()` 注册以挂载到远程环境（[行 1398-1414](../tools/skills_tool.py#L1398-L1414)）。

### 3.7 过程 7：支持文件（脚本）的发现与使用

**入口：** `_build_skill_message()` 中的支持文件扫描 [agent/skill_commands.py:221-250](../agent/skill_commands.py#L221-L250)

```python
supporting = []
linked_files = loaded_skill.get("linked_files") or {}
for entries in linked_files.values():  # references, templates, scripts, assets
    if isinstance(entries, list):
        supporting.extend(entries)

# 回退：skill_view 没返回 linked_files 时直接扫描目录
if not supporting and skill_dir:
    for subdir in ("references", "templates", "scripts", "assets"):
        subdir_path = skill_dir / subdir
        if subdir_path.exists():
            for f in sorted(subdir_path.rglob("*")):
                if f.is_file() and not f.is_symlink():
                    supporting.append(str(f.relative_to(skill_dir)))
```

**脚本绝不会被自动执行**——它们只是被列出并告知 LLM 可用。LLM 有两个选择：
1. **先读后跑**：`skill_view(name, file_path="scripts/foo.py")` → 读内容 → `terminal` 执行
2. **直接跑**：用绝对路径 `python /path/to/skill/scripts/foo.py`

脚本扩展名白名单（[skills_tool.py:1314](../tools/skills_tool.py#L1314)）：`.py`, `.sh`, `.bash`, `.js`, `.ts`, `.rb`

## 4. 有脚本 Skill vs 无脚本 Skill

**两者的加载流程完全相同**——都是加载 SKILL.md 并注入上下文。区别仅在于 `_build_skill_message()` 的 Step 6 是否产生支持文件列表：

| 维度 | 无脚本 Skill | 有脚本 Skill |
|------|------------|------------|
| **SKILL.md** | 纯指令，Agent 直接按文档操作 | 指令 + 脚本调用说明 |
| **支持文件** | 无 | scripts/ references/ templates/ assets/ |
| **LLM 行为** | 用内置工具（terminal、web_search 等）完成任务 | 可选择执行预置脚本或参考文档 |
| **消息注入** | 仅 SKILL.md 内容 | 额外注入文件列表 + 绝对路径 + 使用说明 |
| **设计本质** | "操作手册" | "操作手册 + 预置工具箱" |

```
┌──────────────────────────────────────┐
│           有脚本 Skill                │
│  SKILL.md   → 指令（何时/如何用脚本）  │
│  scripts/   → 工具（Agent 按需执行）   │
│  references/→ 参考（Agent 按需查阅）   │
│  templates/ → 模板（Agent 可复制修改） │
├──────────────────────────────────────┤
│           无脚本 Skill                │
│  SKILL.md   → 纯指令                 │
└──────────────────────────────────────┘
```

## 5. 路径一致性保证机制

整个链路保证 LLM 生成的路径与本地执行路径一致的三个关键设计：

| 环节 | 机制 | 作用 |
|------|------|------|
| **安装时** | `sync_skills()` 复制到 `~/.hermes/skills/` | 仓库相对路径 → 用户目录绝对路径 |
| **加载时** | `_build_skill_message()` 注入 `[Skill directory: ...]` + 文件列表 | 告知 LLM 技能的绝对路径 |
| **执行时** | LLM 拼接绝对路径 → terminal 执行 | 不依赖 CWD，任何目录都能正确执行 |

### 辅助机制：模板变量 `${HERMES_SKILL_DIR}`

[skill_preprocessing.py:37-60](../agent/skill_preprocessing.py#L37-L60) 支持在 SKILL.md 中使用占位符：

```bash
source ${HERMES_SKILL_DIR}/scripts/gh-env.sh
```

加载时自动替换为实际的绝对路径。默认开启。

### 为什么这个设计好

1. **LLM 和本地执行路径天然一致** — 不需"翻译"过程
2. **不依赖 CWD** — 无论从哪启动 Hermes，脚本都能正确找到
3. **跨后端兼容** — Docker/SSH/Modal 等远程后端，只要技能目录被正确挂载即可
4. **不需要路径映射表** — 不维护"仓库路径 → 运行时路径"的转换逻辑

## 6. 执行环境：默认无沙箱

### 6.1 核心结论

Hermes 的终端默认以 **local** 模式运行，直接在宿主机上执行：

```
LLM 生成命令 → terminal_tool → LocalEnvironment.execute() → subprocess.Popen(bash -c "命令")
```

[local.py:549-617](../tools/environments/local.py) 的 `_run_bash()` 是裸的 `subprocess.Popen`，没有 chroot、namespace 或 cgroup 隔离。`preexec_fn=os.setsid` 的唯一"隔离"是创建新进程组（方便 interrupt 时连带子进程一起 kill）。

### 6.2 6 种执行后端

通过 `TERMINAL_ENV` 切换（[terminal_tool.py:1073](../tools/terminal_tool.py)）：

| 后端 | 隔离级别 | 文件系统 | 默认 CWD |
|------|---------|---------|---------|
| **local** (默认) | 无隔离 | 宿主机 | `os.getcwd()` |
| **docker** | 容器隔离 | 容器内（可挂载 volumes） | `/root` |
| **modal** | 云端沙箱 | Modal 持久化文件系统 | `/root` |
| **ssh** | 远程主机 | 远程主机 | `~` |
| **singularity** | 容器隔离 | 容器内 | `/root` |
| **daytona** | 云端开发环境 | Daytona 工作区 | `/root` |

### 6.3 执行模型：每命令一个独立 bash 进程

[base.py:7](../tools/environments/base.py)：

> Unified spawn-per-call model: every command spawns a fresh `bash -c` process.

两个东西在调用之间持久化：
1. **CWD** — 通过临时文件在调用间持久化（`pwd -P` → 写文件 → Python 读取 → 更新 `self.cwd`）
2. **环境变量快照** — 首次初始化时捕获，每次命令前 source 恢复

### 6.4 环境变量跨命令传递

由于每个 terminal 调用是独立的 bash 进程，普通 `export` 无法跨调用。正确做法：

```bash
# 将 source 和后续使用放在同一个 terminal 调用中
source /home/user/.hermes/skills/github/github-auth/scripts/gh-env.sh && \
  gh api user
```

或将变量写入 `~/.hermes/.env` 实现跨会话持久化。

### 6.5 中间文件路径策略

| 策略           | 示例                                          | 可靠性   | 说明               |
| ------------ | ------------------------------------------- | ----- | ---------------- |
| **技能目录绝对路径** | `/home/user/.hermes/skills/.../output.json` | ✅ 最高  | LLM 已知 skill_dir |
| **CWD 相对路径** | `./output.json`                             | ✅ 高   | CWD 在调用间持久化      |
| **系统临时目录**   | `/tmp/output.json`                          | ⚠️ 中等 | 路径固定但需手动清理       |

## 7. 完整执行时序

```
用户输入 /gif-search cat memes
        │
        ▼
┌─ CLI process_command() ─────────────────────────────────────────────┐
│  1. 解析 base_cmd = "/gif-search"                                  │
│  2. 查找 skill_commands[base_cmd] → 命中                           │
│  3. user_instruction = "cat memes"                                  │
└─────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌─ build_skill_invocation_message("/gif-search", "cat memes") ───────┐
│  4. get_skill_commands() → 取 skill_info                           │
│  5. _load_skill_payload("gif-search")                              │
│     └─ skill_view("gif-search", preprocess=False)                  │
│         ├─ 安全验证（路径穿越、绝对路径）                            │
│         ├─ 3 策略查找 + 冲突检测                                     │
│         ├─ 解析 frontmatter（平台检查、禁用检查）                    │
│         ├─ 环境变量检查 + 密钥捕获                                   │
│         └─ 返回 JSON: {content, linked_files, skill_dir, ...}      │
│  6. _build_skill_message(loaded_skill, skill_dir, activation_note) │
│     ├─ 模板变量替换                                                 │
│     ├─ 内联 shell 展开（如果启用）                                  │
│     ├─ 注入 [Skill directory: /abs/path]                           │
│     ├─ 注入配置值                                                   │
│     ├─ 注入 setup 提示                                              │
│     └─ 列出支持文件（脚本/模板/参考文档）                            │
│  7. bump_use(skill_name) → 写入 .usage.json                        │
└─────────────────────────────────────────────────────────────────────┘
        │
        ▼  格式化的消息文本
┌─ self._pending_input.put(msg) ──────────────────────────────────────┐
│  8. 消息进入待处理队列                                              │
└─────────────────────────────────────────────────────────────────────┘
        │
        ▼  process_loop() 从队列取出
┌─ Agent 循环 (run_agent.py) ─────────────────────────────────────────┐
│  9. 消息作为 user message 注入对话                                  │
│  10. LLM 读取 SKILL.md 指令 + 支持文件列表                          │
│  11. LLM 自主决策：读脚本 → terminal 执行 → 返回结果                 │
└─────────────────────────────────────────────────────────────────────┘
```

## 8. 关键源码索引

| 文件                                                              | 核心函数/内容                                                                                                                              |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| [tools/skills_sync.py](../tools/skills_sync.py)                 | `sync_skills()` — 内置技能同步 + manifest 追踪 + 原子更新                                                                                        |
| [tools/skills_tool.py](../tools/skills_tool.py)                 | `skill_view()`, `skills_list()` — LLM 工具调用入口；`_capture_required_environment_variables()` — 密钥捕获                                      |
| [agent/skill_commands.py](../agent/skill_commands.py)           | `scan_skill_commands()` — 斜杠命令注册；`_build_skill_message()` — 6 步消息组装；`build_skill_invocation_message()` — 用户调用入口                      |
| [agent/skill_preprocessing.py](../agent/skill_preprocessing.py) | `substitute_template_vars()` — `${HERMES_SKILL_DIR}` 替换；`expand_inline_shell()` — `!\`cmd\`` 展开；`preprocess_skill_content()` — 预处理编排 |
| [agent/prompt_builder.py](../agent/prompt_builder.py)           | `build_skills_system_prompt()` — 系统提示词技能索引（两级缓存）                                                                                     |
| [agent/skill_utils.py](../agent/skill_utils.py)                 | `parse_frontmatter()` — YAML 解析；`skill_matches_platform()` — 平台兼容性；`skill_matches_environment()` — 运行时环境匹配                           |
| [agent/skill_bundles.py](../agent/skill_bundles.py)             | Skill 捆绑包（多技能组合调用）                                                                                                                   |
| [cli.py](../cli.py)                                             | CLI 斜杠命令分发；`_pending_input` 队列；`_reload_skills()` 热重载                                                                                |
| [gateway/run.py](../gateway/run.py)                             | Gateway 斜杠命令分发 + 平台级禁用检查                                                                                                             |
| [tools/environments/local.py](../tools/environments/local.py)   | `LocalEnvironment` — 宿主机直接执行，CWD 持久化                                                                                                 |
| [tools/environments/base.py](../tools/environments/base.py)     | `BaseEnvironment` — spawn-per-call 模型                                                                                                |
| [tools/terminal_tool.py](../tools/terminal_tool.py)             | terminal 工具入口，6 种后端，CWD 初始值                                                                                                          |
| [tools/skill_usage.py](../tools/skill_usage.py)                 | 技能使用量追踪 + Curator 抑制列表                                                                                                               |
| [hermes_cli/skills_hub.py](../hermes_cli/skills_hub.py)         | Skills Hub CLI（搜索/浏览/安装/检查）                                                                                                          |
