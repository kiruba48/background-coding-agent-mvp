---
phase: 14-infrastructure-foundation
plan: "03"
subsystem: cli
tags: [commander, abort-signal, auto-register, thin-adapter, vitest]

requires:
  - phase: 14-01
    provides: runAgent() with AbortSignal support in src/agent/index.ts
  - phase: 14-02
    provides: ProjectRegistry backed by conf@^15 in src/agent/registry.ts

provides:
  - autoRegisterCwd() function in src/cli/auto-register.ts
  - runCommand() thin adapter in src/cli/commands/run.ts
  - mapStatusToExitCode() utility (cancelled->130, timeout->124, success->0, others->1)
  - AbortController at CLI entry point with SIGINT/SIGTERM handlers
  - Auto-registration wired into run action (not projects subcommands)

affects:
  - Phase 15 (intent parser / CLI evolution)
  - Phase 16 (REPL / conversational interface)
  - Any phase extending CLI commands

tech-stack:
  added: []
  patterns:
    - "Thin adapter pattern: CLI validates, creates signal, calls library, maps exit code"
    - "Signal handlers at CLI entry point only — library code never registers process signals"
    - "Auto-registration fires on run command by checking project indicators in cwd"

key-files:
  created:
    - src/cli/auto-register.ts
    - src/cli/auto-register.test.ts
    - src/cli/commands/run.test.ts
  modified:
    - src/cli/commands/run.ts
    - src/cli/index.ts

key-decisions:
  - "Signal handlers (SIGINT/SIGTERM) live only in src/cli/index.ts — library code is process-signal-free"
  - "autoRegisterCwd fires in run action only — projects subcommands do not trigger registration"
  - "Basename collision with different path: skip silently (no overwrite, no error)"
  - "timeout CLI option (seconds) converted to timeoutMs (ms) inside runCommand, not at CLI level"

patterns-established:
  - "CLI entry point owns AbortController lifecycle — passes signal down to runCommand -> runAgent"
  - "mapStatusToExitCode is exported and independently testable (pure function)"
  - "Auto-register uses conf cwd option for test isolation (same pattern as registry tests)"

requirements-completed: [REG-02, INFRA-01]

duration: 4min
completed: 2026-03-19
---

# Phase 14 Plan 03: CLI Thin Adapter + Auto-Registration Summary

**CLI run command replaced with thin adapter over runAgent(); AbortController and SIGINT/SIGTERM handlers moved to CLI entry point; autoRegisterCwd() detects project indicators and registers on first run**

## Performance

- **Duration:** 4 min
- **Started:** 2026-03-19T22:58:34Z
- **Completed:** 2026-03-19T23:03:00Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments

- Implemented `autoRegisterCwd()` with TDD (8 tests covering all indicator/collision cases)
- Replaced 211-line orchestration-heavy `run.ts` with a 75-line thin adapter calling `runAgent()`
- Moved AbortController creation and SIGINT/SIGTERM signal handlers to `src/cli/index.ts`
- Exported `mapStatusToExitCode()` as a pure testable function (cancelled->130, timeout->124)
- Wired `autoRegisterCwd()` in the run action only — projects subcommands unaffected
- 325 total tests pass with no regressions

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement auto-registration hook** - `7ac3906` (feat + test TDD)
2. **Task 2: Refactor CLI run command as thin adapter** - `a49db82` (feat)

**Plan metadata:** (final docs commit)

_Note: Task 1 used TDD (RED verified via module-not-found error, GREEN via 8 passing tests)_

## Files Created/Modified

- `src/cli/auto-register.ts` - autoRegisterCwd() checks .git/package.json/pom.xml, registers basename, skips conflicts silently
- `src/cli/auto-register.test.ts` - 8 vitest tests covering all behaviors (indicators, no-indicator, conflict, notice)
- `src/cli/commands/run.ts` - Thin adapter: CLIRunOptions -> AgentOptions, calls runAgent(), maps exit code
- `src/cli/commands/run.test.ts` - 15 tests: mapStatusToExitCode (7 cases) + runCommand (8 cases with mocked runAgent)
- `src/cli/index.ts` - Added autoRegisterCwd(), AbortController, SIGINT/SIGTERM handlers; imports runCommand not runAgent

## Decisions Made

- Comment mentioning `process.exit()` removed from run.ts JSDoc to satisfy strict grep acceptance criteria (the comment described what the function does NOT do — reworded to "Terminate the process")
- Auto-registration wired before AbortController creation to avoid unnecessary complexity

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- Minor: JSDoc comment in run.ts contained the string `process.exit()` in a "Does NOT" list, causing the acceptance criteria grep check to fail. Fixed by rewording the comment. Not a code issue.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- CLI is now a clean thin shell: validate -> register -> signal -> runAgent() -> exit code
- SIGINT/SIGTERM separation is complete — Phase 16 (REPL) can add its own signal handling without conflict
- ProjectRegistry is populated on first `background-agent run` invocation in any project directory
- Phase 15 (intent parser) can extend the CLI input layer without touching agent library

---
*Phase: 14-infrastructure-foundation*
*Completed: 2026-03-19*
