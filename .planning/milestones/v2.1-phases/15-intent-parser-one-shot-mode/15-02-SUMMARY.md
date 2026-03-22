---
phase: 15-intent-parser-one-shot-mode
plan: 02
subsystem: intent
tags: [anthropic-sdk, structured-output, haiku-4.5, readline, zod, picocolors]

# Dependency graph
requires:
  - phase: 15-01
    provides: IntentSchema, IntentResult, ResolvedIntent types, context-scanner readManifestDeps

provides:
  - llmParse() — calls Haiku 4.5 beta structured output to classify natural language task input
  - confirmLoop() — interactive Y/n prompt with redirect/reparse support (max 3 attempts)
  - displayIntent() — compact intent summary block for terminal
  - "latest" sentinel handling in buildNpmPrompt, buildMavenPrompt, and buildPrompt dispatcher

affects: [15-03, one-shot-mode, prompt-builders]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "beta.messages.create() with output_config.format.json_schema for structured output (same pattern as judge.ts)"
    - "XML tag injection for manifest context: <manifest_context>...</manifest_context>"
    - "readline confirm loop: createInterface + SIGINT handler + finally { rl.close() }"
    - "Sentinel detection: targetVersion === 'latest' branch in prompt builders"

key-files:
  created:
    - src/intent/llm-parser.ts
    - src/intent/llm-parser.test.ts
    - src/intent/confirm-loop.ts
    - src/intent/confirm-loop.test.ts
  modified:
    - src/prompts/npm.ts
    - src/prompts/npm.test.ts
    - src/prompts/maven.ts
    - src/prompts/maven.test.ts
    - src/prompts/index.ts

key-decisions:
  - "llmParse() timeout is 15s (not 30s like judge) — intent classification is latency-sensitive user interaction"
  - "Non-y/n input in confirmLoop treated as inline correction (not forced 'n' + separate correction prompt)"
  - "buildPrompt defaults targetVersion to 'latest' via ?? operator — no longer throws when omitted for dep update types"
  - "Existing test 'throws when missing targetVersion' removed and replaced with 'defaults to latest'"

patterns-established:
  - "Pattern: Anthropic SDK mock in tests — vi.mock('@anthropic-ai/sdk') returning constructor with beta.messages.create"
  - "Pattern: readline mock — vi.mock('node:readline/promises') returning controlled question/close/on fns"

requirements-completed: [INTENT-01, INTENT-03, CLI-03]

# Metrics
duration: 18min
completed: 2026-03-20
---

# Phase 15 Plan 02: LLM Parser + Confirm Loop Summary

**Haiku 4.5 structured output intent classifier with Y/n confirm/redirect loop and "latest" sentinel handling in all prompt builders**

## Performance

- **Duration:** 18 min
- **Started:** 2026-03-20T15:06:00Z
- **Completed:** 2026-03-20T15:09:00Z
- **Tasks:** 3
- **Files modified:** 9

## Accomplishments
- `llmParse()` calls Haiku 4.5 via `beta.messages.create()` structured output, injects manifest context in `<manifest_context>` XML tags, and validates response with IntentSchema (version constrained to 'latest' or null via Zod)
- `confirmLoop()` shows compact intent summary, accepts Y/Enter to proceed, re-parses on 'n' with correction, aborts after 3 redirects with clear message; readline SIGINT handled, interface always closed in finally
- `buildNpmPrompt`, `buildMavenPrompt`, and `buildPrompt` now correctly handle 'latest' sentinel — agents are instructed to find the actual latest version from the registry

## Task Commits

Each task was committed atomically:

1. **Task 1: Build LLM parser with Haiku 4.5 structured output** - `d8e8290` (feat)
2. **Task 2: Build confirm loop with redirect support** - `8fb0634` (feat)
3. **Task 3: Update prompt builders to handle "latest" sentinel** - `f7d464f` (feat)

_Note: All tasks used TDD (RED → GREEN pattern)_

## Files Created/Modified
- `src/intent/llm-parser.ts` — llmParse() using beta.messages.create() with structured output schema
- `src/intent/llm-parser.test.ts` — 8 tests: valid result, ZodError on version string, model/betas/manifest context assertions
- `src/intent/confirm-loop.ts` — confirmLoop() + displayIntent(), readline with SIGINT handler
- `src/intent/confirm-loop.test.ts` — 10 tests: Y/Enter/n/redirect/abort/close/SIGINT assertions
- `src/prompts/npm.ts` — 'latest' sentinel branch: "latest available version" + registry lookup instruction
- `src/prompts/npm.test.ts` — added 3 tests for sentinel and removed "throws on missing targetVersion"
- `src/prompts/maven.ts` — same sentinel handling pattern as npm
- `src/prompts/maven.test.ts` — added 3 tests for sentinel and removed "throws on missing targetVersion"
- `src/prompts/index.ts` — `options.targetVersion ?? 'latest'` for both dep update types

## Decisions Made
- `llmParse()` uses 15s timeout (vs 30s in judge) — intent parsing is on the interactive path, latency matters
- Inline correction in confirmLoop: any non-y/n input is treated as a correction directly (no extra prompt), improving UX
- `buildPrompt` now defaults `targetVersion` to `'latest'` when omitted — removes footgun where coordinator forgets to pass version

## Deviations from Plan

None - plan executed exactly as written. The only minor decision was to remove the "throws when missing targetVersion" test case (which was superseded by the new "defaults to latest" behavior), which was explicitly specified in the plan.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- LLM parse path complete (INTENT-01, INTENT-03)
- Confirm loop complete (CLI-03)
- Prompt builders ready for intent pipeline (sentinel flows correctly end-to-end)
- Ready for Phase 15 Plan 03: coordinator `parseIntent()` that wires fast-path + LLM path + confirm loop into one-shot CLI command

---
*Phase: 15-intent-parser-one-shot-mode*
*Completed: 2026-03-20*

## Self-Check: PASSED

- FOUND: src/intent/llm-parser.ts
- FOUND: src/intent/confirm-loop.ts
- FOUND: .planning/phases/15-intent-parser-one-shot-mode/15-02-SUMMARY.md
- FOUND: d8e8290 (Task 1 commit)
- FOUND: 8fb0634 (Task 2 commit)
- FOUND: f7d464f (Task 3 commit)
