import { afterAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { FileReadTool } from '@tools/FileReadTool/FileReadTool'

const tmpRoot = mkdtempSync(join(process.cwd(), '.tmp-test-file-read-tool-'))
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46,
])
const GIF_BYTES = Buffer.from('GIF89a', 'ascii')
const WEBP_BYTES = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'ascii'),
])

mock.module('sharp', () => {
  function sharp(input?: Buffer) {
    const api = {
      metadata: async () => ({ width: 1, height: 1 }),
      resize: () => api,
      jpeg: () => ({
        toBuffer: async () => JPEG_BYTES,
      }),
      png: () => ({
        toBuffer: async () => PNG_BYTES,
      }),
      toBuffer: async () => input ?? PNG_BYTES,
    }
    return api
  }

  return { default: sharp }
})

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

async function runRead(input: {
  file_path: string
  offset?: number
  limit?: number
}) {
  const ctx = { readFileTimestamps: {} as Record<string, number> }
  const gen = FileReadTool.call(input as any, ctx as any)
  for await (const item of gen as any) {
    if (item?.type === 'result') return item.data
  }
  return null
}

describe('FileReadTool parity: offset semantics', () => {
  test('offset=1 reads from first line and reports startLine=1', async () => {
    const filePath = join(tmpRoot, 'offset-1.txt')
    writeFileSync(filePath, 'a\nb\nc', 'utf8')

    const data = await runRead({ file_path: filePath, offset: 1, limit: 2 })
    expect(data?.type).toBe('text')
    expect(data.file.startLine).toBe(1)
    expect(data.file.content).toBe('a\nb')
  })

  test('offset=2 reads from second line and reports startLine=2', async () => {
    const filePath = join(tmpRoot, 'offset-2.txt')
    writeFileSync(filePath, 'a\nb\nc', 'utf8')

    const data = await runRead({ file_path: filePath, offset: 2, limit: 1 })
    expect(data?.type).toBe('text')
    expect(data.file.startLine).toBe(2)
    expect(data.file.content).toBe('b')
  })

  test('offset=0 is allowed and reports startLine=0', async () => {
    const filePath = join(tmpRoot, 'offset-0.txt')
    writeFileSync(filePath, 'a\nb\nc', 'utf8')

    const data = await runRead({ file_path: filePath, offset: 0, limit: 1 })
    expect(data?.type).toBe('text')
    expect(data.file.startLine).toBe(0)
    expect(data.file.content).toBe('a')
  })
})

describe('FileReadTool parity: validateInput gating', () => {
  test('rejects large file when offset/limit are missing', async () => {
    const filePath = join(tmpRoot, 'large.txt')
    writeFileSync(filePath, 'a'.repeat(300_000), 'utf8')

    const result = await FileReadTool.validateInput({
      file_path: filePath,
    } as any)
    expect(result.result).toBe(false)
    expect(result.message).toContain('offset and limit')
  })

  test('rejects binary extensions as text reads', async () => {
    const filePath = join(tmpRoot, 'sound.mp3')
    writeFileSync(filePath, 'not really an mp3', 'utf8')

    const result = await FileReadTool.validateInput({
      file_path: filePath,
    } as any)
    expect(result.result).toBe(false)
    expect(result.message).toContain('cannot read binary files')
  })

  test('rejects empty image files', async () => {
    const filePath = join(tmpRoot, 'empty.png')
    writeFileSync(filePath, '', 'utf8')

    const result = await FileReadTool.validateInput({
      file_path: filePath,
    } as any)
    expect(result.result).toBe(false)
    expect(result.message).toContain('Empty image files')
  })
})

describe('FileReadTool image handling', () => {
  test('preserves detected JPEG media type even when extension differs', async () => {
    const filePath = join(tmpRoot, 'mismatch.png')
    writeFileSync(filePath, JPEG_BYTES)

    const data = await runRead({ file_path: filePath })
    expect(data?.type).toBe('image')
    expect(data.file.type).toBe('image/jpeg')
    expect(data.file.base64).toBe(JPEG_BYTES.toString('base64'))
  })

  test('preserves detected GIF media type', async () => {
    const filePath = join(tmpRoot, 'image.gif')
    writeFileSync(filePath, GIF_BYTES)

    const data = await runRead({ file_path: filePath })
    expect(data?.type).toBe('image')
    expect(data.file.type).toBe('image/gif')
  })

  test('preserves detected WebP media type', async () => {
    const filePath = join(tmpRoot, 'image.webp')
    writeFileSync(filePath, WEBP_BYTES)

    const data = await runRead({ file_path: filePath })
    expect(data?.type).toBe('image')
    expect(data.file.type).toBe('image/webp')
  })

  test('rasterizes SVG files and returns PNG image data', async () => {
    const filePath = join(tmpRoot, 'vector.svg')
    writeFileSync(
      filePath,
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" />',
      'utf8',
    )

    const data = await runRead({ file_path: filePath })
    expect(data?.type).toBe('image')
    expect(data.file.type).toBe('image/png')
    expect(data.file.base64).toBe(PNG_BYTES.toString('base64'))
  })
})
