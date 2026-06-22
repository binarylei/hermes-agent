# CLAUDE.md

本文件为 Claude Code 在 hermes-agent 代码库中工作提供指导。之后生成的文档均使用中文。

## 核心规则

本项目仅用于学习研究 Hermes Agent 的设计与实现，不进行任何代码修改、功能开发或 bug 修复。

## 项目概述

@AGENTS.md

Hermes Agent 是由 [Nous Research](https://nousresearch.com) 构建的自改进 AI agent。它通过同一套 agent 核心，在 CLI、TUI、消息网关（Telegram、Discord、Slack 等约 20 个平台）和 Electron 桌面应用中运行。

- **语言：** Python 3.11+（上限 <3.14）
- **包管理器：** uv
- **安装脚本：** `./setup-hermes.sh`（Linux/macOS），`install.ps1`（Windows）
- **入口点：** `./hermes`（包装脚本）、`cli.py`、`run_agent.py`、`gateway/`
- **配置：** `cli-config.yaml.example` → 用户配置位于 `~/.hermes/`
- **许可证：** MIT

## 架构

代码库遵循 **窄核心、广边缘** 的设计哲学：

| 目录 | 用途 |
|-----------|---------|
| `cli.py` | CLI 主入口（超大型文件 — 命令路由、配置、设置向导） |
| `run_agent.py` | Agent 循环核心 — 工具执行、对话管理 |
| `hermes_state.py` | 状态持久化、会话管理 |
| `gateway/` | 消息网关（Telegram、Discord、Slack 等） |
| `plugins/` | 插件系统 — 不增加核心负担即可扩展 |
| `skills/` | 内置技能（程序化记忆系统） |
| `tools/` | 工具实现（40+ 个工具） |
| `providers/` | LLM 提供商集成 |
| `web/` | Web 仪表盘 |
| `tui_gateway/` | 终端 UI 网关 |
| `ui-tui/` | 终端 UI 实现 |
| `apps/` | 桌面应用（Electron） |
| `cron/` | 内置定时任务调度器 |
| `tests/` | 测试套件 |
| `hermes-docs/` | 项目文档（设计、看板、中间件等） |
| `mydocs/` | 代码研究后生成的个人文档 |

## 关键文件

| 文件 | 用途 |
|------|---------|
| `cli.py` | CLI 命令路由（650K+，超大型文件，欢迎重构） |
| `run_agent.py` | 核心 agent 循环（250K+） |
| `hermes_state.py` | 状态与会话持久化（210K+） |
| `hermes_constants.py` | 共享常量 |
| `hermes_logging.py` | 日志基础设施 |
| `mcp_serve.py` | MCP 服务器实现 |
| `model_tools.py` | 模型工具定义 |
| `toolsets.py` | 工具集系统 |
| `trajectory_compressor.py` | 轨迹压缩（用于训练） |
| `batch_runner.py` | 批量轨迹生成 |
| `pyproject.toml` | 项目元数据与依赖（精确锁定版本） |
| `AGENTS.md` | AI 编码助手的开发指南 |

## 设计原则

1. **每次对话的 prompt 缓存不可侵犯。** 绝不在对话中途修改历史上下文、切换工具集或重建系统提示词（上下文压缩除外）。
2. **核心是窄腰。** 新增模型工具的代价很高——优先使用 CLI 命令 + 技能、服务门控工具或插件。
3. **扩展而非复制。** 在新增模块之前，先检查现有基础设施是否已覆盖该用例。
4. **行为契约优于快照。** 测试应断言数据间的不变量关系，而非冻结当前值。

## 开发命令

```bash
# 搭建开发环境
./setup-hermes.sh

# 手动搭建
uv venv .venv --python 3.11
source .venv/bin/activate
uv pip install -e ".[all,dev]"

# 运行测试
scripts/run_tests.sh

# 本地运行 Hermes
./hermes
```

## 代码研究文档

对代码库的深入分析和研究笔记存放在 `mydocs/` 目录中。查看 `mydocs/README.md` 获取已有文档的索引。`mydocs/` 内的文件名使用中文，专业英语术语保留。
