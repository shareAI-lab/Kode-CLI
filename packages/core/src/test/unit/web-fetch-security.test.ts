import { describe, expect, test } from 'bun:test'

import {
  assertPublicWebFetchTarget,
  createPinnedLookup,
  fetchWithRedirectDetection,
  isPublicNetworkAddress,
  isValidWebFetchUrl,
} from '#tools/tools/network/WebFetchTool/utils'

describe('WebFetch network boundary', () => {
  test('rejects private and special-use IPv4 and IPv6 literals', () => {
    const blocked = [
      '127.0.0.1',
      '169.254.169.254',
      '10.0.0.1',
      '100.64.0.1',
      '0.0.0.0',
      // 0.0.0.0/8 routes to the loopback interface on Linux.
      '0.1.2.3',
      '0.255.255.255',
      '::1',
      'fc00::1',
      'fe80::1',
      '::ffff:7f00:1',
      '64:ff9b::7f00:1',
      '2001:db8::1',
    ]

    for (const address of blocked) {
      expect(isPublicNetworkAddress(address)).toBe(false)
    }
    expect(isPublicNetworkAddress('8.8.8.8')).toBe(true)
    expect(isPublicNetworkAddress('2606:4700:4700::1111')).toBe(true)
  })

  test('allows the 198.18.0.0/15 benchmarking range used by proxy fake-ip', () => {
    // RFC 2544 benchmarking space is not routed on the public internet and
    // cannot reach internal networks; Clash/Surge fake-ip maps it as a
    // virtual range whose traffic is forwarded to the validated hostname.
    expect(isPublicNetworkAddress('198.18.0.1')).toBe(true)
    expect(isPublicNetworkAddress('198.18.2.61')).toBe(true)
    expect(isPublicNetworkAddress('198.19.255.255')).toBe(true)
  })

  test('normalizes alternate IP spellings before validating URLs', () => {
    expect(isValidWebFetchUrl('https://example.com/docs')).toBe(true)
    expect(isValidWebFetchUrl('http://2130706433/')).toBe(false)
    expect(isValidWebFetchUrl('http://0177.0.0.1/')).toBe(false)
    expect(isValidWebFetchUrl('http://[::ffff:127.0.0.1]/')).toBe(false)
    expect(isValidWebFetchUrl('http://user:pass@example.com/')).toBe(false)
  })

  test('rejects hostnames when any DNS result is non-public', async () => {
    await expect(
      assertPublicWebFetchTarget('https://service.example/', async () => [
        { address: '93.184.216.34' },
        { address: '10.0.0.4' },
      ]),
    ).rejects.toThrow('non-public network address')

    await expect(
      assertPublicWebFetchTarget('https://service.example/', async () => [
        { address: '93.184.216.34' },
      ]),
    ).resolves.toBeUndefined()
  })

  test('pins transport lookups to the addresses that passed validation', async () => {
    const approved = [
      { address: '93.184.216.34', family: 4 as const },
      { address: '2606:4700:4700::1111', family: 6 as const },
    ]
    const pinnedLookup = createPinnedLookup(approved)

    const resolved = await new Promise<unknown[]>((resolve, reject) => {
      pinnedLookup('rebound.example', { all: true }, (error, addresses) => {
        if (error) {
          reject(error)
          return
        }
        resolve(Array.isArray(addresses) ? addresses : [addresses])
      })
    })

    expect(resolved).toEqual(approved)
  })

  test('revalidates same-host redirect targets and stops redirect loops', async () => {
    let fetchCalls = 0
    let lookupCalls = 0
    const response = await fetchWithRedirectDetection(
      'https://service.example/start',
      new AbortController().signal,
      {
        lookupHostname: async () => {
          lookupCalls += 1
          return [{ address: '93.184.216.34' }]
        },
        fetchImpl: async (url, _init, target) => {
          fetchCalls += 1
          expect(target.addresses).toEqual([
            { address: '93.184.216.34', family: 4 },
          ])
          return new Response('', {
            status: 303,
            headers: { location: `${new URL(url).pathname}/next` },
          })
        },
      },
    ).catch(error => error)

    expect(response).toBeInstanceOf(Error)
    expect((response as Error).message).toContain('Too many redirects')
    expect(fetchCalls).toBe(10)
    expect(lookupCalls).toBe(10)
  })
})
