import { LEGACY_ENV } from '#config/compat/legacyEnv'

const TRUTHY_VALUES = new Set(['1', 'true', 'yes', 'on'])

function isTruthyEnv(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return TRUTHY_VALUES.has(value.trim().toLowerCase())
}

function getMaxParallelExploreAgents(): number {
  const raw =
    process.env.KODE_PLAN_V2_EXPLORE_AGENT_COUNT ??
    process.env[LEGACY_ENV.codePlanV2ExploreAgentCount]
  if (raw) {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 10) return parsed
  }
  return 3
}

function getMaxParallelPlanAgents(): number {
  const raw =
    process.env.KODE_PLAN_V2_AGENT_COUNT ??
    process.env[LEGACY_ENV.codePlanV2AgentCount]
  if (raw) {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 10) return parsed
  }
  return 1
}

export function isPlanModeInterviewPhaseEnabled(): boolean {
  return isTruthyEnv(
    process.env.KODE_PLAN_MODE_INTERVIEW_PHASE ??
      process.env[LEGACY_ENV.codePlanModeInterviewPhase],
  )
}

export function buildPlanModeMainReminder(args: {
  planExists: boolean
  planFilePath: string
}): string {
  const { planExists, planFilePath } = args

  const writeToolName = 'Write'
  const editToolName = 'Edit'
  const askUserToolName = 'AskUserQuestion'
  const exploreAgentType = 'Explore'
  const planAgentType = 'Plan'
  const exitPlanModeToolName = 'ExitPlanMode'

  const maxParallelExploreAgents = getMaxParallelExploreAgents()
  const maxParallelPlanAgents = getMaxParallelPlanAgents()

  return `Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supercedes any other instructions you have received.

## Plan File Info:
${planExists ? `A plan file already exists at ${planFilePath}. You can read it and make incremental edits using the ${editToolName} tool.` : `No plan file exists yet. You should create your plan at ${planFilePath} using the ${writeToolName} tool.`}
You should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.

## Plan Workflow

### Phase 1: Initial Understanding
Goal: Gain a comprehensive understanding of the user's request by reading through code and asking them questions. Critical: In this phase you should only use the ${exploreAgentType} subagent type.

1. Focus on understanding the user's request and the code associated with their request

2. **Launch up to ${maxParallelExploreAgents} ${exploreAgentType} agents IN PARALLEL** (single message, multiple tool calls) to efficiently explore the codebase.
   - Use 1 agent when the task is isolated to known files, the user provided specific file paths, or you're making a small targeted change.
   - Use multiple agents when: the scope is uncertain, multiple areas of the codebase are involved, or you need to understand existing patterns before planning.
   - Quality over quantity - ${maxParallelExploreAgents} agents maximum, but you should try to use the minimum number of agents necessary (usually just 1)
   - If using multiple agents: Provide each agent with a specific search focus or area to explore. Example: One agent searches for existing implementations, another explores related components, a third investigating testing patterns

3. After exploring the code, use the ${askUserToolName} tool to clarify ambiguities in the user request up front.

### Phase 2: Design
Goal: Design an implementation approach.

Launch ${planAgentType} agent(s) to design the implementation based on the user's intent and your exploration results from Phase 1.

You can launch up to ${maxParallelPlanAgents} agent(s) in parallel.

**Guidelines:**
- **Default**: Launch at least 1 Plan agent for most tasks - it helps validate your understanding and consider alternatives
- **Skip agents**: Only for truly trivial tasks (typo fixes, single-line changes, simple renames)
${
  maxParallelPlanAgents > 1
    ? `- **Multiple agents**: Use up to ${maxParallelPlanAgents} agents for complex tasks that benefit from different perspectives

Examples of when to use multiple agents:
- The task touches multiple parts of the codebase
- It's a large refactor or architectural change
- There are many edge cases to consider
- You'd benefit from exploring different approaches

Example perspectives by task type:
- New feature: simplicity vs performance vs maintainability
- Bug fix: root cause vs workaround vs prevention
- Refactoring: minimal change vs clean architecture
`
    : ''
}
In the agent prompt:
- Provide comprehensive background context from Phase 1 exploration including filenames and code path traces
- Describe requirements and constraints
- Request a detailed implementation plan

### Phase 3: Review
Goal: Review the plan(s) from Phase 2 and ensure alignment with the user's intentions.
1. Read the critical files identified by agents to deepen your understanding
2. Ensure that the plans align with the user's original request
3. Use ${askUserToolName} to clarify any remaining questions with the user

### Phase 4: Final Plan
Goal: Write your final plan to the plan file (the only file you can edit).
- Include only your recommended approach, not all alternatives
- Ensure that the plan file is concise enough to scan quickly, but detailed enough to execute effectively
- Include the paths of critical files to be modified
- Include a verification section describing how to test the changes end-to-end (run the code, use MCP tools, run tests)

### Phase 5: Call ${exitPlanModeToolName}
At the very end of your turn, once you have asked the user questions and are happy with your final plan file - you should always call ${exitPlanModeToolName} to indicate to the user that you are done planning.
This is critical - your turn should only end with either using the ${askUserToolName} tool OR calling ${exitPlanModeToolName}. Do not stop unless it's for these 2 reasons

**Important:** Use ${askUserToolName} ONLY to clarify requirements or choose between approaches. Use ${exitPlanModeToolName} to request plan approval. Do NOT ask about plan approval in any other way - no text questions, no AskUserQuestion. Phrases like "Is this plan okay?", "Should I proceed?", "How does this plan look?", "Any changes before we start?", or similar MUST use ${exitPlanModeToolName}.

NOTE: At any point in time through this workflow you should feel free to ask the user questions or clarifications using the ${askUserToolName} tool. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.`
}

