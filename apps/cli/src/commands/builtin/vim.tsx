import type { Command } from '../types'
import { getGlobalConfig, saveGlobalConfig } from '#core/utils/config'

const vim = {
  type: 'local-jsx',
  name: 'vim',
  description: 'Toggle between Vim and Normal editing modes',
  isEnabled: true,
  isHidden: true,
  async call(onDone) {
    const current = getGlobalConfig().editorMode ?? 'normal'
    const normalized = current === 'emacs' ? 'normal' : current
    const next = normalized === 'normal' ? 'vim' : 'normal'

    saveGlobalConfig({ ...getGlobalConfig(), editorMode: next })

    onDone(
      `Editor mode set to ${next}. ${
        next === 'vim'
          ? 'Use Escape key to toggle between INSERT and NORMAL modes.'
          : 'Using standard (readline) keyboard bindings.'
      }`,
    )
    return null
  },
  userFacingName() {
    return 'vim'
  },
} satisfies Command

export default vim
