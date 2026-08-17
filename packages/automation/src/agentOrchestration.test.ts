import { describe, expect, test } from 'bun:test'

import {
  executeAgentPlan,
  executeAgentPlanEvents,
  planAgentExecution,
} from './agentOrchestration'

describe('agent execution planning', () => {
  test('bounds independent reads and serializes all writes', () => {
    const plan = planAgentExecution(
      [
        {
          id: 'inspect',
          agentType: 'research',
          prompt: 'inspect files',
          mode: 'read',
        },
        { id: 'test', agentType: 'test', prompt: 'run tests', mode: 'read' },
        {
          id: 'edit',
          agentType: 'implement',
          prompt: 'edit files',
          mode: 'write',
        },
        {
          id: 'verify',
          agentType: 'verify',
          prompt: 'verify edit',
          mode: 'read',
          dependsOn: ['edit'],
        },
      ],
      { maxParallelism: 2 },
    )

    expect(plan).toMatchObject({ valid: true, errors: [] })
    expect(
      plan.groups.map(group => [group.kind, group.tasks.map(task => task.id)]),
    ).toEqual([
      ['parallel-read', ['inspect', 'test']],
      ['serial-write', ['edit']],
      ['parallel-read', ['verify']],
    ])
  })

  test('rejects malformed dependency graphs before any executor is called', () => {
    const plan = planAgentExecution([
      { id: 'a', agentType: 'x', prompt: 'x', mode: 'read', dependsOn: ['b'] },
      { id: 'b', agentType: 'x', prompt: 'x', mode: 'read', dependsOn: ['a'] },
    ])
    expect(plan.valid).toBe(false)
    expect(plan.errors).toEqual(['Agent work dependencies contain a cycle.'])
  })

  test('blocks dependents after a failure while completing independent work', async () => {
    const plan = planAgentExecution([
      { id: 'fails', agentType: 'research', prompt: 'fails', mode: 'read' },
      {
        id: 'independent',
        agentType: 'research',
        prompt: 'works',
        mode: 'read',
      },
      {
        id: 'downstream',
        agentType: 'writer',
        prompt: 'must wait',
        mode: 'write',
        dependsOn: ['fails'],
      },
    ])
    const outcomes = await executeAgentPlan(plan, {
      async launch(task) {
        if (task.id === 'fails') throw new Error('expected')
        return `${task.id}:ok`
      },
    })
    expect(outcomes).toEqual([
      expect.objectContaining({ id: 'fails', status: 'failed' }),
      { id: 'independent', status: 'completed', value: 'independent:ok' },
      {
        id: 'downstream',
        status: 'blocked',
        reason: 'Dependency fails did not complete successfully.',
      },
    ])
  })

  test('emits stable lifecycle events without serializing independent reads', async () => {
    const plan = planAgentExecution(
      [
        { id: 'a', agentType: 'research', prompt: 'a', mode: 'read' },
        { id: 'b', agentType: 'research', prompt: 'b', mode: 'read' },
        {
          id: 'write',
          agentType: 'implement',
          prompt: 'write',
          mode: 'write',
          dependsOn: ['a', 'b'],
        },
      ],
      { maxParallelism: 2 },
    )
    const started: string[] = []
    const lifecycle: string[] = []
    for await (const event of executeAgentPlanEvents(plan, {
      async launch(task) {
        started.push(task.id)
        return task.id
      },
    })) {
      if (event.type === 'group_started' || event.type === 'group_finished') {
        lifecycle.push(`${event.type}:${event.group.index}`)
      } else {
        lifecycle.push(
          `${event.type}:${event.outcome.id}:${event.outcome.status}`,
        )
      }
    }
    expect(started.slice(0, 2)).toEqual(['a', 'b'])
    expect(lifecycle).toEqual([
      'group_started:0',
      'task_finished:a:completed',
      'task_finished:b:completed',
      'group_finished:0',
      'group_started:1',
      'task_finished:write:completed',
      'group_finished:1',
    ])
  })

  test('emits a fast read result without waiting for a slower sibling', async () => {
    const plan = planAgentExecution([
      { id: 'fast', agentType: 'research', prompt: 'fast', mode: 'read' },
      { id: 'slow', agentType: 'research', prompt: 'slow', mode: 'read' },
    ])
    let releaseFast!: () => void
    let releaseSlow!: () => void
    const fast = new Promise<void>(resolve => {
      releaseFast = resolve
    })
    const slow = new Promise<void>(resolve => {
      releaseSlow = resolve
    })
    const started: string[] = []
    const iterator = executeAgentPlanEvents(plan, {
      async launch(task) {
        started.push(task.id)
        await (task.id === 'fast' ? fast : slow)
        return task.id
      },
    })

    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'group_started' },
    })
    const firstFinished = iterator.next()
    await Promise.resolve()
    expect(started).toEqual(['fast', 'slow'])

    releaseFast()
    await expect(firstFinished).resolves.toMatchObject({
      value: {
        type: 'task_finished',
        outcome: { id: 'fast', status: 'completed' },
      },
    })

    releaseSlow()
    await iterator.return(undefined)
  })
})
