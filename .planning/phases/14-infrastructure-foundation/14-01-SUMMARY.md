---
phase: 14-infrastructure-foundation
plan: 01
subsystem: agent-library
tags: [abort-signal, cancellation, library-api, docker-lifecycle, tdd]
dependency_graph:
  requires: []
  provides: [runAgent-library-function, AbortSignal-threading, cancellation-chain]
  affects: [src/agent/index.ts, src/orchestrator/retry.ts, src/orchestrator/claude-code-session.ts, src/types.ts]
tech_stack:
  added: []
  patterns: [AbortSignal-threading, 5-second-grace-period, git-reset-on-cancel, sessionSettled-flag]
key_files:
  created:
    - src/agent/index.ts
    - src/agent/index.test.ts
  modified:
    - src/types.ts
    - src/orchestrator/retry.ts
    - src/orchestrator/claude-code-session.ts
    - src/orchestrator/retry.test.ts
    - src/orchestrator/claude-code-session.test.ts
    - src/orchestrator/metrics.ts
decisions:
  - "AbortSignal threaded via SessionConfig.signal field (not constructor parameter) — cleaner separation between config and runtime context"
  - "sessionSettled flag prevents double docker kill: grace period handler checks flag before firing"
  - "signal?.aborted checked BEFORE timedOut in catch block — cancellation takes priority over timeout"
  - "resetWorkspace() is best-effort (errors caught) — cancellation always returns, even if git reset fails"
metrics:
  duration: "~8 minutes"
  completed: "2026-03-19"
  tasks_completed: 2
  files_modified: 8
---

# Phase 14 Plan 01: runAgent() Extraction and AbortSignal Threading Summary

Extract runAgent() as a library-quality importable function and wire AbortSignal cancellation through the full execution chain (runAgent -> RetryOrchestrator -> ClaudeCodeSession) with 5-second grace period and git reset on cancel.

## What Was Built

### Task 1: runAgent() library function (ce028df)

Created `src/agent/index.ts` with:
- `AgentOptions` interface: task config (taskType, repo, turnLimit, timeoutMs, maxRetries, etc.)
- `AgentContext` interface: execution context (optional logger, optional AbortSignal)
- `runAgent(options, context)`: async function that internalizes Docker lifecycle, accepts AbortSignal, returns `RetryResult` — never calls process.exit()

Updated `src/types.ts`:
- Added `'cancelled'` to `RetryResult.finalStatus` union
- Added `'cancelled'` to `SessionResult.status` union
- Added `signal?: AbortSignal` to `SessionConfig`

### Task 2: AbortSignal threading (377aa0f)

Updated `ClaudeCodeSession.run()`:
- Added `signal?: AbortSignal` as third parameter
- Fast-path: pre-aborted signal returns `{ status: 'cancelled' }` immediately
- Abort handler: signals SDK abort via `this.abortController.abort()`, then sets a 5-second timer to call `docker kill {containerName}` if session hasn't exited
- `sessionSettled` flag in finally block prevents grace period handler from double-killing
- catch block checks `signal?.aborted` BEFORE `timedOut` (correct priority order)

Updated `RetryOrchestrator.run()`:
- Pre-loop check: if `this.config.signal?.aborted`, returns `{ finalStatus: 'cancelled' }` immediately
- Per-iteration check: if signal aborted at start of each loop, calls `resetWorkspace()` and returns
- Passes `this.config.signal` to `session.run()` as third argument
- Checks for `sessionResult.status === 'cancelled'`, calls `resetWorkspace()` and returns
- Added private `resetWorkspace(workspaceDir, baselineSha)` method using `git reset --hard`

Updated `src/orchestrator/metrics.ts`:
- Added `'cancelled'` to `SessionStatus` union (required for TypeScript compatibility)

## Test Coverage

| File | Tests Added | Tests Total |
|------|------------|-------------|
| src/agent/index.test.ts | 7 (new) | 7 |
| src/orchestrator/retry.test.ts | 4 new cancellation tests | 23 |
| src/orchestrator/claude-code-session.test.ts | 5 new cancellation tests | 30 |

All 60 tests pass. `npx tsc --noEmit` compiles without errors.

## Verification Results

```
npx vitest run src/agent/ src/orchestrator/retry.test.ts src/orchestrator/claude-code-session.test.ts
Test Files: 4 passed
Tests: 68 passed
```

- `grep "process.exit" src/agent/index.ts` — 0 matches
- `grep "process.once" src/agent/index.ts` — 0 matches
- `grep "'cancelled'" src/types.ts` — matches in both RetryResult.finalStatus and SessionResult.status
- `grep "setTimeout" src/orchestrator/claude-code-session.ts` — grace period timer exists
- `grep "5000" src/orchestrator/claude-code-session.ts` — 5-second grace period confirmed

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] MetricsCollector SessionStatus missing 'cancelled'**
- **Found during:** Task 2 TypeScript compilation
- **Issue:** `src/orchestrator/metrics.ts` `SessionStatus` union did not include 'cancelled', causing TS2345 error in `src/cli/commands/run.ts` when passing `retryResult.finalStatus` to `metrics.recordSession()`
- **Fix:** Added `'cancelled'` to `SessionStatus` type in metrics.ts
- **Files modified:** src/orchestrator/metrics.ts
- **Commit:** 377aa0f (included in Task 2 commit)

## Key Decisions Made

1. **Signal via SessionConfig.signal**: The AbortSignal is threaded through `SessionConfig.signal` rather than adding a separate constructor parameter to RetryOrchestrator. This keeps signal handling aligned with the config-first design.

2. **sessionSettled flag pattern**: Uses a simple boolean flag set in the `finally` block to prevent the grace period setTimeout handler from redundantly calling `docker kill` when the session already exited cleanly.

3. **Cancellation priority**: `signal?.aborted` check in the catch block appears BEFORE the `timedOut` check. If both fire simultaneously (e.g., timeout triggers abort which then fires signal), the response is 'cancelled' not 'timeout' — since an explicit external cancellation request should take semantic priority.

4. **resetWorkspace best-effort**: The `git reset --hard` in `resetWorkspace()` catches all errors. Cancellation always succeeds at the RetryOrchestrator level even if the workspace reset fails (e.g., detached HEAD, git not available).

## Self-Check: PASSED

- src/agent/index.ts: FOUND
- src/agent/index.test.ts: FOUND
- 14-01-SUMMARY.md: FOUND
- Commit ce028df (Task 1): FOUND
- Commit 377aa0f (Task 2): FOUND
