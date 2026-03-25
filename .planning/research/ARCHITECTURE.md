# Architecture Research

**Domain:** Conversational REPL enhancements + Slack bot interface — background coding agent v2.3
**Researched:** 2026-03-25
**Confidence:** HIGH (first-party codebase analysis, all integration points verified in source)

## Context: What This Research Is

This is an integration analysis for v2.3. The system is fully operational (v2.2). The question is: how do four new features — conversational scoping dialogue, REPL post-hoc PR creation, follow-up task referencing, and Slack bot interface — slot into the existing architecture without breaking existing flows or violating the established `SessionCallbacks` decoupling pattern?

This document maps every touch point: what is new, what is modified, what is untouched, and the recommended build order with dependency rationale.

---

## Existing Architecture (v2.2 — What Already Works)

```
User input (REPL or one-shot)
  └─> parseIntent(input, options)
       ├─> fastPathParse()       regex: "update|upgrade|bump <dep>"
       ├─> validateDepInManifest()
       ├─> detectTaskType()
       └─> llmParse()            Haiku 4.5, GA structured output
            schema: { taskType, dep, version, confidence, createPr, taskCategory, project, clarifications }
  └─> ResolvedIntent { taskType, repo, dep, version, confidence, createPr, description?, taskCategory? }
  └─> processInput() [repl/session.ts]
       ├─> clarify via callbacks.clarify()     (low-confidence menu)
       └─> confirm via callbacks.confirm()     (intent display + Y/n + inline correction)
  └─> runAgent(AgentOptions, AgentContext)
       └─> buildPrompt(options)
            ├─> buildMavenPrompt()
            ├─> buildNpmPrompt()
            └─> buildGenericPrompt()   end-state prompt with SCOPE fence
       └─> RetryOrchestrator
            └─> ClaudeCodeSession.query()    Docker + iptables
            └─> compositeVerifier()          build+test+lint (or lint-only for config)
            └─> llmJudge()                   refactoring-aware
       └─> GitHubPRCreator (createPr: true only)
  └─> RetryResult returned to processInput() → rendered in REPL → discarded
```

### Key Integration Hooks That Already Exist

| Hook | Location | Relevance to v2.3 |
|------|----------|-------------------|
| `SessionCallbacks` interface | `src/repl/types.ts` | I/O decoupling — Slack adapter replaces CLI callbacks here |
| `ReplState.history` | `src/repl/types.ts` | Follow-up referencing already reads from here |
| `processInput()` | `src/repl/session.ts` | All four features extend or wrap this function |
| `GitHubPRCreator.create()` | `src/orchestrator/pr-creator.ts` | Post-hoc PR invokes this directly with stored context |
| `buildGenericPrompt()` | `src/prompts/generic.ts` | Scoping dialogue feeds scope constraints into this |
| `TaskHistoryEntry` | `src/repl/types.ts` | Follow-up referencing extends this struct |

---

## Feature 1: Conversational Scoping Dialogue

### What It Does

Before executing a `generic` task, the REPL asks 1-3 focused scope-narrowing questions. Answers are injected into the `buildGenericPrompt()` SCOPE block as user-provided constraints. Dependency-update tasks are unaffected.

### Where It Lives

**New file:** `src/repl/scoping.ts`

Owns the question-answer loop. Takes a `ResolvedIntent` and `SessionCallbacks`, returns a `ScopingResult` with collected answers. Pure logic — no readline, no console output (those go through callbacks).

**Modified:** `src/prompts/generic.ts` — `buildGenericPrompt()` gains optional `scopeHints` parameter.

**Modified:** `src/repl/session.ts` — `processInput()` calls `runScopingDialogue()` between confirm and `runAgent()`.

**New callback:** `SessionCallbacks.askQuestion(prompt: string): Promise<string | null>` — single-question I/O primitive. CLI adapter implements with readline. Slack adapter implements with thread reply + message wait.

### Data Flow

```
processInput(input, state, callbacks)
  └─> parseIntent()               (unchanged)
  └─> clarify()                   (unchanged)
  └─> callbacks.confirm()         (unchanged)
  └─> runScopingDialogue()        NEW — only if taskType === 'generic'
       ├─> callbacks.askQuestion("Which files/dirs should this touch? (Enter to skip)")
       ├─> callbacks.askQuestion("Should tests be updated? (Enter to skip)")
       └─> returns ScopingResult { fileScope?, updateTests?, exclusions? }
  └─> buildPrompt({ ...agentOptions, scopeHints: scopingResult })
       └─> buildGenericPrompt(description, scopeHints)
            ├─> existing SCOPE fence
            └─> if scopeHints.fileScope: "SCOPE: Only touch: <fileScope>"
               if scopeHints.updateTests === false: "Do NOT modify test files."
  └─> runAgent()                  (unchanged)
```

