---
phase: 09-npm-dependency-update
plan: "01"
subsystem: prompts, cli
tags: [npm, prompt-builder, cli-validation, tdd, end-state-prompting]
dependency_graph:
  requires: []
  provides: [buildNpmPrompt, npm-dep-cli-validation]
  affects: [src/prompts/index.ts, src/cli/index.ts]
tech_stack:
  added: []
  patterns: [end-state-prompting, depRequiringTaskTypes-extension]
key_files:
  created:
    - src/prompts/npm.ts
    - src/prompts/npm.test.ts
  modified:
    - src/prompts/index.ts
    - src/cli/index.ts
decisions:
  - npm --dep validation is minimal (non-empty, no control chars/whitespace) unlike Maven strict groupId:artifactId -- npm package names are flexible
  - lockfile regeneration excluded from prompt -- host-side concern only (matches CONTEXT.md guidance)
  - NPM-05 (changelog link) remains deferred -- no Docker network access
metrics:
  duration_seconds: 115
  completed_date: "2026-03-11"
  tasks_completed: 2
  files_changed: 4
---

# Phase 9 Plan 01: npm Prompt Builder and CLI Wiring Summary

npm dependency update prompt builder implemented using end-state prompting with task-type-conditional CLI validation that keeps Maven strict and npm minimal.

## Tasks Completed

| Task | Description | Commit | Files |
|------|-------------|--------|-------|
| 1 (TDD RED) | Failing tests for npm prompt builder and dispatch | 4b85b14 | src/prompts/npm.test.ts |
| 1 (TDD GREEN) | buildNpmPrompt and buildPrompt npm dispatch | b70a88b | src/prompts/npm.ts, src/prompts/index.ts |
| 2 | Add npm-dependency-update to CLI validation | f652bc8 | src/cli/index.ts |

## What Was Built

- `src/prompts/npm.ts`: `buildNpmPrompt(packageName, targetVersion)` produces end-state prompt describing desired outcome (package.json updated, build succeeds, tests pass, breaking APIs resolved). No lockfile mention (host concern). NPM-05 deferred.
- `src/prompts/index.ts`: Imports and exports `buildNpmPrompt`; switch case for `npm-dependency-update` with same dep/targetVersion validation as Maven.
- `src/cli/index.ts`: `depRequiringTaskTypes` extended to include `npm-dependency-update`; validation block restructured to be task-type-conditional. Maven keeps strict `groupId:artifactId` regex. npm uses minimal `[\x00-\x1f\s]` rejection only.
- `src/prompts/npm.test.ts`: 11 tests covering prompt content, end-state format, no step-by-step, no lockfile, and dispatch behavior.

## Verification

- `npx tsc --noEmit` passes (excluding pre-existing test file errors in verifier.test.ts from another plan)
- `npx vitest run src/prompts/` — 22 tests pass (11 new npm + 11 existing Maven)

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

- src/prompts/npm.ts: FOUND
- src/prompts/npm.test.ts: FOUND
- src/prompts/index.ts: FOUND (updated)
- src/cli/index.ts: FOUND (updated)
- Commits 4b85b14, b70a88b, f652bc8: verified in git log
