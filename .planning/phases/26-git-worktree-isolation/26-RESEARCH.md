# Phase 26: Git Worktree Isolation - Research

**Researched:** 2026-04-05
**Domain:** Git worktrees, Node.js filesystem APIs, process lifecycle management
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Worktree lifecycle:**
- Create worktree inside `runAgent()`, right before Docker container starts — callers (REPL, one-shot, Slack) don't need changes
- Clean up worktree in a `finally` block after PR creation completes — ensures worktree exists for the entire pipeline
- In REPL mode, keep worktree alive until user starts a new task or exits — supports post-hoc `pr` command
- Add `skipWorktree` option in `AgentContext` alongside existing `skipDockerChecks` — tests can bypass worktree creation

**Sibling directory layout:**
- Worktrees created as sibling directories to the repo with `.bg-agent` dot-prefix (hidden in file listings)
- Naming: `.bg-agent-<repo-basename>-<short-uuid>` (e.g., `/code/.bg-agent-my-app-a1b2c3`)
- UUID portion matches the branch suffix for traceability

**Stale worktree recovery:**
- Orphan scan runs at REPL startup only (alongside existing Docker checks) — one-shot skips scan since it manages its own worktree
- Detection via PID sentinel file: `.bg-agent-pid` written in each worktree containing the owning process PID
- Stale detection: `process.kill(pid, 0)` — dead PID means orphan
- Prune action: `git worktree remove --force <path>` + `git branch -D <branch>` — complete cleanup of directory, git metadata, and local branch
- REPL scan covers ALL `.bg-agent-*` sibling directories regardless of which mode created them — one-shot crashes cleaned up next REPL start

**Branch strategy:**
- Worktree branch IS the PR branch — same `agent/<slug>-<date>-<hex>` name, no extra checkout/merge step
- `WorktreeManager` generates the branch name (calls `generateBranchName()`, already exported from pr-creator.ts) at worktree creation time — PRCreator receives the branch name instead of generating it
- Branch created from current HEAD — respects user's checked-out branch context; concurrent runs both start from same commit safely
- Local branch deleted during worktree removal: `git worktree remove` + `git branch -D` in same cleanup step

### Claude's Discretion
- WorktreeManager class structure and internal API
- Error handling for git worktree commands that fail (disk full, permissions, etc.)
- Exact PID sentinel file format (plain text vs JSON)
- Whether to extract `generateBranchName()` to a shared utility or keep importing from pr-creator.ts

### Deferred Ideas (OUT OF SCOPE)
- WKTREE-06: SIGINT cleanup handler prunes known worktrees on process exit — deferred to v2.5+
- WKTREE-07: Worktree branch name shown at confirm step before execution — deferred to v2.5+
- PIPE-01: Parallel agent execution orchestration (queue multiple tasks, run in parallel worktrees) — deferred to v2.5+
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| WKTREE-01 | Agent session creates a git worktree in a sibling directory with UUID-suffixed branch name before Docker container starts | `git worktree add <path> -b <branch>` verified to work for sibling directories; `generateBranchName()` already exported |
| WKTREE-02 | Docker container bind-mounts the worktree directory (not main repo) as the workspace volume | `workspaceDir` seam in `runAgent()` → `RetryOrchestrator` → `ClaudeCodeSession` → `buildDockerRunArgs()` means updating `workspaceDir` at `runAgent()` entry propagates everywhere |
| WKTREE-03 | Worktree is automatically removed in a finally block after task completion (success, failure, veto, zero-diff, cancelled) | `git worktree remove --force` + `git branch -D` verified to remove directory + git metadata in single operation |
| WKTREE-04 | Startup orphan scan prunes stale worktrees from crashed sessions using PID sentinel files | `process.kill(pid, 0)` verified: throws ESRCH for dead PIDs, succeeds for live ones; fs.readdir scan of parent dir for `.bg-agent-*` prefix |
| WKTREE-05 | Host-side git operations (commit, push) execute against the worktree path, not the main repo checkout | All git ops in retry.ts, judge.ts, and pr-creator.ts use `workspaceDir` parameter — setting worktree path as `workspaceDir` requires no per-file changes |
</phase_requirements>

