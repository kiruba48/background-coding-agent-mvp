---
phase: 19-generic-prompt-builder
plan: 02
subsystem: intent-display, pr-creator, agent-api
tags: [generic-tasks, confirm-loop, pr-creator, display, tdd]
dependency_graph:
  requires: [19-01]
  provides: [generic-task-display, generic-pr-metadata]
  affects: [src/intent/confirm-loop.ts, src/orchestrator/pr-creator.ts, src/agent/index.ts, src/cli/commands/one-shot.ts]
tech_stack:
  added: []
  patterns: [tdd-red-green, picocolors-display, generic-pr-metadata]
key_files:
  created: []
  modified:
    - src/intent/confirm-loop.ts
    - src/intent/confirm-loop.test.ts
    - src/orchestrator/pr-creator.ts
    - src/orchestrator/pr-creator.test.ts
    - src/agent/index.ts
    - src/cli/commands/one-shot.ts
decisions:
  - "PR body prepends Task category + Instruction block at top of task section for generic tasks — instructs reader before agent narrative"
  - "Branch name uses taskCategory + first 40 chars of description, slugified — keeps names readable without exploding length"
  - "PR title uses raw description text truncated at 72 chars — matches git commit subject convention"
  - "Action line in displayIntent positioned after Task line, before Project line — groups task context together"
metrics:
  duration_minutes: 3
  completed_date: "2026-03-24"
  tasks_completed: 2
  files_modified: 6
---

# Phase 19 Plan 02: Generic Display and PR Metadata Summary

Generic task display (taskCategory label + Action line) and PR creator (description-based title, branch name, and body) updated via TDD.

## What Was Built

### Task 1: displayIntent updated for generic tasks

`displayIntent()` in `src/intent/confirm-loop.ts` now shows:
- Task line: `taskCategory` label (e.g. `code-change`) instead of raw `generic`
- Fallback to `generic` when `taskCategory` is null
- Action line with instruction text (truncated at 80 chars + `...` for long inputs)
- Non-generic tasks unchanged

8 new tests added to `confirm-loop.test.ts` covering all branches. All 22 confirm-loop tests pass.

### Task 2: PR creator adapted for generic tasks

`GitHubPRCreator.create()` in `src/orchestrator/pr-creator.ts` updated:
- `opts` extended with `description?: string` and `taskCategory?: string`
- Branch name: `${taskCategory ?? 'generic'} ${description.slice(0, 40)}` slugified — e.g. `agent/code-change-replace-axios-with-fetch-2026-03-24-a1b2c3`
- PR title: instruction text, truncated at 72 chars with `...` (non-generic unchanged: `Agent: {taskType} YYYY-MM-DD`)
- PR body: prepends `**Task category:** code-change` + `**Instruction:** replace axios with fetch` before the Task section for generic tasks

`AgentOptions` in `src/agent/index.ts` extended with `taskCategory?: string`; `creator.create()` now passes both `description` and `taskCategory`.

`one-shot.ts` updated to map `confirmed.taskCategory` to `agentOptions.taskCategory` — closing the flow from `ResolvedIntent` to PR metadata.

7 new tests added to `pr-creator.test.ts`. All 54 pr-creator tests pass.

**Total test count: 553 (was 538 after 19-01, +15 new tests)**

## Commits

| Hash | Message |
|------|---------|
| d5c5c31 | test(19-02): add failing tests for generic displayIntent behavior |
| d12a770 | feat(19-02): update displayIntent for generic tasks |
| 2e77132 | test(19-02): add failing tests for generic PR creator behavior |
| 31c157d | feat(19-02): adapt PR creator for generic task branch names, titles, and body |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] taskCategory not mapped in one-shot.ts**
- **Found during:** Task 2, step 3 (plan explicitly called for verification of this)
- **Issue:** `one-shot.ts` mapped `confirmed.description` to `agentOptions` but did not map `confirmed.taskCategory`. The plan spec said "verify and add if missing".
- **Fix:** Added `taskCategory: confirmed.taskCategory ?? undefined` to `agentOptions` in `one-shot.ts`
- **Files modified:** `src/cli/commands/one-shot.ts`
- **Commit:** 31c157d

## Self-Check: PASSED

Files exist:
- FOUND: src/intent/confirm-loop.ts
- FOUND: src/intent/confirm-loop.test.ts
- FOUND: src/orchestrator/pr-creator.ts
- FOUND: src/orchestrator/pr-creator.test.ts
- FOUND: src/agent/index.ts
- FOUND: src/cli/commands/one-shot.ts

Commits exist:
- FOUND: d5c5c31
- FOUND: d12a770
- FOUND: 2e77132
- FOUND: 31c157d

Acceptance criteria verified:
- src/intent/confirm-loop.ts contains `intent.taskType === 'generic'`: YES
- src/intent/confirm-loop.ts contains `intent.taskCategory ?? 'generic'`: YES
- src/intent/confirm-loop.ts contains `Action:` string literal: YES
- src/intent/confirm-loop.ts contains `.slice(0, 80)`: YES
- src/intent/confirm-loop.ts contains `+ '...'`: YES
- src/intent/confirm-loop.test.ts contains `taskCategory: 'code-change'`: YES
- src/intent/confirm-loop.test.ts has at least 6 new generic test cases: YES (8 new)
- `npx vitest run src/intent/confirm-loop.test.ts` exits 0: YES (22 pass)
- src/orchestrator/pr-creator.ts `create()` signature has `description?` and `taskCategory?`: YES
- src/orchestrator/pr-creator.ts contains `opts.taskType === 'generic'` for branch, title, body: YES
- src/orchestrator/pr-creator.ts contains `.slice(0, 72)`: YES
- src/orchestrator/pr-creator.ts contains `.slice(0, 40)`: YES
- src/agent/index.ts `AgentOptions` contains `taskCategory?: string`: YES
- src/agent/index.ts `creator.create()` includes description and taskCategory: YES
- src/orchestrator/pr-creator.test.ts has tests for PR body generic tasks: YES
- `npm test` exits 0: YES (553 tests pass)
