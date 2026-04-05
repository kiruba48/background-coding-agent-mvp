# Project Research Summary

**Project:** background-coding-agent v2.4
**Domain:** Git worktree isolation for concurrent agent execution + read-only repo exploration tasks
**Researched:** 2026-04-05
**Confidence:** HIGH

## Executive Summary

This milestone (v2.4) adds two independent capability tracks to an already-operational Node.js/TypeScript background coding agent: git worktree isolation to enable safe concurrent agent runs, and read-only repo exploration tasks that return structured reports instead of code changes. Both tracks build on the existing architecture — `workspaceDir` threading, `RetryOrchestrator`, `ClaudeCodeSession`, Docker isolation — with minimal invasive changes. No new npm dependencies are required; `simple-git`'s `.raw()` method handles all worktree operations, and the existing `node:` stdlib covers path management.

The recommended approach is to deliver in three sequential phases: tech debt cleanup first (isolated from feature work to prevent regression entanglement), then git worktree infrastructure (the foundational isolation seam), then exploration tasks (which depend on the `readOnly` Docker mount pattern established in phase 2 but are otherwise independent of worktrees). The two feature areas share almost no code — worktrees are a write-isolation concern, exploration tasks are a read-only routing concern. They intersect only at `runAgent()`: worktrees are skipped for exploration tasks, and exploration tasks use a `:ro` Docker mount that code-change tasks never use.

The key risks are: (1) orphaned worktrees after host process crashes — requires a startup-scan cleanup with PID sentinel files before shipping, never ship worktree creation without the orphan recovery path; (2) exploration agents writing files despite read-only intent — must be enforced at the `PreToolUse` hook level, not by prompt alone; (3) mixing tech debt fixes with feature code in the same commits, which makes regressions untraceable. All three risks have clear mitigations and are well-understood patterns in the ecosystem.

---

## Key Findings

### Recommended Stack

The v2.4 stack is the v2.3 stack with zero new production dependencies. The entire feature set is implemented with already-installed packages. `simple-git@3.32.3` (installed) handles all git worktree operations via its `.raw()` method — confirmed against TypeScript typings (no `.worktree()` method exists) and verified by live runtime test. This is consistent with how `pr-creator.ts` already uses `.raw(['merge-base', ...])` and `.raw(['cherry-pick', ...])`. The existing Docker Alpine image already contains `git`, `bash`, and `ripgrep` — no new image layers needed. The `node:path`, `node:fs/promises`, and `node:os` stdlib modules cover all path construction and cleanup needs. All v2.4 changes are pure TypeScript against existing modules plus three new files.

**Core technologies:**
- `simple-git@3.32.3` via `.raw(['worktree', ...])`: all worktree lifecycle operations — already installed, `.raw()` is the established pattern in this codebase
- `node:child_process.execFile`: already used in 6 files; no changes needed for worktree work
- `node:path` / `node:fs/promises` / `node:crypto`: worktree sibling directory path construction and UUID generation — Node 20 stdlib, zero overhead
- TypeScript changes only: new `src/orchestrator/worktree.ts`, `src/prompts/investigation.ts`, additive flags on existing interfaces

**Version compatibility:** `simple-git` can optionally be updated from 3.32.3 to 3.33.0 (latest as of 2026-04-05); patch bump is safe. No other version changes required.

### Expected Features

**Must have (table stakes — P1 for v2.4):**
- Worktree lifecycle manager (`createWorktree`, `removeWorktree`, `pruneWorktrees`) — foundational isolation primitive; all concurrent-run safety depends on this
- Docker mount uses worktree path, not main repo path — the single most load-bearing change; without it, isolation is illusory
- Worktree cleanup in `finally` block — orphaned worktrees on failure/cancellation are unacceptable in production
- Sibling directory naming with UUID suffix — prevents branch name collisions for concurrent sessions on the same repo
- `investigation` task type in intent parser — exploration tasks unreachable without this
- `buildInvestigationPrompt()` with subtype routing — structured prompt per exploration subtype (git-strategy, ci-checks, project-structure)
- Report output path in `runAgent()` — bypass verifier + PR, return `finalResponse`; display via adapter
- Tech debt: exit code switch with explicit `vetoed`/`turn_limit`/`cancelled` cases — removes misleading `failed` status

