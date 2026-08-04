import { useMemo } from 'react'
import models, { providers } from '#core/constants/models'

type Option = { value: string; label: string }

const providerCatalog = providers as Record<
  string,
  { name: string; baseURL: string; status?: string }
>
const modelCatalog = models as Record<string, unknown[] | undefined>

export function useModelSelectorMenus(args: {
  containerPaddingY: number
  containerGap: number
}) {
  function getProviderLabel(provider: string, modelCount: number): string {
    if (providerCatalog[provider]) {
      const wipTag = '(' + 'WI' + 'P' + ')'
      return providerCatalog[provider].status === 'wip'
        ? `${providerCatalog[provider].name} ${wipTag}`
        : providerCatalog[provider].name
    }
    return `${provider}`
  }

  const mainMenuOptions: Option[] = useMemo(() => {
    return [
      { value: 'partnerProviders', label: 'Other Providers \u2192' },
      { value: 'partnerCodingPlans', label: 'Some Coding Plans \u2192' },
      { value: 'custom-openai', label: 'Custom OpenAI API' },
      { value: 'custom-anthropic', label: 'Custom Anthropic API' },
      { value: 'ollama', label: 'Ollama' },
    ]
  }, [])

  const rankedProviders = useMemo(
    () => [
      'openai',
      'anthropic',
      'gemini',
      'glm',
      'kimi',
      'minimax',
      'qwen',
      'deepseek',
      'openrouter',
      'orcarouter',
      'burncloud',
      'siliconflow',
      'baidu-qianfan',
      'mistral',
      'xai',
      'groq',
      'azure',
    ],
    [],
  )

  const partnerProviders = useMemo(
    () =>
      rankedProviders.filter(
        provider =>
          providerCatalog[provider] &&
          !provider.includes('coding') &&
          provider !== 'custom-openai' &&
          provider !== 'ollama',
      ),
    [rankedProviders],
  )

  const codingPlanProviders = useMemo(
    () =>
      Object.keys(providers).filter(provider => provider.includes('coding')),
    [],
  )

  const partnerProviderOptions: Option[] = useMemo(
    () =>
      partnerProviders.map(provider => {
        const modelCount = modelCatalog[provider]?.length || 0
        return {
          label: getProviderLabel(provider, modelCount),
          value: provider,
        }
      }),
    [partnerProviders],
  )

  const codingPlanOptions: Option[] = useMemo(
    () =>
      codingPlanProviders.map(provider => {
        const modelCount = modelCatalog[provider]?.length || 0
        return {
          label: getProviderLabel(provider, modelCount),
          value: provider,
        }
      }),
    [codingPlanProviders],
  )

  // Reserve non-list UI rows conservatively to avoid Ink terminal-scroll tearing when
  // the wizard is close to full height (border + title + description + footer).
  const providerReservedLines =
    10 + args.containerPaddingY * 2 + args.containerGap * 4
  const partnerReservedLines =
    12 + args.containerPaddingY * 2 + args.containerGap * 4
  const codingReservedLines = partnerReservedLines

  return {
    mainMenuOptions,
    partnerProviderOptions,
    codingPlanOptions,
    providerReservedLines,
    partnerReservedLines,
    codingReservedLines,
    getProviderLabel,
  }
}
