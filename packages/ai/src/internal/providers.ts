/**
 * OpenAI-compatible provider base URLs owned by @kode/ai.
 * Kept local so provider transport does not import core model constants.
 */
export const providers = {
  kimi: {
    name: 'Kimi (Moonshot)',
    baseURL: 'https://api.moonshot.cn/v1',
  },
  anthropic: {
    name: 'Messages API (Native)',
    baseURL: 'https://api.anthropic.com',
  },
  burncloud: {
    name: 'BurnCloud (All models)',
    baseURL: 'https://ai.burncloud.com/v1',
  },
  deepseek: {
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
  },
  qwen: {
    name: 'Qwen (Alibaba)',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
  openai: {
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
  },
  ollama: {
    name: 'Ollama',
    baseURL: 'http://localhost:11434/v1',
  },
  gemini: {
    name: 'Gemini',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
  },
  'custom-openai': {
    name: 'Custom OpenAI-Compatible API',
    baseURL: '',
  },
  openrouter: {
    name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
  },
} as const
