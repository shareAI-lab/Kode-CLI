import type { Command } from '@commander-js/extra-typings'

import { PRODUCT_NAME } from '#core/constants/product'

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description(`Check the health of your ${PRODUCT_NAME} installation`)
    .action(async () => {
      const { renderDoctorScreen } = await import('../../interactive/renderers')
      await renderDoctorScreen()
      process.exit(0)
    })
}
