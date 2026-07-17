import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createDurableRun,
  createHeadlessRunTelemetry,
  finishDurableRun,
} from '#core/runs'

describe('headless run telemetry', () => {
  test('redacts credentials and treats generic execution errors as non-retryable', () => {
    const telemetry = createHeadlessRunTelemetry({
      inputFormat: 'text',
      outputFormat: 'json',
      promptChars: 42,
      toolCount: 0,
      isError: true,
      resultSubtype: 'error_during_execution',
      error: 'Provider unavailable; api_key=super-secret-value',
    })

    expect(telemetry.failure).toMatchObject({
      kind: 'execution',
      retryable: false,
    })
    expect(telemetry.failure?.message).toContain('[REDACTED]')
    expect(telemetry.failure?.message).not.toContain('super-secret-value')
  })

  test('classifies structured provider failures when the subtype says so', () => {
    const telemetry = createHeadlessRunTelemetry({
      inputFormat: 'text',
      outputFormat: 'json',
      promptChars: 12,
      toolCount: 0,
      isError: true,
      resultSubtype: 'error_provider',
      error: 'upstream timeout',
    })

    expect(telemetry.failure).toMatchObject({
      kind: 'provider',
      retryable: true,
    })
    expect(telemetry.failure?.recommendedAction).toContain('backoff')
  })

  test('treats protocol limits as actionable incomplete runs', () => {
    const telemetry = createHeadlessRunTelemetry({
      inputFormat: 'text',
      outputFormat: 'json',
      promptChars: 12,
      toolCount: 0,
      resultSubtype: 'error_max_turns',
      numTurns: 2,
    })

    expect(telemetry.failure).toMatchObject({
      kind: 'turn_limit',
      retryable: false,
    })
    expect(telemetry.failure?.recommendedAction).toContain('--max-turns')
  })

  test('separates invalid headless configuration from model execution failure', () => {
    const telemetry = createHeadlessRunTelemetry({
      inputFormat: 'text',
      outputFormat: 'json',
      promptChars: 12,
      toolCount: 0,
      isError: true,
      resultSubtype: 'error_invalid_json_schema',
      error: 'Unexpected token',
    })

    expect(telemetry.failure).toMatchObject({
      kind: 'configuration',
      retryable: false,
    })
    expect(telemetry.failure?.recommendedAction).toContain('option or schema')
  })

  test('persists telemetry on durable run finish', () => {
    const storageRoot = mkdtempSync(join(tmpdir(), 'kode-headless-telemetry-'))
    try {
      createDurableRun({
        id: 'agent-headless',
        kind: 'agent',
        cwd: storageRoot,
        command: 'headless',
        storageRoot,
        now: 1,
      })
      const telemetry = createHeadlessRunTelemetry({
        inputFormat: 'text',
        outputFormat: 'json',
        promptChars: 3,
        toolCount: 1,
        resultSubtype: 'error_max_budget_usd',
        totalCostUsd: 1.25,
      })
      const finished = finishDurableRun({
        id: 'agent-headless',
        status: 'failed',
        error: telemetry.failure?.message,
        telemetry,
        storageRoot,
        now: 2,
      })
      expect(finished?.status).toBe('failed')
      expect(finished?.telemetry?.failure?.kind).toBe('budget_limit')
      const onDisk = JSON.parse(
        readFileSync(join(storageRoot, 'agent-headless.json'), 'utf8'),
      ) as { telemetry?: { failure?: { kind?: string } } }
      expect(onDisk.telemetry?.failure?.kind).toBe('budget_limit')
    } finally {
      rmSync(storageRoot, { recursive: true, force: true })
    }
  })
})
