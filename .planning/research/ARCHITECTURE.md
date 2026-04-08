# Architecture Research

**Domain:** v3.0 Program Automator — sweeping-refactor capability integration into existing TypeScript background coding agent
**Researched:** 2026-04-08
**Confidence:** HIGH (direct source code analysis of all integration-relevant files)

## Context: What This Research Is

This is an integration analysis for v3.0. The system is fully operational at v2.4. The question is: how do the eight v3.0 capabilities slot into the existing pipeline without breaking existing task flows, while respecting the architectural invariants established across 27 phases?

Every component below is classified as NEW, MODIFIED, or UNTOUCHED with the specific file and the nature of the change.

---

## Current Architecture (v2.4 Baseline)

```
┌────────────────────────────────────────────────────────────────────┐
│              Entry Points (src/cli/commands/, src/slack/)           │
│   one-shot.ts      repl.ts      slack/adapter.ts                   │
└───────────────────────────────────────────────────────┬────────────┘
                                                         │
┌───────────────────────────────────────────────────────▼────────────┐
│              Intent Layer (src/intent/)                              │
│   explorationFastPath() → fastPathParse() → llmParse()             │
│   parseIntent() → ResolvedIntent { taskType, repo, ... }           │
└───────────────────────────────────────────────────────┬────────────┘
                                                         │
┌───────────────────────────────────────────────────────▼────────────┐
│              Scoping Dialogue + Confirm Loop                         │
│   repl/session.ts::runScopingDialogue()                            │
│   intent/confirm-loop.ts::confirmLoop()                            │
└───────────────────────────────────────────────────────┬────────────┘
                                                         │
┌───────────────────────────────────────────────────────▼────────────┐
│              runAgent() (src/agent/index.ts)                         │
│                                                                     │
│   ┌──────────────────────┐   ┌─────────────────────────────────┐   │
│   │ Investigation bypass │   │ Worktree lifecycle               │   │
│   │ :ro Docker mount     │   │ WorktreeManager.create()        │   │
│   │ ClaudeCodeSession    │   │ RetryOrchestrator.run()         │   │
│   │ readOnly: true       │   │   ClaudeCodeSession per attempt  │   │
│   │ no verifier/judge/PR │   │   compositeVerifier             │   │
│   └──────────────────────┘   │   llmJudge                      │   │
│                               │   GitHubPRCreator (opt)         │   │
│                               │ WorktreeManager.remove()        │   │
│                               └─────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────┘
                                          │
┌─────────────────────────────────────────▼──────────────────────────┐
│   ClaudeCodeSession (src/orchestrator/claude-code-session.ts)       │
│   query() → Docker (iptables, uid 1001, :rw or :ro mount)          │
│   PreToolUse hook (path guard + read-only Write/Edit block)         │
│   MCP verifier server (in-process, mcp__verifier__verify)          │
│   PostToolUse hook (audit log)                                      │
└────────────────────────────────────────────────────────────────────┘
```

### Key Architectural Invariants (Do Not Break)

| Invariant | Location | Why Fixed |
|-----------|----------|-----------|
| `WorktreeManager` single-use per session | `src/agent/index.ts` try/finally | No shared state, no leaks — explicit in key decisions |
| `pruneOrphans` treats dead-PID worktrees as orphans | `src/agent/worktree-manager.ts` | Crash recovery mechanism; must remain reliable |
| `compositeVerifier` signature `(workspaceDir, options?)` | `src/types.ts` RetryConfig.verifier | Used by RetryOrchestrator AND MCP verifier server; neither can change |
| Investigation bypass skips verifier/judge/PR | `src/agent/index.ts` | Read-only tasks have no diff to verify |
| Docker :ro mount + PreToolUse Write/Edit block (two layers) | `src/cli/docker/index.ts`, `claude-code-session.ts` | Defence in depth; neither can be bypassed alone |
| `runAgent()` is single-session (one prompt, one worktree) | `src/agent/index.ts` | The retry loop in RetryOrchestrator handles session retries, not runAgent |

---

## v3.0 Target Architecture

