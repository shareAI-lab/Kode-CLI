import React from 'react'
import { ModelConfig } from '#ui-ink/components/ModelConfig'
import { enableConfigs } from '#core/utils/config'
import { triggerModelConfigChange } from '#core/messages'

export const help = 'Connect providers and choose model roles'
export const description = 'Connect providers and choose model roles'
export const isEnabled = true
export const isHidden = false
export const name = 'model'
export const type = 'local-jsx'
export const ui = { displayMode: 'fullscreen' as const }

export function userFacingName(): string {
  return name
}

export async function call(
  onDone: (result?: string) => void,
  context: any,
): Promise<React.ReactNode> {
  const { abortController } = context
  enableConfigs()
  abortController?.abort?.()
  return (
    <ModelConfig
      onClose={() => {
        // Force ModelManager reload to ensure UI sync - wait for completion before closing
        import('#core/utils/model').then(({ reloadModelManager }) => {
          reloadModelManager()
          // 🔧 Critical fix: Trigger global UI refresh after model config changes
          // This ensures PromptInput component detects ModelManager singleton state changes
          triggerModelConfigChange()
          // Only close after reload is complete to ensure UI synchronization
          onDone()
        })
      }}
    />
  )
}
