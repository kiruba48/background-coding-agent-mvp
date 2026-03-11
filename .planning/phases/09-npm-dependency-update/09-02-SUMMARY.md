---
phase: 09-npm-dependency-update
plan: 02
subsystem: verification
tags: [npm, verifier, error-summarization, tdd]
dependency_graph:
  requires: [08-02-SUMMARY.md]
  provides: [npmBuildVerifier, npmTestVerifier, ErrorSummarizer.summarizeNpmBuildErrors, ErrorSummarizer.summarizeNpmTestFailures]
  affects: [compositeVerifier, RetryOrchestrator (via error type flow)]
tech_stack:
  added: []
  patterns: [TDD red-green, path-based mock routing, ENOENT detection, timeout detection]
key_files:
  created: []
  modified:
    - src/orchestrator/summarizer.ts
    - src/orchestrator/verifier.ts
    - src/orchestrator/verifier.test.ts
decisions:
  - npm errors use 'build'/'test' VerificationError types flowing through existing retry loop (NPM-04 satisfied by architecture)
  - npm test skipped when npm build fails (same noise-reduction pattern as Maven)
  - readPackageJsonScripts helper shared by both npm verifiers (DRY, single JSON parse)
  - summarizeNpmBuildErrors extracts lines matching /error/i or containing 'ERR!' (npm-specific prefix)
  - summarizeNpmTestFailures extracts lines matching FAIL, /failed/i, /Error:/i (generic test runner patterns)
metrics:
  duration: 4 min
  completed: "2026-03-11"
  tasks: 1
  files_modified: 3
---

# Phase 9 Plan 02: npm Build and Test Verifiers Summary

**One-liner:** npm build/test verifiers with error summarization added to composite verification pipeline using 'build'/'test' error types for seamless retry loop integration.

## What Was Built

Added npm verification support to the composite verification pipeline, following the established Maven verifier pattern from Phase 8. Two new verifiers and two new error summarizer methods were implemented using TDD.

### New Exports

**`src/orchestrator/summarizer.ts`**
- `ErrorSummarizer.summarizeNpmBuildErrors(rawOutput)` — extracts lines containing `error` (case-insensitive) or `ERR!` (npm prefix), caps at 5 with remaining count
- `ErrorSummarizer.summarizeNpmTestFailures(rawOutput)` — extracts lines matching `FAIL`, `failed`, `Error:` patterns, caps at 5 with remaining count

**`src/orchestrator/verifier.ts`**
- `npmBuildVerifier(workspaceDir)` — skips when no package.json or no `build` script; runs `npm run build` with 120s timeout; handles ENOENT and timeout
- `npmTestVerifier(workspaceDir)` — skips when no package.json or no `test` script; runs `npm test` with 300s timeout; handles ENOENT and timeout
- `readPackageJsonScripts(workspaceDir)` (private helper) — shared package.json reader for both npm verifiers
- Updated `compositeVerifier` — adds npm verifiers after Maven in correct ordering with build-failure gate

### Composite Verifier Ordering

`TS Build > Vitest > Maven Build > Maven Test > npm Build > npm Test > Lint`

npm test skips when npm build fails (same pattern as Maven), reducing noise.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test expectation used wrong case for extracted error text**
- **Found during:** Task 1 (GREEN phase)
- **Issue:** Test 44 checked `toContain('error')` (lowercase) but `summarizeNpmBuildErrors` correctly extracts the line `ERROR in ./src/index.ts` (uppercase, as written in npm build output)
- **Fix:** Changed test expectation to `toContain('ERROR')` to match actual npm build output format
- **Files modified:** src/orchestrator/verifier.test.ts
- **Commit:** 017bc35 (included in implementation commit)

## Test Coverage

Added 24 new tests (tests 44-67), all passing alongside 47 existing tests (71 total):

| Suite | Tests | Status |
|-------|-------|--------|
| ErrorSummarizer.summarizeNpmBuildErrors | 4 | All pass |
| ErrorSummarizer.summarizeNpmTestFailures | 4 | All pass |
| npmBuildVerifier | 7 | All pass |
| npmTestVerifier | 6 | All pass |
| compositeVerifier — npm integration | 3 | All pass |
| All existing tests | 47 | Still passing |

## Commits

| Hash | Type | Description |
|------|------|-------------|
| 34160fe | test | RED: failing tests for npm error summarizers and verifiers |
| 017bc35 | feat | GREEN: implement npm verifiers, summarizers, composite integration |

## Self-Check: PASSED

Files exist:
- src/orchestrator/summarizer.ts: FOUND
- src/orchestrator/verifier.ts: FOUND
- src/orchestrator/verifier.test.ts: FOUND

Commits exist:
- 34160fe: FOUND
- 017bc35: FOUND

All 71 tests passing, `npx tsc --noEmit` clean.
