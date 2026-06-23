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
    baseURL: '', // Will be configured by user
  },
  openrouter: {
    name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
  },
  requesty: {
    name: 'Requesty',
    baseURL: 'https://router.requesty.ai/v1',
  },
  minimax: {
    name: 'MiniMax',
    baseURL: 'https://api.minimaxi.com/v1',
  },
  'minimax-coding': {
    name: 'MiniMax Coding Plan',
    baseURL: 'https://api.minimaxi.com/anthropic',
  },
  siliconflow: {
    name: 'SiliconFlow',
    baseURL: 'https://api.siliconflow.cn/v1',
  },
  glm: {
    name: 'GLM (Zhipu AI)',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
  },
  'glm-coding': {
    name: 'GLM Coding Plan',
    baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4',
  },
  'baidu-qianfan': {
    name: 'Baidu Qianfan',
    baseURL: 'https://qianfan.baidubce.com/v2',
  },
  mistral: {
    name: 'Mistral',
    baseURL: 'https://api.mistral.ai/v1',
  },
  xai: {
    name: 'xAI',
    baseURL: 'https://api.x.ai/v1',
  },
  groq: {
    name: 'Groq',
    baseURL: 'https://api.groq.com/openai/v1',
  },
  azure: {
    name: 'Azure OpenAI',
    baseURL: '', // Will be dynamically constructed based on resource name
  },
}
