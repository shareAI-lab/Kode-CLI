import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { cwd } from 'process'

import { BunShell } from './shell'

const STATE: {
  originalCwd: string
} = {
  originalCwd: cwd(),
}

type CwdScope = {
  cwd: string
  originalCwd: string
}

const cwdScope = new AsyncLocalStorage<CwdScope>()

/**
 * Pins cwd state to one asynchronous execution chain. This is required for
 * background agents: another daemon turn may change the process-wide cwd
 * after the parent turn returns, but the detached run must stay in its own
 * workspace.
 */
export function runWithCwdScope<T>(
  scopedCwd: string,
  callback: () => T,
  scopedOriginalCwd: string = scopedCwd,
): T {
  const absoluteCwd = isAbsolute(scopedCwd)
    ? scopedCwd
    : resolve(getCwd(), scopedCwd)
  const absoluteOriginalCwd = isAbsolute(scopedOriginalCwd)
    ? scopedOriginalCwd
    : resolve(getOriginalCwd(), scopedOriginalCwd)
  return cwdScope.run(
    { cwd: absoluteCwd, originalCwd: absoluteOriginalCwd },
    callback,
  )
}

export async function setCwd(cwd: string): Promise<void> {
  const scope = cwdScope.getStore()
  if (scope) {
    const resolved = isAbsolute(cwd) ? cwd : resolve(scope.cwd, cwd)
    if (!existsSync(resolved)) {
      throw new Error(`Path "${resolved}" does not exist`)
    }
    scope.cwd = resolved
    return
  }
  await BunShell.getInstance().setCwd(cwd)
}

export function setOriginalCwd(cwd: string): void {
  const scope = cwdScope.getStore()
  if (scope) {
    scope.originalCwd = isAbsolute(cwd) ? cwd : resolve(scope.cwd, cwd)
    return
  }
  STATE.originalCwd = cwd
}

export function getOriginalCwd(): string {
  return cwdScope.getStore()?.originalCwd ?? STATE.originalCwd
}

export function getCwd(): string {
  return cwdScope.getStore()?.cwd ?? BunShell.getInstance().pwd()
}
