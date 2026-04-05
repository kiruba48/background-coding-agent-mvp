# Stack Research

**Domain:** Git worktree isolation and repo exploration tasks — background-coding-agent v2.4
**Researched:** 2026-04-05
**Confidence:** HIGH — live codebase inspection, npm registry, and direct runtime verification

---

## Scope

This file covers ONLY what changes for the v2.4 milestone. The validated existing stack is NOT re-researched:

- Node.js 20, TypeScript (NodeNext / ESM `"type": "module"`)
- `@anthropic-ai/claude-agent-sdk@^0.2.77`, `@anthropic-ai/sdk@^0.80.0`
- `simple-git@^3.32.3`, Commander.js, Pino, Vitest, ESLint v10, Zod 4, conf@15
- `@slack/bolt@^4.6.0`, `octokit@^5.0.5`, `write-file-atomic@^7.0.0`
- Docker (Alpine, multi-stage), `git`, `bash`, `ripgrep` already in image

---

## New Dependencies: None

**No new npm packages are required for v2.4.**

Both features — git worktree management and repo exploration tasks — are implemented entirely with:

1. **`simple-git` already in the project (v3.32.3)** — its `.raw()` method accepts arbitrary git subcommands, including all worktree operations. Live-verified:
   ```
   git.raw(['worktree', 'list', '--porcelain'])  // returns worktree entries
   git.raw(['worktree', 'add', '-b', branch, path])  // creates worktree
   git.raw(['worktree', 'remove', '--force', path])   // removes worktree
   git.raw(['worktree', 'prune'])                      // cleans stale references
   ```
   `simple-git` has no dedicated `.worktree()` method (confirmed by TypeScript typings and runtime inspection). `.raw()` is the correct and supported path — used elsewhere in the project (`pr-creator.ts` uses `.raw(['merge-base', ...])` and `.raw(['cherry-pick', ...])`).

2. **Node.js stdlib** — `node:path`, `node:fs/promises`, `node:os` for worktree directory path construction and cleanup.

3. **Pure TypeScript changes** — new task type (`exploration`), new prompt builder, modified orchestration path for read-only execution (no verification gate, no PR creation).

---

## Changes to Existing Modules

### 1. Git Worktree Manager — new module

**File:** `src/agent/worktree.ts` (new)

**What it does:** Encapsulates all `git worktree` lifecycle operations. Called by `runAgent()` before Docker launch (create worktree) and in a `finally` block (remove worktree).

```typescript
export interface WorktreeHandle {
  worktreePath: string;   // absolute path to the created worktree
  branch: string;         // the branch checked out in that worktree
}

export async function createWorktree(
  repoPath: string,
  branch: string,
): Promise<WorktreeHandle>

export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
): Promise<void>
```

**Path convention:** Worktrees are created as siblings of the repo directory:
```
/path/to/repo/         ← original checkout
/path/to/repo-wt-<sessionId>/   ← worktree created for this run
```

Using `path.dirname(repoPath) + path.basename(repoPath) + '-wt-' + sessionId` produces a predictable, collision-safe path. The parent directory is guaranteed to be writable (it already contains the repo). No `/tmp` — worktrees must be on the same filesystem as `.git/` to avoid cross-device issues.

**Why sibling rather than subdirectory:** `git worktree add` rejects paths inside the repo itself (`.git/` is inside). A sibling directory is the conventional pattern and avoids any conflict with the existing workspace mount.

**Error handling:** If `removeWorktree` fails (e.g., process killed mid-run), `git worktree prune` is called as a fallback. Stale worktree locks are cleaned with `--force` on remove.

**Integration point:** `runAgent()` in `src/agent/index.ts` currently receives `repo` as the workspace dir passed to Docker. For worktree runs, `worktreePath` replaces `repo` as `workspaceDir`. The original `repo` is still needed for `createWorktree` — pass both.

### 2. AgentOptions — `useWorktree` flag

**File:** `src/agent/index.ts`

**What changes:** Add optional `useWorktree?: boolean` to `AgentOptions`. When true, `runAgent()` calls `createWorktree()` before Docker launch and `removeWorktree()` in a `finally` block after the run completes (success, failure, or cancellation). The Docker container is launched with the worktree path as `workspaceDir` instead of `repo`.

