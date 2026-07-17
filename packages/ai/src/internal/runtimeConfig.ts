/**
 * Runtime knobs for provider transport (proxy, etc.) without core config.
 */

export type AiRuntimeBindings = {
  getProxy?: () => string | undefined
}

let getProxyImpl: () => string | undefined = () => {
  const proxy =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy
  return proxy?.trim() || undefined
}

export function bindAiRuntime(
  bindings: AiRuntimeBindings | null | undefined,
): void {
  if (!bindings?.getProxy) {
    getProxyImpl = () => {
      const proxy =
        process.env.HTTPS_PROXY ||
        process.env.HTTP_PROXY ||
        process.env.https_proxy ||
        process.env.http_proxy
      return proxy?.trim() || undefined
    }
    return
  }
  getProxyImpl = bindings.getProxy
}

export function getAiProxy(): string | undefined {
  try {
    return getProxyImpl()
  } catch {
    return undefined
  }
}
