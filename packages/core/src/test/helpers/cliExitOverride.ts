import type { Command } from '@commander-js/extra-typings'

/**
 * Apply `exitOverride()` to a command and every subcommand.
 *
 * commander's `exitOverride()` only affects the command it is called on, and a
 * subcommand inherits the override that existed *when it was created*. Commands
 * built by `createCliProgram` are all created up front, so overriding only the
 * root leaves every subcommand calling `process.exit(0)` when it handles
 * `--help`. Inside a test process that terminates the whole `bun test` run with
 * a success exit code, silently skipping every test that had not run yet.
 */
export function exitOverrideRecursive(command: Command): void {
  command.exitOverride()
  for (const subcommand of command.commands) {
    exitOverrideRecursive(subcommand as Command)
  }
}
