---
phase: 27-repo-exploration-tasks
plan: "02"
subsystem: execution-pipeline
tags: [investigation, read-only, docker, session, agent]
dependency_graph:
  requires: [27-01]
  provides: [investigation-execution-path, read-only-docker-mount, read-only-hook]
  affects: [src/types.ts, src/cli/docker/index.ts, src/orchestrator/claude-code-session.ts, src/agent/index.ts]
tech_stack:
  added: []
  patterns: [TDD red-green, dynamic import for investigation bypass]
key_files:
  created: []
  modified:
    - src/types.ts
    - src/cli/docker/index.ts
    - src/cli/docker/index.test.ts
    - src/orchestrator/claude-code-session.ts
    - src/orchestrator/claude-code-session.test.ts
    - src/agent/index.ts
    - src/agent/index.test.ts
decisions:
  - "Investigation bypass placed between Docker lifecycle and worktree lifecycle in runAgent — Docker setup runs, worktree/orchestrator/verifier/judge/PR are all skipped"
  - "SessionResult.status is a subset of RetryResult.finalStatus so direct cast `as RetryResult['finalStatus']` is valid without a mapping table"
  - "dynamic import used for ClaudeCodeSession in investigation path to match original plan action spec; vi.mock() hoisting still intercepts it correctly in tests"
  - "MockClaudeCodeSession uses vi.fn() constructor pattern (not class) to make the ctor a spy, enabling toHaveBeenCalledWith assertions in Vitest"
metrics:
  duration: "~4 minutes"
  completed: "2026-04-06"
  tasks_completed: 2
  files_modified: 7
---

# Phase 27 Plan 02: Investigation Execution Pipeline Summary

Investigation task execution wired end-to-end: Docker :ro mount, PreToolUse read-only hook, runAgent bypass of RetryOrchestrator/verifier/judge/PR, and clean status mapping to RetryResult.

## What Was Built

### Task 1: readOnly flag through Docker and PreToolUse hook

`SessionConfig.readOnly?: boolean` was added to `src/types.ts`. `DockerRunOptions.readOnly?: boolean` was added to `src/cli/docker/index.ts`, with the workspace mount switching from `:rw` to `:ro` when set. `buildPreToolUseHook` in `src/orchestrator/claude-code-session.ts` gained a `readOnly?: boolean` parameter — when true, the hook denies `Write` and `Edit` tool calls immediately with the message `blocked: read-only session — this investigation task cannot modify files`. Bash tools are not blocked (the `:ro` mount enforces OS-level write protection). Both the hook creation and the `buildDockerRunArgs` call now receive `this.config.readOnly`.

### Task 2: Investigation bypass in runAgent

`AgentOptions.explorationSubtype?: string` was added to `src/agent/index.ts`. A bypass block was inserted in `runAgent` between the Docker lifecycle and the worktree lifecycle. When `options.taskType === 'investigation'`, the function builds a prompt (forwarding `explorationSubtype`), creates a bare `ClaudeCodeSession` with `readOnly: true`, runs it, and returns a `RetryResult` with `verificationResults: []` and `attempts: 1`. RetryOrchestrator, WorktreeManager, compositeVerifier, llmJudge, and GitHubPRCreator are never instantiated for investigation tasks.

## Test Coverage Added

- Docker: `:ro` mount when `readOnly: true`, `:rw` when `false` or omitted (backward compat)
- Session hook: denies Write/Edit with `blocked: read-only session` message in read-only mode; allows Bash; non-read-only mode unchanged
- Agent: investigation bypasses RetryOrchestrator, WorktreeManager; ClaudeCodeSession created with `readOnly:true`; `explorationSubtype` forwarded to `buildPrompt`; session status (success/cancelled/failed) maps directly to `finalStatus`

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check

- [x] `src/types.ts` contains `readOnly?: boolean` in SessionConfig
- [x] `src/cli/docker/index.ts` contains `opts.readOnly ? 'ro' : 'rw'`
- [x] `src/orchestrator/claude-code-session.ts` contains `blocked: read-only session`
- [x] `src/agent/index.ts` contains `if (options.taskType === 'investigation')`
- [x] All 95 tests pass
- [x] Task 1 commit: 94ba2f4
- [x] Task 2 commit: d19737d
