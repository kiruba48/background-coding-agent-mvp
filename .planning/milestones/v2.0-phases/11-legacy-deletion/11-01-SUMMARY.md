---
phase: 11-legacy-deletion
plan: 01
subsystem: orchestrator
tags: [legacy-deletion, typescript, sdk-migration, cleanup]
dependency_graph:
  requires: []
  provides: [clean-orchestrator, sdk-only-session]
  affects: [src/orchestrator, src/cli, src/types.ts]
tech_stack:
  added: []
  patterns: [sdk-only-session, barrel-export]
key_files:
  created: []
  modified:
    - src/types.ts
    - src/orchestrator/claude-code-session.ts
    - src/orchestrator/retry.ts
    - src/orchestrator/index.ts
    - src/orchestrator/retry.test.ts
    - src/orchestrator/judge.test.ts
    - src/cli/index.ts
    - src/cli/commands/run.ts
    - package.json
  deleted:
    - src/orchestrator/agent.ts
    - src/orchestrator/session.ts
    - src/orchestrator/container.ts
    - src/orchestrator/agent.test.ts
    - src/orchestrator/session.test.ts
    - src/orchestrator/container.test.ts
decisions:
  - SessionConfig migrated to src/types.ts without useSDK or image fields — single source of truth for session configuration
  - ContainerConfig and ToolResult removed from types.ts — exclusively used by deleted legacy files
  - RetryOrchestrator simplified to unconditional new ClaudeCodeSession(this.config) — no conditional branch
  - Legacy test files deleted entirely rather than adapted — they tested Docker-based infrastructure that no longer exists
metrics:
  duration: 3m 12s
  completed_date: "2026-03-18"
  tasks_completed: 2
  files_changed: 15
---

# Phase 11 Plan 01: Legacy Deletion Summary

**One-liner:** Deleted 1,989 lines of Docker-based agent infrastructure (AgentSession, AgentClient, ContainerManager) and migrated SessionConfig to types.ts, leaving ClaudeCodeSession as the sole agent runtime.

## What Was Built

Eliminated all legacy agent code from Phase 1-3 that is now superseded by ClaudeCodeSession (Claude Agent SDK):

- **Deleted 6 files** (~1,989 lines): agent.ts, session.ts, container.ts and their test files
- **Migrated SessionConfig** from session.ts to src/types.ts — removes `useSDK` and `image` (Docker-only) fields
- **Simplified RetryOrchestrator** from a conditional `useSDK !== false ? ClaudeCodeSession : AgentSession` branch to an unconditional `new ClaudeCodeSession(this.config)`
- **Cleaned barrel export** (index.ts) — removed AgentClient, AgentSession, ContainerManager exports; re-exported SessionConfig from types.js
- **Removed CLI flag** `--no-use-sdk` and `useSDK` from RunOptions interface and orchestrator config
- **Removed dockerode** dependency and `@types/dockerode` devDependency; removed 4 legacy test scripts (test:agent, test:container, test:session, test:all)

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Migrate SessionConfig to types.ts and delete legacy files | b54a2cd | src/types.ts (modified), 6 files deleted |
| 2 | Update imports, simplify RetryOrchestrator, clean CLI, remove dockerode | c4ca2b4 | 9 files modified |

## Verification Results

- `npx tsc --noEmit` — zero errors
- No production file references AgentSession, AgentClient, or ContainerManager
- No file in codebase imports from `./session.js`, `./agent.js`, or `./container.js`
- SessionConfig in src/types.ts has no `useSDK` or `image` fields
- RetryOrchestrator contains `const session = new ClaudeCodeSession(this.config)` with no conditional
- dockerode absent from package.json dependencies and devDependencies
- `--no-use-sdk` flag absent from CLI

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed broken test imports after session.ts deletion**
- **Found during:** Task 2 (tsc --noEmit reported TS2307 errors)
- **Issue:** retry.test.ts and judge.test.ts had `vi.mock('./session.js', ...)` and `import { AgentSession } from './session.js'` — both unresolvable after session.ts was deleted
- **Fix:** Removed the `vi.mock('./session.js', ...)` block, the `import { AgentSession }` import, and the `MockAgentSession` cast from both test files. Tests already used `MockClaudeCodeSession` for all session mocking — the AgentSession mock was vestigial.
- **Files modified:** src/orchestrator/retry.test.ts, src/orchestrator/judge.test.ts
- **Commit:** c4ca2b4 (included in Task 2 commit)

**2. [Rule 1 - Stale comments] Removed AgentSession references from claude-code-session.ts JSDoc**
- **Found during:** Task 2 post-verification grep
- **Issue:** JSDoc comments in claude-code-session.ts referenced "AgentSession" (e.g., "drop-in replacement for AgentSession", "Matches AgentSession.start() signature")
- **Fix:** Updated three comment lines to remove AgentSession references; kept technical substance
- **Files modified:** src/orchestrator/claude-code-session.ts
- **Commit:** c4ca2b4

## Self-Check: PASSED

All key files present, deleted files absent, both task commits verified in git log.