### Interface Additions

```typescript
// src/repl/types.ts — SessionCallbacks gains one method
interface SessionCallbacks {
  // ... existing methods ...
  /** Ask user a single question; return response string or null if skipped/cancelled. */
  askQuestion?: (prompt: string) => Promise<string | null>;
}

// src/repl/scoping.ts — new types
interface ScopingResult {
  fileScope?: string;       // "src/users/, src/auth/" user-provided path constraints
  updateTests?: boolean;    // true/false/undefined (undefined = skip question)
  exclusions?: string;      // "do not touch migrations/"
}
```

### Modified: `buildGenericPrompt()`

```typescript
// src/prompts/generic.ts — signature change
export async function buildGenericPrompt(
  description: string,
  repoPath?: string,
  scopeHints?: ScopingResult,   // NEW optional parameter
): Promise<string>
```

The `ScopingResult` fields append to the SCOPE block when present. The function remains fully backward compatible — callers that pass no `scopeHints` get identical output to v2.2.

### What Is Unchanged

- Intent parser — scoping is post-parse
- Confirm loop — scoping is post-confirm
- `runAgent()` — receives `description` + `scopeHints` encoded in prompt, no new params
- Verifier, judge, PR creator — entirely unaffected

### Integration Points

| Boundary | Change |
|----------|--------|
| `SessionCallbacks` | Add optional `askQuestion?` method |
| `buildGenericPrompt()` | Add optional `scopeHints` parameter |
| `processInput()` | Insert `runScopingDialogue()` call after confirm, before `runAgent()` |
| CLI `repl.ts` | Implement `askQuestion` callback using existing readline `rl.question()` |

---

## Feature 2: REPL Post-Hoc PR Creation

### What It Does

After a task completes successfully, the user can type `pr` or `create pr` in the REPL to create a GitHub PR for the last completed task, without having requested it upfront. The REPL stores the last `RetryResult` + context on `ReplState` and the command invokes `GitHubPRCreator` with that stored context.

### The Gap (Why It Doesn't Work Today)

`processInput()` returns `SessionOutput { result: RetryResult | null }`. The REPL loop in `repl.ts` calls `renderResultBlock(output.result)` then discards it. `GitHubPRCreator` needs `RetryResult` + the original prompt + task options to build the PR body. A follow-up `"create PR"` input currently reaches `parseIntent()` as a new task, where it fails (no repo context, no code change instruction).

### Where It Lives

**Modified:** `src/repl/types.ts` — `ReplState` gains `lastResult` field.

**Modified:** `src/repl/session.ts` — `processInput()` stores result on state after successful run; adds `pr`/`create pr` command handling before `parseIntent()`.

**No new files required.**

### Data Flow

```
Task completes successfully:
  processInput() → RetryResult
    state.lastResult = {
      retryResult,
      prompt,           // the string passed to RetryOrchestrator
      agentOptions,     // AgentOptions (has taskType, repo, description, taskCategory)
    }
  renderResultBlock(result)
  REPL re-prompts

User types "pr" or "create pr":
  processInput("pr", state, callbacks)
    BEFORE parseIntent() — command intercept
    if isCreatePrCommand(trimmed):
      if !state.lastResult || state.lastResult.agentOptions.createPr:
        callbacks.onMessage("No completed task to create PR for, or PR already created.")
        return { action: 'continue', result: null }
      if state.lastResult.retryResult.finalStatus !== 'success':
        callbacks.onMessage("Last task did not succeed. PR creation requires a successful run.")
        return { action: 'continue', result: null }
      creator = new GitHubPRCreator(state.lastResult.agentOptions.repo)
      prResult = await creator.create({
        taskType: state.lastResult.agentOptions.taskType,
        originalTask: state.lastResult.prompt,
        retryResult: state.lastResult.retryResult,
        description: state.lastResult.agentOptions.description,
        taskCategory: state.lastResult.agentOptions.taskCategory,
      })
      callbacks.onPrCreated(prResult)
      state.lastResult = null   // consumed
      return { action: 'continue', result: null }
```

### Type Changes

```typescript
// src/repl/types.ts — ReplState extension
interface LastTaskContext {
  retryResult: RetryResult;
  prompt: string;           // string sent to RetryOrchestrator (for PR body)
  agentOptions: AgentOptions;
}

interface ReplState {
  currentProject: string | null;
  currentProjectName: string | null;
  history: TaskHistoryEntry[];
  lastResult: LastTaskContext | null;   // NEW — null until first successful task
}
```

