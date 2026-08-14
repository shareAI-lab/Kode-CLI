import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendJsonlAsync,
  flushPendingSync,
  flushJsonlWrites,
} from './jsonlWriter'

const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'jsonl-writer-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('appendJsonlAsync', () => {
  test('writes lines in call order and flushes on demand', async () => {
    const root = tempRoot()
    const file = join(root, 'a.jsonl')

    appendJsonlAsync({ filePath: file, entry: '{"n":1}\n' })
    appendJsonlAsync({ filePath: file, entry: '{"n":2}\n' })
    appendJsonlAsync({ filePath: file, entry: '{"n":3}\n' })

    await flushJsonlWrites(file)

    expect(readFileSync(file, 'utf8')).toBe('{"n":1}\n{"n":2}\n{"n":3}\n')
  })

  test('coalesces same-file writes into one append', async () => {
    const root = tempRoot()
    const file = join(root, 'b.jsonl')

    appendJsonlAsync({ filePath: file, entry: '1\n' })
    appendJsonlAsync({ filePath: file, entry: '2\n' })
    appendJsonlAsync({ filePath: file, entry: '3\n' })
    await flushJsonlWrites(file)

    expect(readFileSync(file, 'utf8')).toBe('1\n2\n3\n')
  })

  test('keeps separate files independent', async () => {
    const root = tempRoot()
    const fileA = join(root, 'a.jsonl')
    const fileB = join(root, 'b.jsonl')

    appendJsonlAsync({ filePath: fileA, entry: 'A1\n' })
    appendJsonlAsync({ filePath: fileB, entry: 'B1\n' })
    appendJsonlAsync({ filePath: fileA, entry: 'A2\n' })

    await flushJsonlWrites()

    expect(readFileSync(fileA, 'utf8')).toBe('A1\nA2\n')
    expect(readFileSync(fileB, 'utf8')).toBe('B1\n')
  })

  test('creates missing parent directories', async () => {
    const root = tempRoot()
    const file = join(root, 'deep', 'nested', 'c.jsonl')

    appendJsonlAsync({ filePath: file, entry: 'x\n' })
    await flushJsonlWrites(file)

    expect(readFileSync(file, 'utf8')).toBe('x\n')
  })

  test('rejects a failed flush and retries the retained batch before later data', async () => {
    const root = tempRoot()
    const file = join(root, 'blocked.jsonl')
    mkdirSync(file)

    appendJsonlAsync({ filePath: file, entry: 'first\n' })
    await expect(flushJsonlWrites(file)).rejects.toMatchObject({
      code: 'EISDIR',
    })

    rmSync(file, { recursive: true, force: true })
    appendJsonlAsync({ filePath: file, entry: 'second\n' })
    await flushJsonlWrites(file)

    expect(readFileSync(file, 'utf8')).toBe('first\nsecond\n')
  })

  test('retains a failed synchronous read-path flush for later recovery', async () => {
    const root = tempRoot()
    const file = join(root, 'blocked-sync.jsonl')
    mkdirSync(file)

    appendJsonlAsync({ filePath: file, entry: 'first\n' })
    flushPendingSync(file)

    rmSync(file, { recursive: true, force: true })
    await flushJsonlWrites(file)

    expect(readFileSync(file, 'utf8')).toBe('first\n')
  })
})
