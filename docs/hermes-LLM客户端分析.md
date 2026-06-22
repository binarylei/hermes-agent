# Hermes LLM 客户端架构

> 本文档深入分析 Hermes Agent 的 LLM 客户端实现方案：SDK 选型、Provider 插件系统、Transport 传输层、API 调用全链路。
> 核心结论：Hermes 没有用 litellm，而是自建 provider 抽象层 + 三个官方 SDK（openai、anthropic、boto3）的架构。

---

## 1. 整体架构总览

Hermes 采用**多 SDK、多传输层**架构，分三层：

```
┌──────────────────────────────────────────────────────────────┐
│ Provider 插件层 (plugins/model-providers/)                   │
│ 28 个 provider 插件，每个声明 ProviderProfile 元数据          │
│ api_mode / base_url / auth_type / build_extra_body()         │
├──────────────────────────────────────────────────────────────┤
│ Transport 传输层 (agent/transports/)                         │
│ 4 种 api_mode → 4 个 ProviderTransport 子类                  │
│ 负责消息格式转换、工具定义转换、响应归一化                      │
├──────────────────────────────────────────────────────────────┤
│ SDK 客户端层 (agent/agent_runtime_helpers.py)                │
│ create_openai_client() → OpenAI SDK (主力，16+ provider)      │
│ build_anthropic_client() → Anthropic SDK (懒加载)            │
│ boto3 → AWS Bedrock SDK                                      │
│ CopilotACPClient / GeminiNativeClient → 自定义客户端          │
└──────────────────────────────────────────────────────────────┘
```

**核心设计决策：**

- **主力 SDK**：`openai==2.24.0`（基础安装），绝大多数 provider 共用 OpenAI Python SDK
- **特殊 SDK**：`anthropic==0.87.0`（可选、懒加载），仅用于原生 Anthropic Messages API
- **不用 litellm**：自建 provider 抽象层，避免引入中间聚合层

---

## 2. 依赖选型

### 2.1 核心依赖（`pyproject.toml`）

| 依赖 | 版本 | 用途 |
|------|------|------|
| `openai` | `==2.24.0` | **主力 SDK**，chat_completions / codex_responses 协议 |
| `httpx` | `==0.28.1` | 底层 HTTP（OpenAI SDK 内部也用它） |
| `requests` | `==2.33.0` | 部分非流式路径使用 |

### 2.2 可选依赖

| 依赖 | 版本 | 用途 | 加载方式 |
|------|------|------|---------|
| `anthropic` | `==0.87.0` | Anthropic Messages API | `tools/lazy_deps.py` 首次使用时动态安装 |
| `boto3` | — | AWS Bedrock Converse API | 按需 |

### 2.3 明确不用的方案

| 方案 | 原因 |
|------|------|
| **litellm** | 不想引入中间聚合层，自建 provider 抽象更可控 |
| **aiohttp** | 仅 messaging/slack/homeassistant 等消息网关 extra 使用，核心 agent 不用 |

---

## 3. Provider 插件层

### 3.1 ProviderProfile 数据结构

每个 LLM 后端通过 `ProviderProfile` dataclass（`providers/base.py`）声明元数据：

```python
@dataclass
class ProviderProfile:
    name: str              # 标准名称（如 "deepseek"）
    aliases: tuple         # 别名（如 ("ds",)）
    api_mode: str          # 传输协议：chat_completions | anthropic_messages | codex_responses | bedrock_converse
    env_vars: dict         # 凭证环境变量名
    base_url: str          # 默认 API 端点
    auth_type: str         # api_key | oauth_device_code | oauth_external | copilot | aws_sdk
    default_headers: dict  # 客户端级别 HTTP 头

    # 以下为 per-provider 请求定制钩子
    def build_extra_body(self, args, agent) -> dict: ...
        # OpenRouter provider preferences, Gemini thinking_config, 等

    def build_api_kwargs_extras(self, args, agent) -> dict: ...
        # Kimi reasoning_effort, DeepSeek extra_body.thinking, 等

    def prepare_messages(self, messages, agent) -> list: ...
        # Qwen cache_control 注入, 等

    def fetch_models(self) -> list: ...
        # 实时获取模型列表

    def get_max_tokens(self, model) -> int: ...
        # per-model 输出上限
```

### 3.2 Provider 发现机制

