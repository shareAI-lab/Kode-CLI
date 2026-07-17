export const PROMPT_CACHING_ENABLED = !process.env.DISABLE_PROMPT_CACHING

export function splitSysPromptPrefix(systemPrompt: string[]): string[] {
  const systemPromptFirstBlock = systemPrompt[0] || ''
  const systemPromptRest = systemPrompt.slice(1)
  return [systemPromptFirstBlock, systemPromptRest.join('\n')].filter(Boolean)
}
