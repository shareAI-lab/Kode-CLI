import type { ChildProcess } from 'node:child_process'

type ExecResult = {
  stdout: string
  stderr: string
  code: number
  interrupted: boolean
}

export type BunShellPromotableExecStatus =
  'running' | 'backgrounded' | 'completed' | 'killed'

export type BunShellPromotableExec = {
  get status(): BunShellPromotableExecStatus
  background: (bashId?: string) => { bashId: string } | null
  kill: () => void
  result: Promise<ExecResult>
  onTimeout?: (
    cb: (background: (bashId?: string) => { bashId: string } | null) => void,
  ) => void
}

export type BunShellSandboxReadConfig = {
  denyOnly: string[]
}

export type BunShellSandboxWriteConfig = {
  allowOnly: string[]
  denyWithinAllow?: string[]
}

export type BunShellSandboxOptions = {
  enabled: boolean
  require?: boolean
  // Compatibility: use `needsNetworkRestriction` (invert of "allow network").
  needsNetworkRestriction?: boolean
  // Back-compat: legacy allowNetwork flag (when true, disables network restriction).
  allowNetwork?: boolean

  /**
   * Linux-only compatibility: when network is restricted via `--unshare-net`,
   * sandboxed processes can only reach the host HTTP/SOCKS proxies via a pair of
   * Unix socket bridge endpoints.
   *
   * The host creates `UNIX-LISTEN` sockets that forward to the host proxy ports,
   * and the sandbox starts `socat TCP-LISTEN` forwarders to expose them as
   * localhost TCP ports (3128/1080 by convention).
   */
  linuxBridge?: {
    httpSocketPath: string
    socksSocketPath: string
  }

  /**
   * Linux-only compatibility: optional Unix socket blocking via seccomp.
   * When present, the sandbox script runs:
   *   apply-seccomp <bpfPath> <shell> -c <command>
   */
  linuxSeccomp?: {
    applySeccompPath: string
    bpfPath: string
  }

  // Compatibility: sandbox network settings.
  allowUnixSockets?: string[]
  allowAllUnixSockets?: boolean
  allowLocalBinding?: boolean
  httpProxyPort?: number
  socksProxyPort?: number

  readConfig?: BunShellSandboxReadConfig
  writeConfig?: BunShellSandboxWriteConfig
  enableWeakerNestedSandbox?: boolean
  binShell?: string

  // Back-compat: previous "write allowlist" API.
  writableRoots?: string[]
  // Back-compat: bwrap --chdir (relies on process cwd instead).
  chdir?: string

  // Test-only overrides (to make sandbox behavior deterministic in unit tests).
  __platformOverride?: NodeJS.Platform
  __bwrapPathOverride?: string | null
  __sandboxExecPathOverride?: string | null
}

export type BunShellExecOptions = {
  /** Immutable launch cwd. Prefer this over the process-wide shell state. */
  cwd?: string
  sandbox?: BunShellSandboxOptions
  stdin?: string
  onStdoutChunk?: (chunk: string) => void
  onStderrChunk?: (chunk: string) => void
  /**
   * Ownership metadata for a background process. It is deliberately separate
   * from the command/sandbox options so callers cannot accidentally derive it
   * from process-global cwd/session state after the task has started.
   */
  backgroundTask?: {
    sessionId?: string
  }
}

export type BackgroundShellCompletion = {
  taskId: string
  status: 'completed' | 'failed' | 'killed'
  exitCode: number | null
  interrupted: boolean
  error?: string
}

export type BackgroundShellLaunch = {
  bashId: string
  pid?: number
  completion: Promise<BackgroundShellCompletion>
}

export type BackgroundShellStatusAttachment = {
  type: 'task_progress'
  taskId: string
  stdoutLineDelta: number
  stderrLineDelta: number
  outputFile: string
}

export type BashNotification = {
  type: 'bash_notification'
  taskId: string
  taskType?: string
  description: string
  status: 'completed' | 'failed' | 'killed'
  exitCode?: number
  outputFile: string
}

export type BackgroundProcess = {
  id: string
  command: string
  stdout: string
  stderr: string
  stdoutCursor: number
  stderrCursor: number
  stdoutLineCount: number
  stderrLineCount: number
  lastReportedStdoutLines: number
  lastReportedStderrLines: number
  code: number | null
  interrupted: boolean
  killed: boolean
  timedOut: boolean
  completionStatusSentInAttachment: boolean
  notified: boolean
  startedAt: number
  completedAt?: number
  timeoutAt: number
  process: ChildProcess
  abortController: AbortController
  timeoutHandle: ReturnType<typeof setTimeout> | null
  cwd: string
  sessionId?: string
  outputFile: string
}