---

## Summary

Phase 26 adds a `WorktreeManager` class and integrates it into `runAgent()` so each agent session gets its own isolated git worktree in a sibling directory. The design exploits the existing `workspaceDir` seam: by setting it to the worktree path before passing it to `RetryOrchestrator`, all downstream code (Docker bind mount, verifiers, judge, PR creator) automatically operates on the worktree without per-file changes. A `finally` block in `runAgent()` tears down the worktree after PR creation completes. REPL startup gets a one-time orphan scan that prunes worktrees whose PID sentinel files point to dead processes.

Git worktree operations (`git worktree add`, `git worktree remove --force`, `git branch -D`) are executed via `execFile('git', args, { cwd: repoDir })` — the same pattern already established in `retry.ts` and `judge.ts`. The `simple-git` package has no `.worktree()` method; raw git via `execFile` is the correct interface. This was confirmed by the STATE.md note: "simple-git.raw(['worktree', ...]) is the only interface for worktree ops."

The branch generated by `WorktreeManager` (via `generateBranchName()`) is passed into `GitHubPRCreator.create()` as `branchOverride` — this short-circuits PR creator's internal `generateBranchName()` call and ensures the PR branch matches the worktree branch exactly. No cherry-pick or extra checkout is needed because the agent committed directly into the worktree branch throughout its session.

**Primary recommendation:** Build `WorktreeManager` as a single TypeScript class in `src/agent/worktree-manager.ts`, integrate it into `runAgent()` with a `try/finally` wrapper, and add the orphan scan to the REPL startup block in `src/cli/commands/repl.ts`.

---

## Standard Stack

### Core

| Library/Tool | Version | Purpose | Why Standard |
|---|---|---|---|
| `git worktree` (CLI) | system git | Create/remove isolated working trees | Built into git; no extra dependencies |
| `node:child_process.execFile` | Node.js 20 built-in | Execute git commands on host | Already established pattern in retry.ts/judge.ts |
| `node:fs/promises` | Node.js 20 built-in | Write PID sentinel file, scan parent dir | Async, no extra deps |
| `node:path` | Node.js 20 built-in | Compute sibling path, basename | Already used everywhere |
| `node:crypto.randomBytes` | Node.js 20 built-in | Generate short UUID suffix | Already used in `generateBranchName()` |

### Supporting

| Library | Version | Purpose | When to Use |
|---|---|---|---|
| `simple-git` | 3.32.3 | Already in project — not used for worktrees | Only for git operations in pr-creator.ts; worktree ops go through execFile |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `execFile('git', ['worktree', ...])` | `simpleGit.raw(['worktree', ...])` | simple-git adds overhead; execFile is more direct and matches retry.ts/judge.ts pattern — use execFile |
| `randomBytes(3).toString('hex')` | `randomUUID()` | Both work; 6-char hex already used in generateBranchName and provides sufficient uniqueness — stay consistent |
| Plain text PID file | JSON PID file | JSON allows adding branch name for recovery; plain text is simpler; planner's discretion |

**Installation:** No new packages needed — all tools are built-in.

---

## Architecture Patterns

### Recommended Project Structure

```
src/
├── agent/
│   ├── index.ts              # runAgent() — add worktree lifecycle here
│   ├── worktree-manager.ts   # NEW: WorktreeManager class
│   └── ...
├── cli/
│   └── commands/
│       └── repl.ts           # Add orphan scan after Docker checks
└── orchestrator/
    └── pr-creator.ts         # generateBranchName() already exported
```

### Pattern 1: WorktreeManager Class

**What:** A class encapsulating worktree creation, PID sentinel writing, cleanup, and orphan scanning. Single responsibility — no business logic, only filesystem and git operations.

**When to use:** Instantiated once per `runAgent()` call (when `skipWorktree` is false). REPL uses a static scan method at startup.

