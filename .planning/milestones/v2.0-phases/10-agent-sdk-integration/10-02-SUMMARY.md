---
phase: 10-agent-sdk-integration
plan: "02"
subsystem: orchestrator
tags: [sdk-integration, cli, retry-orchestrator, session-wiring]
dependency_graph:
  requires: [10-01]
  provides: [SDK-01, SDK-10]
  affects: [src/orchestrator/retry.ts, src/orchestrator/session.ts, src/orchestrator/index.ts, src/cli/commands/run.ts, src/cli/index.ts]
tech_stack:
  added: []
  patterns: [conditional-session-factory, commander-boolean-negation]
key_files:
  created: []
  modified:
    - src/orchestrator/session.ts
    - src/orchestrator/retry.ts
    - src/orchestrator/index.ts
    - src/orchestrator/retry.test.ts
    - src/orchestrator/judge.test.ts
    - src/cli/commands/run.ts
    - src/cli/index.ts
decisions:
  - "useSDK defaults to true (ClaudeCodeSession) via !== false check — undefined and true both select SDK path"
  - "Commander.js --no-use-sdk sets options.useSdk = false; wired as options.useSdk !== false in runAgent"
  - "Test mocks updated from MockAgentSession to MockClaudeCodeSession (default path) — plan assumption was incorrect but fix is minimal"
metrics:
  duration: "~15 minutes"
  completed: "2026-03-17T12:59:10Z"
  tasks_completed: 2
  files_modified: 7
---

# Phase 10 Plan 02: RetryOrchestrator Wiring Summary

RetryOrchestrator wired to use ClaudeCodeSession by default via useSDK flag; CLI --no-use-sdk provides legacy AgentSession fallback for debugging.

## What Was Built

The plan connected `ClaudeCodeSession` (built in Plan 01) to the production pipeline. The `RetryOrchestrator` now transparently creates `ClaudeCodeSession` (SDK path) by default, falling back to `AgentSession` only when `--no-use-sdk` is passed. The data flow is: CLI flag → `RunOptions.useSDK` → `SessionConfig.useSDK` → `RetryOrchestrator` conditional factory.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add useSDK to SessionConfig and wire conditional session creation | 43af7e9 | session.ts, retry.ts, index.ts, retry.test.ts, judge.test.ts |
| 2 | Add --use-sdk CLI flag and pass useSDK through to SessionConfig | acbeabf | run.ts, index.ts |

## Decisions Made

1. **useSDK defaults to true via `!== false` check** — `undefined` (not passed) and `true` both select the `ClaudeCodeSession` path. This is a safe default-on pattern that avoids adding a hard dependency on the flag being present.

2. **Commander.js `--no-use-sdk` camelCase is `useSdk`** — Commander converts `--no-use-sdk` to `options.useSdk = false`. The wiring expression `options.useSdk !== false` correctly passes `true` when omitted (Commander sets `useSdk = true` as default for negation options) and `false` when the flag is passed.

3. **Test mocks updated to ClaudeCodeSession** — The plan stated "tests pass unchanged" but this was incorrect: since `useSDK` defaults to `true`, the tests were using the real `ClaudeCodeSession` path. All 19 `MockAgentSession.mockImplementationOnce` calls in `retry.test.ts` and `judge.test.ts` were updated to `MockClaudeCodeSession.mockImplementationOnce`. Test 9 was retitled to reflect the updated semantic. This is a minimal, necessary change.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test mocks did not cover ClaudeCodeSession default path**
- **Found during:** Task 1 verification
- **Issue:** The plan stated "existing RetryOrchestrator tests still pass unchanged" but this was incorrect. With `useSDK` defaulting to `true`, the tests would call the real `ClaudeCodeSession` (which requires the SDK). All existing tests only mocked `AgentSession`.
- **Fix:** Added `vi.mock('./claude-code-session.js', ...)` to both `retry.test.ts` and `judge.test.ts`. Updated all `MockAgentSession.mockImplementationOnce` calls to `MockClaudeCodeSession.mockImplementationOnce`. Updated test 9 title to reflect ClaudeCodeSession is the default.
- **Files modified:** `src/orchestrator/retry.test.ts`, `src/orchestrator/judge.test.ts`
- **Commits:** 43af7e9

## Verification Results

- `npm test` — 362 tests pass (6 "no test suite" are pre-existing Docker integration tests)
- `npx tsx src/cli/index.ts --help | grep use-sdk` — shows `--no-use-sdk` flag
- `grep "new ClaudeCodeSession" src/orchestrator/retry.ts` — conditional creation present
- `grep "useSDK" src/orchestrator/session.ts` — field in SessionConfig

## Self-Check: PASSED
