---
phase: 09-npm-dependency-update
plan: "03"
subsystem: orchestrator/cli
tags: [npm, pre-verify, lockfile, retry-loop, host-side]
dependency_graph:
  requires: [09-01, 09-02]
  provides: [host-side-npm-install, pre-verify-hook]
  affects: [retry-orchestrator, run-command]
tech_stack:
  added: []
  patterns: [pre-verify-hook, terminal-failure-no-retry, task-type-gating]
key_files:
  created: []
  modified:
    - src/types.ts
    - src/orchestrator/retry.ts
    - src/orchestrator/retry.test.ts
    - src/cli/commands/run.ts
decisions:
  - "preVerify placement: after session success, before verifier — runs on every attempt (agent may re-edit package.json on retry)"
  - "preVerify failure is terminal with no retry — agent cannot fix registry/network issues"
  - "Task-type gating: preVerify only set for npm-dependency-update, undefined for all others"
  - "execFile over exec for npm install — avoids shell injection, well-defined argv"
metrics:
  duration: 2 min
  completed: "2026-03-11"
  tasks_completed: 2
  files_modified: 4
---

# Phase 9 Plan 03: Host-side npm install preVerify hook Summary

**One-liner:** preVerify hook in RetryConfig runs host-side npm install after Docker agent edits package.json, before verification, for npm-dependency-update tasks.

## What Was Built

Added a `preVerify` optional hook to `RetryConfig` that plugs into the retry orchestration loop between session success and verification. For `npm-dependency-update` tasks, this hook runs `npm install` on the host to regenerate `package-lock.json` after the Docker agent (which has no network access) edits `package.json`.

The hook is terminal on failure — if npm install fails (bad version spec, registry down), the run fails immediately with a clear error message. There is no retry since the agent cannot fix registry or network issues.

## Tasks Completed

| Task | Description | Commit |
|------|-------------|--------|
| 1 | Add preVerify hook to RetryOrchestrator (TDD) | 2143d86 |
| 2 | Wire host-side npm install into run.ts | 016f7a5 |

## Key Changes

**src/types.ts**
- Added `preVerify?: (workspaceDir: string) => Promise<void>` to `RetryConfig` with JSDoc explaining the terminal-failure semantic

**src/orchestrator/retry.ts**
- After the "no verifier configured" early return and before the verifier call, added preVerify invocation
- Failure path returns `finalStatus: 'failed'` with message `Pre-verify failed: ...`
- Runs on every retry attempt (agent may re-edit package.json on each attempt)

**src/orchestrator/retry.test.ts**
- Added 5 new tests (15-19) covering: called before verifier, not called on session fail, failure is terminal, backwards compatible without preVerify, called on each retry attempt

**src/cli/commands/run.ts**
- Imported `promisify` and `execFile` from Node.js built-ins
- Created `preVerify` function conditionally for `npm-dependency-update` task type
- `npm install` runs with `cwd: workspaceDir`, 2-minute timeout, 10MB buffer
- Error output truncated to 500 chars in error message
- Passed `preVerify` to `RetryOrchestrator` constructor in retryConfig

## Decisions Made

- **preVerify placement:** After `verifier` guard (no verifier = no preVerify), before verifier call. This mirrors the plan's specified insertion point and ensures the hook only fires when verification is configured.
- **Terminal failure, no retry:** npm install failures (registry, network, bad version) are not fixable by the agent — fail immediately to save time and give a clear signal.
- **Task-type gating:** `preVerify` is `undefined` for all non-npm task types. Maven handles deps during `mvn compile` (no host-side step needed). Generic tasks also unaffected.
- **execFileAsync over exec:** Uses `execFile` (not `exec`) to avoid shell injection and get well-typed argv control.

## Deviations from Plan

None — plan executed exactly as written.

## Verification

- `npx tsc --noEmit` passes (no type errors)
- `npx vitest run src/orchestrator/retry.test.ts` — 19/19 tests pass
- All 335 tests across the full test suite pass
- RetryConfig.preVerify is optional and backwards compatible (all 14 pre-existing tests pass unchanged)
- npm install only wired for npm-dependency-update task type

## Self-Check: PASSED

All key files exist on disk and all task commits are present in git history.
