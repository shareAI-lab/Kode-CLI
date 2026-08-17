import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync, gzipSync } from 'node:zlib'
import { strToU8, zipSync } from 'fflate'
import {
  extractTarBuffer,
  extractTarGzBuffer,
  extractZipBuffer,
} from '#core/utils/archive/extract'

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function tarHeader(options: {
  name: string
  typeflag: '0' | '5'
  size: number
  mode?: number
}): Buffer {
  const header = Buffer.alloc(512, 0)

  header.write(options.name, 0, 100, 'utf8')

  const mode = options.mode ?? (options.typeflag === '5' ? 0o755 : 0o644)
  header.write(mode.toString(8).padStart(7, '0') + '\0', 100, 8, 'ascii')
  header.write('0000000\0', 108, 8, 'ascii') // uid
  header.write('0000000\0', 116, 8, 'ascii') // gid
  header.write(
    options.size.toString(8).padStart(11, '0') + '\0',
    124,
    12,
    'ascii',
  )
  header.write('00000000000\0', 136, 12, 'ascii') // mtime
  header.write('        ', 148, 8, 'ascii') // checksum placeholder
  header.write(options.typeflag, 156, 1, 'ascii')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')

  let checksum = 0
  for (const byte of header) checksum += byte
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')

  return header
}

function pad512(buf: Buffer): Buffer {
  const pad = (512 - (buf.length % 512)) % 512
  if (pad === 0) return buf
  return Buffer.concat([buf, Buffer.alloc(pad, 0)])
}

function buildTar(
  entries: Array<{ path: string; type: 'file' | 'dir'; data?: Buffer }>,
): Buffer {
  const chunks: Buffer[] = []
  for (const entry of entries) {
    if (entry.type === 'dir') {
      const name = entry.path.endsWith('/') ? entry.path : `${entry.path}/`
      chunks.push(tarHeader({ name, typeflag: '5', size: 0 }))
      continue
    }

    const data = entry.data ?? Buffer.alloc(0)
    chunks.push(
      tarHeader({ name: entry.path, typeflag: '0', size: data.length }),
    )
    chunks.push(pad512(data))
  }
  chunks.push(Buffer.alloc(1024, 0))
  return Buffer.concat(chunks)
}

