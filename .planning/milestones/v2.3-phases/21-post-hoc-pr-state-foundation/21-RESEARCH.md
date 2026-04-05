# Phase 21: Post-Hoc PR & State Foundation - Research

**Researched:** 2026-03-25
**Domain:** REPL meta-command intercept, ReplState schema extension, GitHubPRCreator reuse
**Confidence:** HIGH

## Summary

Phase 21 is a surgical extension to the existing REPL pipeline. All three moving parts — meta-command intercept, state retention, and PR creation — reuse established infrastructure. No new libraries are needed. The primary work is schema extension to `ReplState` and `TaskHistoryEntry`, a new branch in `processInput()`, and description population in `appendHistory()`.

The existing `GitHubPRCreator.create()` already accepts the exact inputs that post-hoc PR needs: `taskType`, `originalTask`, and a full `RetryResult`. The meta-command pattern is already established for `exit`, `quit`, and `history` — the PR command follows that exact same shape. `SessionOutput` already carries `result` and `intent` back to the REPL loop; the only question is how to surface the `PRResult` to the display layer, which can reuse the existing `onPrCreated?` callback slot or a new field on `SessionOutput`.

The state enrichment for FLLW-01 and FLLW-02 requires storing `lastRetryResult?: RetryResult` and `lastIntent?: ResolvedIntent` on `ReplState`, plus adding `description?: string` to `TaskHistoryEntry`. Both are backward-compatible optional field additions.

**Primary recommendation:** Implement the PR meta-command check as a new branch in `processInput()` after the `history` check (line 64 in session.ts), using `GitHubPRCreator.create()` directly with values from `state.lastRetryResult` and `state.lastIntent`. Store `lastRetryResult` and `lastIntent` on ReplState immediately after `runAgent()` returns success.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **Meta-command detection:** Exact match set: `pr`, `create pr`, `create a pr` (case-insensitive, trimmed). Intercepted in `processInput()` before `parseIntent()` runs — same location as exit/quit/history. Anything else containing "pr" flows to intent parser normally.
- **PR confirmation flow:** Show "Creating PR for: [description] ([project])" then create immediately. No Y/n confirmation. Reuse `GitHubPRCreator.create()` directly. After success, display PR URL only: "PR created: https://github.com/org/repo/pull/123".
- **State retention:** Add `lastRetryResult?: RetryResult` and `lastIntent?: ResolvedIntent` to ReplState. Overwritten on each new task completion. PR eligibility: `lastRetryResult.finalStatus === 'success'` required. Allow duplicate PRs — let GitHub API handle conflicts (no prCreated tracking flag).
- **TaskHistoryEntry enrichment:** Add `description?: string` field to TaskHistoryEntry (FLLW-01). Populated from `intent.description` verbatim for generic tasks. For dependency updates, format as "update {dep} to {version}". Never rewritten.
- **Error handling:** No completed task: "No completed task in this session". No GITHUB_TOKEN: GitHubPRCreator's existing validation handles this. PR creation failure: surface the API error from PRResult.error.

