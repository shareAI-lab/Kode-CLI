import { MACRO } from '#core/constants/macros'

import { DaemonRegistry } from './daemonRegistry'
import { DaemonSupervisor, type StartDaemonResult } from './daemonSupervisor'
import { createNodeDaemonProcessController } from './nodeDaemonProcessController'

type BackgroundLoopHostSupervisor = Pick<DaemonSupervisor, 'start'>

export type BackgroundLoopHostResult = Extract<
  StartDaemonResult,
  { state: 'started' | 'reused' }
>

function defaultVersionSignature(): string {
  const version =
    MACRO.VERSION || process.env.npm_package_version || 'unknown-version'
  const runtime = process.versions.bun
    ? `bun-${process.versions.bun}`
    : `node-${process.versions.node}`
  return `${version}:${runtime}`
}

function createSupervisor(): DaemonSupervisor {
  return new DaemonSupervisor({
    registry: new DaemonRegistry(),
    controller: createNodeDaemonProcessController(),
  })
}

/**
 * Starts the existing workspace-scoped daemon in detached mode or reuses a
 * healthy compatible one. Process creation lives in the shared controller,
 * which already uses the portable Node detached/unref lifecycle rules.
 */
export async function ensureBackgroundLoopHost(args: {
  cwd: string
  supervisor?: BackgroundLoopHostSupervisor
  versionSignature?: string
}): Promise<BackgroundLoopHostResult> {
  const result = await (args.supervisor ?? createSupervisor()).start({
    workspacePath: args.cwd,
    versionSignature: args.versionSignature ?? defaultVersionSignature(),
  })

  if (result.state === 'started' || result.state === 'reused') return result
  if (result.state === 'version_mismatch') {
    throw new Error(
      `A daemon for this workspace is already running with ${result.entry.versionSignature}; stop it explicitly before enabling background loop keep-alive.`,
    )
  }
  throw new Error(
    `The registered daemon (pid ${result.entry.pid}) failed its health probe. Inspect it or run \`kode daemon stop --force\` after verifying the PID.`,
  )
}
