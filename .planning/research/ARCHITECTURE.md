# Architecture Research

**Domain:** Git worktree isolation + repo exploration tasks — background coding agent v2.4
**Researched:** 2026-04-05
**Confidence:** HIGH (first-party codebase analysis; all integration points verified in source)

## Context: What This Research Is

This is an integration analysis for v2.4. The system is fully operational (v2.3). The question is: how do two new capabilities — git worktree isolation for concurrent agent runs and read-only repo exploration tasks — slot into the existing pipeline without breaking existing flows or adding unnecessary complexity?

This document maps every touch point: what is new, what is modified, what is untouched, and the recommended build order with dependency rationale.

---

## Existing Architecture (v2.3 — What Already Works)

```
User input (REPL | one-shot | Slack)
  └─> parseIntent(input, options)
       ├─> fastPathParse()       regex: dep-update patterns
       └─> llmParse()            Haiku 4.5, GA structured output
  └─> processInput(input, state, callbacks, registry)
       ├─> clarify()             low-confidence menu
       ├─> confirm()             intent display + Y/n
       └─> runScopingDialogue()  scope questions (generic only)
  └─> runAgent(AgentOptions, AgentContext)
       ├─> buildPrompt(options)  → prompt string
       └─> RetryOrchestrator
            ├─> captureBaselineSha(workspaceDir)   [HOST git]
            ├─> ClaudeCodeSession.run(message)
            │    └─> spawn('docker', buildDockerRunArgs({workspaceDir, ...}))
            │         └─> -v workspaceDir:/workspace:rw
            │         └─> claude <sdk-args>   [inside container]
            ├─> getWorkspaceDiff(workspaceDir)     [HOST git]
            ├─> compositeVerifier(workspaceDir)    [HOST npm/mvn/tsc]
            └─> llmJudge(workspaceDir, task, sha)  [HOST Anthropic API]
  └─> GitHubPRCreator.create(...)   [HOST Octokit]
  └─> RetryResult → processInput() → rendered in adapter
```

### Key Architectural Constants

| Constant | Value | Why Fixed |
|----------|-------|-----------|
| `workspaceDir` | Absolute host path to repo | Git, verifier, judge, Docker mount all use this |
| Container mount | `-v workspaceDir:/workspace:rw` | Agent reads/writes files at `/workspace` |
| Host git | `git` commands run on host (not in container) | Container user (UID 1001) can't write `.git/` |
| `containerWorkspaceDir` | `/workspace` (hardcoded in session) | PreToolUse hook and SDK `cwd` use this value |

---

## Feature 1: Git Worktree Isolation

### Problem Being Solved

Currently, all agent runs operate on the same working tree of the target repo. Two concurrent runs on the same repo would conflict: both would be on the same branch, both would write to the same files, and `git reset --hard` (cancellation cleanup) would destroy both. Worktree isolation gives each session its own directory, its own branch, and independent working-tree state.

### How Git Worktrees Work

A git worktree is a linked working directory pointing to the same `.git` object store as the main checkout. Each worktree has its own HEAD, index, and working tree, but shares all commit history and branch metadata.

```bash
# Creates a sibling directory with a fresh branch
git worktree add ../my-repo-agent-abc123 -b agent/abc123
# → ../my-repo-agent-abc123/ now exists, checked out at HEAD of main branch
# → branch agent/abc123 created
# → git worktree list shows it

# Cleanup
git worktree remove ../my-repo-agent-abc123
git branch -d agent/abc123
```

The worktree directory shares the `.git` object store but has its own `.git` file (not directory) containing: `gitdir: /path/to/main/.git/worktrees/agent-abc123`.

### Filesystem Layout

```
/repos/
├── my-app/                  ← main checkout (workspaceDir in existing code)
│   ├── .git/                ← shared object store; worktrees registered here
│   └── src/...
└── my-app-agent-abc123/     ← worktree for session abc123 (NEW)
    ├── .git                 ← FILE (not dir): gitdir: ../my-app/.git/worktrees/agent-abc123
    └── src/...              ← independent working tree
```

The worktree lives as a sibling directory to the main checkout. The naming convention `{repo-basename}-agent-{sessionId}` ensures uniqueness and traceability.

### Integration Point: `WorktreeManager`

A new module handles the full lifecycle of a worktree for a single session.

**New file:** `src/orchestrator/worktree.ts`

