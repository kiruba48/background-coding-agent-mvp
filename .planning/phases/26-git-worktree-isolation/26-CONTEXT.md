# Phase 26: Git Worktree Isolation - Context

**Gathered:** 2026-04-05
**Status:** Ready for planning

<domain>
## Phase Boundary

Every agent session operates in its own git worktree so concurrent runs on the same repo never conflict. Docker container mounts the worktree, not the main checkout. Worktrees are created, cleaned up, and recovered automatically.

</domain>

<decisions>
## Implementation Decisions

### Worktree lifecycle
- Create worktree inside `runAgent()`, right before Docker container starts — callers (REPL, one-shot, Slack) don't need changes
- Clean up worktree in a `finally` block after PR creation completes — ensures worktree exists for the entire pipeline
- In REPL mode, keep worktree alive until user starts a new task or exits — supports post-hoc `pr` command
- Add `skipWorktree` option in `AgentContext` alongside existing `skipDockerChecks` — tests can bypass worktree creation

### Sibling directory layout
- Worktrees created as sibling directories to the repo with `.bg-agent` dot-prefix (hidden in file listings)
- Naming: `.bg-agent-<repo-basename>-<short-uuid>` (e.g., `/code/.bg-agent-my-app-a1b2c3`)
- UUID portion matches the branch suffix for traceability

### Stale worktree recovery
- Orphan scan runs at REPL startup only (alongside existing Docker checks) — one-shot skips scan since it manages its own worktree
- Detection via PID sentinel file: `.bg-agent-pid` written in each worktree containing the owning process PID
- Stale detection: `process.kill(pid, 0)` — dead PID means orphan
- Prune action: `git worktree remove --force <path>` + `git branch -D <branch>` — complete cleanup of directory, git metadata, and local branch
- REPL scan covers ALL `.bg-agent-*` sibling directories regardless of which mode created them — one-shot crashes cleaned up next REPL start

### Branch strategy
- Worktree branch IS the PR branch — same `agent/<slug>-<date>-<hex>` name, no extra checkout/merge step
- `WorktreeManager` generates the branch name (calls `generateBranchName()`, already exported from pr-creator.ts) at worktree creation time — PRCreator receives the branch name instead of generating it
- Branch created from current HEAD — respects user's checked-out branch context; concurrent runs both start from same commit safely
- Local branch deleted during worktree removal: `git worktree remove` + `git branch -D` in same cleanup step

### Claude's Discretion
- WorktreeManager class structure and internal API
- Error handling for git worktree commands that fail (disk full, permissions, etc.)
- Exact PID sentinel file format (plain text vs JSON)
- Whether to extract `generateBranchName()` to a shared utility or keep importing from pr-creator.ts

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements
- `.planning/REQUIREMENTS.md` — WKTREE-01 through WKTREE-05 define the five acceptance criteria for worktree isolation

### Architecture context
- `.planning/PROJECT.md` — Key decisions table documents host-side git execution pattern, Docker isolation model, and one-container-per-task invariant

### Existing integration points
- `src/agent/index.ts` — `runAgent()` function where worktree creation/cleanup will be added; `workspaceDir` seam flows from here
- `src/cli/docker/index.ts` — Docker bind mount line (`-v ${opts.workspaceDir}:/workspace:rw`) that must point to worktree
- `src/orchestrator/pr-creator.ts` — `GitHubPRCreator` uses `simpleGit(this.workspaceDir)` for push; `generateBranchName()` exported here
- `src/orchestrator/retry.ts` — `captureBaselineSha()` and `resetWorkspace()` run git commands against `workspaceDir`
- `src/types.ts` — `SessionConfig.workspaceDir` and `RetryConfig` interfaces that carry the workspace path

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `generateBranchName()` in `pr-creator.ts`: Already generates `agent/<slug>-<date>-<hex>` names — WorktreeManager can call this directly
- `simple-git` package: Already a dependency (used in pr-creator.ts) — available for worktree operations via `.raw(['worktree', ...])`
- `skipDockerChecks` pattern in `AgentContext`: Established pattern for test bypass — `skipWorktree` follows the same convention

### Established Patterns
- `workspaceDir` is a clean seam: Flows through `AgentOptions.repo` → `RetryOrchestrator` → `ClaudeCodeSession` → Docker bind mount → `GitHubPRCreator`. Swapping repo path for worktree path at the top propagates everywhere.
- Host-side git uses `execFile('git', args, { cwd: workspaceDir })` — consistent pattern in retry.ts and judge.ts
- `simple-git` used only in pr-creator.ts — worktree ops can use either `simple-git.raw()` or `execFile('git', ...)`

### Integration Points
- `runAgent()` in `src/agent/index.ts` — primary insertion point for worktree create/cleanup wrapping the Docker + retry pipeline
- REPL task handler — needs awareness of worktree lifecycle for post-hoc PR support (keep worktree alive between tasks)
- Docker bind mount in `src/cli/docker/index.ts` — receives worktree path instead of repo path (no code change needed if `workspaceDir` is set correctly upstream)

</code_context>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches

</specifics>

<deferred>
## Deferred Ideas

- WKTREE-06: SIGINT cleanup handler prunes known worktrees on process exit — deferred to v2.5+
- WKTREE-07: Worktree branch name shown at confirm step before execution — deferred to v2.5+
- PIPE-01: Parallel agent execution orchestration (queue multiple tasks, run in parallel worktrees) — deferred to v2.5+

</deferred>

---

*Phase: 26-git-worktree-isolation*
*Context gathered: 2026-04-05*
