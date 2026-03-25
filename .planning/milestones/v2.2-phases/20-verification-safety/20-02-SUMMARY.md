---
phase: 20-verification-safety
plan: 02
subsystem: orchestrator/judge
tags: [llm-judge, api-migration, scope-creep, refactoring, structured-outputs]
dependency_graph:
  requires: []
  provides: [enriched-judge-prompt, ga-api-call]
  affects: [src/orchestrator/judge.ts, src/orchestrator/judge.test.ts]
tech_stack:
  added: []
  patterns: [ga-structured-outputs, no-beta-api, NOT-scope-creep-guidance]
key_files:
  created: []
  modified:
    - src/orchestrator/judge.ts
    - src/orchestrator/judge.test.ts
decisions:
  - GA API (client.messages.create) replaces beta API — follows Phase 18 migration pattern from llm-parser.ts
  - Four new NOT-scope-creep entries cover the full set of mechanical rename consequences (tests, imports, types, docs)
metrics:
  duration: ~15 minutes
  completed: 2026-03-24
  tasks_completed: 1
  files_modified: 2
---

# Phase 20 Plan 02: LLM Judge Prompt Enrichment and GA API Migration Summary

## One-liner

Enriched judge prompt with 4 refactoring-specific NOT-scope-creep entries and migrated judge API from beta structured outputs to GA client.messages.create.

## What Was Built

The LLM Judge previously used the beta structured outputs API (`client.beta.messages.create` with `betas: ['structured-outputs-2025-11-13']`) and had only 2 "NOT scope creep" entries in its evaluation prompt. This meant legitimate rename/refactor operations — where the agent must update test files, import paths, TypeScript type annotations, and doc comments — could be incorrectly vetoed as scope creep.

This plan:

1. **Enriched the judge prompt** with 4 new NOT-scope-creep entries specifically for rename/refactor scenarios
2. **Migrated the API call** from `client.beta.messages.create` to `client.messages.create` (GA path)
3. **Removed all beta dependencies** from judge.ts: no BetaMessage import, no betas array, no type assertions

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| RED | Add failing tests for GA API migration and enriched prompt | 0b3b6f8 | src/orchestrator/judge.test.ts |
| GREEN | Implement enriched prompt and GA API migration | fa79a52 | src/orchestrator/judge.ts |

## Decisions Made

- **GA API path**: `client.messages.create` replaces `client.beta.messages.create`, following the same pattern established in Phase 18 for `llm-parser.ts`. No type assertions, no betas header, no BetaMessage import.
- **Four new entries cover all mechanical rename consequences**: test file updates (consistency), import path changes (mechanical consequences of rename), TypeScript type annotations (language requirement), string literals/doc comments (when task explicitly asks for rename).

## Acceptance Criteria Verification

- `src/orchestrator/judge.ts` does NOT contain `import type { BetaMessage }` — PASS
- `src/orchestrator/judge.ts` does NOT contain `client.beta.messages.create` — PASS
- `src/orchestrator/judge.ts` does NOT contain `as any) as BetaMessage` — PASS
- `src/orchestrator/judge.ts` does NOT contain `betas:` — PASS (grep returns 0)
- `src/orchestrator/judge.ts` contains `client.messages.create(` — PASS
- `src/orchestrator/judge.ts` contains 6 NOT-scope-creep entries (2 original + 4 new) — PASS
- `src/orchestrator/judge.test.ts` mocks `messages.create` (not `beta.messages.create`) — PASS
- `npx vitest run src/orchestrator/judge.test.ts` exits 0, 30/30 tests pass — PASS

## Deviations from Plan

None - plan executed exactly as written.

## Deferred Items

- `src/orchestrator/retry.test.ts` imports `isConfigFile` and `getChangedFilesFromBaseline` from `./retry.js` (committed in plan 20-01 RED phase). The GREEN phase implementation for those functions exists in the working tree (uncommitted in retry.ts) but was not part of this plan's scope. Full test suite shows 2 failures in retry.test.ts — these are pre-existing from plan 20-01's incomplete GREEN phase, not caused by this plan's changes.

## Self-Check: PASSED

- src/orchestrator/judge.ts — FOUND
- src/orchestrator/judge.test.ts — FOUND
- .planning/phases/20-verification-safety/20-02-SUMMARY.md — FOUND
- commit 0b3b6f8 (RED: failing tests) — FOUND
- commit fa79a52 (GREEN: implementation) — FOUND
