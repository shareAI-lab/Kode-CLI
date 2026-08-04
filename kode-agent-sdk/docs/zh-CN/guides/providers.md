# Provider 配置指南

KODE SDK 提供三个内置 Provider 实现，支持所有符合对应 API 协议的模型服务。

---

## 内置 Provider

| Provider | API 协议 | 兼容服务 |
|----------|----------|----------|
| `AnthropicProvider` | Anthropic Messages API | Anthropic、兼容服务 |
| `OpenAIProvider` | OpenAI Chat/Responses API | OpenAI、DeepSeek、GLM、Qwen、Minimax、OpenRouter 等 |
| `GeminiProvider` | Google Generative AI API | Google Gemini |

> **说明**：只要服务的 API 协议兼容，即可使用对应的 Provider。例如 DeepSeek、GLM、Qwen 等都使用 OpenAI 兼容 API，可通过 `OpenAIProvider` 配置 `baseURL` 使用。

---

## 环境变量配置

<!-- tabs:start -->
#### **Linux / macOS**
```bash
export ANTHROPIC_API_KEY=sk-ant-...
export ANTHROPIC_BASE_URL=https://api.anthropic.com  # 可选
export OPENAI_API_KEY=sk-...
export OPENAI_BASE_URL=https://api.openai.com/v1  # 可选
export GOOGLE_API_KEY=...
```

#### **Windows (PowerShell)**
```powershell
$env:ANTHROPIC_API_KEY="sk-ant-..."
$env:ANTHROPIC_BASE_URL="https://api.anthropic.com"  # 可选
$env:OPENAI_API_KEY="sk-..."
$env:OPENAI_BASE_URL="https://api.openai.com/v1"  # 可选
$env:GOOGLE_API_KEY="..."
```
<!-- tabs:end -->

---

## AnthropicProvider

用于 Anthropic Claude 系列模型及兼容 Anthropic API 的服务。

### 基本配置

```typescript
import { AnthropicProvider } from '@shareai-lab/kode-sdk';

const provider = new AnthropicProvider(
  process.env.ANTHROPIC_API_KEY!,
  'claude-sonnet-4-5-20250929',  // 任意支持的模型 ID
  process.env.ANTHROPIC_BASE_URL  // 可选，默认 https://api.anthropic.com
);
```

### 启用扩展思维

```typescript
const provider = new AnthropicProvider(
  process.env.ANTHROPIC_API_KEY!,
  'claude-sonnet-4-5-20250929',
  undefined,
  undefined,
  {
    extraBody: {
      thinking: {
        type: 'enabled',
        budget_tokens: 10000,  // 最小 1024
      },
    },
  }
);
```

### 启用缓存

```typescript
const provider = new AnthropicProvider(
  process.env.ANTHROPIC_API_KEY!,
  'claude-sonnet-4-5-20250929',
  undefined,
  undefined,
  {
    cache: {
      breakpoints: 4,  // 1-4 个缓存断点
      defaultTtl: '1h', // '5m' 或 '1h'
    },
    beta: {
      extendedCacheTtl: true,
    },
  }
);
```

### 示例模型

以下为常用模型示例，实际支持所有 Anthropic API 兼容的模型：

| 模型 | 说明 |
|------|------|
| `claude-sonnet-4-5-20250929` | Claude 4.5 Sonnet（推荐） |
| `claude-opus-4-5-20251101` | Claude 4.5 Opus |
| `claude-haiku-4-5-20251015` | Claude 4.5 Haiku（快速低成本） |

---

## OpenAIProvider

用于 OpenAI 及所有兼容 OpenAI API 的服务（DeepSeek、GLM、Qwen、Minimax、OpenRouter 等）。

### 基本配置

```typescript
import { OpenAIProvider } from '@shareai-lab/kode-sdk';

// OpenAI 官方
const provider = new OpenAIProvider(
  process.env.OPENAI_API_KEY!,
  'gpt-5-2025-08-07',  // 任意支持的模型 ID
  process.env.OPENAI_BASE_URL  // 可选，默认 https://api.openai.com/v1
);
```

### 使用 DeepSeek

```typescript
const provider = new OpenAIProvider(
  process.env.DEEPSEEK_API_KEY!,
  'deepseek-chat',
  'https://api.deepseek.com/v1'
);

// DeepSeek 推理模型
const reasonerProvider = new OpenAIProvider(
  process.env.DEEPSEEK_API_KEY!,
  'deepseek-reasoner',
  'https://api.deepseek.com/v1',
  undefined,
  {
    reasoning: {
      fieldName: 'reasoning_content',
      stripFromHistory: true,
    },
  }
);
```

### 使用 GLM (智谱)

```typescript
const provider = new OpenAIProvider(
  process.env.GLM_API_KEY!,
  'glm-4-plus',
  'https://open.bigmodel.cn/api/paas/v4'
);
```

### 使用 Qwen (通义千问)

```typescript
const provider = new OpenAIProvider(
  process.env.QWEN_API_KEY!,
  'qwen-plus',
  'https://dashscope.aliyuncs.com/compatible-mode/v1'
);
```

### 使用 Minimax

```typescript
const provider = new OpenAIProvider(
  process.env.MINIMAX_API_KEY!,
  'abab6.5s-chat',
  'https://api.minimax.chat/v1'
);
```

### 使用 OpenRouter

```typescript
const provider = new OpenAIProvider(
  process.env.OPENROUTER_API_KEY!,
  'anthropic/claude-sonnet-4.5',  // OpenRouter 模型格式
  'https://openrouter.ai/api/v1'
);
```