### New Callback Method

```typescript
// src/repl/types.ts — SessionCallbacks
interface SessionCallbacks {
  // ... existing methods ...
  /** Display a non-interactive message (PR URL, status notice). */
  onMessage?: (message: string) => void;
  /** Called after PR creation with the PRResult. CLI adapter displays URL. */
  onPrCreated?: (result: PRResult) => void;
}
```

### `processInput()` Change: Where the Prompt Is Stored

Currently `processInput()` builds `agentOptions` and passes them to `runAgent()` but the `prompt` string is built inside `runAgent()` (`buildPrompt(options)`) and never surfaced. Two options:

**Option A (recommended):** Export `buildPrompt()` call from `agent/index.ts` and call it in `processInput()` before `runAgent()`. Store the result on `lastResult.prompt`. `runAgent()` then takes the pre-built prompt as an optional parameter (falls back to building it internally if not provided).

**Option B:** Re-build the prompt string inside the `pr` command handler using the stored `agentOptions`. This duplicates logic but avoids changing `runAgent()`.

Option A is cleaner. The prompt string is the same object in both `lastResult` and `runAgent()` — no duplication, no divergence risk.

### What Is Unchanged

- `GitHubPRCreator` — called with the same interface it already has
- `parseIntent()` — `pr` command is intercepted before parsing reaches it
- Intent parser, verifier, judge — entirely unaffected
- `processInput()` shape — `SessionOutput` type unchanged; `pr` command returns `{ action: 'continue', result: null }`

---

## Feature 3: Follow-Up Task Referencing

### What It Means

Users can say "now fix the test that broke" or "also do it for the auth module" and the system resolves the reference to the previous task's result (branch, diff, files changed). This is richer than the current follow-up detection (`"also X"` inherits repo/taskType) — it can reference *what the last task changed*.

### What Already Exists

`ReplState.history` stores `TaskHistoryEntry[]` (taskType, dep, version, repo, status). The intent parser already receives `history` and uses it to inherit `taskType`/`repo` for `"also X"` patterns. The fast-path follow-up detection (`FOLLOW_UP_PREFIX`, `FOLLOW_UP_TOO_SUFFIX`) already handles simple "also" patterns.

### What Is Missing

`TaskHistoryEntry` carries no information about *what changed* — no branch name, no files modified, no summary of agent changes. Follow-up references like "fix the test that broke" require knowing what test broke (from the last `RetryResult`).

### Where It Lives

**Modified:** `src/repl/types.ts` — `TaskHistoryEntry` gains optional rich fields.

**Modified:** `src/repl/session.ts` — `appendHistory()` populates the new fields from `RetryResult`.

**Modified:** `src/intent/llm-parser.ts` — `buildHistoryBlock()` includes the new fields in the LLM context block (if present).

**No new files required.**

### Type Changes

```typescript
// src/repl/types.ts — TaskHistoryEntry extension
interface TaskHistoryEntry {
  taskType: TaskType;
  dep: string | null;
  version: string | null;
  repo: string;
  status: 'success' | 'failed' | 'cancelled' | 'zero_diff';
  // NEW optional fields — populated only for completed (non-cancelled) runs
  branch?: string;            // git branch created by agent (if PR was created)
  finalResponse?: string;     // agent's last message (summary of changes made)
  filesChanged?: string[];    // list of files in the diff (from git diff --name-only)
}
```

### `appendHistory()` Change

`appendHistory()` currently takes only `TaskHistoryEntry`. The session core needs `RetryResult` to extract `finalResponse` and (optionally) file list. `appendHistory()` is an internal helper, so the signature change is contained.

```typescript
// src/repl/session.ts — internal helper
function appendHistory(
  state: ReplState,
  entry: TaskHistoryEntry,
  retryResult?: RetryResult,  // NEW optional
): void {
  if (retryResult) {
    const lastSession = retryResult.sessionResults.at(-1);
    if (lastSession) {
      entry.finalResponse = lastSession.finalResponse?.slice(0, 300);
    }
  }
  // branch: populated if state.lastResult was set (PR was created)
  // filesChanged: requires git diff --name-only — defer to Phase 3 if needed
  state.history.push(entry);
}
```

### LLM Context Block Change

`buildHistoryBlock()` in `llm-parser.ts` currently emits one line per entry. With `finalResponse` available, it can include a brief summary:

```
<session_history>
Previous tasks this session (most recent last):
  1. generic | dep: none | repo: my-app | status: success
     Changes: "Renamed getUserById to fetchUserById in users/service.ts"
  2. generic | dep: none | repo: my-app | status: failed
</session_history>
```

