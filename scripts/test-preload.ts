// Test-run preload: make Ink render like a real terminal.
//
// Ink reads the `is-in-ci` package at import time. When it detects CI it stops
// writing intermediate frames and only flushes the final frame on unmount
// (`ink.js` — "CIs don't handle erasing ansi escapes well, so it's better to
// only render last frame of non-static output").
//
// The e2e TUI tests assert on frames *while mounted*, so under CI they observe
// an empty stream and fail. `is-in-ci` treats the literal strings '0' and
// 'false' as "not CI", so setting CI to 'false' restores terminal-like
// rendering for the test process only.
//
// This is deliberately narrow: every other CI check in this repository uses
// `Boolean(process.env.CI)` or `process.env.CI && ...`, and `Boolean('false')`
// is still `true`, so their behaviour is unchanged (verified for
// `mcp/client/clients.ts`, `services/vcr.ts`, `core/utils/env.ts` and
// `apps/cli/src/app.tsx`). Nothing reads CONTINUOUS_INTEGRATION, which
// `is-in-ci` also consults, so it is left untouched.
if (process.env.CI && process.env.CI !== '0' && process.env.CI !== 'false') {
  process.env.CI = 'false'
}
