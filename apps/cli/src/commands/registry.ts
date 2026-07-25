import bug from './builtin/bug'
import automation from './builtin/automation'
import browser from './builtin/browser'
import clear from './builtin/clear'
import checkpoint from './builtin/checkpoint'
import compact from './builtin/compact'
import config from './builtin/config'
import cost from './builtin/cost'
import ctx_viz from './debug/ctx_viz'
import addDir from './builtin/add-dir'
import bash from './builtin/bash'
import exit from './builtin/exit'
import doctor from './builtin/doctor'
import gateDump from './builtin/gate-dump'
import help from './builtin/help'
import hooks from './builtin/hooks'
import files from './builtin/files'
import exportCommand from './builtin/export'
import skills from './builtin/skills'
import init from './builtin/init'
import listen from './debug/listen'
import messages_debug from './debug/messages_debug'
import login from './builtin/login'
import logout from './builtin/logout'
import lsp from './builtin/lsp'
import loop from './builtin/loop'
import memory from './builtin/memory'
import migrate from './builtin/migrate'
import mcp from './mcp/mcp'
import plugin from './plugin/plugin'
import outputStyle from './builtin/output-style'
import permissions from './builtin/permissions'
import theme from './builtin/theme'
import vim from './builtin/vim'
import * as model from './builtin/model'
import modelstatus from './builtin/modelstatus'
import note from './builtin/note'
import onboarding from './builtin/onboarding'
import open from './builtin/open'
import copy from './builtin/copy'
import importCommand from './builtin/import'
import plan from './builtin/plan'
import transcript from './builtin/transcript'
import consoleCommand from './builtin/console'
import notifications from './builtin/notifications'
import plugins from './builtin/plugins'
import pr_comments from './builtin/pr_comments'
import refreshCommands from './builtin/refreshCommands'
import releaseNotes from './builtin/release-notes'
import review from './builtin/review'
import rename from './builtin/rename'
import resume from './builtin/resume'
import rollback from './builtin/rollback'
import runs from './builtin/runs'
import rewind from './builtin/rewind'
import status from './builtin/status'
import statusline from './builtin/statusline'
import supervisor from './builtin/supervisor'
import capabilities from './builtin/capabilities'
import tag from './builtin/tag'
import goal from './builtin/goal'
import watch from './builtin/watch'
import work from './builtin/work'
import worktree from './builtin/worktree'
import tasks from './builtin/tasks'
import terminalSetup from './builtin/terminal-setup'
import sandbox from './builtin/sandbox'
import agents from './agent/agents'
import { PARITY_STUB_COMMANDS } from './builtin/parityStubs'
import { getMCPCommands, getMcpListChangedVersion } from '#core/mcp/client'
import { loadCustomCommands } from '#cli-services/customCommands'
import { memoize } from 'lodash-es'
import { isInteractiveLoginEnabled } from '#core/utils/auth'
import type { Command } from './types'

export type { Command } from './types'

const INTERNAL_ONLY_COMMANDS = [ctx_viz, listen, messages_debug]

// Declared as a function so that we don't run this until getCommands is called,
// since underlying functions read from config, which can't be read at module initialization time
const COMMANDS = memoize((): Command[] => [
  agents,
  addDir,
  automation,
  bash,
  browser,
  clear,
  checkpoint,
  compact,
  config,
  cost,
  doctor,
  exit,
  exportCommand,
  gateDump,
  help,
  hooks,
  files,
  skills,
  init,
  lsp,
  loop,
  memory,
  migrate,
  outputStyle,
  permissions,
  theme,
  vim,
  statusline,
  capabilities,
  mcp,
  plugin,
  model,
  modelstatus,
  note,
  onboarding,
  open,
  copy,
  importCommand,
  plan,
  transcript,
  consoleCommand,
  notifications,
  plugins,
  pr_comments,
  rename,
  resume,
  rollback,
  runs,
  rewind,
  status,
  supervisor,
  tag,
  refreshCommands,
  releaseNotes,
  bug,
  goal,
  review,
  watch,
  work,
  worktree,
  tasks,
  terminalSetup,
  sandbox,
  ...PARITY_STUB_COMMANDS,
  ...(isInteractiveLoginEnabled() ? [logout, login()] : []),
  ...INTERNAL_ONLY_COMMANDS,
])

export const getCommands = memoize(
  async (): Promise<Command[]> => {
    const [mcpCommands, customCommands] = await Promise.all([
      getMCPCommands(),
      loadCustomCommands(),
    ])

    return [...mcpCommands, ...customCommands, ...COMMANDS()].filter(
      _ => _.isEnabled,
    )
  },
  () => `mcp-prompts@${getMcpListChangedVersion('prompts')}`,
)

export function hasCommand(commandName: string, commands: Command[]): boolean {
  return commands.some(
    _ => _.userFacingName() === commandName || _.aliases?.includes(commandName),
  )
}

export function getCommand(commandName: string, commands: Command[]): Command {
  const command = commands.find(
    _ => _.userFacingName() === commandName || _.aliases?.includes(commandName),
  ) as Command | undefined
  if (!command) {
    throw ReferenceError(
      `Command ${commandName} not found. Available commands: ${commands
        .map(_ => {
          const name = _.userFacingName()
          return _.aliases ? `${name} (aliases: ${_.aliases.join(', ')})` : name
        })
        .join(', ')}`,
    )
  }

  return command
}