**Example (conceptual):**
```typescript
// src/agent/worktree-manager.ts
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { writeFile, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);

export class WorktreeManager {
  private worktreePath: string;
  private branchName: string;
  private repoDir: string;

  constructor(repoDir: string, worktreePath: string, branchName: string) {
    this.repoDir = repoDir;
    this.worktreePath = worktreePath;
    this.branchName = branchName;
  }

  /** Create worktree + write PID sentinel */
  async create(): Promise<void> {
    // git worktree add <path> -b <branch> HEAD
    await execFileAsync('git', ['worktree', 'add', this.worktreePath, '-b', this.branchName], {
      cwd: this.repoDir,
    });
    // Write PID sentinel
    await writeFile(
      path.join(this.worktreePath, '.bg-agent-pid'),
      String(process.pid),
    );
  }

  /** Remove worktree directory + local branch. Best-effort on error. */
  async remove(): Promise<void> {
    try {
      await execFileAsync('git', ['worktree', 'remove', '--force', this.worktreePath], {
        cwd: this.repoDir,
      });
    } catch { /* log but don't throw — in finally block */ }
    try {
      await execFileAsync('git', ['branch', '-D', this.branchName], {
        cwd: this.repoDir,
      });
    } catch { /* branch may already be deleted */ }
  }

  /** Generate the sibling worktree path from repo dir and suffix */
  static buildWorktreePath(repoDir: string, suffix: string): string {
    const parentDir = path.dirname(repoDir);
    const repoBasename = path.basename(repoDir);
    return path.join(parentDir, `.bg-agent-${repoBasename}-${suffix}`);
  }

  /** Scan parentDir for .bg-agent-* dirs and prune orphans (dead PID) */
  static async pruneOrphans(repoDir: string, logger?: pino.Logger): Promise<void> {
    const parentDir = path.dirname(repoDir);
    const repoBasename = path.basename(repoDir);
    const prefix = `.bg-agent-${repoBasename}-`;
    let entries: string[];
    try {
      entries = await readdir(parentDir);
    } catch { return; }

    for (const entry of entries) {
      if (!entry.startsWith(prefix)) continue;
      const worktreePath = path.join(parentDir, entry);
      const sentinelPath = path.join(worktreePath, '.bg-agent-pid');
      let isOrphan = false;
      try {
        const pidStr = await readFile(sentinelPath, 'utf-8');
        const pid = parseInt(pidStr.trim(), 10);
        if (isNaN(pid)) { isOrphan = true; }
        else {
          try { process.kill(pid, 0); }  // throws ESRCH if dead
          catch { isOrphan = true; }
        }
      } catch { isOrphan = true; } // sentinel missing = orphan

      if (isOrphan) {
        logger?.warn({ worktreePath }, 'Pruning stale worktree');
        // Extract branch name from worktree .git file
        // git worktree remove --force handles directory removal
        // Then delete the branch by reading the branch from git worktree list
        try {
          await execFileAsync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repoDir });
        } catch { /* best-effort */ }
        // Branch deletion: need to read branch name from git metadata before removal,
        // or parse from directory name suffix pattern
      }
    }
  }
}
```

### Pattern 2: Integration in runAgent()

**What:** `WorktreeManager` wraps the entire Docker + retry + PR pipeline in `runAgent()`. The worktree path replaces `options.repo` as the `workspaceDir` for all downstream operations.

**When to use:** Always when `skipWorktree` is false in `AgentContext`.

**Key integration point:**
```typescript
// In runAgent() — after Docker checks, before RetryOrchestrator creation
if (!context.skipWorktree) {
  const suffix = randomBytes(3).toString('hex');
  const worktreePath = WorktreeManager.buildWorktreePath(options.repo, suffix);
  const branchName = generateBranchName(branchInput); // same logic as before
  const manager = new WorktreeManager(options.repo, worktreePath, branchName);
  await manager.create();

  // All downstream code uses worktree path — no other changes needed
  effectiveWorkspaceDir = worktreePath;
  effectiveBranchOverride = branchName;

  // Cleanup in finally block (after PR creation)
  try {
    // ... orchestrator.run(), PR creation ...
  } finally {
    await manager.remove();
  }
}
```

### Pattern 3: Orphan Scan at REPL Startup

**What:** Added immediately after the existing Docker startup checks in `replCommand()`. Runs once per REPL session.

**Key placement in repl.ts:**
```typescript
// After spinner.success({ text: 'Docker ready' })
await WorktreeManager.pruneOrphans(/* repoDir from... */ );
// Note: at REPL startup, currentProject is not yet set.
// Scan uses cwd or last-known project from registry.
```

