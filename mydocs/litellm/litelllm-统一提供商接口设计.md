# LiteLLM 统一提供商接口设计

> 关联文档：本文是 [ARCHITECTURE.md](../ARCHITECTURE.md) 第 3 节 "Translation Layer" 的深度展开。ARCHITECTURE.md 告诉你"在哪里改代码"，本文解释"为什么这么设计、整套抽象如何协作"。

---

## 1. 问题定义

LiteLLM 需要支持 100+ LLM 提供商，每个提供商有自己的：

- **请求格式** — OpenAI 用 `messages` 数组，Anthropic 用 `messages` + `system` 顶字段，Cohere 用 `chat_history` + `message`
- **参数映射** — `temperature` 在 OpenAI 叫 `temperature`，在 Anthropic 叫 `temperature`（一致但参数位置不同），`reasoning_effort` 在 Anthropic 侧对应 `thinking` 块
- **响应结构** — OpenAI 返回 `choices[0].message.content`，Anthropic 返回 `content[0].text`，Cohere 返回 `text`
- **流式协议** — SSE、JSON lines、gRPC 各不相同
- **认证方式** — API Key header、AWS SigV4 签名、OAuth token

用户期望一次学习，所有模型通用；维护者期望新增提供商或参数时不触及核心逻辑。两个期望指向同一个架构需求：**所有提供商对上层暴露完全相同的接口**。

---

## 2. 业界常见做法

### 2.1 直接适配器（Ad-hoc Adapter）

每个提供商写一个独立的函数/类，调用方按 model 名 if-else 分发。

```
if provider == "openai":
    return openai_adapter(messages, params)
elif provider == "anthropic":
    return anthropic_adapter(messages, params)
elif ...
```

问题：每加一个提供商就要加一个分支，分发逻辑和适配逻辑耦合，O(n) 遍历。

### 2.2 LangChain 的 BaseChatModel 继承

LangChain 定义 `BaseChatModel` ABC，各提供商继承后实现 `_generate()` / `_stream()`。核心思路也是统一接口，但：

- 每个子类需要自己管理 HTTP 会话、重试、错误处理，模板代码多
- 类型系统依赖 LangChain 自身的 `AIMessage` / `HumanMessage` 体系，与 OpenAI 生态不完全互通

### 2.3 LiteLLM 的选择

LiteLLM 走的是"**以 OpenAI 为规范格式（canonical format），所有人向它对齐**"的路线。原因是：

- OpenAI API 是 LLM 领域的事实标准
- 绝大多数新提供商（Groq、DeepSeek、Fireworks、xAI 等）本身就是 OpenAI 兼容的，接入成本几乎为零
- 上游生态（SDK、工具链、监控）已经围绕 OpenAI 格式构建

---

## 3. LiteLLM 方案：三层抽象

```
用户调用 completion(model="claude-sonnet-4-6", messages=[...], temperature=0.7)
  │
  ├── 接口层：统一签名，OpenAI 参数标准
  │
  ├── 路由层：get_llm_provider() 识别 → ProviderConfigManager 工厂查表
  │
  └── 适配层：BaseConfig ABC → 子类 transform_request() / transform_response()
```

### 3.1 接口层 — `completion()` 统一签名

入口函数 `litellm.main.completion()` 对外暴露的是 **OpenAI 标准参数**（`model`, `messages`, `temperature`, `tools`, `response_format` 等）。用户无论调哪个提供商，传参格式完全一致。

```python
# 两个调用签名完全相同，差异被内部消化
litellm.completion(model="gpt-5", messages=[...], temperature=0.7)
litellm.completion(model="claude-sonnet-4-6", messages=[...], temperature=0.7)
```

### 3.2 路由层 — 自动识别 + 工厂查表

**第一步：`get_llm_provider()` 识别提供商**

`litellm_core_utils/get_llm_provider_logic.py:get_llm_provider()` 负责从 model 名称中解析出 `custom_llm_provider`：

- 前缀匹配：`cohere/command-r` → `cohere_chat`
- 模式匹配：`claude-opus-4-7` → `anthropic`（正则 `^claude-[a-z]+-\d+-\d+`）
- api_base 反查：OpenAI-like 提供商通过 URL hostname 精确匹配（不是子串匹配，防止 SSRF 攻击）
- 查 `model_prices_and_context_window.json` 获取注册信息

**第二步：`ProviderConfigManager` 工厂查表**

`litellm/utils.py:ProviderConfigManager._PROVIDER_CONFIG_MAP` 是一个 **O(1) 字典**，将 `LlmProviders` 枚举映射到对应的 Config 类工厂函数：