```
Entry Points
  ├── existing: one-shot.ts, repl.ts, slack/adapter.ts  [UNTOUCHED]
  └── new:      cli/commands/refactor.ts  [NEW: start/resume/status]
        │
        ▼
Intent Layer (src/intent/)
  sweepingRefactorFastPath() [NEW] → explorationFastPath() → fastPathParse() → llmParse()
  parseIntent() routes 'sweeping-refactor' taskType [MODIFIED]
        │
        ├── generic/dep-update/investigation → existing runAgent() path [UNTOUCHED]
        │
        └── sweeping-refactor ─────────────────────────────────────────────┐
                                                                             │
┌────────────────────────────────────────────────────────────────────────────▼───┐
│  RecipeRunner (src/refactor/runner.ts)  [NEW]                                   │
│  - loads + validates YAML recipe against Appendix A schema                      │
│  - strategy dispatch: deterministic | end-state-prompt | doc-grounded           │
│  - drives DiscoveryPassRunner [NEW] → targets.json                              │
│  - calls RefactorOrchestrator [NEW]                                             │
└────────────────────────────────────────────────────────────────────────────────┬┘
                                                                                  │
┌─────────────────────────────────────────────────────────────────────────────────▼┐
│  RefactorOrchestrator (src/refactor/orchestrator.ts)  [NEW]                      │
│  - owns RefactorRun (persistent JSON ledger in .bg-agent-runs/<runId>/)          │
│  - manages one long-lived worktree (createOrReuse, not per-session)              │
│  - per-chunk loop: pop pending target → call runAgent() → mark done/failed       │
│  - passes skipWorktree/skipWorktreeCleanup flags to each runAgent() call         │
└─────────────────────────────────────────────────────────────────────────────────┬┘
                                                                                   │
                                                                     (per chunk)   │
┌──────────────────────────────────────────────────────────────────────────────────▼┐
│  runAgent() (src/agent/index.ts)  [MODIFIED — new AgentContext flags]              │
│  skipWorktree: true (orchestrator owns lifecycle)                                  │
│  skipWorktreeCleanup: true (do not remove in finally)                              │
│  contextBundlePath: recipe.context.bundle (optional)                              │
│  envelopeConfig: recipe.envelope (turn/timeout overrides)                         │
│       │                                                                            │
│       └── RetryOrchestrator with DifferentialVerifier [NEW] + recipeSpec judge   │
└──────────────────────────────────────────────────────────────────────────────────-┘
                                          │
                               [ClaudeCodeSession — MODIFIED]
                               - second -v mount for /context/ :ro
                               - capability MCP tools registered when taskType=sweeping-refactor
```

---

## Component Classification

### NEW Components

| Component | File | Purpose |
|-----------|------|---------|
| `RefactorRun` entity + types | `src/refactor/types.ts` | Data model: runId, recipe, ledger entries, baseline, worktreePath, branch |
| `RefactorStateStore` | `src/refactor/state-store.ts` | JSON ledger persisted to `.bg-agent-runs/<runId>/state.json` and `targets.json` |
| `RecipeLoader` + Zod schema | `src/refactor/recipe.ts` | YAML load + validation against Appendix A recipe schema |
| `RecipeRunner` | `src/refactor/runner.ts` | Top-level: validate recipe → discovery → RefactorOrchestrator; strategy dispatch |
| `DiscoveryPassRunner` | `src/refactor/discovery.ts` | Executes discovery block → `targets.json` via read-only runAgent() |
| `RefactorOrchestrator` | `src/refactor/orchestrator.ts` | Multi-session loop: pop → runAgent() → mark done/failed → persist |
| `BaselineCapture` | `src/refactor/baseline.ts` | Captures build/test/lint snapshot at run start; stored on RefactorRun |
| `DifferentialVerifier` | `src/refactor/diff-verifier.ts` | Wrapper: closes over BaselineSnapshot, calls compositeVerifier, compares diff |
| `buildSweepingRefactorPrompt` | `src/prompts/sweeping-refactor.ts` | Per-chunk prompt builder (end-state discipline; recipe spec + target) |
| Capability MCP tools | `src/mcp/tools/config-edit.ts`, `ast-tools.ts`, `import-rewrite.ts`, `rewrite-run.ts`, `test-tools.ts`, `doc-retrieve.ts` | `config_edit`, `ast_query/rewrite`, `import_rewrite`, `rewrite_run`, `test_baseline/compare`, `doc_retrieve` |
| `RecipeInterviewDialogue` | `src/repl/recipe-interview.ts` | 4-question interview → RecipeDraft validated against recipe schema |
| `refactor` CLI subcommand | `src/cli/commands/refactor.ts` | `agent refactor start/resume/status` |

### MODIFIED Components

