# mydocs — 代码研究文档

本目录存放对 hermes-agent 代码库进行深入研究后生成的文档。

## 文档索引

| 文档 | 描述 | 日期 |
|------|------|------|
| [hermes-工作目录隔离机制.md](hermes-工作目录隔离机制.md) | Hermes 工作目录隔离机制：三层 cwd 管理（TERMINAL_CWD → _SESSION_CWD → _task_env_overrides）、6 大使用场景矩阵、ACP/batch_runner/TUI/Cron 调用链分析 | 2026-06-18 |
| [hermes-整体架构分析.md](hermes-整体架构分析.md) | Hermes 整体架构分析：目录结构、功能分层（9层）、核心数据流、关键类与入口点、设计特点 | 2026-06-18 |
| [hermes-AIAgent架构分析.md](hermes-AIAgent架构分析.md) | Hermes AIAgent 核心架构与运行机制：分层架构（5层）、10 环节流水线、agent/ 包 80+ 模块分工、依赖关系与重构演进 | 2026-06-22 |
| [hermes-工具系统分析.md](hermes-工具系统分析.md) | Hermes 工具系统全景分析：60+ 工具总览、设计原则、核心工具深度剖析、与 Claude Code 对比 | 2026-06-15 |
| [hermes-工具执行引擎分析.md](hermes-工具执行引擎分析.md) | Hermes 工具执行引擎深度分析：tool_executor/tool_dispatch_helpers/tool_guardrails 三文件协作、串行/并发调度决策、18 种分发分支、环路检测守卫、与 LLM 配合机制 | 2026-06-22 |
| [hermes-工具搜索桥接分析.md](hermes-工具搜索桥接分析.md) | Hermes 工具搜索桥接深度分析：渐进式工具暴露机制、三元桥接设计（tool_search/tool_describe/tool_call）、BM25 检索目录、双层调度解包、与 MCP 协议对比 | 2026-06-22 |
| [hermes-文件工具分析.md](hermes-文件工具分析.md) | Hermes 文件操作工具全景分析：工作路径管理机制（三层 CWD 架构 + 沙箱路径映射）+ 4 个文件工具深度剖析 | 2026-06-15 |
| [hermes-技能执行分析.md](hermes-技能执行分析.md) | Hermes 技能完整生命周期分析：sync_skills 播种机制、7 个运行时关键过程、消息构建 6 步组装、有/无脚本执行差异、路径一致性保证、执行环境分析 | 2026-06-18 |
| [hermes-LLM客户端分析.md](hermes-LLM客户端分析.md) | Hermes LLM 客户端架构：SDK 选型（openai/anthropic/boto3）、Provider 插件系统（28个）、Transport 传输层、API 调用全链路 | 2026-06-17 |

## 用途

- 记录对代码架构、模块实现、设计模式的分析
- 保存关键代码路径的跟踪笔记
- 整理依赖关系、数据流和调用链
- 归档研究过程中发现的非显而易见的细节

> 此目录由 AI 辅助生成文档时使用，不作为项目正式文档的一部分。
