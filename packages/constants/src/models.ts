import { anthropic } from './models/anthropic'
import { deepseek } from './models/deepseek'
import { gemini } from './models/gemini'
import { groq } from './models/groq'
import { mistral } from './models/mistral'
import { openai } from './models/openai'
import { xai } from './models/xai'

import { providers } from './models/providers'

type ProviderModel = {
  model: string
  input_cost_per_token?: number
  output_cost_per_token?: number
  [key: string]: unknown
}

const models: Record<string, ProviderModel[]> = {
  openai,
  mistral,
  deepseek,
  xai,
  groq,
  anthropic,
  gemini,
  kimi: [],
  qwen: [],
  glm: [],
  minimax: [],
  'baidu-qianfan': [],
  siliconflow: [],
  ollama: [],
  burncloud: [],
  'minimax-coding': [],
  'glm-coding': [],
}

export default models
export { providers }