| Component | File | Change | Scope |
|-----------|------|--------|-------|
| `TASK_TYPES` + `TaskType` | `src/intent/types.ts` | Add `'sweeping-refactor'` to const array and union | ~2 lines |
| `sweepingRefactorFastPath()` | `src/intent/fast-path.ts` | New fast-path function: verbs "modernize all X to Y", "migrate all X", "refactor all X to Y" | ~20 lines |
| `parseIntent()` | `src/intent/index.ts` | Route sweeping-refactor before dep-update patterns; skip scoping questions path | ~10 lines |
| LLM parser system prompt + schema | `src/intent/llm-parser.ts` | Add sweeping-refactor examples; update schema enum | ~10 lines |
| `runScopingDialogue` caller | `src/repl/session.ts` | Branch to `runRecipeInterview()` when taskType=sweeping-refactor (Phase 34) | ~10 lines |
| `AgentContext` | `src/agent/index.ts` | Add `skipWorktreeCleanup?`, `contextBundlePath?`, `envelopeConfig?` fields | ~5 lines |
| `runAgent()` | `src/agent/index.ts` | Honor skipWorktreeCleanup in finally; pass contextBundlePath + envelopeConfig; sweeping-refactor task type routing | ~30 lines |
| `WorktreeManager.create()` | `src/agent/worktree-manager.ts` | Write `runId` into sentinel when provided; `pruneOrphans` skips live-run sentinels | ~20 lines |
| `SessionConfig` | `src/types.ts` | Add `contextBundlePath?: string`, `taskType?: string` | Additive fields |
| `RetryConfig` | `src/types.ts` | Add `baselineSnapshot?: BaselineSnapshot`, `recipeSpec?: string` | Additive fields |
| `buildDockerRunArgs()` | `src/cli/docker/index.ts` | Accept optional `contextBundlePath`; add second `-v` mount when set | ~5 lines |
| `ClaudeCodeSession.run()` | `src/orchestrator/claude-code-session.ts` | Pass contextBundlePath to buildDockerRunArgs; append context-bundle instructions to system prompt; conditionally register capability MCP tools | ~20 lines |
| `llmJudge()` | `src/orchestrator/judge.ts` | Add optional `recipeSpec` param; prepend as scope definition in judge prompt | ~15 lines |
| `compositeVerifier()` | `src/orchestrator/verifier.ts` | `testVerifier` returns structured test names for differential comparison (Phase 30 only) | ~20 lines |
| `buildPrompt()` dispatch | `src/prompts/index.ts` | Add `'sweeping-refactor'` case routing to `buildSweepingRefactorPrompt()` | ~5 lines |
| `createVerifierMcpServer` | `src/mcp/verifier-server.ts` | Export `createCapabilityToolsMcpServer()`; existing server unchanged | ~5 lines |

### UNTOUCHED Components

- `src/orchestrator/retry.ts` — RetryOrchestrator works for chunks as-is; DifferentialVerifier is passed via retryConfig.verifier
- `src/orchestrator/summarizer.ts`
- `src/orchestrator/metrics.ts`
- `src/orchestrator/pr-creator.ts`
- `src/repl/types.ts`
- `src/intent/context-scanner.ts`
- `src/intent/confirm-loop.ts`
- `src/agent/registry.ts`
- `src/prompts/generic.ts`, `maven.ts`, `npm.ts`, `exploration.ts`
- `src/slack/blocks.ts`, `src/slack/index.ts`, `src/slack/types.ts`
- `src/cli/commands/one-shot.ts`, `run.ts`, `projects.ts`, `repl.ts`
- `src/errors.ts`
- All existing test files (new components add new test files)

---

## Detailed Integration Analysis

### 1. RefactorRun Entity — Where It Lives

**Decision: JSON ledger at `.bg-agent-runs/<runId>/`**

The existing `conf@15` library (already in stack) uses atomic JSON writes. For the same pattern, `RefactorStateStore` writes to a project-relative `.bg-agent-runs/` directory using `fs.promises.writeFile` + atomic rename (`writeFile` to `.tmp`, then `fs.rename`).

```
.bg-agent-runs/
└── <runId>/
    ├── state.json       ← RefactorRun metadata: status, worktreePath, branch, baseline, timestamps
    ├── targets.json     ← LedgerEntry[]: { id, file, locator, kind, status, commitSha?, failReason?, attempts }
    └── recipe.yaml      ← verbatim copy of recipe (immutable history; recipe.version binds the run)
```

**Not SQLite.** `better-sqlite3` requires a native addon compiled separately for host (macOS/glibc) and Docker image (Alpine/musl). This is a two-platform build burden for no gain at single-repo, serial-chunk scale. Add SQLite only if `max_parallel > 1` (v3.1+) requires transaction isolation.

**Not extending `TaskHistoryEntry`.** `TaskHistoryEntry` (in `src/repl/types.ts`) is in-memory session history for multi-turn follow-up context. A `RefactorRun` persists across process restarts and has a completely different lifecycle. They are different concerns.

### 2. Long-Lived Worktree — Extending WorktreeManager Without Breaking Orphan Scan

The invariant: `pruneOrphans()` checks whether the PID in the sentinel is alive. This remains correct for run-owned worktrees IF the `RefactorOrchestrator` process is still alive — the sentinel's PID is the orchestrator process, which is alive for the entire run.

The problem is at the `runAgent()` boundary: its try/finally unconditionally removes the worktree.

**Solution: two new `AgentContext` flags**

```typescript
// src/agent/index.ts
export interface AgentContext {
  // ... existing fields ...
  skipWorktree?: boolean;         // EXISTING: skip creation for tests
  skipWorktreeCleanup?: boolean;  // NEW: skip removal in finally (orchestrator owns lifecycle)
  contextBundlePath?: string;     // NEW: mount at /context/ :ro
  envelopeConfig?: EnvelopeConfig; // NEW: per-chunk turn/timeout overrides
}
```

`RefactorOrchestrator` creates one `WorktreeManager` at run start and holds it for the run's lifetime. For each chunk call to `runAgent()`:

