---
phase: 25-tech-debt-cleanup
plan: "01"
subsystem: cli, errors, repl
tags: [exit-codes, dead-code, history-recording, tech-debt]
dependency_graph:
  requires: []
  provides: [correct-exit-codes, clean-errors-module, accurate-repl-history]
  affects: [src/cli/commands/run.ts, src/errors.ts, src/repl/session.ts]
tech_stack:
  added: []
  patterns: [TDD red-green, explicit switch cases over default catch-all]
key_files:
  created: []
  modified:
    - src/cli/commands/run.ts
    - src/cli/commands/run.test.ts
    - src/errors.ts
    - src/repl/session.ts
    - src/repl/session.test.ts
decisions:
  - "Explicit switch cases over default for vetoed/turn_limit to make intent clear and type-safe"
  - "SessionTimeoutError deleted without replacement — timeout is surfaced via finalStatus, not thrown"
  - "Ternary chain extended with 'cancelled' case between zero_diff and failed fallback"
metrics:
  duration: "~3 minutes"
  completed: "2026-04-05"
  tasks_completed: 3
  files_changed: 5
---

# Phase 25 Plan 01: CLI Exit Codes, Dead Code Removal, and REPL History Fix Summary

**One-liner:** Three targeted fixes — distinct exit codes for vetoed/turn_limit, removal of unused SessionTimeoutError class, and accurate 'cancelled' recording in REPL session history.

## What Was Built

Three independent fixes to establish correct process exit semantics and accurate session history before Phase 26 feature work begins.

### Task 1: Distinct Exit Codes for Vetoed and Turn_Limit

Updated `mapStatusToExitCode` in `src/cli/commands/run.ts` to replace the default catch-all for `vetoed` and `turn_limit` with explicit cases:
- `vetoed` now returns exit code `2` (task rejected by LLM Judge)
- `turn_limit` now returns exit code `3` (agent exceeded max turns)

JSDoc updated to document all 8 exit code mappings. Two new `runCommand` integration tests added alongside the updated unit tests.

### Task 2: Remove SessionTimeoutError Dead Code

Deleted `SessionTimeoutError` class from `src/errors.ts`. Confirmed via grep that it was never imported anywhere in the codebase — defined but never used. `TurnLimitError` remains as the sole exported error class.

### Task 3: Fix Cancelled Task Recording in REPL Session History

Fixed `historyStatus` ternary chain in `src/repl/session.ts` to explicitly handle `finalStatus === 'cancelled'` when `runAgent` returns normally (without throwing). Previously this non-throw cancelled path fell through to `'failed'`, while only the AbortError throw path correctly recorded `'cancelled'`.

## Decisions Made

- **Explicit switch cases over default** — Using `case 'vetoed': return 2` over relying on `default: return 1` makes the mapping intent clear and will cause a TypeScript compile error if the `RetryResult['finalStatus']` union grows a new member.
- **No replacement for SessionTimeoutError** — The timeout signal is conveyed via `finalStatus: 'timeout'` in `RetryResult`. No other module needs a thrown class for this.
- **Ternary chain extension** — Consistent with existing pattern in session.ts, added `result.finalStatus === 'cancelled' ? 'cancelled'` before the final `'failed'` fallback.

## Deviations from Plan

None — plan executed exactly as written.

### Pre-existing Out-of-Scope Issue (Deferred)

`src/slack/blocks.test.ts` has 4 pre-existing failing tests caused by uncommitted working-tree changes to `src/slack/blocks.ts` and `src/slack/blocks.test.ts`. These are unrelated to this plan's scope and were present before execution began. Logged to deferred items.

## Test Results

- `src/cli/commands/run.test.ts`: 18/18 passed
- `src/repl/session.test.ts`: 60/60 passed
- Combined: 78/78 passed

## Self-Check: PASSED

All source files exist. All 5 task commits confirmed in git log (bfa1bf3, 020f8f9, 53f7216, e467a3e, 9d69ba6).