**Should have (P2 — add after validation):**
- SIGINT cleanup handler — prune known worktrees on process exit; add when orphaned worktrees are observed in real usage
- Worktree branch name shown at confirm step — add when users report inability to predict branch names

**Defer (v2.5+):**
- Exploration subtype: security scan (needs vulnerability data source)
- Exploration results stored in session history for follow-up referencing
- Parallel agent execution orchestration (worktree isolation is the prerequisite; queuing/status display is the follow-on)

**Anti-features to avoid:**
- Shared worktree across multi-turn REPL tasks — breaks one-container-per-task isolation invariant (explicitly out-of-scope in PROJECT.md)
- Exploration tasks that write code as a side-effect — mixing read/write breaks the scope contract and the verifier's diff criterion
- Worktrees stored inside the repo directory — `git worktree add` rejects paths inside the repo; sibling is the correct convention

### Architecture Approach

v2.4 threads two routing branches through `runAgent()` using `workspaceDir` as the single isolation seam. All downstream components (`ClaudeCodeSession` Docker mount, `compositeVerifier`, `llmJudge`, `captureBaselineSha`, `GitHubPRCreator`) already accept `workspaceDir` as a parameter and are path-agnostic — changing what path it points to (main repo vs. worktree) changes isolation behavior without touching any downstream code. The `RetryOrchestrator` is extended via a `skipVerification?: boolean` flag on `RetryConfig`, following the established capability-gating pattern. Three new files, eleven modified files (all additive changes), fifteen files entirely unchanged.

**Major components:**

1. `WorktreeManager` (`src/orchestrator/worktree.ts` — NEW) — lifecycle for worktree create/remove/prune; host-side git operations only; called from `runAgent()` with `finally` cleanup guarantee
2. `buildInvestigationPrompt()` (`src/prompts/investigation.ts` — NEW) — read-only analysis prompt with explicit file-write prohibition; routes through existing `buildPrompt()` dispatcher
3. `runAgent()` (`src/agent/index.ts` — MODIFIED, ~30 lines) — conditional worktree creation for non-investigation tasks; passes worktree path as `workspaceDir`; sets `readOnly: true` and `skipVerification: true` for investigation tasks
4. `buildDockerRunArgs()` (`src/cli/docker/index.ts` — MODIFIED, ~5 lines) — new `readOnly?: boolean` in `DockerRunOptions`; `:ro` vs `:rw` mount based on flag
5. `RetryOrchestrator` (`src/orchestrator/retry.ts` — MODIFIED, ~10 lines) — short-circuit verification when `skipVerification: true`

**Unchanged:** `ClaudeCodeSession` (receives updated `workspaceDir`), `compositeVerifier`, `llmJudge`, all REPL/Slack/processInput infrastructure

### Critical Pitfalls

1. **Worktree not removed on host process crash (SIGKILL / OOM / terminal close)** — `finally` block does not run on SIGKILL. Mitigation: implement startup-scan orphan cleanup using a PID sentinel file (`.bg-agent-pid`) in each worktree directory; `process.kill(pid, 0)` distinguishes live sessions from orphans. Also run `git worktree prune` on each `runAgent()` invocation. Confirmed real-world failure mode in claude-code issue #26725 (12 orphan branches, 7 nested worktrees from a single session).

2. **Docker bind mount points to main repo instead of worktree path** — If `SessionConfig.workspaceDir` is not updated to the worktree directory before container start, the agent edits the main branch while the worktree branch sits empty. Mitigation: create worktree first, then construct `SessionConfig` with `workspaceDir = worktreeInfo.worktreeDir`. Verify with integration test: agent commits appear on worktree branch; main branch HEAD is unchanged.

3. **Exploration agent writes files despite "read-only" intent** — The prompt saying "do not write files" is insufficient; the Claude Agent SDK exposes Write/Edit tools by default. The agent may write a report `.md` file, which the LLM Judge approves as "useful output." Mitigation: `PreToolUse` hook blocks `Write`, `Edit`, `MultiEdit`, and write-capable `Bash` patterns when `readOnly: true`. OWASP MCP Top 10 (2025) MCP02 identifies this as the second most critical MCP risk pattern.