`providers/__init__.py` 的 `_discover_providers()` 在首次访问时扫描：

```
1. 内置: <repo>/plugins/model-providers/<name>/__init__.py
2. 用户插件: $HERMES_HOME/plugins/model-providers/<name>/
3. 旧式单文件: <repo>/providers/<name>.py（向后兼容）
```

每个插件的 `__init__.py` 调用 `register_provider(profile)`。用户插件覆盖同名的内置插件（last-writer-wins）。

### 2.3 28 个内置 Provider 插件

| Provider 目录 | api_mode | auth_type | 备注 |
|---|---|---|---|
| `alibaba/` | chat_completions | api_key | 阿里 DashScope |
| `alibaba-coding-plan/` | 自定义 | api_key | 阿里 coding plan |
| `anthropic/` | **anthropic_messages** | api_key | 原生 Anthropic Messages API |
| `arcee/` | chat_completions | api_key | Arcee AI |
| `azure-foundry/` | chat_completions | oauth_external | Microsoft Azure Foundry |
| `bedrock/` | **bedrock_converse** | aws_sdk | AWS Bedrock |
| `copilot/` | chat_completions | copilot | GitHub Copilot |
| `copilot-acp/` | 自定义 ACP | copilot | Copilot ACP 协议 |
| `custom/` | chat_completions | api_key | Ollama/local/vLLM/llama.cpp |
| `deepseek/` | chat_completions | api_key | DeepSeek API |
| `gemini/` | chat_completions | api_key / oauth_external | Google Gemini（2 个 profile） |
| `gmi/` | chat_completions | api_key | GMI Cloud |
| `huggingface/` | chat_completions | api_key | HuggingFace 推理 |
| `kilocode/` | chat_completions | api_key | KiloCode |
| `kimi-coding/` | chat_completions | api_key | Kimi/Moonshot |
| `minimax/` | chat_completions | api_key | MiniMax |
| `nous/` | chat_completions | oauth_device_code | Nous Research Portal |
| `novita/` | chat_completions | api_key | NovitaAI |
| `nvidia/` | chat_completions | api_key | NVIDIA NIM |
| `ollama-cloud/` | chat_completions | api_key | Ollama Cloud |
| `openai-codex/` | **codex_responses** | oauth_external | ChatGPT Codex（Responses API） |
| `opencode-zen/` | chat_completions | api_key | OpenCode Zen |
| `openrouter/` | chat_completions | api_key | OpenRouter 聚合器 |
| `qwen-oauth/` | chat_completions | oauth_external | Qwen Portal OAuth |
| `stepfun/` | chat_completions | api_key | StepFun（阶跃星辰） |
| `xai/` | chat_completions / codex_responses | api_key | xAI/Grok |
| `xiaomi/` | chat_completions | api_key | 小米 MiMo |
| `zai/` | chat_completions | api_key | 智谱 GLM |

---

## 4. Transport 传输层

### 4.1 设计动机

不同 LLM 提供商的 API 协议不同：OpenAI 用 Chat Completions API，Anthropic 用 Messages API，OpenAI Codex 用 Responses API。Transport 层的职责是**归一化这些差异**，让上层 agent loop 只看到统一的接口。

### 4.2 ProviderTransport 接口

```python
class ProviderTransport(ABC):
    api_mode: str

    def convert_messages(self, messages: list, agent) -> list:
        """把 OpenAI 格式消息转为 provider 原生格式"""

    def convert_tools(self, tools: list, agent) -> list:
        """转换工具定义 schema"""

    def build_kwargs(self, messages, tools, agent, **overrides) -> dict:
        """组装完整 API 参数字典"""

    def normalize_response(self, raw_response, agent) -> NormalizedResponse:
        """把 SDK 原始响应映射到统一类型"""

    def validate_response(self, response) -> bool:
        """验证响应有效性"""

    def extract_cache_stats(self, response) -> dict:
        """提取 prompt caching 统计"""

    def map_finish_reason(self, finish_reason) -> str:
        """归一化结束原因"""
```

### 4.3 四种已注册 Transport

