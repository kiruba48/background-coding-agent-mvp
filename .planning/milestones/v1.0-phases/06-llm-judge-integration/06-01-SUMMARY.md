---
phase: 06-llm-judge-integration
plan: 01
subsystem: llm-judge
tags: [anthropic-sdk, structured-output, git-diff, scope-detection, tdd]
dependency_graph:
  requires: [src/types.ts, "@anthropic-ai/sdk", "node:child_process"]
  provides: [src/orchestrator/judge.ts, JudgeResult type, llmJudge function]
  affects: [src/orchestrator/index.ts, src/types.ts]
tech_stack:
  added: []
  patterns: ["beta structured outputs (SDK 0.71.2)", "git CLI via execFileAsync", "fail-open error handling", "TDD (red-green-refactor)"]
key_files:
  created:
    - src/orchestrator/judge.ts
    - src/orchestrator/judge.test.ts
  modified:
    - src/types.ts
    - src/orchestrator/index.ts
decisions:
  - "Cast beta.messages.create response as `any` then `BetaMessage` to resolve SDK union type (Stream | BetaMessage) without disabling type safety on the call site"
  - "Module-level mockCreate singleton in tests avoids vi.mock constructor pattern issues with arrow function factories"
metrics:
  duration_min: 4
  completed: 2026-02-28
  tasks_completed: 2
  files_changed: 4
---

# Phase 6 Plan 1: LLM Judge Core Implementation Summary

**One-liner:** LLM Judge using Claude Haiku 4.5 via beta structured outputs — APPROVE/VETO verdict with fail-open on API errors and lockfile diff truncation.

## What Was Built

### Task 1: Type Definitions (src/types.ts)

Added the semantic safety layer types that thread through the orchestration pipeline:

- **`JudgeResult`** interface: `verdict ('APPROVE'|'VETO')`, `reasoning`, `veto_reason`, `durationMs`, optional `skipped` flag
- **`VerificationError.type`** extended: added `'judge'` to the union (`'build' | 'test' | 'lint' | 'judge' | 'custom'`)
- **`RetryResult.finalStatus`** extended: added `'vetoed'` terminal status
- **`RetryResult.judgeResults`** added: optional array for full judge invocation logging
- **`RetryConfig`** extended: optional `judge` function field and `maxJudgeRetries` (default 1, separate budget from verifier retries)

### Task 2: LLM Judge Implementation (src/orchestrator/judge.ts)

278-line implementation with TDD (22 unit tests, all green):

**`getWorkspaceDiff(workspaceDir)`** — Three-stage fallback:
1. `git diff HEAD~1 HEAD --no-color` (agent committed its changes)
2. `git diff HEAD --no-color` (staged + unstaged vs last commit)
3. `git diff --no-color` (unstaged only)
4. Returns `''` on error (no commits, no git)