This enriches the LLM's context for natural follow-up references like "fix what you broke" or "also apply this to the function you just renamed."

### Boundary: What `filesChanged` Requires

Extracting `filesChanged` requires a `git diff --name-only` call against the workspace after the agent run. This is feasible (simple-git is already a dependency, used in `pr-creator.ts`) but adds async work to the already-synchronous `appendHistory()`. Recommendation: defer `filesChanged` to a follow-up iteration; `finalResponse` alone covers most follow-up reference cases.

### What Is Unchanged

- Fast-path follow-up detection — still handles `"also X"` pattern
- `parseIntent()` coordinator — receives enriched history but its structure is unchanged
- `processInput()` flow — only `appendHistory()` internal call changes

---

## Feature 4: Slack Bot Interface

### What It Does

A Slack adapter wraps the existing `processInput()` / `runAgent()` pipeline with Slack-specific I/O. Intent parsing, confirmation, scoping, agent execution, verification, and PR creation all reuse existing code. The Slack adapter is a thin I/O layer, not a new backend.

### Architecture: SessionCallbacks as the Adapter Contract

The `SessionCallbacks` interface is precisely the seam designed for this. The CLI REPL implements it with readline. The Slack adapter implements it with Slack API calls.

```
┌─────────────────────────────────────────────────────────────┐
│                    Adapters (I/O Layer)                      │
│                                                             │
│  ┌─────────────────────┐    ┌──────────────────────────┐   │
│  │   CLI REPL Adapter  │    │    Slack Bot Adapter      │   │
│  │   (repl.ts)         │    │    (slack/adapter.ts)     │   │
│  │                     │    │                           │   │
│  │  confirm: readline  │    │  confirm: interactive msg │   │
│  │  clarify: menu list │    │  clarify: button menu     │   │
│  │  askQuestion: rl    │    │  askQuestion: thread msg  │   │
│  │  onMessage: console │    │  onMessage: thread reply  │   │
│  │  onPrCreated: log   │    │  onPrCreated: link reply  │   │
│  └──────────┬──────────┘    └───────────┬──────────────┘   │
└─────────────┼────────────────────────────┼──────────────────┘
              │                            │
              └──────────────┬─────────────┘
                             │
              ┌──────────────▼─────────────────────────────────┐
              │           Session Core (Channel-Agnostic)       │
              │                                                  │
              │  processInput(input, state, callbacks, registry) │
              │    parseIntent() → clarify → confirm             │
              │    runScopingDialogue()  [v2.3]                  │
              │    runAgent()                                    │
              │    appendHistory()                               │
              └──────────────────────────────────────────────────┘
```

### Where It Lives

**New directory:** `src/slack/`

```
src/slack/
├── adapter.ts        SessionCallbacks implementation for Slack
├── bot.ts            Slack event listener, routes mentions to processInput()
├── state.ts          ReplState per-channel or per-user (in-memory or Redis)
└── index.ts          exports
```

**No changes to session core, intent parser, agent, verifier, or judge.**

### Slack-Specific Implementation Notes

**Confirmation flow:** Slack interactive messages (Block Kit buttons: "Proceed" / "Cancel" / text input for correction). The `confirm` callback posts a message and blocks until the user clicks or the timeout fires.

**Clarification flow:** Same pattern — Button blocks for each clarification option.

**`askQuestion` (scoping dialogue):** Post a message, await a thread reply within a timeout window (e.g. 60 seconds). If no reply, treat as empty string (skip).

**State management:** `ReplState` is per-channel (one agent session per Slack channel) or per-user (private DM context). An in-memory Map keyed by channel/user ID is sufficient for an initial implementation. Redis persistence is a future enhancement.

**AbortSignal:** The Slack adapter creates an `AbortController` per task. A "Cancel" button or timeout aborts the signal.

**Running agent:** The Slack adapter calls `processInput()` the same way the REPL loop does. The agent runs in Docker on the host where the bot process is running.

### `SessionCallbacks` Interface After v2.3

```typescript
interface SessionCallbacks {
  // EXISTING (v2.1)
  confirm: (intent: ResolvedIntent, reparse: (correction: string) => Promise<ResolvedIntent>) => Promise<ResolvedIntent | null>;
  clarify: (clarifications: ClarificationOption[]) => Promise<string | null>;
  getSignal: () => AbortSignal;
  onAgentStart?: () => void;
  onAgentEnd?: () => void;
  // NEW (v2.3)
  askQuestion?: (prompt: string) => Promise<string | null>;   // scoping dialogue
  onMessage?: (message: string) => void;                      // post-hoc PR status
  onPrCreated?: (result: PRResult) => void;                   // PR URL delivery
}
```

