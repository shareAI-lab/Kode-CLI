# Voice conversation and agent orchestration

## Decision

`/voice` is an opt-in, macOS-first conversational input surface. It records a
short WAV locally, sends it to MiMo ASR, lets the person edit the transcript,
and only then submits a normal user message to the existing REPL. A completed
reply may be synthesized with MiMo TTS and played asynchronously.

## Experimental rollout

Voice is disabled by default, including command discovery. On `beta`, enable
it only for an explicit trial by starting Kode with:

```bash
KODE_EXPERIMENTAL_VOICE=1 kode
```

The process must be restarted after changing this environment variable. The
flag exposes `/voice`; it does not bypass microphone permissions, transcript
review, normal tool approval, or the MiMo API-key requirement. Open
`/voice config` to paste a MiMo key; the masked value is stored only in Kode's
owner-only credential store. An environment value such as `MIMO_API_KEY` still
takes precedence for managed or CI use. Keys are never accepted as slash-command
arguments and never written to regular Kode configuration.

It is deliberately **not** a second command interpreter, a bypass of tool
permissions, or proof that a task plan has launched subagents.

MiMo documents SSE streaming for both completed-audio ASR and PCM16 TTS. The
implementation uses those streaming responses, while retaining a bounded WAV
fallback if an API-compatible proxy does not preserve SSE. It does **not** claim
live microphone upload or hands-free endpointing: capture is still an explicit,
user-controlled push-to-talk interval.