**`truncateLockfileDiffs(diff)`** — Replaces entire diff hunks for `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `pom.xml.lock` with `+ lockfile updated`. Non-lockfile hunks untouched. Regex-based hunk boundary detection (`diff --git` headers).

**`truncateDiff(diff)`** — Slices to `MAX_DIFF_CHARS` (8,000) with truncation notice including original length.

**`llmJudge(workspaceDir, originalTask)`** — Main function:
1. Gets diff via `getWorkspaceDiff`
2. Skips (APPROVE + `skipped: true`) if diff empty or under `MIN_DIFF_CHARS` (10)
3. Applies lockfile truncation then size truncation
4. Calls `client.beta.messages.create()` with beta `structured-outputs-2025-11-13`
5. JSON schema guarantees `{ reasoning, verdict, veto_reason }` fields
6. Wraps entire API call in try-catch — any error returns APPROVE + `skipped: true` (fail open)
7. Model configurable via `JUDGE_MODEL` env var, defaults to `claude-haiku-4-5-20251001`

**`src/orchestrator/index.ts`** updated — Exports `llmJudge` and `JudgeResult` type.

## Key Design Choices

| Choice | Rationale |
|--------|-----------|
| `client.beta.messages.create` cast as `any as BetaMessage` | SDK v0.71.2 `create()` return type is `Stream<...> | BetaMessage`; casting avoids TypeScript error on `.content` access without `stream: false` overload resolution |
| Module-level `mockCreate` singleton | `vi.mock` factory arrow functions cannot be used as constructors; sharing singleton via module scope avoids `getMockCreate` instantiation overhead |
| Fail-open on ALL API errors | Prevents judge API outage from blocking PR creation; code passed deterministic verification — semantic check should not be a hard blocker |
| Separate `MIN_DIFF_CHARS = 10` threshold | Avoids judge invocation on no-op agent runs; diff < 10 chars is statistically empty |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] TypeScript union type error on beta.messages.create response**
- **Found during:** Task 2 GREEN phase (TypeScript check)
- **Issue:** SDK v0.71.2 `client.beta.messages.create()` returns `Stream<BetaRawMessageStreamEvent> | BetaMessage`, so `.content` property access fails TypeScript since `Stream` doesn't have it
- **Fix:** Added `stream: false` to call params and cast `} as any) as BetaMessage` to resolve union; imported `BetaMessage` type from SDK beta messages path
- **Files modified:** `src/orchestrator/judge.ts`
- **Commit:** 61727eb

**2. [Rule 1 - Bug] Duplicate `getMockCreate` function in test file**
- **Found during:** Task 2 test run after initial edit
- **Issue:** Edit operation appended a second `getMockCreate` function without removing the first one; esbuild transform error prevented test execution
- **Fix:** Removed duplicate function; simplified to module-level `mockCreate` singleton referenced directly
- **Files modified:** `src/orchestrator/judge.test.ts`
- **Commit:** 61727eb

**3. [Rule 1 - Bug] Arrow function factory in vi.mock cannot be used as constructor**
- **Found during:** Task 2 test run after first attempt
- **Issue:** `vi.mock('@anthropic-ai/sdk', () => ({ default: vi.fn().mockImplementation(() => ...) }))` fails because Vitest requires constructor mocks to use `function` not arrow functions
- **Fix:** Changed mock factory to use `function MockAnthropic()` syntax; moved `mockCreate` to module level as singleton
- **Files modified:** `src/orchestrator/judge.test.ts`
- **Commit:** 61727eb

## Self-Check

**Files created:**
- `/Users/kiruba/code/Projects/ai/background-coding-agent/src/orchestrator/judge.ts` — FOUND (278 lines, 4 exports)
- `/Users/kiruba/code/Projects/ai/background-coding-agent/src/orchestrator/judge.test.ts` — FOUND (22 tests, all passing)

**Exports verified:**
- `llmJudge` — exported from judge.ts and re-exported from index.ts
- `getWorkspaceDiff` — exported from judge.ts
- `truncateDiff` — exported from judge.ts
- `truncateLockfileDiffs` — exported from judge.ts
- `JudgeResult` type — in types.ts and re-exported from index.ts

**Type requirements:**
- `JudgeResult` interface — FOUND in src/types.ts
- `'judge'` in VerificationError.type — FOUND
- `'vetoed'` in RetryResult.finalStatus — FOUND
- `judgeResults` in RetryResult — FOUND
- `judge` and `maxJudgeRetries` in RetryConfig — FOUND

**Commits:**
- e5832b9 — feat(06-01): add JudgeResult type and extend types
- b8c432a — test(06-01): add failing tests (RED phase)
- 61727eb — feat(06-01): implement llmJudge (GREEN phase)

**Verification:**
- `npx tsc --noEmit` — PASS
- `npx vitest run judge.test.ts` — 22/22 PASS
- All existing 84 unit tests — PASS

## Self-Check: PASSED
