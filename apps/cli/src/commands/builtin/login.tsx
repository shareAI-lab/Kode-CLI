import * as React from 'react'
import type { Command } from '../types'
import { LoginScreen } from '#ui-ink/components/LoginScreen'
import { clearTerminal } from '#cli-utils/terminal'
import { clearConversation } from './clear'

export default () =>
  ({
    type: 'local-jsx',
    name: 'login',
    description:
      'Configure Codex, GitHub Copilot, OpenAI, or another model provider',
    isEnabled: true,
    isHidden: false,
    ui: { displayMode: 'fullscreen' },
    async call(onDone, context) {
      await clearTerminal()
      return (
        <Login
          onDone={async () => {
            await clearConversation(context)
            onDone()
          }}
        />
      )
    },
    userFacingName() {
      return 'login'
    },
  }) satisfies Command

const Login = LoginScreen