| api_mode | Transport 类 | 文件 | 覆盖 provider 数 |
|---|---|---|---|
| `chat_completions` | `ChatCompletionsTransport` | `agent/transports/chat_completions.py` | ~16 个 |
| `anthropic_messages` | `AnthropicTransport` | `agent/transports/anthropic.py` | 2 个 |
| `codex_responses` | `ResponsesApiTransport` | `agent/transports/codex.py` | 2 个 |
| `bedrock_converse` | `BedrockTransport` | `agent/transports/bedrock.py` | 1 个 |

### 4.4 api_mode 自动检测

在 `agent/agent_init.py` 的 `init_agent()` 中自动判断：

```python
if provider == "anthropic" or "api.anthropic.com" in base_url:
    api_mode = "anthropic_messages"
elif provider == "openai-codex" or "chatgpt.com/backend-api/codex" in base_url:
    api_mode = "codex_responses"
elif provider == "bedrock" or "bedrock-runtime.*.amazonaws.com" in base_url:
    api_mode = "bedrock_converse"
elif GPT-5.x models on api.openai.com:
    api_mode = "codex_responses"
elif URL ends with "/anthropic":
    api_mode = "anthropic_messages"
else:
    api_mode = "chat_completions"  # 默认
```

---

## 5. SDK 客户端层

### 5.1 OpenAI SDK 客户端创建

`agent/agent_runtime_helpers.py` 的 `create_openai_client()` 是中心工厂函数：

```python
def create_openai_client(agent):
    # 特殊 provider 走自定义客户端
    if agent.provider == "copilot-acp":
        return CopilotACPClient()
    if agent.provider == "google-gemini-cli":
        return GeminiCloudCodeClient()
    if agent.provider == "gemini" and is_native_base_url:
        return GeminiNativeClient()

    # 其余 ~90% 的 provider 走这里
    # 1. 拷贝 client_kwargs 防止 mutation 泄漏
    # 2. 校验代理环境变量
    # 3. 注入 keepalive httpx.Client（防止 CLOSE-WAIT 累积）
    # 4. 调用 OpenAI SDK
    return OpenAI(
        api_key=api_key,
        base_url=base_url,
        http_client=httpx.Client(...),
        default_headers=...,
    )
```

**`OpenAI` 类名是一个懒代理**（`agent/process_bootstrap.py`），将 ~240ms 的 SDK 导入延迟到真正需要时才执行。

### 5.2 每次请求创建独立 Client

```python
def _create_request_openai_client():
    return OpenAI(..., max_retries=0)
```

关键参数 `max_retries=0`：agent 在外层 loop 中自己控制重试逻辑，SDK 层不做重试，避免二次放大。

### 5.3 Anthropic SDK 客户端创建

`agent/anthropic_adapter.py` 的 `build_anthropic_client()`：

```python
def build_anthropic_client(api_key, base_url, ...):
    client = anthropic.Anthropic(
        api_key=api_key,
        base_url=base_url,
        default_headers={...},
    )
    # 处理多种认证方式：
    # - 标准 API Key (sk-ant-*): x-api-key header
    # - OAuth setup token (sk-ant-oat*): Bearer auth
    # - 可调用 token provider (Entra ID JWT): httpx event hook
    # - Kimi /coding: 自定义 User-Agent
    # - 第三方 Anthropic 兼容端点: 自定义 key header
    return client
```

`build_anthropic_bedrock_client()` 使用 `anthropic.AnthropicBedrock` 处理 AWS Bedrock 上的 Claude 模型。

### 5.4 自定义客户端

| 客户端 | 用途 |
|--------|------|
| `CopilotACPClient` | GitHub Copilot 的 ACP（Agent Communication Protocol） |
| `GeminiNativeClient` | Google Gemini 原生 API |
| `GeminiCloudCodeClient` | Google Cloud Code 中的 Gemini CLI |

---

## 6. API 调用全链路

### 6.1 chat_completions 模式（~16 个 provider）

以 DeepSeek 为例：

```
run_agent.py: conversation loop
  │
  ├─ 1. transport.build_kwargs(messages, tools, agent)
  │     ├─ message 格式：保持 OpenAI 格式（chat_completions 是原生格式）
  │     ├─ profile.build_extra_body() → DeepSeek thinking config
  │     └─ profile.build_api_kwargs_extras() → reasoning_effort 等
  │
  ├─ 2. interruptible_streaming_api_call()
  │     └─ _call_chat_completions() in daemon thread
  │           ├─ _create_request_openai_client()
  │           │     └─ OpenAI(api_key=..., base_url=..., max_retries=0)
  │           └─ client.chat.completions.create(stream=True, **api_kwargs)
  │
  └─ 3. transport.normalize_response(raw_response)
        └─ 映射到 NormalizedResponse（content + tool_calls + reasoning + usage）
```