```typescript
await runAgent(
  { taskType: 'sweeping-refactor', repo: refactorRun.worktreePath, ... },
  { skipWorktree: true, skipWorktreeCleanup: true, contextBundlePath: ... }
);
```

`pruneOrphans` is extended to check: if a sentinel has a `runId` field, and `.bg-agent-runs/<runId>/state.json` exists with `status: 'running'`, skip it. If `state.json` is absent or `status` is terminal, treat as orphan.

```typescript
// Extended PidSentinel in src/agent/worktree-manager.ts
interface PidSentinel {
  pid: number;
  branch: string;
  createdAt: number;
  runId?: string;  // NEW: set for RefactorRun-owned worktrees
}
```

This preserves the invariant: a crashed `RefactorOrchestrator` leaves `state.json` with `status: 'running'` and a dead PID — the orphan scan's PID-liveness check still fires and prunes correctly.

### 3. Per-Chunk Session Loop — Where It Lives

**Decision: New `RefactorOrchestrator` class in `src/refactor/orchestrator.ts` — NOT inside RetryOrchestrator**

`RetryOrchestrator` is the inner retry loop: N attempts at the same task until it passes verification. `RefactorOrchestrator` is the outer work loop: N chunks against the same recipe until the ledger is exhausted. These are different abstractions.

```typescript
// src/refactor/orchestrator.ts
export class RefactorOrchestrator {
  constructor(
    private runId: string,
    private store: RefactorStateStore,
    private recipe: ValidatedRecipe,
  ) {}

  async run(options: OrchestratorOptions): Promise<RefactorRunResult> {
    // 1. Ensure worktree exists (createOrReuse)
    // 2. Capture baseline if not already captured
    // 3. while (pendingTargets.length > 0):
    //      target = store.popPending(runId)
    //      store.markInProgress(runId, target.id)
    //      result = await runAgent({ ..., skipWorktree: true, skipWorktreeCleanup: true })
    //      if (result.finalStatus === 'success'):
    //        sha = await gitCommit(worktreePath, target)
    //        store.markDone(runId, target.id, sha)
    //      else:
    //        store.markFailed(runId, target.id, result.error)
    //        // continue to next target — do not abort run
    // 4. Persist final run status
  }
}
```

The loop lives entirely in `RefactorOrchestrator`. `RetryOrchestrator` runs inside each `runAgent()` call for per-chunk retries, as today.

### 4. Differential Verification — Orchestrator Wraps the Verifier

**Decision: DifferentialVerifier is a higher-order function, NOT a modification to compositeVerifier**

The existing `RetryConfig.verifier` signature `(workspaceDir, options?) => Promise<VerificationResult>` is used by both `RetryOrchestrator` and the MCP verifier server. Modifying `compositeVerifier` to accept a `BaselineSnapshot` parameter would break the MCP server (which has no baseline context).

```typescript
// src/refactor/diff-verifier.ts
export function createDifferentialVerifier(
  baseline: BaselineSnapshot,
  verifyBlock: VerifyBlock,
): RetryConfig['verifier'] {
  return async (workspaceDir, options) => {
    const result = await compositeVerifier(workspaceDir, options);
    return applyDifferentialRules(result, baseline, verifyBlock);
  };
}
```

`RefactorOrchestrator` passes `createDifferentialVerifier(baseline, recipe.verification)` as the `retryConfig.verifier` for each chunk. Existing `runAgent()` calls for non-sweeping-refactor tasks continue to use `compositeVerifier` directly.

Phase 30 requires `testVerifier` to return structured test names (not just pass/fail) so `DifferentialVerifier` can compare which tests regressed. This is the one structural change to `verifier.ts`: extend `VerificationResult` with an optional `testResults?: TestResult[]` field.

### 5. Context Bundle Mount — Coexistence with Workspace Mount

`buildDockerRunArgs` currently produces one `-v` mount. Adding a second for `/context/` is additive:

```typescript
// src/cli/docker/index.ts
export interface DockerRunOptions {
  workspaceDir: string;
  apiKey: string;
  sessionId: string;
  networkName?: string;
  imageTag?: string;
  readOnly?: boolean;
  contextBundlePath?: string;  // NEW: absolute path; mounted at /context :ro
}
```

The Docker args builder appends the second mount when `contextBundlePath` is set:

```typescript
if (opts.contextBundlePath) {
  args.push('-v', `${opts.contextBundlePath}:/context:ro`);
}
```

The existing PreToolUse path-traversal check in `ClaudeCodeSession` already blocks writes outside `/workspace` — `/context` falls outside `/workspace`, so it is automatically protected without any hook changes. The second mount is defence-at-mount-level only; the SDK hook provides no additional coverage because the agent cannot reach `/context` via Write/Edit (they require paths starting with `/workspace`).

### 6. Capability Toolbox — Conditional MCP Server Registration

**Decision: Register capability tools only when `taskType === 'sweeping-refactor'`**

`ClaudeCodeSession.run()` already conditionally sets `readOnly`. The same pattern applies to capability tools:

