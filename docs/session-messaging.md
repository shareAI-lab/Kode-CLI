# Cross-session messaging

Kode sessions in the same Git workspace can exchange durable local messages without sharing a context window or requiring both sessions to be online.

## Interactive workflow

Run `/session-message` or `/sm` with no arguments to open the message center. It supports:

- active-session discovery and keyboard target selection;
- composing new messages and threaded replies;
- sent and received history with status indicators;
- text, session, message-ID, and thread-ID search;
- unread markers that do not suppress later model delivery;
- cancellation of an outgoing message before the target claims it;
- idle notifications without starting a model turn or consuming tokens.

The command form remains available for fast or script-like interaction:

```text
/sm list
/sm send <session-id|prefix|slug|title|tag> <message>
/sm reply <message-id|8+-character-prefix> <message>
/sm inbox
/sm history [query]
/sm read <message-id|all>
/sm cancel <message-id>
/sm status <message-id>
```

A reviewed voice transcript can use the same transport with
`/voice message <session-id-or-prefix>`. Delivery guarantees and security limits
do not change merely because the body originated from ASR.

The `SessionMessage` agent tool exposes list, send, reply, inbox, history, status, and cancel operations. Sending, replying, and cancelling use the normal permission flow. Task subagents cannot use the tool, which prevents hidden fan-out and message loops.

## Delivery model

Messages are stored under the Kode data root and isolated by a hash of the canonical Git worktree root. Each message has a stable message ID and thread ID.

1. History and sender status are persisted first.
2. An atomic pending file is written as the delivery commit point.
3. The target claims a bounded batch before its next main model turn.
4. A receipt is written only after the model request returns.
5. Failed turns release their claims. Crashed claims expire and return to the queue.

Receipt and cancellation records are checked during recovery, so an interrupted cleanup cannot redeliver a terminal message. Delivery is at-least-once until a receipt exists; consumers can use the stable message ID for deduplication.

## Security and limits

- Only persisted sessions with verified `cwd` metadata in the exact canonical Git workspace are discoverable.
- Received content is escaped and injected as untrusted peer context below the current user's instructions.
- Files use owner-only permissions (`0600`) and directories use `0700`.
- Messages are limited to 16 KiB, queues to 256 messages, and model batches to 8 messages or 64 KiB.
- History is bounded to 4096 records. UI queries return at most 200 records.
- Idle monitoring only checks the local mailbox and raises a notification. It never invokes a model.

This is a same-machine, same-user cooperative channel. It is not an authenticated remote transport and does not defend against a malicious process already running as the same operating-system user.
