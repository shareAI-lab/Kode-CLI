import { readFileSync, writeFileSync } from 'node:fs'
import { cwd } from 'process'
import type { Command } from '@commander-js/extra-typings'

import {
  applyModelConfigYamlImport,
  formatModelConfigYamlForSharing,
  getGlobalConfig,
  saveGlobalConfig,
} from '#config'
import { setup } from '../setup'

export function registerModelsCommands(program: Command): void {
  // Models (YAML import/export)

  const modelsCmd = program
    .command('models')
    .description('Import/export model profiles and pointers (YAML)')

  modelsCmd
    .command('export')
    .description(
      'Export shareable model config as YAML (does not include plaintext API keys)',
    )
    .option('--cwd <cwd>', 'The current working directory', String, cwd())
    .option('-o, --output <path>', 'Write YAML to file instead of stdout')
    .action(async ({ cwd, output }) => {
      try {
        await setup(cwd, false)
        const yamlText = formatModelConfigYamlForSharing(getGlobalConfig())
        if (output) {
          writeFileSync(output, yamlText, 'utf-8')
          console.log(`Wrote model config YAML to ${output}`)
        } else {
          console.log(yamlText)
        }
        process.exit(0)
      } catch (error) {
        console.error((error as Error).message)
        process.exit(1)
      }
    })

  modelsCmd
    .command('import <file>')
    .description('Import model config YAML (merges by default)')
    .option('--cwd <cwd>', 'The current working directory', String, cwd())
    .option('--replace', 'Replace existing model profiles instead of merging')
    .action(async (file: string, { cwd, replace }) => {
      try {
        await setup(cwd, false)

        const yamlText = readFileSync(file, 'utf-8')
        const { nextConfig, warnings } = applyModelConfigYamlImport(
          getGlobalConfig(),
          yamlText,
          { replace: !!replace },
        )
        saveGlobalConfig(nextConfig)

        // Force ModelManager reload after config change
        await import('#core/utils/model').then(({ reloadModelManager }) => {
          reloadModelManager()
        })

        if (warnings.length > 0) {
          console.error(warnings.join('\n'))
        }
        console.log(`Imported model config YAML from ${file}`)
        process.exit(0)
      } catch (error) {
        console.error((error as Error).message)
        process.exit(1)
      }
    })

  modelsCmd
    .command('list')
    .description('List configured model profiles and pointers')
    .option('--cwd <cwd>', 'The current working directory', String, cwd())
    .option('--json', 'Output as JSON')
    .action(async (options: any) => {
      try {
        const workingDir =
          typeof options?.cwd === 'string' ? options.cwd : cwd()
        const asJson = options?.json === true
        await setup(workingDir, false)
        const { reloadModelManager, getModelManager } =
          await import('#core/utils/model')
        reloadModelManager()
        const manager = getModelManager()
        const config = getGlobalConfig()

        const pointers = (['main', 'task', 'compact', 'quick'] as const).map(
          pointer => {
            const pointerId = config.modelPointers?.[pointer] ?? null
            const resolved = manager.resolveModelWithInfo(pointer)
            const profile = resolved.success ? resolved.profile : null
            return {
              pointer,
              pointerId,
              resolved: profile
                ? {
                    name: profile.name,
                    provider: profile.provider,
                    modelName: profile.modelName,
                    isActive: profile.isActive,
                  }
                : null,
              error: resolved.success ? null : (resolved.error ?? null),
            }
          },
        )

        const profiles = (config.modelProfiles ?? []).map(p => ({
          name: p.name,
          provider: p.provider,
          modelName: p.modelName,
          baseURL: p.baseURL ?? null,
          maxTokens: p.maxTokens,
          contextLength: p.contextLength,
          reasoningEffort: p.reasoningEffort ?? null,
          isActive: p.isActive,
          createdAt: p.createdAt,
          lastUsed: typeof p.lastUsed === 'number' ? p.lastUsed : null,
          isGPT5: p.isGPT5 ?? null,
          validationStatus: p.validationStatus ?? null,
          lastValidation:
            typeof p.lastValidation === 'number' ? p.lastValidation : null,
          apiKeyEnv: p.apiKeyEnv ?? null,
        }))

        if (asJson) {
          console.log(JSON.stringify({ pointers, profiles }, null, 2))
          process.exitCode = 0
          return
        }

        console.log('Model pointers:\n')
        for (const ptr of pointers) {
          const resolvedLabel = ptr.resolved
            ? `${ptr.resolved.name} (${ptr.resolved.provider}:${ptr.resolved.modelName})`
            : '(unresolved)'
          const configured = ptr.pointerId ? ` -> ${ptr.pointerId}` : ''
          const err = ptr.error ? ` [${ptr.error}]` : ''
          console.log(`  - ${ptr.pointer}${configured}: ${resolvedLabel}${err}`)
        }

        const active = profiles.filter(p => p.isActive)
        console.log(
          `\nModel profiles (${active.length}/${profiles.length} active):\n`,
        )
        for (const p of profiles.sort((a, b) => a.name.localeCompare(b.name))) {
          const status = p.isActive ? 'active' : 'inactive'
          console.log(`  - ${p.name} (${status})`)
          console.log(`    provider=${p.provider} modelName=${p.modelName}`)
          if (p.baseURL) console.log(`    baseURL=${p.baseURL}`)
        }

        process.exitCode = 0
        return
      } catch (error) {
        console.error((error as Error).message)
        process.exitCode = 1
        return
      }
    })
}