```typescript
// src/orchestrator/claude-code-session.ts
const mcpServers: Record<string, unknown> = {
  verifier: verifierServer,
};
if (this.config.taskType === 'sweeping-refactor') {
  const { createCapabilityToolsMcpServer } = await import('../mcp/verifier-server.js');
  mcpServers.capability_tools = createCapabilityToolsMcpServer(workspaceDir);
}
```

`SessionConfig` gains `taskType?: string` — this is already present in `AgentOptions` and just needs threading through `runAgent()` → `SessionConfig`. No other component needs to know about the taskType.

Tools are registered in a separate MCP server (`capability_tools`), not mixed into the existing `verifier` server. This keeps the verifier server's test surface unchanged.

### 7. Recipe Runner — Position in the Architecture

**Decision: RecipeRunner is a parallel entry point alongside runAgent(), not inside it**

`runAgent()` is a single-session function. Its try/finally structure, Docker lifecycle, and worktree cleanup are all scoped to one session. Threading multi-session loops inside it would require significant refactoring and risk breaking existing task types.

`RecipeRunner` is called by:
1. `refactor` CLI subcommand (`agent refactor start`)
2. `processInput()` in REPL/Slack when `intent.taskType === 'sweeping-refactor'` and a recipe is confirmed

The call graph:

```
agent refactor start --recipe ./recipe.yaml
    └── RecipeRunner.start(recipe, options)
             │
             ├── DiscoveryPassRunner.run(recipe.discovery)
             │       └── runAgent({ taskType: 'investigation', readOnly: true })
             │           → targets.json (written host-side from finalResponse)
             │
             └── RefactorOrchestrator.run(runId, recipe, worktree)
                      └── loop: runAgent() per chunk
```

`RecipeRunner` does not call `runAgent()` directly for transform chunks — `RefactorOrchestrator` does. `RecipeRunner` owns recipe validation, strategy dispatch, and the top-level run lifecycle.

### 8. Conversational Recipe Authoring — Extending the Scoping Dialogue

The Phase 22 scoping dialogue (`runScopingDialogue()` in `src/repl/session.ts`) asks up to 3 generic questions for `generic` tasks. For `sweeping-refactor`, the four questions are fixed and structured (not LLM-generated):

1. "What marks a target site?" → recipe.discovery
2. "What should it become?" → recipe.transformation.spec
3. "How do we know it still works?" → recipe.verification
4. "Any docs I should read?" → recipe.context.bundle

**Integration point:** In `processInput()` in `src/repl/session.ts`, the existing branch for `generic` tasks calls `runScopingDialogue`. Add a parallel branch for `sweeping-refactor` that calls `runRecipeInterview()` from the new `src/repl/recipe-interview.ts` module.

```typescript
// src/repl/session.ts (Phase 34 addition)
if (intent.taskType === 'sweeping-refactor' && !options.recipeFile) {
  const recipeDraft = await runRecipeInterview(intent, callbacks.askQuestion);
  if (recipeDraft === null) return { status: 'cancelled' };
  // recipeDraft is a ValidatedRecipe — pass to RecipeRunner
}
```

The existing `runScopingDialogue` is unchanged. The new `runRecipeInterview` is a separate function in a new file. The REPL and Slack callers use it via `SessionCallbacks.askQuestion` — the same channel-agnostic interface already used by the scoping dialogue.

---

## Recommended Project Structure (v3.0 additions)

```
src/
├── agent/
│   ├── index.ts              MODIFIED: skipWorktreeCleanup, contextBundlePath, envelopeConfig
│   └── worktree-manager.ts   MODIFIED: runId in sentinel, pruneOrphans live-run check
├── cli/
│   ├── commands/
│   │   └── refactor.ts       NEW: start/resume/status subcommands
│   └── docker/
│       └── index.ts          MODIFIED: contextBundlePath → second -v mount
├── intent/
│   ├── fast-path.ts          MODIFIED: sweepingRefactorFastPath()
│   ├── index.ts              MODIFIED: route sweeping-refactor taskType
│   └── types.ts              MODIFIED: add 'sweeping-refactor'
├── mcp/
│   ├── verifier-server.ts    MODIFIED: export createCapabilityToolsMcpServer()
│   └── tools/                NEW directory
│       ├── config-edit.ts    NEW: roundtrip YAML/JSON with schema validation
│       ├── ast-tools.ts      NEW: ast_query + ast_rewrite (tree-sitter)
│       ├── import-rewrite.ts NEW: rename/replace imports across module system
│       ├── rewrite-run.ts    NEW: OpenRewrite/jscodeshift/semgrep bridge
│       ├── test-tools.ts     NEW: test_baseline + test_compare
│       └── doc-retrieve.ts   NEW: BM25 lookup over /context/ bundle
├── orchestrator/
│   ├── claude-code-session.ts MODIFIED: /context/ mount, capability tools registration
│   ├── judge.ts               MODIFIED: optional recipeSpec param in llmJudge()
│   └── verifier.ts            MODIFIED (Phase 30): testVerifier returns TestResult[]
├── prompts/
│   └── sweeping-refactor.ts   NEW: per-chunk prompt builder
├── refactor/                  NEW top-level module (zero contamination of existing paths)
│   ├── types.ts               NEW: RefactorRun, LedgerEntry, BaselineSnapshot, EnvelopeConfig
│   ├── state-store.ts         NEW: JSON ledger read/write
│   ├── recipe.ts              NEW: YAML loader + Zod validator (Appendix A schema)
│   ├── runner.ts              NEW: RecipeRunner (entry point + strategy dispatch)
│   ├── orchestrator.ts        NEW: RefactorOrchestrator (multi-chunk loop)
│   ├── discovery.ts           NEW: DiscoveryPassRunner
│   ├── baseline.ts            NEW: BaselineCapture
│   └── diff-verifier.ts       NEW: DifferentialVerifier (wraps compositeVerifier)
├── repl/
│   ├── session.ts             MODIFIED (Phase 34): branch to recipe interview
│   └── recipe-interview.ts   NEW: 4-question interview → RecipeDraft
└── types.ts                   MODIFIED: SessionConfig + RetryConfig extensions
```

