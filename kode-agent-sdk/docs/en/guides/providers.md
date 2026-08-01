# Provider Configuration Guide

KODE SDK provides three built-in Provider implementations that support any model service conforming to the corresponding API protocol.

---

## Built-in Providers

| Provider | API Protocol | Compatible Services |
|----------|--------------|---------------------|
| `AnthropicProvider` | Anthropic Messages API | Anthropic, compatible services |
| `OpenAIProvider` | OpenAI Chat/Responses API | OpenAI, DeepSeek, GLM, Qwen, Minimax, OpenRouter, etc. |
| `GeminiProvider` | Google Generative AI API | Google Gemini |

> **Note**: Any service with a compatible API protocol can use the corresponding Provider. For example, DeepSeek, GLM, Qwen, etc. all use OpenAI-compatible APIs and can be used via `OpenAIProvider` with a custom `baseURL`.

---

## Environment Variables

<!-- tabs:start -->
#### **Linux / macOS**
```bash
export ANTHROPIC_API_KEY=sk-ant-...
export ANTHROPIC_BASE_URL=https://api.anthropic.com  # optional
export OPENAI_API_KEY=sk-...
export OPENAI_BASE_URL=https://api.openai.com/v1  # optional
export GOOGLE_API_KEY=...
```

#### **Windows (PowerShell)**
```powershell
$env:ANTHROPIC_API_KEY="sk-ant-..."
$env:ANTHROPIC_BASE_URL="https://api.anthropic.com"  # optional
$env:OPENAI_API_KEY="sk-..."
$env:OPENAI_BASE_URL="https://api.openai.com/v1"  # optional
$env:GOOGLE_API_KEY="..."
```
<!-- tabs:end -->

---

## AnthropicProvider

For Anthropic Claude models and services compatible with the Anthropic API.

### Basic Configuration

```typescript
import { AnthropicProvider } from '@shareai-lab/kode-sdk';

const provider = new AnthropicProvider(
  process.env.ANTHROPIC_API_KEY!,
  'claude-sonnet-4-5-20250929',  // any supported model ID
  process.env.ANTHROPIC_BASE_URL  // optional, default: https://api.anthropic.com
);
```

### Enable Extended Thinking

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
        budget_tokens: 10000,  // minimum 1024
      },
    },
  }
);
```

### Enable Caching

```typescript
const provider = new AnthropicProvider(
  process.env.ANTHROPIC_API_KEY!,
  'claude-sonnet-4-5-20250929',
  undefined,
  undefined,
  {
    cache: {
      breakpoints: 4,  // 1-4 cache breakpoints
      defaultTtl: '1h', // '5m' or '1h'
    },
    beta: {
      extendedCacheTtl: true,
    },
  }
);
```

### Example Models

The following are common model examples. Any model compatible with the Anthropic API is supported:

| Model | Description |
|-------|-------------|
| `claude-sonnet-4-5-20250929` | Claude 4.5 Sonnet (recommended) |
| `claude-opus-4-5-20251101` | Claude 4.5 Opus |
| `claude-haiku-4-5-20251015` | Claude 4.5 Haiku (fast, low-cost) |

---

## OpenAIProvider

For OpenAI and all OpenAI API-compatible services (DeepSeek, GLM, Qwen, Minimax, OpenRouter, etc.).

### Basic Configuration

```typescript
import { OpenAIProvider } from '@shareai-lab/kode-sdk';

// OpenAI official
const provider = new OpenAIProvider(
  process.env.OPENAI_API_KEY!,
  'gpt-5-2025-08-07',  // any supported model ID
  process.env.OPENAI_BASE_URL  // optional, default: https://api.openai.com/v1
);
```

### Using DeepSeek

```typescript
const provider = new OpenAIProvider(
  process.env.DEEPSEEK_API_KEY!,
  'deepseek-chat',
  'https://api.deepseek.com/v1'
);

// DeepSeek reasoning model
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

### Using GLM (Zhipu)

```typescript
const provider = new OpenAIProvider(
  process.env.GLM_API_KEY!,
  'glm-4-plus',
  'https://open.bigmodel.cn/api/paas/v4'
);
```

### Using Qwen (Tongyi Qianwen)

```typescript
const provider = new OpenAIProvider(
  process.env.QWEN_API_KEY!,
  'qwen-plus',
  'https://dashscope.aliyuncs.com/compatible-mode/v1'
);
```

### Using Minimax

```typescript
const provider = new OpenAIProvider(
  process.env.MINIMAX_API_KEY!,
  'abab6.5s-chat',
  'https://api.minimax.chat/v1'
);
```

### Using OpenRouter

```typescript
const provider = new OpenAIProvider(
  process.env.OPENROUTER_API_KEY!,
  'anthropic/claude-sonnet-4.5',  // OpenRouter model format
  'https://openrouter.ai/api/v1'
);
```

### Using OrcaRouter

```typescript
const provider = new OpenAIProvider(
  process.env.ORCAROUTER_API_KEY!,
  'openai/gpt-5.5',  // OrcaRouter model format: <upstream>/<model>
  'https://api.orcarouter.ai/v1'
);
```