4. **Branch name collision between concurrent sessions** — Deterministic branch names from task type alone (e.g., always `bg-agent-npm-update`) guarantee collision on the second concurrent session for the same repo. Mitigation: use `{task-type-prefix}-{8-hex-uuid}` for all worktree branch names. UUID generated with `crypto.randomBytes(4).toString('hex')`.

5. **Tech debt fixes mixed with feature code cause untraceable regressions** — The `configOnly` bypass fix in `retry.ts` is a logic change in a production-critical path. Intermixed with worktree work, a regression is hard to bisect. Mitigation: dedicated Phase 1 with only debt fixes, each fix preceded by a failing test. Full 696-test suite must pass before Phase 2 begins.

---

## Implications for Roadmap

The build order is unambiguous. Three phases with clear dependency rationale:

### Phase 1: Tech Debt Cleanup

**Rationale:** Tech debt items touch the same files (`retry.ts`, `src/cli/output.ts`) that worktree integration also modifies. Fixing debt first establishes a clean, verified baseline where any regression introduced by Phase 2 or Phase 3 work is immediately attributable. PITFALLS.md explicitly warns: "never ship debt fixes and feature code in the same PR — regressions become untraceable." The configOnly bypass fix in `retry.ts` is a logic change in the same function Phase 2 modifies for `skipVerification`; doing it first means Phase 2's diff is unambiguously feature-only.

**Delivers:** Clean codebase, full 696-test baseline passing, explicit exit code cases for `vetoed`/`turn_limit`/`cancelled`, dead code removed (`SessionTimeoutError`, Slack dead code), `retry.ts` configOnly verifier bypass corrected, cancelled tasks recorded as `cancelled` not `failed`

**Addresses:** Exit code switch (FEATURES.md tech debt items), dead code removal, Slack multi-turn history population

**Avoids:** Pitfall 6 (regression in verification pipeline masking from mixed commits)

**Research flag:** No deeper research needed — these are enumerated items in PROJECT.md Known Tech Debt list. Execute only.

### Phase 2: Git Worktree Isolation

**Rationale:** `WorktreeManager` establishes `workspaceDir` as the isolation seam — the architectural pattern that Phase 3's read-only Docker mount also relies on. Building worktrees second establishes `sessionId` threading through `SessionConfig`, which provides consistent log correlation for all subsequent task types. The `readOnly` Docker mount flag can be introduced here as infrastructure (alongside the worktree-path change to `buildDockerRunArgs`) so Phase 3 has no Docker layer changes to make.

**Delivers:** `WorktreeManager` (create/remove/prune with PID sentinel for orphan detection), `workspaceDir` updated to worktree path in `runAgent()`, `finally`-block cleanup, UUID-suffix branch names, `sessionId` threading on `SessionConfig`, startup orphan scan, `readOnly?: boolean` flag on `DockerRunOptions` and `SessionConfig`, concurrent-safe agent runs

**Uses:** `simple-git.raw(['worktree', ...])`, `crypto.randomBytes(4)`, existing `AgentOptions` extension pattern

**Implements:** `WorktreeManager`, modified `runAgent()`, modified `SessionConfig`/`RetryConfig`/`types.ts`, modified `buildDockerRunArgs`

**Avoids:** Pitfalls 1, 2, 3, 5 (orphan cleanup, mount path correctness, branch collision, stale index lock)

**Research flag:** No deeper research needed — integration points fully mapped in ARCHITECTURE.md against live source. Critical verification: integration test confirming agent commits appear on worktree branch and main HEAD unchanged after each run.

### Phase 3: Repo Exploration Tasks

