import { beforeEach, describe, expect, test } from 'bun:test'
import { hasPermissionsToUseTool } from '#core/permissions'
import { hasReadPermission } from '#core/utils/permissions/filesystem'
import { getCwd } from '#core/utils/state'
import { FileEditTool } from '#tools/tools/filesystem/FileEditTool/FileEditTool'
import { FileReadTool } from '#tools/tools/filesystem/FileReadTool/FileReadTool'
import { FileWriteTool } from '#tools/tools/filesystem/FileWriteTool/FileWriteTool'
import { NotebookEditTool } from '#tools/tools/filesystem/NotebookEditTool/NotebookEditTool'
import {
  applyToolPermissionContextUpdates,
  createDefaultToolPermissionContext,
  type ToolPermissionContextUpdate,
} from '#core/types/toolPermissionContext'
import type { ToolUseContext } from '#core/tooling/Tool'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import path from 'path'
import {
  __resetPlanModeForTests,
  getPlanConversationKey,
  getPlanFilePath,
} from '#core/utils/planMode'
import { createAssistantMessage } from '#core/utils/messages'
import {
  getKodeAgentSessionId,
  setKodeAgentSessionId,
} from '#protocol/utils/kodeAgentSessionId'

function makeTempDir(prefix: string): string {
  return mkdtempSync(path.join(path.dirname(process.cwd()), `.tmp-${prefix}-`))
}

function makeContext(args?: {
  toolPermissionContext?: ReturnType<typeof createDefaultToolPermissionContext>
  messageLogName?: string
  forkNumber?: number
}): ToolUseContext {
  return {
    abortController: new AbortController(),
    messageId: 'test',
    options: {
      commands: [],
      tools: [],
      verbose: false,
      slowAndCapableModel: undefined,
      safeMode: false,
      forkNumber: args?.forkNumber ?? 0,
      messageLogName: args?.messageLogName ?? 'test',
      maxThinkingTokens: 0,
      toolPermissionContext: args?.toolPermissionContext,
    },
    readFileTimestamps: {},
  }
}