**Rationale for `src/refactor/` as a top-level module:** Zero contamination of existing paths. The module boundary means Phases 28-33 can be built and tested in isolation. None of the new types or functions need to be imported by `src/orchestrator/`, `src/agent/`, or `src/intent/` until the explicit integration points listed above are wired.

---

## Data Flow

### Discovery Pass (Phase 28)

```
RecipeRunner.start(recipe)
    └── DiscoveryPassRunner.run(recipe.discovery)
             └── runAgent({ taskType: 'investigation', readOnly: true,
                             description: discoveryPrompt(recipe.discovery) })
                       │
                       └── ClaudeCodeSession (readOnly: true)
                                 agent uses grep/ast_query MCP tools
                                 returns finalResponse with JSON target list
             │
             DiscoveryPassRunner parses finalResponse → LedgerEntry[]
             RefactorStateStore.saveTargets(runId, entries)
             → .bg-agent-runs/<runId>/targets.json
             → .bg-agent-runs/<runId>/state.json  (all entries: 'pending')
```

Note: the agent cannot use the Write tool (readOnly: true blocks it). `targets.json` is written host-side by `DiscoveryPassRunner` after parsing `sessionResult.finalResponse`. This matches the existing pattern where `.reports/` files are written by the REPL, not the agent.

### Per-Chunk Transform Session (Phase 29)

```
RefactorOrchestrator.run(runId)
    │
    ├── WorktreeManager: create() for new run; reuse existing for resume
    ├── BaselineCapture.capture(worktreePath) → baseline stored in state.json
    │
    └── loop while store.pendingCount(runId) > 0:
          target = store.popPending(runId)
          store.markInProgress(runId, target.id)
          │
          result = await runAgent({
            taskType: 'sweeping-refactor',
            repo: refactorRun.worktreePath,       ← pre-created worktree path
            description: buildSweepingRefactorPrompt(recipe, target),
            contextBundlePath: recipe.context?.bundle,
            envelopeConfig: recipe.envelope,       ← max_turns, timeout_seconds
          }, {
            skipWorktree: true,                    ← orchestrator owns lifecycle
            skipWorktreeCleanup: true,
          })
          │
          inside runAgent():
            RetryOrchestrator(
              verifier: createDifferentialVerifier(baseline, recipe.verification),
              judge: llmJudge with recipeSpec: recipe.transformation.spec
            )
          │
          if result.finalStatus === 'success':
            sha = execFile('git', ['commit', ...], { cwd: worktreePath })
            store.markDone(runId, target.id, sha)
          else:
            store.markFailed(runId, target.id, result.error ?? result.finalStatus)
            // continue — single chunk failure does not abort run
```

### Context Bundle Mount (Phase 31)

```
agent refactor start --context-bundle ./scio-migration-guide/
    └── RecipeRunner → RefactorOrchestrator → runAgent({ contextBundlePath: '/abs/path/scio-migration-guide' })
             │
             └── ClaudeCodeSession.run()
                       buildDockerRunArgs({ ..., contextBundlePath })
                       → docker run -v /workspace:rw -v /abs/path/scio-migration-guide:/context:ro ...
                       │
                       system prompt appended:
                       "A read-only reference bundle is available at /context/.
                        Use mcp__capability_tools__doc_retrieve to look up migration guidance
                        before editing each target site."
```

### State Store Schema

```typescript
// src/refactor/types.ts

export interface RefactorRun {
  runId: string;            // UUID, immutable
  recipe: ValidatedRecipe;  // verbatim parsed recipe
  status: 'running' | 'completed' | 'paused' | 'failed';
  worktreePath: string;
  branch: string;
  baseline: BaselineSnapshot | null;
  createdAt: number;
  updatedAt: number;
}

export interface LedgerEntry {
  id: string;               // UUID per target
  file: string;
  locator: string;          // line:N | jsonpath:$.a.b | symbol:Foo
  kind: string;
  status: 'pending' | 'in-progress' | 'done' | 'failed' | 'skipped';
  commitSha?: string;
  failReason?: string;
  attempts: number;
}

export interface BaselineSnapshot {
  buildPassed: boolean;
  testResults: TestResult[];        // { name: string; passed: boolean }[]
  lintErrorCount: number;
  capturedAt: number;
}
```

