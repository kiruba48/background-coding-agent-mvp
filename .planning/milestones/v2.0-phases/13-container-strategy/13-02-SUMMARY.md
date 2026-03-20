---
phase: 13-container-strategy
plan: "02"
subsystem: docker
tags: [docker, container, spawn, tdd, session, cli]
dependency_graph:
  requires: [docker/Dockerfile, docker/entrypoint.sh, src/cli/docker/index.ts]
  provides: [spawnClaudeCodeProcess wiring, docker kill fallback, CLI Docker readiness checks]
  affects: [src/orchestrator/claude-code-session.ts, src/cli/commands/run.ts]
tech_stack:
  added: [node:child_process spawn for Docker, execFile docker kill fallback]
  patterns: [spawnClaudeCodeProcess override pattern, try/catch/finally cleanup, always-on Docker mode]
key_files:
  created: []
  modified:
    - src/orchestrator/claude-code-session.ts
    - src/orchestrator/claude-code-session.test.ts
    - src/cli/commands/run.ts
decisions:
  - spawnClaudeCodeProcess built inside try block to catch ANTHROPIC_API_KEY missing error and return failed SessionResult (not throw)
  - execFile mock in tests needs default beforeEach implementation — docker kill in finally block hangs tests without it
  - Docker readiness checks placed before RetryOrchestrator creation; errors propagate naturally to existing try/catch
  - spawn env set to {} — Docker container provides its own environment including ANTHROPIC_API_KEY via -e flag
metrics:
  duration: "8m 7s"
  completed: "2026-03-19"
  tasks: 3
  files: 3
---

# Phase 13 Plan 02: Docker Container Wiring Summary

**One-liner:** Wired Docker container spawning into ClaudeCodeSession via spawnClaudeCodeProcess with docker kill fallback, and added always-on Docker readiness checks to CLI startup.

## Tasks Completed

| Task | Description | Commit | Files |
|------|-------------|--------|-------|
| 1 (TDD RED) | Add failing tests for spawnClaudeCodeProcess and docker kill | 9b0dd38 | src/orchestrator/claude-code-session.test.ts |
| 1 (TDD GREEN) | Implement spawnClaudeCodeProcess + docker kill fallback | 46f9423 | src/orchestrator/claude-code-session.ts, test.ts |
| 2 | Add Docker readiness checks to CLI run command | c06410f | src/cli/commands/run.ts |
| 3 (human-verify) | Verify Docker container runs agent session end-to-end | approved | All Docker pipeline verification checks passed |

## What Was Built

### src/orchestrator/claude-code-session.ts

Added Docker container spawning to ClaudeCodeSession:

1. **Imports:** `spawn`, `execFile` from `node:child_process`; `promisify` from `node:util`; `buildDockerRunArgs` from `../cli/docker/index.js`; `execFileAsync = promisify(execFile)`

2. **ANTHROPIC_API_KEY check** inside the try block — if missing, throws `Error('ANTHROPIC_API_KEY environment variable is required')` which gets caught and returned as `failed` SessionResult

3. **spawnClaudeCodeProcess closure** built inside try block:
   - Calls `buildDockerRunArgs({ workspaceDir, apiKey, sessionId }, sdkOptions.command, sdkOptions.args)`
   - Returns `spawn('docker', dockerArgs, { stdio: ['pipe', 'pipe', 'inherit'], signal: sdkOptions.signal, env: {} })`
   - Container name: `agent-${sessionId}`

4. **query() options** now includes `spawnClaudeCodeProcess` — SDK uses it instead of spawning claude directly

5. **Docker kill fallback** in finally block:
   ```typescript
   try {
     await execFileAsync('docker', ['kill', containerName], { timeout: 5000 });
   } catch {
     // Container may have already exited — ignore errors
   }
   ```

### src/orchestrator/claude-code-session.test.ts

Extended from 20 to 25 tests. New tests (21-25):

- **Test 21:** `query() receives spawnClaudeCodeProcess option` — verifies function is passed in options
- **Test 22:** `spawnClaudeCodeProcess spawns docker with correct args` — extracts fn from options, calls it, verifies spawn('docker', ...) called with correct structure
- **Test 23:** `docker kill called in finally block` — mocks execFile, verifies `docker kill agent-{sessionId}` called
- **Test 24:** `docker kill failure silently caught` — execFile rejects, session still returns success
- **Test 25:** `returns failed when ANTHROPIC_API_KEY not set` — deletes env var, verifies `status: 'failed'` + error message

Mock setup: `vi.mock('node:child_process')`, `vi.mock('../cli/docker/index.js')`, with default `execFile` mock in `beforeEach` resolving immediately (prevents docker kill timeout hanging tests).

### src/cli/commands/run.ts

Added three Docker readiness calls at the top of `runAgent()`, before `RetryOrchestrator` creation:

```typescript
// Docker is always-on — every agent run goes through Docker
await assertDockerRunning();
await ensureNetworkExists();
await buildImageIfNeeded();
```

If Docker is not running, `assertDockerRunning()` throws a descriptive error that propagates to the existing `catch(error)` block, returning exit code 1 with a clear message.

## Verification Results

- `npx vitest run src/orchestrator/claude-code-session.test.ts` — 25/25 tests pass
- `npx tsc --noEmit` — exits 0 (no type errors)
- Full test suite `npx vitest run` — 271/271 tests pass (5 new tests added)

### Human Verification (Task 3 — Approved)

End-to-end Docker container pipeline confirmed working by human:
1. `npm test` — 271/271 tests pass
2. `docker build -t background-agent:latest -f docker/Dockerfile docker/` — success (all layers cached)
3. `docker run --rm --cap-add NET_ADMIN background-agent:latest whoami` — outputs `agent`
4. `docker run --rm --cap-add NET_ADMIN background-agent:latest id` — outputs `uid=1001(agent) gid=1001(agent)`
5. `docker run --rm --cap-add NET_ADMIN background-agent:latest claude --version` — outputs Claude Code CLI version 2.1.79

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Moved ANTHROPIC_API_KEY check inside try block**
- **Found during:** Task 1 TDD GREEN phase
- **Issue:** Plan instructed adding the API key check before the `try` block. However, if the key is missing, the throw propagates as an unhandled exception past the existing catch that maps errors to `SessionResult`. Tests expected `result.status === 'failed'` but the session would throw instead.
- **Fix:** Moved the `const apiKey` check and the `spawnClaudeCodeProcess` closure inside the try block so errors are caught and returned as `failed` SessionResult.
- **Files modified:** src/orchestrator/claude-code-session.ts
- **Commit:** 46f9423

**2. [Rule 2 - Missing functionality] Added default execFile mock in beforeEach**
- **Found during:** Task 1 TDD GREEN phase (tests timing out)
- **Issue:** The docker kill in the finally block calls `execFileAsync` which promisifies `execFile`. Without a mock implementation, the promise never resolves causing all tests to hang for 5 seconds each (21 tests × 5s = 105s timeout).
- **Fix:** Added `mockExecFile.mockImplementation((...args) => { const cb = args[args.length-1]; if (typeof cb === 'function') cb(null, '', ''); })` to `beforeEach`.
- **Files modified:** src/orchestrator/claude-code-session.test.ts
- **Commit:** 46f9423

## Self-Check: PASSED

Files modified:
- src/orchestrator/claude-code-session.ts — FOUND
- src/orchestrator/claude-code-session.test.ts — FOUND
- src/cli/commands/run.ts — FOUND

Commits:
- 9b0dd38 — TDD RED tests
- 46f9423 — TDD GREEN implementation
- c06410f — CLI Docker readiness checks
