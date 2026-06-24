# Anthropic 客户端请求处理完整流程

> 关联文档：本文是 [litelllm-统一提供商接口设计](./litelllm-统一提供商接口设计.md) 第 7 节"一次完整调用的源码路径"的 Anthropic 专项展开。

---

## 0. 前置结论：Anthropic 走通用 HTTP 路径

与 OpenAI 使用官方 SDK 不同，Anthropic 走的是 **`BaseLLMHTTPHandler` 通用 HTTP 路径**的变体——它有自己的 `AnthropicChatCompletion` handler，但底层使用 httpx 直接发送 HTTP POST 到 `https://api.anthropic.com/v1/messages`，不使用 Anthropic 官方 SDK。

这意味着：

- `transform_request()` 的产物是 **Anthropic 格式的 JSON body**（`{model, messages, system, max_tokens, ...}`）
- `transform_response()` **每次都被调用**，负责将 Anthropic 响应结构翻译为 `ModelResponse`
- 流式解析由 `ModelResponseIterator` 完成，解析 Anthropic SSE 事件为 `ModelResponseStream` chunk
- HTTP 通信、重试、错误处理全部由 LiteLLM 自己的 httpx 封装管理

这与 OpenAI 形成鲜明对比：OpenAI 的 `transform_request()` 几乎透传，`transform_response()` 默认不被调用，HTTP 细节委托给 SDK。

---

## 1. 总览：从 `completion()` 到 `ModelResponse`

```
用户调用 completion(model="claude-sonnet-4-6", messages=[...], temperature=0.7)
  │
  ├── 1. main.py:completion()                         入口函数，参数校验
  ├── 2. get_llm_provider()                           识别提供商 → "anthropic"
  ├── 3. ProviderConfigManager.get_provider_chat_config() 获取 AnthropicConfig
  ├── 4. get_optional_params() + map_openai_params()   参数筛选与翻译
  ├── 5. if-elif 链 → _complete_anthropic()           分发
  ├── 6. AnthropicChatCompletion.completion()          HTTP 调用 + 转换
  └── 7. AnthropicConfig.transform_response()          响应归一化 → ModelResponse
```

下面逐步展开。

---

## 2. 入口层：`main.py:completion()`

