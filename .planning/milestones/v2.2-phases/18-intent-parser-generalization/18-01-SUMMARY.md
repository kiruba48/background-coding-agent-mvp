---
phase: 18-intent-parser-generalization
plan: "01"
subsystem: intent
tags: [anthropic-sdk, regex, fast-path, refactoring-guard]

# Dependency graph
requires: []
provides:
  - SDK @anthropic-ai/sdk bumped to ^0.80.0 (prerequisite for structured outputs API in Plan 02)
  - REFACTORING_VERB_GUARD regex in fast-path.ts blocking replace/rename/move/extract/migrate/rewrite
  - 10 new verb-guard test cases in fast-path.test.ts including regression guard for dep verbs
affects: [18-02-structured-outputs, intent-parser]

# Tech tracking
tech-stack:
  added: ["@anthropic-ai/sdk@^0.80.0"]
  patterns:
    - "Module-scope regex constants for fast-path guards (REFACTORING_VERB_GUARD alongside FOLLOW_UP_PATTERNS, DEPENDENCY_PATTERNS)"
    - "Verb guard fires before PR suffix strip to catch compound refactoring+PR instructions"

key-files:
  created: []
  modified:
    - package.json
    - package-lock.json
    - src/intent/fast-path.ts
    - src/intent/fast-path.test.ts

key-decisions:
  - "REFACTORING_VERB_GUARD exported from fast-path.ts for test visibility and future reuse"
  - "Verb guard placed before PR_SUFFIX test so 'replace axios with fetch and create PR' is blocked at the guard, not matched as a dep-update-with-PR"
  - "TDD RED phase: new tests already passed without implementation because DEPENDENCY_PATTERNS requires update|upgrade|bump — verb guard is defense-in-depth against future pattern expansion"

patterns-established:
  - "Defense-in-depth: named REFACTORING_VERB_GUARD constant makes the exclusion explicit and stable across future pattern changes"

requirements-completed: [INTENT-02, INTENT-03]

# Metrics
duration: 2min
completed: 2026-03-23
---

# Phase 18 Plan 01: SDK Bump and Refactoring Verb Guard Summary

**SDK bumped to ^0.80.0 for structured outputs API, plus REFACTORING_VERB_GUARD regex blocking six refactoring verbs from fast-path dependency matching**

## Performance

- **Duration:** 2 min
- **Started:** 2026-03-23T10:49:54Z
- **Completed:** 2026-03-23T10:52:12Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- @anthropic-ai/sdk bumped from ^0.71.2 to ^0.80.0 with all 513 tests passing
- REFACTORING_VERB_GUARD added as module-scope exported const — blocks replace/rename/move/extract/migrate/rewrite
- Guard fires before PR_SUFFIX strip, preventing false positive on "replace X with Y and create PR"
- 10 new test cases in describe('verb guard') block including dep-verb regression guard

## Task Commits

Each task was committed atomically:

1. **Task 1: Bump @anthropic-ai/sdk to ^0.80.0** - `4b93027` (chore)
2. **Task 2 RED: Add failing tests for verb guard** - `8e6cf16` (test)
3. **Task 2 GREEN: Implement refactoring verb guard** - `e812ffc` (feat)

**Plan metadata:** (docs commit follows)

_Note: TDD RED tests already passed without implementation — DEPENDENCY_PATTERNS already required update|upgrade|bump. Guard is defense-in-depth._

## Files Created/Modified
- `package.json` - SDK version bumped to ^0.80.0
- `package-lock.json` - lockfile updated for SDK ^0.80.0
- `src/intent/fast-path.ts` - Added exported REFACTORING_VERB_GUARD const and guard check
- `src/intent/fast-path.test.ts` - Added describe('verb guard') block with 10 test cases

## Decisions Made
- Exported `REFACTORING_VERB_GUARD` from fast-path.ts for test visibility and to allow callers to inspect the set of guarded verbs
- Placed verb guard before PR_SUFFIX test (before line 35) to ensure compound instructions like "replace axios with fetch and create PR" are blocked at the guard rather than partially parsed
- No REFACTOR phase needed — implementation was clean on first pass

## Deviations from Plan

### TDD Note

The TDD RED phase (new tests must fail before implementation) could not produce failing tests because the new behavioral requirements are already satisfied by existing patterns: DEPENDENCY_PATTERNS only matches "update|upgrade|bump" as the first verb, so "replace X with Y" naturally returns null without any guard. The verb guard provides defense-in-depth to make this exclusion explicit and stable against future pattern additions.

All other plan steps executed exactly as specified.

---

**Total deviations:** 0 rule-violations (TDD note only — behavioral requirements pre-satisfied by existing patterns)
**Impact on plan:** No scope creep. Guard implemented as specified.

## Issues Encountered
None — SDK upgrade and verb guard both applied cleanly with zero type errors.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Plan 02 (structured outputs migration) is unblocked — SDK ^0.80.0 is now in place
- REFACTORING_VERB_GUARD is in place so LLM parser will receive refactoring instructions (fast-path returns null for them)
- All 513 tests pass, TypeScript clean

---
*Phase: 18-intent-parser-generalization*
*Completed: 2026-03-23*
