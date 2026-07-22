# Durable automation

Kode now keeps long-running automation state outside the chat transcript. The
data lives under the active Kode data root (`~/.kode` by default, or
`KODE_CONFIG_DIR`) and survives a CLI or daemon restart.

## Goal and loop commands

```text
/goal <objective>
/goal status [goal-id]
/goal cancel <goal-id>
/goal resume <goal-id>
/goal list

/loop <objective> --every 30s|5m|1h
/loop status [goal-id]
/loop cancel <goal-id>
/automation status|recover|events <goal-id>
```

`/goal` starts a session-scoped `GoalRun` immediately and dispatches its first
turn as soon as the interactive session is idle. After each final answer, Kode
asks the quick model for a strict completion decision. A rejected answer
receives a bounded continuation prompt; completion, cancellation, pause, and
lease recovery are recorded as append-only events.

`/loop` creates a durable fixed-interval routine. It never replays missed
intervals after downtime. When an interactive REPL session is idle, the due
prompt is atomically claimed and submitted as a normal turn. The daemon has the
same behaviour for an already-connected idle session. Interval routines return
to the next cadence after their turn instead of being silently marked complete.

## Safety and recovery commands

```text
/checkpoint create [label]
/checkpoint list
/rollback <checkpoint-id> [--force]
/worktree create <label> [--branch <branch>]
/worktree list
/worktree release <id> [--force]
/runs status|reconcile
/supervisor status|plan [serial|parallel] [--max N]|list|refresh <id>|cancel <id>
```

Checkpoints capture the Git index, worktree diff, and untracked files. A normal
rollback refuses workspace drift and first writes an emergency checkpoint. Use
`--force` only after reviewing that emergency checkpoint.

Managed worktrees are created outside the repository and tracked by a durable
lease record. Releasing a dirty managed worktree is refused unless `--force` is
explicitly supplied.

Background shell and agent records are reconciled at startup. A shell is only
considered tailable with an exact process identity; LLM agent/goal runs are
marked interrupted and requeueable rather than falsely reattached.

When a background agent reaches a terminal state, its owning session receives
one task notification at the next main-agent turn. The notification points to
the task output file instead of injecting the full result into context; other
sessions cannot consume it.

The task supervisor is a durable DAG planner over Kode Tasks. It validates
missing dependencies/cycles, exposes ready and critical tasks, and persists
serial or bounded-parallel plans. It never launches an LLM or modifies task
records by itself.

## Memory and integrations

```text
/memory remember <fact or preference>
/memory list [1-20]
/memory search <query>
/memory forget <memory-id>

/watch pr <owner>/<repo>#<number>
/watch run <owner>/<repo>#<run-id>
/browser status
```

Memory is project-scoped, JSONL-backed, deduplicated, TTL-aware, and redacts
common credentials before storage. Automatic extraction requires an explicit
`remember:`/preference/convention marker; ordinary imperative prose is not
persisted. Retrieved records are injected only as bounded, untrusted data and
cannot change policy or tool permissions.

`/watch` runs only validated, read-only `gh` argv calls. It disables interactive
prompts, never comments/merges/reruns, limits output, and redacts secrets.
Browser automation is disabled by default. A host may attach the MCP adapter,
which is fail-closed: every action needs approval, an allowlisted HTTP(S)
page URL reported by the transport after the action, and non-sensitive typed
input. A redirect or an unreported final URL clears the active browser state.

## Windows execution boundary

Kode does not claim that a local PowerShell/Node child process is a sandbox.
On Windows, unattended goal/loop execution blocks every non-read-only tool and
background Bash execution unless a strongly isolated remote execution kernel
(for example a managed WSL2/VM/MCP worker) is supplied by the host. Normal
foreground permission checks remain in place everywhere.

## Module boundaries

- `#core/goals`: GoalRun state, scheduler claims, evaluator state machine.
- `#core/checkpoints`, `#core/worktrees`, `#core/runs`: recovery primitives.
- `#core/automation`: task graph and supervisor planner.
- `#core/memory`, `#core/integrations/github`, `#core/browser`: durable memory
  and fail-closed integration adapters.
- `#runtime/execution`: execution-kernel policy boundary.
