import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { URL } from 'node:url'

type NetworkQuery = { host: string; port: number }

function parseConnectTarget(value: string): NetworkQuery | null {
  const trimmed = value.trim()
  const firstToken = trimmed.split(/\s+/)[0]!
  const withoutLeadingSlash = firstToken.startsWith('/')
    ? firstToken.slice(1)
    : firstToken
  const authority = withoutLeadingSlash.startsWith('//')
    ? withoutLeadingSlash.slice(2)
    : withoutLeadingSlash

  try {
    const url = new URL(`http://${authority}`)
    if (!url.hostname) return null
    const port = Number(url.port) || 443
    return { host: url.hostname, port }
  } catch {
    return null
  }
}

function writeHttpErrorResponse(socket: net.Socket, statusLine: string): void {
  try {
    socket.write(
      `HTTP/1.1 ${statusLine}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    )
  } catch {
    /* no-op */
  }
  try {
    socket.destroy()
  } catch {
    /* no-op */
  }
}

export async function startHttpProxy(args: {
  shouldAllowNetworkRequest: (query: NetworkQuery) => Promise<boolean>
  onServer: (server: net.Server) => void
}): Promise<number> {
  const server = net.createServer(clientSocket => {
    let buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0)

    const onData = (chunk: Buffer<ArrayBufferLike>) => {
      buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk

      const headerEnd = buffered.indexOf('\r\n\r\n')
      if (headerEnd === -1) return

      const headerText = buffered.slice(0, headerEnd).toString('latin1')
      const remainder = buffered.slice(headerEnd + 4)
      buffered = Buffer.alloc(0)
      clientSocket.off('data', onData)

      const lines = headerText.split('\r\n')
      const requestLine = lines.shift() ?? ''
      const [methodRaw, targetRaw, versionRaw] = requestLine.split(' ')
      const method = (methodRaw ?? '').trim().toUpperCase()
      const target = (targetRaw ?? '').trim()
      const version = (versionRaw ?? 'HTTP/1.1').trim() || 'HTTP/1.1'

      if (!method || !target) {
        writeHttpErrorResponse(clientSocket, '400 Bad Request')
        return
      }

      const headers: Record<string, string> = {}
      for (const line of lines) {
        const idx = line.indexOf(':')
        if (idx === -1) continue
        const key = line.slice(0, idx).trim().toLowerCase()
        const value = line.slice(idx + 1).trim()
        if (!key) continue
        headers[key] = value
      }

      if (method === 'CONNECT') {
        void (async () => {
          const targetValue = target || headers['host'] || ''
          const parsed = targetValue ? parseConnectTarget(targetValue) : null
          if (!parsed) {
            writeHttpErrorResponse(clientSocket, '400 Bad Request')
            return
          }

          const allowed = await args.shouldAllowNetworkRequest({
            host: parsed.host,
            port: parsed.port,
          })
          if (!allowed) {
            writeHttpErrorResponse(clientSocket, '403 Forbidden')
            return
          }

          const upstream = net.connect(parsed.port, parsed.host)
          upstream.once('error', () => {
            writeHttpErrorResponse(clientSocket, '502 Bad Gateway')
          })

          upstream.once('connect', () => {
            try {
              clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
            } catch {
              try {
                upstream.destroy()
              } catch {
                /* no-op */
              }
              return
            }

            if (remainder.length > 0) {
              try {
                upstream.write(remainder)
              } catch {
                /* no-op */
              }
            }

            clientSocket.pipe(upstream)
            upstream.pipe(clientSocket)
          })
        })()
        return
      }

      void (async () => {
        const hostHeader = headers['host'] ?? ''
        let targetUrl: URL | null = null
        if (target.startsWith('http://') || target.startsWith('https://')) {
          try {
            targetUrl = new URL(target)
          } catch {
            targetUrl = null
          }
        } else if (hostHeader) {
          try {
            targetUrl = new URL(
              `http://${hostHeader}${target.startsWith('/') ? target : '/' + target}`,
            )
          } catch {
            targetUrl = null
          }
        }

        if (!targetUrl) {
          writeHttpErrorResponse(clientSocket, '400 Bad Request')
          return
        }

        const port =
          targetUrl.port !== ''
            ? Number(targetUrl.port)
            : targetUrl.protocol === 'https:'
              ? 443
              : 80

        const allowed = await args.shouldAllowNetworkRequest({
          host: targetUrl.hostname,
          port,
        })
        if (!allowed) {
          writeHttpErrorResponse(clientSocket, '403 Forbidden')
          return
        }

        if (targetUrl.protocol === 'https:') {
          // Non-CONNECT HTTPS proxy requests are not supported; clients should use CONNECT.
          writeHttpErrorResponse(clientSocket, '400 Bad Request')
          return
        }

        delete headers['proxy-connection']
        delete headers['proxy-authorization']
        headers['connection'] = 'close'
        headers['host'] = targetUrl.host

        const upstream = net.connect(port, targetUrl.hostname)
        upstream.once('error', () => {
          writeHttpErrorResponse(clientSocket, '502 Bad Gateway')
        })

        upstream.once('connect', () => {
          const path = `${targetUrl.pathname}${targetUrl.search}`
          try {
            upstream.write(`${method} ${path} ${version}\r\n`)
            for (const [k, v] of Object.entries(headers)) {
              upstream.write(`${k}: ${v}\r\n`)
            }
            upstream.write('\r\n')
          } catch {
            writeHttpErrorResponse(clientSocket, '502 Bad Gateway')
            try {
              upstream.destroy()
            } catch {
              /* no-op */
            }
            return
          }

          if (remainder.length > 0) {
            try {
              upstream.write(remainder)
            } catch {
              /* no-op */
            }
          }

          clientSocket.pipe(upstream)
          upstream.pipe(clientSocket)
          upstream.once('end', () => {
            try {
              clientSocket.end()
            } catch {
              /* no-op */
            }
          })
        })
      })()
    }

    clientSocket.on('data', onData)
  })

  args.onServer(server)

  return new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.once('listening', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to get HTTP proxy address'))
        return
      }
      server.unref()
      resolve((addr as AddressInfo).port)
    })
    server.listen(0, '127.0.0.1')
  })
}
