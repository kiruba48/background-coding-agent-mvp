---
phase: 15-intent-parser-one-shot-mode
plan: 03
subsystem: cli
tags: [commander, intent-parser, one-shot, natural-language, readline, registry, clarification]

# Dependency graph
requires:
  - phase: 15-01
    provides: types.ts, fast-path.ts, context-scanner.ts (intent foundation)
  - phase: 15-02
    provides: llm-parser.ts, confirm-loop.ts (LLM parsing + confirm UI)
  - phase: 14
    provides: ProjectRegistry, autoRegisterCwd, runAgent, AgentOptions

provides:
  - parseIntent() coordinator (src/intent/index.ts) — fast-path → manifest validate → LLM fallback
  - oneShotCommand() handler (src/cli/commands/one-shot.ts) — NL → clarify → confirm → runAgent
  - CLI positional arg routing (src/cli/index.ts) — bg-agent 'NL' vs legacy -t -r flags

affects: [phase-16, phase-17, any code importing from src/intent/index.ts or src/cli]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - TDD with registry injection: tests pass registry instance via ParseOptions.registry rather than mocking constructor
    - Constructor mock pattern: use function() syntax (not arrow) for vi.fn() mocks called with `new`
    - Readline mock hoisting fix: avoid top-level variables in vi.mock() factory (hoisting constraint)

key-files:
  created:
    - src/intent/index.ts
    - src/intent/index.test.ts
    - src/cli/commands/one-shot.ts
    - src/cli/commands/one-shot.test.ts
  modified:
    - src/cli/index.ts

key-decisions:
  - "parseIntent coordinator is channel-agnostic: repo prompting and clarification UI live in one-shot.ts, not in index.ts"
  - "clarifications injected into resolveRepoInteractively moved to CLI layer; parseIntent only returns clarifications array"
  - "Registry injection via ParseOptions.registry (not constructor mock) — consistent with Phase 14 factory injection pattern"
  - "vi.fn() constructor mocks require regular function syntax, not arrow functions (arrow fns cannot be called with new)"
  - "oneShotCommand returns 0 (not error) on both: user cancels clarification and user aborts confirm loop — clean exits"

patterns-established:
  - "Pattern: Two-phase routing in CLI: positional NL arg → oneShotCommand; -t/-r flags → runCommand (legacy)"
  - "Pattern: Interactive readline mocks use sequential answer arrays (makeRlMock) to avoid hoisting issues"

requirements-completed: [INTENT-01, INTENT-02, CLI-01, CLI-03]

# Metrics
duration: 8min
completed: 2026-03-20
---

# Phase 15 Plan 03: Intent Parser One-Shot Mode Summary

**parseIntent() coordinator wiring fast-path → manifest validation → LLM fallback, with one-shot CLI command handler providing numbered clarification UI, interactive repo prompting, and Commander.js positional arg routing**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-03-20T15:12:04Z
- **Completed:** 2026-03-20T15:20:00Z
- **Tasks:** 2 (4 commits: 2 TDD RED + 2 TDD GREEN)
- **Files modified:** 5 (2 created source, 2 created tests, 1 modified)

## Accomplishments

- parseIntent() coordinator orchestrates fast-path → dep validation → LLM fallback in correct order (INTENT-03: manifest read before LLM)
- oneShotCommand() connects all intent components into working pipeline with numbered clarification choices, interactive repo prompting, and autoRegisterCwd
- CLI positional arg routing: `bg-agent 'update recharts'` routes to one-shot path; legacy `-t -r` flags route to runCommand unchanged
- 423/423 tests pass (was 337 before, added 14 + 17 = 31 new tests); `npx tsc --noEmit` clean

## Task Commits

Each task was committed atomically:

1. **Task 1: parseIntent coordinator (RED)** - `9f58b29` (test)
2. **Task 1: parseIntent coordinator (GREEN)** - `0a96740` (feat)
3. **Task 2: one-shot + CLI routing (RED)** - `a8172c9` (test)
4. **Task 2: one-shot + CLI routing (GREEN)** - `142ab9e` (feat)

_Note: TDD tasks have two commits each (test → feat)_

## Files Created/Modified

- `src/intent/index.ts` - parseIntent() coordinator; re-exports all intent module types and functions
- `src/intent/index.test.ts` - 14 tests covering fast-path success, LLM fallback, registry resolution, clarification passthrough
- `src/cli/commands/one-shot.ts` - oneShotCommand() with promptClarification(), resolveRepoInteractively(), full pipeline
- `src/cli/commands/one-shot.test.ts` - 17 tests covering core path, options, clarifications, repo prompting
- `src/cli/index.ts` - Added .argument('[input]'), changed -t/-r from requiredOption to option, added routing fork

## Decisions Made

- parseIntent coordinator is channel-agnostic: repo prompting and clarification UI live in one-shot.ts, not in index.ts. This keeps parseIntent usable from non-CLI contexts (Slack, REPL, etc.) per the conversational agent roadmap.
- Registry injection via ParseOptions.registry (not constructor mock): consistent with Phase 14 factory injection pattern; avoids mock constructor issues in tests.
- oneShotCommand returns 0 (clean exit) when user cancels clarification AND when confirmLoop returns null — both are intentional user aborts, not errors.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed vi.mock() constructor mocking for ProjectRegistry**
- **Found during:** Task 1 (parseIntent tests) and Task 2 (one-shot tests)
- **Issue:** Tests used arrow function `() => instance` as mockImplementation for `new ProjectRegistry()`. Arrow functions cannot be invoked with `new`, causing `TypeError: () => ... is not a constructor`.
- **Fix:** Task 1: Changed tests to inject registry via ParseOptions.registry (avoiding new ProjectRegistry() in hot path). Task 2: Created makeRegistryCtor() helper using regular `function` syntax compatible with `new`.
- **Files modified:** src/intent/index.test.ts, src/cli/commands/one-shot.test.ts
- **Verification:** All 31 new tests pass
- **Committed in:** 0a96740, 142ab9e

**2. [Rule 1 - Bug] Fixed vi.mock() hoisting for readline/promises**
- **Found during:** Task 2 (one-shot tests)
- **Issue:** `mockRlInstance` defined at top-level then referenced inside vi.mock() factory caused `ReferenceError: Cannot access 'mockRlInstance' before initialization` due to vi.mock hoisting.
- **Fix:** Moved mock setup to beforeEach using a `makeRlMock(answers)` factory with sequential answer array.
- **Files modified:** src/cli/commands/one-shot.test.ts
- **Verification:** All 17 one-shot tests pass
- **Committed in:** 142ab9e

---

**Total deviations:** 2 auto-fixed (both Rule 1 — test infrastructure bugs)
**Impact on plan:** Both fixes necessary for correct test isolation. No scope creep. Source code unaffected.

## Issues Encountered

- Commander.js requires `addCommand()` to remain before `parse()` for subcommand routing (confirmed by plan research, implemented correctly).

## Next Phase Readiness

- Phase 15 complete. All 3 plans executed. Full intent parser + one-shot mode pipeline working.
- All components connected: fast-path → LLM fallback → clarification → confirm loop → runAgent
- Phase 16 or 17 can consume the intent module via `import { parseIntent } from 'src/intent/index.js'`
- No blockers. Full test suite green.

---
*Phase: 15-intent-parser-one-shot-mode*
*Completed: 2026-03-20*
