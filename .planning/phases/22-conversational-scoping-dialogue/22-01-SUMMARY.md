---
phase: 22-conversational-scoping-dialogue
plan: 01
subsystem: intent-parser
tags: [scoping-dialogue, intent-parser, llm-schema, session-callbacks, prompt-engineering]

# Dependency graph
requires: []
provides:
  - IntentSchema.scopingQuestions field (Zod schema + TypeScript type)
  - ResolvedIntent.scopingQuestions field
  - OUTPUT_SCHEMA.scopingQuestions field for LLM structured output
  - INTENT_SYSTEM_PROMPT instruction #9 for scoping question generation
  - readTopLevelDirs() helper in context-scanner.ts
  - llmParse() repoPath parameter + top_level_dirs XML context block
  - runScopingDialogue() pure function (caps at 3 questions, skips null/empty)
  - SessionCallbacks.askQuestion optional method
  - SessionCallbacks.confirm updated signature with scopeHints third param
  - processInput() Step 2.5 scoping dialogue (generic tasks only)
  - scopeHints threaded through AgentOptions -> PromptOptions -> buildGenericPrompt
  - buildGenericPrompt SCOPE HINTS block
affects:
  - 22-02 (wires CLI confirm display and askQuestion adapter)
  - 24-slack-adapter (implements askQuestion or skips via optional design)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Optional callback pattern: SessionCallbacks.askQuestion optional so adapters (Slack, one-shot) gracefully skip scoping
    - scopingQuestions not added to required array in OUTPUT_SCHEMA; Zod .default([]) handles missing field from cached/old LLM responses
    - Scoping dialogue pure function (runScopingDialogue) separate from processInput for testability

key-files:
  created: []
  modified:
    - src/intent/types.ts
    - src/intent/llm-parser.ts
    - src/intent/index.ts
    - src/intent/context-scanner.ts
    - src/repl/types.ts
    - src/repl/session.ts
    - src/prompts/generic.ts
    - src/prompts/index.ts
    - src/agent/index.ts
    - src/intent/llm-parser.test.ts
    - src/intent/context-scanner.test.ts
    - src/intent/index.test.ts
    - src/repl/session.test.ts
    - src/prompts/generic.test.ts

key-decisions:
  - "scopingQuestions NOT added to OUTPUT_SCHEMA required array — Zod .default([]) handles missing field without breaking cached/old LLM responses"
  - "readTopLevelDirs uses sync readdirSync (not async) since it is called inside an already-async llmParse; no latency concern"
  - "runScopingDialogue is a pure exported function (not inlined in processInput) for isolated testability"

patterns-established:
  - "Optional callback pattern: askQuestion? means adapters implement only what they need; session core gates on callbacks.askQuestion presence"
  - "scopeHints flow: processInput -> AgentOptions.scopeHints -> PromptOptions.scopeHints -> buildGenericPrompt third arg -> SCOPE HINTS block"

requirements-completed: [SCOPE-01, SCOPE-02, SCOPE-03, SCOPE-05]

# Metrics
duration: 7min
completed: 2026-03-26
---

# Phase 22 Plan 01: Extend Intent Parser and Session Core for Scoping Questions Summary

**LLM-generated scoping questions pipeline: scopingQuestions from Zod schema through intent parser to REPL dialogue and agent prompt SCOPE HINTS block**

## Performance

- **Duration:** 7 min
- **Started:** 2026-03-26T10:34:43Z
- **Completed:** 2026-03-26T10:41:20Z
- **Tasks:** 2
- **Files modified:** 14 (9 source + 5 test)

## Accomplishments

- Scoping questions data pipeline: LLM generates questions -> intent parser forwards them -> REPL collects answers -> agent prompt includes SCOPE HINTS
- runScopingDialogue() pure function caps at 3 questions, skips null/empty answers, formats as "question: answer" hint strings
- processInput() gates scoping on taskType === 'generic' AND callbacks.askQuestion defined — npm/maven tasks never see scoping, non-REPL adapters silently skip
- scopeHints thread end-to-end: processInput -> AgentOptions -> PromptOptions -> buildGenericPrompt SCOPE HINTS block
- readTopLevelDirs() provides real directory context to LLM for generating precise, repo-aware scoping questions