All new methods are optional (`?`). The existing CLI adapter and one-shot adapter continue working without implementing them. `runScopingDialogue()` skips the dialogue if `callbacks.askQuestion` is undefined.

### What Is Unchanged

Everything in `src/orchestrator/`, `src/agent/`, `src/intent/`, `src/prompts/`, `src/mcp/`. The Slack adapter is purely additive.

---

## System Overview: v2.3 Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                         ADAPTERS (I/O)                              │
│                                                                     │
│   CLI REPL (repl.ts)           Slack Bot (slack/bot.ts)            │
│   implements SessionCallbacks  implements SessionCallbacks          │
│   via readline                 via Slack API (Block Kit)           │
└──────────────────────────┬──────────────────────────┬─────────────┘
                           │                          │
                           └──────────┬───────────────┘
                                      │
┌─────────────────────────────────────▼──────────────────────────────┐
│                      SESSION CORE (channel-agnostic)                │
│                                                                     │
│   processInput(input, state, callbacks, registry)                   │
│     1. parseIntent()         intent / fast-path / LLM              │
│     2. callbacks.clarify()   low-confidence menu                   │
│     3. callbacks.confirm()   display plan + Y/n                    │
│     4. runScopingDialogue()  NEW: scope questions (generic only)   │
│     5. runAgent()            builds prompt, executes, verifies     │
│     6. appendHistory()       stores result on ReplState            │
│     7. "pr" command handler  NEW: post-hoc PR from lastResult      │
│                                                                     │
│   ReplState:                                                        │
│     history: TaskHistoryEntry[]   (enriched with finalResponse)    │
│     lastResult: LastTaskContext   NEW: stores last RetryResult      │
└───────────────────────────┬────────────────────────────────────────┘
                            │
┌───────────────────────────▼────────────────────────────────────────┐
│                      INTENT LAYER (unchanged)                       │
│                                                                     │
│   parseIntent()  →  fastPathParse  |  llmParse (Haiku 4.5)         │
│   history context: enriched with finalResponse snippets             │
└───────────────────────────┬────────────────────────────────────────┘
                            │
┌───────────────────────────▼────────────────────────────────────────┐
│                      PROMPT LAYER (minor addition)                  │
│                                                                     │
│   buildGenericPrompt(description, repoPath, scopeHints?)           │
│     scopeHints from scoping dialogue feed SCOPE block              │
└───────────────────────────┬────────────────────────────────────────┘
                            │
┌───────────────────────────▼────────────────────────────────────────┐
│                  EXECUTION LAYER (entirely unchanged)               │
│                                                                     │
│   RetryOrchestrator → ClaudeCodeSession (Docker + iptables)        │
│   compositeVerifier → llmJudge → GitHubPRCreator                   │
└────────────────────────────────────────────────────────────────────┘
```

---

## New vs Modified vs Unchanged

### New Components

| Component | File | Purpose |
|-----------|------|---------|
| `runScopingDialogue()` | `src/repl/scoping.ts` | Orchestrates scope question-answer loop for generic tasks |
| `ScopingResult` type | `src/repl/scoping.ts` | Scope hints collected from user dialogue |
| `LastTaskContext` type | `src/repl/types.ts` | Stored RetryResult + context for post-hoc PR |
| Slack adapter | `src/slack/adapter.ts` | `SessionCallbacks` implementation for Slack |
| Slack bot | `src/slack/bot.ts` | Event listener, state management, entry point |
| Slack state | `src/slack/state.ts` | Per-channel/user ReplState management |

### Modified Components

| Component | File | Change | Scope |
|-----------|------|--------|-------|
| `ReplState` | `src/repl/types.ts` | Add `lastResult: LastTaskContext \| null` | Additive field |
| `TaskHistoryEntry` | `src/repl/types.ts` | Add optional `finalResponse?`, `branch?` | Additive fields |
| `SessionCallbacks` | `src/repl/types.ts` | Add optional `askQuestion?`, `onMessage?`, `onPrCreated?` | Additive, optional |
| `processInput()` | `src/repl/session.ts` | Add `pr` command handler; call `runScopingDialogue()`; store `lastResult` | ~40 lines |
| `appendHistory()` | `src/repl/session.ts` | Accept optional `RetryResult` to populate `finalResponse` | ~10 lines |
| `buildGenericPrompt()` | `src/prompts/generic.ts` | Add optional `scopeHints` parameter | Additive, backward-compatible |
| `buildHistoryBlock()` | `src/intent/llm-parser.ts` | Include `finalResponse` snippet when present | Additive |
| CLI `repl.ts` | `src/cli/commands/repl.ts` | Implement `askQuestion`, `onMessage`, `onPrCreated` callbacks | ~20 lines |

### Entirely Unchanged

- `src/orchestrator/` — all 6 files (retry, verifier, judge, pr-creator, claude-code-session, metrics)
- `src/agent/index.ts` — `runAgent()` interface unchanged
- `src/intent/` — `parseIntent()`, `fastPathParse()`, `contextScanner`, `confirmLoop` unchanged
- `src/prompts/maven.ts`, `npm.ts` — dep-update prompts unchanged
- `src/mcp/` — in-process MCP verifier unchanged
- `src/cli/commands/one-shot.ts` — one-shot path unchanged (scoping is REPL-only)
- `src/types.ts` — `RetryResult`, `SessionResult`, `VerificationResult` unchanged

---

## Data Flows

### Scoping Dialogue Flow (new)

```
User: "extract the payment logic from checkout.ts into a separate service"

