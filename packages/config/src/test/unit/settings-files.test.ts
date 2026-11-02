import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { SettingsFileError } from '../../errors'
import { loadSettingsWithLegacyFallback, readSettingsFile } from '../../files'
import { updateLocalSettings } from '../../local'

describe('settings files fail closed', () => {
  let root: string
  let primary: string
  let legacy: string

  beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), 'kode-settings-'))
    primary = join(root, '.kode', 'settings.local.json')
    legacy = join(root, '.claude', 'settings.local.json')
    fs.mkdirSync(dirname(primary))
    fs.mkdirSync(dirname(legacy))
  })

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  const load = () =>
    loadSettingsWithLegacyFallback({
      destination: 'localSettings',
      projectDir: root,
      migrateToPrimary: true,
    })

  test('only an absent file returns null', () => {
    expect(readSettingsFile(primary)).toBeNull()
    expect(readSettingsFile(join(root, 'absent', 'settings.json'))).toBeNull()
    expect(load()).toEqual({ settings: null, usedPath: null })
    fs.writeFileSync(primary, '{}')
    expect(readSettingsFile(primary)).toEqual({})
  })

  test.each([
    '',
    '{"permissions":',
    '{"permissions":{"deny":["Write(.env)"]}',
    '<<<<<<< HEAD',
    'null',
    '[]',
    '42',
    '"text"',
  ])('rejects malformed or non-object settings: %j', raw => {
    fs.writeFileSync(primary, raw)
    fs.writeFileSync(legacy, '{"permissions":{"allow":["Write"]}}')
    expect(load).toThrow(SettingsFileError)
    expect(fs.readFileSync(primary, 'utf8')).toBe(raw)
  })

  test.each([null, [], false, 'deny'].map(permissions => ({ permissions })))(
    'rejects a non-object permissions value: %j',
    ({ permissions }) => {
      fs.writeFileSync(primary, JSON.stringify({ permissions }))
      expect(load).toThrow('permissions must be an object')
    },
  )

  for (const key of ['allow', 'deny', 'ask', 'additionalDirectories']) {
    test.each(
      [null, 'Write(.env)', {}, [false], ['Write(.env)', 1]].map(value => ({
        value,
      })),
    )(`rejects malformed permissions.${key}: %j`, ({ value }) => {
      fs.writeFileSync(
        primary,
        JSON.stringify({ permissions: { [key]: value } }),
      )
      expect(load).toThrow(`permissions.${key} must be an array of strings`)
    })
  }

  test('preserves valid policy, empty lists and unknown settings', () => {
    const settings = {
      permissions: {
        allow: [],
        deny: ['Write(.env)'],
        ask: ['Write(secret/**)'],
        additionalDirectories: ['../shared'],
        futureOption: true,
      },
      futureSetting: { enabled: true },
    }
    fs.writeFileSync(primary, JSON.stringify(settings))
    fs.writeFileSync(legacy, 'broken legacy is not selected')
    expect(load()).toEqual({ settings, usedPath: primary })
  })

  test('falls back and migrates only when primary is absent', () => {
    const settings = { permissions: { deny: ['Write(.env)'] } }
    fs.writeFileSync(legacy, JSON.stringify(settings))
    expect(load()).toEqual({ settings, usedPath: legacy })
    expect(readSettingsFile(primary)).toEqual(settings)
  })

  test('rejects a broken legacy policy and does not migrate it', () => {
    fs.writeFileSync(legacy, '{"permissions":')
    expect(load).toThrow(SettingsFileError)
    expect(fs.existsSync(primary)).toBe(false)
  })

  test('rejects directories and non-directory parents', () => {
    fs.mkdirSync(primary)
    expect(load).toThrow('unable to read file')
    fs.rmdirSync(primary)
    fs.rmdirSync(dirname(primary))
    fs.writeFileSync(dirname(primary), 'not a directory')
    expect(load).toThrow('unable to read file')
  })

  test.each(['EACCES', 'EPERM'])(
    'propagates %s instead of using legacy policy',
    code => {
      fs.writeFileSync(primary, '{}')
      fs.writeFileSync(legacy, '{}')
      const readFileSync = fs.readFileSync
      const read = spyOn(fs, 'readFileSync').mockImplementation(((
        path: any,
        ...args: any[]
      ) => {
        if (path === primary)
          throw Object.assign(new Error('private contents'), { code })
        return (readFileSync as any)(path, ...args)
      }) as typeof fs.readFileSync)
      try {
        expect(load).toThrow(`unable to read file (${code})`)
        expect(load).not.toThrow('private contents')
      } finally {
        read.mockRestore()
      }
    },
  )

  test.skipIf(process.platform === 'win32')(
    'distinguishes missing files from broken symlinks',
    () => {
      const target = join(root, 'target.json')
      fs.symlinkSync(target, primary)
      expect(load).toThrow(SettingsFileError)
      fs.writeFileSync(target, '{"permissions":{"deny":["Write(.env)"]}}')
      expect(load().settings?.permissions).toEqual({ deny: ['Write(.env)'] })
      fs.unlinkSync(primary)
      fs.rmdirSync(dirname(primary))
      fs.symlinkSync(join(root, 'target-dir'), dirname(primary))
      expect(load).toThrow(SettingsFileError)
      fs.mkdirSync(join(root, 'target-dir'))
      expect(load().settings).toBeNull()
    },
  )

  test('diagnostics identify the file without exposing settings contents', () => {
    fs.writeFileSync(primary, '{"token":"private-test-value"} trailing')
    try {
      load()
      throw new Error('expected settings failure')
    } catch (error) {
      expect(error).toBeInstanceOf(SettingsFileError)
      expect((error as Error).message).toContain(JSON.stringify(primary))
      expect(String(error)).not.toContain('private-test-value')
      expect((error as Error).cause).toBeUndefined()
    }
  })

  test('settings updates do not overwrite a corrupt policy', () => {
    const raw = '{"permissions":{"deny":'
    fs.writeFileSync(primary, raw)
    expect(() =>
      updateLocalSettings({ outputStyle: 'default' }, { projectDir: root }),
    ).toThrow(SettingsFileError)
    expect(fs.readFileSync(primary, 'utf8')).toBe(raw)
  })
})
