import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { SettingsFileError } from '#config'
import { hasPermissionsToUseTool } from '#core/permissions'
import {
  loadToolPermissionContextFromDisk,
  persistToolPermissionUpdateToDisk,
} from '#core/permissions/toolPermissionSettings'
import { runToolUse } from '#core/query'
import { createAssistantMessage } from '#core/utils/messages'
import {
  getCwd,
  getOriginalCwd,
  setCwd,
  setOriginalCwd,
} from '#core/utils/state'
import {
  __resetToolPermissionContextStateForTests,
  getToolPermissionContextForConversationKey,
} from '#core/utils/toolPermissionContextState'
import { FileWriteTool } from '#tools/tools/filesystem/FileWriteTool/FileWriteTool'
import type { ToolUseContext } from '#core/tooling/Tool'
import type { PermissionMode } from '#core/types/PermissionMode'

describe('permission settings initialization', () => {
  const originalCwd = getCwd()
  const originalWorkingDir = getOriginalCwd()
  const originalConfigDir = process.env.KODE_CONFIG_DIR
  let root: string
  let projectDir: string
  let homeDir: string
  let sources: string[]

  const writeJson = (path: string, value: unknown) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(value))
  }
  const load = () =>
    loadToolPermissionContextFromDisk({
      projectDir,
      homeDir,
      includeKodeProjectConfig: false,
    })
  const context = (
    mode: PermissionMode = 'acceptEdits',
    headless = true,
  ): ToolUseContext => ({
    messageId: 'settings-test',
    abortController: new AbortController(),
    readFileTimestamps: {},
    options: { permissionMode: mode, shouldAvoidPermissionPrompts: headless },
  })
  const checkWrite = (ctx = context()) =>
    hasPermissionsToUseTool(
      FileWriteTool,
      { file_path: join(projectDir, '.env'), content: 'test-only' },
      ctx,
      createAssistantMessage(''),
    )

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'kode-policy-'))
    homeDir = join(root, 'home')
    projectDir = join(root, 'project')
    sources = [
      join(homeDir, '.kode', 'settings.json'),
      join(projectDir, '.kode', 'settings.json'),
      join(projectDir, '.kode', 'settings.local.json'),
    ]
    for (const path of sources) writeJson(path, {})
    process.env.KODE_CONFIG_DIR = join(homeDir, '.kode')
    await setCwd(projectDir)
    setOriginalCwd(projectDir)
    __resetToolPermissionContextStateForTests()
  })

  afterEach(async () => {
    await setCwd(originalCwd)
    setOriginalCwd(originalWorkingDir)
    if (originalConfigDir === undefined) delete process.env.KODE_CONFIG_DIR
    else process.env.KODE_CONFIG_DIR = originalConfigDir
    __resetToolPermissionContextStateForTests()
    rmSync(root, { recursive: true, force: true })
  })

  test.each([0, 1, 2])(
    'a broken source %i aborts the entire policy load',
    async source => {
      for (const path of sources)
        writeJson(path, {
          permissions: {
            allow: ['Write'],
            deny: ['Write(.env)'],
            ask: ['Write(secret/**)'],
          },
        })
      writeFileSync(sources[source]!, '{"permissions":')
      expect(load).toThrow(SettingsFileError)
      const result = await checkWrite()
      expect(result.result).toBe(false)
      if (result.result !== false) throw new Error('expected failure')
      expect(result.shouldPromptUser).toBe(false)
      expect(result.message).toContain('Cannot load settings')
    },
  )

  test.each([
    'acceptEdits',
    'yolo',
    'dontAsk',
    'bypassPermissions',
    'plan',
    'cautious',
  ] as const)('a broken policy cannot be approved in %s mode', async mode => {
    writeFileSync(sources[1]!, '{"permissions":')
    for (const headless of [false, true]) {
      const result = await checkWrite(context(mode, headless))
      expect(result.result).toBe(false)
      if (result.result !== false) throw new Error('expected failure')
      expect(result.shouldPromptUser).toBe(false)
      expect(result.message).toContain('Cannot load settings')
    }
  })

  test('deny and ask retain precedence across sources; valid empty policy still permits edits', async () => {
    expect((await checkWrite()).result).toBe(true)
    writeJson(sources[0]!, { permissions: { allow: ['Write(.env)'] } })
    writeJson(sources[1]!, { permissions: { ask: ['Write(.env)'] } })
    const interactive = await checkWrite(context('acceptEdits', false))
    expect(interactive.result).toBe(false)
    if (interactive.result !== false) throw new Error('expected prompt')
    expect(interactive.shouldPromptUser).not.toBe(false)
    const headless = await checkWrite()
    expect(headless.result).toBe(false)
    if (headless.result !== false) throw new Error('expected denial')
    expect(headless.shouldPromptUser).toBe(false)
    writeJson(sources[2]!, { permissions: { deny: ['Write(.env)'] } })
    const denied = await checkWrite(context('acceptEdits', false))
    expect(denied.result).toBe(false)
    if (denied.result !== false) throw new Error('expected denial')
    expect(denied.shouldPromptUser).toBe(false)
    expect(denied.message).toContain('has been denied')
  })

  test('a failed interactive initialization is not cached and can recover after repair', () => {
    const options = {
      conversationKey: 'broken-policy:0',
      isBypassPermissionsModeAvailable: true,
    }
    writeFileSync(sources[2]!, '{"permissions":')
    expect(() => getToolPermissionContextForConversationKey(options)).toThrow(
      SettingsFileError,
    )
    writeJson(sources[2]!, { permissions: { deny: ['Write(.env)'] } })
    expect(
      getToolPermissionContextForConversationKey(options).alwaysDenyRules
        .localSettings,
    ).toEqual(['Write(.env)'])
  })

  test('persisting a permission does not overwrite a corrupt policy', () => {
    writeFileSync(sources[2]!, '{"permissions":')
    expect(() =>
      persistToolPermissionUpdateToDisk({
        projectDir,
        homeDir,
        update: {
          type: 'addRules',
          destination: 'localSettings',
          behavior: 'allow',
          rules: ['Write'],
        },
      }),
    ).toThrow(SettingsFileError)
    expect(readFileSync(sources[2]!, 'utf8')).toBe('{"permissions":')
  })

  test.each(['valid', 'deny', 'ask', 'corrupt'] as const)(
    'actual Write pipeline respects %s policy',
    async policy => {
      if (policy === 'corrupt') writeFileSync(sources[1]!, '{"permissions":')
      else if (policy !== 'valid')
        writeJson(sources[1]!, { permissions: { [policy]: ['Write(.env)'] } })
      const target = join(projectDir, '.env')
      const messages = []
      for await (const message of runToolUse(
        {
          type: 'tool_use',
          id: 'policy-write',
          name: 'Write',
          input: { file_path: target, content: 'test-only' },
        },
        new Set(),
        createAssistantMessage(''),
        hasPermissionsToUseTool,
        {
          ...context(),
          options: {
            ...context().options,
            tools: [FileWriteTool],
            commands: [],
            forkNumber: 0,
            messageLogName: 'policy-test',
            verbose: false,
          },
        } as any,
      ))
        messages.push(message)
      expect(existsSync(target)).toBe(policy === 'valid')
      if (policy === 'valid')
        expect(readFileSync(target, 'utf8')).toBe('test-only')
      else expect(JSON.stringify(messages)).toContain('is_error')
      if (policy === 'corrupt')
        expect(JSON.stringify(messages)).toContain('Cannot load settings')
    },
  )
})