Model ids keep their upstream namespace, so pass them exactly as OrcaRouter lists them. `orcarouter/auto` selects a named router that picks the upstream per request instead of a fixed model.

### Enable Reasoning (o4 models)

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

### Example Models

The following are common model examples. Any model compatible with the OpenAI API is supported:

| Service | Example Models |
|---------|----------------|
| OpenAI | `gpt-5.2-pro-2025-12-11`, `gpt-5-2025-08-07`, `o4-mini-2025-04-16` |
| DeepSeek | `deepseek-chat`, `deepseek-reasoner` |
| GLM | `glm-4-plus`, `glm-4-flash` |
| Qwen | `qwen-plus`, `qwen-turbo` |
| OpenRouter | `anthropic/claude-sonnet-4.5`, `openai/gpt-5` |
| OrcaRouter | `openai/gpt-5.5`, `anthropic/claude-sonnet-4.6`, `orcarouter/auto` |

---

## GeminiProvider

For Google Gemini models.

### Basic Configuration

```typescript
import { GeminiProvider } from '@shareai-lab/kode-sdk';

const provider = new GeminiProvider(
  process.env.GOOGLE_API_KEY!,
  'gemini-3-flash'  // any supported model ID
);
```

### Enable Thinking

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

### Example Models

The following are common model examples. Any model compatible with the Gemini API is supported:

| Model | Description |
|-------|-------------|
| `gemini-3-flash` | Gemini 3 Flash (latest, recommended) |
| `gemini-2.5-pro` | Gemini 2.5 Pro (stable, supports thinking) |
| `gemini-2.5-flash` | Gemini 2.5 Flash (stable) |

---

## Using with Agent

### Provider Factory Pattern

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
    // Simple factory - ignores config, uses env vars
    modelFactory: () => new AnthropicProvider(
      process.env.ANTHROPIC_API_KEY!,
      process.env.ANTHROPIC_MODEL_ID ?? 'claude-sonnet-4-5-20250929'
    ),
  }
);
```

### Using ModelConfig from Template

The `modelFactory` receives a `ModelConfig` object that may include the model ID from the template:

```typescript
// Template with model specification
templates.register({
  id: 'gpt-assistant',
  systemPrompt: 'You are a helpful assistant.',
  model: 'gpt-4o',  // This is passed to modelFactory
});

// Factory that uses the config
modelFactory: (config: ModelConfig) => {
  const modelId = config.model ?? 'claude-sonnet-4-5-20250929';
  return new AnthropicProvider(
    process.env.ANTHROPIC_API_KEY!,
    modelId
  );
}
```

### Multi-Provider Factory

For applications supporting multiple providers, create a factory that selects based on config:

```typescript
function createModelFactory(): (config: ModelConfig) => ModelProvider {
  return (config: ModelConfig) => {
    // Use config.provider or infer from model name
    const provider = config.provider ?? inferProvider(config.model);

    switch (provider) {
      case 'anthropic':
        return new AnthropicProvider(
          config.apiKey ?? process.env.ANTHROPIC_API_KEY!,
          config.model ?? 'claude-sonnet-4-5-20250929',
          config.baseUrl,
          config.proxyUrl
        );
      case 'openai':
        return new OpenAIProvider(
          config.apiKey ?? process.env.OPENAI_API_KEY!,
          config.model ?? 'gpt-4o',
          config.baseUrl,
          config.proxyUrl
        );
      case 'gemini':
        return new GeminiProvider(
          config.apiKey ?? process.env.GOOGLE_API_KEY!,
          config.model ?? 'gemini-3-flash'
        );
      default:
        throw new Error(`Unknown provider: ${provider}`);
    }
  };
}

function inferProvider(model?: string): string {
  if (!model) return 'anthropic';
  if (model.startsWith('claude')) return 'anthropic';
  if (model.startsWith('gpt')) return 'openai';
  if (model.startsWith('gemini')) return 'gemini';
  return 'anthropic';
}
```

---

## Proxy Configuration

All Providers support proxy configuration:

```typescript
const provider = new AnthropicProvider(
  process.env.ANTHROPIC_API_KEY!,
  'claude-sonnet-4-5-20250929',
  undefined,  // baseUrl
  process.env.HTTPS_PROXY  // proxyUrl
);
```

---

## Error Handling

```typescript
try {
  await agent.send('Hello');
} catch (error) {
  if (error.message.includes('rate limit')) {
    // Rate limited, retry after delay
  } else if (error.message.includes('authentication')) {
    // Invalid API key
  }
}
```

---

## Best Practices

1. **Use environment variables** for API keys and baseURL
2. **Set reasonable timeouts** based on expected response times
3. **Enable caching** for repeated prompts (Anthropic, Gemini)
4. **Handle rate limits** with exponential backoff

---

## References

- [Anthropic API Documentation](https://docs.anthropic.com/)
- [OpenAI API Documentation](https://platform.openai.com/docs/)
- [Google AI Documentation](https://ai.google.dev/docs)
- [DeepSeek API Documentation](https://platform.deepseek.com/docs)
- [OpenRouter Documentation](https://openrouter.ai/docs)
