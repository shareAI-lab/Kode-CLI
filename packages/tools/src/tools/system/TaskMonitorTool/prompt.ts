export const TOOL_NAME_FOR_PROMPT = 'TaskMonitor'

export const DESCRIPTION =
  'Lists and inspects the live background-agent and shell execution topology'

export const PROMPT = `- action=list returns the bounded current background task topology
- action=get inspects one task, including elapsed time, last activity, turn count, guidance state, and a bounded output tail
- This tool is read-only and never waits for task completion
- Results are restricted to tasks owned by the current workspace and session
- Use TaskGuide to redirect a running agent, TaskOutput to wait, or TaskStop to interrupt
- A queued guidance status does not prove the target model has applied it`