```typescript
export interface WorktreeInfo {
  worktreeDir: string;  // absolute path to the new worktree
  branchName: string;   // agent/{sessionId}
  sessionId: string;
}

export class WorktreeManager {
  constructor(private mainRepo: string) {}

  /** Create a worktree for a session. Returns the worktree path. */
  async create(sessionId: string): Promise<WorktreeInfo>;

  /** Remove the worktree directory and delete the branch. Best-effort — never throws. */
  async remove(info: WorktreeInfo): Promise<void>;

  /** Prune orphaned worktrees from the repo (e.g. after crash). */
  async prune(): Promise<void>;
}
```

All git operations in `WorktreeManager` run on the host (same as `captureBaselineSha`, `getWorkspaceDiff` in `judge.ts`). This is consistent with the established pattern: the container user (UID 1001) cannot write to `.git/`.

### Integration Point: `runAgent()`

`runAgent()` in `src/agent/index.ts` is the single entry point for all agent runs. It owns the Docker lifecycle and wires `SessionConfig.workspaceDir`. This is where worktree creation/cleanup is added.

**Modified:** `src/agent/index.ts`

The change wraps the existing `RetryOrchestrator.run()` call:

```
runAgent(options, context):
  1. Docker lifecycle (unchanged)
  2. NEW: worktreeManager = new WorktreeManager(options.repo)
  3. NEW: worktreeInfo = await worktreeManager.create(sessionId)
  4. Construct RetryOrchestrator with:
       workspaceDir: worktreeInfo.worktreeDir  ← CHANGED (was options.repo)
  5. retryResult = await orchestrator.run(...)
  6. GitHubPRCreator (uses worktreeDir, already has the branch)
  7. NEW: finally { await worktreeManager.remove(worktreeInfo) }
```

The `workspaceDir` threading is the critical path. Every downstream component receives `workspaceDir`:
- `ClaudeCodeSession` → mounts it as `-v workspaceDir:/workspace:rw`
- `compositeVerifier(workspaceDir)` → runs tsc/vitest against worktree
- `llmJudge(workspaceDir, ...)` → diffs against worktree
- `captureBaselineSha(workspaceDir)` → captures HEAD in worktree
- `GitHubPRCreator(workspaceDir)` → pushes branch from worktree

No downstream component needs modification — they all accept `workspaceDir` as a parameter and are path-agnostic.

### Docker Volume Mount Change

The Docker volume mount in `buildDockerRunArgs` is `-v workspaceDir:/workspace:rw`. With worktrees, `workspaceDir` becomes the worktree path instead of the main repo path. The mount is otherwise identical — the agent sees `/workspace` regardless.

**Not modified:** `src/cli/docker/index.ts` — `buildDockerRunArgs` is unchanged. The caller (`ClaudeCodeSession`) passes the worktree path as `workspaceDir`.

### Branch Name Available for PR Creation

The worktree creates a branch named `agent/{sessionId}`. `GitHubPRCreator` currently auto-generates branch names or accepts a `branchOverride`. With worktrees, the branch already exists in git, so `GitHubPRCreator` should use the worktree's branch rather than creating a new one.

**Modified:** `src/orchestrator/pr-creator.ts` — Accept an optional `worktreeBranch` param in `PRCreatorOptions`. When present, push from that branch instead of generating a new one.

### Cleanup Invariant

Cleanup must run in a `finally` block in `runAgent()` — not after `orchestrator.run()` returns normally — because:
- The session may be cancelled via `AbortSignal`
- `orchestrator.run()` may throw on unexpected errors
- Zombie worktrees accumulate disk space

`WorktreeManager.remove()` is best-effort (catches and logs all errors) to avoid masking the actual run result.

### Concurrent Run Safety

Worktrees share the `.git` object store. Git handles concurrent reads safely. Concurrent writes to the object store (two agents committing simultaneously) are safe — git uses its own locking for pack operations. The isolation is at the working-tree level: each worktree has its own index file, HEAD file, and working directory. Two agents can commit to different branches concurrently without conflict.

The one shared risk is `git worktree prune` running during active sessions. This is avoided by using `git worktree remove` per session (explicit) rather than relying on prune.

### SessionId for Worktree Naming

`ClaudeCodeSession` already generates a `sessionId` (UUID) per session. `runAgent()` needs to generate this ID before the session starts so it can pass it to both `WorktreeManager.create()` and `ClaudeCodeSession`. The session ID can be generated in `runAgent()` and threaded through `SessionConfig`.

**Modified:** `src/types.ts` — Add optional `sessionId?: string` to `SessionConfig`. When set, `ClaudeCodeSession` uses it instead of generating its own. This enables the worktree branch name to match the container name.