Primary API references: [MiMo ASR](https://mimo.mi.com/docs/en-US/api/audio/Speech-Recognition),
[MiMo TTS](https://mimo.mi.com/docs/en-US/api/audio/tts), and
[MiMo model list](https://mimo.mi.com/docs/en-US/api/model/list-models).

## Current architecture

```text
microphone
  -> native macOS recorder (16 kHz mono WAV; private temporary directory)
  -> MiMo ASR SSE adapter (progressive transcript)
  -> editable transcript / explicit Send
  -> existing REPL user-message and main-agent intent brief
  -> clarification, normal answer, or validated TaskBatch -> TaskTool path
  -> assistant text transcript
  -> optional MiMo TTS SSE PCM16 -> bounded native playback queue
```

The implementation boundary is intentionally narrow:

| Layer                                                | Owns                                                                                   | Does not own                       |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------- |
| `packages/runtime/src/voice`                         | macOS recording/playback, temporary-file cleanup, versioned private Swift-helper cache | provider requests, user intent     |
| `packages/ai/src/voice`                              | MiMo request/response contract and response validation                                 | secrets at rest, native I/O        |
| `apps/cli/src/ui/screens/overlays/VoiceScreen.tsx`   | visible capture, cancellation, review/send states                                      | tool approval, task execution      |
| REPL                                                 | normal conversation, permissions, model tools and final transcript                     | microphone/device policy           |
| `packages/core/src/automation/agentOrchestration.ts` | deterministic dependency plan and injected execution semantics                         | choosing an intent from raw speech |

`TaskSupervisor` remains a persistent planner/observer. It has no worker or
LLM invocation by design. Actual background Task agents continue to be launched
through the existing TaskTool path, where permission and lifecycle behavior is
already defined.

## Why a transcript is not a command

Speech is often fragmented: fillers, pauses, corrections, restarts, implied
references ("the previous one"), and incomplete requests are normal. ASR can
also contain wrong words. A local keyword parser would make a dangerous action
look certain when it is not.

For each voice-originated turn, the main agent receives additional scoped
instructions to:

1. resolve only obvious filler/repetition from prior conversation;
2. maintain a **tentative** reading of the current goal, confirmed facts,
   explicit corrections, and open questions rather than treating every turn as
   an instruction form;
3. ask one concise clarification when an ambiguity changes a write, external,
   or irreversible effect; bounded read-only investigation may proceed while
   the broader conversation remains open;
4. freeze an execution brief only when moving from conversation to delegated
   work;
5. keep normal approval for writes, shell execution, publication, cost, or
   external state changes;
6. respond with a short spoken-friendly first sentence and visible progress for
   longer work.

This is a conversation state machine, not an assumption that every utterance is
a complete instruction:

```text
idle -> recording -> transcribing -> review -> submitted
             |              |            |          |
             +--cancel------+--failure---+--edit-----+--normal REPL turn
                                                       |
                         tentative conversation ------+--> natural reply / revise understanding
                         bounded read-only question --+--> state what is being checked
                         clear execution boundary ----+--> freeze brief -> TaskBatch
                         side effect -----------------+--> existing approval gate
```

The user can always cancel while recording or transcription is in flight. No
audio is retained after an individual request completes or fails. The review
screen is the last, user-controlled checkpoint before any model sees the text.

### Voice intent brief

For a jumpy request, the main agent reconciles the conversation before any
subagent starts. The brief is an execution snapshot, not a second
transcription, a per-turn classification step, or a replacement for the
user-visible original text:

```text
normalized goal: inspect the current architecture and report the likely cause
explicit facts: current workspace only; report before changing files
assumptions: read-only investigation is sufficient
unresolved questions: []
subtasks: one self-contained exploration prompt per agent
```

If an unresolved question is material—such as which target to change, whether a
previous statement was retracted, or whether a side effect is intended—the
brief stays non-runnable and the user receives a focused clarification instead.
The main agent may still begin a clearly bounded read-only check, but must say
what it is checking and must not represent that check as a commitment to the
larger unfinished request.

## Interaction design

The first vertical slice uses explicit push-to-talk because it is understandable
and reliable in a terminal:

| State        | User feedback                               | Input behavior                                                   | Recovery                                    |
| ------------ | ------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------- |
| Ready        | "Press Enter"                               | start capture                                                    | close or configure key                      |
| Preparing    | visible setup state                         | input held                                                       | failure explains permission/config boundary |
| Recording    | persistent Listening indicator and time cap | Enter stops, Esc cancels                                         | no partial submission                       |
| Transcribing | progressive transcript as ASR SSE arrives   | Esc aborts                                                       | returns to ready without transcript         |
| Review       | editable transcript                         | Enter sends, Ctrl+R appends another capture, Esc closes          | edit, retry, or abandon                     |
| Agent work   | existing REPL stream and permission UI      | normal cancel/approval controls                                  | text remains authoritative                  |
| TTS playback | text is already complete                    | low-latency PCM stream; `/voice stop` or new input interrupts it | failure never changes chat result           |

The next interaction increments should be validated independently, in this
order: device selector + audio meter, VAD-assisted pause segmentation, interim
transcripts, then true barge-in (stop/resume playback). Do not enable hands-free
auto-submit until endpointing has false-positive evidence for the target
language and acoustic environment.

## What other systems teach us

The design borrows patterns, not dependencies:

- [LiveKit's turn model](https://docs.livekit.io/agents/logic/turns/) separates
  speech activity, end-of-turn detection, and interruption detection. It also
  treats false interruption recovery as a first-class behavior. We apply the
  separation now, but defer VAD/barge-in because `/voice` is push-to-talk.
- [LiveKit session events](https://docs.livekit.io/agents/logic/sessions/)
  expose listening, thinking, speaking, transcription, and conversation updates
  as independent states. The CLI uses the same user-visible state distinction
  rather than a single spinner.
- [Pipecat's release notes](https://github.com/pipecat-ai/pipecat/releases)
  emphasize cancellation, stale-response filtering, and queue-backed streaming.
  Each Kode playback has a generation id; interruption aborts the pending SSE
  request, stops the native player, and makes queued audio stale.
- [Semantic Kernel orchestration patterns](https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-orchestration/)
  distinguish concurrent, sequential, and handoff workflows. Our planner only
  parallelizes read-only work and serializes writers. Dynamic handoff remains a
  deliberate main-agent decision, not a keyword match.
- [Microsoft's handoff workflow](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/handoff)
  keeps interaction, handoff rules, context synchronization, and sensitive tool
  approval explicit. Kode likewise preserves a single authoritative REPL
  transcript and existing approval path.

## Agent dispatch model

The scheduler is a three-stage gate:

```text
voice transcript -> main-agent intent brief -> structured work items -> execution adapter
                         |                      |                      |
                 clarify / answer now   validate brief + DAG     TaskTool/runtime launch
```

1. **Intent brief** decides whether this is a normal answer, a clarification, a
   read-only investigation, or a proposed state-changing task. Before it can
   delegate, it records a normalized goal, explicit facts/constraints, bounded
   assumptions, and unresolved questions. A nonempty unresolved-question list
   is a hard stop: ask the user rather than guessing. Raw ASR wording is not
   passed to a subagent.
2. **Plan** receives the intent brief plus structured `AgentWorkItem`s. It rejects empty/duplicate
   identifiers, missing/self/duplicate dependencies, bad modes, and cycles.
   Independent read-only items run in bounded parallel groups; every writer is
   alone in a group, and reads do not overlap writers.
3. **Execute** is injected by the host. A failed task blocks its dependents but
   does not unnecessarily stop independent work. A host must persist task/run
   identifiers before offering crash recovery; the current pure executor does
   not claim durable scheduling.

The main-agent tool surface now includes `TaskBatch` for this narrow execution
case. It validates the graph, starts the actual existing Task agents, keeps
verified read-only agents within a bounded concurrent group, emits group and
task lifecycle progress to the active conversation, and waits for each group
before unlocking dependents. An agent with `tools: "*"`, shell, edit, or
an unknown capability cannot be declared read-only; it must run as a serialized
write task. Task subagents are not offered `TaskBatch`, preventing recursive
fan-out. Each launched task retains its normal agent transcript, permission
context, model selection, and result rendering.

For a voice turn, direct `Task` delegation is rejected. `TaskBatch` is the
only gateway and requires `voice_intent`; after validation it wraps every
subagent prompt in the normalized brief. This makes the main agent the single
place where a jumpy or self-correcting conversation is reconciled, while each
subagent receives one bounded, self-contained assignment.

### Continuation rather than duplicate delegation

`TaskBatch` accepts an optional `resume_agent_id` for a task. The main agent
uses it only when the user explicitly asks to continue a known, inactive agent
and the prior id is present in the conversation. The task is still launched
through the normal `TaskTool` resume path, but the current execution brief and
task prompt explicitly override older assumptions in that transcript. The UI
labels this as a continuation and reports it in lifecycle progress.

This is intentionally not a way to send an instruction to an active background
agent or to bypass approval. Foreground batch tasks finish before returning;
active background Agents instead use the bounded runtime-guidance control below.
That queue is process-local and deliberately does not claim restart recovery.

This avoids three common failures: all agents receiving conflicting raw speech,
parallel filesystem writes, and a UI that says "dispatched" while only a plan
exists.

## Runtime control and cross-session routing

Voice is also a reviewed input surface for the existing control planes; it does
not create a voice-only execution path:

```text
/voice tasks
/voice task <task-id>
/voice guide [task-id]
/voice message <session-id-or-prefix>
```

- `tasks` and `task` inspect the same live topology exposed to the main Agent by
  `TaskMonitor`: status, runtime, last activity, turn count, and queued/applied
  guidance counts.
- `guide` records and transcribes, then requires the normal editable review
  checkpoint before queuing guidance for a running background Agent. If exactly
  one Agent is running, the task ID may be omitted.
- `message` uses the durable same-workspace session mailbox after review. It has
  the same target isolation, queue limit, status, and crash-recovery semantics
  as `/sm`; voice does not weaken them.

The main Agent can use `TaskGuide` for the same runtime redirection. A queued
record is injected only before the target's next model request and becomes
`applied` after that request accepts it. It cannot undo a shell/tool action that
already started. `TaskStop` remains the explicit immediate-interruption path.
`TaskMonitor` is read-only, while `TaskGuide` keeps the normal permission gate
so an already-running worker cannot be silently redirected into new work.
`/tasks` provides the equivalent keyboard workflow: select a running Agent,
press `g`, review the instruction, and press Enter to queue it.

Live task monitoring and guidance are restricted to the current workspace and
owning session. A different session cannot inspect, stop, or guide those local
tasks by guessing an ID; it must communicate through the explicit, auditable
session mailbox. A task with missing ownership metadata is hidden and cannot be
controlled rather than falling back to workspace-only trust.

Runtime guidance is deliberately process-local and bounded because the target
background Agent is itself process-local. A process restart terminates that
Agent rather than pretending the guidance can resume it. Cross-session messages
remain separately persisted because their destination sessions can be offline.

## Performance strategy and budgets

The initial path favors predictable correctness over false real-time claims.

| Measure                 | Initial target                   | How it is measured                    |
| ----------------------- | -------------------------------- | ------------------------------------- |
| local capture format    | 16 kHz, mono, PCM WAV            | recorder output metadata/size         |
| upload cap              | under MiMo's 10 MB input maximum | runtime hard limit and provider guard |
| recording cap           | 120 s default, 180 s absolute    | validated config                      |
| ASR/TTS request timeout | 60 s                             | provider abortable timeout            |
| concurrent read tasks   | 4 default, 32 maximum            | deterministic planner groups          |
| concurrent writes       | 1                                | deterministic planner invariant       |
| TTS overlap             | 0                                | six-frame bounded native PCM queue    |
| runtime guidance        | 16 KiB/item, 64 queued           | in-memory bounded control queue       |

Do not set a user-experience latency SLO from one network trace. Record separate
timestamps for microphone stop, ASR completion, transcript confirmation, first
assistant token, final assistant text, TTS completion, and playback start. P50,
P95, timeout/cancel rate, ASR correction rate, clarification rate, permission
denial rate, and stale-audio discard rate are the release metrics.

## Security and correctness controls

- The global configuration stores only `apiKeyEnv`, never an API-key value. A
  pasted key is written atomically to Kode's owner-only credential store (0700
  directory, 0600 file on POSIX); `/voice status` reports only a credential
  source (`environment`, `kode-storage`, or `missing`) and never a value.
- HTTPS is required except for an explicitly loopback development proxy.
- Provider response bodies are not inserted into errors or the transcript;
  malformed JSON/base64, empty audio, and unsafe byte counts fail closed.
- Audio files use a 0700 temporary directory and are removed for success,
  failure, cancellation, and playback completion. The separately cached local
  Swift helpers are executable-only, owned by the local user, versioned by
  source digest, and stored in a 0700 directory so recording does not compile
  code on every push-to-talk interaction.
- No automatic retry is performed for ASR/TTS, avoiding duplicate charge or
  duplicate playback semantics.
- Assistant code blocks and XML-like tool payloads are removed before TTS; TTS
  is never treated as a second authoritative result.
- User review precedes model submission; existing permissions still guard every
  sensitive tool call after it.

## Delivery sequence and acceptance gates

| Phase                      | Deliverable                                                         | Must prove before the next phase                                                    |
| -------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 0 — foundation             | config, MiMo SSE adapters, push-to-talk, review, safe TTS           | unit tests and manually verified config failure paths                               |
| 1 — conversational quality | telemetry, correction/clarification UX, interruption controls       | replay corpus of fragmented Chinese/English utterances and no unsafe auto-execution |
| 2 — hands-free realtime    | VAD, live-audio upload, acoustic barge-in                           | real microphone and noisy-room tests, false-interruption and P95 data               |
| 3 — agent workflows        | host execution adapter, durable run records, explicit handoff rules | restart/recovery, dependency failure, permission and concurrent-write tests         |

Real-provider acceptance is intentionally conditional on a non-production MiMo
credential and a user-granted macOS microphone permission. Until those are
available, tests can prove request shape, local cleanup, cancellation, and
simulated latency—not successful remote recognition, actual hardware capture,
or end-to-end speech quality.
