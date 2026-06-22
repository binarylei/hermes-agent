---
layout: home

hero:
  name: "Hermes Agent"
  text: "代码研究文档"
  tagline: 对 Hermes Agent 源码的架构分析、工具剖析、技能执行等深度研究笔记
  actions:
    - theme: brand
      text: 开始阅读
      link: /hermes-整体架构分析
    - theme: alt
      text: 查看源码
      link: https://github.com/NousResearch/hermes-agent

features:
  - icon: 🏗️
    title: 架构分析
    details: 整体架构、目录结构、功能分层、核心数据流与设计模式
  - icon: 🔧
    title: 工具系统
    details: 60+ 工具全景、Core Tools 深度剖析、与 Claude Code 对比
  - icon: ⚡
    title: 技能执行
    details: 完整生命周期分析、运行时关键过程、消息构建机制
---

## 文档索引

| 文档 | 描述 | 日期 |
|------|------|------|
| [整体架构分析](/hermes-整体架构分析) | Hermes 整体架构分析：目录结构、功能分层（9 层）、核心数据流、关键类与入口点、设计特点 | 2026-06-18 |
| [LLM 客户端分析](/hermes-LLM客户端分析) | Hermes LLM 客户端架构：SDK 选型（openai/anthropic/boto3）、Provider 插件系统（28 个）、Transport 传输层、API 调用全链路 | 2026-06-17 |
| [工具系统分析](/hermes-工具系统分析) | Hermes 工具系统全景分析：60+ 工具总览、设计原则、核心工具深度剖析、与 Claude Code 对比 | 2026-06-15 |
| [文件工具分析](/hermes-文件工具分析) | Hermes 文件操作工具全景分析：工作路径管理机制（三层 CWD 架构 + 沙箱路径映射）+ 4 个文件工具深度剖析 | 2026-06-15 |
| [技能执行分析](/hermes-技能执行分析) | Hermes 技能完整生命周期分析：sync_skills 播种机制、7 个运行时关键过程、消息构建 6 步组装、有/无脚本执行差异、路径一致性保证、执行环境分析 | 2026-06-18 |
| [工作目录隔离机制](/hermes-工作目录隔离机制) | Hermes 工作目录隔离机制：三层 cwd 管理（TERMINAL_CWD → _SESSION_CWD → _task_env_overrides）、6 大使用场景矩阵、ACP/batch_runner/TUI/Cron 调用链分析 | 2026-06-18 |

---

## 关于本项目

本目录存放对 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 代码库进行深入研究后生成的分析文档。

Hermes Agent 是由 [Nous Research](https://nousresearch.com) 构建的自改进 AI agent，通过同一套 agent 核心在 CLI、TUI、消息网关（Telegram、Discord、Slack 等约 20 个平台）和 Electron 桌面应用中运行。

> 此目录由 AI 辅助生成文档时使用，不作为项目正式文档的一部分。
