import net from 'node:net'
import type { AddressInfo } from 'node:net'

type NetworkQuery = { host: string; port: number }

function buildSocks5Reply(rep: number): Buffer {
  // VER, REP, RSV, ATYP, BND.ADDR, BND.PORT (0.0.0.0:0)
  return Buffer.from([0x05, rep, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
}

function parseSocks5Request(
  buffer: Buffer,
): { host: string; port: number; remaining: Buffer } | null {
  if (buffer.length < 4) return null
  if (buffer[0] !== 0x05) return null
  const cmd = buffer[1]
  const atyp = buffer[3]
  if (cmd !== 0x01) return null

  let offset = 4
  let host = ''

  if (atyp === 0x01) {
    if (buffer.length < offset + 4 + 2) return null
    host = `${buffer[offset]}.${buffer[offset + 1]}.${buffer[offset + 2]}.${buffer[offset + 3]}`
    offset += 4
  } else if (atyp === 0x03) {
    if (buffer.length < offset + 1) return null
    const len = buffer[offset]!
    offset += 1
    if (buffer.length < offset + len + 2) return null
    host = buffer.slice(offset, offset + len).toString('utf8')
    offset += len
  } else if (atyp === 0x04) {
    if (buffer.length < offset + 16 + 2) return null
    const parts: string[] = []
    for (let i = 0; i < 16; i += 2) {
      parts.push(buffer.readUInt16BE(offset + i).toString(16))
    }
    host = parts.join(':')
    offset += 16
  } else {
    return null
  }

  const port = buffer.readUInt16BE(offset)
  offset += 2
  return { host, port, remaining: buffer.slice(offset) }
}

export async function startSocks5Proxy(args: {
  shouldAllowNetworkRequest: (query: NetworkQuery) => Promise<boolean>
  onServer: (server: net.Server) => void
}): Promise<number> {
  const server = net.createServer(socket => {
    let buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let stage: 'greeting' | 'request' = 'greeting'

    const onData = (chunk: Buffer<ArrayBufferLike>) => {
      buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk

      if (stage === 'greeting') {
        if (buffered.length < 2) return
        if (buffered[0] !== 0x05) {
          socket.end()
          return
        }

        const nMethods = buffered[1]!
        if (buffered.length < 2 + nMethods) return
        const methods = buffered.slice(2, 2 + nMethods)
        const supportsNoAuth = methods.includes(0x00)
        socket.write(Buffer.from([0x05, supportsNoAuth ? 0x00 : 0xff]))
        buffered = buffered.slice(2 + nMethods)
        if (!supportsNoAuth) {
          socket.end()
          return
        }
        stage = 'request'
      }

      if (stage === 'request') {
        const parsed = parseSocks5Request(buffered)
        if (!parsed) return
        buffered = parsed.remaining

        void (async () => {
          const allowed = await args.shouldAllowNetworkRequest({
            host: parsed.host,
            port: parsed.port,
          })
          if (!allowed) {
            socket.write(buildSocks5Reply(0x02))
            socket.end()
            return
          }

          const upstream = net.connect(parsed.port, parsed.host)
          upstream.once('error', () => {
            try {
              socket.write(buildSocks5Reply(0x05))
            } catch {
              /* no-op */
            }
            socket.end()
          })
          upstream.once('connect', () => {
            try {
              socket.write(buildSocks5Reply(0x00))
            } catch {
              try {
                upstream.destroy()
              } catch {
                /* no-op */
              }
              socket.end()
              return
            }
            socket.pipe(upstream)
            upstream.pipe(socket)
          })
        })()
      }
    }

    socket.on('data', onData)
  })

  args.onServer(server)

  return new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.once('listening', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to get SOCKS proxy address'))
        return
      }
      server.unref()
      resolve((addr as AddressInfo).port)
    })
    server.listen(0, '127.0.0.1')
  })
}