```python
_LlmProviders.OPENAI    → lambda: litellm.OpenAIGPTConfig()
_LlmProviders.ANTHROPIC → lambda: litellm.AnthropicConfig()
_LlmProviders.GROQ      → lambda: litellm.GroqChatConfig()
_LlmProviders.COHERE    → lambda model: _get_cohere_config(model)
# ... 100+ 条目
```

没有 if-elif 链，没有遍历，一次字典查找拿到配置实例。

### 3.3 适配层 — `BaseConfig` ABC 体系

这是统一接口的核心。每个提供商实现自己的 Config 子类，覆盖 `BaseConfig` 定义的抽象方法。

#### 继承体系

```
BaseConfig                         ← ABC，定义全部接口契约
  │
  ├── OpenAIGPTConfig              ← OpenAI 的完整实现（也是默认实现）
  │     │
  │     ├── OpenAILikeChatConfig   ← OpenAI 兼容提供商的基础类
  │     │     ├── GroqChatConfig
  │     │     ├── DeepSeekChatConfig
  │     │     ├── XAIChatConfig
  │     │     └── ... (30+ 提供商)
  │     │
  │     ├── CohereChatConfig       ← 完全独立实现（非 OpenAI 兼容）
  │     ├── AnthropicConfig        ← 完全独立实现
  │     ├── VertexAIConfig         ← 完全独立实现
  │     └── ...
  │
  └── (其他独立实现)
```

- **OpenAI 兼容的提供商**（Groq、DeepSeek、Fireworks 等）只需继承 `OpenAILikeChatConfig`，覆盖 0~2 个方法即可接入，因为它们 API 和 OpenAI 同构
- **非 OpenAI 兼容的提供商**（Anthropic、Cohere、Gemini）需要独立实现 `transform_request()` 和 `transform_response()`，做消息格式、参数名、响应结构的双向翻译

#### BaseConfig 定义的抽象方法

| 方法 | 职责 | 方向 |
|---|---|---|
| `transform_request()` | OpenAI 格式 → 提供商 HTTP body | 请求方向 |
| `transform_response()` | 提供商 HTTP response → `ModelResponse` | 响应方向 |
| `validate_environment()` | 校验 api_key / api_base / 额外 headers | 环境准备 |
| `map_openai_params()` | OpenAI 参数 → 提供商等效参数 | 参数映射 |
| `get_supported_openai_params()` | 声明该提供商支持的 OpenAI 参数子集 | 能力声明 |
| `get_error_class()` | 提供商错误 → 统一的 `BaseLLMException` | 错误归一化 |
| `get_complete_url()` | 拼接完整的请求 URL | 端点构造 |
| `sign_request()` | 需要签名的提供商（如 AWS Bedrock）重写 | 认证 |

#### 关键设计决策

**为什么用 ABC 而非 Protocol？**
ABC 提供具体的默认实现（如 `sign_request` 返回原 headers、`translate_developer_role_to_system_role` 做 system 角色映射），子类只覆盖有差异的部分。Protocol 无法提供默认行为。

**为什么 transform_request 是纯函数？**
输入 dict → 输出 dict，无副作用，无状态依赖。这意味着每个 transformation 可以**不发起 HTTP 请求就做单元测试**（见下文 6.2）。

**为什么 ProviderConfigManager 用 lambda 工厂而非直接存实例？**
避免循环导入。Config 类在提供商各自的模块中定义，工厂 lambda 延迟到首次访问时才执行 import。

---

## 4. 类型系统：统一的数模

所有 `transform_response()` 方法的返回类型都是 `ModelResponse`（以及流式的 `ModelResponseStream`）。这套类型定义在 `litellm/types/utils.py` 和 `litellm/types/llms/openai.py` 中，遵循 OpenAI 的类型结构：

```
ModelResponse
  ├── id: str
  ├── choices: List[Choices]
  │     ├── index: int
  │     ├── message: Message
  │     │     ├── role: str
  │     │     ├── content: Optional[str]
  │     │     └── tool_calls: Optional[List[ChatCompletionMessageToolCall]]
  │     └── finish_reason: str
  └── usage: Usage
        ├── prompt_tokens: int
        ├── completion_tokens: int
        └── total_tokens: int
```

`AllMessageValues` 定义了统一的消息类型联合：`ChatCompletionSystemMessage | ChatCompletionUserMessage | ChatCompletionAssistantMessage | ...`，所有提供商在 `transform_request()` 中接收这个类型，自己负责转成提供商的格式。

错误模型 `BaseLLMException` 则统一了 `status_code`、`message`、`headers`、`request`、`response`，无论原始错误是什么形状。

---

## 5. 流式处理抽象

流式响应通过两层抽象统一：

### 5.1 `BaseModelResponseIterator` — 提供商级 chunk 解析

