import { performance } from 'node:perf_hooks'

import {
  executeAgentPlanEvents,
  planAgentExecution,
} from '../packages/core/src/automation/agentOrchestration'

const count = Number(process.env.KODE_VOICE_BENCHMARK_TASKS ?? '10000')
if (!Number.isSafeInteger(count) || count < 1 || count > 100_000) {
  throw new Error(
    'KODE_VOICE_BENCHMARK_TASKS must be an integer from 1 to 100000.',
  )
}

const tasks = Array.from({ length: count }, (_, index) => ({
  id: `read-${index}`,
  agentType: 'research',
  prompt: `Inspect unit ${index}`,
  mode: 'read' as const,
}))
const startedAt = performance.now()
const plan = planAgentExecution(tasks, { maxParallelism: 4 })
const elapsedMs = performance.now() - startedAt
if (!plan.valid || plan.groups.some(group => group.tasks.length > 4)) {
  throw new Error(`Invalid benchmark plan: ${plan.errors.join(' ')}`)
}
const executionStartedAt = performance.now()
let completed = 0
for await (const event of executeAgentPlanEvents(plan, {
  launch: async task => task.id,
})) {
  if (event.type === 'task_finished' && event.outcome.status === 'completed')
    completed += 1
}
const executionElapsedMs = performance.now() - executionStartedAt
if (completed !== count)
  throw new Error('Execution event benchmark lost agent tasks.')
console.log(
  JSON.stringify({
    benchmark: 'voice-agent-read-plan',
    tasks: count,
    groups: plan.groups.length,
    elapsedMs: Number(elapsedMs.toFixed(2)),
    executionElapsedMs: Number(executionElapsedMs.toFixed(2)),
  }),
)