---

## Build Order and Phase Dependencies

```
Phase 28: Sweeping-Refactor Task Type + Discovery Pass
│
│  NEW:  src/refactor/types.ts
│        src/refactor/state-store.ts
│        src/refactor/discovery.ts
│        src/prompts/sweeping-refactor.ts
│  MOD:  src/intent/types.ts         (add 'sweeping-refactor')
│        src/intent/fast-path.ts     (sweepingRefactorFastPath)
│        src/intent/index.ts         (routing)
│        src/prompts/index.ts        (dispatch case)
│
│  No dependency on Phase 29+. Can be built and verified independently.
│
▼
Phase 29: RefactorRun Orchestrator
│
│  NEW:  src/refactor/orchestrator.ts
│        src/refactor/baseline.ts
│        src/cli/commands/refactor.ts
│  MOD:  src/agent/index.ts          (skipWorktreeCleanup, contextBundlePath, envelopeConfig)
│        src/agent/worktree-manager.ts (runId in sentinel, pruneOrphans live-run check)
│        src/types.ts                (SessionConfig + RetryConfig new fields)
│
│  REQUIRES Phase 28 (consumes targets.json from discovery)
│
▼
Phase 30: Differential Verification     Phase 31: Context Bundle + Judge Scope
│                                        │
│  NEW:  src/refactor/diff-verifier.ts  │  MOD: src/cli/docker/index.ts
│  MOD:  src/orchestrator/verifier.ts   │       src/orchestrator/claude-code-session.ts
│        (testVerifier structured names)│       src/orchestrator/judge.ts (recipeSpec)
│                                        │       src/types.ts (contextBundlePath)
│  REQUIRES Phase 29 (baseline lives    │
│    on RefactorRun)                     │  REQUIRES Phase 29 (runAgent() path)
│
└──────────────────────────────────────┬─┘
                                        │ (both must complete before Phase 32)
                                        ▼
Phase 32: Recipe Format + Recipe Runner
│
│  NEW:  src/refactor/recipe.ts         (Zod schema + YAML loader)
│        src/refactor/runner.ts         (RecipeRunner + strategy dispatch)
│        recipes/                       (reference recipes at project root)
│
│  REQUIRES Phases 28, 29, 30, 31
│
▼
Phase 33: Capability Toolbox
│
│  NEW:  src/mcp/tools/ (6 tool files)
│  MOD:  src/mcp/verifier-server.ts    (export createCapabilityToolsMcpServer)
│        src/orchestrator/claude-code-session.ts (conditional registration)
│        docker/Dockerfile             (tree-sitter, OpenRewrite, jscodeshift, semgrep)
│
│  REQUIRES Phase 32 (recipes reference tools by name; reference recipes exercise tools)
│
▼
Phase 34: Conversational Recipe Authoring
│
│  NEW:  src/repl/recipe-interview.ts
│  MOD:  src/repl/session.ts           (branch to recipe interview)
│        src/slack/adapter.ts          (4-question flow for Slack)
│
│  REQUIRES Phase 32 (must emit valid recipe)
│  REQUIRES Phase 22 (scoping dialogue infrastructure — already shipped)
```

**Why Phases 30 and 31 are parallel:** They have no dependency on each other. Phase 30 modifies `verifier.ts` and creates `diff-verifier.ts`. Phase 31 modifies `claude-code-session.ts`, `docker/index.ts`, and `judge.ts`. No shared files. Both phases require only Phase 29 as a prerequisite.

---

## Anti-Patterns to Avoid

### Anti-Pattern 1: Multi-Session Loop Inside runAgent()

**What people do:** Add a `forEachTarget` loop inside `runAgent()` for sweeping-refactor.
**Why it's wrong:** `runAgent()`'s try/finally worktree cleanup fires on the entire loop, not per-chunk. Partial failures (target 3 fails, resume from target 4) have no clean handling. The existing single-session exit statuses (`cancelled`, `zero_diff`, `vetoed`) become ambiguous across N chunks.
**Do this instead:** `runAgent()` stays single-session. `RefactorOrchestrator` owns the loop and passes `skipWorktree/skipWorktreeCleanup` flags.

### Anti-Pattern 2: Shared or Pooled WorktreeManager

**What people do:** Add instance-level "reuse" state (`isActive`, `refCount`) to `WorktreeManager` to share a worktree across sessions.
**Why it's wrong:** The key decisions log explicitly states `WorktreeManager single-use`. Pooling introduces shared mutable state that `pruneOrphans` cannot safely reason about — the PID sentinel maps one-to-one with one process.
**Do this instead:** `RefactorOrchestrator` holds one `WorktreeManager` for the run's lifetime and passes `skipWorktree/skipWorktreeCleanup` to each `runAgent()` call. The sentinel gets a `runId` field; `pruneOrphans` checks the state store.

