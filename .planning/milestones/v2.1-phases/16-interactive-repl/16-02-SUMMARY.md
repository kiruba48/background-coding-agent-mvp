---
phase: 16-interactive-repl
plan: 02
subsystem: cli
tags: [readline, repl, signals, history, nanospinner, picocolors, typescript]

# Dependency graph
requires:
  - phase: 16-01
    provides: "processInput(), createSessionState(), SessionCallbacks interface, ReplState types from src/repl/"
  - phase: 15-02
    provides: "displayIntent() from confirm-loop.ts, ResolvedIntent types"
provides:
  - "replCommand() — full CLI REPL adapter with readline, SIGINT handling, history, banner, result rendering"
  - "REPL routing in CLI entry point — no-args invocation opens interactive REPL"
  - "loadHistory/saveHistory — history persistence to ~/.config/background-agent/history"
  - "renderResultBlock — box-drawing result summary after each task"
affects:
  - phase: 17
    description: "Conversational multi-turn mode will extend replCommand() patterns"

# Tech tracking
tech-stack:
  added: ["nanospinner@^1.2.2 — spinner for Docker startup check"]
  patterns:
    - "Ref-object pattern for mutable signal state in closures (activeQuestionControllerRef)"
    - "Per-task AbortController created in main loop; discarded after each task"
    - "rl.on('history') event for incremental history persistence"
    - "Dynamic import of replCommand() in index.ts — lazy-load REPL and nanospinner"

key-files:
  created:
    - src/cli/commands/repl.ts
    - src/cli/commands/repl.test.ts
  modified:
    - src/cli/index.ts
    - src/repl/session.test.ts

key-decisions:
  - "REPL guard in index.ts placed BEFORE AbortController and process signal handlers — readline owns SIGINT in REPL mode, process.on(SIGINT) would conflict"
  - "Dynamic import('./commands/repl.js') in index.ts — nanospinner and REPL code loaded only when needed"
  - "askQuestion uses a ref object ({current}) rather than a module-level variable so the SIGINT closure can observe the current controller without stale closure captures"
  - "Docker checks run exactly once at REPL startup via nanospinner spinner — not per-task (session core passes skipDockerChecks: true)"
  - "confirmLoop from confirm-loop.ts not imported — it creates its own readline which would conflict; REPL reimplements confirm flow using shared rl interface"

patterns-established:
  - "Single readline interface shared across all REPL interactions (confirm, clarify, main prompt)"
  - "SessionCallbacks wired to shared readline — decouples I/O from session logic (same pattern as Phase 16-01)"

requirements-completed: [CLI-02]

# Metrics
duration: 3min
completed: 2026-03-20
---

# Phase 16 Plan 02: Interactive REPL Summary

**CLI REPL adapter with readline loop, double-Ctrl+C signal handling, history persistence to ~/.config/background-agent/history, nanospinner Docker startup banner, project-aware prompt, and box-drawing result block — wired into index.ts so `bg-agent` with no args opens the REPL**

## Performance

- **Duration:** ~3 min
- **Started:** 2026-03-20T19:58:34Z
- **Completed:** 2026-03-20T20:01:02Z
- **Tasks:** 2 of 2
- **Files modified:** 4

## Accomplishments

- Built `src/cli/commands/repl.ts` — full interactive REPL with readline, SIGINT (single cancel / double force-kill / idle clear), Ctrl+D exit, history persistence, startup banner with Docker check, project-aware prompt, and SessionCallbacks for confirm/clarify
- Wired REPL into `src/cli/index.ts` — no-args invocation routes to REPL before process signal handlers are installed
- Fixed pre-existing TypeScript type errors in `src/repl/session.test.ts` (vi.fn() without generic types caused tsc failure)
- 16 unit tests for loadHistory, saveHistory, getPrompt, renderResultBlock — all pass; 85 total CLI+REPL tests green, build passes

## Task Commits

Each task was committed atomically:

1. **Task 1: Build CLI REPL adapter** - `296e68c` (feat)
2. **Task 2: Wire REPL into CLI entry point + fix session.test.ts types** - `a8c0299` (feat)

## Files Created/Modified

- `src/cli/commands/repl.ts` — replCommand(), loadHistory/saveHistory, getPrompt, renderResultBlock, SIGINT/close/history handlers, confirm/clarify callbacks using shared readline
- `src/cli/commands/repl.test.ts` — 16 unit tests for composable pure functions
- `src/cli/index.ts` — REPL guard added before AbortController/signal handlers; dynamic import of replCommand
- `src/repl/session.test.ts` — Fixed vi.fn() generics to use vi.fn<SessionCallbacks[method]>() for TypeScript compliance

## Decisions Made

- REPL guard in `index.ts` is placed **before** `new AbortController()` and `process.on('SIGINT')` — critical because readline's `rl.on('SIGINT')` owns signal handling in REPL mode; a conflicting process handler would exit on first Ctrl+C.
- Ref object `activeQuestionControllerRef` used instead of a module-level variable to avoid stale closure captures when the SIGINT handler fires.
- `confirmLoop` from `confirm-loop.ts` is deliberately not imported — it creates its own readline interface which would conflict. The REPL re-implements the confirm flow using the long-lived shared `rl` instance.
- Docker checks run once at REPL startup (spinner shows progress). The session core already passes `skipDockerChecks: true` per the Phase 16-01 decision.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed TypeScript type errors in src/repl/session.test.ts**
- **Found during:** Task 2 verification (`npm run build`)
- **Issue:** `vi.fn()` without generic type parameters produced `Mock<Procedure | Constructable>` which is not assignable to `SessionCallbacks` method signatures — caused 9 tsc errors
- **Fix:** Changed `vi.fn()` to `vi.fn<SessionCallbacks['confirm']>()` etc. and typed `makeCallbacks` return as `SessionCallbacks`
- **Files modified:** src/repl/session.test.ts
- **Verification:** `npm run build` exits 0, all tests still pass
- **Committed in:** a8c0299 (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 - pre-existing type bug in prior plan's test file)
**Impact on plan:** Essential for build correctness. No scope creep.

## Issues Encountered

None beyond the TypeScript type fix documented above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 16 is complete: REPL session core (Plan 01) and CLI adapter (Plan 02) are both done
- `bg-agent` with no args opens the interactive REPL with Docker banner, readline history, and project-aware prompt
- Phase 17 (multi-turn conversational mode) can extend `processInput()` with conversation history and extend `replCommand()` for multi-turn display
- Blocker noted in STATE.md: token budget sizing for multi-turn history is unvalidated — recommend research phase before Phase 17 planning

---
*Phase: 16-interactive-repl*
*Completed: 2026-03-20*