processInput()
  └─> parseIntent() → taskType: 'generic', confidence: 'high'
  └─> callbacks.confirm() → user confirms
  └─> runScopingDialogue(intent, callbacks)
       ├─> callbacks.askQuestion("Which files/dirs should this touch? (Enter to skip)")
       │     User: "src/checkout.ts, src/payments/"
       ├─> callbacks.askQuestion("Should tests be updated? [y/N/skip]")
       │     User: "y"
       └─> ScopingResult { fileScope: "src/checkout.ts, src/payments/", updateTests: true }
  └─> buildGenericPrompt(description, repoPath, scopeHints)
       → "You are a coding agent. extract the payment logic from checkout.ts into a separate service
          SCOPE: Only touch: src/checkout.ts, src/payments/
          SCOPE: Update tests to reflect the changes."
  └─> runAgent({ description, ... })   → Docker execution
```

### Post-Hoc PR Flow (new)

```
Task completes:
  processInput() → RetryResult (finalStatus: 'success')
    state.lastResult = { retryResult, prompt, agentOptions }
    renderResultBlock()
    re-prompt

User: "pr"
  processInput("pr", state, callbacks)
    isCreatePrCommand("pr") → true
    state.lastResult is set, status is 'success'
    GitHubPRCreator(state.lastResult.agentOptions.repo).create({
      taskType: ...,
      originalTask: state.lastResult.prompt,
      retryResult: state.lastResult.retryResult,
    })
    callbacks.onPrCreated(prResult)  → CLI prints PR URL
    state.lastResult = null
```

### Follow-Up With Enriched History (enriched existing flow)

```
Task 1 completes:
  appendHistory(state, entry, retryResult)
    entry.finalResponse = "Renamed getUserById to fetchUserById in users/service.ts"

User: "also rename in tests"
  parseIntent("also rename in tests", { history: state.history })
    llmParse() receives:
      <session_history>
        1. generic | repo: my-app | status: success
           Changes: "Renamed getUserById to fetchUserById in users/service.ts"
      </session_history>
    LLM understands "also rename in tests" refers to getUserById→fetchUserById rename
    → taskType: 'generic', repo: inherited, confidence: 'high'
```

### Slack Flow (new channel, same core)

```
Slack @mention: "@agent rename getUserById to fetchUserById in my-app"

slack/bot.ts
  └─> extractMessage(event)
  └─> getOrCreateState(channelId)   per-channel ReplState
  └─> SlackCallbacks implements SessionCallbacks:
       confirm: post Block Kit message, await button click
       clarify: post numbered button menu
       askQuestion: post thread message, await reply
       onPrCreated: reply with PR URL
  └─> processInput(messageText, state, slackCallbacks, registry)
       (identical to REPL path from here)
```

---

## Build Order

```
Phase 1: Post-Hoc PR Creation
  (Self-contained, no new callbacks needed)
       |
       v
Phase 2: Scoping Dialogue
  (Adds askQuestion callback; buildGenericPrompt extension)
       |
       v
Phase 3: Follow-Up Task Referencing
  (TaskHistoryEntry enrichment; llm-parser history block update)
       |
       v
Phase 4: Slack Bot
  (Requires SessionCallbacks complete; all core features tested)
