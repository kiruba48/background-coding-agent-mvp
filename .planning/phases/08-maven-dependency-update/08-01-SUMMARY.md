---
phase: 08-maven-dependency-update
plan: 01
subsystem: cli
tags: [commander, prompts, maven, end-state-prompting]

# Dependency graph
requires:
  - phase: 07-github-pr-creation
    provides: CLI foundation with runAgent and RunOptions interface
provides:
  - "--dep and --target-version CLI flags with conditional validation"
  - "Prompt module (src/prompts/) with task-type dispatch and Maven builder"
  - "End-state prompt for Maven dependency updates"
affects: [08-maven-dependency-update, 09-npm-dependency-update]

# Tech tracking
tech-stack:
  added: []
  patterns: [end-state-prompting-per-task-type, prompt-module-dispatch, conditional-cli-validation]

key-files:
  created:
    - src/prompts/maven.ts
    - src/prompts/index.ts
    - src/prompts/maven.test.ts
  modified:
    - src/cli/index.ts
    - src/cli/commands/run.ts

key-decisions:
  - "Prompt module decoupled from CLI types via minimal PromptOptions interface"
  - "depRequiringTaskTypes array for extensible conditional validation (Phase 9 adds npm)"
  - "buildPrompt replaces hardcoded prompt in run.ts for all task types"

patterns-established:
  - "Prompt dispatch: buildPrompt switches on taskType, delegates to per-type builders"
  - "Conditional CLI validation: depRequiringTaskTypes array gates flag requirements by task type"

requirements-completed: [MVN-01, MVN-02]

# Metrics
duration: 3min
completed: 2026-03-05
---

# Phase 8 Plan 01: CLI Flags and Prompt Module Summary

**CLI --dep and --target-version flags with end-state Maven prompt builder dispatched via src/prompts/ module**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-05T14:37:47Z
- **Completed:** 2026-03-05T14:40:50Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- Created prompt module with Maven end-state prompt builder following project's end-state prompting principle
- Added --dep and --target-version CLI flags with conditional validation (exit 2 when missing for maven-dependency-update)
- Replaced hardcoded prompt string in run.ts with buildPrompt dispatch
- 10 unit tests covering prompt content, dispatch, validation, and fallback

## Task Commits

Each task was committed atomically:

1. **Task 1: Create prompt module with Maven prompt builder** - `70bd447` (feat, TDD)
2. **Task 2: Add --dep and --target-version CLI flags** - `1809a9e` (feat)

_Task 1 used TDD: tests written first (RED), then implementation (GREEN), combined in single commit._

## Files Created/Modified
- `src/prompts/maven.ts` - End-state prompt builder for Maven dependency updates
- `src/prompts/index.ts` - Prompt dispatch by task type with PromptOptions interface
- `src/prompts/maven.test.ts` - 10 unit tests for prompt builder and dispatch
- `src/cli/index.ts` - Added --dep, --target-version flags and conditional validation
- `src/cli/commands/run.ts` - Extended RunOptions, switched to buildPrompt module

## Decisions Made
- Prompt module uses minimal PromptOptions interface (not full RunOptions) to stay decoupled from CLI types
- depRequiringTaskTypes array designed for extension in Phase 9 (npm-dependency-update)
- buildPrompt replaces hardcoded prompt for all task types, ensuring generic fallback matches previous behavior

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

Pre-existing TypeScript errors in verifier.test.ts reference mavenBuildVerifier/mavenTestVerifier exports that don't exist yet (plan 08-02 scope). These are not caused by this plan's changes and were not fixed.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Prompt module ready for Phase 9 to add npm prompt builder
- CLI flags ready for end-to-end Maven dependency update pipeline
- Plan 08-02 (Maven verification in composite verifier) is unblocked

---
*Phase: 08-maven-dependency-update*
*Completed: 2026-03-05*

## Self-Check: PASSED
