---
phase: 15-intent-parser-one-shot-mode
plan: 01
subsystem: intent
tags: [zod, intent-parser, fast-path, regex, context-scanner, pom.xml, package.json]

# Dependency graph
requires: []
provides:
  - IntentResult, FastPathResult, ResolvedIntent, ClarificationOption types via src/intent/types.ts
  - IntentSchema (Zod) enforcing version sentinel ('latest' or null only — never real version from LLM)
  - fastPathParse() for instant dependency update resolution without LLM call
  - validateDepInManifest() for checking package.json/pom.xml manifests
  - detectTaskType() for inferring task type from manifest presence
  - readManifestDeps() for structured manifest context injection into LLM prompts
affects: [15-02-llm-parser, 15-03-coordinator-cli]

# Tech tracking
tech-stack:
  added: [zod@^4.3.6 (explicit prod dep — was transitive via Anthropic SDK)]
  patterns:
    - "Zod schema for LLM output validation: z.enum(['latest']).nullable() prevents version number hallucination"
    - "TDD with real tmpDir fixtures using os.tmpdir() + fs.mkdtemp for filesystem tests"
    - "pom.xml parsed with <dependency> block scoping to avoid project's own artifactId"

key-files:
  created:
    - src/intent/types.ts
    - src/intent/types.test.ts
    - src/intent/fast-path.ts
    - src/intent/fast-path.test.ts
    - src/intent/context-scanner.ts
    - src/intent/context-scanner.test.ts
  modified:
    - package.json (zod added to dependencies)
    - package-lock.json

key-decisions:
  - "Zod IntentSchema.version is z.enum(['latest']).nullable() — real version numbers never come from LLM; FastPathResult.version is plain string because fast-path CAN extract user-specified versions"
  - "pom.xml parsing scoped to <dependency> blocks only — avoids including project's own <artifactId> in dep list"
  - "validateDepInManifest() also placed in fast-path.ts (not context-scanner.ts) since it serves fast-path validation before LLM fallback"
  - "detectTaskType() returns null for both-or-neither case — falls through to LLM, not a hard error"

patterns-established:
  - "Pattern: Intent module TDD with real tmpDir fixtures — no mocking fs, creates real files in beforeEach"
  - "Pattern: groupId:artifactId format for Maven deps in context scanner output"

requirements-completed: [INTENT-01, INTENT-02, INTENT-03]

# Metrics
duration: 59min
completed: 2026-03-20
---

# Phase 15 Plan 01: Intent Parser Types, Fast-Path Parser, and Context Scanner Summary

**Zod-validated intent type contracts, regex fast-path for dependency update patterns, and manifest-aware context scanner — all three non-LLM components of the intent parser**

## Performance

- **Duration:** ~59 min
- **Started:** 2026-03-20T14:03:39Z
- **Completed:** 2026-03-20T15:02:41Z
- **Tasks:** 3
- **Files modified:** 8

## Accomplishments
- Created `src/intent/types.ts` with IntentSchema (Zod), IntentResult, FastPathResult, ResolvedIntent, ClarificationOption — the full type contract for the intent parser subsystem
- Built `src/intent/fast-path.ts` with three functions: `fastPathParse()` (regex for obvious dependency patterns), `validateDepInManifest()` (package.json + pom.xml dep checking), `detectTaskType()` (infers npm vs maven from manifest)
- Built `src/intent/context-scanner.ts` with `readManifestDeps()` — reads package.json and pom.xml, scopes pom.xml to dependency blocks only (Pitfall 5 from research), returns structured string for LLM prompt injection
- Added zod as explicit prod dependency (was transitive only via Anthropic SDK)
- 37 new tests passing; full suite still at 367 passing (330 existing + 37 new)

## Task Commits

Each task was committed atomically:

1. **Task 1: Define intent parser type contracts and install zod** - `60c3ca2` (feat)
2. **Task 2: Build fast-path regex parser with tests** - `feab131` (feat)
3. **Task 3: Build context scanner with tests** - `cc48562` (feat)

_Note: All tasks followed TDD pattern — test written first (RED), implementation second (GREEN)_

## Files Created/Modified
- `src/intent/types.ts` - IntentSchema (Zod), IntentResult, FastPathResult, ResolvedIntent, ClarificationOption type contracts
- `src/intent/types.test.ts` - 7 tests: schema validation including version sentinel enforcement
- `src/intent/fast-path.ts` - fastPathParse(), validateDepInManifest(), detectTaskType()
- `src/intent/fast-path.test.ts` - 22 tests: all regex patterns, package.json/pom.xml manifest validation, task type detection
- `src/intent/context-scanner.ts` - readManifestDeps() with pom.xml dependency block scoping
- `src/intent/context-scanner.test.ts` - 8 tests: both manifest types, "No manifest found" case, groupId:artifactId format
- `package.json` - Added zod ^4.3.6 to dependencies
- `package-lock.json` - Updated with explicit zod resolution

## Decisions Made
- Zod schema's `version` field uses `z.enum(['latest']).nullable()` — this enforces the architectural invariant that version numbers NEVER come from the LLM. FastPathResult.version is a plain `string` because the fast-path CAN extract user-specified versions ("update recharts to 2.15.0").
- `validateDepInManifest()` placed in fast-path.ts (not context-scanner.ts) — it serves fast-path validation before LLM fallback, and the plan specified it as a fast-path.ts export.
- pom.xml parsing uses `/<dependency>[\s\S]*?<\/dependency>/g` block scoping to avoid including the project's own `<artifactId>` (research Pitfall 5).
- `detectTaskType()` returns null for both-or-neither manifest case — falls through to LLM for disambiguation.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None - all three tasks executed cleanly on first attempt.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Types foundation ready: Plans 02 and 03 can import from `src/intent/types.ts`
- Fast-path ready for coordinator: `fastPathParse()` + `validateDepInManifest()` + `detectTaskType()` are the fast path components needed by Plan 03's coordinator
- Context scanner ready for LLM parser: `readManifestDeps()` provides the manifest context needed by Plan 02's `llmParse()`
- No blockers for Plan 02 (LLM parser + confirm loop)

---
*Phase: 15-intent-parser-one-shot-mode*
*Completed: 2026-03-20*
