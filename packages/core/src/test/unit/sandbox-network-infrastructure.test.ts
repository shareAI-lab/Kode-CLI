import { afterEach, describe, expect, test } from 'bun:test'
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import {
  __resetSandboxNetworkInfrastructureForTests,
  ensureSandboxNetworkInfrastructure,
  matchesSandboxDomainPattern,
} from '#core/sandbox/sandboxNetworkInfrastructure'
import type { SandboxRuntimeConfig } from '#core/sandbox/sandboxConfig'

async function canListenOnLoopback(): Promise<boolean> {
  return await new Promise(resolve => {
    const server = net.createServer()
    const done = (value: boolean) => {
      try {
        server.close(() => resolve(value))
      } catch {
        resolve(value)
      }
    }

    server.once('error', (err: any) => {
      // Some sandboxes disallow opening listening sockets (EPERM).
      if (err?.code === 'EPERM') return done(false)
      return done(false)
    })

    server.listen(0, '127.0.0.1', () => done(true))
  })
}

const CAN_LISTEN_ON_LOOPBACK = await canListenOnLoopback()
// These cases exercise the host HTTP/SOCKS proxies. Linux bridge wiring is a
// separate concern and would add an unrelated external `socat` dependency.
const HOST_PROXY_TEST_PLATFORM: NodeJS.Platform = 'darwin'

function createRuntimeConfig(
  overrides?: Partial<SandboxRuntimeConfig>,
): SandboxRuntimeConfig {
  return {
    network: {
      allowedDomains: [],
      deniedDomains: [],
      allowUnixSockets: [],
      allowAllUnixSockets: false,
      allowLocalBinding: false,
      httpProxyPort: undefined,
      socksProxyPort: undefined,
    },
    filesystem: { denyRead: [], allowWrite: ['.'], denyWrite: [] },
    ripgrep: { command: 'rg', args: [] },
    ...(overrides ?? {}),
  }
}

function getListenPort(server: {
  address(): string | AddressInfo | null
}): number {
  const addr = server.address()
  if (addr && typeof addr === 'object') return addr.port
  throw new Error('Expected server to be listening on a TCP port')
}

async function readFirstLine(socket: net.Socket): Promise<string> {
  return await new Promise(resolve => {
    let buffered = ''
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString('utf8')
      const idx = buffered.indexOf('\r\n')
      if (idx !== -1) {
        socket.off('data', onData)
        resolve(buffered.slice(0, idx))
      }
    }
    socket.on('data', onData)
  })
}

afterEach(async () => {
  await __resetSandboxNetworkInfrastructureForTests()
})

describe('sandbox network infrastructure (compatibility)', () => {
  test('matchesSandboxDomainPattern supports "*.domain" and exact matches', () => {
    expect(
      matchesSandboxDomainPattern('api.example.com', '*.example.com'),
    ).toBe(true)
    expect(
      matchesSandboxDomainPattern('API.EXAMPLE.COM', '*.example.com'),
    ).toBe(true)
    expect(matchesSandboxDomainPattern('example.com', '*.example.com')).toBe(
      false,
    )
    expect(matchesSandboxDomainPattern('example.com', 'example.com')).toBe(true)
    expect(matchesSandboxDomainPattern('Example.Com', 'example.com')).toBe(true)
  })

  if (!CAN_LISTEN_ON_LOOPBACK) {
    test('network-dependent tests skipped (loopback listen not permitted)', () => {
      expect(true).toBe(true)
    })
    return
  }

  test('default deny: unknown host with no callback returns 403 (CONNECT)', async () => {
    const runtimeConfig = createRuntimeConfig()
    const ports = await ensureSandboxNetworkInfrastructure({
      runtimeConfig,
      permissionCallback: null,
      platform: HOST_PROXY_TEST_PLATFORM,
    })

    const socket = net.connect(ports.httpProxyPort, '127.0.0.1')
    socket.write(
      'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n',
    )

    const line = await readFirstLine(socket)
    expect(line).toContain('403')

    socket.destroy()
  })

  test('deny rules take precedence over allow rules (CONNECT)', async () => {
    const server = http.createServer((_req, res) => res.end('ok'))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const destPort = getListenPort(server)

    const runtimeConfig = createRuntimeConfig({
      network: {
        ...createRuntimeConfig().network,
        allowedDomains: ['localhost'],
        deniedDomains: ['localhost'],
      },
    })
    const ports = await ensureSandboxNetworkInfrastructure({
      runtimeConfig,
      permissionCallback: null,
      platform: HOST_PROXY_TEST_PLATFORM,
    })

    const socket = net.connect(ports.httpProxyPort, '127.0.0.1')
    socket.write(
      `CONNECT localhost:${destPort} HTTP/1.1\r\nHost: localhost:${destPort}\r\n\r\n`,
    )
    const line = await readFirstLine(socket)
    expect(line).toContain('403')

    socket.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  test('allow rules permit CONNECT to local host', async () => {
    const server = net.createServer(sock => {
      sock.end()
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const destPort = getListenPort(server)

    const runtimeConfig = createRuntimeConfig({
      network: {
        ...createRuntimeConfig().network,
        allowedDomains: ['localhost'],
      },
    })
    const ports = await ensureSandboxNetworkInfrastructure({
      runtimeConfig,
      permissionCallback: null,
      platform: HOST_PROXY_TEST_PLATFORM,
    })

    const socket = net.connect(ports.httpProxyPort, '127.0.0.1')
    socket.write(
      `CONNECT localhost:${destPort} HTTP/1.1\r\nHost: localhost:${destPort}\r\n\r\n`,
    )
    const line = await readFirstLine(socket)
    expect(line).toContain('200')

    socket.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
})
