export const TOOL_NAME_FOR_PROMPT = 'TaskStop'
export const DESCRIPTION = 'Stop a running background task by ID'

export const PROMPT = `
- Stops a running background task by its ID
- Takes a task_id parameter identifying the task to stop
- Returns a success or failure status
- Use this tool when you need to terminate a long-running task
- Task IDs can be found using the /tasks command
- Stopping is immediate cancellation; use TaskGuide when a running Agent should continue with refined instructions
`
