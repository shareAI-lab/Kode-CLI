import React from 'react'
import type { Command } from '../types'
import { Doctor } from '#ui-ink/screens/Doctor'
import { PRODUCT_NAME } from '#core/constants/product'

const doctor: Command = {
  name: 'doctor',
  description: `Checks the health of your ${PRODUCT_NAME} installation`,
  isEnabled: true,
  isHidden: true,
  ui: { displayMode: 'fullscreen' },
  userFacingName() {
    return 'doctor'
  },
  type: 'local-jsx',
  call(onDone, context) {
    const element = React.createElement(Doctor, {
      onDone,
      doctorMode: true,
      toolPermissionContext: context.options?.toolPermissionContext,
    })
    return Promise.resolve(element)
  },
}

export default doctor
