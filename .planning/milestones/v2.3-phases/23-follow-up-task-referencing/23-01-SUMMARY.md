---
phase: 23-follow-up-task-referencing
plan: 01
subsystem: intent
tags: [llm-parser, repl, session-history, follow-up, tdd]

# Dependency graph
requires:
  - phase: 21-repl-state-foundation
    provides: TaskHistoryEntry schema with description field, processInput try/finally history pattern
  - phase: 22-conversational-scoping-dialogue
    provides: ScopeHint type, runScopingDialogue pattern
provides:
  - TaskHistoryEntry.finalResponse field for enriched history
  - summarize() utility for 300-char sentence-boundary truncation
  - Enriched buildHistoryBlock with Task:/Changes: lines per entry
  - Reference resolution guidance in LLM system prompt (pronoun, positional, keyword)
affects: [phase-24-slack-adapter]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "flatMap over history entries to emit multi-line blocks conditionally"
    - "Conditional XML line emission: omit line when field undefined (no placeholder)"
    - "taskResult captured before if-block so both success and non-throw-fail paths have it"

key-files:
  created: []
  modified:
    - src/repl/types.ts
    - src/repl/session.ts
    - src/intent/llm-parser.ts
    - src/repl/session.test.ts
    - src/intent/llm-parser.test.ts

key-decisions:
  - "finalResponse accessed via taskResult?.sessionResults?.at(-1)?.finalResponse — NOT RetryResult.finalResponse (which does not exist)"
  - "taskResult captured BEFORE success check so all non-throw statuses (success, failed, zero_diff) get finalResponse"
  - "Changes line omitted when finalResponse undefined — no placeholder text per locked decision"
  - "summarize() has 50-char minimum before accepting sentence boundary to avoid cutting at version numbers like v2.1."

patterns-established:
  - "Multi-line history blocks: use flatMap + filter(Boolean) to conditionally emit sub-lines"
  - "TDD flow: write failing tests, confirm RED, implement minimal fix, confirm GREEN"

requirements-completed: [FLLW-03]

# Metrics
duration: 4min
completed: 2026-04-01
---

# Phase 23 Plan 01: Follow-up Task Referencing Summary

**Enriched LLM history block with Task/Changes lines and pronoun/positional/keyword reference resolution guidance, enabling "now add tests for that" to resolve correctly to previous task subject**

## Performance

- **Duration:** 4 min
- **Started:** 2026-04-01T08:15:20Z
- **Completed:** 2026-04-01T08:19:25Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- Added `finalResponse?: string` to `TaskHistoryEntry` and wired data flow from `runAgent` through `appendHistory`
- Exported `summarize()` utility truncating at last sentence boundary within 300 chars (50-char minimum before accepting)
- Updated `buildHistoryBlock()` to emit `Task:` line (when description present) and `Changes:` line (when finalResponse present) per entry
- Extended system prompt with reference resolution guidance: pronoun ("that", "it"), positional ("task 2"), and keyword ("the auth task") patterns
- 17 new tests across session.test.ts and llm-parser.test.ts with full TDD RED/GREEN cycle

## Task Commits

Each task was committed atomically:

1. **Task 1: Types + data flow + summarize utility** - `46ad24e` (feat)
2. **Task 2: Enriched buildHistoryBlock format + reference resolution prompt + tests** - `7cba27b` (feat)

**Plan metadata:** `(pending)` (docs: complete plan)

## Files Created/Modified
- `src/repl/types.ts` - Added `finalResponse?: string` field to `TaskHistoryEntry`
- `src/repl/session.ts` - Capture `taskResult`, import `RetryResult`, pass `finalResponse` to `appendHistory`
- `src/intent/llm-parser.ts` - Added `summarize()` export, updated `buildHistoryBlock()` to flatMap with Task:/Changes: lines, extended system prompt
- `src/repl/session.test.ts` - Added 4 FLLW-03 tests for finalResponse flow
- `src/intent/llm-parser.test.ts` - Added 13 tests: enriched format, reference resolution guidance, summarize unit tests

## Decisions Made
- `taskResult` captured before the `if (result.finalStatus === 'success')` block so that non-throw failures (status: 'failed', 'zero_diff') also capture `finalResponse`
- `summarize()` minimum boundary threshold is 50 chars to avoid cutting at short version strings like "v2.1."
- No placeholder text in Changes line — omitted entirely when `finalResponse` is undefined

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- FLLW-03 complete: follow-up inputs like "now add tests for that" will now resolve to the previous task's subject via enriched LLM history block
- Phase 24 (Slack adapter) can leverage the enriched history block for multi-turn conversation context
- No blockers

---
*Phase: 23-follow-up-task-referencing*
*Completed: 2026-04-01*

## Self-Check: PASSED

- src/repl/types.ts: FOUND
- src/repl/session.ts: FOUND
- src/intent/llm-parser.ts: FOUND
- 23-01-SUMMARY.md: FOUND
- Commit 46ad24e: FOUND
- Commit 7cba27b: FOUND