**Challenge:** REPL doesn't know the repo until the user types the first task. CONTEXT.md says "scan covers ALL `.bg-agent-*` sibling directories regardless of which mode created them." This means the scan needs to happen per-worktree-create, OR the REPL must scan based on registered repos or cwd parent.

**Recommended resolution:** At REPL startup, scan the parent of `process.cwd()` for `.bg-agent-*` dirs. This covers the common case where users run the REPL from the project directory. The scan is opportunistic — it doesn't guarantee finding orphans from different directories, but captures the most common failure mode (crashed session in the current working directory).

### Anti-Patterns to Avoid

- **Putting worktree path inside the repo directory:** Git rejects this (documented in REQUIREMENTS.md as out of scope). Always use sibling path.
- **Using `git worktree remove` without `--force`:** Fails if the worktree has uncommitted changes (verified: `--force` removes even dirty worktrees).
- **Deleting branch before worktree remove:** `git worktree remove` leaves the branch; `git branch -D` is a separate step done AFTER `git worktree remove`.
- **Reusing the branch name on PR creator:** Pass the worktree branch as `branchOverride` to `GitHubPRCreator.create()`. The PR creator currently runs `generateBranchName()` internally — it must receive the pre-generated name to avoid creating a different branch.
- **Worktree removal before PR creation completes:** The finally block must wrap the entire pipeline including `creator.create()`. Branch exists until PR is pushed.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Orphan worktree path detection | Custom file registry | PID sentinel + `process.kill(pid, 0)` | No persistent state file needed; OS manages process liveness |
| Worktree directory isolation | Custom copy of repo | `git worktree add` | Git handles all .git metadata, ref tracking, and branch isolation natively |
| Branch deletion with directory | Two-step manual rm + git reset | `git worktree remove --force` + `git branch -D` | Single command removes directory AND git worktree metadata atomically |
| Unique suffix generation | External UUID library | `randomBytes(3).toString('hex')` | Already in codebase for `generateBranchName()`; no new dependency |

**Key insight:** `git worktree` handles all the hard parts (isolation, ref tracking, HEAD management). The only application logic needed is the lifecycle wrapper and orphan detection.

---

## Common Pitfalls

### Pitfall 1: Branch Already Checked Out

