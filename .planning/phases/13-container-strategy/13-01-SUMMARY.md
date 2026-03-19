---
phase: 13-container-strategy
plan: "01"
subsystem: docker
tags: [docker, container, iptables, network-isolation, entrypoint, tdd]
dependency_graph:
  requires: []
  provides: [docker/Dockerfile, docker/entrypoint.sh, src/cli/docker/index.ts]
  affects: [src/cli/commands/run.ts, src/orchestrator/claude-code-session.ts]
tech_stack:
  added: [iptables, bind-tools, su-exec, @anthropic-ai/claude-code@2.1.79]
  patterns: [multi-stage Dockerfile, entrypoint privilege drop, docker helper module]
key_files:
  created:
    - docker/entrypoint.sh
    - src/cli/docker/index.ts
    - src/cli/docker/index.test.ts
  modified:
    - docker/Dockerfile
decisions:
  - Mock callback extraction must handle both 3-arg execFile(cmd, args, cb) and 4-arg execFile(cmd, args, opts, cb) call signatures — promisify drops opts arg when not provided
  - execFileAsync calls for network create/inspect consistently pass empty opts ({}) to normalize mock behavior
metrics:
  duration: "17m 29s"
  completed: "2026-03-19"
  tasks: 2
  files: 4
---

# Phase 13 Plan 01: Docker Container Infrastructure Summary

**One-liner:** Multi-stage Alpine Dockerfile with Claude Code CLI 2.1.79, iptables network isolation entrypoint via su-exec privilege drop, and tested TypeScript helper module for Docker operations.

## Tasks Completed

| Task | Description | Commit | Files |
|------|-------------|--------|-------|
| 1 | Rewrite Dockerfile and create entrypoint.sh | b068e08 | docker/Dockerfile, docker/entrypoint.sh |
| 2 (TDD RED) | Add failing tests for docker helper module | f6b40dd | src/cli/docker/index.test.ts |
| 2 (TDD GREEN) | Implement docker helper module — all tests pass | da3cb0b | src/cli/docker/index.ts, src/cli/docker/index.test.ts |

## What Was Built

### docker/Dockerfile

Multi-stage Alpine image replacing the previous `CMD ["sleep", "infinity"]` placeholder:

- **Stage 1 (nodejs-base):** node:20-alpine + bash, git, ca-certificates, ripgrep, iptables, bind-tools, su-exec
- **Stage 2 (multi-runtime):** nodejs-base + openjdk17-jre-headless, maven
- **Stage 3 (agent):** multi-runtime + `npm install -g @anthropic-ai/claude-code@2.1.79` + agent user (UID 1001) + ENTRYPOINT

Key decisions from the plan:
- No `USER agent` — entrypoint runs as root, drops via su-exec
- No `CMD` — SDK passes claude command as args
- Claude Code CLI pinned at 2.1.79 for reproducibility

### docker/entrypoint.sh

Bash script that runs as root to set iptables rules before dropping to UID 1001:

1. Resolves `api.anthropic.com` IPs via `dig` with 3-retry loop (handles DNS timing)
2. Allows loopback, ESTABLISHED/RELATED connections, DNS (UDP+TCP 53)
3. If IPs resolved: allows TCP 443 to those IPs only, blocks everything else
4. If DNS failed: fallback to allow all TCP 443 with warning, then DROP
5. `exec su-exec agent "$@"` drops privileges and executes the SDK-provided command

### src/cli/docker/index.ts

TypeScript helper module exporting 4 functions:

- **`assertDockerRunning()`** — calls `docker info` with 5s timeout; throws descriptive error if Docker isn't running
- **`ensureNetworkExists(networkName?)`** — inspects `agent-net`; creates if not found; zero manual setup
- **`buildImageIfNeeded(imageTag?)`** — inspects image; builds from `docker/Dockerfile` if absent (10min timeout)
- **`buildDockerRunArgs(opts, sdkCommand, sdkArgs)`** — constructs full `docker run` arg array with security hardening: `--rm --interactive --name agent-{sessionId} --network agent-net --cap-drop ALL --cap-add NET_ADMIN --security-opt no-new-privileges --pids-limit 200 -e ANTHROPIC_API_KEY -v workspace:/workspace:rw`

## Verification Results

- `docker build -t background-agent:test -f docker/Dockerfile docker/` — exits 0
- `docker run --rm --cap-add NET_ADMIN background-agent:test whoami` — outputs `agent`
- `npm test -- src/cli/docker/index.test.ts` — 12/12 tests pass
- Full test suite — 266/266 tests pass

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed execFile mock callback extraction for variable argument counts**
- **Found during:** Task 2 TDD GREEN phase
- **Issue:** `promisify(execFile)` omits the `options` argument when not provided, calling `execFile(cmd, args, callback)` with 3 args instead of 4. Mock helpers expected 4-arg form and treated the callback as `_opts`, leaving the promise permanently pending — causing the exception to propagate to the `catch` block and triggering a second `docker build` call.
- **Fix:** Replaced fixed-arity mock functions with variadic `(...args: unknown[])` and `extractCallback(args)` helper that extracts the last argument regardless of whether opts were passed.
- **Files modified:** src/cli/docker/index.test.ts
- **Commit:** da3cb0b (same as GREEN commit)

**2. [Rule 2 - Missing functionality] Added consistent empty opts to execFileAsync calls without options**
- **Found during:** Task 2 TDD GREEN phase
- **Issue:** `ensureNetworkExists` called `execFileAsync('docker', ['network', 'create', networkName])` without opts, which is valid but inconsistent with mock expectations.
- **Fix:** Added `{}` as opts arg to all `execFileAsync` calls that didn't need specific options, normalizing the call pattern.
- **Files modified:** src/cli/docker/index.ts
- **Commit:** da3cb0b

## Self-Check: PASSED

Files created/modified:
- docker/Dockerfile — FOUND
- docker/entrypoint.sh — FOUND
- src/cli/docker/index.ts — FOUND
- src/cli/docker/index.test.ts — FOUND

Commits:
- b068e08 — FOUND (Task 1: Dockerfile + entrypoint.sh)
- f6b40dd — FOUND (Task 2 RED: failing tests)
- da3cb0b — FOUND (Task 2 GREEN: implementation)
