---
phase: 07-github-pr-creation
plan: "02"
subsystem: cli
tags: [cli, commander, github, pr, integration]

# Dependency graph
requires:
  - phase: 07-01
    provides: GitHubPRCreator class (pr-creator.ts), PRResult interface (types.ts)
  - src/cli/index.ts (Commander program)
  - src/cli/commands/run.ts (runAgent, RunOptions)
provides:
  - --create-pr CLI flag with GITHUB_TOKEN validation
  - --branch CLI flag with --create-pr dependency validation
  - RunOptions.createPr and RunOptions.branchOverride fields
  - PR creation step wired in runAgent() after finalStatus === 'success'
affects:
  - Phase 8 (Maven Dependency Update) — CLI now creates PRs after successful agent runs
  - Phase 9 (npm Dependency Update) — same

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Non-fatal PR creation (exit code 0 on agent success regardless of PR outcome)
    - CLI flag mutual dependency validation (--branch requires --create-pr)
    - Pre-run environment validation (GITHUB_TOKEN checked before agent starts)

key-files:
  created: []
  modified:
    - src/cli/index.ts (--create-pr and --branch flags added)
    - src/cli/commands/run.ts (RunOptions extended, GitHubPRCreator wired)

key-decisions:
  - "PR creation failure is non-fatal: agent success exit code (0) is preserved even if PR errors"
  - "--branch without --create-pr exits code 2 (user error) before any agent work"
  - "GITHUB_TOKEN checked pre-run so user gets immediate feedback, not a failure after minutes of agent work"

patterns-established:
  - "Mutual flag validation pattern: secondary flag validated against primary before heavy work starts"
  - "Non-fatal post-success step: wrap in try/catch, log warning, preserve exit code"

requirements-completed: [PR-03]

# Metrics
duration: 10min
completed: 2026-03-02
---

# Phase 7 Plan 02: CLI Integration Summary

**--create-pr and --branch flags wired into Commander CLI with GITHUB_TOKEN pre-validation and non-fatal PR creation step after successful agent runs.**

## Performance

- **Duration:** 10 min
- **Started:** 2026-03-02T15:10:00Z
- **Completed:** 2026-03-02T15:20:00Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- Added `--create-pr` and `--branch` CLI flags to Commander program in `src/cli/index.ts`
- Added pre-run validations: `--branch` requires `--create-pr` (exit 2), `--create-pr` requires `GITHUB_TOKEN` (exit 2)
- Extended `RunOptions` with `createPr?: boolean` and `branchOverride?: string`
- Wired `GitHubPRCreator.create()` in `runAgent()` after `retryResult.finalStatus === 'success'`
- PR creation failure is non-fatal: logs warning + branch name, exit code remains 0

## Task Commits

Each task was committed atomically:

1. **Task 1: Add --create-pr and --branch flags to CLI** - `8b119a1` (feat)
2. **Task 2: Extend RunOptions and wire PR creation in runAgent()** - `ad8372f` (feat)

## Files Created/Modified
- `src/cli/index.ts` - Added `--create-pr` and `--branch` options; validation for mutual dependency and GITHUB_TOKEN; passes `createPr`/`branchOverride` to `runAgent()`
- `src/cli/commands/run.ts` - Imported `GitHubPRCreator` and `picocolors`; added `createPr?` and `branchOverride?` to `RunOptions`; PR creation block after successful `retryResult`

## Decisions Made

- **PR creation is non-fatal**: If `GitHubPRCreator.create()` returns `prResult.error` or throws, the CLI logs a yellow warning and prints the branch name for manual PR creation, but keeps exit code 0 (the agent succeeded). This matches the CONTEXT.md decision from Plan 01.
- **Pre-run GITHUB_TOKEN validation**: Checked before `runAgent()` to surface the missing token immediately (exit 2) rather than after minutes of agent work.
- **`--branch` mutual dependency**: Validated pre-run so users get an immediate error (exit 2) if they forget `--create-pr`.

## CLI Usage Examples

**Default (no PR creation):**
```sh
background-agent -t maven-dependency-update -r /path/to/repo
```

**With PR creation (auto-generated branch name):**
```sh
GITHUB_TOKEN=ghp_... background-agent -t maven-dependency-update -r /path/to/repo --create-pr
```

**With PR creation and custom branch:**
```sh
GITHUB_TOKEN=ghp_... background-agent -t maven-dependency-update -r /path/to/repo --create-pr --branch agent/maven-deps-q1-2026
```

**Error cases:**
```sh
# --branch without --create-pr → exit 2
background-agent -t test -r . --branch my-branch
# Error: --branch requires --create-pr

# --create-pr without GITHUB_TOKEN → exit 2
background-agent -t test -r . --create-pr
# Error: GITHUB_TOKEN environment variable is required for --create-pr
```

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None. The 6 pre-existing "No test suite found" failures in `agent.test.ts`, `container.test.ts`, and `session.test.ts` are stub files that existed before this plan (confirmed by stash verification — same failures on base branch). All 254 actual tests pass with no regressions.

## Next Phase Readiness

- Phase 7 complete: `GitHubPRCreator` service (Plan 01) + CLI integration (Plan 02) fully implemented
- Phase 8 (Maven Dependency Update) can use `--create-pr` flag to create PRs after successful maven runs
- Phase 9 (npm Dependency Update) same
- No blockers

---
*Phase: 07-github-pr-creation*
*Completed: 2026-03-02*