### What Is Unchanged

- `ClaudeCodeSession` — receives `workspaceDir` (now the worktree path) via `SessionConfig`, no other changes
- `compositeVerifier` — path-agnostic, works on any directory
- `llmJudge` — path-agnostic
- `buildDockerRunArgs` — path-agnostic
- `processInput()`, intent parser, REPL, Slack — entirely unaffected (worktree is below the `runAgent()` boundary)
- `GitHubPRCreator` — minor addition of optional `worktreeBranch` parameter

---

## Feature 2: Repo Exploration Tasks

### Problem Being Solved

Some useful tasks are purely investigative: "what is the CI strategy for this repo?", "summarize the project structure", "what test coverage exists?". These do not change any files. They run the agent in read-only mode and return a structured report rather than a diff. The existing `generic` task type assumes code changes will happen (it runs the full verifier loop, creates a branch for PR). Exploration tasks need a different output path.

### New Task Type: `investigation`

A new `taskType: 'investigation'` flows through the intent parser as a distinct category. The intent parser identifies it when the task is read-only/analytical ("explain", "describe", "analyze", "show me", "what is", "list", "find").

**Modified:** `src/intent/types.ts`

```typescript
export const TASK_TYPES = [
  'npm-dependency-update',
  'maven-dependency-update',
  'generic',
  'investigation',   // NEW
] as const;
```

### How Exploration Differs from Code Change

| Dimension | Code change (`generic`) | Exploration (`investigation`) |
|-----------|------------------------|-------------------------------|
| Docker mount | `:rw` (read-write) | `:ro` (read-only) |
| Branch creation | Yes (worktree or main branch) | No branch needed |
| Verification | compositeVerifier + LLM Judge | Skipped entirely |
| Retry loop | Up to 3 retries | Single attempt only |
| Output | `RetryResult.finalStatus` = success/failed | `RetryResult.finalStatus` = success + `finalResponse` populated |
| PR creation | Optional | Never |
| Zero-diff check | Yes (blocks retry) | Not applicable |

### Docker Mount for Read-Only

The key distinction: `docker run -v workspaceDir:/workspace:ro` instead of `:rw`. This prevents the agent from accidentally or deliberately modifying files during an investigation task.

**Modified:** `src/cli/docker/index.ts` — `buildDockerRunArgs` accepts a new `readOnly?: boolean` option in `DockerRunOptions`. When `true`, the workspace mount uses `:ro`.

```typescript
export interface DockerRunOptions {
  workspaceDir: string;
  apiKey: string;
  sessionId: string;
  networkName?: string;
  imageTag?: string;
  readOnly?: boolean;   // NEW — defaults to false (existing behavior)
}

// Volume mount line change:
'-v', `${opts.workspaceDir}:/workspace:${opts.readOnly ? 'ro' : 'rw'}`,
```

**Modified:** `src/orchestrator/claude-code-session.ts` — `SessionConfig` gains `readOnly?: boolean`. The session passes this to `buildDockerRunArgs`.

### Exploration Does Not Use Worktrees

Worktrees are for concurrent write isolation. A read-only investigation task has no writes to isolate. Investigation tasks mount the main repo directly at its current HEAD — no branch creation, no worktree lifecycle.

**Modified:** `src/agent/index.ts` — The worktree creation is conditional on `options.taskType !== 'investigation'`.

### Output: Report as `finalResponse`

