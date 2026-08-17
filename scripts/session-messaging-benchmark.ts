import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  acknowledgeSessionMessages,
  claimSessionMessages,
  getSessionMessageHistory,
  getSessionMessageInboxSummary,
  getSessionMessageStatus,
  sendSessionMessage,
} from '../packages/protocol/src/sessionMessaging'
import { getSessionLogFilePath } from '../packages/protocol/src/utils/kodeAgentSessionLog'

const SENDER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TARGET = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function writeSession(cwd: string, sessionId: string, title: string): void {
  const path = getSessionLogFilePath({ cwd, sessionId })
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    `${JSON.stringify({
      type: 'user',
      uuid: crypto.randomUUID(),
      sessionId,
      cwd,
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: title },
    })}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
}

const requestedCount = Number.parseInt(process.argv[2] ?? '200', 10)
const count = Number.isFinite(requestedCount)
  ? Math.min(240, Math.max(1, requestedCount))
  : 200
const configDir = mkdtempSync(join(tmpdir(), 'kode-session-bench-config-'))
const workspace = mkdtempSync(join(tmpdir(), 'kode-session-bench-workspace-'))
const previousConfigDir = process.env.KODE_CONFIG_DIR

try {
  process.env.KODE_CONFIG_DIR = configDir
  writeSession(workspace, SENDER, 'Benchmark sender')
  writeSession(workspace, TARGET, 'Benchmark target')

  const body = `Coordinate benchmark payload: ${'x'.repeat(992)}`
  const sendStartedAt = performance.now()
  const sent = await Promise.all(
    Array.from({ length: count }, (_, index) =>
      sendSessionMessage({
        cwd: workspace,
        senderSessionId: SENDER,
        targetSessionId: TARGET,
        body: `${body}:${index}`,
      }),
    ),
  )
  const sendDurationMs = performance.now() - sendStartedAt

  const deliveryStartedAt = performance.now()
  let delivered = 0
  for (;;) {
    const claimed = await claimSessionMessages({
      cwd: workspace,
      sessionId: TARGET,
      limit: 32,
    })
    if (claimed.length === 0) break
    delivered += await acknowledgeSessionMessages({
      cwd: workspace,
      sessionId: TARGET,
      messageIds: claimed.map(message => message.messageId),
    })
  }
  const deliveryDurationMs = performance.now() - deliveryStartedAt

  const receiptStartedAt = performance.now()
  const receiptCount = sent.filter(
    message =>
      getSessionMessageStatus({
        cwd: workspace,
        senderSessionId: SENDER,
        messageId: message.messageId,
      }).status === 'delivered',
  ).length
  const receiptDurationMs = performance.now() - receiptStartedAt

  const historyStartedAt = performance.now()
  const history = getSessionMessageHistory({
    cwd: workspace,
    sessionId: SENDER,
    query: 'benchmark payload',
    limit: 200,
  })
  const historyDurationMs = performance.now() - historyStartedAt

  const idlePollStartedAt = performance.now()
  const idlePollIterations = 100
  for (let index = 0; index < idlePollIterations; index += 1) {
    await getSessionMessageInboxSummary({ cwd: workspace, sessionId: TARGET })
  }
  const idlePollDurationMs = performance.now() - idlePollStartedAt

  const expectedHistoryCount = Math.min(count, 200)
  if (
    delivered !== count ||
    receiptCount !== count ||
    history.length !== expectedHistoryCount
  ) {
    throw new Error(
      `Benchmark correctness failure: sent=${count}, delivered=${delivered}, receipts=${receiptCount}, history=${history.length}`,
    )
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        messages: count,
        payloadBytes: Buffer.byteLength(body, 'utf8'),
        send: {
          durationMs: Number(sendDurationMs.toFixed(2)),
          messagesPerSecond: Number(
            (count / (sendDurationMs / 1_000)).toFixed(2),
          ),
        },
        claimAndAcknowledge: {
          durationMs: Number(deliveryDurationMs.toFixed(2)),
          messagesPerSecond: Number(
            (count / (deliveryDurationMs / 1_000)).toFixed(2),
          ),
        },
        receiptLookup: {
          durationMs: Number(receiptDurationMs.toFixed(2)),
          messagesPerSecond: Number(
            (count / (receiptDurationMs / 1_000)).toFixed(2),
          ),
        },
        historySearch: {
          matched: history.length,
          durationMs: Number(historyDurationMs.toFixed(2)),
        },
        emptyInboxPoll: {
          iterations: idlePollIterations,
          durationMs: Number(idlePollDurationMs.toFixed(2)),
          averageMs: Number(
            (idlePollDurationMs / idlePollIterations).toFixed(3),
          ),
        },
      },
      null,
      2,
    )}\n`,
  )
} finally {
  if (previousConfigDir === undefined) delete process.env.KODE_CONFIG_DIR
  else process.env.KODE_CONFIG_DIR = previousConfigDir
  rmSync(configDir, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
}
