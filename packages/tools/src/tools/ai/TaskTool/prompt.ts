import { type Tool } from '@kode/tool-interface/Tool'
import { getTools, getReadOnlyTools } from '#tools'
import { FileWriteTool } from '#tools/tools/filesystem/FileWriteTool/FileWriteTool'
import { GlobTool } from '#tools/tools/filesystem/GlobTool/GlobTool'
import { FileReadTool } from '#tools/tools/filesystem/FileReadTool/FileReadTool'
import { getActiveAgents, SUBAGENT_DISALLOWED_TOOL_NAMES } from '@kode/agent'

const TASK_TOOL_NAME = 'Task'
const TASK_OUTPUT_TOOL_NAME = 'TaskOutput'
const TASK_MONITOR_TOOL_NAME = 'TaskMonitor'
const TASK_GUIDE_TOOL_NAME = 'TaskGuide'

export async function getTaskTools(safeMode: boolean): Promise<Tool[]> {
  // No recursive tasks, yet..
  return (await (!safeMode ? getTools() : getReadOnlyTools())).filter(
    tool => !SUBAGENT_DISALLOWED_TOOL_NAMES.has(tool.name),
  )
}

export async function getPrompt(safeMode: boolean): Promise<string> {
  // Maintain compatibility with legacy agent packs and their tool lists.
  const agents = await getActiveAgents()

  // Format exactly as in original: (Tools: tool1, tool2)
  const agentDescriptions = agents
    .map(agent => {
      const toolsStr = Array.isArray(agent.tools)
        ? agent.tools.join(', ')
        : 'All tools'
      const properties = agent.forkContext
        ? 'Properties: access to current context; '
        : ''
      return `- ${agent.agentType}: ${agent.whenToUse} (${properties}Tools: ${toolsStr})`
    })
    .join('\n')

  // Keep wording stable so shared legacy agent packs behave consistently.
  return `Launch a new agent to handle complex, multi-step tasks autonomously. 

The ${TASK_TOOL_NAME} tool launches specialized agents (subprocesses) that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

Available agent types and the tools they have access to:
${agentDescriptions}

When using the ${TASK_TOOL_NAME} tool, you must specify a subagent_type parameter to select which agent type to use.

When NOT to use the ${TASK_TOOL_NAME} tool:
- If you want to read a specific file path, use the ${FileReadTool.name} or ${GlobTool.name} tool instead of the ${TASK_TOOL_NAME} tool, to find the match more quickly
- If you are searching for a specific class definition like "class Foo", use the ${GlobTool.name} tool instead, to find the match more quickly
- If you are searching for code within a specific file or set of 2-3 files, use the ${FileReadTool.name} tool instead of the ${TASK_TOOL_NAME} tool, to find the match more quickly
- Other tasks that are not related to the agent descriptions above


Usage notes:
- Always include a short description (3-5 words) summarizing what the agent will do
- Launch multiple agents concurrently whenever possible, to maximize performance; to do that, use a single message with multiple tool uses
- When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.
- You can optionally run agents in the background using the run_in_background parameter. When an agent runs in the background, you will need to use ${TASK_OUTPUT_TOOL_NAME} to retrieve its results once it's done. You can continue to work while background agents run - When you need their results to continue you can use ${TASK_OUTPUT_TOOL_NAME} in blocking mode to pause and wait for their results.
- Use ${TASK_MONITOR_TOOL_NAME} for a non-blocking view of live Agent status, activity, turns, recent output, and queued/applied guidance. Use ${TASK_GUIDE_TOOL_NAME} to send a reviewed correction to a running background Agent at its next model-turn boundary. Use TaskStop instead if current work must stop immediately.
- Agents can be resumed using the \`resume\` parameter by passing the agent ID from a previous invocation. When resumed, the agent continues with its full previous context preserved. When NOT resuming, each invocation starts fresh and you should provide a detailed task description with all necessary context.
- When the agent is done, it will return a single message back to you along with its agent ID. You can use this ID to resume the agent later if needed for follow-up work.
- Provide clear, detailed prompts so the agent can work autonomously and return exactly the information you need.
- Agents with "access to current context" can see the full conversation history before the tool call. When using these agents, you can write concise prompts that reference earlier context (e.g., "investigate the error discussed above") instead of repeating information. The agent will receive all prior messages and understand the context.
- Treat an agent's output as a progress report, not execution proof. Before telling the user that code works, a change is safe, or an external action completed, independently inspect the relevant artifact and corroborate it with the appropriate tool output (for example tests, build output, or a remote receipt).
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent
- If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.
- If the user specifies that they want you to run agents "in parallel", you MUST send a single message with multiple ${TASK_TOOL_NAME} tool use content blocks. For example, if you need to launch both a code-reviewer agent and a test-runner agent in parallel, send a single message with both tool calls.

Example usage:

<example_agent_descriptions>
"code-reviewer": use this agent after you are done writing a signficant piece of code
"greeting-responder": use this agent when to respond to user greetings with a friendly joke
</example_agent_description>

<example>
user: "Please write a function that checks if a number is prime"
assistant: Sure let me write a function that checks if a number is prime
assistant: First let me use the ${FileWriteTool.name} tool to write a function that checks if a number is prime
assistant: I'm going to use the ${FileWriteTool.name} tool to write the following code:
<code>
function isPrime(n) {
  if (n <= 1) return false
  for (let i = 2; i * i <= n; i++) {
    if (n % i === 0) return false
  }
  return true
}
</code>
<commentary>
Since a signficant piece of code was written and the task was completed, now use the code-reviewer agent to review the code
</commentary>
assistant: Now let me use the code-reviewer agent to review the code
assistant: Uses the Task tool to launch the code-reviewer agent 
</example>

<example>
user: "Hello"
<commentary>
Since the user is greeting, use the greeting-responder agent to respond with a friendly joke
</commentary>
assistant: "I'm going to use the Task tool to launch the greeting-responder agent"
</example>`
}