**Rationale:** Exploration depends on the `readOnly` Docker mount flag (established in Phase 2), `skipVerification` in `RetryConfig` (additive to Phase 2's types), and the `investigation` task type in the intent layer. None of these depend on worktrees — exploration tasks explicitly do not create worktrees. Phase 3 is cleanly independent after Phase 2 establishes the shared infrastructure. If scope must be cut, Phase 2 delivers standalone value (concurrent runs) without Phase 3.

**Delivers:** `investigation` task type in intent parser + LLM schema with verb examples, `buildInvestigationPrompt()` with 3 subtypes (git-strategy, ci-checks, project-structure), `skipVerification: true` + `maxRetries: 1` routing for investigation tasks, `finalResponse` display path in REPL and Slack adapters, `PreToolUse` write-blocking enforcement for `readOnly: true` sessions

**Implements:** `src/prompts/investigation.ts`, modified `llm-parser.ts`, modified `RetryOrchestrator` skip path, modified REPL + Slack adapters for report display

**Avoids:** Pitfall 4 (exploration agent writes files — `PreToolUse` enforcement required before any prompt work); `zero_diff` displayed as failure for exploration tasks (result rendering checks `taskType === 'investigation'` before interpreting `finalStatus`)

**Research flag:** No deeper research needed for core routing infrastructure. The three exploration subtype prompts (git-strategy, ci-checks, project-structure) will benefit from prompt engineering iteration against real repos — treat initial implementations as v1 with expectation of tuning.

### Phase Ordering Rationale

- **Debt first:** Prevents regression entanglement. The `retry.ts` `configOnly` fix is in the same function that Phase 2 modifies for `skipVerification`. Doing debt first means Phase 2's diff is unambiguously feature-only. Full test suite must pass as the gate between Phase 1 and Phase 2.
- **Worktrees before exploration:** Phase 2 establishes the `workspaceDir`-as-seam pattern, the `sessionId` threading, and the `readOnly` Docker flag. Phase 3 adds a parallel routing branch through `runAgent()` — reading Phase 2's code makes the exploration routing straightforward to implement.
- **Exploration last:** It is the most self-contained addition. If Phase 3 slips, Phase 2 delivers standalone value. If Phase 3 is accelerated, it has no blockers once Phase 2's Docker flag is in place.
- **Both features are independent after Phase 1:** Phase 2 and Phase 3 can be delivered as separate milestones if scope is cut. Neither blocks the other.

### Research Flags

Phases with standard, well-documented patterns (no `/gsd:research-phase` needed):
- **Phase 1 (Tech Debt):** All items enumerated in PROJECT.md Known Tech Debt. No research needed — execution only.
- **Phase 2 (Worktrees):** Integration points fully mapped in ARCHITECTURE.md against live source. `simple-git.raw()` worktree operations verified by runtime test. Official git docs are authoritative.
- **Phase 3 (Exploration):** Core routing and Docker flag changes fully specified. Prompt subtype schemas are well-understood.

Phases that may benefit from light research during execution:
- **Phase 2 — PID sentinel file placement:** The sentinel-file-with-PID orphan detection pattern is documented but the exact hook point (module init vs. first `runAgent()` call) should be confirmed against the REPL startup sequence before implementation.
- **Phase 3 — Exploration subtype prompt quality:** The three subtype prompts need prompt engineering iteration. The routing is specified; the output quality emerges from testing against real repos.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Live codebase inspection: `simple-git` typings checked, `.raw()` runtime-verified, Docker image confirmed, npm registry checked. No inference — all findings are from primary sources. |
| Features | HIGH | Worktree mechanics from official git docs; ecosystem patterns from multiple MEDIUM-confidence sources agree. Exploration subtypes from GitHub Blog canonical reference. Anti-features from PROJECT.md explicit constraints. |
| Architecture | HIGH | First-party codebase analysis. Every integration point (`workspaceDir` threading, `DockerRunOptions`, `RetryConfig`, `SessionConfig`) verified against live source. Component boundary map is authoritative. |
| Pitfalls | HIGH | Pitfalls 1 and 5 confirmed by first-party claude-code issue tracker (#26725, #11005). Pitfall 4 confirmed by OWASP MCP Top 10 (2025). Pitfalls 2, 3, 6 confirmed by direct code analysis. No significant gaps. |

**Overall confidence: HIGH**

### Gaps to Address

- **PID sentinel file startup scan placement:** The startup-scan orphan cleanup requires knowing when `runAgent()` is first called per process. The exact hook point (module init vs. first `runAgent()` call) needs to be confirmed against the REPL startup sequence in `src/cli/commands/repl.ts` during Phase 2 implementation. Low risk — the pattern is clear, just needs placement.

- **`zero_diff` handling for exploration tasks:** PITFALLS.md and ARCHITECTURE.md agree that `zero_diff` result code should not surface as "failure" for exploration tasks. FEATURES.md suggests `exploration_complete` as a new `finalStatus`; ARCHITECTURE.md says `finalResponse` as success criterion is sufficient. Resolution: use task-type-aware result rendering in the REPL adapter (check `intent.taskType === 'investigation'` before interpreting `finalStatus`). Decide in Phase 3 implementation.

- **Worktree branch lifecycle after PR creation:** The worktree branch (`agent/{sessionId}`) is created by `WorktreeManager`. `GitHubPRCreator` pushes that branch to the remote for the PR. If `WorktreeManager.remove()` deletes the local branch before the PR is created, the push fails. Resolution: the local worktree branch must not be deleted until after `GitHubPRCreator` completes. Clarify exact call sequence in Phase 2 implementation against the `runAgent()` finally block ordering.

---

## Sources

### Primary (HIGH confidence)
- `node_modules/simple-git/typings/simple-git.d.ts` — no `.worktree()` method; `.raw()` is the only interface
- `src/orchestrator/pr-creator.ts` lines 362, 460 — `.raw(['merge-base', ...])`, `.raw(['cherry-pick', ...])` establish `.raw()` as the project's pattern
- `src/cli/docker/index.ts` — `buildDockerRunArgs`, `-v workspaceDir:/workspace:rw` mount
- `src/agent/index.ts` — `runAgent()` entry point, `workspaceDir` threading
- `src/orchestrator/retry.ts` — `RetryConfig`, `RetryOrchestrator.run()`, `resetWorkspace()` pattern
- `src/types.ts` — `SessionConfig`, `RetryResult`, `SessionResult.finalResponse`
- `src/intent/types.ts` — `TASK_TYPES`, `TASK_CATEGORIES`
- `.planning/PROJECT.md` — v2.4 milestone spec, Key Decisions, Known Tech Debt
- [git-worktree official docs](https://git-scm.com/docs/git-worktree) — `add`, `list`, `remove`, `prune`, `lock`, `repair`
- [anthropics/claude-code issue #26725](https://github.com/anthropics/claude-code/issues/26725) — orphaned worktrees/branches failure mode confirmed
- [anthropics/claude-code issue #11005](https://github.com/anthropics/claude-code/issues/11005) — stale index.lock blocking git ops confirmed
- [OWASP MCP Top 10 MCP02:2025](https://owasp.org/www-project-mcp-top-10/2025/MCP02-2025%E2%80%93Privilege-Escalation-via-Scope-Creep) — scope creep / privilege escalation in read-only agents
- [Docker bind mounts official docs](https://docs.docker.com/engine/storage/bind-mounts/) — `:ro` mount behavior

### Secondary (MEDIUM confidence)
- [Upsun: Git Worktrees for Parallel AI Agents](https://devcenter.upsun.com/posts/git-worktrees-for-parallel-ai-coding-agents/) — sibling directory convention, Docker volume interaction, same-filesystem requirement
- [BSWEN: Worktree Isolation in AI Agents](https://docs.bswen.com/blog/2026-03-18-ai-agent-worktree-isolation/) — one-task-one-worktree-one-agent pattern
- [Nick Mitchinson: Git Worktrees for Multi-Feature AI Dev](https://www.nrmitchi.com/2025/10/using-git-worktrees-for-multi-feature-development-with-ai-agents/) — branch-per-task, naming conventions
- [Penligent: Git Worktrees Need Runtime Isolation](https://www.penligent.ai/hackinglabs/git-worktrees-need-runtime-isolation-for-parallel-ai-agent-development/) — shared `.git` pitfall, silent fallback failure mode
- [Jon Roosevelt: Git Worktrees Ate My Edits](https://jonroosevelt.com/blog/git-worktrees-broke-dedicated-machines-fixed-it) — worktree error causing main checkout fallback
- [GitHub Blog: Automate Repo Tasks with Agentic Workflows](https://github.blog/ai-and-ml/automate-repository-tasks-with-github-agentic-workflows/) — canonical exploration subtypes
- [Termdock: Worktree Conflicts with AI Agents](https://www.termdock.com/en/blog/git-worktree-conflicts-ai-agents) — build cache contamination, index lock deadlocks
- `project_repo_exploration_tasks.md` (project memory) — read-only investigative tasks returning reports as prior project decision

---
*Research completed: 2026-04-05*
*Ready for roadmap: yes*
