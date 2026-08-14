import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  appendTaskOutput,
  flushAllTaskOutputs,
  flushTaskOutput,
  getTaskOutputStoreFilePath,
  getTaskOutputsStoreDir,
  MAX_OUTPUT_FILE_BYTES,
  readTaskOutputDelta,
  readTaskOutputTail,
  readTaskOutputTailLines,
  touchTaskOutputFile,
} from './taskOutputStore'

const ENV_KEYS = ['KODE_CONFIG_DIR', 'KODE_PROJECT_DIR'] as const
let temporaryRoot = ''
let previousEnv: Record<(typeof ENV_KEYS)[number], string | undefined>

beforeEach(() => {
  previousEnv = Object.fromEntries(
    ENV_KEYS.map(key => [key, process.env[key]]),
  ) as Record<(typeof ENV_KEYS)[number], string | undefined>
  temporaryRoot = mkdtempSync(join(tmpdir(), 'kode-task-output-'))
  process.env.KODE_CONFIG_DIR = join(temporaryRoot, 'kode')
  process.env.KODE_PROJECT_DIR = join(temporaryRoot, 'project')
})

test('incremental output uses byte offsets for multibyte text', () => {
  const taskId = 'delta-output'
  touchTaskOutputFile(taskId)
  appendTaskOutput(taskId, '你好')

  const first = readTaskOutputDelta(taskId, 0)
  expect(first).toEqual({ content: '你好', newOffset: 6 })
  appendTaskOutput(taskId, '世界')
  expect(readTaskOutputDelta(taskId, first.newOffset)).toEqual({
    content: '世界',
    newOffset: 12,
  })
})

afterEach(() => {
  flushAllTaskOutputs()
  for (const key of ENV_KEYS) {
    const previous = previousEnv[key]
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  }
  rmSync(temporaryRoot, { recursive: true, force: true })
})

test('buffers small stream chunks until a read or explicit flush needs them', () => {
  const taskId = 'buffered-output'
  touchTaskOutputFile(taskId)
  appendTaskOutput(taskId, 'first ')
  appendTaskOutput(taskId, 'second')

  expect(readFileSync(getTaskOutputStoreFilePath(taskId), 'utf8')).toBe('')

  flushTaskOutput(taskId)
  expect(readFileSync(getTaskOutputStoreFilePath(taskId), 'utf8')).toBe(
    'first second',
  )
})

test('flushes a quiet stream batch on its bounded timer', async () => {
  const taskId = 'timed-output'
  touchTaskOutputFile(taskId)
  appendTaskOutput(taskId, 'eventual output')

  await new Promise(resolve => setTimeout(resolve, 80))

  expect(readFileSync(getTaskOutputStoreFilePath(taskId), 'utf8')).toBe(
    'eventual output',
  )
})

test('read APIs flush buffered output before calculating a delta', () => {
  const taskId = 'buffered-delta'
  touchTaskOutputFile(taskId)
  appendTaskOutput(taskId, '你好')

  expect(readTaskOutputDelta(taskId, 0)).toEqual({
    content: '你好',
    newOffset: 6,
  })
})

test('task output is private and tail reads stay byte-bounded', () => {
  const taskId = 'bounded-output'
  touchTaskOutputFile(taskId)
  appendTaskOutput(taskId, 'a'.repeat(2 * 1024 * 1024) + 'THE-END')

  const tail = readTaskOutputTail(taskId, 4_096)

  expect(tail.wasTruncated).toBe(true)
  expect(Buffer.byteLength(tail.content)).toBeLessThanOrEqual(4_096)
  expect(tail.content.endsWith('THE-END')).toBe(true)
  if (process.platform !== 'win32') {
    expect(statSync(getTaskOutputsStoreDir()).mode & 0o777).toBe(0o700)
    expect(statSync(getTaskOutputStoreFilePath(taskId)).mode & 0o777).toBe(
      0o600,
    )
  }
})

test('large single-line output remains visible through the bounded line tail', () => {
  const taskId = 'single-line-output'
  touchTaskOutputFile(taskId)
  appendTaskOutput(taskId, 'x'.repeat(2 * 1024 * 1024) + 'THE-END')

  const lines = readTaskOutputTailLines(taskId, 10)

  expect(lines[0]).toBe('[Earlier output omitted; showing partial final line]')
  expect(lines.at(-1)?.endsWith('THE-END')).toBe(true)
  expect(Buffer.byteLength(lines.join('\n'))).toBeLessThanOrEqual(4_200)
})

test('caps the on-disk output file at the byte budget and keeps the newest output', () => {
  const taskId = 'capped-file'
  touchTaskOutputFile(taskId)
  const chunks = ['a', 'b', 'c', 'd', 'e'].map(letter =>
    letter.repeat(300 * 1024),
  )
  for (const chunk of chunks) appendTaskOutput(taskId, chunk)
  flushTaskOutput(taskId)

  const filePath = getTaskOutputStoreFilePath(taskId)
  expect(statSync(filePath).size).toBeLessThanOrEqual(MAX_OUTPUT_FILE_BYTES)
  const content = readFileSync(filePath, 'utf8')
  // The newest output always wins: the last chunk survives in full.
  expect(content.endsWith(chunks.at(-1)!)).toBe(true)
})

test('never splits a multi-byte character at the output trim boundary', () => {
  const taskId = 'capped-multibyte'
  touchTaskOutputFile(taskId)
  appendTaskOutput(taskId, '你好'.repeat(200 * 1024))
  flushTaskOutput(taskId)

  const fileContent = readFileSync(getTaskOutputStoreFilePath(taskId), 'utf8')
  expect(Buffer.byteLength(fileContent)).toBeLessThanOrEqual(
    MAX_OUTPUT_FILE_BYTES,
  )
  expect(fileContent.includes('\uFFFD')).toBe(false)
})
