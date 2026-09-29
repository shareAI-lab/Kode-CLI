import { beforeEach, describe, expect, test } from 'bun:test'
import { AskUserQuestionTool } from '#tools/tools/interaction/AskUserQuestionTool/AskUserQuestionTool'
import { TaskOutputTool } from '#tools/tools/system/TaskOutputTool/TaskOutputTool'
import { BashTool } from '#tools/tools/system/BashTool/BashTool'
import { FileReadTool } from '#tools/tools/filesystem/FileReadTool/FileReadTool'
import { FileWriteTool } from '#tools/tools/filesystem/FileWriteTool/FileWriteTool'
import { GrepTool } from '#tools/tools/search/GrepTool/GrepTool'
import { TaskStopTool } from '#tools/tools/system/TaskStopTool/TaskStopTool'
import { EnterPlanModeTool } from '#tools/tools/interaction/PlanModeTool/EnterPlanModeTool'
import { ExitPlanModeTool } from '#tools/tools/interaction/PlanModeTool/ExitPlanModeTool'
import { TaskTool } from '#tools/tools/ai/TaskTool/TaskTool'
import { TodoWriteTool } from '#tools/tools/interaction/TodoWriteTool/TodoWriteTool'
import { __resetPlanModeForTests } from '#core/plan/mode'
import { WebFetchTool } from '#tools/tools/network/WebFetchTool/WebFetchTool'

// Plan mode is process-global state: other suites force it on at startup, so
// without a reset this file's plan-mode assertions depend on execution order.
beforeEach(() => {
  __resetPlanModeForTests()
})

describe('Tool isReadOnly/isConcurrencySafe flags (compatibility)', () => {
  test('key tools match expected flags', () => {
    expect(TaskOutputTool.isReadOnly()).toBe(true)
    expect(TaskOutputTool.isConcurrencySafe()).toBe(true)

    expect(TaskStopTool.isReadOnly()).toBe(false)
    expect(TaskStopTool.isConcurrencySafe()).toBe(true)

    expect(TodoWriteTool.isReadOnly()).toBe(false)
    expect(TodoWriteTool.isConcurrencySafe()).toBe(false)

    expect(AskUserQuestionTool.isReadOnly()).toBe(true)
    expect(AskUserQuestionTool.isConcurrencySafe()).toBe(true)

    expect(FileReadTool.isReadOnly()).toBe(true)
    expect(FileReadTool.isConcurrencySafe()).toBe(true)

    expect(FileWriteTool.isReadOnly()).toBe(false)
    expect(FileWriteTool.isConcurrencySafe()).toBe(false)

    expect(GrepTool.isReadOnly()).toBe(true)
    expect(GrepTool.isConcurrencySafe()).toBe(true)

    expect(WebFetchTool.isReadOnly()).toBe(true)
    expect(WebFetchTool.isConcurrencySafe()).toBe(true)

    expect(EnterPlanModeTool.isReadOnly()).toBe(true)
    expect(EnterPlanModeTool.isConcurrencySafe()).toBe(true)

    expect(ExitPlanModeTool.isReadOnly()).toBe(false)
    expect(ExitPlanModeTool.isConcurrencySafe()).toBe(true)

    expect(TaskTool.isReadOnly()).toBe(true)
    expect(TaskTool.isConcurrencySafe()).toBe(true)
  })

  test('BashTool concurrency-safe equals read-only (Reference CLI y9)', () => {
    const readOnly = { command: 'pwd' }
    const notReadOnly = { command: 'cat foo > bar' }

    expect(BashTool.isReadOnly(readOnly)).toBe(true)
    expect(BashTool.isConcurrencySafe(readOnly)).toBe(true)
    expect(BashTool.isReadOnly(notReadOnly)).toBe(false)
    expect(BashTool.isConcurrencySafe(notReadOnly)).toBe(false)
  })
})
