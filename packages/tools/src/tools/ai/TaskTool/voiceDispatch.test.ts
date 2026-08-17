import { describe, expect, test } from 'bun:test'

import { callTaskTool, getVoiceTaskDispatchError } from './call'

describe('voice task dispatch policy', () => {
  test('rejects direct delegation from an unorganized voice turn', () => {
    expect(
      getVoiceTaskDispatchError({ options: { voiceTurn: true } }),
    ).toContain('must use TaskBatch')
  })

  test('enforces the policy before a direct Task call can resolve an agent', async () => {
    const iterator = callTaskTool(
      {
        description: 'Raw voice task',
        prompt: 'Uh, check the thing and maybe change it.',
        subagent_type: 'Explore',
      },
      {
        abortController: new AbortController(),
        messageId: 'voice-direct-task',
        readFileTimestamps: {},
        options: { voiceTurn: true },
      },
    )
    await expect(iterator.next()).rejects.toThrow('must use TaskBatch')
  })

  test('allows normal text work and a TaskBatch-approved voice task', () => {
    expect(getVoiceTaskDispatchError({ options: {} })).toBeNull()
    expect(
      getVoiceTaskDispatchError({
        options: { voiceTurn: true, voiceIntentPrepared: true },
      }),
    ).toBeNull()
  })
})