### Claude's Discretion
- Exact placement of meta-command check within processInput() control flow
- Whether to log PR creation events via Pino
- SessionOutput shape — whether to add prResult field or reuse existing patterns
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| PR-01 | User can type `pr` or `create pr` in REPL to create a GitHub PR for the last completed task | processInput() meta-command branch; state.lastRetryResult stores the RetryResult to pass to GitHubPRCreator.create() |
| PR-02 | User sees clear error message when no completed task exists ("No completed task in this session") | Guard check: `!state.lastRetryResult` or `state.lastRetryResult.finalStatus !== 'success'` before calling creator |
| PR-03 | User sees task summary before PR is created ("Creating PR for: [description] ([project])") | Print to console before GitHubPRCreator.create() is awaited; uses state.lastIntent.description and state.currentProjectName |
| PR-04 | `create pr` / `create a pr` natural language input routes to post-hoc PR flow, not intent parser | Exact-match set handled before parseIntent() call, same pattern as exit/quit/history intercept |
| FLLW-01 | TaskHistoryEntry includes task description | Add optional `description?: string` field to TaskHistoryEntry interface; populate in appendHistory() |
| FLLW-02 | RetryResult is stored on ReplState after each task completion | Add `lastRetryResult?: RetryResult` and `lastIntent?: ResolvedIntent` to ReplState; assign after runAgent() success |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `simple-git` | already installed | Git operations in GitHubPRCreator | Already used; no new dependency |
| `octokit` | already installed | GitHub API calls in GitHubPRCreator | Already used; no new dependency |
| `picocolors` | already installed | Terminal color output | Already used throughout REPL |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `pino` | already installed | Structured logging | If logging PR creation events (Claude's discretion) |

**Installation:** No new dependencies required. All needed libraries are already present.

## Architecture Patterns

### Recommended Project Structure

No new files needed. All changes touch existing files:

```
src/repl/
├── types.ts          # Add lastRetryResult/lastIntent to ReplState; add description to TaskHistoryEntry
├── session.ts        # Add PR meta-command branch; store state after runAgent; extend appendHistory()
src/cli/commands/
└── repl.ts           # Add PR URL display after processInput() returns with PR result
```

### Pattern 1: Meta-Command Intercept (established pattern)

**What:** Exact-match string check before `parseIntent()` in `processInput()`. Returns early with appropriate `SessionOutput`.

**When to use:** Any command that should bypass the intent parser and LLM dispatch entirely.

**Example — existing pattern in session.ts lines 39-64:**
```typescript
// Source: src/repl/session.ts
const trimmed = input.trim().toLowerCase();

if (trimmed === 'exit' || trimmed === 'quit') {
  return { action: 'quit' };
}
if (trimmed === 'history') {
  // ... display history
  return { action: 'continue' };
}

// PR meta-command follows same shape:
if (trimmed === 'pr' || trimmed === 'create pr' || trimmed === 'create a pr') {
  // ... handle post-hoc PR
  return { action: 'continue' };
}
```

### Pattern 2: SessionOutput Extension for PR Result

**What:** SessionOutput currently carries `result?: RetryResult | null` and `intent?: ResolvedIntent`. The PR result needs to reach the REPL loop display in `repl.ts`.

**Options (Claude's discretion):**
- Add `prResult?: PRResult` field to `SessionOutput` — planner SHOULD choose this: clean, typed, consistent with existing result/intent fields
- Alternatively, display PR output inline within `processInput()` via `console.log` — simpler but mixes display with session logic

The existing pattern in `repl.ts` (lines 334-337) renders result blocks from `output.result`. A `prResult` field follows the same consumption pattern.

**Example — SessionOutput extension:**
```typescript
// Source: src/repl/types.ts (to be modified)
export interface SessionOutput {
  action: 'continue' | 'quit';
  result?: RetryResult | null;
  intent?: ResolvedIntent;
  prResult?: PRResult;        // new: post-hoc PR result
}
```

### Pattern 3: ReplState Extension

**What:** Optional fields on ReplState, initialized as `undefined` (matches `createSessionState()` pattern of null defaults for optional data).

**Example:**
```typescript
// Source: src/repl/types.ts (to be modified)
export interface ReplState {
  currentProject: string | null;
  currentProjectName: string | null;
  history: TaskHistoryEntry[];
  lastRetryResult?: RetryResult;   // new: FLLW-02
  lastIntent?: ResolvedIntent;     // new: supports PR summary and FLLW-02
}
```

**Populated in session.ts** after `runAgent()` returns successfully (inside the try block, before the `return` statement on line 155):
```typescript
// Source: src/repl/session.ts (to be modified)
const result = await runAgent(agentOptions, agentContext);
// Store for post-hoc PR and follow-up referencing
state.lastRetryResult = result;
state.lastIntent = confirmed;
// ... existing return
```

### Pattern 4: TaskHistoryEntry Description Population

**What:** The `description` field is populated in `appendHistory()`. For generic tasks, use `intent.description`. For dep updates, format as "update {dep} to {version}".

**Example — appendHistory() call site (session.ts lines 161-168):**
```typescript
// Source: src/repl/session.ts (to be modified)
appendHistory(state, {
  taskType: confirmed.taskType,
  dep: confirmed.dep ?? null,
  version: confirmed.version ?? null,
  repo: confirmed.repo,
  status: historyStatus,
  description: confirmed.taskType === 'generic'
    ? confirmed.description
    : confirmed.dep
      ? `update ${confirmed.dep} to ${confirmed.version ?? 'latest'}`
      : undefined,
});
```

### Pattern 5: GitHubPRCreator Invocation for Post-Hoc PR

**What:** `GitHubPRCreator.create()` already has all required parameters. Post-hoc invocation requires the repo path (from `state.lastIntent.repo`) as the workspace directory constructor argument.

**Example:**
```typescript
// Source: src/orchestrator/pr-creator.ts (reused unchanged)
const creator = new GitHubPRCreator(state.lastIntent.repo);
const prResult = await creator.create({
  taskType: state.lastIntent.taskType,
  originalTask: state.lastIntent.description ?? state.lastIntent.dep ?? state.lastIntent.taskType,
  retryResult: state.lastRetryResult,
  description: state.lastIntent.description,
  taskCategory: state.lastIntent.taskCategory ?? undefined,
});
```

**Important:** `GitHubPRCreator.create()` never throws on PR creation failure — it returns `PRResult` with `error` field set. The GITHUB_TOKEN missing check **does throw** (line 326 in pr-creator.ts), so the post-hoc PR handler must catch that separately.

### Anti-Patterns to Avoid

- **Calling parseIntent() for the PR command:** The PR command must be intercepted before `parseIntent()` is called. If it reaches the LLM, "create pr" will be misinterpreted as a code change task.
- **Re-running runAgent() for post-hoc PR:** The agent should NOT be re-executed. The PR is created from the stored `lastRetryResult` only. No task re-run.
- **Storing prCreated flag:** Decided against. GitHub API naturally deduplicates (returns existing PR). No prCreated tracking flag needed.
- **Checking finalStatus on each new task:** `lastRetryResult` is overwritten on every task completion regardless of status. The eligibility check (`finalStatus === 'success'`) happens at PR invocation time.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| GitHub PR creation | Custom Octokit logic | `GitHubPRCreator.create()` | Already handles: branch creation, push, breaking change detection, PR body, token sanitization, branch restoration |
| PR body formatting | Custom markdown | `buildPRBody()` from pr-creator.ts | Already produces 6-section PR body with verification/judge data |
| Git operations | Direct git shell calls | `simple-git` via GitHubPRCreator | Already used; handles branch restoration in finally block |

**Key insight:** The hardest parts of PR creation (branch naming, diff stat, breaking change detection, existing PR detection) are already solved in `GitHubPRCreator`. The post-hoc path is purely about providing the right inputs from stored state.

## Common Pitfalls

### Pitfall 1: GITHUB_TOKEN Throws vs PRResult.error
**What goes wrong:** Developer adds try/catch expecting `GitHubPRCreator.create()` to never throw, but missing GITHUB_TOKEN causes an immediate throw before the try block in `create()` (line 326 in pr-creator.ts).
**Why it happens:** The method has a split error contract: token validation throws, everything else returns PRResult with error field.
**How to avoid:** In the post-hoc PR handler, wrap the entire `creator.create()` call in try/catch. The catch block covers both the token throw and any unexpected errors. PRResult.error covers API failures.
**Warning signs:** Tests pass locally (developer has GITHUB_TOKEN set) but fail in CI or user environments.

### Pitfall 2: lastRetryResult set on all statuses
**What goes wrong:** If `lastRetryResult` is stored for both success and failure cases, a failed task leaves stale state that could be used for PR creation if the eligibility check is forgotten.
**Why it happens:** Session.ts `finally` block runs for all outcomes. If assignment is placed in `finally`, failed results are stored.
**How to avoid:** Assign `lastRetryResult` and `lastIntent` inside the `try` block, after `runAgent()` resolves successfully (before the return on line 155). Failed runs (thrown errors) never reach that assignment.
**Warning signs:** PR created from a failed task's HEAD commit.

### Pitfall 3: parseIntent intercept ordering
**What goes wrong:** If the PR meta-command check is placed after the `MAX_INPUT_LENGTH` guard (line 67) but before parseIntent, "create a pr" strings under 2000 chars will correctly intercept. However, placing it AFTER parseIntent means the LLM sees "create pr" as a potential code task.
**Why it happens:** Control flow in processInput() has multiple early-return guards at different line numbers.
**How to avoid:** Place the PR check in the exact slot documented: after the `history` check (line 64) and before the `MAX_INPUT_LENGTH` guard (line 67). This is consistent with the "exit/quit/history" pattern.

### Pitfall 4: repl.ts display logic for PR result
**What goes wrong:** If `prResult` is returned in `SessionOutput` but repl.ts doesn't handle it, no URL is displayed to the user. The PR is still created but the user sees nothing.
**Why it happens:** `repl.ts` handles `output.result` for RetryResult rendering but won't know about `output.prResult` without explicit handling.
**How to avoid:** After the `if (output.result)` block in repl.ts (line 334), add an `if (output.prResult)` block that displays the URL or error message.

### Pitfall 5: appendHistory() description for dep updates with null dep
**What goes wrong:** For `npm-dependency-update` or `maven-dependency-update` tasks where `dep` is null (edge case), `"update null to latest"` would be written as the description.
**Why it happens:** Blind string interpolation without null guard.
**How to avoid:** Only populate description for dep updates when `confirmed.dep` is non-null. Fall back to `undefined` otherwise.

## Code Examples

### PR Meta-Command Handler (new branch in processInput)
```typescript
// Source: based on established pattern in src/repl/session.ts
// Placement: after history check (line 64), before MAX_INPUT_LENGTH guard

const PR_COMMANDS = new Set(['pr', 'create pr', 'create a pr']);

if (PR_COMMANDS.has(trimmed.toLowerCase())) {
  if (!state.lastRetryResult || state.lastRetryResult.finalStatus !== 'success') {
    console.log(pc.yellow('\n  No completed task in this session.\n'));
    return { action: 'continue' };
  }
  const projectName = state.currentProjectName ?? 'unknown';
  const description = state.lastIntent?.description ?? state.lastIntent?.dep ?? state.lastIntent?.taskType ?? 'task';
  console.log(pc.dim(`\n  Creating PR for: ${description} (${projectName})`));
  const creator = new GitHubPRCreator(state.lastIntent!.repo);
  let prResult: PRResult;
  try {
    prResult = await creator.create({
      taskType: state.lastIntent!.taskType,
      originalTask: description,
      retryResult: state.lastRetryResult,
      description: state.lastIntent?.description,
      taskCategory: state.lastIntent?.taskCategory ?? undefined,
    });
  } catch (err) {
    console.error(pc.red(`\n  PR creation failed: ${(err as Error).message}\n`));
    return { action: 'continue' };
  }
  return { action: 'continue', prResult };
}
```

### ReplState After runAgent() Success
```typescript
// Source: src/repl/session.ts — inside try block after runAgent()
const result = await runAgent(agentOptions, agentContext);
// Store for post-hoc PR (PR-01, FLLW-02) — success only
state.lastRetryResult = result;
state.lastIntent = confirmed;
historyStatus = result.finalStatus === 'success'
  ? 'success'
  : result.finalStatus === 'zero_diff'
  ? 'zero_diff'
  : 'failed';
return { action: 'continue', result, intent: confirmed };
```

### Display in repl.ts
```typescript
// Source: src/cli/commands/repl.ts — after existing output.result handling
if (output.prResult) {
  if (output.prResult.error) {
    console.error(pc.red(`  PR creation failed: ${output.prResult.error}\n`));
  } else {
    console.log(pc.green(`  PR created: ${output.prResult.url}\n`));
  }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| No post-hoc PR | `pr` meta-command in REPL | Phase 21 | Users can create PRs without re-running |
| TaskHistoryEntry has no description | `description?: string` field | Phase 21 | Enables Phase 23 follow-up referencing |
| ReplState has no last-result storage | `lastRetryResult?` + `lastIntent?` | Phase 21 | Foundation for Phases 22, 23, 24 |

## Open Questions

1. **Where to print PR summary — session.ts or repl.ts?**
   - What we know: CONTEXT.md says "show 'Creating PR for:...' before creating" — could be done in processInput() via console.log or returned in SessionOutput for repl.ts to render.
   - What's unclear: Which side owns the display responsibility per established patterns (repl.ts handles all display for result blocks).
   - Recommendation: Print summary directly in processInput() (as shown in the code example above) because it's pre-creation feedback, not a result. This is consistent with how history printing works (also in session.ts). The prResult in SessionOutput carries the URL for post-creation display in repl.ts.

2. **Pino logging for PR creation events**
   - What we know: CONTEXT.md flags this as Claude's discretion.
   - What's unclear: Whether a logger instance is available at the PR intercept point in processInput().
   - Recommendation: Skip Pino logging for the PR intercept. The logger is created inside the task run flow (line 126 in session.ts) and is not available at the meta-command level. Console output is sufficient for user-facing feedback.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.0.18 |
| Config file | `vitest.config.ts` (excludes dist/, node_modules/) |
| Quick run command | `npx vitest run src/repl/session.test.ts` |
| Full suite command | `npm test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PR-01 | `pr` input triggers GitHubPRCreator.create() using stored lastRetryResult | unit | `npx vitest run src/repl/session.test.ts` | ❌ Wave 0 — new tests needed |
| PR-02 | `pr` with no lastRetryResult returns "No completed task" without calling creator | unit | `npx vitest run src/repl/session.test.ts` | ❌ Wave 0 |
| PR-03 | Summary line printed before create() is called | unit | `npx vitest run src/repl/session.test.ts` | ❌ Wave 0 |
| PR-04 | `create pr`, `create a pr` intercepted before parseIntent() | unit | `npx vitest run src/repl/session.test.ts` | ❌ Wave 0 |
| FLLW-01 | TaskHistoryEntry.description populated from intent for generic + dep update tasks | unit | `npx vitest run src/repl/session.test.ts` | ❌ Wave 0 |
| FLLW-02 | state.lastRetryResult + state.lastIntent set after successful runAgent(); not set on failure | unit | `npx vitest run src/repl/session.test.ts` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run src/repl/session.test.ts`
- **Per wave merge:** `npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/repl/session.test.ts` — add tests 24-30 covering PR-01 through PR-04 and FLLW-01/FLLW-02 (file exists, new test cases needed within existing describe block)
- [ ] `src/orchestrator/pr-creator.ts` mock — add `vi.mock('../orchestrator/pr-creator.js', ...)` in session.test.ts for PR intercept tests

*(No new test files needed — all tests belong in the existing `src/repl/session.test.ts` which already has the mock infrastructure for `runAgent`, `parseIntent`, and `ProjectRegistry`.)*

## Sources

### Primary (HIGH confidence)
- `src/repl/session.ts` — full source read; meta-command pattern, appendHistory, processInput control flow
- `src/repl/types.ts` — full source read; ReplState, TaskHistoryEntry, SessionCallbacks, SessionOutput interfaces
- `src/orchestrator/pr-creator.ts` — full source read; GitHubPRCreator.create() signature and error contract
- `src/types.ts` — full source read; RetryResult, PRResult type definitions
- `src/cli/commands/repl.ts` — full source read; REPL loop, result display, SessionCallbacks implementation
- `src/repl/session.test.ts` — full source read; existing test structure, vitest patterns
- `src/intent/types.ts` — full source read; ResolvedIntent interface

### Secondary (MEDIUM confidence)
- `.planning/phases/21-post-hoc-pr-state-foundation/21-CONTEXT.md` — locked decisions and canonical refs
- `.planning/REQUIREMENTS.md` — PR-01 through PR-04, FLLW-01, FLLW-02 definitions
- `.planning/STATE.md` — accumulated context and decisions

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new dependencies; all libraries confirmed present in codebase
- Architecture: HIGH — all patterns verified from live source code; meta-command intercept is exact precedent
- Pitfalls: HIGH — identified from direct code inspection (pr-creator.ts throw vs return contract, session.ts control flow ordering)

**Research date:** 2026-03-25
**Valid until:** 2026-04-25 (stable internal codebase — no external API changes expected)