export function buildPlanModeMainInterviewReminder(args: {
  planExists: boolean
  planFilePath: string
}): string {
  const { planExists, planFilePath } = args

  const writeToolName = 'Write'
  const editToolName = 'Edit'
  const askUserToolName = 'AskUserQuestion'
  const exploreAgentType = 'Explore'
  const exitPlanModeToolName = 'ExitPlanMode'

  return `Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supercedes any other instructions you have received.

## Plan File Info:
${planExists ? `A plan file already exists at ${planFilePath}. You can read it and make incremental edits using the ${editToolName} tool.` : `No plan file exists yet. You should create your plan at ${planFilePath} using the ${writeToolName} tool.`}

## Iterative Planning Workflow

Your goal is to build a comprehensive plan through iterative refinement and interviewing the user. Read files, interview and ask questions, and build the plan incrementally.

### How to Work

0. Write your plan in the plan file specified above. This is the ONLY file you are allowed to edit.

1. **Explore the codebase**: Use Read, Glob, and Grep tools to understand the codebase.
You have access to the ${exploreAgentType} agent type if you want to delegate search.
Use this generously for particularly complex searches or to parallelize exploration.

2. **Interview the user**: Use ${askUserToolName} to interview the user and ask questions that:
   - Clarify ambiguous requirements
   - Get user input on technical decisions and tradeoffs
   - Understand preferences for UI/UX, performance, edge cases
   - Validate your understanding before committing to an approach
   Make sure to:
   - Not ask any questions that you could find out yourself by exploring the codebase.
   - Batch questions together when possible so you ask multiple questions at once
   - DO NOT ask any questions that are obvious or that you believe you know the answer to.

3. **Write to the plan file iteratively**: As you learn more, update the plan file:
   - Start with your initial understanding of the requirements, leave in space to fill it out.
   - Add sections as you explore and learn about the codebase
   - Refine based on user answers to your questions
   - The plan file is your working document - edit it as your understanding evolves

4. **Interleave exploration, questions, and writing**: Don't wait until the end to write. After each discovery or clarification, update the plan file to capture what you've learned.

5. **Adjust the level of detail to the task**: For a highly unspecified task like a new project or feature, you might need to ask many rounds of questions. Whereas for a smaller task you may need only some or a few.

### Plan File Structure
Your plan file should be divided into clear sections using markdown headers, based on the request. Fill out these sections as you go.
- Include only your recommended approach, not all alternatives
- Ensure that the plan file is concise enough to scan quickly, but detailed enough to execute effectively
- Include the paths of critical files to be modified
- Include a verification section describing how to test the changes end-to-end (run the code, use MCP tools, run tests)

### Ending Your Turn

Your turn should only end by either:
- Using ${askUserToolName} to gather more information
- Calling ${exitPlanModeToolName} when the plan is ready for approval

**Important:** Use ${exitPlanModeToolName} to request plan approval. Do NOT ask about plan approval via text or AskUserQuestion.`
}

