import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Hermes Agent 代码研究',
  description: 'Hermes Agent 架构、工具系统、技能执行等深度分析文档',
  lang: 'zh-CN',

  // GitHub Pages 部署在 /hermes-agent/ 子路径下
  base: '/hermes-agent/',

  // 文档中 ../agent/xxx.py 等源码链接在站内不存在，跳过死链检查
  ignoreDeadLinks: true,

  // README.md 用作目录说明，不作为文档页面
  srcExclude: ['README.md'],

  themeConfig: {
    // 站点标题（显示在左上角）
    siteTitle: 'Hermes 研究',

    // 顶部导航
    nav: [
      { text: '文档索引', link: '/' },
      { text: 'GitHub', link: 'https://github.com/binarylei/hermes-agent/tree/v2026.6.19' },
    ],

    // 侧边栏
    sidebar: [
      {
        text: '概述',
        items: [
          { text: '文档索引', link: '/' },
        ],
      },
      {
        text: '核心架构',
        collapsed: false,
        items: [
          { text: '整体架构分析', link: '/hermes-整体架构分析' },
          { text: 'AIAgent 架构分析', link: '/hermes-AIAgent架构分析' },
          { text: 'LLM 客户端分析', link: '/hermes-LLM客户端分析' },
          { text: '传输层深度分析', link: '/hermes-传输层深度分析' },
          { text: '上下文压缩机制分析', link: '/hermes-上下文压缩机制分析' },
          { text: '记忆系统分析', link: '/hermes-记忆系统分析' },
        ],
      },
      {
        text: '工具与技能',
        collapsed: false,
        items: [
          { text: '工具系统分析', link: '/hermes-工具系统分析' },
          { text: '工具执行引擎分析', link: '/hermes-工具执行引擎分析' },
          { text: '工具搜索桥接分析', link: '/hermes-工具搜索桥接分析' },
          { text: '文件工具分析', link: '/hermes-文件工具分析' },
          { text: '技能执行分析', link: '/hermes-技能执行分析' },
        ],
      },
      {
        text: '机制分析',
        collapsed: false,
        items: [
          { text: '工作目录隔离机制', link: '/hermes-工作目录隔离机制' },
        ],
      },
      {
        text: 'LiteLLM 对比分析',
        collapsed: false,
        items: [
          { text: '统一提供商接口设计', link: '/litellm/litelllm-统一提供商接口设计' },
          { text: 'OpenAI 客户端请求处理流程', link: '/litellm/litellm-OpenAI客户端请求处理流程' },
          { text: 'Anthropic 客户端请求处理流程', link: '/litellm/litellm-Anthropic客户端请求处理流程' },
          { text: 'Transport/BaseConfig 对比', link: '/litellm/litellm-Hermes与LiteLLM的Transport-BaseConfig对比' },
        ],
      },
    ],

    // 本地搜索
    search: {
      provider: 'local',
    },

    // 社交链接（显示在顶栏右侧）
    socialLinks: [
      { icon: 'github', link: 'https://github.com/binarylei/hermes-agent/tree/v2026.6.19' },
    ],

    // 页脚
    footer: {
      message: '基于 VitePress 构建',
      copyright: 'MIT License',
    },

    // 上下页导航
    docFooter: {
      prev: '上一篇',
      next: '下一篇',
    },

    // 右侧大纲标题
    outline: {
      label: '本页目录',
      level: [2, 3],
    },
  },
})
