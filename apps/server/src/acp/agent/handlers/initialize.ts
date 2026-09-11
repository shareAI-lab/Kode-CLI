import { MACRO } from '#core/constants/macros'

import * as Protocol from '../../protocol'
import { isRecord } from '../guards'

export function handleInitialize(args: {
  params: unknown
  setClientCapabilities: (caps: Protocol.ClientCapabilities) => void
}): Protocol.InitializeResponse {
  const p = isRecord(args.params) ? args.params : {}

  const clientCapabilities = isRecord(p.clientCapabilities)
    ? (p.clientCapabilities as Protocol.ClientCapabilities)
    : {}

  args.setClientCapabilities(clientCapabilities)

  return {
    protocolVersion: Protocol.ACP_PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: {
        image: false,
        audio: false,
        embeddedContext: true,
        embeddedContent: true,
      },
      mcpCapabilities: {
        http: true,
        sse: true,
        ws: true,
      },
    },
    agentInfo: {
      name: 'kode',
      title: 'Kode',
      version: MACRO.VERSION || '0.0.0',
    },
    authMethods: [],
  }
}

export function handleAuthenticate(): Protocol.AuthenticateResponse {
  return {}
}
