---
phase: 20-verification-safety
plan: "01"
subsystem: orchestrator
tags: [zero-diff, config-only, verification-routing, tdd]
dependency_graph:
  requires: []
  provides: [zero_diff-status, config-only-verification-routing]
  affects: [src/orchestrator/retry.ts, src/orchestrator/verifier.ts, src/types.ts, src/agent/index.ts, src/repl/types.ts, src/repl/session.ts, src/cli/commands/repl.ts, src/cli/commands/run.ts]
tech_stack:
  added: []
  patterns: [TDD red-green cycle, exported helper functions for testability, test isolation with mock state management]
key_files:
  created:
    - path: .planning/phases/20-verification-safety/20-01-SUMMARY.md
      description: This summary
  modified:
    - path: src/types.ts
      description: Added 'zero_diff' to RetryResult.finalStatus union
    - path: src/orchestrator/retry.ts
      description: Added CONFIG_FILE_PATTERNS, isConfigFile, getChangedFilesFromBaseline exports; zero-diff check and config-only routing in run()
    - path: src/orchestrator/verifier.ts
      description: Extended compositeVerifier options with configOnly:boolean for lint-only path
    - path: src/orchestrator/retry.test.ts
      description: Added 10 new tests for zero-diff detection and config-only classification
    - path: src/orchestrator/verifier.test.ts
      description: Added 2 new tests for compositeVerifier configOnly option
    - path: src/agent/index.ts
      description: Added zero_diff entry to statusMap (maps to 'success' for metrics)
    - path: src/repl/types.ts
      description: Added 'zero_diff' to TaskHistoryEntry.status union
    - path: src/repl/session.ts
      description: Updated historyStatus assignment to distinguish zero_diff from failed
    - path: src/cli/commands/repl.ts
      description: Added zero_diff to statusColor ternary (yellow) and actionable message display
    - path: src/cli/commands/run.ts
      description: Added case 'zero_diff': return 0 to mapStatusToExitCode
decisions:
  - "zero_diff is returned immediately on session success with empty/tiny diff — no retry since same prompt cannot produce different result"
  - "Config-only changes skip build+test (avoid false failures from pre-existing issues) but always run lint — catches config syntax errors"
  - "Config-only changes still invoke the LLM Judge — explicitly preserved per plan requirement"
  - "isConfigFile checks both basename and full path to handle .github/workflows/*.yml patterns while rejecting src/config/app.ts"
  - "zero_diff maps to exit code 0 in CLI — agent completed successfully, just made no changes"
  - "REPL history records zero_diff as distinct status (not collapsed into 'failed')"
  - "test isolation: used mockImplementationOnce for config-5/config-6 and explicit state reset in test 14 to prevent mock pollution across tests"
metrics:
  duration: "8 minutes"
  tasks_completed: 2
  files_modified: 10
  completed_date: "2026-03-24"
---

# Phase 20 Plan 01: Zero-Diff Detection and Config-Only Verification Routing Summary

Zero-diff detection with `getWorkspaceDiff`/`MIN_DIFF_CHARS` check in `RetryOrchestrator.run()`, config-only routing with `isConfigFile`/`CONFIG_FILE_PATTERNS`, lint-only `compositeVerifier` path for config changes, and `zero_diff` propagation through all display layers.

## Tasks Completed

| Task | Description | Commit | Files |
|------|-------------|--------|-------|
| TDD RED | Failing tests for zero_diff and config-only routing | 4407c8b | retry.test.ts, verifier.test.ts |
| 1 | Types + orchestrator + verifier implementation | 23f7b7c | types.ts, retry.ts, verifier.ts, retry.test.ts |
| 2 | Propagate zero_diff through display layer | 2eb74ce | agent/index.ts, repl/types.ts, repl/session.ts, repl.ts, run.ts |

## What Was Built

### Zero-Diff Detection
`RetryOrchestrator.run()` now calls `getWorkspaceDiff(workspaceDir, baselineSha)` after every successful session. If the diff is empty or shorter than `MIN_DIFF_CHARS` (10), it returns `{ finalStatus: 'zero_diff' }` immediately — no verifier, no judge, no PR creation, no retry.

### Config-Only Routing
After the zero-diff check (and only when a verifier is configured), the orchestrator calls `getChangedFilesFromBaseline()` to list changed files. If ALL changed files match `CONFIG_FILE_PATTERNS` (`.eslintrc.json`, `tsconfig.json`, `vite.config.ts`, etc.), it routes to `compositeVerifier(workspaceDir, { configOnly: true })` which runs lint only. The judge call remains unconditional.

### Exported Helpers
`isConfigFile(filepath)` and `CONFIG_FILE_PATTERNS` are exported for testability. The function checks both basename and full path (for `.github/**` patterns). `getChangedFilesFromBaseline` is also exported.

### Display Layer
- `zero_diff` renders in yellow in the REPL result block with actionable message
- REPL history records `zero_diff` as distinct status (not `failed`)
- CLI exit code 0 for `zero_diff`
- Metrics maps `zero_diff` to `'success'` session status

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Test isolation] Mock state pollution between tests**
- **Found during:** Task 1 (GREEN phase) — test 14 failing after adding config-5/config-6
- **Issue:** `config-5` and `config-6` used `mockImplementation` (permanent override) for `execFile` and `getWorkspaceDiff`. Vitest's `clearAllMocks()` clears call history but NOT permanent implementations, causing test 14 to see `.eslintrc.json` as the changed file and route through configOnly path.
- **Fix:** Changed `zero-3` to use `mockResolvedValueOnce` instead of permanent `mockResolvedValue`. Added explicit state reset at the top of test 14 to ensure `getWorkspaceDiff` and `execFile` have safe default values.
- **Files modified:** src/orchestrator/retry.test.ts
- **Commit:** 23f7b7c (included in feat commit)

**2. [Rule 1 - Bug] isConfigFile needed to check full path for .github/** patterns**
- **Found during:** Task 1 (GREEN phase) — test config-3 failing
- **Issue:** `isConfigFile` checked only `path.basename()`, so `.github/workflows/ci.yml` resolved to basename `ci.yml` which doesn't match any pattern.
- **Fix:** Extended `isConfigFile` to check both basename AND full normalized path against `CONFIG_FILE_PATTERNS`.
- **Files modified:** src/orchestrator/retry.ts
- **Commit:** 23f7b7c

## Verification

```
npx vitest run --reporter=verbose   # 569 tests pass (was 553 before this plan, +16 new tests)
npx tsc --noEmit                    # TypeScript compiles cleanly
grep -n 'zero_diff' src/types.ts src/orchestrator/retry.ts src/repl/types.ts ...  # present in all 7 files
grep -n 'configOnly' src/orchestrator/verifier.ts src/orchestrator/retry.ts       # present in both
```

## Self-Check: PASSED

- All 8 key source files exist
- All 3 commits verified (4407c8b, 23f7b7c, 2eb74ce)
- 569 tests pass
- TypeScript compiles cleanly