**What goes wrong:** `git worktree add -b <branch>` fails if `<branch>` already exists locally.
**Why it happens:** Two concurrent runs generate the same branch name (extremely unlikely with 6-char hex suffix, but edge case exists).
**How to avoid:** The `generateBranchName()` function uses `randomBytes(3).toString('hex')` — collision probability is ~1 in 16M. No special handling needed. If it fails, propagate error to user (don't retry with different name).
**Warning signs:** Error message: "fatal: A branch named '...' already exists".

### Pitfall 2: Worktree Directory Already Exists

**What goes wrong:** `git worktree add <path>` fails if `<path>` already exists on disk.
**Why it happens:** Previous crash left orphan directory that wasn't cleaned up (before orphan scanner existed).
**How to avoid:** Orphan scanner at REPL startup handles this. For one-shot mode, check if path exists and fail clearly. The naming convention (`.bg-agent-<basename>-<6hex>`) makes collision extremely unlikely for new runs.
**Warning signs:** Error message: "fatal: '<path>' already exists".

### Pitfall 3: Branch Deletion Fails After Worktree Remove

**What goes wrong:** `git branch -D <branch>` fails with "branch not found".
**Why it happens:** The branch was the worktree's HEAD — after `git worktree remove`, the branch still exists. But if something else already deleted it, `-D` errors.
**How to avoid:** Catch and ignore the error from `git branch -D` in the cleanup method. Best-effort deletion.

### Pitfall 4: PR Creator Generates Different Branch Name

**What goes wrong:** `GitHubPRCreator` calls `generateBranchName()` internally, creating a NEW branch name different from the worktree branch. The agent's commits are on the worktree branch; the PR tries to push a different branch.
**Why it happens:** Current `GitHubPRCreator.create()` generates branch name from `opts.taskType` or `opts.description` if no `branchOverride` is given.
**How to avoid:** Always pass the worktree branch name as `branchOverride` in the `creator.create()` call. The PR creator already supports this parameter.

### Pitfall 5: Orphan Scan Deletes Active Worktrees

**What goes wrong:** Orphan scan kills a worktree belonging to a concurrent running process.
**Why it happens:** Bug in PID check — using wrong PID or checking the wrong sentinel file.
**How to avoid:** PID sentinel file written AFTER `git worktree add` succeeds. `process.kill(pid, 0)` correctly returns (no throw) if process is alive, throws ESRCH if dead. Only throw ESRCH triggers pruning.

### Pitfall 6: Worktree Not Cleaned Up When runAgent Throws Unexpectedly

**What goes wrong:** An unhandled exception before the `finally` block is reached leaves the worktree behind.
**Why it happens:** `try/finally` must wrap the entire pipeline including orchestrator creation.
**How to avoid:** Ensure `WorktreeManager.create()` is called and `manager.remove()` is in the `finally` block that wraps the orchestrator AND PR creation. Structure:
```
create worktree
try {
  run orchestrator
  create PR
} finally {
  remove worktree  ← always runs
}
```

### Pitfall 7: REPL Post-Hoc PR After Worktree Removal

**What goes wrong:** User runs `pr` command after task completes, but worktree is already removed.
**Why it happens:** Worktree removed in `finally` block — after PR creation, branch is on remote, main repo HEAD hasn't moved. Post-hoc PR from REPL session uses `state.lastIntent.repo` (the ORIGINAL repo path, not worktree path) to construct a new `GitHubPRCreator`. The worktree branch was already pushed to remote during the task's `creator.create()` call.
**How to avoid:** Post-hoc `pr` command only applies when `createPr` was false during the task run. In that case, `GitHubPRCreator` is initialized with `state.lastIntent.repo` (the original repo). The branch name from the worktree session must be stored in `state` so the post-hoc `pr` command can pass it as `branchOverride`.

**This is a new requirement:** `state.lastIntent` must store the worktree's branch name for post-hoc PR to use as `branchOverride`. Without this, post-hoc PR generates a different branch name and fails to find the agent's commits.

---

## Code Examples

### Creating a Worktree (verified via CLI test)

```bash
# Verified working: creates sibling directory with new branch
git worktree add /parent/.bg-agent-myrepo-a1b2c3 -b agent/task-2026-04-05-a1b2c3
# Output: Preparing worktree (new branch 'agent/task-2026-04-05-a1b2c3')
#         HEAD is now at <sha> <commit message>
```

```typescript
// In WorktreeManager.create() — source: verified CLI behavior
await execFileAsync('git', [
  'worktree', 'add',
  this.worktreePath,
  '-b', this.branchName,
], { cwd: this.repoDir });
```

### Removing a Worktree (verified via CLI test)

```bash
# Verified working: removes directory AND git metadata even with uncommitted changes
git worktree remove --force /parent/.bg-agent-myrepo-a1b2c3
git branch -D agent/task-2026-04-05-a1b2c3
```

### PID Liveness Check (verified via Node.js)

```typescript
// Verified: throws ESRCH for dead PIDs, succeeds (no throw) for live PIDs
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);  // signal 0 = existence check only, doesn't kill
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
    // ESRCH = no such process (dead)
    // EPERM = process exists but no permission (treat as alive)
  }
}
```

### Computing Sibling Path

```typescript
// Source: verified via node -e
import path from 'node:path';

function buildWorktreePath(repoDir: string, suffix: string): string {
  const parentDir = path.dirname(repoDir);           // /code/Projects/ai
  const repoBasename = path.basename(repoDir);       // background-coding-agent
  return path.join(parentDir, `.bg-agent-${repoBasename}-${suffix}`);
  // Result: /code/Projects/ai/.bg-agent-background-coding-agent-a1b2c3
}
```

### Listing Worktrees (porcelain format, for orphan scan)

```bash
# Verified output format:
git worktree list --porcelain
# worktree /path/to/main
# HEAD <sha>
# branch refs/heads/main
#
# worktree /path/to/.bg-agent-repo-a1b2c3
# HEAD <sha>
# branch refs/heads/agent/task-2026-04-05-a1b2c3
```

### Passing Branch to PR Creator (existing pattern)

```typescript
// In runAgent() — pass worktree branch as branchOverride so PR creator
// doesn't generate a different name
const prResult = await creator.create({
  taskType: options.taskType,
  originalTask: prompt,
  retryResult,
  branchOverride: effectiveBranchOverride,  // worktree branch name
  description: options.description,
  taskCategory: options.taskCategory,
});
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|---|---|---|---|
| Single repo checkout, sequential tasks only | Per-task worktree in sibling directory | Phase 26 | Enables concurrent runs without branch conflicts |
| PR branch generated by `GitHubPRCreator` | PR branch generated by `WorktreeManager`, passed as `branchOverride` | Phase 26 | Branch name known before Docker starts; worktree and PR branch are identical |
| `workspaceDir = options.repo` | `workspaceDir = worktreePath` (when skipWorktree=false) | Phase 26 | All downstream code gets worktree automatically via existing seam |

---

## Open Questions

1. **REPL orphan scan: which repoDir to use?**
   - What we know: At REPL startup, `state.currentProject` is null (no task run yet). The scan needs a `repoDir` to compute `path.dirname(repoDir)` for scanning.
   - What's unclear: Should we scan from `process.cwd()` parent, or scan from all registered project parents?
   - Recommendation: Scan `path.dirname(process.cwd())` at startup. This covers the primary use case (user runs REPL from the project directory). Document that orphans from other project paths require another REPL startup from that directory. Keep it simple.

2. **Post-hoc PR branch name persistence**
   - What we know: `state.lastIntent` in REPL stores task details for post-hoc `pr` command. The worktree branch name must be stored for post-hoc PR to use as `branchOverride`.
   - What's unclear: Whether `ReplState`/`TaskHistoryEntry` needs extension, or if the branch name is passed differently.
   - Recommendation: Add `worktreeBranch?: string` to `ReplState` (not `TaskHistoryEntry`). Set it when task completes with `success`. Post-hoc `pr` command passes it as `branchOverride`. Clear it after use.

3. **Orphan scan: branch name recovery for cleanup**
   - What we know: After `git worktree remove --force`, the branch still exists (orphan branch). We need the branch name to run `git branch -D`.
   - What's unclear: How to get branch name from an orphan worktree dir before removing it.
   - Recommendation: Use `git worktree list --porcelain` from `repoDir` to get branch names for all `.bg-agent-*` paths before calling `worktree remove`. Alternatively, store branch name in PID sentinel file (JSON format: `{ pid, branch }`). JSON sentinel is cleaner.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 4.0.18 |
| Config file | `vitest.config.ts` |
| Quick run command | `npx vitest run src/agent/worktree-manager.test.ts` |
| Full suite command | `npx vitest run` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| WKTREE-01 | WorktreeManager.create() calls `git worktree add` with correct path and branch | unit | `npx vitest run src/agent/worktree-manager.test.ts` | Wave 0 |
| WKTREE-01 | WorktreeManager.buildWorktreePath() produces `.bg-agent-<basename>-<suffix>` sibling path | unit | `npx vitest run src/agent/worktree-manager.test.ts` | Wave 0 |
| WKTREE-01 | PID sentinel file is written after worktree create | unit | `npx vitest run src/agent/worktree-manager.test.ts` | Wave 0 |
| WKTREE-02 | runAgent() passes worktreePath as workspaceDir to RetryOrchestrator | unit | `npx vitest run src/agent/index.test.ts` | Exists (needs new tests) |
| WKTREE-03 | WorktreeManager.remove() called in finally block even when orchestrator throws | unit | `npx vitest run src/agent/index.test.ts` | Exists (needs new tests) |
| WKTREE-03 | WorktreeManager.remove() calls `git worktree remove --force` + `git branch -D` | unit | `npx vitest run src/agent/worktree-manager.test.ts` | Wave 0 |
| WKTREE-04 | pruneOrphans() skips directories with alive PID sentinel | unit | `npx vitest run src/agent/worktree-manager.test.ts` | Wave 0 |
| WKTREE-04 | pruneOrphans() removes directories with dead PID sentinel | unit | `npx vitest run src/agent/worktree-manager.test.ts` | Wave 0 |
| WKTREE-04 | pruneOrphans() removes directories with missing sentinel file | unit | `npx vitest run src/agent/worktree-manager.test.ts` | Wave 0 |
| WKTREE-05 | runAgent() passes worktreePath (not options.repo) as workspaceDir | unit | `npx vitest run src/agent/index.test.ts` | Exists (needs new tests) |
| WKTREE-05 | GitHubPRCreator receives worktree branchName as branchOverride | unit | `npx vitest run src/agent/index.test.ts` | Exists (needs new tests) |

### Sampling Rate

- **Per task commit:** `npx vitest run src/agent/worktree-manager.test.ts src/agent/index.test.ts`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `src/agent/worktree-manager.test.ts` — covers WKTREE-01 (create, buildPath, PID write), WKTREE-03 (remove), WKTREE-04 (pruneOrphans)
- [ ] New test cases in `src/agent/index.test.ts` — cover WKTREE-02 (workspaceDir swap), WKTREE-03 (finally cleanup), WKTREE-05 (branchOverride passthrough)

---

## Key Integration Points Summary

The plan must address these specific connection points in exact order:

1. **`src/agent/worktree-manager.ts`** — New file. `WorktreeManager` class with `create()`, `remove()`, `buildWorktreePath()`, `pruneOrphans()`.

2. **`src/agent/index.ts` — `runAgent()`**:
   - Add `skipWorktree?: boolean` to `AgentContext` interface
   - After Docker checks, before `RetryOrchestrator` creation: call `WorktreeManager.create()`, set `effectiveWorkspaceDir = worktreePath`, capture `effectiveBranchOverride`
   - Wrap orchestrator + PR creation in `try/finally` calling `manager.remove()`
   - Pass `effectiveBranchOverride` to `GitHubPRCreator.create()` as `branchOverride`

3. **`src/cli/commands/repl.ts` — `replCommand()`**:
   - After `spinner.success({ text: 'Docker ready' })`, call `WorktreeManager.pruneOrphans(path.dirname(process.cwd()), logger)`

4. **`src/repl/session.ts` — `processInput()`**:
   - Store worktree branch name in `ReplState.lastWorktreeBranch` after successful task
   - Post-hoc `pr` command uses `state.lastWorktreeBranch` as `branchOverride`

5. **`src/repl/types.ts` — `ReplState`**:
   - Add `lastWorktreeBranch?: string` field

6. **`src/orchestrator/pr-creator.ts`** — No changes. `generateBranchName()` already exported and `branchOverride` parameter already exists on `create()`.

7. **`src/types.ts`** — No changes needed. `SessionConfig.workspaceDir` already carries the path through the chain.

---

## Sources

### Primary (HIGH confidence)

- Verified via local CLI: `git worktree add`, `git worktree remove --force`, `git branch -D` behavior
- Verified via Node.js: `process.kill(pid, 0)` — ESRCH for dead PIDs, no-throw for live PIDs
- Direct source reading: `src/agent/index.ts`, `src/orchestrator/pr-creator.ts`, `src/orchestrator/retry.ts`, `src/types.ts`, `src/cli/docker/index.ts`, `src/cli/commands/repl.ts`, `src/repl/session.ts`
- `.planning/phases/26-git-worktree-isolation/26-CONTEXT.md` — all locked decisions
- `.planning/STATE.md` — confirmed `simple-git.raw()` is the only worktree interface
- simple-git package.json: version 3.32.3 (no `.worktree()` method — confirmed by `Object.keys()` check)

### Secondary (MEDIUM confidence)

- `git worktree list --porcelain` output format: verified via CLI test

### Tertiary (LOW confidence)

- None — all claims verified from official sources or direct code inspection

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — built-in Node.js APIs + system git, verified via CLI
- Architecture: HIGH — all integration points read from source, all git commands verified
- Pitfalls: HIGH — most discovered by reading existing code and testing edge cases directly

**Research date:** 2026-04-05
**Valid until:** 2026-05-05 (stable domain — git worktree API unchanged for years)