This is the minimal invasive change: one boolean flag, three lines of code around the Docker launch, no changes to the verification pipeline or ClaudeCodeSession.

### 3. Task Types — add `exploration`

**File:** `src/intent/types.ts`

**What changes:**

```typescript
export const TASK_TYPES = [
  'npm-dependency-update',
  'maven-dependency-update',
  'generic',
  'exploration',   // new
] as const;
```

`exploration` is a read-only investigative task. The agent uses `git log`, `grep`, `find`, `cat`, and `ripgrep` (all already in the Docker image) to produce a report. No writes. No verification gate. No PR.

**Why a distinct task type over a generic task with "read-only" instructions:** The orchestration path diverges meaningfully — exploration runs skip the entire verification pipeline (`compositeVerifier`, `llmJudge`, zero-diff check) and PR creation. A task type flag makes that routing explicit and testable rather than inferred from `taskCategory`.

### 4. Prompts — `buildExplorationPrompt`

**File:** `src/prompts/exploration.ts` (new)

**What it does:** Builds a read-only agent prompt that:
- Opens with an explicit instruction that the agent must not modify, create, or delete files
- Lists the investigative question(s) from the user
- Instructs the agent to return a structured Markdown report as its final response
- Lists allowed tools: `Read`, `Bash` (git/grep/ripgrep only), `Glob`, `Grep`

The agent already has `Read`, `Bash`, `Glob`, `Grep` as built-in tools from the Claude Agent SDK. The PreToolUse hook in `ClaudeCodeSession` will block any write attempts (it already blocks `Edit`, `Write` outside the workspace — for exploration tasks it should block all writes).

### 5. RetryOrchestrator — exploration fast path

**File:** `src/orchestrator/retry.ts`

**What changes:** When `taskType === 'exploration'`, `RetryOrchestrator` runs one session and returns the `finalResponse` directly. No retries (nothing to correct — read-only output), no verification, no judge, no PR. `RetryResult.finalStatus` is `'success'` if the session completes without error, regardless of diff state.

**Integration:** `runAgent()` passes `taskType` through to `RetryOrchestrator`. The orchestrator already receives `RetryConfig`; exploration can set `verifier: undefined` and `judge: undefined` to skip both. The routing decision (to skip verification) lives in `runAgent()` based on `taskType`, keeping `RetryOrchestrator` generic.

### 6. REPL — `ExplorationResult` display

**File:** `src/repl/session.ts`

**What changes:** When `RetryResult.finalStatus === 'success'` and the task type is `exploration`, render `result.sessionResults[0].finalResponse` as the report output instead of the standard diff/verification summary block. Exploration results never have a PR to create, so `state.lastResult` still stores them (for `history`) but the `pr` command should print "Exploration tasks do not create PRs."

---

## What NOT to Add

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `execa` npm package | `.raw()` on the existing `simple-git` instance handles all git worktree commands with no shell injection risk and no new dependency. `node:child_process.execFile` (already used in `agent/index.ts`, `verifier.ts`, `docker/index.ts`) covers the remaining subprocess needs. | `simple-git.raw()` for git ops, `node:child_process.execFile` (already imported) for other subprocesses |
| `git-worktree` npm package (alexweininger/git-worktree) | 27 stars, last commit 2020, unmaintained. Does not support modern git worktree features. | `simple-git.raw(['worktree', ...])` |
| `simple-worktree` npm package (max-winderbaum) | 3 stars, focused on file syncing across worktrees for human developers. Not an API library. Solves the wrong problem. | `simple-git.raw(['worktree', ...])` |
| New Docker image layer for exploration | `git`, `bash`, `ripgrep` are already installed in the Alpine image. Exploration uses the same image as code-change tasks. | Existing `background-agent:latest` image |
| Write-blocking via a separate Docker flag (`--read-only` already set) | Container is already `--read-only` with `/workspace` as the only writable volume. The PreToolUse hook already blocks writes outside repo. For exploration, strengthen the hook to reject all write tools. | PreToolUse hook in `ClaudeCodeSession` |
| Separate "exploration" Docker network or container config | Exploration tasks have the same isolation requirements as code-change tasks. Same network, same iptables rules (Anthropic API access only, rest blocked). | Existing `buildDockerRunArgs()` unchanged |
| A dedicated report storage system | Exploration reports are returned as `RetryResult.sessionResults[0].finalResponse` — plain Markdown text in the existing result object. REPL prints to terminal. No persistence needed. | `RetryResult.finalResponse` (already in `SessionResult`) |
| `taskCategory` extension for exploration | `exploration` is a first-class task type, not a category of `generic`. It routes to a completely different orchestration path. Adding it as a category would require detecting it in multiple places. | `TASK_TYPES` enum extension |