### 使用 OrcaRouter

```typescript
const provider = new OpenAIProvider(
  process.env.ORCAROUTER_API_KEY!,
  'openai/gpt-5.5',  // OrcaRouter 模型格式：<上游>/<模型>
  'https://api.orcarouter.ai/v1'
);
```

模型 ID 需保留上游命名空间，按 OrcaRouter 列出的写法原样传入。`orcarouter/auto` 是命名路由，不是固定模型，每次请求由服务端选择上游。

### 启用推理 (o4 模型)

```typescript
const provider = new OpenAIProvider(
  process.env.OPENAI_API_KEY!,
  'o4-mini',
  undefined,
  undefined,
  {
    api: 'responses',
    responses: {
      reasoning: {
        effort: 'medium',  // 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
      },
    },
  }
);
```

### 示例模型

以下为常用模型示例，实际支持所有 OpenAI API 兼容的模型：

| 服务 | 模型示例 |
|------|----------|
| OpenAI | `gpt-5.2-pro-2025-12-11`, `gpt-5-2025-08-07`, `o4-mini-2025-04-16` |
| DeepSeek | `deepseek-chat`, `deepseek-reasoner` |
| GLM | `glm-4-plus`, `glm-4-flash` |
| Qwen | `qwen-plus`, `qwen-turbo` |
| OpenRouter | `anthropic/claude-sonnet-4.5`, `openai/gpt-5` |
| OrcaRouter | `openai/gpt-5.5`, `anthropic/claude-sonnet-4.6`, `orcarouter/auto` |

---

## GeminiProvider

用于 Google Gemini 系列模型。

### 基本配置

```typescript
import { GeminiProvider } from '@shareai-lab/kode-sdk';

const provider = new GeminiProvider(
  process.env.GOOGLE_API_KEY!,
  'gemini-3-flash'  // 任意支持的模型 ID
);
```

### 启用 Thinking

```typescript
const provider = new GeminiProvider(
  process.env.GOOGLE_API_KEY!,
  'gemini-2.5-pro',
  undefined,
  undefined,
  {
    thinking: {
      level: 'medium',  // 'minimal' | 'low' | 'medium' | 'high'
      includeThoughts: true,
    },
  }
);
```

### 示例模型

以下为常用模型示例，实际支持所有 Gemini API 兼容的模型：

| 模型 | 说明 |
|------|------|
| `gemini-3-flash` | Gemini 3 Flash（最新，推荐） |
| `gemini-2.5-pro` | Gemini 2.5 Pro（稳定版，支持 thinking） |
| `gemini-2.5-flash` | Gemini 2.5 Flash（稳定版） |

---

## 与 Agent 配合使用

### Provider 工厂模式

```typescript
import { Agent, AnthropicProvider } from '@shareai-lab/kode-sdk';

const agent = await Agent.create(
  {
    templateId: 'default',
    sandbox: { kind: 'local', workDir: './workspace' },
  },
  {
    store,
    templateRegistry,
    toolRegistry,
    sandboxFactory,
    modelFactory: () => new AnthropicProvider(
      process.env.ANTHROPIC_API_KEY!,
      process.env.ANTHROPIC_MODEL_ID ?? 'claude-sonnet-4-5-20250929'
    ),
  }
);
```

### 动态 Provider 选择

```typescript
function createProvider(providerName: string) {
  switch (providerName) {
    case 'anthropic':
      return new AnthropicProvider(
        process.env.ANTHROPIC_API_KEY!,
        process.env.ANTHROPIC_MODEL_ID ?? 'claude-sonnet-4-5-20250929'
      );
    case 'openai':
      return new OpenAIProvider(
        process.env.OPENAI_API_KEY!,
        process.env.OPENAI_MODEL_ID ?? 'gpt-5-2025-08-07'
      );
    case 'deepseek':
      return new OpenAIProvider(
        process.env.DEEPSEEK_API_KEY!,
        'deepseek-chat',
        'https://api.deepseek.com/v1'
      );
    case 'gemini':
      return new GeminiProvider(
        process.env.GOOGLE_API_KEY!,
        process.env.GEMINI_MODEL_ID ?? 'gemini-3-flash'
      );
    default:
      throw new Error(`未知 provider: ${providerName}`);
  }
}
```

---

## 代理配置

所有 Provider 都支持代理配置：

```typescript
const provider = new AnthropicProvider(
  process.env.ANTHROPIC_API_KEY!,
  'claude-sonnet-4-5-20250929',
  undefined,  // baseUrl
  process.env.HTTPS_PROXY  // proxyUrl
);
```

---

## 错误处理

```typescript
try {
  await agent.send('你好');
} catch (error) {
  if (error.message.includes('rate limit')) {
    // 速率限制，等待后重试
  } else if (error.message.includes('authentication')) {
    // API 密钥无效
  }
}
```

---

## 最佳实践

1. **使用环境变量** 存储 API 密钥和 baseURL
2. **设置合理的超时时间** 根据预期响应时间
3. **启用缓存** 用于重复提示词（Anthropic、Gemini）
4. **处理速率限制** 使用指数退避

---

## 参考资料

- [Anthropic API 文档](https://docs.anthropic.com/)
- [OpenAI API 文档](https://platform.openai.com/docs/)
- [Google AI 文档](https://ai.google.dev/docs)
- [DeepSeek API 文档](https://platform.deepseek.com/docs)
- [OpenRouter 文档](https://openrouter.ai/docs)
