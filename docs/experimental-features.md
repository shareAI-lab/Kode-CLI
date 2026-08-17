# Experimental features

Experimental features are disabled by default and must be opted into when
starting Kode. They exist for capabilities that introduce a new execution,
network, device, or billable-provider boundary and have not completed general
release validation.

| Feature            | Enable                                  | Why it is opt-in                                                                                         |
| ------------------ | --------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Voice conversation | `KODE_EXPERIMENTAL_VOICE=1 kode`        | Uses a microphone and MiMo ASR/TTS. Transcript review and normal permission checks remain required.      |
| MCP Sampling       | `KODE_EXPERIMENTAL_MCP_SAMPLING=1 kode` | Lets a connected MCP server request an LLM completion, which can consume configured model quota or cost. |

Changing an environment flag requires restarting Kode so capability
advertisement and request handlers remain consistent for the full process.

## Rollout decision rule

Do not add a feature flag simply because a change is large. Use one when a new
capability can cause external effects, cost, device access, or a compatibility
boundary that needs staged evidence. Fixes, internal hardening, and existing
durable state transitions should remain available unless a complete policy can
gate every public entry point, background worker, and persisted-state recovery
path consistently.
