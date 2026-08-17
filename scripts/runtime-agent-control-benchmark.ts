import {
  __removeBackgroundAgentTaskForTests,
  acknowledgeBackgroundAgentGuidance,
  claimBackgroundAgentGuidance,
  guideBackgroundAgentTask,
  upsertBackgroundAgentTask,
  type BackgroundAgentTaskRuntime,
} from '../packages/core/src/utils/backgroundTasks'
import {
  listOwnedBackgroundTaskSnapshots,
  summarizeBackgroundTaskSnapshots,
} from '../packages/core/src/tasks/backgroundRegistry'

const ITERATIONS = 10_000
const AGENT_COUNT = 50
// Match the production per-turn claim limit so this measures steady-state
// delivery instead of intentionally filling the bounded pending queue.
const BATCH = 8
const sessionId = 'runtime-control-benchmark'
const cwd = process.cwd()
const agentIds = Array.from(
  { length: AGENT_COUNT },
  () => `benchmark-${crypto.randomUUID()}`,
)
for (const agentId of agentIds) {
  const task: BackgroundAgentTaskRuntime = {
    type: 'async_agent',
    agentId,
    parentAgentId: 'main',
    description: 'Runtime control benchmark',
    prompt: 'Benchmark only.',
    status: 'running',
    cwd,
    sessionId,
    startedAt: Date.now(),
    messages: [],
    guidance: [],
    abortController: new AbortController(),
    done: Promise.resolve(),
  }
  upsertBackgroundAgentTask(task)
}
const agentId = agentIds[0]!

const start = performance.now()
let delivered = 0
while (delivered < ITERATIONS) {
  const count = Math.min(BATCH, ITERATIONS - delivered)
  for (let index = 0; index < count; index += 1) {
    guideBackgroundAgentTask({
      agentId,
      body: `Review control boundary ${delivered + index}.`,
    })
  }
  const claimed = claimBackgroundAgentGuidance({
    agentId,
    maxItems: count,
  })
  acknowledgeBackgroundAgentGuidance({
    agentId,
    guidanceIds: claimed.map(item => item.guidanceId),
  })
  delivered += claimed.length
}
const guidanceDurationMs = performance.now() - start

const monitorStart = performance.now()
let checksum = 0
for (let index = 0; index < ITERATIONS; index += 1) {
  const snapshots = listOwnedBackgroundTaskSnapshots({ cwd, sessionId })
  checksum += summarizeBackgroundTaskSnapshots(snapshots).running
}
const monitorDurationMs = performance.now() - monitorStart

for (const id of agentIds) __removeBackgroundAgentTaskForTests(id)

console.log(
  JSON.stringify(
    {
      iterations: ITERATIONS,
      agents: AGENT_COUNT,
      guidanceLifecycle: {
        durationMs: Number(guidanceDurationMs.toFixed(2)),
        operationsPerSecond: Number(
          ((ITERATIONS / guidanceDurationMs) * 1_000).toFixed(2),
        ),
      },
      ownedTopologySnapshot: {
        durationMs: Number(monitorDurationMs.toFixed(2)),
        averageMs: Number((monitorDurationMs / ITERATIONS).toFixed(4)),
        checksum,
      },
    },
    null,
    2,
  ),
)
