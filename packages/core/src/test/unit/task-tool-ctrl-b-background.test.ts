import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TaskTool } from '#tools/tools/ai/TaskTool/TaskTool'
import {
  getBackgroundAgentTask,
  killBackgroundAgentTask,
} from '#core/utils/backgroundTasks'
import { createAssistantMessage } from '#core/utils/messages'
import { AgentSupervisor } from '#core/utils/agentSupervisor'
import { readDurableRun } from '#core/runs'

describe('TaskTool ctrl+b backgrounding parity', () => {
  test('can be backgrounded via the ctrl+b overlay callback', async () => {
    const previousNodeEnv = process.env.NODE_ENV
    const previousConfigDir = process.env.KODE_CONFIG_DIR
    const configDir = mkdtempSync(join(tmpdir(), 'kode-ctrl-b-durable-'))
    process.env.NODE_ENV = 'development'
    process.env.KODE_CONFIG_DIR = configDir

    async function* stubQuery() {
      yield createAssistantMessage('working')
      await new Promise(resolve => setTimeout(resolve, 2500))
      yield createAssistantMessage('done')
    }

    let triggered = false

    try {
      const events: any[] = []
      for await (const ev of TaskTool.call(
        {
          description: 'bg via ctrl+b',
          prompt: 'do it',
          subagent_type: 'general-purpose',
        },
        {
          abortController: new AbortController(),
          readFileTimestamps: {},
          messageId: 'm',
          options: {
            safeMode: false,
            forkNumber: 0,
            messageLogName: 'task-tool-ctrl-b-test',
            verbose: false,
            model: 'main',
            mcpClients: [],
          },
          __testQuery: stubQuery,
          setToolJSX: (value: any) => {
            if (triggered) return
            if (!value || !value.jsx) return
            const onKeypress = value.onKeypress
            if (typeof onKeypress !== 'function') return
            triggered = true
            setTimeout(
              () => onKeypress('b', { ctrl: true, meta: false, shift: false }),
              0,
            )
          },
        } as any,
      )) {
        events.push(ev)
      }

      expect(triggered).toBe(true)

      const result = events.find(e => e.type === 'result')
      expect(result).toBeTruthy()
      expect(result.data.status).toBe('async_launched')

      const agentId = result.data.agentId as string
      const task = getBackgroundAgentTask(agentId)
      expect(task).toBeTruthy()
      expect(task?.status).toBe('running')
      expect(AgentSupervisor.activeCount).toBe(1)
      expect(readDurableRun({ id: agentId })?.status).toBe('running')
      await task?.done
      expect(task?.status).not.toBe('running')
      expect(AgentSupervisor.activeCount).toBe(0)
      expect(readDurableRun({ id: agentId })?.status).toBe('completed')
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = previousNodeEnv
      if (previousConfigDir === undefined) delete process.env.KODE_CONFIG_DIR
      else process.env.KODE_CONFIG_DIR = previousConfigDir
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('explicit background stop cancels durable state and releases capacity', async () => {
    const previousNodeEnv = process.env.NODE_ENV
    const previousConfigDir = process.env.KODE_CONFIG_DIR
    const configDir = mkdtempSync(join(tmpdir(), 'kode-bg-stop-durable-'))
    process.env.NODE_ENV = 'development'
    process.env.KODE_CONFIG_DIR = configDir

    async function* stubQuery() {
      await new Promise<void>(() => {})
      yield createAssistantMessage('unreachable')
    }

    try {
      const generator = TaskTool.call(
        {
          description: 'stop durable background task',
          prompt: 'wait until stopped',
          subagent_type: 'general-purpose',
          run_in_background: true,
        },
        {
          abortController: new AbortController(),
          readFileTimestamps: {},
          messageId: 'm',
          options: {
            safeMode: false,
            forkNumber: 0,
            messageLogName: 'task-tool-stop-test',
            verbose: false,
            model: 'main',
            mcpClients: [],
          },
          __testQuery: stubQuery,
        },
      )

      const launched = await generator.next()
      if (launched.done || launched.value.type !== 'result') {
        throw new Error('Expected background launch result')
      }
      const agentId = launched.value.data.agentId
      const task = getBackgroundAgentTask(agentId)
      if (!task) throw new Error('Expected registered background task')
      expect(readDurableRun({ id: agentId })?.status).toBe('running')

      expect(killBackgroundAgentTask(agentId)).toBe(true)
      await task.done

      expect(task.status).toBe('killed')
      expect(readDurableRun({ id: agentId })?.status).toBe('cancelled')
      expect(AgentSupervisor.activeCount).toBe(0)
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = previousNodeEnv
      if (previousConfigDir === undefined) delete process.env.KODE_CONFIG_DIR
      else process.env.KODE_CONFIG_DIR = previousConfigDir
      rmSync(configDir, { recursive: true, force: true })
    }
  })
})