```

### Phase 1 First: Post-Hoc PR Creation

No new callback methods. The change is contained to:
- `ReplState.lastResult` storage in `processInput()`
- `"pr"` command intercept in `processInput()`
- CLI `repl.ts` adds `onPrCreated` callback (render PR URL)

This is the most self-contained feature. It establishes the `lastResult` field on `ReplState` that Phase 2 (scoping) also benefits from, and tests the `pr` command intercept pattern before more complex features add intercept logic.

### Phase 2 Second: Scoping Dialogue

Requires `askQuestion` callback to be defined. CLI `repl.ts` implements it with readline (same `askQuestion()` helper already in repl.ts, just needs to be exposed through callbacks). `buildGenericPrompt()` extension is backward-compatible — no existing tests break. `runScopingDialogue()` is a pure function (input: intent + callbacks, output: ScopingResult) — testable in isolation with mock callbacks.

### Phase 3 Third: Follow-Up Task Referencing

Low-risk enrichment of existing `TaskHistoryEntry`. The `finalResponse` field is populated from `RetryResult` already in scope after Phase 1. The LLM prompt block change in `llm-parser.ts` is additive. No existing tests break — the history block includes more text when the field is present.

### Phase 4 Last: Slack Bot

Depends on all `SessionCallbacks` additions being complete and stable. The Slack adapter is a new directory with no modifications to existing code. The adapter can be built and tested in isolation using mock `processInput()` calls. Full integration tests require a Slack workspace — unit tests mock the Slack API.

---

## Architectural Patterns

### Pattern 1: SessionCallbacks as the Channel Abstraction

**What:** Every piece of I/O that differs between CLI and Slack is behind a `SessionCallbacks` method. The session core (`processInput()`) never calls `console.log`, `rl.question()`, or any Slack API directly.

**When to use:** Any time a new v2.3 feature needs user interaction, add an optional method to `SessionCallbacks` rather than inlining the I/O.

**Trade-offs:** More indirection in the session core. Offset by: every adapter (CLI, Slack, future MCP) gets the feature for free by implementing the callback.

**Example:**
```typescript
// WRONG: inline I/O in session core
const answer = await rl.question("Which files?");  // breaks Slack

// RIGHT: delegate through callbacks
const answer = await callbacks.askQuestion?.("Which files/dirs should this touch?") ?? null;
```

### Pattern 2: Optional Callbacks with Graceful Degradation

**What:** New `SessionCallbacks` methods are always optional (`?`). The session core proceeds without them — scoping is skipped if `askQuestion` is absent, PR creation notice is skipped if `onPrCreated` is absent.

**When to use:** Always for new callback methods. Never require a callback that an existing adapter doesn't implement.

**Trade-offs:** Features are silently skipped when callbacks are absent. Mitigated by: the feature is always visible in adapters that implement it; absence is an explicit adapter-level choice.

### Pattern 3: State Fields as Additive, Nullable

**What:** New fields on `ReplState` and `TaskHistoryEntry` are always nullable (`| null`) or optional (`?`). State initialization sets them to `null` or omits them. No code that reads existing fields needs to change.

**When to use:** Any state extension. Do not require new fields to be populated for existing features to work.

**Example:**
```typescript
// WRONG: required field on ReplState
lastResult: LastTaskContext;  // breaks createSessionState(), all tests

