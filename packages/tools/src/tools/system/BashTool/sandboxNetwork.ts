import type { ToolUseContext } from '@kode/tool-interface/Tool'
import type { BunShellSandboxPlan } from '#core/sandbox/bunShellSandboxPlan'
import { ensureSandboxNetworkInfrastructure } from '#core/sandbox/sandboxNetworkInfrastructure'
import type { BunShellSandboxOptions } from '#runtime/shell'
import { WebFetchTool } from '#tools/tools/network/WebFetchTool/WebFetchTool'

export async function maybeAttachSandboxNetworkPorts(args: {
  sandboxPlan: BunShellSandboxPlan
  sandboxOptions: BunShellSandboxOptions | undefined
  context: ToolUseContext
}): Promise<BunShellSandboxOptions | undefined> {
  const { sandboxPlan, sandboxOptions, context } = args
  if (!sandboxPlan.willSandbox) return sandboxOptions
  if (!sandboxOptions || sandboxOptions.enabled !== true) return sandboxOptions

  const platform = sandboxOptions.__platformOverride ?? process.platform
  if (platform !== 'darwin' && platform !== 'linux') return sandboxOptions

  const needsRestriction =
    sandboxOptions.needsNetworkRestriction !== undefined
      ? sandboxOptions.needsNetworkRestriction === true
      : sandboxOptions.allowNetwork === true
        ? false
        : true
  if (!needsRestriction) return sandboxOptions

  const { abortController } = context
  const mode = context?.options?.toolPermissionContext?.mode ?? 'cautious'
  const shouldAvoidPermissionPrompts = Boolean(
    context?.options?.shouldAvoidPermissionPrompts,
  )
  const requestToolUsePermission =
    typeof context?.options?.requestToolUsePermission === 'function'
      ? context.options.requestToolUsePermission
      : undefined

  const ports = await ensureSandboxNetworkInfrastructure({
    runtimeConfig: sandboxPlan.runtimeConfig,
    platform,
    permissionCallback: async ({ host, port }) => {
      if (mode === 'acceptEdits') return true
      if (shouldAvoidPermissionPrompts) return false
      if (!requestToolUsePermission) return false
      if (abortController.signal.aborted) return false

      const hostForUrl =
        host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
      const url = `http://${hostForUrl}:${port}/`

      const result = await requestToolUsePermission(
        {
          tool: WebFetchTool,
          description: 'Network request outside of sandbox',
          input: { url },
          commandPrefix: null,
          suggestions: undefined,
          riskScore: null,
        },
        context,
      )

      return result.result === true
    },
  })

  if (platform === 'linux') {
    if (!ports.linuxBridge) return sandboxOptions
    return {
      ...sandboxOptions,
      linuxBridge: ports.linuxBridge,
      // Compatibility: inside a Linux net namespace we expose proxy bridges on fixed ports.
      httpProxyPort: 3128,
      socksProxyPort: 1080,
    }
  }

  return {
    ...sandboxOptions,
    httpProxyPort: ports.httpProxyPort,
    socksProxyPort: ports.socksProxyPort,
  }
}
