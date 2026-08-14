import { format } from 'node:util'

export function terminalLog(...args: unknown[]): void {
  process.stderr.write(`${format(...args)}\n`)
}
