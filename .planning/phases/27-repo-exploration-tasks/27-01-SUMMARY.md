---
phase: 27-repo-exploration-tasks
plan: 01
subsystem: intent-pipeline, prompts
tags: [exploration, investigation, fast-path, prompt-builder, tdd]
dependency_graph:
  requires: []
  provides:
    - investigation task type in TASK_TYPES
    - ExplorationSubtype type and explorationSubtype on ResolvedIntent
    - explorationFastPath() with EXPLORATION_PATTERNS and ACTION_VERB_GUARD
    - buildExplorationPrompt() with 4-subtype registry
    - investigation case in buildPrompt() switch
  affects:
    - src/intent/types.ts
    - src/intent/fast-path.ts
    - src/intent/llm-parser.ts
    - src/intent/index.ts
    - src/prompts/index.ts
tech_stack:
  added: []
  patterns:
    - TDD (RED-GREEN per task)
    - end-state prompting discipline for exploration prompts
    - action verb guard prevents exploration misclassification
key_files:
  created:
    - src/prompts/exploration.ts
    - src/prompts/exploration.test.ts
  modified:
    - src/intent/types.ts
    - src/intent/fast-path.ts
    - src/intent/fast-path.test.ts
    - src/intent/llm-parser.ts
    - src/intent/llm-parser.test.ts
    - src/intent/index.ts
    - src/intent/index.test.ts
    - src/prompts/index.ts
decisions:
  - ACTION_VERB_GUARD regex prevents action verbs (update/fix/replace/add/remove etc.) from being misclassified as exploration — guard fires before pattern matching
  - ExplorationSubtype re-exported from src/intent/index.ts to keep public API surface at the index barrel
  - buildExplorationPrompt is synchronous (not async) — no I/O needed unlike buildGenericPrompt which reads manifests
  - SUBTYPES registry uses fallback: unknown subtype falls back to 'general' rather than throwing
metrics:
  duration_minutes: 3
  tasks_completed: 2
  files_created: 2
  files_modified: 7
  completed_date: "2026-04-06"
requirements:
  - EXPLR-01
  - EXPLR-02
---

# Phase 27 Plan 01: Investigation Type and Exploration Prompt Builder Summary

**One-liner:** `investigation` task type added to intent pipeline with regex fast-path + ACTION_VERB_GUARD, and 4-subtype exploration prompt builder with read-only constraint enforcement.

## What Was Built

### Task 1: Investigation type and exploration fast-path (commit: d6f67bd)

Added `'investigation'` as the 4th element of `TASK_TYPES` in `src/intent/types.ts`, making it automatically propagate to the Zod `IntentSchema` and the LLM `OUTPUT_SCHEMA` enum. Added `ExplorationSubtype` type and `explorationSubtype?: ExplorationSubtype` field to `ResolvedIntent`.

Added to `src/intent/fast-path.ts`:
- `EXPLORATION_PATTERNS`: 5 regex patterns matching exploration verbs and domain phrases
- `ACTION_VERB_GUARD`: blocks action verbs (update/fix/replace/add/remove/delete/create/refactor/rename/move/implement/migrate) from triggering exploration classification
- `explorationFastPath()`: returns `{ subtype }` for matched exploration intents, or `null` for empty/action-verb inputs

Updated `src/intent/index.ts` to call `explorationFastPath(input)` before `fastPathParse(input)`. When matched, immediately returns `{ taskType: 'investigation', explorationSubtype, dep: null, version: null, confidence: 'high' }` without LLM call.

Added 'investigation' guidance to `INTENT_SYSTEM_PROMPT` in `src/intent/llm-parser.ts` for LLM fallback coverage.

### Task 2: Exploration prompt builder (commit: 03e6b14)

Created `src/prompts/exploration.ts` with `buildExplorationPrompt(description, subtype)`:
- `SUBTYPES` registry mapping 4 subtype keys to `{ name, focusSection }` configs
- Each FOCUS section provides concrete investigation guidance (what to look for, which files/commands to use, report sections to populate)
- `CONSTRAINTS` section enforces read-only mode
- `OUTPUT` section uses end-state prompting discipline — describes the desired report, not steps
- Unknown subtypes fall back gracefully to `'general'`

Updated `src/prompts/index.ts`:
- Added `explorationSubtype?: string` to `PromptOptions`
- Added `case 'investigation':` in `buildPrompt()` switch dispatching to `buildExplorationPrompt()`
- Exported `buildExplorationPrompt` from the barrel

## Test Coverage

- `fast-path.test.ts`: 11 new tests in `explorationFastPath` describe block
- `llm-parser.test.ts`: 3 new tests verifying TASK_TYPES and system prompt inclusion
- `index.test.ts`: 3 new tests in `exploration fast-path` describe block (mock updated to include `explorationFastPath`)
- `exploration.test.ts`: 13 new tests covering all 4 subtypes, fallback, dispatch, error path
- **Total new tests: 30** | **Total tests passing: 236**

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

- src/prompts/exploration.ts: FOUND
- src/prompts/exploration.test.ts: FOUND
- Commit d6f67bd (Task 1): FOUND
- Commit 03e6b14 (Task 2): FOUND
