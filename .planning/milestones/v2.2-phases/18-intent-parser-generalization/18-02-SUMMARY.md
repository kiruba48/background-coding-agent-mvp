---
phase: 18-intent-parser-generalization
plan: 02
subsystem: intent
tags: [anthropic-sdk, zod, structured-outputs, intent-parser, typescript]

# Dependency graph
requires:
  - phase: 18-01
    provides: SDK bumped to ^0.80.0 enabling GA structured outputs API

provides:
  - IntentSchema with 'generic' enum value (replacing 'unknown') and taskCategory field
  - ResolvedIntent interface with optional taskCategory field
  - llm-parser.ts using GA client.messages.create with zero type assertions
  - index.ts passing through 'generic' directly with taskCategory

affects:
  - phase-19-generic-task-handler
  - any code consuming ResolvedIntent.taskType or creating IntentResult

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Generic task type passthrough: LLM returns 'generic' directly, no mapping needed in index.ts"
    - "taskCategory field classifies generic tasks as code-change, config-edit, or refactor"
    - "GA structured outputs: client.messages.create with output_config.format, no betas header"

key-files:
  created: []
  modified:
    - src/intent/types.ts
    - src/intent/types.test.ts
    - src/intent/llm-parser.ts
    - src/intent/llm-parser.test.ts
    - src/intent/index.ts
    - src/intent/index.test.ts

key-decisions:
  - "IntentSchema uses 'generic' enum value directly — 'unknown' is removed entirely, keeping schema honest"
  - "taskCategory is a required field in IntentSchema and OUTPUT_SCHEMA (null for dep-updates, enum for generic)"
  - "index.ts direct passthrough: llmResult.taskType used verbatim, no mapping required"
  - "GA API path: client.messages.create replaces client.beta.messages.create, zero type assertions"

patterns-established:
  - "taskCategory propagation: index.ts passes isGeneric ? llmResult.taskCategory : undefined to ResolvedIntent"
  - "OUTPUT_SCHEMA must always mirror IntentSchema — enum values and required fields must match exactly"

requirements-completed: [INTENT-01, INTENT-03]

# Metrics
duration: 4min
completed: 2026-03-23
---

# Phase 18 Plan 02: Intent Schema Generalization + GA API Migration Summary

**IntentSchema migrated from 'unknown' to 'generic' with taskCategory field, and LLM parser migrated from beta structured outputs to GA client.messages.create with zero type assertions**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-23T10:54:36Z
- **Completed:** 2026-03-23T10:58:24Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- IntentSchema now uses 'generic' enum value; 'unknown' is completely removed
- taskCategory field (code-change | config-edit | refactor | null) added to IntentSchema, OUTPUT_SCHEMA, and ResolvedIntent
- index.ts uses direct passthrough (llmResult.taskType verbatim) — no unknown->generic mapping
- INTENT_SYSTEM_PROMPT updated with generic taskType guidance and taskCategory classification rules
- llm-parser.ts migrated to GA API: client.messages.create, Message type, no betas header, no type assertions

## Task Commits

Each task was committed atomically:

1. **TDD RED: failing tests for generic schema + taskCategory** - `50af3dd` (test)
2. **Task 1: Update IntentSchema, OUTPUT_SCHEMA, system prompt, and index.ts mapping** - `bc73883` (feat)
3. **Task 2: Migrate LLM parser to GA structured outputs API** - `b9d9d33` (feat)

## Files Created/Modified
- `src/intent/types.ts` - IntentSchema with 'generic' enum + taskCategory field; ResolvedIntent with taskCategory
- `src/intent/types.test.ts` - Tests for generic acceptance, unknown rejection, invalid taskCategory rejection
- `src/intent/llm-parser.ts` - GA API call, updated OUTPUT_SCHEMA and INTENT_SYSTEM_PROMPT
- `src/intent/llm-parser.test.ts` - Mock updated to GA path, betas assertion replaced with output_config assertion
- `src/intent/index.ts` - Direct generic passthrough, taskCategory flows through
- `src/intent/index.test.ts` - Updated to use 'generic' taskType in mocks, added taskCategory assertion

## Decisions Made
- 'unknown' completely removed from schema — schema is honest about the task types it handles
- taskCategory is a required field in both IntentSchema and OUTPUT_SCHEMA (null for dep-updates ensures consistent shape)
- Direct passthrough in index.ts instead of mapping — cleaner and prevents future drift
- GA API requires SDK ^0.80.0 (delivered in Plan 01); no runtime behavior changes expected

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## Next Phase Readiness
- INTENT-01 and INTENT-03 requirements complete
- ResolvedIntent.taskCategory is now available for Phase 19 generic task handler to consume
- All 121 intent tests pass, TypeScript compiles cleanly

---
*Phase: 18-intent-parser-generalization*
*Completed: 2026-03-23*