## Task Commits

Each task was committed atomically:

1. **Task 1: Extend intent types, LLM schema, and context scanner** - `702effc` (feat)
2. **Task 2: Add SessionCallbacks.askQuestion, runScopingDialogue, processInput scoping, SCOPE HINTS, thread scopeHints** - `a121538` (feat)

## Files Created/Modified

- `src/intent/types.ts` - Added scopingQuestions to IntentSchema and ResolvedIntent
- `src/intent/llm-parser.ts` - Added scopingQuestions to OUTPUT_SCHEMA, instruction #9 to system prompt, max_tokens 1024, repoPath param, top_level_dirs block
- `src/intent/index.ts` - Forward scopingQuestions for generic tasks; pass repoPath to llmParse
- `src/intent/context-scanner.ts` - Added readTopLevelDirs() export for repo directory context
- `src/repl/types.ts` - Added askQuestion? to SessionCallbacks; updated confirm signature with scopeHints param
- `src/repl/session.ts` - Added runScopingDialogue() export; added Step 2.5 scoping in processInput; scopeHints in agentOptions
- `src/prompts/generic.ts` - Added scopeHints parameter; appends SCOPE HINTS block when non-empty
- `src/prompts/index.ts` - Added scopeHints to PromptOptions; passes to buildGenericPrompt
- `src/agent/index.ts` - Added scopeHints to AgentOptions; passes to buildPrompt
- `src/intent/llm-parser.test.ts` - Tests: IntentSchema with/without scopingQuestions, max_tokens 1024, top_level_dirs inclusion
- `src/intent/context-scanner.test.ts` - Tests: readTopLevelDirs with fixture dirs, nonexistent path, hidden dir exclusion, sorted output
- `src/intent/index.test.ts` - Updated mock responses to include scopingQuestions; updated llmParse call assertion for 4-arg signature
- `src/repl/session.test.ts` - Tests: runScopingDialogue behavior, processInput scoping gates, scopeHints in agentOptions and confirm
- `src/prompts/generic.test.ts` - Tests: buildGenericPrompt with/without scopeHints, SCOPE HINTS block content and position

## Decisions Made

- scopingQuestions NOT added to `required` array in OUTPUT_SCHEMA — Zod `.default([])` handles missing field from cached/old LLM responses without breaking
- readTopLevelDirs uses synchronous `readdirSync` (called inside async llmParse context) — no latency concern, simpler code
- runScopingDialogue exported as pure function separate from processInput for isolated unit testing

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Updated index.test.ts mock responses to include scopingQuestions field**
- **Found during:** Task 2 (buildgenericprompt and pipeline wiring)
- **Issue:** Adding `scopingQuestions` with `.optional().default([])` to IntentSchema makes TypeScript infer `scopingQuestions: string[]` as required in the output type. Existing mock objects in index.test.ts were missing this field, causing 8+ TypeScript errors during `npm run build`.
- **Fix:** Added `scopingQuestions: []` to all 9 mock LLM response objects in index.test.ts; updated llmParse call assertion to include repoPath as 4th argument.
- **Files modified:** src/intent/index.test.ts
- **Verification:** `npm test` passes (620 tests), `npm run build` succeeds (no TypeScript errors)
- **Committed in:** a121538 (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 — bug: TypeScript type mismatch in test mocks)
**Impact on plan:** Fix required for correctness — existing tests would fail TypeScript compilation. No scope creep.

## Issues Encountered

None beyond the auto-fixed deviation above.

## Next Phase Readiness

- Complete scoping pipeline (LLM -> dialogue -> agent prompt) is ready
- Plan 22-02 needs to wire the CLI adapter: implement `askQuestion` in REPL CLI, display scopeHints in confirm output
- SessionCallbacks.confirm already accepts scopeHints (third param) — Plan 02 can render them in the UI
- Slack adapter (Phase 24) can omit askQuestion entirely — scoping silently bypassed by optional design

## Self-Check: PASSED

All created files verified present. Both task commits (702effc, a121538) confirmed in git log.

---
*Phase: 22-conversational-scoping-dialogue*
*Completed: 2026-03-26*
