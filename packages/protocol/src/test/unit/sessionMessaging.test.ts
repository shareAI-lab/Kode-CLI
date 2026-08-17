import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import {
  __getSessionMessagePathsForTests,
  acknowledgeSessionMessages,
  cancelSessionMessage,
  claimSessionMessages,
  formatSessionMessagesForContext,
  getSessionMessageHistory,
  getSessionMessageInboxSummary,
  getSessionMessageStatus,
  listSessionMessageTargets,
  markSessionMessagesRead,
  peekSessionMessages,
  releaseSessionMessageClaims,
  replyToSessionMessage,
  resolveSessionMessageTarget,
  sendSessionMessage,
  SESSION_MESSAGE_MAX_BYTES,
  SESSION_MESSAGE_MAX_QUEUED,
  SessionMessageError,
} from '../../sessionMessaging'
import { getSessionLogFilePath } from '../../utils/kodeAgentSessionLog'

const SENDER = '11111111-1111-4111-8111-111111111111'
const TARGET = '22222222-2222-4222-8222-222222222222'
const OTHER = '33333333-3333-4333-8333-333333333333'

function writeSession(args: {
  cwd: string
  sessionId: string
  title: string
  timestamp?: number
}): void {
  const path = getSessionLogFilePath({
    cwd: args.cwd,
    sessionId: args.sessionId,
  })
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    `${JSON.stringify({
      type: 'user',
      uuid: crypto.randomUUID(),
      sessionId: args.sessionId,
      cwd: args.cwd,
      slug: args.title.toLowerCase().replaceAll(' ', '-'),
      timestamp: new Date(args.timestamp ?? Date.now()).toISOString(),
      message: { role: 'user', content: args.title },
    })}\n${JSON.stringify({
      type: 'custom-title',
      sessionId: args.sessionId,
      customTitle: args.title,
    })}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
}

describe('durable cross-session messaging', () => {
  const originalConfigDir = process.env.KODE_CONFIG_DIR
  let configDir: string
  let workspace: string

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'kode-session-message-config-'))
    workspace = mkdtempSync(join(tmpdir(), 'kode-session-message-workspace-'))
    process.env.KODE_CONFIG_DIR = configDir
    writeSession({ cwd: workspace, sessionId: SENDER, title: 'Sender' })
    writeSession({ cwd: workspace, sessionId: TARGET, title: 'Target review' })
  })

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.KODE_CONFIG_DIR
    else process.env.KODE_CONFIG_DIR = originalConfigDir
    rmSync(configDir, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  })

  test('lists, resolves, queues, claims, injects, and receipts a message', async () => {
    const targets = listSessionMessageTargets({
      cwd: workspace,
      currentSessionId: SENDER,
    })
    expect(targets.map(target => target.sessionId)).toEqual([TARGET, SENDER])
    expect(targets.find(target => target.sessionId === SENDER)?.isCurrent).toBe(
      true,
    )

    const resolved = resolveSessionMessageTarget({
      cwd: workspace,
      currentSessionId: SENDER,
      identifier: 'target-review',
    })
    expect(resolved).toEqual({ sessionId: TARGET, label: 'Target review' })

    const sent = await sendSessionMessage({
      cwd: workspace,
      senderSessionId: SENDER,
      targetSessionId: TARGET,
      body: 'Please verify <unsafe> & report evidence.',
      now: 1_750_000_000_000,
    })
    expect(
      getSessionMessageStatus({
        cwd: workspace,
        senderSessionId: SENDER,
        messageId: sent.messageId,
      }).status,
    ).toBe('queued')
    expect(
      (await peekSessionMessages({ cwd: workspace, sessionId: TARGET }))[0],
    ).toMatchObject({
      messageId: sent.messageId,
      senderSessionId: SENDER,
      targetSessionId: TARGET,
    })

    const claimed = await claimSessionMessages({
      cwd: workspace,
      sessionId: TARGET,
    })
    expect(claimed.map(message => message.messageId)).toEqual([sent.messageId])
    expect(
      getSessionMessageStatus({
        cwd: workspace,
        senderSessionId: SENDER,
        messageId: sent.messageId,
      }).status,
    ).toBe('claimed')

    const context = formatSessionMessagesForContext(claimed)
    expect(context).toContain('untrusted peer context')
    expect(context).toContain('&lt;unsafe&gt; &amp; report evidence.')
    expect(context).not.toContain('<unsafe>')

    expect(
      await acknowledgeSessionMessages({
        cwd: workspace,
        sessionId: TARGET,
        messageIds: [sent.messageId],
        deliveredAt: 1_750_000_000_500,
      }),
    ).toBe(1)
    expect(
      await peekSessionMessages({ cwd: workspace, sessionId: TARGET }),
    ).toEqual([])
    expect(
      getSessionMessageStatus({
        cwd: workspace,
        senderSessionId: SENDER,
        messageId: sent.messageId,
      }),
    ).toMatchObject({
      status: 'delivered',
      messageId: sent.messageId,
      deliveredAt: 1_750_000_000_500,
    })
  })

  test('recovers expired claims and supports explicit release', async () => {
    const first = await sendSessionMessage({
      cwd: workspace,
      senderSessionId: SENDER,
      targetSessionId: TARGET,
      body: 'first',
    })
    const second = await sendSessionMessage({
      cwd: workspace,
      senderSessionId: SENDER,
      targetSessionId: TARGET,
      body: 'second',
    })
    const claimTime = Date.now()
    const claimed = await claimSessionMessages({
      cwd: workspace,
      sessionId: TARGET,
      limit: 2,
      now: claimTime,
    })
    expect(claimed).toHaveLength(2)

    expect(
      await releaseSessionMessageClaims({
        cwd: workspace,
        sessionId: TARGET,
        messageIds: [first.messageId],
      }),
    ).toBe(1)
    expect(
      (await peekSessionMessages({ cwd: workspace, sessionId: TARGET })).map(
        message => message.messageId,
      ),
    ).toEqual([first.messageId])

    const recovered = await peekSessionMessages({
      cwd: workspace,
      sessionId: TARGET,
      now: claimTime + 1,
      claimLeaseMs: 0,
    })
    expect(recovered.map(message => message.messageId).sort()).toEqual(
      [first.messageId, second.messageId].sort(),
    )
  })

  test('does not redeliver terminal inflight records after a crash window', async () => {
    const sent = await sendSessionMessage({
      cwd: workspace,
      senderSessionId: SENDER,
      targetSessionId: TARGET,
      body: 'deliver exactly once after receipt persistence',
    })
    await claimSessionMessages({ cwd: workspace, sessionId: TARGET })
    await expect(
      acknowledgeSessionMessages({
        cwd: workspace,
        sessionId: TARGET,
        messageIds: [sent.messageId],
        deliveredAt: Number.NaN,
      }),
    ).rejects.toMatchObject({ code: 'invalid_message' })
    expect(
      await acknowledgeSessionMessages({
        cwd: workspace,
        sessionId: TARGET,
        messageIds: [sent.messageId],
      }),
    ).toBe(1)

    const paths = __getSessionMessagePathsForTests({
      cwd: workspace,
      sessionId: TARGET,
    })
    const staleInflightPath = join(paths.inflight, `${sent.messageId}.json`)
    writeFileSync(staleInflightPath, `${JSON.stringify(sent)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    expect(
      await peekSessionMessages({
        cwd: workspace,
        sessionId: TARGET,
        claimLeaseMs: 0,
      }),
    ).toEqual([])
    expect(existsSync(staleInflightPath)).toBe(false)
  })

  test('keeps replies in a thread and exposes two-sided searchable history', async () => {
    const first = await sendSessionMessage({
      cwd: workspace,
      senderSessionId: SENDER,
      targetSessionId: TARGET,
      body: 'Audit the parser boundary.',
      now: 1_750_000_000_000,
    })
    const reply = await replyToSessionMessage({
      cwd: workspace,
      sessionId: TARGET,
      messageId: first.messageId.slice(0, 8),
      body: 'Verified the parser boundary with a regression test.',
      now: 1_750_000_000_100,
    })

    expect(reply.threadId).toBe(first.messageId)
    expect(reply.replyToMessageId).toBe(first.messageId)
    expect(
      getSessionMessageHistory({ cwd: workspace, sessionId: SENDER }).map(
        item => [item.direction, item.message.messageId],
      ),
    ).toEqual([
      ['incoming', reply.messageId],
      ['outgoing', first.messageId],
    ])
    expect(
      getSessionMessageHistory({
        cwd: workspace,
        sessionId: TARGET,
        query: 'regression',
      })[0]?.message.messageId,
    ).toBe(reply.messageId)
    expect(formatSessionMessagesForContext([reply])).toContain(
      `<reply-to-message-id>${first.messageId}</reply-to-message-id>`,
    )
  })

  test('refreshes cached discovery when a new target appears', () => {
    expect(
      listSessionMessageTargets({
        cwd: workspace,
        currentSessionId: SENDER,
      }).some(target => target.sessionId === OTHER),
    ).toBe(false)
    writeSession({ cwd: workspace, sessionId: OTHER, title: 'New reviewer' })
    expect(
      resolveSessionMessageTarget({
        cwd: workspace,
        currentSessionId: SENDER,
        identifier: 'new-reviewer',
      }),
    ).toEqual({ sessionId: OTHER, label: 'New reviewer' })
  })

  test('reads version-one messages created before thread metadata existed', async () => {
    const paths = __getSessionMessagePathsForTests({
      cwd: workspace,
      sessionId: TARGET,
    })
    mkdirSync(paths.pending, { recursive: true })
    const messageId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    writeFileSync(
      join(paths.pending, `${messageId}.json`),
      `${JSON.stringify({
        version: 1,
        messageId,
        workspaceId: paths.workspaceId,
        senderSessionId: SENDER,
        targetSessionId: TARGET,
        body: 'legacy queue message',
        sentAt: 1_750_000_000_000,
      })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )

    expect(
      (await peekSessionMessages({ cwd: workspace, sessionId: TARGET }))[0],
    ).toMatchObject({
      messageId,
      threadId: messageId,
      replyToMessageId: null,
    })
  })

  test('tracks unread state separately from model delivery', async () => {
    const first = await sendSessionMessage({
      cwd: workspace,
      senderSessionId: SENDER,
      targetSessionId: TARGET,
      body: 'first unread',
    })
    await sendSessionMessage({
      cwd: workspace,
      senderSessionId: SENDER,
      targetSessionId: TARGET,
      body: 'second unread',
    })

    expect(
      (
        await getSessionMessageInboxSummary({
          cwd: workspace,
          sessionId: TARGET,
        })
      ).unreadCount,
    ).toBe(2)
    expect(
      await markSessionMessagesRead({
        cwd: workspace,
        sessionId: TARGET,
        messageIds: [first.messageId],
      }),
    ).toBe(1)
    expect(
      (
        await getSessionMessageInboxSummary({
          cwd: workspace,
          sessionId: TARGET,
        })
      ).unreadCount,
    ).toBe(1)
    expect(
      (await peekSessionMessages({ cwd: workspace, sessionId: TARGET })).map(
        message => message.messageId,
      ),
    ).toContain(first.messageId)
    expect(
      getSessionMessageHistory({ cwd: workspace, sessionId: TARGET }).find(
        item => item.message.messageId === first.messageId,
      )?.isUnread,
    ).toBe(false)
  })

  test('cancels only queued outgoing messages and never delivers them', async () => {
    const queued = await sendSessionMessage({
      cwd: workspace,
      senderSessionId: SENDER,
      targetSessionId: TARGET,
      body: 'withdraw this handoff',
      now: 1_750_000_000_000,
    })
    await expect(
      cancelSessionMessage({
        cwd: workspace,
        senderSessionId: TARGET,
        messageId: queued.messageId,
      }),
    ).rejects.toMatchObject({ code: 'message_not_found' })

    expect(
      await cancelSessionMessage({
        cwd: workspace,
        senderSessionId: SENDER,
        messageId: queued.messageId.slice(0, 8),
        cancelledAt: 1_750_000_000_010,
      }),
    ).toMatchObject({
      status: 'cancelled',
      messageId: queued.messageId,
      cancelledAt: 1_750_000_000_010,
    })
    expect(
      await claimSessionMessages({ cwd: workspace, sessionId: TARGET }),
    ).toEqual([])
    expect(
      getSessionMessageStatus({
        cwd: workspace,
        senderSessionId: SENDER,
        messageId: queued.messageId.slice(0, 8),
      }).status,
    ).toBe('cancelled')
    await expect(
      cancelSessionMessage({
        cwd: workspace,
        senderSessionId: SENDER,
        messageId: queued.messageId,
      }),
    ).rejects.toMatchObject({ code: 'already_cancelled' })

    const claimedMessage = await sendSessionMessage({
      cwd: workspace,
      senderSessionId: SENDER,
      targetSessionId: TARGET,
      body: 'already processing',
    })
    await claimSessionMessages({ cwd: workspace, sessionId: TARGET })
    await expect(
      cancelSessionMessage({
        cwd: workspace,
        senderSessionId: SENDER,
        messageId: claimedMessage.messageId,
      }),
    ).rejects.toMatchObject({ code: 'already_claimed' })
  })

  test('does not lose messages from concurrent senders', async () => {
    writeSession({ cwd: workspace, sessionId: OTHER, title: 'Other sender' })
    const sends = Array.from({ length: 32 }, (_, index) =>
      sendSessionMessage({
        cwd: workspace,
        senderSessionId: index % 2 === 0 ? SENDER : OTHER,
        targetSessionId: TARGET,
        body: `message-${index}`,
      }),
    )
    const sent = await Promise.all(sends)
    const pending = await peekSessionMessages({
      cwd: workspace,
      sessionId: TARGET,
      limit: 50,
    })
    expect(new Set(pending.map(message => message.messageId)).size).toBe(32)
    expect(new Set(sent.map(message => message.messageId)).size).toBe(32)
    expect(new Set(pending.map(message => message.body)).size).toBe(32)
  })

  test('serializes independent sender processes without overwriting messages', async () => {
    const modulePath = resolve(
      process.cwd(),
      'packages/protocol/src/sessionMessaging.ts',
    )
    const workers = Array.from({ length: 4 }, (_, workerIndex) => {
      const prefix = ['8', '9', 'a', 'b'][workerIndex]!
      const sender = `${prefix.repeat(8)}-0000-4000-8000-000000000000`
      const script = [
        `import { sendSessionMessage } from ${JSON.stringify(modulePath)}`,
        `const cwd = ${JSON.stringify(workspace)}`,
        `const sender = ${JSON.stringify(sender)}`,
        `const target = ${JSON.stringify(TARGET)}`,
        'await Promise.all(Array.from({ length: 10 }, (_, index) => sendSessionMessage({ cwd, senderSessionId: sender, targetSessionId: target, body: `worker-message-${sender}-${index}` })))',
      ].join('\n')
      return Bun.spawn({
        cmd: [process.execPath, '-e', script],
        cwd: process.cwd(),
        env: { ...process.env, KODE_CONFIG_DIR: configDir },
        stdout: 'pipe',
        stderr: 'pipe',
      })
    })

    const exits = await Promise.all(workers.map(worker => worker.exited))
    const errors = await Promise.all(
      workers.map(worker => new Response(worker.stderr).text()),
    )
    expect(exits).toEqual([0, 0, 0, 0])
    expect(errors.join('')).toBe('')

    const pending = await peekSessionMessages({
      cwd: workspace,
      sessionId: TARGET,
      limit: 50,
    })
    expect(pending).toHaveLength(40)
    expect(new Set(pending.map(message => message.messageId)).size).toBe(40)
    expect(new Set(pending.map(message => message.body)).size).toBe(40)
  }, 15_000)

  test('serializes cancellation against a claim across independent processes', async () => {
    const sent = await sendSessionMessage({
      cwd: workspace,
      senderSessionId: SENDER,
      targetSessionId: TARGET,
      body: 'race cancellation against delivery claim',
    })
    const modulePath = resolve(
      process.cwd(),
      'packages/protocol/src/sessionMessaging.ts',
    )
    const cancelScript = [
      `import { cancelSessionMessage } from ${JSON.stringify(modulePath)}`,
      `try { const result = await cancelSessionMessage({ cwd: ${JSON.stringify(workspace)}, senderSessionId: ${JSON.stringify(SENDER)}, messageId: ${JSON.stringify(sent.messageId)} }); console.log(JSON.stringify({ kind: 'cancel', status: result.status })) } catch (error) { console.log(JSON.stringify({ kind: 'cancel', error: error?.code ?? 'unknown' })) }`,
    ].join('\n')
    const claimScript = [
      `import { claimSessionMessages } from ${JSON.stringify(modulePath)}`,
      `const result = await claimSessionMessages({ cwd: ${JSON.stringify(workspace)}, sessionId: ${JSON.stringify(TARGET)} }); console.log(JSON.stringify({ kind: 'claim', count: result.length }))`,
    ].join('\n')
    const workers = [cancelScript, claimScript].map(script =>
      Bun.spawn({
        cmd: [process.execPath, '-e', script],
        cwd: process.cwd(),
        env: { ...process.env, KODE_CONFIG_DIR: configDir },
        stdout: 'pipe',
        stderr: 'pipe',
      }),
    )
    expect(await Promise.all(workers.map(worker => worker.exited))).toEqual([
      0, 0,
    ])
    const output = await Promise.all(
      workers.map(
        async worker =>
          JSON.parse((await new Response(worker.stdout).text()).trim()) as {
            kind: 'cancel' | 'claim'
            status?: string
            error?: string
            count?: number
          },
      ),
    )
    const cancellation = output.find(item => item.kind === 'cancel')!
    const claim = output.find(item => item.kind === 'claim')!
    if (cancellation.status === 'cancelled') {
      expect(claim.count).toBe(0)
    } else {
      expect(cancellation.error).toBe('already_claimed')
      expect(claim.count).toBe(1)
    }
  }, 15_000)

  test('fails closed for self-send, cross-workspace targets, oversized input, and full queues', async () => {
    const legacyPath = getSessionLogFilePath({
      cwd: workspace,
      sessionId: OTHER,
    })
    mkdirSync(dirname(legacyPath), { recursive: true })
    writeFileSync(
      legacyPath,
      `${JSON.stringify({
        type: 'user',
        uuid: crypto.randomUUID(),
        sessionId: OTHER,
        timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'missing cwd metadata' },
      })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )
    expect(
      listSessionMessageTargets({
        cwd: workspace,
        currentSessionId: SENDER,
      }).some(target => target.sessionId === OTHER),
    ).toBe(false)

    const otherWorkspace = mkdtempSync(
      join(tmpdir(), 'kode-session-message-other-workspace-'),
    )
    try {
      writeSession({
        cwd: otherWorkspace,
        sessionId: OTHER,
        title: 'Elsewhere',
      })

      await expect(
        sendSessionMessage({
          cwd: workspace,
          senderSessionId: SENDER,
          targetSessionId: SENDER,
          body: 'self',
        }),
      ).rejects.toMatchObject({ code: 'self_send' })
      await expect(
        sendSessionMessage({
          cwd: workspace,
          senderSessionId: SENDER,
          targetSessionId: OTHER,
          body: 'cross workspace',
        }),
      ).rejects.toMatchObject({ code: 'target_not_found' })
      await expect(
        sendSessionMessage({
          cwd: workspace,
          senderSessionId: SENDER,
          targetSessionId: TARGET,
          body: '界'.repeat(SESSION_MESSAGE_MAX_BYTES),
        }),
      ).rejects.toMatchObject({ code: 'message_too_large' })

      const paths = __getSessionMessagePathsForTests({
        cwd: workspace,
        sessionId: TARGET,
      })
      mkdirSync(paths.pending, { recursive: true })
      for (let index = 0; index < SESSION_MESSAGE_MAX_QUEUED; index += 1) {
        const id = `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`
        writeFileSync(join(paths.pending, `${id}.json`), '{}')
      }
      await expect(
        sendSessionMessage({
          cwd: workspace,
          senderSessionId: SENDER,
          targetSessionId: TARGET,
          body: 'queue overflow',
        }),
      ).rejects.toMatchObject({ code: 'queue_full' })
    } finally {
      rmSync(otherWorkspace, { recursive: true, force: true })
    }
  })
})