describe('archive extraction (zip + tar.gz)', () => {
  test('extractZipBuffer writes files (stripComponents + filter)', async () => {
    const zip = zipSync({
      'root/bin/rg.exe': strToU8('hello'),
      'root/README.txt': strToU8('readme'),
      'root/bin/': strToU8(''),
    })

    const outDir = makeTempDir('kode-zip-extract-')
    try {
      await extractZipBuffer(zip, outDir, {
        stripComponents: 1,
        filter: p => p === 'bin/rg.exe',
      })

      expect(readFileSync(join(outDir, 'bin', 'rg.exe'), 'utf8')).toBe('hello')
      expect(existsSync(join(outDir, 'README.txt'))).toBe(false)
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  })

  test('extractTarGzBuffer writes files (stripComponents)', async () => {
    const tar = buildTar([
      { path: 'root/bin', type: 'dir' },
      { path: 'root/bin/rg', type: 'file', data: Buffer.from('hello') },
      { path: 'root/README.txt', type: 'file', data: Buffer.from('readme') },
    ])
    const tgz = gzipSync(tar)

    const outDir = makeTempDir('kode-tgz-extract-')
    try {
      await extractTarGzBuffer(new Uint8Array(tgz), outDir, {
        stripComponents: 1,
      })
      expect(readFileSync(join(outDir, 'bin', 'rg'), 'utf8')).toBe('hello')
      expect(readFileSync(join(outDir, 'README.txt'), 'utf8')).toBe('readme')
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  })

  test('rejects path traversal entries', async () => {
    const zip = zipSync({ '../evil.txt': strToU8('nope') })
    const outDir = makeTempDir('kode-zip-traversal-')
    try {
      await expect(extractZipBuffer(zip, outDir)).rejects.toThrow(
        'Unsafe archive path',
      )
      expect(existsSync(join(outDir, '..', 'evil.txt'))).toBe(false)
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }

    const tar = buildTar([
      { path: '../evil.txt', type: 'file', data: Buffer.from('nope') },
    ])
    const tgz = gzipSync(tar)
    const outDir2 = makeTempDir('kode-tgz-traversal-')
    try {
      await expect(
        extractTarGzBuffer(new Uint8Array(tgz), outDir2),
      ).rejects.toThrow('Unsafe archive path')
      expect(existsSync(join(outDir2, '..', 'evil.txt'))).toBe(false)
    } finally {
      rmSync(outDir2, { recursive: true, force: true })
    }
  })

  test('rejects ZIP expansion limits before writing any files', async () => {
    const zip = zipSync({
      'root/ok.txt': strToU8('ok'),
      'root/large.txt': strToU8('x'.repeat(64)),
    })
    const outDir = makeTempDir('kode-zip-limits-')
    try {
      await expect(
        extractZipBuffer(zip, outDir, {
          stripComponents: 1,
          limits: { maxEntryBytes: 16 },
        }),
      ).rejects.toThrow('exceeds limit 16 bytes')
      expect(existsSync(join(outDir, 'ok.txt'))).toBe(false)
      expect(existsSync(join(outDir, 'large.txt'))).toBe(false)
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  })

  test('rejects duplicate normalized ZIP output paths', async () => {
    const zip = zipSync({
      'root/a/file.txt': strToU8('first'),
      'root/a\\file.txt': strToU8('second'),
    })
    const outDir = makeTempDir('kode-zip-duplicate-')
    try {
      await expect(
        extractZipBuffer(zip, outDir, { stripComponents: 1 }),
      ).rejects.toThrow('Duplicate archive output path')
      expect(existsSync(join(outDir, 'a', 'file.txt'))).toBe(false)
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  })

  test('detects case-only collisions on case-folding file systems', async () => {
    const zip = zipSync({
      'root/A.txt': strToU8('upper'),
      'root/a.txt': strToU8('lower'),
    })
    const outDir = makeTempDir('kode-zip-case-')
    try {
      const caseFolding =
        process.platform === 'darwin' || process.platform === 'win32'
      if (caseFolding) {
        await expect(
          extractZipBuffer(zip, outDir, { stripComponents: 1 }),
        ).rejects.toThrow('Duplicate archive output path')
      } else {
        await extractZipBuffer(zip, outDir, { stripComponents: 1 })
        expect(readFileSync(join(outDir, 'A.txt'), 'utf8')).toBe('upper')
        expect(readFileSync(join(outDir, 'a.txt'), 'utf8')).toBe('lower')
      }
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  })

  test('rejects ZIP file/directory hierarchy conflicts before writing', async () => {
    const zip = zipSync({
      'root/a/child.txt': strToU8('child'),
      'root/a': strToU8('file'),
    })
    const outDir = makeTempDir('kode-zip-hierarchy-')
    try {
      await expect(
        extractZipBuffer(zip, outDir, { stripComponents: 1 }),
      ).rejects.toThrow('conflicts with an existing directory path')
      expect(existsSync(join(outDir, 'a'))).toBe(false)
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  })

  test('rejects tar limits and corrupt headers before writing any files', async () => {
    const tar = buildTar([
      { path: 'root/ok.txt', type: 'file', data: Buffer.from('ok') },
      {
        path: 'root/large.txt',
        type: 'file',
        data: Buffer.from('x'.repeat(64)),
      },
    ])
    const outDir = makeTempDir('kode-tar-limits-')
    try {
      await expect(
        extractTarGzBuffer(new Uint8Array(gzipSync(tar)), outDir, {
          stripComponents: 1,
          limits: { maxEntryBytes: 16 },
        }),
      ).rejects.toThrow('exceeds limit 16 bytes')
      expect(existsSync(join(outDir, 'ok.txt'))).toBe(false)

      const corrupt = Buffer.from(tar)
      corrupt[0] = corrupt[0]! ^ 1
      await expect(
        extractTarGzBuffer(new Uint8Array(gzipSync(corrupt)), outDir, {
          stripComponents: 1,
        }),
      ).rejects.toThrow('Invalid tar header checksum')
      expect(existsSync(join(outDir, 'ok.txt'))).toBe(false)
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  })

  test('caps tar.gz decompression output', async () => {
    const tar = buildTar([
      {
        path: 'root/large.txt',
        type: 'file',
        data: Buffer.from('x'.repeat(2048)),
      },
    ])
    const outDir = makeTempDir('kode-tgz-output-limit-')
    try {
      await expect(
        extractTarGzBuffer(new Uint8Array(gzipSync(tar)), outDir, {
          limits: { maxExtractedBytes: 1024 },
        }),
      ).rejects.toThrow('Failed to decompress tar.gz within')
      expect(existsSync(join(outDir, 'root', 'large.txt'))).toBe(false)
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  })

  test('does not charge tar headers and padding against file byte limits', async () => {
    const content = Buffer.alloc(1024, 0x61)
    const tar = buildTar([
      { path: 'root/exact-limit.txt', type: 'file', data: content },
    ])
    expect(tar.byteLength).toBeGreaterThan(content.byteLength)

    const outDir = makeTempDir('kode-tar-content-budget-')
    try {
      await extractTarGzBuffer(new Uint8Array(gzipSync(tar)), outDir, {
        stripComponents: 1,
        limits: { maxExtractedBytes: content.byteLength },
      })
      expect(readFileSync(join(outDir, 'exact-limit.txt'))).toEqual(content)
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  })

  test('applies archive input limits to raw tar buffers', async () => {
    const tar = buildTar([
      { path: 'root/file.txt', type: 'file', data: Buffer.from('hello') },
    ])
    const outDir = makeTempDir('kode-tar-input-limit-')
    try {
      await expect(
        extractTarBuffer(new Uint8Array(tar), outDir, {
          limits: { maxArchiveBytes: 512 },
        }),
      ).rejects.toThrow('exceeds limit 512 bytes')
      expect(existsSync(join(outDir, 'root', 'file.txt'))).toBe(false)
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  })

  test('rejects invalid extraction limits', async () => {
    const zip = zipSync({ 'file.txt': strToU8('hello') })
    const outDir = makeTempDir('kode-archive-invalid-limit-')
    try {
      await expect(
        extractZipBuffer(zip, outDir, { limits: { maxEntries: 0 } }),
      ).rejects.toThrow('maxEntries must be a positive integer')
      expect(existsSync(join(outDir, 'file.txt'))).toBe(false)
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  })

  test('rejects ZIP entries whose decompressed output exceeds the declared size', async () => {
    // Hand-built local-header-only zip: compression deflate, declared
    // uncompressed size of 8 bytes while the payload actually inflates to
    // 4096 bytes. fflate's fixed-buffer inflate would silently truncate this;
    // the bounded decoder must abort instead.
    const payload = Buffer.from('x'.repeat(4096))
    const deflated = deflateRawSync(payload)
    const name = 'bomb.txt'

    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0) // local file header signature
    header.writeUInt16LE(20, 4) // version needed to extract
    header.writeUInt16LE(0, 6) // general purpose flags
    header.writeUInt16LE(8, 8) // compression method: deflate
    header.writeUInt16LE(0, 10) // last mod time
    header.writeUInt16LE(0, 12) // last mod date
    header.writeUInt32LE(0, 14) // crc-32 (unchecked by the stream parser)
    header.writeUInt32LE(deflated.byteLength, 18) // compressed size
    header.writeUInt32LE(8, 22) // declared uncompressed size (lying)
    header.writeUInt16LE(name.length, 26) // file name length
    header.writeUInt16LE(0, 28) // extra field length

    const zip = Buffer.concat([header, Buffer.from(name), deflated])

    const outDir = makeTempDir('kode-zip-bomb-')
    try {
      await expect(extractZipBuffer(zip, outDir)).rejects.toThrow(
        'exceeds decompressed size budget',
      )
      expect(existsSync(join(outDir, name))).toBe(false)
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  })
})
