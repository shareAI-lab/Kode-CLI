import type { ProviderType } from '#core/utils/config'

const OPENAI_COMPATIBLE_PROVIDERS: ReadonlySet<ProviderType> = new Set([
  'azure',
  'burncloud',
  'minimax',
  'kimi',
  'deepseek',
  'siliconflow',
  'qwen',
  'glm',
  'glm-coding',
  'baidu-qianfan',
  'openai',
  'mistral',
  'xai',
  'groq',
  'openrouter',
  'orcarouter',
  'gemini',
  'ollama',
  'custom-openai',
])

export function isOpenAICompatibleProvider(provider: ProviderType): boolean {
  return OPENAI_COMPATIBLE_PROVIDERS.has(provider)
}