### Anti-Pattern 3: Modifying compositeVerifier Signature for Baseline Comparison

**What people do:** Add `baseline?: BaselineSnapshot` to `compositeVerifier(workspaceDir, options?)` so it can compare in-place.
**Why it's wrong:** `compositeVerifier` is referenced as `RetryConfig.verifier` and called by the MCP verifier server (which has no baseline). Modifying the signature breaks both callers.
**Do this instead:** `DifferentialVerifier` is a wrapper that closes over the baseline and calls `compositeVerifier` internally. It is passed as `retryConfig.verifier` by `RefactorOrchestrator`. Existing callers are untouched.

### Anti-Pattern 4: SQLite for the Ledger

**What people do:** Introduce `better-sqlite3` for the state store.
**Why it's wrong:** Native addon requires separate compilation for macOS/glibc (host) and Alpine/musl (Docker). Significant operational burden for no gain at single-process, serial-chunk scale.
**Do this instead:** JSON ledger with atomic rename. Add SQLite only at v3.1+ if `max_parallel > 1` requires transaction isolation.

### Anti-Pattern 5: Registering Capability Tools for All Task Types

**What people do:** Register all MCP tools unconditionally in `ClaudeCodeSession` to "keep it simple."
**Why it's wrong:** Tools not scoped to sweeping-refactor create surface area for the generic agent to call `ast_rewrite` on a dep-update task. Tool descriptions add tokens to every session. Judge may veto unexpected tool use.
**Do this instead:** Capability tools registered only when `SessionConfig.taskType === 'sweeping-refactor'`. Thread `taskType` through `AgentOptions` → `SessionConfig`.

### Anti-Pattern 6: Discovery Writing targets.json via Agent Write Tool

**What people do:** Have the discovery agent write `targets.json` directly using the Write tool.
**Why it's wrong:** The discovery pass is read-only (same invariant as `investigation` tasks — Write tool is blocked). Discovery uses the agent's `finalResponse` text, which is parsed host-side by `DiscoveryPassRunner`.
**Do this instead:** `DiscoveryPassRunner` parses `sessionResult.finalResponse` for a JSON block and writes `targets.json` on the host. This matches the established pattern where `.reports/` files are written by the REPL.

---

## Scaling Considerations

| Concern | v2.4 (single session) | v3.0 (serial chunks) | v3.1+ (parallel chunks) |
|---------|----------------------|----------------------|------------------------|
| Worktrees | One per session | One per run, long-lived | One per parallel worker |
| State | In-memory RetryResult | JSON ledger on disk | Requires atomic writes |
| Docker containers | One at a time | One at a time (serial) | N simultaneous containers |
| Cost bound | Turns × session | N chunks × envelope | max_parallel × chunks × envelope |
| Crash recovery | None (one-shot) | Resume from `state.json` | Requires distributed locking |

For v3.0, `max_parallel: 1` is enforced. The recipe schema already has `max_parallel: integer`; the runner rejects `max_parallel > 1` with a clear error rather than silently ignoring it. This surfaces the v3.1 boundary explicitly.

---

## Sources

All findings are based on direct source code analysis (HIGH confidence):
- `src/agent/index.ts` — `runAgent()`, `AgentOptions`, `AgentContext`, Docker lifecycle, worktree lifecycle
- `src/agent/worktree-manager.ts` — `WorktreeManager`, `PidSentinel`, `pruneOrphans`
- `src/orchestrator/retry.ts` — `RetryOrchestrator`, `RetryConfig`, session retry loop
- `src/orchestrator/verifier.ts` — `compositeVerifier`, `RetryConfig.verifier` signature
- `src/orchestrator/claude-code-session.ts` — `ClaudeCodeSession.run()`, `buildDockerRunArgs()` call, MCP server registration
- `src/orchestrator/judge.ts` — `llmJudge` signature
- `src/cli/docker/index.ts` — `DockerRunOptions`, `-v` mount generation
- `src/mcp/verifier-server.ts` — `createVerifierMcpServer`, MCP server pattern
- `src/intent/index.ts`, `fast-path.ts`, `types.ts` — intent routing, TASK_TYPES, fast-path patterns
- `src/types.ts` — `SessionConfig`, `RetryConfig`, `RetryResult` interfaces
- `src/repl/session.ts` — `processInput`, `runScopingDialogue`, `SessionCallbacks`
- `.planning/milestones/v3.0-ROADMAP.md` — Phase 28-34 specs, Appendix A recipe schema
- `.planning/PROJECT.md` — Key Decisions table, architectural invariants, known tech debt

---
*Architecture research for: v3.0 Program Automator — sweeping-refactor integration into background coding agent*
*Researched: 2026-04-08*
