---
phase: 22-conversational-scoping-dialogue
plan: "02"
subsystem: cli
tags: [readline, repl, displayIntent, scopeHints, SessionCallbacks, confirmCb]

# Dependency graph
requires:
  - phase: 22-01
    provides: SessionCallbacks.askQuestion? optional field, confirm callback scopeHints parameter, runScopingDialogue pure function
provides:
  - displayIntent(intent, scopeHints?) renders scope hints header and indented bullets
  - CLI confirmCb threads scopeHints from processInput to displayIntent
  - CLI callbacks.askQuestion wired to existing readline helper for zero-new-I/O scoping
affects: [22-03, 22-04, 24-slack-adapter]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Optional parameter threading: scopeHints flows from processInput -> confirm callback -> displayIntent without breaking existing callers"
    - "Reuse existing helper: askQuestion callback delegates to the already-established readline askQuestion function"

key-files:
  created: []
  modified:
    - src/intent/confirm-loop.ts
    - src/cli/commands/repl.ts
    - src/intent/confirm-loop.test.ts

key-decisions:
  - "confirmLoop also updated to accept scopeHints (for completeness) even though the REPL uses its own confirmCb — keeps the standalone confirmLoop path consistent"

patterns-established:
  - "Scope hints display: header 'Scope hints:' followed by indented dim bullets, rendered between existing fields and trailing newline"
  - "CLI adapter pattern: callbacks.askQuestion delegates to existing readline helper with rl and activeQuestionControllerRef refs"

requirements-completed: [SCOPE-04]

# Metrics
duration: 3min
completed: 2026-03-26
---

# Phase 22 Plan 02: CLI Adapter & Scope Hints Display Summary

**displayIntent extended with optional scopeHints rendering and CLI callbacks.askQuestion wired to readline helper, completing the end-to-end scoping dialogue path**

## Performance

- **Duration:** 3 min
- **Started:** 2026-03-26T10:44:50Z
- **Completed:** 2026-03-26T10:48:00Z
- **Tasks:** 1 (TDD: RED + GREEN)
- **Files modified:** 3

## Accomplishments

- `displayIntent` now accepts optional `scopeHints?: string[]` and renders a "Scope hints:" header with indented dim bullets when non-empty, rendering nothing extra when empty or undefined
- CLI `confirmCb` updated to accept the `scopeHints` third parameter from Plan 01's signature change and thread it to both `displayIntent` calls inside the callback
- CLI `callbacks` object now includes `askQuestion` wired to the pre-existing `askQuestion(rl, prompt, activeQuestionControllerRef)` helper — zero new I/O code
- `confirmLoop` standalone path also updated to accept and thread `scopeHints` for consistency

## Task Commits

Each task was committed atomically via TDD:

1. **RED - Failing scope hints tests** - `4fc1aa9` (test)
2. **GREEN - Scope hints + CLI wiring implementation** - `972f9f8` (feat)

## Files Created/Modified

- `src/intent/confirm-loop.ts` - displayIntent and confirmLoop updated with scopeHints parameter
- `src/cli/commands/repl.ts` - confirmCb accepts scopeHints, passes to displayIntent; callbacks.askQuestion added
- `src/intent/confirm-loop.test.ts` - 4 new tests: non-empty hints render, empty array omits, undefined omits, existing fields still present with hints

## Decisions Made

- confirmLoop (standalone) also updated for scopeHints even though REPL uses its own confirmCb — keeps the path consistent and avoids a divergence if confirmLoop is used directly in tests or future non-REPL callers

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Full end-to-end scoping dialogue is now wired: LLM generates questions (Plan 01) -> user answers via CLI askQuestion -> hints collected in processInput -> confirm callback receives scopeHints -> displayIntent shows them at the confirm step -> hints included in agent prompt (Plan 01 buildGenericPrompt)
- Phase 22 is complete. Phase 23 (REPL post-hoc PR creation) and Phase 24 (Slack adapter) can proceed independently.

---
*Phase: 22-conversational-scoping-dialogue*
*Completed: 2026-03-26*
