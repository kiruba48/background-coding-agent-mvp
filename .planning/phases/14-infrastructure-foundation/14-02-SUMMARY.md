---
phase: 14-infrastructure-foundation
plan: "02"
subsystem: project-registry
tags: [registry, cli, conf, commander, tdd]
dependency_graph:
  requires: []
  provides: [ProjectRegistry, createProjectsCommand]
  affects: [src/cli/index.ts]
tech_stack:
  added: [conf@^15]
  patterns: [TDD-red-green, dependency-injection-for-tests, commander-subcommand-group]
key_files:
  created:
    - src/agent/registry.ts
    - src/agent/registry.test.ts
    - src/cli/commands/projects.ts
    - src/cli/commands/projects.test.ts
  modified:
    - src/cli/index.ts
    - package.json
    - package-lock.json
key_decisions:
  - "Registry factory injection pattern for test isolation (avoids mocking conf internals)"
  - "conf@15 cwd option used in tests to isolate storage in tmpDir"
  - "createProjectsCommand accepts optional registryFactory for test injection"
metrics:
  duration_minutes: 3
  completed_date: "2026-03-19"
  tasks_completed: 2
  files_changed: 7
requirements_satisfied: [REG-01]
---

# Phase 14 Plan 02: Project Registry Summary

**One-liner:** ProjectRegistry CRUD backed by conf@^15 with Commander CLI subcommands for `bg-agent projects list|add|remove`

## What Was Built

- **`src/agent/registry.ts`** — `ProjectRegistry` class with `register`, `resolve`, `has`, `remove`, `list` methods, backed by `conf@^15` for atomic persistent JSON storage. Constructor accepts optional `{ cwd }` for test isolation.
- **`src/cli/commands/projects.ts`** — `createProjectsCommand()` returns a Commander subcommand group with `list`, `add`, and `remove` sub-commands. Path existence validated via `fs.access`. Name conflicts trigger TTY prompt in interactive mode, error in non-TTY (CI/scripts). Registry factory injection enables test isolation.
- **`src/cli/index.ts`** — Wired `createProjectsCommand()` via `program.addCommand()`.
- **Tests** — 8 registry tests + 7 CLI command tests, all passing. TDD: RED-GREEN-REFACTOR followed for both tasks.

## Tests

```
src/agent/registry.test.ts  — 8 tests (PASS)
src/cli/commands/projects.test.ts — 7 tests (PASS)
Total: 15 tests
```

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed test helper parseAsync argument format**
- **Found during:** Task 2 GREEN phase
- **Issue:** Test helper called `cmd.parseAsync(['node', 'bg-agent', 'projects', ...args])` but `cmd` is already the `projects` Command, so Commander saw 'projects' as an unknown subcommand name
- **Fix:** Changed to `cmd.parseAsync(['node', 'bg-agent', ...args])` — correct when cmd IS the projects Command
- **Files modified:** `src/cli/commands/projects.test.ts`
- **Commit:** b73f1c8

### Pre-existing Issues (Out of Scope)

TypeScript error in `src/agent/index.ts` and `src/cli/commands/run.ts` (`"cancelled"` not assignable to `SessionStatus`) exists on the branch prior to this plan. Not caused by or related to registry work. Logged per scope rules.

## Self-Check: PASSED