The exploration agent's output is Claude's final text response. This already flows through `SessionResult.finalResponse` (a field that exists since v2.3's `TaskHistoryEntry` follow-up enrichment). No new types are needed — `RetryResult.sessionResults[0].finalResponse` contains the report.

**No new types required.** The REPL and Slack adapters display `finalResponse` for investigation tasks using the same rendering path used for the `history` command enrichment.

### Intent Parser Changes

The LLM parser needs to recognize investigation tasks. Investigative verbs include: "analyze", "explain", "describe", "show", "list", "find", "summarize", "check", "review", "audit", "what is", "how does", "explore".

**Modified:** `src/intent/llm-parser.ts` — Add `investigation` to the output schema. The system prompt is updated with examples: "analyze the CI setup" → `taskType: 'investigation'`. The fast-path parser does NOT handle investigation (no regex shortcut — these are complex NL queries that need LLM judgment).

The refactoring verb guard (which blocks misclassification of "replace X with Y" as dep-update) remains unchanged — investigation tasks are not dep-update candidates.

### Verification Bypass

`RetryOrchestrator` runs the full verify loop for all tasks. Investigation tasks short-circuit this:

**Modified:** `src/orchestrator/retry.ts` — The retry loop checks if `retryConfig.skipVerification` is set. When true, verification is skipped entirely after the session succeeds. The `RetryConfig` interface gains:

```typescript
export interface RetryConfig {
  maxRetries: number;
  verifier?: (...) => Promise<VerificationResult>;
  judge?: (...) => Promise<JudgeResult>;
  maxJudgeVetoes?: number;
  preVerify?: (...) => Promise<void>;
  skipVerification?: boolean;   // NEW — true for investigation tasks
}
```

**Modified:** `src/agent/index.ts` — When `options.taskType === 'investigation'`, pass `skipVerification: true` and `maxRetries: 1` to `RetryOrchestrator`.

### Prompt for Investigation Tasks

**New file:** `src/prompts/investigation.ts`

The investigation prompt instructs the agent that it is in read-only analysis mode:

```
You are analyzing the repository at /workspace. Do not modify any files.
Your task: {description}

Provide a structured report covering your findings. Be specific — include file names,
directory paths, and concrete observations. End with a clear summary.
```

**Modified:** `src/prompts/index.ts` — `buildPrompt()` routes `taskType === 'investigation'` to `buildInvestigationPrompt()`.

### Output Rendering in Adapters

Investigation tasks return no diff, no PR, and no verification results. The REPL adapter renders `finalResponse` from the session result when `finalStatus === 'success'` and `taskType === 'investigation'`. This reuses the existing `sanitizeForDisplay()` function.

**Modified:** `src/cli/commands/repl.ts` — The result renderer checks `intent.taskType === 'investigation'` and displays `result.sessionResults[0]?.finalResponse` as the report output.

**Modified:** `src/slack/adapter.ts` — The Slack adapter posts the `finalResponse` as a thread reply (same pattern as other results). No Block Kit changes needed.

### What Is Unchanged

- `compositeVerifier` — not called for investigation tasks
- `llmJudge` — not called for investigation tasks
- `GitHubPRCreator` — not called for investigation tasks
- `ClaudeCodeSession.run()` — unmodified; it returns `finalResponse` regardless
- `WorktreeManager` — not invoked for investigation tasks
- `RetryResult` type — no new fields needed

---

## System Overview: v2.4 Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                         ADAPTERS (I/O)                              │
│                                                                     │
│   CLI REPL           One-Shot         Slack Bot                     │
│   (unchanged)        (unchanged)      (unchanged)                   │
└──────────────────────────────────────────────────────┬─────────────┘
                                                        │
┌─────────────────────────────────────────────────────▼─────────────┐
│                      SESSION CORE (unchanged)                       │
│   processInput() → parseIntent() → clarify → confirm → runAgent()  │
│   investigation taskType routes through same processInput() flow    │
└───────────────────────────────────────────────┬────────────────────┘
                                                 │
┌────────────────────────────────────────────────▼───────────────────┐
│                    INTENT LAYER (minor addition)                     │
│   parseIntent() — adds 'investigation' to TASK_TYPES enum          │
│   LLM schema: investigation verbs → taskType: 'investigation'       │
└───────────────────────────────────────────────┬────────────────────┘
                                                 │
┌────────────────────────────────────────────────▼───────────────────┐
│                    PROMPT LAYER (new route)                          │
│   buildPrompt()                                                     │
│   ├─> buildMavenPrompt()       (unchanged)                          │
│   ├─> buildNpmPrompt()         (unchanged)                          │
│   ├─> buildGenericPrompt()     (unchanged)                          │
│   └─> buildInvestigationPrompt() NEW — read-only analysis prompt    │
└───────────────────────────────────────────────┬────────────────────┘
                                                 │
┌────────────────────────────────────────────────▼───────────────────┐
│                    AGENT ENTRY POINT (modified)                      │
│   runAgent(options, context)                                        │
│                                                                     │
│   if taskType !== 'investigation':                                  │
│     worktreeInfo = WorktreeManager.create(sessionId)   NEW         │
│     workspaceDir = worktreeInfo.worktreeDir             CHANGED     │
│   else:                                                             │
│     workspaceDir = options.repo  (main checkout, unchanged)        │
│                                                                     │
│   RetryOrchestrator({ workspaceDir, ... })                         │
│   finally: WorktreeManager.remove(worktreeInfo)  NEW               │
└──────────────┬──────────────────────────────────┬──────────────────┘
               │ code-change tasks                │ investigation tasks
┌──────────────▼──────────────┐  ┌────────────────▼───────────────┐
│    EXECUTION (code change)  │  │  EXECUTION (investigation)      │
│                             │  │                                  │
│  RetryOrchestrator          │  │  RetryOrchestrator               │
│  (maxRetries: 3)            │  │  (maxRetries: 1,                 │
│                             │  │   skipVerification: true)        │
│  ClaudeCodeSession          │  │  ClaudeCodeSession               │
│  Docker: :rw mount          │  │  Docker: :ro mount  CHANGED     │
│  workspaceDir = worktree    │  │  workspaceDir = main repo        │
│                             │  │                                  │
│  compositeVerifier ✓        │  │  compositeVerifier skipped      │
│  llmJudge ✓                 │  │  llmJudge skipped               │
│  GitHubPRCreator (opt) ✓    │  │  GitHubPRCreator skipped        │
└──────────────────────────── ┘  └─────────────────────────────────┘
```

---

## New vs Modified vs Unchanged

### New Components

| Component | File | Purpose |
|-----------|------|---------|
| `WorktreeManager` | `src/orchestrator/worktree.ts` | Lifecycle for worktree create/remove/prune |
| `WorktreeInfo` type | `src/orchestrator/worktree.ts` | Worktree path + branch name for a session |
| `buildInvestigationPrompt()` | `src/prompts/investigation.ts` | Read-only analysis prompt |

### Modified Components

| Component | File | Change | Scope |
|-----------|------|--------|-------|
| `runAgent()` | `src/agent/index.ts` | Worktree create/cleanup for non-investigation; `readOnly` flag for investigation | ~30 lines |
| `buildDockerRunArgs()` | `src/cli/docker/index.ts` | Add `readOnly?: boolean` to `DockerRunOptions`; `:ro` mount when true | ~5 lines |
| `ClaudeCodeSession` | `src/orchestrator/claude-code-session.ts` | Pass `readOnly` from `SessionConfig` to `buildDockerRunArgs` | ~3 lines |
| `SessionConfig` | `src/types.ts` | Add `sessionId?: string`, `readOnly?: boolean` | Additive fields |
| `RetryConfig` | `src/types.ts` | Add `skipVerification?: boolean` | Additive field |
| `RetryOrchestrator.run()` | `src/orchestrator/retry.ts` | Short-circuit verification when `skipVerification: true` | ~10 lines |
| `PRCreatorOptions` | `src/orchestrator/pr-creator.ts` | Add optional `worktreeBranch?: string` | Additive field |
| `TASK_TYPES` | `src/intent/types.ts` | Add `'investigation'` | Additive enum value |
| `IntentSchema` | `src/intent/types.ts` | `z.enum([..., 'investigation'])` | Additive |
| `buildPrompt()` | `src/prompts/index.ts` | Route `investigation` to `buildInvestigationPrompt()` | ~5 lines |
| LLM system prompt | `src/intent/llm-parser.ts` | Add investigation verb examples; update schema | ~10 lines |
| REPL result renderer | `src/cli/commands/repl.ts` | Display `finalResponse` for investigation results | ~10 lines |
| Slack adapter | `src/slack/adapter.ts` | Post `finalResponse` for investigation results | ~5 lines |

### Entirely Unchanged

- `src/orchestrator/verifier.ts` — called by `RetryOrchestrator`; unchanged when `skipVerification: true` bypasses it
- `src/orchestrator/judge.ts` — unchanged
- `src/orchestrator/summarizer.ts` — unchanged
- `src/orchestrator/metrics.ts` — unchanged
- `src/repl/session.ts` — `processInput()` is unchanged; `runAgent()` handles the worktree/exploration split
- `src/repl/types.ts` — `SessionCallbacks`, `ReplState`, `TaskHistoryEntry` unchanged
- `src/intent/fast-path.ts` — fast-path does not handle investigation
- `src/intent/context-scanner.ts` — unchanged
- `src/intent/confirm-loop.ts` — unchanged
- `src/mcp/verifier-server.ts` — unchanged (still used by code-change sessions)
- `src/agent/registry.ts` — unchanged
- `src/prompts/maven.ts`, `npm.ts`, `generic.ts` — unchanged
- `src/slack/bot.ts`, `state.ts` — unchanged
- `src/cli/commands/one-shot.ts` — unchanged (investigation tasks work via one-shot too)
- `docker/Dockerfile` — unchanged (image supports both read-write and read-only mounts)

---

## Data Flows

### Concurrent Code-Change Flow (with worktrees)

```
User: "update lodash to 4.17.21" (session A)
User: "bump axios to 1.7.0"     (session B, concurrent)

Session A:
  runAgent({ repo: '/repos/my-app', taskType: 'npm-dependency-update', ... })
    sessionId = 'abc123'
    worktreeInfo = WorktreeManager.create('abc123')
      → git worktree add ../my-app-agent-abc123 -b agent/abc123
      → worktreeDir = '/repos/my-app-agent-abc123'
    RetryOrchestrator({ workspaceDir: '/repos/my-app-agent-abc123' })
      → docker run -v /repos/my-app-agent-abc123:/workspace:rw ...
      → agent edits package.json in /repos/my-app-agent-abc123
      → host: git diff, npm install, tsc, vitest (all in worktreeDir)
    GitHubPRCreator('/repos/my-app-agent-abc123')
      → pushes branch agent/abc123
  finally: WorktreeManager.remove(worktreeInfo)
      → git worktree remove /repos/my-app-agent-abc123
      → git branch -d agent/abc123 (optional, or kept for the pushed PR)

Session B (concurrent, independent):
  runAgent({ repo: '/repos/my-app', ... })
    sessionId = 'def456'
    worktreeInfo.worktreeDir = '/repos/my-app-agent-def456'
    ... same flow, no interaction with session A
```

### Investigation Flow

```
User: "explain the CI pipeline for this repo"

processInput()
  └─> parseIntent() → taskType: 'investigation', confidence: 'high'
  └─> callbacks.confirm() → user confirms
  └─> runAgent({ taskType: 'investigation', repo: '/repos/my-app', ... })
       workspaceDir = '/repos/my-app'  (main checkout, NO worktree)
       RetryOrchestrator({
         workspaceDir: '/repos/my-app',
         maxRetries: 1,
         skipVerification: true,
         // verifier and judge not provided
       })
       ClaudeCodeSession({ workspaceDir, readOnly: true })
         → docker run -v /repos/my-app:/workspace:ro ...
         → agent reads .github/workflows/*.yml, README.md, Makefile
         → returns structured report as finalResponse
       RetryResult {
         finalStatus: 'success',
         sessionResults: [{
           finalResponse: "CI pipeline analysis:\n\n1. Build: ...\n2. Test: ..."
         }]
       }
  └─> REPL adapter displays sessionResults[0].finalResponse as the report
```

---

## Architectural Patterns

### Pattern 1: `workspaceDir` as the Single Isolation Seam

**What:** All downstream components (Docker mount, git ops, verifier, judge) already accept `workspaceDir` as a parameter. Changing what `workspaceDir` points to (main repo vs. worktree) changes isolation behavior without touching any downstream code.

**When to use:** Any new isolation strategy (worktrees, temp dirs, network shares) only needs to change `workspaceDir` passed to `RetryOrchestrator`. No other component changes.

**Trade-offs:** The seam is implicit — components don't know they're in a worktree. This is intentional: isolation is an infrastructure concern, not a business logic concern.

### Pattern 2: Capability Gating via `RetryConfig` Flags

**What:** `RetryOrchestrator` is already configurable via `RetryConfig` (verifier, judge, preVerify, maxRetries). Adding `skipVerification` extends this pattern rather than adding a new code path.

**When to use:** Any time a task type needs different retry/verification behavior, add a flag to `RetryConfig` rather than branching in `runAgent()`.

**Trade-offs:** `RetryConfig` grows. Offset by: each flag is optional with clear semantics, and the orchestrator is the right owner for these decisions.

### Pattern 3: Task Type Routing at `buildPrompt()`

**What:** The `buildPrompt()` dispatcher already routes by `taskType`. Adding `investigation` as a new case follows the established pattern (maven, npm, generic all work this way).

**When to use:** Any new task type with distinct prompt requirements adds a `buildXPrompt()` function and a case in `buildPrompt()`.

### Pattern 4: Read-Only as a `SessionConfig` Flag

**What:** The Docker mount mode (`:rw` vs. `:ro`) is set by `readOnly` in `SessionConfig`, not by the task type directly. `runAgent()` sets `readOnly: true` for investigation tasks. `ClaudeCodeSession` passes it to `buildDockerRunArgs()`.

**When to use:** Any future security-sensitive execution mode (e.g., a "sandbox preview" mode) can use the same flag without changing the Docker args builder's interface.

---

## Anti-Patterns

### Anti-Pattern 1: Sharing the Main Checkout for Concurrent Writes

**What people do:** Skip worktrees, assume sequential execution, add file-level locks.

**Why it's wrong:** The existing `git reset --hard` cleanup in `RetryOrchestrator.resetWorkspace()` would destroy another session's work. The LLM Judge's `captureBaselineSha` would pick up the wrong HEAD. Two agents on the same branch create git conflicts on commit.

**Do this instead:** Worktrees give each session a fully isolated working tree. The main checkout is never touched during agent execution.

### Anti-Pattern 2: Running Worktree Cleanup Inside the Container

**What people do:** Have the agent run `git worktree remove` as a Bash tool call inside Docker.

**Why it's wrong:** The container user (UID 1001) cannot write to the `.git/` directory — this is an established constraint in the codebase (see PROJECT.md Key Decisions). Cleanup must always run on the host.

**Do this instead:** `WorktreeManager.remove()` runs on the host in `runAgent()`'s `finally` block.

### Anti-Pattern 3: Mounting the Entire Parent Directory for Worktrees

**What people do:** To make the worktree visible inside the container, mount the parent directory `/repos/` instead of the worktree itself.

**Why it's wrong:** Mounts the entire repos directory, exposing sibling repositories. Breaks the workspace boundary — the agent at `/workspace` would see multiple repos.

**Do this instead:** Mount only the worktree directory itself (`-v /repos/my-app-agent-abc123:/workspace:rw`). The worktree is self-contained as a directory; it does not need to see its parent.

### Anti-Pattern 4: Using Worktrees for Investigation Tasks

**What people do:** Create a worktree for investigation tasks to ensure a "clean" read-only state.

**Why it's wrong:** Worktrees are for write isolation. An investigation task is already isolated by the `:ro` Docker mount — the agent cannot modify files. Creating a worktree adds overhead (disk copy, branch creation, cleanup) with no benefit.

**Do this instead:** Investigation tasks use the main checkout with a `:ro` mount.

### Anti-Pattern 5: Skipping Cleanup on Agent Error

**What people do:** Only call `WorktreeManager.remove()` on the success path.

**Why it's wrong:** Worktrees accumulate as orphans after cancellations, timeouts, or unexpected errors. In a busy environment this consumes significant disk (each worktree duplicates the working tree).

**Do this instead:** `WorktreeManager.remove()` always runs in `finally { }` regardless of outcome.

---

## Component Boundaries (v2.4 Target)

```
src/
├── intent/
│   ├── types.ts              MODIFY: add 'investigation' to TASK_TYPES
│   ├── llm-parser.ts         MODIFY: investigation verb examples in system prompt
│   ├── fast-path.ts          NO CHANGE (no fast-path for investigation)
│   ├── context-scanner.ts    NO CHANGE
│   ├── confirm-loop.ts       NO CHANGE
│   └── index.ts              NO CHANGE
├── prompts/
│   ├── index.ts              MODIFY: route 'investigation' to buildInvestigationPrompt
│   ├── investigation.ts      NEW: read-only analysis prompt
│   ├── generic.ts            NO CHANGE
│   ├── maven.ts              NO CHANGE
│   └── npm.ts                NO CHANGE
├── orchestrator/
│   ├── worktree.ts           NEW: WorktreeManager (create/remove/prune)
│   ├── retry.ts              MODIFY: skipVerification flag check
│   ├── claude-code-session.ts MODIFY: pass readOnly to buildDockerRunArgs
│   ├── verifier.ts           NO CHANGE
│   ├── judge.ts              NO CHANGE
│   ├── pr-creator.ts         MODIFY: optional worktreeBranch in PRCreatorOptions
│   ├── summarizer.ts         NO CHANGE
│   └── metrics.ts            NO CHANGE
├── agent/
│   └── index.ts              MODIFY: worktree lifecycle; readOnly flag for investigation
├── cli/
│   ├── docker/
│   │   └── index.ts          MODIFY: readOnly field in DockerRunOptions
│   └── commands/
│       └── repl.ts           MODIFY: render finalResponse for investigation results
├── slack/
│   └── adapter.ts            MODIFY: post finalResponse for investigation results
├── repl/                     NO CHANGE (all files)
├── mcp/                      NO CHANGE
└── types.ts                  MODIFY: sessionId?, readOnly? on SessionConfig; skipVerification? on RetryConfig
```

---

## Build Order

```
Phase 1: Tech Debt Cleanup
  (No feature dependencies; clears noise before new code)
       |
       v
Phase 2: Git Worktree Isolation
  (WorktreeManager + runAgent integration + SessionId threading)
       |
       v
Phase 3: Repo Exploration Tasks
  (Depends on: investigation taskType in intent layer; readOnly Docker mount)
  (Independent of: WorktreeManager — exploration skips worktrees)
```

### Phase 1 First: Tech Debt Cleanup

Dead code removal, exit code fixes, and accumulated tech debt items (documented in `PROJECT.md` Known Tech Debt) are completely independent of v2.4 features. Doing this first means the new feature code is written against a clean codebase, and the tech debt fixes don't accidentally regress the new feature work.

### Phase 2 Second: Git Worktree Isolation

`WorktreeManager` is a new file with no dependencies on exploration tasks. The integration into `runAgent()` modifies the `workspaceDir` threading — which is the foundational plumbing both features share. Building worktrees first establishes the pattern of `workspaceDir` as the isolation seam, which the exploration task PR-creator bypass also relies on.

The `sessionId` threading through `SessionConfig` (needed for worktree naming) also benefits exploration tasks indirectly — consistent session IDs improve log correlation across both task types.

### Phase 3 Third: Repo Exploration Tasks

Exploration depends on:
1. `readOnly` Docker mount support (built in Phase 2's docker changes, or added here)
2. `investigation` taskType in the intent layer (new, no prior dependency)
3. `skipVerification` in `RetryConfig` (new, no prior dependency)

Exploration does NOT depend on worktrees — the two features are cleanly independent after Phase 2 establishes the shared infrastructure.

---

## Integration Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| `runAgent()` → `WorktreeManager` | `create(sessionId)` → `WorktreeInfo` | Host-side; always in finally for cleanup |
| `runAgent()` → `RetryOrchestrator` | `workspaceDir` changed to worktree path | All downstream components receive this transparently |
| `runAgent()` → `RetryOrchestrator` | `skipVerification: true` for investigation | Bypasses verifier + judge entirely |
| `ClaudeCodeSession` → Docker | `readOnly` flag → `:ro` vs `:rw` mount | Investigation = `:ro`; code-change = `:rw` |
| `buildPrompt()` → `buildInvestigationPrompt()` | `taskType === 'investigation'` routing | New case in existing dispatcher |
| `processInput()` → `runAgent()` | No new params — `taskType` already flows | Session core unchanged |
| Adapter → `finalResponse` | `result.sessionResults[0].finalResponse` | Existing field, new display path for investigation |

---

## Sources

- `src/agent/index.ts` — `runAgent()` entry point, Docker lifecycle, `workspaceDir` threading — HIGH confidence
- `src/orchestrator/claude-code-session.ts` — `buildDockerRunArgs` call, `containerWorkspaceDir = '/workspace'`, `spawnClaudeCodeProcess` — HIGH confidence
- `src/cli/docker/index.ts` — `DockerRunOptions`, `-v workspaceDir:/workspace:rw` mount line — HIGH confidence
- `src/orchestrator/retry.ts` — `RetryConfig`, `RetryOrchestrator.run()`, `resetWorkspace()` cleanup pattern — HIGH confidence
- `src/types.ts` — `SessionConfig`, `RetryConfig`, `RetryResult` interfaces — HIGH confidence
- `src/intent/types.ts` — `TASK_TYPES` enum, `IntentSchema` — HIGH confidence
- `.planning/PROJECT.md` — v2.4 milestone spec, Key Decisions table (host-side git execution), Known Tech Debt — HIGH confidence
- [BSWEN Worktree Isolation](https://docs.bswen.com/blog/2026-03-18-ai-agent-worktree-isolation/) — worktree filesystem layout, create/cleanup pattern — MEDIUM confidence
- [Upsun: Git Worktrees for Parallel AI Agents](https://devcenter.upsun.com/posts/git-worktrees-for-parallel-ai-coding-agents/) — concurrent run safety, Docker volume interaction — MEDIUM confidence
- [Jon Roosevelt: Worktrees Ate My Edits](https://jonroosevelt.com/blog/git-worktrees-broke-dedicated-machines-fixed-it) — shared `.git` pitfalls, isolation invariants — MEDIUM confidence
- [OpenLibrary Docker Compose Issue](https://github.com/internetarchive/openlibrary/issues/11920) — sibling worktree mount pattern confirmation — MEDIUM confidence

---

*Architecture research for: v2.4 Git Worktree Isolation + Repo Exploration Tasks — background coding agent*
*Researched: 2026-04-05*
