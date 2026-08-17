/** Tools that only make sense in the parent conversation and must never be
 * advertised as capabilities of a Task subagent. */
export const SUBAGENT_DISALLOWED_TOOL_NAMES = new Set<string>([
  'Task',
  'TaskBatch',
  'TaskOutput',
  'TaskMonitor',
  'TaskGuide',
  'TaskStop',
  'EnterPlanMode',
  'ExitPlanMode',
  'AskUserQuestion',
  'SessionMessage',
])
