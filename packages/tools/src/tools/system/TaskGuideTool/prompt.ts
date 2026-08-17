export const TOOL_NAME_FOR_PROMPT = 'TaskGuide'

export const DESCRIPTION =
  'Queues reviewed guidance for a running background agent at its next model-turn boundary'

export const PROMPT = `- Sends a bounded follow-up instruction to a running background agent
- Delivery occurs at the next model-turn boundary; it does not cancel a tool call that already started
- Use TaskOutput with block=false before and after guiding when current status matters
- The result reports queued status, not proof that the agent has applied the guidance
- Use TaskStop instead when the current work must stop immediately
- The target must belong to this workspace, session, and launching parent agent
- Requires an explicit target task_id and normal permission approval`
