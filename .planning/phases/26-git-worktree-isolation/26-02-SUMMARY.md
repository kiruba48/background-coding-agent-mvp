---
phase: 26-git-worktree-isolation
plan: "02"
subsystem: agent-pipeline
tags: [worktree, isolation, repl, git, agent]
dependency_graph:
  requires: ["26-01"]
  provides: ["worktree-pipeline-integration"]
  affects: ["src/agent/index.ts", "src/repl/session.ts", "src/cli/commands/repl.ts"]
tech_stack:
  added: []
  patterns: ["try/finally for resource cleanup", "effectiveWorkspaceDir seam for downstream isolation"]
key_files:
  created: []
  modified:
    - src/agent/index.ts
    - src/types.ts
    - src/repl/types.ts
    - src/repl/session.ts
    - src/cli/commands/repl.ts
    - src/agent/index.test.ts
decisions:
  - "WorktreeManager mock uses a class constructor (not arrow function) to support `new` calls in tests"
  - "effectiveBranchOverride replaces options.branchOverride throughout the try block — worktree branch always wins"
  - "worktreeBranch added as optional field to RetryResult (not a wrapper type) to minimize public API churn"
  - "skipWorktree: true added to all existing runAgent() test calls to keep them focused on their original concerns"
metrics:
  duration: "5m 18s"
  completed: "2026-04-05"
  tasks_completed: 2
  files_modified: 6
---

# Phase 26 Plan 02: Worktree Pipeline Integration Summary

Wire WorktreeManager (from Plan 01) into the full agent pipeline: isolated worktree per session with try/finally cleanup, orphan pruning at REPL startup, and post-hoc PR using the stored worktree branch.

## What Was Built

**runAgent() worktree lifecycle** (`src/agent/index.ts`, `src/types.ts`):
- Added `randomBytes`/`WorktreeManager`/`generateBranchName` imports
- Added `skipWorktree?: boolean` to `AgentContext` (allows tests to bypass)
- Before RetryOrchestrator: build worktree path, generate branch name, `worktreeManager.create()`
- Set `effectiveWorkspaceDir` and `effectiveBranchOverride` from the worktree
- Entire orchestrator+PR section wrapped in `try/finally` — `worktreeManager.remove()` runs even on throw
- All downstream consumers (`RetryOrchestrator`, `buildPrompt`, `GitHubPRCreator`) use `effectiveWorkspaceDir`
- `branchOverride` in `creator.create()` uses `effectiveBranchOverride` (worktree branch)
- `worktreeBranch?: string` added to `RetryResult` — set before returning

**REPL orphan scan** (`src/cli/commands/repl.ts`):
- Added `WorktreeManager` import
- `pruneOrphans(process.cwd())` called after Docker ready, before registry init — wrapped in try/catch (non-fatal)

**Post-hoc PR branch support** (`src/repl/types.ts`, `src/repl/session.ts`):
- Added `lastWorktreeBranch?: string` to `ReplState`
- On success: `state.lastWorktreeBranch = result.worktreeBranch`
- PR command: passes `branchOverride: state.lastWorktreeBranch` to `creator.create()`
- After PR: clears `state.lastWorktreeBranch = undefined` (prevents duplicate PRs)

**Integration tests** (`src/agent/index.test.ts`):
- Added class-based `WorktreeManager` mock with `buildWorktreePath` static method
- Added `generateBranchName` mock to pr-creator mock
- 5 new integration tests in `worktree integration` describe block:
  1. Creates worktree when `skipWorktree` not set
  2. Skips worktree when `skipWorktree: true`
  3. Removes worktree in finally block even when orchestrator throws
  4. Passes worktree path as `workspaceDir` to `RetryOrchestrator`
  5. Returns `worktreeBranch` on result
- All existing tests updated with `skipWorktree: true` context

## Decisions Made

1. **WorktreeManager mock uses class constructor**: Vitest requires `new`-able mocks for classes. Arrow function implementations fail with "is not a constructor". Fixed by using a class body in `vi.mock`.

2. **effectiveBranchOverride overwrites options.branchOverride**: The worktree branch is always authoritative once active — `options.branchOverride` is only used as a fallback when `skipWorktree: true`.

3. **worktreeBranch on RetryResult**: Avoids a wrapper type (AgentRunResult) that would break existing callers. Optional field is backward-compatible and allows REPL session.ts to extract the branch directly.

4. **Orphan scan placement**: After Docker ready check, before registry — matches the plan's specified location. Non-fatal (wrapped in try/catch) so a git error never blocks REPL startup.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] WorktreeManager mock used arrow function (not a constructor)**
- **Found during:** Task 2 — test run
- **Issue:** `vi.fn().mockImplementation((_repoDir, worktreePath, branchName) => ({...}))` produces an arrow function which fails with "is not a constructor" when called with `new WorktreeManager()`
- **Fix:** Replaced with a proper class body using `vi.mock('./worktree-manager.js', () => { class MockWorktreeManager {...} })`
- **Files modified:** src/agent/index.test.ts
- **Commit:** fb932dc

**2. [Rule 1 - Bug] MockRetryOrchestrator.mockImplementationOnce used arrow function in "finally" test**
- **Found during:** Task 2 — test run (1 remaining failure after first fix)
- **Issue:** `mockImplementationOnce(() => orchestratorInstance)` arrow function can't be used as a constructor
- **Fix:** Changed to `mockImplementationOnce(function () { return orchestratorInstance; })`
- **Files modified:** src/agent/index.test.ts
- **Commit:** fb932dc

## Verification

- Full test suite: 717 tests across 29 files — all pass
- TypeScript: pre-existing error in `src/slack/adapter.test.ts` (unrelated to this plan); all new code compiles cleanly
- Acceptance criteria: all items confirmed present via grep

## Self-Check: PASSED

Files confirmed present:
- src/agent/index.ts: contains WorktreeManager, generateBranchName, skipWorktree, effectiveWorkspaceDir, worktreeBranch
- src/types.ts: contains `worktreeBranch?: string`
- src/repl/types.ts: contains `lastWorktreeBranch?: string`
- src/repl/session.ts: contains state.lastWorktreeBranch set/read/cleared
- src/cli/commands/repl.ts: contains WorktreeManager.pruneOrphans
- src/agent/index.test.ts: contains worktree integration describe block

Commits confirmed:
- 9b0982f: feat(26-02): add worktree lifecycle to runAgent() and skipWorktree to AgentContext
- fb932dc: feat(26-02): add orphan scan to REPL startup, post-hoc PR branch support, and integration tests