`litellm/llms/base_llm/base_model_iterator.py:BaseModelResponseIterator` 是一个 ABC，定义了 SSEData Iterator → `ModelResponseStream` chunk 的单向转换：

- OpenAI 的 `OpenAIChatCompletionStreamingHandler` 继承它，解析 `data: {"choices": [{"delta": ...}]}` 格式
- Cohere 的 `ModelResponseIterator` 继承它，解析 Cohere 的 `{"text": "...", "finish_reason": "..."}` JSON lines 格式
- 每个提供商返回自己的子类实例

### 5.2 `CustomStreamWrapper` — 用户侧统一迭代器

`litellm/litellm_core_utils/streaming_handler.py:CustomStreamWrapper` 包装了各提供商的原始迭代器（通过 `BaseConfig.get_async_custom_stream_wrapper()` / `get_sync_custom_stream_wrapper()` 获得），向用户暴露统一的 `for chunk in response:` 迭代体验：

- 处理 thinking content 的合并
- 处理特殊 token 的过滤
- 处理 stream_options（是否返回 usage chunk）
- 处理 tool call delta 的累积

```python
# 用户侧 — 无论调哪个提供商，流式用法完全一致
response = litellm.completion(model="claude-sonnet-4-6", messages=[...], stream=True)
for chunk in response:
    print(chunk.choices[0].delta.content)
```

---

## 6. Token 计数抽象

`litellm/llms/base_llm/base_utils.py:BaseTokenCounter` 定义了 `count_tokens()` ABC。各提供商实现自己的计数逻辑：

- OpenAI 用 tiktoken
- Anthropic 用其原生 token counting API
- 其他 OpenAI 兼容提供商可以复用 OpenAI 的计数器

`BaseLLMModelInfo.get_token_counter()` 是工厂方法，返回提供商对应的 `BaseTokenCounter` 实例。这保证了 cost 计算和 token 统计的一致性。

---

## 7. 一次完整调用的源码路径

以下是 `completion()` 从入口到返回 `ModelResponse` 的完整调用链：

```
1. litellm/main.py:completion(model, messages, temperature, ...)
   │  用户传入 OpenAI 标准参数
   │
2. litellm/main.py:L5278 → get_llm_provider(model, custom_llm_provider, ...)
   │  解析出 custom_llm_provider = "anthropic"
   │
3. litellm/utils.py:ProviderConfigManager.get_provider_chat_config(model, provider)
   │  从 _PROVIDER_CONFIG_MAP 查表拿到 AnthropicConfig 实例
   │
4. litellm/utils.py:get_optional_params(...)
   │  从 kwargs 中筛选出该提供商支持的可选参数
   │
5. anthropic_config.validate_environment(headers, model, messages, ...)
   │  校验 api_key、构造 Anthropic 专用 headers (x-api-key, anthropic-version)
   │
6. anthropic_config.map_openai_params(non_default_params, optional_params, model, drop_params)
   │  temperature → temperature, reasoning_effort → thinking 块, response_format → tools
   │
7. anthropic_config.transform_request(model, messages, optional_params, litellm_params, headers)
   │  将 OpenAI messages 转为 Anthropic 的 {messages, system, ...} JSON body
   │
8. BaseLLMHTTPHandler.completion() → HTTP POST https://api.anthropic.com/v1/messages
   │  发送 HTTP 请求
   │
9. anthropic_config.transform_response(model, raw_response, model_response, ...)
   │  将 Anthropic 的 {content: [{type:"text", text:"..."}]} 转为 ModelResponse
   │
10. 返回统一的 ModelResponse 对象
```

对于流式调用，步骤 8-9 替换为：

```
8'. BaseLLMHTTPHandler.completion() → streaming HTTP POST
9'. anthropic_config.get_async_custom_stream_wrapper() → CustomStreamWrapper
10'. 返回 CustomStreamWrapper，用户 for chunk in response
```

---

## 8. 总结

LiteLLM 的统一接口设计围绕一个原则：**OpenAI 是规范格式，所有提供商适配到这个格式**。实现上通过三层抽象（接口层 → 路由层 → 适配层）+ 两套 ABC（`BaseConfig` 做请求/响应转换，`BaseTokenCounter` 做 token 计数）将 100+ 提供商的差异收敛到各自的 `transformation.py` 文件中。

关键设计优势：

- **零侵入路由**：O(1) 工厂查表替代 if-elif 链
- **单文件隔离**：每个提供商的适配逻辑在自己的 `transformation.py` 中，互不影响
- **纯函数可测**：`transform_request` / `transform_response` 是纯函数，不发起 HTTP 即可单元测试
- **继承复用**：OpenAI 兼容提供商几乎零代码接入，非兼容提供商仅需实现 `transform_request` / `transform_response`
