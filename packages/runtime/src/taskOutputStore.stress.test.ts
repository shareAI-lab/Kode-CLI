import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  appendTaskOutput,
  flushAllTaskOutputs,
  readTaskOutputTail,
  touchTaskOutputFile,
} from './taskOutputStore'

const ENV_KEYS = ['KODE_CONFIG_DIR', 'KODE_PROJECT_DIR'] as const
let temporaryRoot = ''
let previousEnv: Record<(typeof ENV_KEYS)[number], string | undefined>

beforeEach(() => {
  previousEnv = Object.fromEntries(
    ENV_KEYS.map(key => [key, process.env[key]]),
  ) as Record<(typeof ENV_KEYS)[number], string | undefined>
  temporaryRoot = mkdtempSync(join(tmpdir(), 'kode-task-output-stress-'))
  process.env.KODE_CONFIG_DIR = join(temporaryRoot, 'kode')
  process.env.KODE_PROJECT_DIR = join(temporaryRoot, 'project')
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

test('coalesces high-frequency small chunks before writing task output', () => {
  const taskId = 'small-chunks'
  const chunk = 'x'.repeat(1024)
  touchTaskOutputFile(taskId)

  const startedAt = performance.now()
  for (let index = 0; index < 1_024; index += 1) {
    appendTaskOutput(taskId, chunk)
  }
  const appendDurationMs = performance.now() - startedAt
  flushAllTaskOutputs()

  const tail = readTaskOutputTail(taskId, 2_048)
  expect(appendDurationMs).toBeLessThan(150)
  expect(tail.content).toHaveLength(2_048)
})

test('100 MB task output is read with bounded latency and memory', () => {
  const taskId = 'large-output'
  const chunk = Buffer.alloc(1024 * 1024, 97).toString('utf8')
  touchTaskOutputFile(taskId)
  for (let index = 0; index < 100; index += 1) {
    appendTaskOutput(taskId, chunk)
  }
  appendTaskOutput(taskId, 'THE-END')

  const beforeHeap = process.memoryUsage().heapUsed
  const startedAt = performance.now()
  const tail = readTaskOutputTail(taskId, 100_000)
  const durationMs = performance.now() - startedAt
  const heapDelta = Math.max(0, process.memoryUsage().heapUsed - beforeHeap)

  expect(tail.wasTruncated).toBe(true)
  expect(Buffer.byteLength(tail.content)).toBeLessThanOrEqual(100_000)
  expect(tail.content.endsWith('THE-END')).toBe(true)
  expect(durationMs).toBeLessThan(250)
  expect(heapDelta).toBeLessThan(8 * 1024 * 1024)
})