位置：[litellm/main.py:4951](https://github.com/binarylei/litellm/blob/litellm_internal_staging/litellm/main.py#L4951)

### 2.1 参数校验

与 OpenAI 路径相同，`completion()` 入口对所有提供商做统一参数校验：

```python
messages = validate_and_fix_openai_messages(messages=messages)
tools = validate_and_fix_openai_tools(tools=tools)
tool_choice = validate_chat_completion_tool_choice(tool_choice=tool_choice)
```

### 2.2 提供商识别

```python
model, custom_llm_provider, dynamic_api_key, api_base = get_llm_provider(
    model=model, custom_llm_provider=custom_llm_provider, ...
)
```

`get_llm_provider()` 位于 [litellm_core_utils/get_llm_provider_logic.py](https://github.com/binarylei/litellm/blob/litellm_internal_staging/litellm/litellm_core_utils/get_llm_provider_logic.py)，对于 `model="claude-sonnet-4-6"`：

- **正则匹配**（第 78-91 行）：`_CLAUDE_PATTERN = re.compile(r"^claude-[a-z]+-\d+-\d+(?:-\d{8})?$", re.IGNORECASE)` 匹配 Claude 模型名，返回 `custom_llm_provider = "anthropic"`
- **模型列表兜底**：检查 `model in litellm.anthropic_models`，区分 chat（`anthropic`）和 text（`anthropic_text`）端点

这个正则让新 Claude 模型（如未来的 `claude-haiku-4-8`）无需修改代码即可自动路由到 Anthropic。

### 2.3 获取 ProviderConfig（工厂查表）

```python
provider_config = ProviderConfigManager.get_provider_chat_config(
    model=model, provider=LlmProviders(custom_llm_provider), ...
)
```

`ProviderConfigManager._PROVIDER_CONFIG_MAP` 中 Anthropic 的注册（[utils.py:8425](https://github.com/binarylei/litellm/blob/litellm_internal_staging/litellm/utils.py#L8425)）：

```python
LlmProviders.ANTHROPIC → lambda: litellm.AnthropicConfig()
```

与 OpenAI 不同，Anthropic 没有"路由器 Config"——`AnthropicConfig` 直接做所有转换，因为 Anthropic 模型之间不需要像 o-series vs GPT 那样做参数策略切换。

### 2.4 参数筛选与翻译

`map_openai_params()` 在这里执行，将 OpenAI 标准参数翻译为 Anthropic 等效参数：

| OpenAI 参数 | Anthropic 等效 | 翻译方式 |
|---|---|---|
| `max_tokens` / `max_completion_tokens` | `max_tokens`（int 转换） | 直接映射 |
| `tools` | Anthropic tool 格式 | `_map_tools()`：函数 → `AnthropicMessagesTool`，hosted tools → `AnthropicHostedTools`，MCP → `AnthropicMcpServerTool` |
| `tool_choice` / `parallel_tool_calls` | `AnthropicMessagesToolChoice` | `_map_tool_choice()` |
| `stop` | `stop_sequences` | `_map_stop_sequences()` |
| `response_format` | `output_format`（新模型）或 tool-based JSON mode | `map_response_format_to_anthropic_output_format()` 或 `map_response_format_to_anthropic_tool()` |
| `user` | `metadata.user_id` | 直接映射（过滤 email 格式） |
| `reasoning_effort` | `thinking` + `output_config.effort` | `_map_reasoning_effort()`：low→budget_tokens=1024, high→budget_tokens=4096, xhigh→budget_tokens=8192, max→budget_tokens=12288 |
| `web_search_options` | `AnthropicWebSearchTool` | `map_web_search_tool()` |
| `context_management` | Anthropic compact/edits 格式 | `map_openai_context_management_to_anthropic()` |

### 2.5 dispatch 路由

`main.py` 的 if-elif 链中，`custom_llm_provider == "anthropic"` 命中：

```python
# main.py:L5746-5747
elif custom_llm_provider == "anthropic":
    response = _complete_anthropic(_dispatch_ctx)
```

---

## 3. 分发层：`_complete_anthropic()`

位置：[litellm/main.py:2677](https://github.com/binarylei/litellm/blob/litellm_internal_staging/litellm/main.py#L2677)

### 3.1 密钥和端点解析

```python
api_key = (
    api_key
    or litellm.anthropic_key        # 模块级全局变量
    or litellm.api_key              # 通用 api_key
    or os.environ.get("ANTHROPIC_API_KEY")
)

api_base = (
    api_base
    or litellm.api_base
    or get_secret("ANTHROPIC_API_BASE")
    or get_secret("ANTHROPIC_BASE_URL")
    or "https://api.anthropic.com/v1/messages"
)
```

优先级链：函数参数 > 模块全局变量 > 环境变量 > 默认值。

### 3.2 URL 后缀处理

```python
# main.py:L2713-2723
if api_base is not None and not disable_url_suffix and not api_base.endswith("/v1/messages"):
    api_base += "/v1/messages"
```

自动追加 `/v1/messages` 后缀，除非设置了 `LITELLM_ANTHROPIC_DISABLE_URL_SUFFIX`。

### 3.3 委托给 Handler

```python
# main.py:L2725-2743
response = anthropic_chat_completions.completion(
    model=model, messages=messages, api_base=api_base,
    acompletion=acompletion, ...
)
```

`anthropic_chat_completions` 是 [main.py:300](https://github.com/binarylei/litellm/blob/litellm_internal_staging/litellm/main.py#L300) 创建的模块级单例 `AnthropicChatCompletion()`。

---

## 4. Handler 层：`AnthropicChatCompletion.completion()`

位置：[litellm/llms/anthropic/chat/handler.py:330](https://github.com/binarylei/litellm/blob/litellm_internal_staging/litellm/llms/anthropic/chat/handler.py#L330)

这是 Anthropic 请求的**核心调度中心**。与 OpenAI 路径不同，这里的每一步都清晰可见：

### 4.1 环境校验（validate_environment）

```python
# handler.py:L360-367
headers = AnthropicConfig().validate_environment(
    api_key=api_key, headers=headers, model=model,
    messages=messages, optional_params=optional_params, ...
)
```

`validate_environment()` 位于 [common_utils.py:622](https://github.com/binarylei/litellm/blob/litellm_internal_staging/litellm/llms/anthropic/common_utils.py#L622)，做了大量工作：

1. **OAuth 检测**（`optionally_handle_anthropic_oauth()`，第 45 行）：检测 `sk-ant-oat*` 前缀的 OAuth token，切换到 `Authorization: Bearer` 模式，注入 `anthropic-beta: oauth-2026-04-15` 和 `anthropic-dangerous-direct-browser-access: true`

2. **API Key 解析**：从 `ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN` 环境变量获取凭证

3. **特性检测**（决定需要哪些 beta header）：
   - `is_cache_control_set()` — 检查消息中是否有 `cache_control` 标记
   - `is_computer_tool_used()` — 是否使用了 computer 工具
   - `is_mcp_server_used()` — 是否有 MCP server 工具
   - `is_pdf_used()` / `is_file_id_used()` — 是否包含 PDF/文件
   - `is_web_search_tool_used()` / `is_tool_search_used()` — 搜索工具
   - `is_effort_used()` — reasoning effort 参数
   - `is_code_execution_tool_used()` / `is_container_with_skills_used()` — 代码执行

4. **构建 Headers**（`get_anthropic_headers()`，[common_utils.py:536](https://github.com/binarylei/litellm/blob/litellm_internal_staging/litellm/llms/anthropic/common_utils.py#L536)）：

```python
headers = {
    "anthropic-version": "2023-06-01",
    "accept": "application/json",
    "content-type": "application/json",
    "x-api-key": api_key,           # 或 Authorization: Bearer <auth_token>
    "anthropic-beta": "comma,separated,beta,headers",  # 根据特性检测结果
}
```

注意：Prompt Caching 不再需要 beta header——它已自动生效。但 computer tool、MCP、tool search、effort、code execution 等仍需对应 beta header。

### 4.2 再次获取 ProviderConfig

```python
# handler.py:L369-376
config = ProviderConfigManager.get_provider_chat_config(
    model=model, provider=LlmProviders(custom_llm_provider),
)
```

与 OpenAI 路径一样，handler 内部也会重新获取一次 config。这里的 `custom_llm_provider` 是 `"anthropic"`，所以拿到的是 `AnthropicConfig` 实例。

### 4.3 请求转换（transform_request）

```python
# handler.py:L378-384
data = config.transform_request(
    model=model, messages=messages, optional_params=optional_params,
    litellm_params=litellm_params, headers=headers,
)
```

这是 Anthropic 路径最关键的一步。`AnthropicConfig.transform_request()` 位于 [transformation.py:1832](https://github.com/binarylei/litellm/blob/litellm_internal_staging/litellm/llms/anthropic/chat/transformation.py#L1832)，做以下工作：

1. **校验 tools 存在性**：如果 messages 中有 tool_call 但 `optional_params` 中没有 tools，则注入一个 dummy tool（Anthropic API 会因此拒绝请求）

2. **清理无效 thinking 参数**：如果 messages 中没有 thinking_blocks，则移除 thinking 参数，防止 Anthropic 400

3. **更新 beta headers**：根据 `optional_params` 中的特性使用情况更新 `anthropic-beta` header

4. **工具名 sanitization**（第 1902 行）：Anthropic 要求工具名满足 `^[a-zA-Z0-9_-]{1,128}$`。如果工具名包含 `/` 等非法字符，会被 rewrite 为合法形式，并建立 forward/reverse map。reverse map 存储在 `litellm_params[ANTHROPIC_TOOL_NAME_REVERSE_MAP_KEY]` 中，供响应侧还原原始工具名

5. **消息格式翻译**（第 1911-1921 行）：
   - `translate_system_message()` 将 OpenAI 的 system role 消息抽取为 Anthropic 的顶字段 `system`
   - `anthropic_messages_pt()` 将剩余的 messages 格式化为 Anthropic 的 messages 结构

6. **合并默认配置**：`AnthropicConfig.get_config()` 获取 `max_tokens` 等默认值，合入 `optional_params`

7. **处理 metadata.user_id**：将 LiteLLM 元数据中的 user_id 转为 Anthropic 的 `metadata.user_id`

8. **清理内部参数**：移除 `is_vertex_request`、`client_metadata` 等不应发送到 Anthropic API 的字段

9. **组装最终 data**：

```python
data = {
    "model": model,
    "messages": anthropic_messages,
    **optional_params,
}
```

### 4.4 Beta header 过滤

```python
# handler.py:L386-390
headers, data = update_request_with_filtered_beta(
    headers=headers, request_data=data, provider=custom_llm_provider,
)
```

根据提供商能力过滤不支持的 beta header 值，防止请求被 Anthropic 拒绝。

### 4.5 四条代码路径的分叉

```python
# handler.py:L403-529
if acompletion is True:
    if stream is True:
        return self.acompletion_stream_function(...)   # 路径 A：异步流式
    else:
        return self.acompletion_function(...)           # 路径 B：异步非流式
else:
    if stream is True:
        # make_sync_call() + CustomStreamWrapper       # 路径 C：同步流式
        return CustomStreamWrapper(...)
    else:
        # client.post() + transform_response()         # 路径 D：同步非流式
        return config.transform_response(...)
```

四条路径的核心差异在于 HTTP 调用方式和响应处理，但 `transform_request()` 对四种方式**完全一致**。

---

## 5. 同步非流式路径（路径 D）

最基础的路径，也是最容易理解的。

### 5.1 HTTP 发送

```python
# handler.py:L489-501
client = _get_httpx_client(params={"timeout": timeout})
response = client.post(
    api_base,                    # https://api.anthropic.com/v1/messages
    headers=headers,             # x-api-key, anthropic-version, anthropic-beta...
    data=json.dumps(data),       # transform_request 产出的 JSON body
    timeout=timeout,
)
```

使用的是 LiteLLM 自己的 `HTTPHandler`（基于 httpx），不使用 Anthropic 官方 SDK。

### 5.2 响应解析（transform_response）

```python
# handler.py:L517-529
return config.transform_response(
    model=model, raw_response=response, model_response=model_response,
    logging_obj=logging_obj, api_key=api_key, request_data=data,
    messages=messages, optional_params=optional_params,
    litellm_params=litellm_params, encoding=encoding, json_mode=json_mode,
)
```

`AnthropicConfig.transform_response()` 位于 [transformation.py:2562](https://github.com/binarylei/litellm/blob/litellm_internal_staging/litellm/llms/anthropic/chat/transformation.py#L2562)：

1. 调用 `logging_obj.post_call()` 记录日志
2. `raw_response.json()` 解析 JSON
3. 从 `litellm_params` 取出 tool name reverse map
4. 委托给 `transform_parsed_response()`

### 5.3 transform_parsed_response — 核心响应翻译

位于 [transformation.py:2425](https://github.com/binarylei/litellm/blob/litellm_internal_staging/litellm/llms/anthropic/chat/transformation.py#L2425)，将 Anthropic 响应结构翻译为 OpenAI 格式：

**Step 1 — 响应头处理**：

```python
_hidden_params["additional_headers"] = process_anthropic_headers(dict(raw_response.headers))
```

`process_anthropic_headers()`（[common_utils.py:992](https://github.com/binarylei/litellm/blob/litellm_internal_staging/litellm/llms/anthropic/common_utils.py#L992)）将 Anthropic 的 rate-limit 头映射为 OpenAI 兼容名称，并将所有原始头包裹在 `llm_provider-anthropic-*` 前缀下。

**Step 2 — 内容提取**（`extract_response_content()`，[transformation.py:2084](https://github.com/binarylei/litellm/blob/litellm_internal_staging/litellm/llms/anthropic/chat/transformation.py#L2084)）：

遍历 Anthropic 响应中的 `content` 数组，按类型分发：

```
Anthropic content[]                 → OpenAI 等效
─────────────────────────────────────────────────
{"type": "text", "text": "..."}     → text_content 字符串拼接
{"type": "tool_use", ...}           → ChatCompletionToolCallChunk（id, name, arguments）
{"type": "server_tool_use", ...}    → ChatCompletionToolCallChunk
{"type": "thinking", ...}           → thinking_blocks + reasoning_content
{"type": "redacted_thinking", ...}  → ChatCompletionRedactedThinkingBlock
{"type": "compaction", ...}         → compaction_blocks
{"type": "*_tool_result", ...}      → web_search_results / tool_results
citations 字段                       → citations（附带 supported_text）
```

**Step 3 — 工具名还原**（第 2464 行）：

如果在请求侧 sanitize 了工具名，这里用 reverse map 还原为调用方的原始工具名。只有实际被 rewrite 的名字才会出现在 reverse map 中——合法命名的工具不受影响。

**Step 4 — JSON mode 解析**（`_resolve_json_mode_non_streaming()`，[transformation.py:2046](https://github.com/binarylei/litellm/blob/litellm_internal_staging/litellm/llms/anthropic/chat/transformation.py#L2046)）：

Anthropic 的 JSON mode 通过 tool call 返回结果。如果所有 tool_calls 都是 `response_format` 内部工具，提取 JSON 作为 `message.content`；如果混合了用户工具和 JSON 工具，过滤掉 JSON 工具并保留用户工具。

**Step 5 — 组装 ModelResponse**：

```python
_message = litellm.Message(
    tool_calls=tool_calls_for_message,
    content=text_content or None,
    provider_specific_fields=provider_specific_fields,  # citations, thinking_blocks, ...
    thinking_blocks=thinking_blocks,
    reasoning_content=reasoning_content,
)
model_response.choices[0].message = _message
model_response.choices[0].finish_reason = map_finish_reason(completion_response["stop_reason"])
```

`stop_reason` 映射（Anthropic → OpenAI）：

| Anthropic stop_reason | OpenAI finish_reason |
|---|---|
| `end_turn` | `stop` |
| `max_tokens` | `length` |
| `stop_sequence` | `stop` |
| `tool_use` | `tool_calls` |

**Step 6 — Usage 计算**（`calculate_usage()`，[transformation.py:2189](https://github.com/binarylei/litellm/blob/litellm_internal_staging/litellm/llms/anthropic/chat/transformation.py#L2189)）：

从 Anthropic 的 `usage` 对象提取：
- `input_tokens` / `output_tokens` — 基础 token 数
- `cache_creation_input_tokens` / `cache_read_input_tokens` — 缓存 token
- `server_tool_use.web_search_requests` / `tool_search_requests` — 服务端工具使用
- `iterations` — 多轮迭代模式的 token 汇总
- `cache_creation` — 缓存创建详情（ephemeral_5m / ephemeral_1h）

拼装为 OpenAI 标准的 `Usage` 对象，其中 `prompt_tokens_details` 包含缓存 token 明细。

---

## 6. 流式路径（路径 A / C）

当 `stream=True` 时，走流式路径。同步（`make_sync_call`）和异步（`make_call`）的结构完全对称。

### 6.1 HTTP 流式发送

```python
# handler.py:L75-120 (make_call, 异步版)
response = await client.post(
    api_base, headers=headers, data=data, stream=True, timeout=timeout,
)
completion_stream = ModelResponseIterator(
    streaming_response=response.aiter_lines(),  # 异步逐行迭代
    sync_stream=False,
    json_mode=json_mode,
    speed=optional_params.get("speed"),
    tool_name_reverse_map=litellm_params.get(ANTHROPIC_TOOL_NAME_REVERSE_MAP_KEY),
)
```

关键点：`stream=True` 让 httpx 以流式方式接收 SSE 数据，`ModelResponseIterator` 包装了 `response.aiter_lines()`（异步）或 `response.iter_lines()`（同步）。

### 6.2 ModelResponseIterator — SSE 事件解析

位置：[handler.py:536](https://github.com/binarylei/litellm/blob/litellm_internal_staging/litellm/llms/anthropic/chat/handler.py#L536)

这是 Anthropic 流式处理的核心。Anthropic 的 SSE 事件类型及其解析：

#### content_block_start（第 810 行）

新内容块开始。按子类型处理：

```python
{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_xxx","name":"get_weather","input":{}}}
```

- **`text`**：提取文本作为 content
- **`tool_use` / `server_tool_use`**：创建 `ChatCompletionToolCallChunk`，记录 tool_index。同时做工具名反向映射，将 sanitized 名还原为原始名。对于 server_tool_use，记录 `_server_tool_inputs` 供后续组装 `code_interpreter_results`
- **`redacted_thinking`**：创建 `ChatCompletionRedactedThinkingBlock`
- **`compaction`**：记录 compaction block
- **`*_tool_result`**：累积 web_search_results / tool_results / code_interpreter_results

#### content_block_delta（第 795 行）

内容块的增量更新：

```python
{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}
```

`_content_block_delta_helper()`（第 627 行）按 delta 类型分发：

- **`text_delta`** → `text` 字段
- **`input_json_delta`** → tool call 的 `partial_json` arguments（仅当 `current_content_block_type` 为 `tool_use` 或 `server_tool_use` 时。`web_search_tool_result` 的 `input_json_delta` 被忽略，防止误判为 tool call）
- **`thinking_delta`** → 累积 `reasoning_content_chunks`，产出 `thinking_blocks`
- **`citation_delta`** → `provider_specific_fields["citation"]`
- **`compaction_delta`** → `provider_specific_fields["compaction_delta"]`

#### content_block_stop（第 935 行）

内容块结束。对 tool_use/server_tool_use 块：
- 如果所有 delta 中 arguments 为空，填入 `"{}"`（空参数）
- 对 server_tool_use，从累积的 `input_json_delta` 组装完整 input

#### message_start（第 993 行）

流开始时的初始消息，包含初始 usage（input_tokens）。

#### message_delta（第 978 行）

流结束时的 delta，包含最终 `stop_reason`、最终 `usage`、`container`（代码执行容器信息）。

#### error（第 1018 行）

```python
{"type":"error","error":{"type":"api_error","message":"Internal server error"}}
```

抛出 `AnthropicError`，终止流。

### 6.3 JSON mode 流式处理

`_handle_json_mode_chunk()`（第 1060 行）在 `chunk_parser` 末尾被调用。当 `json_mode=True` 且检测到 tool call 来自 `response_format` 内部工具时：
- 如果只有 JSON 工具 → 将 tool call arguments 作为 `content` 输出，移除 tool_calls
- 如果混合了用户工具 → 过滤掉 JSON 工具，保留用户工具

### 6.4 碎片化 JSON 处理

`_handle_accumulated_json_chunk()`（第 1132 行）处理 TCP 层面的 SSE 碎片化问题。当 Anthropic 的 JSON 被分割到多个 TCP 包时，单个 SSE line 可能不是完整 JSON。该方法累积碎片直到接收到合法 JSON 为止。

### 6.5 CustomStreamWrapper 包装

```python
# handler.py:L250-256 (异步流式)
streamwrapper = CustomStreamWrapper(
    completion_stream=completion_stream,  # ModelResponseIterator 实例
    model=model,
    custom_llm_provider="anthropic",
    logging_obj=logging_obj,
    _response_headers=process_anthropic_headers(headers),
)
return streamwrapper
```

`CustomStreamWrapper` 位于 [litellm_core_utils/streaming_handler.py:114](https://github.com/binarylei/litellm/blob/litellm_internal_staging/litellm/litellm_core_utils/streaming_handler.py#L114)，它是所有提供商的统一流式包装器。对 Anthropic：

- `ModelResponseIterator` 产出 `ModelResponseStream` chunk（已经是 OpenAI 格式）
- `CustomStreamWrapper._dispatch_provider_chunk()`（第 1162 行）识别 `custom_llm_provider="anthropic"` 的 chunk，提取 `text`、`tool_use`、`finish_reason`、`usage`、`provider_specific_fields`
- `chunk_creator()`（第 1532 行）遍历流，处理 thinking_blocks 合并、tool call delta 累积
- `__next__()`（第 1915 行）处理超时、重复检测、日志记录

用户侧体验：

```python
response = litellm.completion(model="claude-sonnet-4-6", messages=[...], stream=True)
for chunk in response:
    print(chunk.choices[0].delta.content)          # 文本增量
    print(chunk.choices[0].delta.tool_calls)       # tool call delta
    print(chunk.choices[0].delta.reasoning_content) # thinking 文本
```

---

## 7. 异步路径

异步路径（`acompletion=True`）与同步路径结构完全对称：

```
completion() → _complete_anthropic()
  → AnthropicChatCompletion.completion(acompletion=True)
    ├── stream=True  → acompletion_stream_function()
    │   ├── make_call() → AsyncHTTPHandler.post(stream=True)
    │   ├── ModelResponseIterator(aiter_lines)
    │   └── CustomStreamWrapper
    │
    └── stream=False → acompletion_function()
        ├── AsyncHTTPHandler.post()
        └── config.transform_response()
```

`make_call()`（[handler.py:75](https://github.com/binarylei/litellm/blob/litellm_internal_staging/litellm/llms/anthropic/chat/handler.py#L75)）使用 `AsyncHTTPHandler`（基于 httpx.AsyncClient），返回值与同步 `make_sync_call()` 一致——都是 `(ModelResponseIterator, headers)`。

---

## 8. 错误处理

Anthropic 路径有两层错误处理：

### 8.1 HTTP 层错误

`make_call()` / `make_sync_call()` 和 `acompletion_function()` / 同步非流式路径中的 `client.post()`：

```python
except httpx.HTTPStatusError as e:
    raise AnthropicError(
        status_code=e.response.status_code,
        message=e.response.text,           # 或 await e.response.aread()
        headers=e.response.headers,
    )
except Exception as e:
    for exception in litellm.LITELLM_EXCEPTION_TYPES:
        if isinstance(e, exception):
            raise e                        # 透传已知 LiteLLM 异常
    raise AnthropicError(status_code=500, message=str(e))
```

所有 HTTP 错误被包装为 `AnthropicError`（继承 `BaseLLMException`），包含 status_code、message、headers。已定义的 LiteLLM 异常类型（如认证错误、速率限制）会被透传。

### 8.2 SSE 流内错误

`ModelResponseIterator.chunk_parser()` 中处理 SSE `error` 事件：

```python
# handler.py:L1018-1027
elif type_chunk == "error":
    _error_dict = chunk.get("error", {}) or {}
    message = _error_dict.get("message", None) or str(chunk)
    raise AnthropicError(message=message, status_code=500)
```

### 8.3 响应 JSON 解析错误

`transform_response()` 中处理非 JSON 响应：

```python
# transformation.py:L2586-2595
try:
    completion_response = raw_response.json()
except Exception as e:
    raise AnthropicError(
        message="Unable to get json response - {}, Original Response: {}".format(
            str(e), raw_response.text
        ),
        status_code=raw_response.status_code,
        headers=response_headers,
    )
```

---

## 9. 与 OpenAI 路径的关键差异对比

| 维度 | OpenAI | Anthropic |
|---|---|---|
| HTTP 通信 | 官方 `openai` SDK | LiteLLM 自己的 httpx handler |
| `transform_request()` 角色 | 几乎透传（拼 kwargs） | 核心转换：消息结构重构、工具名 sanitization、beta header 管理 |
| `transform_response()` 调用 | 默认不调用 | 每次必调用 |
| 响应解析 | SDK 返回 Pydantic 对象 → `convert_to_model_response_object()` | `extract_response_content()` 遍历 content 数组逐块翻译 |
| 流式解析 | SDK `Stream[ChatCompletionChunk]` | `ModelResponseIterator` 手写 SSE 解析器 |
| 参数翻译量 | 极少（参数名一致） | 大量：tools 格式转换、reasoning_effort→thinking、response_format→output_format |
| 认证方式 | `Authorization: Bearer` | `x-api-key`（标准）或 `Authorization: Bearer`（OAuth/auth_token） |
| Beta header 管理 | 无 | 按特性动态启用（12+ 种 beta header） |
| Config 类结构 | `OpenAIConfig` 路由器 → 子类 | `AnthropicConfig` 直接处理 |
| 工具名处理 | 无需处理 | Sanitization + forward/reverse map |

核心差异：**OpenAI 是规范格式，Anthropic 需要完整适配**。`AnthropicConfig` 承担了远多于 `OpenAIGPTConfig` 的工作——消息结构重构、参数名映射、响应 content 数组遍历翻译、beta header 特性检测、工具名 sanitization、OAuth 支持等。

---

## 10. 完整调用链图

```
completion(model="claude-sonnet-4-6", messages=[...], temperature=0.7)
  │
  ├── main.py:completion()                              [litellm/main.py:4951]
  │   ├── validate_and_fix_openai_messages()             参数校验
  │   ├── get_llm_provider()
  │   │   ├── _CLAUDE_PATTERN 正则匹配 → "anthropic"     [get_llm_provider_logic.py:78]
  │   │   └── litellm.anthropic_models 兜底
  │   ├── ProviderConfigManager.get_provider_chat_config()
  │   │   └── 返回 AnthropicConfig()                     [utils.py:8425]
  │   ├── get_optional_params()                          筛选非默认参数
  │   └── pre_process_non_default_params()
  │       └── AnthropicConfig.map_openai_params()        [transformation.py:1402]
  │           ├── temperature → temperature
  │           ├── reasoning_effort → thinking + output_config
  │           ├── tools → _map_tools()                   [transformation.py:869]
  │           └── response_format → output_format / tool
  │
  ├── if-elif 链 → _complete_anthropic()                 [litellm/main.py:2677]
  │   ├── 解析 api_key (优先级链)
  │   ├── 解析 api_base → 追加 /v1/messages 后缀
  │   └── anthropic_chat_completions.completion()        [handler.py:330]
  │
  └── AnthropicChatCompletion.completion()               [handler.py:330]
      ├── AnthropicConfig().validate_environment()        [common_utils.py:622]
      │   ├── optionally_handle_anthropic_oauth()         检测 OAuth token
      │   ├── get_api_key() / get_auth_token()            解析凭证
      │   ├── 特性检测 (12+ 种 feature flag)
      │   └── get_anthropic_headers()                     [common_utils.py:536]
      │       ├── x-api-key / Authorization: Bearer
      │       ├── anthropic-version: 2023-06-01
      │       └── anthropic-beta: 按需拼接
      │
      ├── ProviderConfigManager.get_provider_chat_config()
      │   └── 获取 AnthropicConfig（handler 内再次）
      │
      ├── config.transform_request()                      [transformation.py:1832]
      │   ├── 校验 tools 存在性 + 注入 dummy tool
      │   ├── 清理无效 thinking 参数
      │   ├── 更新 anthropic-beta headers
      │   ├── _sanitize_tool_names_in_request()           工具名合法化
      │   │   └── 构建 forward/reverse map（防冲突）
      │   ├── _rewrite_tool_names_in_messages()           历史消息工具名改写
      │   ├── translate_system_message()                  system → 顶字段
      │   ├── anthropic_messages_pt()                     OpenAI → Anthropic 消息格式
      │   ├── strip_advisor_blocks_from_messages()        清理 advisor block
      │   ├── add_code_execution_tool()                   添加代码执行工具
      │   ├── 合并 AnthropicConfig 类变量默认值
      │   ├── 处理 metadata.user_id
      │   └── 返回 {"model", "messages", **optional_params}
      │
      ├── update_request_with_filtered_beta()             beta header 过滤
      │
      └── ┬─ stream=True  → make_sync_call() / make_call()
         │   ├── HTTPHandler.post(stream=True) → SSE      [handler.py:75/135]
         │   ├── ModelResponseIterator                     [handler.py:536]
         │   │   ├── content_block_start → text/tool_use/thinking/...
         │   │   ├── content_block_delta → text/partial_json/thinking/...
         │   │   ├── content_block_stop → 最终化 tool call
         │   │   ├── message_start → 初始 usage
         │   │   ├── message_delta → finish_reason + 最终 usage
         │   │   └── error → AnthropicError
         │   └── CustomStreamWrapper                      [streaming_handler.py:114]
         │
         └─ stream=False → client.post()
             └── config.transform_response()               [transformation.py:2562]
                 └── transform_parsed_response()           [transformation.py:2425]
                     ├── process_anthropic_headers()       响应头映射
                     ├── extract_response_content()        content[] 遍历翻译
                     │   ├── text → text_content
                     │   ├── tool_use → ChatCompletionToolCallChunk
                     │   ├── thinking → thinking_blocks + reasoning_content
                     │   └── *_tool_result → web_search/tool_results
                     ├── 工具名反向映射（reverse map）
                     ├── _resolve_json_mode_non_streaming() JSON mode 解析
                     ├── 组装 litellm.Message
                     ├── map_finish_reason()               stop_reason → finish_reason
                     └── calculate_usage()                 [transformation.py:2189]
                         ├── input_tokens / output_tokens
                         ├── cache_creation/read tokens
                         ├── server_tool_use 统计
                         └── iterations 汇总
```

---

## 11. 关键设计观察

### 11.1 AnthropicChatCompletion 是独立的 Handler

与 OpenAI 不同，Anthropic 没有走 `BaseLLMHTTPHandler.completion()` 通用路径。`AnthropicChatCompletion`（[handler.py:203](https://github.com/binarylei/litellm/blob/litellm_internal_staging/litellm/llms/anthropic/chat/handler.py#L203)）继承 `BaseLLM`，有自己的 HTTP 调用、流式解析、错误处理逻辑。

原因：
- Anthropic 的 SSE 事件模型（`content_block_start` / `content_block_delta` / `content_block_stop` / `message_delta` / `message_start`）与 OpenAI 的 `choices[0].delta` 完全不同，需要专门的解析器
- Anthropic 特有的特性（tool name sanitization、beta header 管理、OAuth、code_interpreter_results）需要贯穿请求/响应的上下文状态
- `ModelResponseIterator` 维护了大量流式状态（content_blocks 缓冲、tool_index 跟踪、accumulated JSON、web_search_results 累积），不适合通用化

### 11.2 transform_request 是核心转换枢纽

Anthropic 的 `transform_request()` 远不只是"拼 JSON"。它是所有 Anthropic 兼容提供商（Anthropic 直连、Bedrock Anthropic、Vertex AI Anthropic、Azure Anthropic）的**唯一聚合点**：

```python
# AmazonAnthropicConfig / VertexAIAnthropicConfig / AzureAnthropicConfig 都调用
# super().transform_request() 或 AnthropicConfig.transform_request(self, ...)
```

这意味着工具名 sanitization、消息格式翻译、system prompt 抽取等逻辑只要在 `AnthropicConfig.transform_request()` 中实现一次，所有 Anthropic 兼容路径都会受益。

### 11.3 工具名 sanitization 的设计精妙

工具名 sanitization（`_sanitize_tool_names_in_request()`，[transformation.py:1012](https://github.com/binarylei/litellm/blob/litellm_internal_staging/litellm/llms/anthropic/chat/transformation.py#L1012)）是 Anthropic 路径特有的逻辑。Anthropic 要求工具名满足 `^[a-zA-Z0-9_-]{1,128}$`，这意味着 `/`（如 MCP 工具的 `mcp__server__tool`）不合法。

设计要点：
- **单次就做 sanitize**：在 `transform_request` 中（而非 `map_openai_params`），因为这是所有 Anthropic 路径的共享边界
- **状态放在 litellm_params**：forward/reverse map 存储在 `litellm_params`（内部字典），不污染 `optional_params`（会被序列化到 JSON body 并因此被 Anthropic 拒绝）
- **只映射实际改写的名字**：合法命名的工具不会被 reverse map 误映射
- **冲突处理**：如果 `foo/bar` → `foo_bar`，但已有工具叫 `foo_bar`，则使用 `foo_bar_1` 等后缀递增

### 11.4 Anthropic 不需要 "路由器 Config"

与 OpenAI 的 `OpenAIConfig`（根据 model 名路由到子 Config）不同，Anthropic 只需要一个 `AnthropicConfig`。原因：

- Anthropic 的所有 Claude 模型共享同一套 API 契约（`/v1/messages`）
- 参数差异通过 `get_supported_openai_params()` 中的模型名检查处理（如 `claude-3-7-sonnet` 支持 `thinking`，更新模型支持 `output_format`）
- 没有类似 o-series vs GPT 的根本性参数策略差异

### 11.5 流式的 SSE 模型是完全手写的

Anthropic 不使用 `BaseModelResponseIterator`（那是给简单 JSON lines 流用的）。`ModelResponseIterator` 完全手写，处理 Anthropic 特有的事件模型：

- 维护 `content_blocks` 缓冲区累积同一个 content block 的所有 delta
- 跟踪 `current_content_block_type` 以区分 tool_use delta 和 web_search delta
- 处理 TCP 碎片化导致的 JSON 不完整问题（`accumulated_json`）
- 累积 web_search_results 和 tool_results 以供多轮重建
- 收集 `reasoning_content_chunks` 供最终 usage 计算时拆分 reasoning tokens

### 11.6 Beta header 的"特性驱动"模型

Anthropic 的 beta header 不是硬编码的，而是根据请求中实际使用的特性动态检测：

```
computer tool → "computer-use-2025-01-28"
MCP server   → "mcp-client-2025-04-04"
tool_search  → "tool-search-2025-04-29"
effort       → "effort-2025-04-29"
code_execution → "code-execution-2025-08-25"
files_api    → "files-api-2025-04-14" + "code-execution-2025-05-22"
container_with_skills → "skills-2025-10-02"
```

每个特性在 `AnthropicModelInfo` 中有对应的 `is_*_used()` 检测方法。只有检测到使用的特性才会在 header 中声明对应的 beta。这避免了不必要的 beta header 导致兼容性问题。