export function buildPlanModeSparseReminder(args: {
  planFilePath: string
  interviewPhaseEnabled: boolean
}): string {
  const askUserToolName = 'AskUserQuestion'
  const exitPlanModeToolName = 'ExitPlanMode'

  const workflowHint = args.interviewPhaseEnabled
    ? 'Follow iterative workflow: explore codebase, interview user, write to plan incrementally.'
    : 'Follow 5-phase workflow.'

  return `Plan mode still active (see full instructions earlier in the conversation). Read-only except plan file (${args.planFilePath}). ${workflowHint} End turns with ${askUserToolName} (for clarifications) or ${exitPlanModeToolName} (for plan approval). Never ask about plan approval via text or AskUserQuestion.`
}

export function buildPlanModeSubAgentReminder(args: {
  planExists: boolean
  planFilePath: string
}): string {
  const { planExists, planFilePath } = args

  const writeToolName = 'Write'
  const editToolName = 'Edit'
  const askUserToolName = 'AskUserQuestion'

  return `Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits, run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supercedes any other instructions you have received (for example, to make edits). Instead, you should:

## Plan File Info:
${planExists ? `A plan file already exists at ${planFilePath}. You can read it and make incremental edits using the ${editToolName} tool if you need to.` : `No plan file exists yet. You should create your plan at ${planFilePath} using the ${writeToolName} tool if you need to.`}
You should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.
Answer the user's query comprehensively, using the ${askUserToolName} tool if you need to ask the user clarifying questions. If you do use the ${askUserToolName}, make sure to ask all clarifying questions you need to fully understand the user's intent before proceeding.`
}

export function buildPlanModeReentryReminder(planFilePath: string): string {
  const exitPlanModeToolName = 'ExitPlanMode'

  return `## Re-entering Plan Mode

You are returning to plan mode after having previously exited it. A plan file exists at ${planFilePath} from your previous planning session.

**Before proceeding with any new planning, you should:**
1. Read the existing plan file to understand what was previously planned
2. Evaluate the user's current request against that plan
3. Decide how to proceed:
   - **Different task**: If the user's request is for a different task—even if it's similar or related—start fresh by overwriting the existing plan
   - **Same task, continuing**: If this is explicitly a continuation or refinement of the exact same task, modify the existing plan while cleaning up outdated or irrelevant sections
4. Continue on with the plan process and most importantly you should always edit the plan file one way or the other before calling ${exitPlanModeToolName}

Treat this as a fresh planning session. Do not assume the existing plan is relevant without evaluating it first.`
}

export function buildPlanModeExitReminder(args: {
  planFilePath: string
  planExists: boolean
}): string {
  return `## Exited Plan Mode

You have exited plan mode. You can now make edits, run tools, and take actions.${args.planExists ? ` The plan file is located at ${args.planFilePath} if you need to reference it.` : ''}`
}

export function wrapSystemReminder(text: string): string {
  return `<system-reminder>\n${text}\n</system-reminder>`
}
