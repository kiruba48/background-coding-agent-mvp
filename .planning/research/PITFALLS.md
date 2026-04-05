# Pitfalls Research

**Domain:** v2.4 — Adding git worktree isolation for concurrent agent runs, read-only repo exploration tasks, and tech debt cleanup to an existing background coding agent
**Researched:** 2026-04-05
**Confidence:** HIGH (first-party codebase analysis + verified against git documentation + Claude Code issue tracker real-world failure modes)

---

## Critical Pitfalls

Mistakes that break the isolation contract, leave the repository in a corrupt or unrecoverable state, or require rewriting infrastructure that other features depend on.

---

### Pitfall 1: Worktree Not Removed on Agent Crash or Signal Kill

**What goes wrong:**
The agent runs in Docker. The host process managing the session (`RetryOrchestrator`, `runAgent()`) creates a worktree via `git worktree add` before launching the container, then removes it afterward via `git worktree remove`. If Docker crashes, the host process is SIGKILL'd, or the user hard-kills the terminal (not SIGINT but terminal close), the `finally` block does not run. The worktree directory and its `.git/worktrees/<name>/` metadata remain. On the next run using the same branch name, `git worktree add` fails with `fatal: '<branch>' is already checked out at '<path>'`.

This failure mode is confirmed in the wild by [Anthropics/claude-code issue #26725](https://github.com/anthropics/claude-code/issues/26725): 12 orphan branches and 7 nested worktrees were left after a single session with 6 agents, none cleaned up after agent completion.

**Why it happens:**
`try/finally` protects against application-level exceptions but not against process-level termination (SIGKILL, OOM kill, terminal close). There is no cleanup agent for the host-side file system state. The worktree directory is a sibling of the repo dir, outside the Docker container, and Docker has no mechanism to clean it up.

**How to avoid:**
Two-layer protection:
1. **Host-side cleanup on session start:** When `runAgent()` initializes, scan for stale worktrees belonging to previous sessions for this repo (e.g., prefix `bg-agent-*` or `bg-agent-<taskHash>-*`). Remove any whose branch has been deleted or whose directory exists but no session is running. Use `git worktree prune` to clean `.git/worktrees/` metadata for directories that no longer exist.
2. **Sentinel file with PID:** Before creating the worktree, write a sentinel file (`.bg-agent-pid`) in the worktree directory containing the host PID. On startup scan, check if that PID is alive (`process.kill(pid, 0)`). If not alive and worktree exists, remove it. This distinguishes genuinely-running sessions from orphans without requiring a central registry.

**Warning signs:**
- `git worktree add` in tests sometimes fails with "already checked out" without a prior test leaving a worktree
- Worktree directory from a previous run exists on disk after a test suite crash
- `git worktree list` shows more entries than active sessions after restarts

**Phase to address:** Git worktree isolation phase, first thing — the cleanup-on-startup scan must be implemented in the same commit as worktree creation. Never ship creation without cleanup.

---

### Pitfall 2: Worktree Branch Name Collides Between Concurrent Sessions

**What goes wrong:**
Two concurrent agent sessions for the same repo attempt to create worktrees with the same branch name. Session A calls `git worktree add ../repo-bg-agent-update-lodash bg-agent-update-lodash`. Session B does the same 200ms later with an identical task. Git refuses the second `add` with `fatal: '<branch>' is already checked out`. Session B fails to start and surfaces a confusing error to the user instead of running.

A worse variant: the auto-generated branch name is deterministic from task type only (e.g., always `bg-agent-npm-update`). Every npm update task for the same repo tries to create the same branch. Any second concurrent run fails immediately.

**Why it happens:**
Branch name generation does not account for session uniqueness. The current `GitHubPRCreator` generates branch names from task type + timestamp, but that logic lives inside the PR creator and is not available to the worktree setup code. If worktree setup uses a simpler naming scheme (just task type), collisions are guaranteed.

**How to avoid:**
Generate worktree branch names using a combination of: task type prefix + short UUID (8 hex chars from `crypto.randomBytes(4).toString('hex')`). Example: `bg-agent-npm-a3f2b1c9`. This guarantees uniqueness across concurrent sessions for the same repo. Store the generated branch name on `AgentOptions` or thread it through `SessionConfig` so the same name is used for the worktree directory, the branch, and eventually the PR branch. Do not reuse the PR branch name for the worktree branch — worktrees use ephemeral branches that are deleted after the session; PRs use persistent branches.

**Warning signs:**
- Branch name generation for worktrees is deterministic from task type alone (no random component)
- Two concurrent npm update tasks fail, with the second one reporting "already checked out"
- Integration tests that run two concurrent sessions against the same fixture repo produce intermittent failures

**Phase to address:** Git worktree isolation phase — branch name generation policy must be decided before writing any `git worktree add` calls.

---

### Pitfall 3: Docker Bind Mount Points to Main Worktree, Not the Session Worktree

**What goes wrong:**
The existing `SessionConfig.workspaceDir` is the absolute path of the repo (e.g., `/Users/kiruba/repos/my-app`). Docker is started with `-v ${workspaceDir}:/workspace:rw`. When worktrees are added, the agent session should run inside the new worktree directory (`/Users/kiruba/repos/my-app-bg-agent-a3f2b1c9`), not the main repo. If the bind mount path is not updated to point to the worktree directory, the agent edits the main worktree while the worktree branch is elsewhere, producing either no changes or changes on the wrong branch.

A related failure: the worktree directory contains a `.git` file (not directory) that points to `../my-app/.git/worktrees/<name>`. Docker mounts the worktree directory but the git metadata resolves via this relative path. If the container's user (UID 1001) cannot follow the `.git` file's relative path resolution to the host `.git` directory (permissions differ), all git operations inside the container fail with "not a git repository."

**Why it happens:**
`workspaceDir` is set once at `runAgent()` call time and threaded through to `ClaudeCodeSession` and the Docker container setup. Introducing worktrees requires updating `workspaceDir` to the worktree path before the container is started. It is easy to miss this because `workspaceDir` looks like a simple path string, not a Docker mount configuration. The `.git` file resolution issue is documented in Docker-for-Windows but also affects Linux when UID mismatch prevents cross-directory stat.

**How to avoid:**
When worktree isolation is active: create the worktree first, then set `workspaceDir` to the worktree's absolute path before constructing `SessionConfig`. The worktree path — not the main repo path — is passed to `ClaudeCodeSession` as the container bind mount. Verify this with an integration test: after the agent runs, confirm `git log --oneline -1` in the worktree shows a commit, and `git log --oneline -1` in the main repo is unchanged. For the `.git` file resolution: mount the worktree directory as the workspace AND also mount the main `.git` directory read-only (`-v ${repoRoot}/.git:/workspace-git:ro`) and set `GIT_DIR=/workspace-git/worktrees/<name>` inside the container, or use the worktree's resolved absolute paths.

**Warning signs:**
- Agent runs successfully but `git diff` on the worktree shows no changes
- Changes appear in the main worktree (`main` branch) instead of the agent's branch
- `git status` inside the container says "not a git repository"
- The Claude Agent SDK's built-in git tools fail inside the container with path errors

**Phase to address:** Git worktree isolation phase — the bind mount path change is the most security-critical correctness requirement. Must be verified by integration test before any other worktree work.

---

### Pitfall 4: Repo Exploration Agent Writes Files Despite "Read-Only" Intent

**What goes wrong:**
The repo exploration task is described as "read-only investigative mode returning reports." But the Claude Agent SDK has Write, Edit, and Bash tools available by default. The agent, when asked to "analyze the CI pipeline configuration," might write a `ci-analysis.md` file to the repo, run `npm install` to check dependencies, or create temporary files during investigation. The verification pipeline (which runs after the session) sees a non-empty diff, routes it through the LLM Judge, and the judge approves "this looks like useful documentation." A report file gets committed to the user's repo without their explicit consent.

This is not a hypothetical: OWASP MCP Top 10 (2025) identifies "Privilege Escalation via Scope Creep" as the second most critical MCP risk — an agent granted read permissions accumulates write behavior over time.

**Why it happens:**
The system does not distinguish between exploration tasks and code-change tasks at the tool-permission level. The existing `PreToolUse` hook in `ClaudeCodeSession` performs security checks (disallowed commands) but does not enforce read-only mode for specific task types. The prompt says "analyze and report" but the SDK still exposes Write/Edit tools. The agent model, when generating a report, naturally reaches for Write to "save" the report.

**How to avoid:**
For exploration tasks: pass an explicit `readOnly: true` flag in `SessionConfig`. In the `PreToolUse` hook, if `readOnly` is set, block any tool call with a write side-effect: `Write`, `Edit`, `MultiEdit`, and any `Bash` command containing `>`, `>>`, `tee`, or known file-write patterns. Return a `BLOCK` result with a message: "This is a read-only exploration session. Return your findings as text in your response." Additionally, skip the diff check and verifier entirely for exploration sessions — the success criterion is the agent's `finalResponse`, not a git diff. The `zero_diff` result is the expected outcome for exploration tasks.

**Warning signs:**
- An exploration task produces a non-zero diff (any diff from an exploration task is suspicious)
- The Claude Agent SDK's Write tool is invoked during a "generate report" session
- The judge approves a diff that contains `.md` files created by the agent (documentation scope creep)

**Phase to address:** Repo exploration tasks phase — the `readOnly` tool enforcement must be implemented before any exploration prompts are written. Do not rely on the prompt alone to prevent writes.

---

### Pitfall 5: Worktree Stale Index Lock Blocks Concurrent Git Operations on Shared `.git`

**What goes wrong:**
Git creates `.git/index.lock` (for the main worktree) and `.git/worktrees/<name>/index.lock` (for linked worktrees) during write operations. If `ClaudeCodeSession` runs concurrent git operations inside multiple containers — each on their own worktree — they share the underlying `.git` object database. Pack operations, `git gc`, or index refresh operations that touch the shared `.git/objects/` directory can create lock contention across worktrees.

More practically: the existing `captureBaselineSha()` and `getWorkspaceDiff()` calls in `retry.ts` run `git diff` and `git log` commands on the host. If these run simultaneously with the agent's git operations inside Docker (which runs in the same worktree), the two processes can conflict on the index lock. The agent's container writes to the worktree index; the host reads from it. On some filesystems (NFS, some macOS APFS volumes under Docker Desktop), this can result in stale locks.

This is confirmed as a real issue in [Anthropics/claude-code issue #11005](https://github.com/anthropics/claude-code/issues/11005): stale `.git/index.lock` files created by background git operations block user git commands for 20+ seconds.

**Why it happens:**
The host-side `RetryOrchestrator` runs git commands against `workspaceDir` while the agent is running inside Docker. With a single worktree, this is the same directory. With multiple concurrent worktrees, the host-side commands and container-side commands both write to index lock files, and a crash in either leaves a stale lock.

**How to avoid:**
Host-side git commands (`captureBaselineSha`, `getWorkspaceDiff`, `getChangedFilesFromBaseline`) should use `--no-optional-locks` flag where applicable (e.g., `git diff --no-optional-locks`) and should never run concurrently with the agent session — only before `session.start()` and after `session.stop()`. For `git status` polling, never poll during the session; capture baseline before and diff after. Implement a stale lock cleanup helper: before each host-side git command, check if `.git/index.lock` (or the worktree-specific lock) exists with no holding process, and remove it after a safety delay (5+ seconds since last modification time).

**Warning signs:**
- `git diff` called from `RetryOrchestrator` occasionally fails with "Another git process seems to be running"
- Tests with concurrent sessions occasionally produce lock errors
- `captureBaselineSha()` or `getWorkspaceDiff()` timing out in integration tests

**Phase to address:** Git worktree isolation phase — the timing of host-side git commands relative to container execution must be explicitly documented and enforced in `RetryOrchestrator`.

---

### Pitfall 6: Tech Debt Cleanup Introduces Regressions in the Verification Pipeline

**What goes wrong:**
The existing tech debt list includes: exit code switch missing explicit `vetoed`/`turn_limit` cases, `SessionTimeoutError` dead code, cancelled tasks recorded as `failed` in session history, and `retry.ts` `configOnly` path bypassing `retryConfig.verifier`. These items are in production-critical paths. Fixing them in the same milestone as git worktree and exploration features means regressions in the verification pipeline can be masked by the new feature tests. A CI suite that passes does not confirm the existing 696 tests still cover the fixed paths — new tests may cover new features while old edge cases are accidentally broken.

The specific risk: fixing the `configOnly` bypass (`retry.ts` bypasses `retryConfig.verifier` for config-only changes) is a logic change in `RetryOrchestrator.run()`. Any mistake here could skip verification for all config-only tasks silently — the code path that was previously buggy-but-harmless becomes correctly-routed-but-now-broken if the fix is wrong.

**Why it happens:**
Tech debt is cleaned up opportunistically — "while I'm in this file, let me fix that too." Without explicit phase boundaries, debt cleanup and feature work intermix in the same commits. When a test fails, it is unclear whether the failure is from the new feature, the debt cleanup, or an interaction between them. Bisecting is slow.

**How to avoid:**
Address tech debt in a **dedicated phase before** any worktree or exploration work. The debt phase should: (1) fix exactly the listed items, (2) add regression tests for each fix before making the fix ("test first, then fix"), (3) run the full 696-test suite and confirm no regressions. The phase should be a single PR with only debt fixes. Worktree and exploration phases follow after, in their own PRs, with the clean baseline. This also makes the diff reviewable — debt changes are separable from feature changes.

**Warning signs:**
- Debt fixes committed in the same PR as worktree infrastructure
- The `configOnly` path in `retry.ts` is modified without a test that explicitly exercises the verifier being called (not bypassed) for a config-only change
- `exit code` tests added for `vetoed` and `turn_limit` statuses do not exist before fixing the switch

**Phase to address:** Tech debt cleanup phase should be Phase 1 (first phase of v2.4), before git worktree or exploration work begins.

---

## Technical Debt Patterns

Shortcuts that seem reasonable but create long-term problems.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Use `workspaceDir` (main repo) as Docker mount instead of worktree path | No mount path refactoring | Agent edits main branch while session branch is elsewhere; diff is empty or wrong | Never — Docker must always mount the worktree path, not the main repo path |
| Generate worktree branch names from task type only (no UUID) | Simpler naming | Concurrent sessions for the same task type collide on branch checkout | Never — always include a unique component (UUID/timestamp) |
| Skip worktree cleanup in test teardown ("prune will handle it") | Faster test writing | Stale worktrees accumulate across test runs; `git branch -D` fails because branches are checked out | Never in test suite — each test must clean its own worktrees |
| Rely on prompt alone to enforce read-only in exploration tasks | No code changes needed | Agent writes files, creates documentation, runs installs; judge approves it as "useful output" | Never — enforce at `PreToolUse` hook level, not prompt level |
| Clean up worktrees only on graceful exit | Handles 99% of cases | SIGKILL/OOM kills during agent runs leave orphan worktrees; `git branch -D` fails on next run | Never for production use — startup scan is mandatory |
| Mix debt fixes and feature code in the same PR | Faster velocity | Regressions are untraceable; bisect is slow; test failures ambiguous | Never — tech debt fixes in isolated commits or separate PR |
| Re-use existing `verifier` pipeline for exploration tasks | No new task routing needed | Verification expects a diff; exploration produces none; `zero_diff` is surfaced as failure/unexpected | Never — exploration must have its own result path that treats `finalResponse` as the output |

---

## Integration Gotchas

Common mistakes when wiring git worktree and exploration features into the existing pipeline.

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| `runAgent()` ↔ worktree path | Pass original `options.repo` to `SessionConfig.workspaceDir` | Create worktree first; set `workspaceDir` to worktree path before constructing `SessionConfig`; original repo path stored separately for cleanup |
| `RetryOrchestrator` ↔ baseline SHA | `captureBaselineSha()` captures main repo HEAD, not worktree HEAD | SHA capture must run against the worktree directory, which starts at the same commit as main but diverges as the agent works |
| `compositeVerifier` ↔ worktree | Verifier runs against `workspaceDir` (now the worktree); correct | No change needed — verifier already uses `workspaceDir` path; this is the one thing that works automatically |
| `GitHubPRCreator` ↔ worktree branch | PR branch already exists (it's the worktree branch) | Use the worktree branch as the PR source branch; do not generate a new branch name inside `GitHubPRCreator` |
| `getWorkspaceDiff()` ↔ worktree | Diff runs against worktree dir; correct | No change needed — diff already uses `workspaceDir`; verify with integration test |
| Exploration task ↔ `RetryResult.finalStatus` | `zero_diff` returned for exploration tasks; surfaces as "nothing changed" warning | Add `exploration_complete` as a new `finalStatus` or handle `zero_diff` specially for exploration task type — display `finalResponse` as the report |
| Worktree cleanup ↔ `AbortSignal` | Cleanup skipped when signal is aborted | `resetWorkspace()` in `RetryOrchestrator` currently only resets git state; must also call `git worktree remove` before returning `cancelled` status |
| Stale worktree scan ↔ concurrent sessions | Scan runs and removes a worktree that is actively in use by another session | Sentinel PID file in worktree directory distinguishes live sessions from orphans; never remove a worktree whose PID is alive |

---

## Performance Traps

Patterns that work at small scale but fail as usage grows.

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Worktrees never pruned; disk fills up | Disk space alert; `git worktree list` shows dozens of stale entries | Startup scan with prune; limit max live worktrees per repo | After ~50 agent runs on same repo without cleanup |
| `git worktree add` on large repos with full history | 3-5s delay per worktree creation on repos with large object stores | Worktrees share object store by design — no clone needed; this is acceptable. But if baseline SHA capture runs `git fetch` first, that is 10-30s | From first run if `git fetch` is accidentally included in setup |
| Concurrent exploration tasks with heavy `grep`/`find` Bash | CPU spike; agent session timeout | Exploration tasks need the same 5-min timeout and 10-turn limit as code tasks | Immediate, with large repos |
| Per-worktree `npm install` (preVerify hook) on concurrent npm update tasks | Multiple concurrent `npm install` processes writing to the same `node_modules` in different worktrees but with the same package.json path | Each worktree has its own `node_modules` (they are not shared); concurrent installs are safe because each worktree is a separate directory | Not a problem if worktree isolation is correct |

---

## Security Mistakes

Domain-specific security issues introduced by the new features.

| Mistake | Risk | Prevention |
|---------|------|------------|
| Exploration task Bash commands not constrained to read-only operations | Agent runs `curl`, `git push`, or other network/write operations under the guise of "exploration" | `PreToolUse` hook blocks write-capable Bash patterns for `readOnly: true` sessions; allowlist must include read-only patterns only (`cat`, `ls`, `find`, `grep`, `git log`, `git diff`, `git show`) |
| Worktree path leaks into Slack bot responses | Absolute host paths like `/Users/kiruba/repos/my-app-bg-agent-a3f2b1c9` exposed in Slack thread | Sanitize worktree paths from all user-facing output; display only the branch name or session ID |
| Agent in worktree has write access to shared `.git/config` | Agent could modify global git config (e.g., `core.hooksPath`, remotes) affecting all future operations on that repo | Mount worktree directory but NOT the parent `.git/config`; the PreToolUse hook already blocks direct `.git/` writes, but verify the pattern covers `../.git/config` relative paths |
| Exploration report contains credentials or secrets found in repo | Agent reads `.env` files or configs and includes secrets in `finalResponse` which is logged | Exploration prompt must explicitly instruct: "Never include secrets, tokens, or credential values in your report. Note that credentials exist but do not reproduce them." |

---

## UX Pitfalls

Common user experience mistakes in the new features.

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| `zero_diff` displayed for exploration tasks | User sees "Agent produced no changes" — reads as failure when it is expected success | Route exploration task results to a separate display path: show `finalResponse` as the report output, not the diff-based result block |
| Worktree branch name shown in PR (e.g., `bg-agent-a3f2b1c9`) without context | PR title and branch name are opaque | PR title generated from task description (existing behavior); branch name can remain UUID-based but PR body explains it |
| Concurrent runs have no progress visibility | User starts two tasks; both show "running" with no differentiation | Session ID or task description shown in the running indicator for concurrent sessions |
| Exploration task "report" is just agent's verbose thought process | User gets 2000 words of reasoning instead of structured findings | Exploration prompt must request a structured report format: "Return findings as a structured markdown report with sections: Summary, Key Findings, Recommendations." |

---

## "Looks Done But Isn't" Checklist

Things that appear complete but are missing critical pieces.

- [ ] **Worktree cleanup on crash:** Verify that after a `kill -9` on the host process, the next `runAgent()` call for the same repo successfully creates a new worktree — requires startup scan to prune the orphan from the previous run
- [ ] **Docker mount points to worktree:** Verify `git log --oneline -1` inside the container shows the worktree branch, not `main`; verify `git log --oneline -1` in the main repo is unchanged after agent runs
- [ ] **Read-only enforcement:** Verify that an exploration session with a Write tool call in the agent's response is blocked at `PreToolUse` with a clear error, not silently allowed
- [ ] **Exploration result display:** Verify the REPL shows the agent's `finalResponse` as the report output for exploration tasks, not "Agent produced no changes (zero diff)"
- [ ] **Concurrent session branch isolation:** Verify two simultaneous npm update sessions on the same repo do not produce the same branch name and do not corrupt each other's worktrees
- [ ] **Worktree removed on cancellation:** Verify that Ctrl+C during an agent run removes the worktree directory and calls `git worktree remove` — not just `git reset --hard`
- [ ] **Debt fixes have regression tests:** Verify each tech debt item (exit codes, configOnly bypass, dead code) has a test that fails before the fix and passes after
- [ ] **`git worktree prune` on startup:** Verify that a stale worktree from a previous crashed run is automatically cleaned up on the next `runAgent()` invocation — no manual intervention required

---

## Recovery Strategies

When pitfalls occur despite prevention, how to recover.

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Orphaned worktrees from crashes | LOW | `git worktree list` to identify orphans; `git worktree remove --force <path>` for each; `git worktree prune` to clean `.git/worktrees/` metadata; `git branch -D bg-agent-*` to remove orphan branches |
| Docker mount pointing to main repo (agent edited main branch) | MEDIUM | `git reset --hard <baseline-sha>` to undo main branch changes; re-run task with corrected `workspaceDir` |
| Exploration agent wrote files to repo | LOW | `git reset --hard HEAD` in the repo (no worktree needed — exploration uses main worktree or its own); verify diff is empty; add `PreToolUse` block before next run |
| Stale index lock blocking git operations | LOW | Check `lsof /path/to/.git/index.lock`; if no process holds it, `rm /path/to/.git/index.lock`; add stale lock detection to startup scan |
| Tech debt fix introduced regression | MEDIUM | `git revert` the debt-fix commit (isolated PR makes this clean); add the failing test; re-fix with correct implementation; re-merge |
| Branch name collision (two sessions same branch) | LOW | The second session fails at `git worktree add`; increase uniqueness in branch name generation (longer UUID); existing session is unaffected |

---

## Pitfall-to-Phase Mapping

How roadmap phases should address these pitfalls.

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Tech debt regressions in verification pipeline | Phase 1: Tech debt cleanup | All 696 existing tests pass; new regression tests for each fixed item; debt phase PR contains only debt fixes |
| Worktree not cleaned up on crash | Phase 2: Git worktree infrastructure | Test: `kill -9` host process during agent run; restart; `runAgent()` succeeds without "already checked out" error |
| Docker mount pointing to main repo | Phase 2: Git worktree infrastructure | Integration test: agent commits go to worktree branch, main branch unchanged |
| Branch name collision | Phase 2: Git worktree infrastructure | Test: two concurrent sessions for same repo never produce same branch name (UUID component required) |
| Stale index lock | Phase 2: Git worktree infrastructure | Host-side git commands use `--no-optional-locks`; timing documented: baseline before session, diff after session |
| Exploration agent writes files | Phase 3: Repo exploration tasks | Test: exploration session with Write tool call blocked at PreToolUse; `zero_diff` is expected result |
| Exploration result displayed as failure | Phase 3: Repo exploration tasks | REPL test: exploration task with `finalResponse` set displays report, not "no changes" warning |
| Worktree not removed on cancellation | Phase 2: Git worktree infrastructure | Test: Ctrl+C during session removes worktree directory and `git worktree list` no longer shows it |

---

## Sources

- [Git worktree documentation](https://git-scm.com/docs/git-worktree) — official reference for `add`, `remove`, `prune`, `lock`, and `repair` commands — HIGH confidence
- [Stale worktrees never cleaned up — anthropics/claude-code issue #26725](https://github.com/anthropics/claude-code/issues/26725) — real-world failure modes: orphan branches, nested worktrees, disk accumulation — HIGH confidence (first-party issue tracker)
- [Stale index.lock from background git ops — anthropics/claude-code issue #11005](https://github.com/anthropics/claude-code/issues/11005) — stale `.git/index.lock` files blocking git commands for 20+ seconds; `--no-optional-locks` workaround — HIGH confidence (verified with Git Trace2 logs)
- [Git worktree conflicts with AI agents — Termdock](https://www.termdock.com/en/blog/git-worktree-conflicts-ai-agents) — build cache contamination, package lockfile divergence, index lock deadlocks — MEDIUM confidence (blog, but verified against git docs)
- [Common git worktree mistakes — BSWEN](https://docs.bswen.com/blog/2026-03-30-git-worktree-troubleshooting/) — stale reference cleanup, path conflicts, manual deletion gotchas — MEDIUM confidence (blog)
- [OWASP MCP Top 10 — MCP02:2025 Privilege Escalation via Scope Creep](https://owasp.org/www-project-mcp-top-10/2025/MCP02-2025%E2%80%93Privilege-Escalation-via-Scope-Creep) — read-only agents accumulating write behavior; enforcement at authorization layer — HIGH confidence (OWASP official)
- [Docker bind mounts — official docs](https://docs.docker.com/engine/storage/bind-mounts/) — bind mount behavior, read-only mounts, recursive mount options — HIGH confidence
- Direct code analysis: `src/orchestrator/retry.ts` (worktree cleanup gap in `resetWorkspace()`), `src/agent/index.ts` (`workspaceDir` threading), `src/types.ts` (`SessionConfig.workspaceDir` as mount path), `.planning/PROJECT.md` (tech debt list, isolation constraints) — HIGH confidence

---
*Pitfalls research for: v2.4 Git Worktree Isolation and Repo Exploration Tasks — adding worktree-based concurrency and read-only investigative mode to existing background coding agent*
*Researched: 2026-04-05*