---

## Installation

```bash
# No new dependencies for v2.4
# simple-git already installed; update to latest if desired:
npm install simple-git@^3.33.0
```

---

## Version Compatibility

| Package | Version | Notes |
|---------|---------|-------|
| `simple-git` | `3.32.3` (installed), `3.33.0` (latest as of 2026-04-05) | `.raw()` worktree commands verified working on installed version. Patch bump is safe. |
| `node:child_process` | Node.js 20 built-in | `execFile` + `promisify` pattern already used across 6 files in the project. No changes needed. |
| `node:path`, `node:fs/promises`, `node:os` | Node.js 20 built-in | Sufficient for worktree path construction (`path.dirname`, `path.basename`, `path.join`) and cleanup. |

---

## Alternatives Considered

| Recommended | Alternative | Why Not |
|-------------|-------------|---------|
| `simple-git.raw(['worktree', ...])` | `execFile('git', ['worktree', ...])` directly | Both work. `.raw()` is preferred because it reuses the existing `simpleGit(repoPath)` instance (same `cwd` binding), consistent error handling, and matches the pattern already used in `pr-creator.ts`. |
| Worktree as sibling directory | Worktree inside repo (e.g. `repo/.worktrees/session-id/`) | `git worktree add` rejects paths inside the repository. Git documentation recommends siblings or separate top-level paths. |
| Worktree as sibling directory | `/tmp/agent-worktrees/session-id/` | `/tmp` may be a different filesystem than the repo root on macOS (APFS volumes vs. tmpfs). `git worktree add` can fail cross-device. Sibling directories are always on the same filesystem. |
| `useWorktree?: boolean` flag on `AgentOptions` | Always use worktrees | Worktrees add a git dependency overhead and disk space cost. For single-session REPL runs, it's unnecessary. Default off, explicitly enabled for concurrent scenarios. |
| `exploration` as a distinct `TASK_TYPES` entry | `generic` task with `taskCategory: 'exploration'` | The orchestration path diverges at `RetryOrchestrator` (no verification, no PR, no retries). Routing on `taskCategory` spreads the conditional logic across multiple layers. A named task type makes the routing explicit and keeps verification bypass in one place. |

---

## Sources

- `node_modules/simple-git/typings/simple-git.d.ts` — no `.worktree()` method in TypeScript typings (HIGH confidence — live file)
- Runtime test: `simpleGit(repoPath).raw(['worktree', 'list', '--porcelain'])` — returns current worktree entry successfully (HIGH confidence — live test)
- `src/orchestrator/pr-creator.ts` lines 362, 460 — `git.raw(['merge-base', ...])` and `git.raw(['cherry-pick', ...])` confirm `.raw()` is the established pattern for arbitrary git commands (HIGH confidence — live source)
- `npm show simple-git version` → `3.33.0` (HIGH confidence — live npm registry)
- `docker/Dockerfile` — `git`, `bash`, `ripgrep` confirmed installed in Alpine image (HIGH confidence — live file)
- `src/cli/docker/index.ts` line 79 — `-v ${workspaceDir}:/workspace:rw` volume mount pattern (HIGH confidence — live source)
- `src/intent/types.ts` — `TASK_TYPES`, `TASK_CATEGORIES` current definitions (HIGH confidence — live source)
- `src/types.ts` — `RetryResult`, `SessionResult.finalResponse` fields (HIGH confidence — live source)
- [git worktree official docs](https://git-scm.com/docs/git-worktree) — `add`, `list`, `remove`, `prune` subcommands (HIGH confidence — official git documentation)
- [Upsun: Git Worktrees for Parallel AI Agents](https://devcenter.upsun.com/posts/git-worktrees-for-parallel-ai-coding-agents/) — worktree isolation pattern for AI agents, confirmed same-filesystem requirement (MEDIUM confidence — technical blog, 2025)

---
*Stack research for: Git worktree isolation and repo exploration tasks (background-coding-agent v2.4)*
*Researched: 2026-04-05*