// RIGHT: nullable with null default
lastResult: LastTaskContext | null;  // null until first successful task
```

### Pattern 4: Command Intercept Before `parseIntent()`

**What:** Built-in REPL commands (`"pr"`, `"history"`, `"exit"`) are handled before `parseIntent()` is called. This prevents the LLM from misclassifying a command as a coding task.

**When to use:** Any single-word or short-phrase command that should not reach the intent parser.

**Example:**
```typescript
// src/repl/session.ts — command dispatch at top of processInput()
if (isCreatePrCommand(trimmed)) {
  return handlePostHocPr(state, callbacks);
}
// ... existing history, exit, empty checks ...
// Only then: parseIntent()
```

---

## Anti-Patterns

### Anti-Pattern 1: New Execution Path for Slack

**What people do:** Build a separate Slack-specific task runner that calls `runAgent()` directly, bypassing `processInput()`.

**Why it's wrong:** `processInput()` owns the full flow: parse → clarify → confirm → scope → run → history. Bypassing it means the Slack bot gets none of that behavior for free, and diverges from CLI behavior. Every new feature added to `processInput()` would need to be replicated in the Slack path.

**Do this instead:** The Slack adapter calls `processInput()` with Slack-specific `SessionCallbacks`. The core pipeline is shared.

### Anti-Pattern 2: Storing `RetryResult` Outside `ReplState`

**What people do:** Store the last `RetryResult` in a module-level variable or closure in `repl.ts`.

**Why it's wrong:** `ReplState` is explicitly the container for all mutable session state. Module-level variables are not injectable, not testable, and break multiple-session scenarios (e.g. Slack with per-channel state).

**Do this instead:** `state.lastResult` on `ReplState`. The Slack adapter has one `ReplState` per channel — each stores its own `lastResult`.

### Anti-Pattern 3: Making `askQuestion` Required

**What people do:** Add `askQuestion` as a required method on `SessionCallbacks` and update all existing adapters to implement it.

**Why it's wrong:** The one-shot CLI path has no user interaction loop — it cannot implement `askQuestion`. Requiring it breaks the one-shot adapter and forces a stub implementation that returns `null`.

**Do this instead:** `askQuestion?` is optional. `runScopingDialogue()` checks `if (!callbacks.askQuestion) return {}` and skips silently. The one-shot path gets no scoping dialogue — which is correct behavior for a non-interactive command.

### Anti-Pattern 4: Writing Slack Adapter Logic Inside `processInput()`

**What people do:** Add `if (channel === 'slack') { ... }` branching inside `processInput()`.

**Why it's wrong:** The session core becomes channel-aware, defeating the purpose of the `SessionCallbacks` abstraction. Every new channel requires modifying `processInput()`.

**Do this instead:** All channel-specific behavior lives in the adapter's `SessionCallbacks` implementation. `processInput()` calls callbacks without knowing what channel it's running on.

---

## Component Boundaries (v2.3 Target)

```
src/
├── intent/
│   ├── types.ts              NO CHANGE
│   ├── llm-parser.ts         MODIFY: buildHistoryBlock() includes finalResponse when present
│   ├── fast-path.ts          NO CHANGE
│   ├── context-scanner.ts    NO CHANGE
│   ├── confirm-loop.ts       NO CHANGE
│   └── index.ts              NO CHANGE
├── prompts/
│   ├── generic.ts            MODIFY: add optional scopeHints parameter
│   ├── index.ts              MODIFY: pass scopeHints from buildPrompt options to buildGenericPrompt
│   ├── maven.ts              NO CHANGE
│   └── npm.ts                NO CHANGE
├── repl/
│   ├── types.ts              MODIFY: ReplState.lastResult, TaskHistoryEntry rich fields, SessionCallbacks additions
│   ├── session.ts            MODIFY: pr command handler, runScopingDialogue call, lastResult storage, appendHistory enrichment
│   └── scoping.ts            NEW: runScopingDialogue(), ScopingResult type
├── slack/                    NEW DIRECTORY
│   ├── adapter.ts            NEW: SessionCallbacks for Slack
│   ├── bot.ts                NEW: event listener + state management
│   └── index.ts              NEW: exports
├── agent/
│   └── index.ts              VERIFY: pre-built prompt optional param (for lastResult.prompt storage)
├── orchestrator/             NO CHANGE (all 6 files)
├── cli/
│   └── commands/
│       └── repl.ts           MODIFY: implement askQuestion, onMessage, onPrCreated callbacks
├── mcp/                      NO CHANGE
└── types.ts                  NO CHANGE
```

---

## Integration Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| Session core → scoping | `runScopingDialogue(intent, callbacks)` → `ScopingResult` | Only called for `taskType === 'generic'`; returns `{}` if `askQuestion` absent |
| Session core → prompt | `buildPrompt({ ...options, scopeHints })` | `scopeHints` threaded through `AgentOptions` (new optional field) or passed directly |
| Session core → PR creator | `GitHubPRCreator.create(state.lastResult)` | No interface change to `GitHubPRCreator` — called with existing params |
| Slack adapter → session core | `processInput(text, channelState, slackCallbacks, registry)` | Identical call signature to CLI |
| Slack adapter → state | `Map<channelId, ReplState>` | In-memory; Slack bot owns lifecycle |

---

## Sources

- `src/repl/session.ts` — `processInput()` flow, `appendHistory()` internals, HIGH confidence
- `src/repl/types.ts` — `ReplState`, `SessionCallbacks`, `TaskHistoryEntry` interfaces, HIGH confidence
- `src/cli/commands/repl.ts` — CLI callback implementations, `askQuestion()` helper already present, HIGH confidence
- `src/orchestrator/pr-creator.ts` — `GitHubPRCreator.create()` interface, called with `RetryResult` + prompt + options, HIGH confidence
- `src/prompts/generic.ts` — `buildGenericPrompt()` signature, SCOPE block structure, HIGH confidence
- `src/intent/llm-parser.ts` — `buildHistoryBlock()` structure, session history XML format, HIGH confidence
- `.planning/PROJECT.md` v2.3 milestone spec — four target features, SessionCallbacks architecture note, HIGH confidence
- Memory files: `project_conversational_interface.md`, `project_repl_post_hoc_pr.md`, `project_generic_task_prompts.md` — implementation notes, HIGH confidence

---
*Architecture research for: v2.3 REPL enhancements + Slack bot integration — background coding agent*
*Researched: 2026-03-25*
