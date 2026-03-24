---
phase: 19-generic-prompt-builder
plan: "01"
subsystem: prompts
tags: [prompts, generic-task, async, tdd]
dependency_graph:
  requires: []
  provides: [buildGenericPrompt, async-buildPrompt, repoPath-in-PromptOptions]
  affects: [src/prompts/index.ts, src/agent/index.ts, src/prompts/npm.test.ts, src/prompts/maven.test.ts]
tech_stack:
  added: []
  patterns: [end-state-prompting, scope-fencing, conditional-context-injection, async-dispatch]
key_files:
  created:
    - src/prompts/generic.ts
    - src/prompts/generic.test.ts
  modified:
    - src/prompts/index.ts
    - src/agent/index.ts
    - src/agent/index.test.ts
    - src/prompts/npm.test.ts
    - src/prompts/maven.test.ts
decisions:
  - "buildGenericPrompt omits CONTEXT block entirely when readManifestDeps returns 'No manifest found'"
  - "buildPrompt made async to support manifest reading; npm/maven cases return sync values from async function (valid)"
  - "repoPath passed as options.repo from agent to buildPrompt, matching AgentOptions existing field"
metrics:
  duration_seconds: 120
  completed_date: "2026-03-24"
  tasks_completed: 2
  files_changed: 7
---

# Phase 19 Plan 01: Generic Prompt Builder Summary

**One-liner:** Scope-fenced end-state prompt builder for generic tasks with conditional manifest dependency injection and async buildPrompt dispatch.

## What Was Built

`buildGenericPrompt(description, repoPath?)` is the core prompt builder for the `generic` taskType. It produces prompts with:
- User instruction verbatim in the prompt body (end-state prompting discipline, TASK-04)
- SCOPE block with four "Do NOT" constraints preventing unrelated changes
- "After your changes, the following should be true:" end-state assertions
- Optional CONTEXT block with manifest dependencies when repoPath resolves actual deps
- "Work in the current directory." footer

`buildPrompt` is now async (`Promise<string>`) to support manifest reading. The `PromptOptions` interface gains `repoPath?: string`. The agent runner passes `repoPath: options.repo` and awaits the result.

## Tasks Completed

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 (TDD RED) | Failing tests for buildGenericPrompt | f093b31 | src/prompts/generic.test.ts |
| 1 (TDD GREEN) | Create buildGenericPrompt + async buildPrompt | 13b6635 | src/prompts/generic.ts, src/prompts/index.ts |
| 2 | Update existing tests and agent caller | d2bd927 | src/agent/index.ts, src/agent/index.test.ts, npm.test.ts, maven.test.ts |

## Verification

- `npx vitest run src/prompts/generic.test.ts`: 12/12 pass
- `npm test`: 538 tests pass (0 failures, up from 526)
- `npx tsc --noEmit`: exits 0

## Decisions Made

1. **CONTEXT block omission** — When `readManifestDeps` returns `'No manifest found'`, the CONTEXT block is omitted entirely (not present as empty). This keeps prompts clean for repos without manifests.

2. **Async buildPrompt** — Made async to support `readManifestDeps` which is inherently async (file I/O). Existing npm/maven cases return synchronous string values from the async function, which is valid TypeScript and requires no changes to those prompt builders.

3. **repoPath from options.repo** — The agent passes `repoPath: options.repo` because `AgentOptions` already has `repo: string` representing the workspace path. No new field needed.

## Deviations from Plan

None — plan executed exactly as written. TDD RED/GREEN/REFACTOR pattern followed. No refactor phase was needed (code was clean after GREEN).

## Self-Check

- `src/prompts/generic.ts` exists: FOUND
- `src/prompts/generic.test.ts` exists: FOUND
- `src/prompts/index.ts` contains `async function buildPrompt`: FOUND
- `src/agent/index.ts` contains `await buildPrompt`: FOUND
- Commits f093b31, 13b6635, d2bd927: FOUND

## Self-Check: PASSED
