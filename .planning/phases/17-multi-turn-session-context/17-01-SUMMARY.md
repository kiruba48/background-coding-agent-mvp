---
phase: 17-multi-turn-session-context
plan: 01
subsystem: intent
tags: [multi-turn, session-history, follow-up, fast-path, llm-parser, parseIntent]

# Dependency graph
requires:
  - phase: 16-repl-session-core
    provides: ReplState interface and session core in src/repl/types.ts, src/repl/session.ts
  - phase: 15-intent-parser-one-shot-mode
    provides: parseIntent coordinator, FastPathResult, ResolvedIntent, llmParse, fastPathParse

provides:
  - TaskHistoryEntry interface exported from src/repl/types.ts
  - MAX_HISTORY_ENTRIES constant (10) in src/repl/types.ts
  - history field on ReplState interface
  - isFollowUp flag on FastPathResult
  - inheritedFields field on ResolvedIntent
  - FOLLOW_UP_PATTERNS regex set in fast-path.ts detecting "also X", "now do X", "same for X", "X too"
  - buildHistoryBlock() function in llm-parser.ts for session history XML injection
  - History-aware llmParse() signature with optional history parameter
  - History-threading in parseIntent coordinator with follow-up inheritance and graceful degradation

affects:
  - 17-02 (wires history into session core and confirm display)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Follow-up detection via regex BEFORE standard patterns — order matters for correct precedence
    - Session history XML blocks injected into LLM user message between manifest context and user input
    - Graceful degradation: follow-up with no history strips prefix and re-parses as fresh
    - inheritedFields Set communicates which fields came from history to display layer

key-files:
  created: []
  modified:
    - src/repl/types.ts
    - src/repl/session.ts
    - src/intent/types.ts
    - src/intent/fast-path.ts
    - src/intent/fast-path.test.ts
    - src/intent/llm-parser.ts
    - src/intent/llm-parser.test.ts
    - src/intent/index.ts
    - src/intent/index.test.ts

key-decisions:
  - "Follow-up pattern detection in fast-path.ts runs BEFORE standard DEPENDENCY_PATTERNS — order ensures 'also update lodash' hits follow-up path, not ambiguous standard path"
  - "Graceful degradation when no history: strip follow-up prefix and recursive re-parse with history: undefined — prevents infinite recursion, enables clean first-turn behavior"
  - "inheritedFields uses Set<'taskType' | 'repo'> to communicate to display layer which fields were inherited without coupling the parse result to UI concerns"
  - "History XML block placed between </manifest_context> and <user_input> — structured so LLM sees context before the user message"

patterns-established:
  - "Follow-up patterns: check FOLLOW_UP_PATTERNS before DEPENDENCY_PATTERNS in fast-path; same pattern precedence should be maintained if patterns are extended"
  - "History injection: buildHistoryBlock() formats entries as numbered list; append to user message not system prompt"
  - "inheritedFields: Set on ResolvedIntent — always a new Set instance, never mutated"

requirements-completed: [SESS-01]

# Metrics
duration: 5min
completed: 2026-03-22
---

# Phase 17 Plan 01: Multi-Turn Session Context — Type Definitions and Intent Layer Summary

**TaskHistoryEntry type, follow-up regex patterns in fast-path, session history XML injection in LLM parser, and history-aware parseIntent coordinator with inheritedFields tagging**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-03-22T11:18:47Z
- **Completed:** 2026-03-22T11:22:59Z
- **Tasks:** 3
- **Files modified:** 9

## Accomplishments

- Defined `TaskHistoryEntry` interface and `MAX_HISTORY_ENTRIES = 10` in `src/repl/types.ts`, extended `ReplState` with `history` field
- Added `FOLLOW_UP_PATTERNS` to fast-path.ts detecting "also update X", "now do X", "same for X", "X too" patterns; returns `isFollowUp: true` on match; false positives (multi-word non-dep phrases) correctly return null
- Extended `llmParse()` to accept optional `history?: TaskHistoryEntry[]`; injects `<session_history>` XML block into user message and adds follow-up guidance to system prompt when history is non-empty
- Updated `parseIntent` coordinator to accept `history` in `ParseOptions`, inherit taskType/repo from last history entry for follow-ups, tag `inheritedFields` on result, and gracefully degrade (strip prefix + re-parse) when no history

## Task Commits

1. **Task 1: Define TaskHistoryEntry type and extend intent types** - `39b636c` (feat)
2. **Task 2: Add follow-up detection to fast-path and history injection to LLM parser** - `06cb511` (feat)
3. **Task 3: Update parseIntent coordinator to thread history and set inheritedFields** - `0526ac6` (feat)

## Files Created/Modified

- `src/repl/types.ts` - Added TaskHistoryEntry interface, MAX_HISTORY_ENTRIES constant, history field on ReplState
- `src/repl/session.ts` - Updated createSessionState() to include `history: []` (auto-fix for compilation)
- `src/intent/types.ts` - Added isFollowUp?: boolean to FastPathResult, inheritedFields?: Set to ResolvedIntent
- `src/intent/fast-path.ts` - Added FOLLOW_UP_PATTERNS array and follow-up detection before standard patterns
- `src/intent/fast-path.test.ts` - Added 12 follow-up pattern tests
- `src/intent/llm-parser.ts` - Added buildHistoryBlock(), extended llmParse() with optional history parameter
- `src/intent/llm-parser.test.ts` - Added 6 history injection tests
- `src/intent/index.ts` - Added history to ParseOptions, follow-up inheritance logic, inheritedFields tagging, TaskHistoryEntry re-export
- `src/intent/index.test.ts` - Added 4 history threading tests, updated existing llmParse assertion for 3-arg call

## Decisions Made

- Follow-up detection runs BEFORE standard DEPENDENCY_PATTERNS — critical for "update lodash too" to match follow-up path rather than matching standard pattern without isFollowUp flag
- Graceful degradation uses recursive `parseIntent()` call with `history: undefined` to avoid infinite recursion while reusing all existing resolution logic
- `inheritedFields: Set<'taskType' | 'repo'>` chosen over a boolean flag to allow display layer (Plan 02) to show which specific fields were inherited

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed createSessionState() missing history field causing TypeScript error**
- **Found during:** Task 1 (type definitions)
- **Issue:** Adding `history: TaskHistoryEntry[]` to ReplState made `createSessionState()` in session.ts fail TypeScript compilation with TS2741 (missing required property)
- **Fix:** Added `history: []` to the returned object literal in `createSessionState()`
- **Files modified:** `src/repl/session.ts`
- **Verification:** `npx tsc --noEmit` exits 0 after fix
- **Committed in:** `39b636c` (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 - blocking type error)
**Impact on plan:** Necessary for correct compilation. No scope creep — the history field was specified by the plan; only the downstream initialization needed updating.

## Issues Encountered

None beyond the auto-fixed compilation error above.

## Next Phase Readiness

- All intent-layer types and parsing logic ready for Plan 02
- `TaskHistoryEntry` exported from both `src/repl/types.ts` and re-exported from `src/intent/index.ts`
- `inheritedFields` on `ResolvedIntent` ready for confirm display (Plan 02 shows "[inherited from last task]" labels)
- `history` field on `ReplState` ready for session core to populate after each task completes (Plan 02)
- 93 tests pass across intent layer and session core

---
*Phase: 17-multi-turn-session-context*
*Completed: 2026-03-22*