### 6.2 anthropic_messages 模式

以 Anthropic 原生为例：

```
run_agent.py: conversation loop
  │
  ├─ 1. transport.build_kwargs(messages, tools, agent)
  │     ├─ convert_messages_to_anthropic() → Anthropic 格式消息
  │     ├─ 注入 prompt caching 标记（cache_control）
  │     └─ 注入 extended thinking 配置
  │
  ├─ 2. agent._anthropic_messages_create(api_kwargs)
  │     └─ self._anthropic_client.messages.create(**api_kwargs)
  │
  └─ 3. transport.normalize_response(raw_response)
        └─ Anthropic ContentBlock → NormalizedResponse
```

### 6.3 codex_responses 模式

以 OpenAI Codex 为例：

```
run_agent.py: conversation loop
  │
  ├─ 1. transport.build_kwargs(messages, tools, agent)
  │     └─ _chat_messages_to_responses_input() → Responses API 格式
  │
  ├─ 2. _run_codex_stream(api_kwargs, client=...)
  │     └─ active_client.responses.create(stream=True, **stream_kwargs)
  │
  └─ 3. transport.normalize_response()
        └─ Responses API events → NormalizedResponse
```

### 6.4 Provider 自动路由

当 `provider="auto"` 时，`resolve_provider_client()` 按优先级自动选择可用后端：

```
1. OpenRouter（有 OPENROUTER_API_KEY）
2. 本地 Ollama/vLLM/llama.cpp（检测 localhost 端口）
3. 其他已配置 provider 的 API Key
```

---

## 7. 设计决策总结

| 决策 | 选择 | 原因 |
|------|------|------|
| 主力 SDK | `openai` Python SDK | 绝大多数 provider 兼容 OpenAI Chat Completions 协议 |
| Anthropic 调用 | `anthropic` Python SDK（懒加载） | 原生 Messages API 与 Chat Completions 差异太大，不适合强行适配 |
| Bedrock 调用 | `boto3` 直接调用 | 使用了 Bedrock Converse API，不需要额外抽象 |
| 不用 litellm | 自建 provider 抽象 | 对 supply-chain 有精确版本锁定要求；自建抽象更可控 |
| 每次请求建新 Client | `max_retries=0` | agent 外层 loop 控制重试，SDK 层不做重试避免二次放大 |
| httpx 连接池 | keepalive 注入 | 防止大量 CLOSE-WAIT 套接字累积 |
| SDK 懒导入 | `LazyProxy` 延迟 240ms | 加速进程启动 |
| 依赖精确锁定 | `==X.Y.Z` | 供应链安全（吸取 litellm 被投毒事件的教训） |

---

## 8. 与传统方案对比

| | Hermes | 典型 litellm 项目 | 自己实现 HTTP Client |
|---|---|---|---|
| 维护成本 | 中（自建 provider 抽象 + transport 层） | 低（委托给 litellm） | 高（每个 provider 差异需手写） |
| 控制力 | 高（per-provider 钩子） | 中（受限于 litellm 的抽象） | 最高 |
| 供应链风险 | 低（3 个精确锁定的 SDK） | 高（litellm 及其传递依赖） | 低 |
| 新 provider 接入 | 写一个 ProviderProfile + 注册 | 等 litellm 支持或写 litellm provider | 手写全套 HTTP 逻辑 |
| 流式处理 | SDK 原生支持 | SDK 原生支持 | 需手写 SSE 解析 |

Hermes 选择了**中间路线**：不直接用 litellm（供应链风险），也不自己写 HTTP（维护成本），而是用 3 个官方 SDK + 自建 provider/transport 抽象层。这 28 个 provider 插件中，大部分只需要几行 ProviderProfile 声明即可接入——实际 HTTP 调用完全由 SDK 处理。

---

> 生成日期：2026-06-17
> 分析范围：agent/agent_runtime_helpers.py、agent/agent_init.py、agent/chat_completion_helpers.py、agent/conversation_loop.py、agent/transports/、agent/anthropic_adapter.py、providers/、plugins/model-providers/、pyproject.toml