describe('Compatibility: filesystem permission engine', () => {
  beforeEach(() => {
    __resetPlanModeForTests()
  })

  test('fails closed when write tool permission input is unavailable', () => {
    expect(() => FileEditTool.needsPermissions(undefined)).not.toThrow()
    expect(FileEditTool.needsPermissions(undefined)).toBe(true)

    expect(() => FileWriteTool.needsPermissions(undefined)).not.toThrow()
    expect(FileWriteTool.needsPermissions(undefined)).toBe(true)

    expect(() => NotebookEditTool.needsPermissions(undefined)).not.toThrow()
    expect(NotebookEditTool.needsPermissions(undefined)).toBe(true)
  })

  test('uses the current directory permission context when read input is unavailable', () => {
    expect(() => FileReadTool.needsPermissions(undefined)).not.toThrow()
    expect(FileReadTool.needsPermissions(undefined)).toBe(
      !hasReadPermission(getCwd()),
    )
  })

  test('allows reading inside working directory by default', async () => {
    const toolPermissionContext = createDefaultToolPermissionContext({
      isBypassPermissionsModeAvailable: true,
    })
    const ctx = makeContext({ toolPermissionContext })

    const result = await hasPermissionsToUseTool(
      FileReadTool,
      { file_path: 'package.json' },
      ctx,
      createAssistantMessage(''),
    )

    expect(result.result).toBe(true)
  })

  test('asks to read outside working directory and provides suggestions', async () => {
    const tmp = makeTempDir('kode-perm-read')
    const filePath = path.join(tmp, 'a.txt')
    writeFileSync(filePath, 'hello', 'utf8')

    try {
      const toolPermissionContext = createDefaultToolPermissionContext({
        isBypassPermissionsModeAvailable: true,
      })
      const ctx = makeContext({ toolPermissionContext })

      const result = await hasPermissionsToUseTool(
        FileReadTool,
        { file_path: filePath },
        ctx,
        createAssistantMessage(''),
      )

      expect(result.result).toBe(false)
      if (result.result !== false) {
        throw new Error('Expected permission denied result')
      }
      expect(result.blockedPath).toBe(filePath)
      expect(result.decisionReason).toBe(
        'No allow rule matched (outside working directories)',
      )
      expect(result.requiresExplicitApproval).toBe(true)
      expect(result.suggestions?.length ?? 0).toBeGreaterThan(0)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('applying read suggestions allows subsequent reads', async () => {
    const tmp = makeTempDir('kode-perm-read-apply')
    const filePath = path.join(tmp, 'a.txt')
    writeFileSync(filePath, 'hello', 'utf8')

    try {
      const base = createDefaultToolPermissionContext({
        isBypassPermissionsModeAvailable: true,
      })
      const ctx = makeContext({ toolPermissionContext: base })

      const denied = await hasPermissionsToUseTool(
        FileReadTool,
        { file_path: filePath },
        ctx,
        createAssistantMessage(''),
      )

      expect(denied.result).toBe(false)
      if (denied.result !== false) {
        throw new Error('Expected permission denied result')
      }
      expect(denied.requiresExplicitApproval).toBe(true)
      const updates: ToolPermissionContextUpdate[] = denied.suggestions ?? []
      expect(updates.length).toBeGreaterThan(0)

      const updatedContext = applyToolPermissionContextUpdates(base, updates)
      const ctx2 = makeContext({ toolPermissionContext: updatedContext })
      const allowed = await hasPermissionsToUseTool(
        FileReadTool,
        { file_path: filePath },
        ctx2,
        createAssistantMessage(''),
      )
      expect(allowed.result).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('applying write suggestions allows subsequent writes via acceptEdits + addDirectories', async () => {
    const tmp = makeTempDir('kode-perm-write-apply')
    const filePath = path.join(tmp, 'b.txt')

    try {
      const base = createDefaultToolPermissionContext({
        isBypassPermissionsModeAvailable: true,
        mode: 'acceptEdits',
      })
      const ctx = makeContext({ toolPermissionContext: base })

      const denied = await hasPermissionsToUseTool(
        FileWriteTool,
        { file_path: filePath, content: 'hi' },
        ctx,
        createAssistantMessage(''),
      )

      expect(denied.result).toBe(false)
      if (denied.result !== false) {
        throw new Error('Expected permission denied result')
      }
      const updates: ToolPermissionContextUpdate[] = denied.suggestions ?? []
      expect(updates.length).toBeGreaterThan(0)
      expect(
        updates.some(u => u.type === 'setMode' && u.mode === 'acceptEdits'),
      ).toBe(true)
      expect(updates.some(u => u.type === 'addDirectories')).toBe(true)

      const updatedContext = applyToolPermissionContextUpdates(base, updates)
      const ctx2 = makeContext({ toolPermissionContext: updatedContext })
      const allowed = await hasPermissionsToUseTool(
        FileWriteTool,
        { file_path: filePath, content: 'hi' },
        ctx2,
        createAssistantMessage(''),
      )
      expect(allowed.result).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('allows writing to the plan file for the current conversation', async () => {
    const tmpConfig = makeTempDir('kode-plan-config')
    const previousConfigDir = process.env.KODE_CONFIG_DIR
    process.env.KODE_CONFIG_DIR = tmpConfig

    try {
      const toolPermissionContext = createDefaultToolPermissionContext({
        isBypassPermissionsModeAvailable: true,
        mode: 'acceptEdits',
      })
      const ctx = makeContext({
        toolPermissionContext,
        messageLogName: 'plan-test',
        forkNumber: 0,
      })

      const conversationKey = getPlanConversationKey(ctx)
      const planFilePath = getPlanFilePath(undefined, conversationKey)
      mkdirSync(path.dirname(planFilePath), { recursive: true })

      const result = await hasPermissionsToUseTool(
        FileWriteTool,
        { file_path: planFilePath, content: 'plan' },
        ctx,
        createAssistantMessage(''),
      )
      expect(result.result).toBe(true)
    } finally {
      if (previousConfigDir === undefined) delete process.env.KODE_CONFIG_DIR
      else process.env.KODE_CONFIG_DIR = previousConfigDir
      rmSync(tmpConfig, { recursive: true, force: true })
    }
  })

  test('allows reading session-memory files for the current session (kode root + claude compat root)', async () => {
    const tmpRoots = makeTempDir('kode-perm-roots')
    const tmpKodeRoot = path.join(tmpRoots, '.kode')
    const tmpClaudeRoot = path.join(tmpRoots, '.claude')
    mkdirSync(tmpKodeRoot, { recursive: true })
    mkdirSync(tmpClaudeRoot, { recursive: true })

    const previousKodeConfigDir = process.env.KODE_CONFIG_DIR
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    const previousSessionId = getKodeAgentSessionId()

    process.env.KODE_CONFIG_DIR = tmpKodeRoot
    process.env.CLAUDE_CONFIG_DIR = tmpClaudeRoot
    setKodeAgentSessionId('session-perm-test')

    try {
      const toolPermissionContext = createDefaultToolPermissionContext({
        isBypassPermissionsModeAvailable: true,
      })
      const ctx = makeContext({ toolPermissionContext })

      const projectKey = process.cwd().replace(/[^a-zA-Z0-9]/g, '-')
      const sessionId = getKodeAgentSessionId()

      const kodeSessionMemoryFile = path.join(
        tmpKodeRoot,
        'projects',
        projectKey,
        sessionId,
        'session-memory',
        'summary.md',
      )
      mkdirSync(path.dirname(kodeSessionMemoryFile), { recursive: true })
      writeFileSync(kodeSessionMemoryFile, 'test', 'utf8')

      const claudeSessionMemoryFile = path.join(
        tmpClaudeRoot,
        'projects',
        projectKey,
        sessionId,
        'session-memory',
        'summary.md',
      )
      mkdirSync(path.dirname(claudeSessionMemoryFile), { recursive: true })
      writeFileSync(claudeSessionMemoryFile, 'test', 'utf8')

      const kodeRead = await hasPermissionsToUseTool(
        FileReadTool,
        { file_path: kodeSessionMemoryFile },
        ctx,
        createAssistantMessage(''),
      )
      expect(kodeRead.result).toBe(true)

      const claudeRead = await hasPermissionsToUseTool(
        FileReadTool,
        { file_path: claudeSessionMemoryFile },
        ctx,
        createAssistantMessage(''),
      )
      expect(claudeRead.result).toBe(true)

      const kodeWriteDenied = await hasPermissionsToUseTool(
        FileWriteTool,
        { file_path: kodeSessionMemoryFile, content: 'overwrite' },
        ctx,
        createAssistantMessage(''),
      )
      expect(kodeWriteDenied.result).toBe(false)
    } finally {
      setKodeAgentSessionId(previousSessionId)
      if (previousKodeConfigDir === undefined)
        delete process.env.KODE_CONFIG_DIR
      else process.env.KODE_CONFIG_DIR = previousKodeConfigDir
      if (previousClaudeConfigDir === undefined)
        delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir
      rmSync(tmpRoots, { recursive: true, force: true })
    }
  })

  test('allows writing to scratchpad files for the current session (kode tmpdir layout)', async () => {
    if (process.platform === 'win32') return

    const tmpScratchBase = makeTempDir('kode-scratchpad')
    const previousClaudeTmpDir = process.env.CLAUDE_TMPDIR
    const previousTmp = process.env.CLAUDE_CODE_TMPDIR
    const previousSessionId = getKodeAgentSessionId()
    delete process.env.CLAUDE_TMPDIR
    process.env.CLAUDE_CODE_TMPDIR = tmpScratchBase
    setKodeAgentSessionId('session-scratchpad-test')

    try {
      const toolPermissionContext = createDefaultToolPermissionContext({
        isBypassPermissionsModeAvailable: true,
        mode: 'acceptEdits',
      })
      const ctx = makeContext({ toolPermissionContext })

      const projectKey = process.cwd().replace(/[^a-zA-Z0-9]/g, '-')
      const sessionId = getKodeAgentSessionId()
      const scratchpadFile = path.join(
        tmpScratchBase,
        'kode',
        projectKey,
        sessionId,
        'scratchpad',
        'note.txt',
      )

      const allowed = await hasPermissionsToUseTool(
        FileWriteTool,
        { file_path: scratchpadFile, content: 'hi' },
        ctx,
        createAssistantMessage(''),
      )
      expect(allowed.result).toBe(true)
    } finally {
      setKodeAgentSessionId(previousSessionId)
      if (previousClaudeTmpDir === undefined) delete process.env.CLAUDE_TMPDIR
      else process.env.CLAUDE_TMPDIR = previousClaudeTmpDir
      if (previousTmp === undefined) delete process.env.CLAUDE_CODE_TMPDIR
      else process.env.CLAUDE_CODE_TMPDIR = previousTmp
      rmSync(tmpScratchBase, { recursive: true, force: true })
    }
  })

  test('allows reading Claude tasks/*.output files (claude tmpdir layout)', async () => {
    if (process.platform === 'win32') return

    const tmpScratchBase = makeTempDir('kode-tasks-out')
    const previousClaudeTmpDir = process.env.CLAUDE_TMPDIR
    const previousTmp = process.env.CLAUDE_CODE_TMPDIR
    delete process.env.CLAUDE_TMPDIR
    process.env.CLAUDE_CODE_TMPDIR = tmpScratchBase

    try {
      const toolPermissionContext = createDefaultToolPermissionContext({
        isBypassPermissionsModeAvailable: true,
      })
      const ctx = makeContext({ toolPermissionContext })

      const projectKey = process.cwd().replace(/[^a-zA-Z0-9]/g, '-')
      const outputFile = path.join(
        tmpScratchBase,
        'claude',
        projectKey,
        'tasks',
        'bash_123.output',
      )
      mkdirSync(path.dirname(outputFile), { recursive: true })
      writeFileSync(outputFile, 'hello', 'utf8')

      const allowed = await hasPermissionsToUseTool(
        FileReadTool,
        { file_path: outputFile },
        ctx,
        createAssistantMessage(''),
      )
      expect(allowed.result).toBe(true)
    } finally {
      if (previousClaudeTmpDir === undefined) delete process.env.CLAUDE_TMPDIR
      else process.env.CLAUDE_TMPDIR = previousClaudeTmpDir
      if (previousTmp === undefined) delete process.env.CLAUDE_CODE_TMPDIR
      else process.env.CLAUDE_CODE_TMPDIR = previousTmp
      rmSync(tmpScratchBase, { recursive: true, force: true })
    }
  })

  test('asks for UNC paths and does not provide suggestions', async () => {
    const toolPermissionContext = createDefaultToolPermissionContext({
      isBypassPermissionsModeAvailable: true,
    })
    const ctx = makeContext({ toolPermissionContext })

    const result = await hasPermissionsToUseTool(
      FileReadTool,
      { file_path: '//server/share/file.txt' },
      ctx,
      createAssistantMessage(''),
    )

    expect(result.result).toBe(false)
    if (result.result !== false) {
      throw new Error('Expected permission denied result')
    }
    expect(result.blockedPath).toBe('//server/share/file.txt')
    expect(result.decisionReason).toBe(
      'UNC/network path requires manual approval',
    )
    expect(result.requiresExplicitApproval).toBe(true)
    expect(result.suggestions).toBeUndefined()
  })

  test('asks for suspicious Windows path patterns and does not provide suggestions', async () => {
    const toolPermissionContext = createDefaultToolPermissionContext({
      isBypassPermissionsModeAvailable: true,
    })
    const ctx = makeContext({ toolPermissionContext })

    const result = await hasPermissionsToUseTool(
      FileReadTool,
      { file_path: 'C:\\\\foo:bar' },
      ctx,
      createAssistantMessage(''),
    )

    expect(result.result).toBe(false)
    if (result.result !== false) {
      throw new Error('Expected permission denied result')
    }
    expect(result.blockedPath).toBe('C:\\\\foo:bar')
    expect(result.decisionReason).toBe(
      'Suspicious Windows path pattern requires manual approval',
    )
    expect(result.requiresExplicitApproval).toBe(true)
    expect(result.suggestions).toBeUndefined()
  })

  test('symlink target outside working dirs requires manual approval unless added to additionalWorkingDirectories', async () => {
    const outside = makeTempDir('kode-perm-symlink-out')
    const outsideFile = path.join(outside, 'target.txt')
    writeFileSync(outsideFile, 'x', 'utf8')

    const inside = makeTempDir('kode-perm-symlink-in')
    const linkPath = path.join(inside, 'link.txt')
    symlinkSync(outsideFile, linkPath)

    try {
      const base = createDefaultToolPermissionContext({
        isBypassPermissionsModeAvailable: true,
      })
      const withInside = applyToolPermissionContextUpdates(base, [
        {
          type: 'addDirectories',
          destination: 'session',
          directories: [inside],
        },
      ])
      const ctx = makeContext({ toolPermissionContext: withInside })

      const denied = await hasPermissionsToUseTool(
        FileReadTool,
        { file_path: linkPath },
        ctx,
        createAssistantMessage(''),
      )
      expect(denied.result).toBe(false)
      if (denied.result !== false) {
        throw new Error('Expected permission denied result')
      }
      expect(denied.requiresExplicitApproval).toBe(true)

      const updated = applyToolPermissionContextUpdates(withInside, [
        {
          type: 'addDirectories',
          destination: 'session',
          directories: [outside],
        },
      ])
      const ctx2 = makeContext({ toolPermissionContext: updated })
      const allowed = await hasPermissionsToUseTool(
        FileReadTool,
        { file_path: linkPath },
        ctx2,
        createAssistantMessage(''),
      )
      expect(allowed.result).toBe(true)
    } finally {
      rmSync(outside, { recursive: true, force: true })
      rmSync(inside, { recursive: true, force: true })
    }
  })
})
