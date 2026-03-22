# Phase 17: Multi-Turn Session Context - Research

**Researched:** 2026-03-22
**Domain:** TypeScript in-memory session state, intent parsing extension, REPL UX
**Confidence:** HIGH

## Summary

This phase adds follow-up disambiguation to the REPL: after a completed task, the user can say "now do lodash too" and the system inherits `taskType` and `repo` from the last history entry rather than requiring re-statement of project context. The mechanism is intentionally minimal — a small in-memory array appended to `ReplState`, passed into `parseIntent()` via `ParseOptions`, and used by both the fast-path (pattern matching) and the LLM path (system prompt injection).

All decisions are locked in CONTEXT.md. The main risks are (1) fast-path regex ordering and disambiguation accuracy, (2) LLM prompt injection format for history, and (3) UI annotation placement for inherited fields. None of these require external library research — the entire scope is in-project TypeScript code changes with no new dependencies.

Execution isolation is explicitly NOT changed. Each task still launches a fresh Docker container. The history window is a fixed-size in-memory array (10 entries max), which requires no summarization or token-counting logic.

**Primary recommendation:** Implement in-order: `TaskHistoryEntry` type → `ReplState` extension → `ParseOptions` extension → `fastPathParse()` follow-up branches → `llmParse()` system prompt injection → `processInput()` append-and-dispatch → `displayIntent()` annotations → REPL `history` command handler.

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**History shape and storage**
- Minimal tuple per completed task: `{ taskType, dep, version, repo, status }`
- Extends existing `ReplState` interface with `history: TaskHistoryEntry[]` array
- Session core (`session.ts`) appends to history after `runAgent()` completes (not after confirmation)
- All tasks that reach execution are recorded regardless of outcome (success, failed, cancelled)

**History injection into intent parser**
- Add `history?: TaskHistoryEntry[]` field to existing `ParseOptions` interface
- `session.ts` passes `state.history` when calling `parseIntent()`
- Fast-path checks history for follow-up pattern matching (last entry only)
- LLM path receives compact history summary in system prompt for ambiguous follow-ups

**Follow-up resolution logic**
- Fast-path extended with follow-up regex patterns: "also X", "now do X", "same for X", "X too"
- When follow-up detected, inherit `taskType` and `repo` from the **last** history entry only
- If follow-up detected but no history exists: strip prefix, re-parse as fresh command (graceful degradation)
- Falls through to LLM if pattern not recognized or ambiguous (e.g., project switch)
- LLM path also receives history — both paths are history-aware

**Bounding strategy**
- Fixed window of 10 entries (last 10 tasks)
- When window full, oldest entry drops (`shift()`)
- ~200 tokens when serialized for LLM (~20 tokens per entry, <0.1% of Haiku 4.5 context)
- No summarization or token counting needed — fixed window is sufficient

**Confirm display**
- When fields are inherited from session history, annotate the confirm block: `(from session)` next to task type and repo
- User can see what was parsed fresh vs. inherited — builds trust in follow-up mechanism

**REPL `history` command**
- Typing `history` in the REPL shows a numbered list of completed tasks: type, dep, repo, status
- Quick way for user to inspect what context follow-ups will inherit

### Claude's Discretion
- Exact follow-up regex patterns (syntax and ordering)
- LLM system prompt format for history injection
- How to format the `(from session)` annotation in confirm display
- `history` command rendering details (colors, spacing)

### Deferred Ideas (OUT OF SCOPE)
- SESS-02: Follow-up tasks referencing previous task results ("fix the errors from that") — requires rich history with error context, deferred to v2.2+
- Cross-session history persistence — explicitly out of scope per REQUIREMENTS.md (stale context causes misparses)
- Referencing any task in history (not just last) — LLM sees full window but fast-path inherits from last only
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| SESS-01 | REPL session maintains context from prior tasks for follow-up disambiguation | Addressed by: history tuple type in `ReplState`, follow-up fast-path branches, LLM system-prompt injection, `(from session)` confirm annotation, and `history` REPL command |
</phase_requirements>

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| TypeScript | ^5.7.2 | Type definitions for `TaskHistoryEntry`, extended interfaces | Already in project |
| Zod | ^4.3.6 | Already used for `IntentSchema` validation | No new schema needed for history (plain TS interface is sufficient) |
| picocolors | ^1.1.1 | Dim/italic annotation for `(from session)` display | Already used throughout confirm/REPL rendering |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Anthropic SDK | ^0.71.2 | `llmParse()` system prompt already uses this; history injected as additional context | LLM fallback path only |

**No new dependencies required.** This phase is entirely additive changes to existing modules.

**Version verification:** All packages already present in `package.json` — no installation required.

## Architecture Patterns

### Where Each Change Lives

```
src/repl/
├── types.ts          # Add TaskHistoryEntry interface; add history field to ReplState
└── session.ts        # Pass state.history to parseIntent(); append to history after runAgent(); handle "history" command

src/intent/
├── index.ts          # Add history?: TaskHistoryEntry[] to ParseOptions; pass to fastPathParse and llmParse
├── fast-path.ts      # Add follow-up detection before standard dependency patterns
├── llm-parser.ts     # Accept history param; inject compact summary into system prompt
└── confirm-loop.ts   # Accept inheritedFields set; annotate task/repo with "(from session)"
```

### Pattern 1: Extend ReplState with bounded history array

**What:** Add `history: TaskHistoryEntry[]` to `ReplState` and initialise it in `createSessionState()`. Append after `runAgent()` resolves (or rejects), enforcing the 10-entry cap with `shift()`.

**When to use:** Always — history is session-scoped and must be available to every `processInput()` call.

```typescript
// src/repl/types.ts
export interface TaskHistoryEntry {
  taskType: string;
  dep: string | null;
  version: string | null;
  repo: string;
  status: 'success' | 'failed' | 'cancelled';
}

export interface ReplState {
  currentProject: string | null;
  currentProjectName: string | null;
  history: TaskHistoryEntry[];   // NEW — bounded to MAX_HISTORY_ENTRIES
}
```

```typescript
// src/repl/session.ts — append in finally block after runAgent
const MAX_HISTORY_ENTRIES = 10;

function appendHistory(state: ReplState, entry: TaskHistoryEntry): void {
  if (state.history.length >= MAX_HISTORY_ENTRIES) {
    state.history.shift();
  }
  state.history.push(entry);
}
```

**Key decision:** Record all tasks that reach execution (the `runAgent()` call), regardless of outcome. This mirrors the decision in CONTEXT.md ("all tasks that reach execution are recorded regardless of outcome").

### Pattern 2: Follow-up detection in fast-path (before standard patterns)

**What:** Before the existing `DEPENDENCY_PATTERNS` match loop, check for follow-up prefix words. If detected, strip the prefix, extract the bare dependency name, and return a `FastPathFollowUpResult` (or a regular `FastPathResult` with `isFollowUp: true`). The caller (`parseIntent`) then merges `taskType` and `repo` from the last history entry.

**When to use:** Only when `history` is provided and non-empty. If no history, follow-up detection strips the prefix and re-parses as a fresh command (graceful degradation).

**Recommended follow-up patterns (Claude's discretion):**
```typescript
// Ordered most-specific to least-specific to avoid false positives
const FOLLOW_UP_PATTERNS = [
  /^(?:also\s+(?:update|upgrade|bump)|now\s+(?:do|update|upgrade|bump)|same\s+for|do\s+(?:the\s+same\s+for))\s+(?<dep>@?[a-z0-9\-._~/]+)/i,
  /^(?:update|upgrade|bump)\s+(?<dep>@?[a-z0-9\-._~/]+)\s+too\s*$/i,
  /^(?<dep>@?[a-z0-9\-._~/]+)\s+too\s*$/i,
];
```

**Graceful degradation when history is empty:**
```typescript
// Strip known follow-up prefixes and re-parse as standard input
const FOLLOW_UP_PREFIX = /^(?:also\s+|now\s+do\s+|same\s+for\s+)/i;
const stripped = input.replace(FOLLOW_UP_PREFIX, '');
return fastPathParse(stripped); // re-enter standard path
```

### Pattern 3: History injection into LLM system prompt

**What:** Append a compact `<session_history>` XML block to the existing `INTENT_SYSTEM_PROMPT` when history is non-empty. This is appended to the static system prompt, not the user message, to keep the per-call content clean.

**Why XML tags:** Consistent with existing `<manifest_context>` and `<user_input>` delimiters already in `llmParse()`.

**Recommended format (Claude's discretion):**
```typescript
function buildHistoryBlock(history: TaskHistoryEntry[]): string {
  const lines = history.map((h, i) =>
    `  ${i + 1}. ${h.taskType} | dep: ${h.dep ?? 'none'} | repo: ${h.repo} | status: ${h.status}`
  );
  return `\n\n<session_history>\nPrevious tasks this session (most recent last):\n${lines.join('\n')}\n</session_history>`;
}
```

**LLM guidance to add to system prompt when history present:**
```
When the user says "also X", "now do X", "X too", or similar follow-up phrases,
inherit taskType and repo from the most recent session_history entry unless the
user explicitly specifies a different project.
```

**Token budget:** 10 entries × ~20 tokens = ~200 tokens. Haiku 4.5 context window is 200K tokens. Impact is negligible (< 0.1%).

### Pattern 4: `(from session)` annotation in confirm display

**What:** `displayIntent()` in `confirm-loop.ts` currently renders task type and project unconditionally. Add an optional `inheritedFields?: Set<'taskType' | 'repo'>` parameter. When a field is in the set, append `pc.dim('(from session)')` after the value.

**Recommended format (Claude's discretion):**
```typescript
export function displayIntent(intent: ResolvedIntent, inheritedFields?: Set<string>): void {
  const fromSession = pc.dim(' (from session)');
  console.log('');
  console.log(pc.bold('  Parsed Intent:'));
  const taskSuffix = inheritedFields?.has('taskType') ? fromSession : '';
  console.log(`    Task:    ${pc.cyan(intent.taskType)}${taskSuffix}`);
  const projSuffix = inheritedFields?.has('repo') ? fromSession : '';
  console.log(`    Project: ${pc.cyan(path.basename(intent.repo))}${projSuffix}`);
  if (intent.dep) console.log(`    Dep:     ${pc.cyan(intent.dep)}`);
  if (intent.version) console.log(`    Version: ${pc.cyan(intent.version)}`);
  if (intent.createPr) console.log(`    PR:      ${pc.cyan('yes')}`);
  console.log('');
}
```

`inheritedFields` flows from `parseIntent()` return value → `session.ts` → `callbacks.confirm()` → `displayIntent()`.

**Where to add inherited metadata on ResolvedIntent:**
```typescript
// src/intent/types.ts — add optional field
export interface ResolvedIntent {
  // ... existing fields ...
  inheritedFields?: Set<'taskType' | 'repo'>;  // NEW
}
```

### Pattern 5: REPL `history` command

**What:** In `processInput()` (or the REPL main loop in `repl.ts`), check for the literal string `"history"` before dispatching to `parseIntent()`. Print numbered list and return `{ action: 'continue' }`.

**Where:** `processInput()` in `session.ts` — keeps it in the channel-agnostic session core, consistent with how `exit`/`quit` are handled.

**Recommended rendering (Claude's discretion):**
```typescript
if (trimmed === 'history') {
  if (state.history.length === 0) {
    console.log(pc.dim('\n  No tasks in session history.\n'));
  } else {
    console.log('');
    state.history.forEach((h, i) => {
      const statusColor = h.status === 'success' ? pc.green : h.status === 'cancelled' ? pc.yellow : pc.red;
      console.log(
        `  ${pc.dim(String(i + 1).padStart(2))}. ${pc.cyan(h.taskType)} | ${h.dep ?? pc.dim('no dep')} | ${pc.dim(path.basename(h.repo))} | ${statusColor(h.status)}`
      );
    });
    console.log('');
  }
  return { action: 'continue' };
}
```

### Anti-Patterns to Avoid

- **Appending history in session.ts BEFORE runAgent completes:** History records actual execution outcomes (success/failed/cancelled). Appending after `confirm()` but before `runAgent()` would record tasks that were never actually run.
- **Mutating history inside `parseIntent()`:** The intent parser is channel-agnostic and must remain read-only with respect to session state. Only `processInput()` in `session.ts` mutates `state.history`.
- **Putting follow-up inheritance logic inside `llmParse()`:** The fast-path handles the obvious cases. LLM receives history as context but the field-inheritance decision (`inheritedFields`) should be determined in `parseIntent()`, not inside the LLM response parsing.
- **Growing history unboundedly:** The `shift()` cap must be applied in every append path, not just "when it looks like it's getting large."
- **Persisting history to disk:** Cross-session context is explicitly out of scope. History lives only in `ReplState` which is destroyed on REPL exit.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Token counting for history budget | Custom tokenizer or `tiktoken` | Fixed window of 10 entries | 200-token ceiling is <0.1% of Haiku 4.5 context; no counting needed |
| Similarity matching for follow-up detection | Embedding cosine similarity | Regex prefix patterns + LLM fallback | The fast-path only needs to detect a handful of short phrases; LLM handles the ambiguous cases |
| History serialization format | Custom compact encoder | JSON.stringify on the `TaskHistoryEntry[]` slice | Sufficient; the entries are small and already plain objects |

**Key insight:** Every tempting "smart" feature (token counting, semantic matching, summarization) is pre-empted by deliberately limiting scope to 10 entries and relying on the existing fast-path/LLM fallback architecture.

## Common Pitfalls

### Pitfall 1: Follow-up regex false-positive on multi-dep commands
**What goes wrong:** Pattern `/^also\s+update\s+.../i` accidentally matches "also update the config file" (a generic task), returning a dep name of "the".
**Why it happens:** The dep capture group in follow-up patterns is greedy and matches non-dep strings.
**How to avoid:** Reuse the same dep character class `@?[a-z0-9\-._~/]+` that existing `DEPENDENCY_PATTERNS` uses, so multi-word phrases cannot match as a single dep.
**Warning signs:** Test "also fix the login bug" — should return `null` from follow-up detection.

### Pitfall 2: `inheritedFields` not threaded through to displayIntent
**What goes wrong:** The `(from session)` annotation is invisible in the confirm block because `inheritedFields` is created in `parseIntent()` but not passed to the confirm callback.
**Why it happens:** `SessionCallbacks.confirm` takes `(intent, reparse)` — `intent` is `ResolvedIntent`. If `inheritedFields` is not on `ResolvedIntent`, it's lost.
**How to avoid:** Add `inheritedFields?: Set<'taskType' | 'repo'>` to `ResolvedIntent` in `types.ts`. Then `displayIntent()` reads it from the intent directly, no signature change required for the callback.

### Pitfall 3: History appended even when user cancels at confirm
**What goes wrong:** A task appears in `history` even though the user pressed "n" at the confirm prompt and `runAgent()` was never called.
**Why it happens:** If append logic is placed before the `confirm()` await, it runs regardless of the user's choice.
**How to avoid:** The CONTEXT.md decision is explicit: append "after `runAgent()` completes (not after confirmation)." Place append in a `try/finally` around `runAgent()`, capturing the status from `result.finalStatus` for success/failed and using a `cancelled` sentinel for `AbortError`.

### Pitfall 4: `history` command tested against session.ts but "history" command handler is in repl.ts
**What goes wrong:** Implementing the `history` command in `repl.ts` (CLI adapter) rather than in `session.ts` (session core) makes it impossible to unit-test without a readline interface.
**Why it happens:** It's tempting to add it where the readline loop lives.
**How to avoid:** Place it in `processInput()` in `session.ts` alongside the existing `exit`/`quit` guards. The session.test.ts pattern of mocking `parseIntent` and calling `processInput()` directly will naturally cover the `history` command.

### Pitfall 5: Existing session.test.ts broken by adding `history` to ReplState
**What goes wrong:** `createSessionState()` change adds `history: []` but test fixtures using `makeCallbacks()` or calling `createSessionState()` still pass the old state shape — TypeScript catches this at compile but runtime mock objects may silently pass.
**Why it happens:** `makeCallbacks` returns `SessionCallbacks`, which doesn't include state. But `processInput` calls `state.history` — if tests construct `state` manually (e.g., `{ currentProject: null, currentProjectName: null }`) TypeScript will flag the missing field.
**How to avoid:** Always use `createSessionState()` in tests. Update the existing tests to call `createSessionState()` if any were hand-constructing state objects.

## Code Examples

Verified patterns from existing codebase:

### How fast-path currently handles input — reference for follow-up extension
```typescript
// Source: src/intent/fast-path.ts (current implementation)
export function fastPathParse(input: string): FastPathResult | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const createPr = PR_SUFFIX.test(trimmed);
  const cleaned = createPr ? trimmed.replace(PR_SUFFIX, '') : trimmed;
  for (const pattern of DEPENDENCY_PATTERNS) {
    const m = cleaned.match(pattern);
    if (m?.groups) {
      return { dep: m.groups.dep, version: m.groups.version ?? 'latest', project: m.groups.project ?? null, createPr };
    }
  }
  return null;
}
```

The follow-up detection should run BEFORE this loop (early return with inherited flag) or as a separate exported function called in `parseIntent()`.

### How LLM prompt is constructed — reference for history injection
```typescript
// Source: src/intent/llm-parser.ts (current implementation)
content: `<manifest_context>\n${escapeXml(manifestContext)}\n</manifest_context>\n\n<user_input>${escapeXml(truncatedInput)}</user_input>`
```

History block should be appended between `</manifest_context>` and `<user_input>`:
```
<manifest_context>...</manifest_context>
<session_history>...</session_history>
<user_input>...</user_input>
```

### How processInput currently appends state after confirmation — reference for history append
```typescript
// Source: src/repl/session.ts (current, lines 77-79)
await autoRegisterCwd(registry, confirmed.repo);
state.currentProject = confirmed.repo;
state.currentProjectName = path.basename(confirmed.repo);
```

History append belongs after `runAgent()`, using a `try/finally` to capture `cancelled` status on `AbortError`:
```typescript
let historyStatus: TaskHistoryEntry['status'] = 'failed';
try {
  const result = await runAgent(agentOptions, agentContext);
  historyStatus = result.finalStatus === 'success' ? 'success' : 'failed';
  return { action: 'continue', result, intent: confirmed };
} catch (err) {
  historyStatus = (err as Error).name === 'AbortError' ? 'cancelled' : 'failed';
  throw err;
} finally {
  callbacks.onAgentEnd?.();
  appendHistory(state, {
    taskType: confirmed.taskType,
    dep: confirmed.dep ?? null,
    version: confirmed.version ?? null,
    repo: confirmed.repo,
    status: historyStatus,
  });
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| No session context (Phase 16) | Bounded in-memory history with fast-path follow-up detection | Phase 17 | Users can chain tasks naturally without restating project context |
| Stateless `parseIntent()` | `parseIntent()` is history-aware via `ParseOptions.history` | Phase 17 | Parser can now disambiguate follow-up patterns using prior context |

## Open Questions

1. **Should `history` command be handled before or inside `processInput()`?**
   - What we know: `exit`/`quit` are handled inside `processInput()`; CLI adapter calls `processInput()` for all non-empty input
   - What's unclear: Whether handling `history` in the CLI adapter (`repl.ts` main loop) would make it easier to display without a `SessionOutput` return
   - Recommendation: Handle inside `processInput()` in `session.ts` (consistent with `exit`/`quit` and keeps it testable without readline)

2. **When `runAgent()` is aborted mid-run, should the entry be status `'cancelled'` or omitted?**
   - What we know: CONTEXT.md says "all tasks that reach execution are recorded regardless of outcome"
   - What's unclear: Whether an AbortError thrown by `runAgent()` counts as "reached execution"
   - Recommendation: Record as `'cancelled'` — it did reach execution (Docker container started). Consistent with `result.finalStatus === 'cancelled'` in the existing `RetryResult` type.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest ^4.0.18 |
| Config file | vitest.config.ts |
| Quick run command | `npx vitest run src/repl/session.test.ts src/intent/fast-path.test.ts src/intent/index.test.ts src/intent/llm-parser.test.ts src/intent/confirm-loop.test.ts` |
| Full suite command | `npm test` |

### Phase Requirements to Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SESS-01 | Follow-up input inherits repo+taskType from last history entry | unit | `npx vitest run src/repl/session.test.ts` | Exists (needs new test cases) |
| SESS-01 | History bounded to 10 entries, oldest drops on overflow | unit | `npx vitest run src/repl/session.test.ts` | Exists (needs new test case) |
| SESS-01 | Fast-path detects "also X", "now do X", "X too" patterns | unit | `npx vitest run src/intent/fast-path.test.ts` | Exists (needs new test cases) |
| SESS-01 | Follow-up with no history gracefully strips prefix | unit | `npx vitest run src/intent/fast-path.test.ts` | Exists (needs new test case) |
| SESS-01 | History injected into LLM system prompt when non-empty | unit | `npx vitest run src/intent/llm-parser.test.ts` | Exists (needs new test case) |
| SESS-01 | `history` command prints completed tasks and returns continue | unit | `npx vitest run src/repl/session.test.ts` | Exists (needs new test case) |
| SESS-01 | `(from session)` displayed in confirm block for inherited fields | unit | `npx vitest run src/intent/confirm-loop.test.ts` | Exists (needs new test case) |
| SESS-01 | Execution isolation: each runAgent call gets fresh signal | unit | `npx vitest run src/repl/session.test.ts` | Existing test 9 — no change needed |

### Sampling Rate
- **Per task commit:** `npx vitest run src/repl/session.test.ts src/intent/fast-path.test.ts`
- **Per wave merge:** `npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
None — existing test infrastructure covers all phase requirements. New test cases are additions to existing test files, not new files.

## Sources

### Primary (HIGH confidence)
- Direct code inspection: `src/repl/session.ts`, `src/repl/types.ts`, `src/intent/index.ts`, `src/intent/fast-path.ts`, `src/intent/llm-parser.ts`, `src/intent/confirm-loop.ts`, `src/intent/types.ts`, `src/cli/commands/repl.ts`
- Direct test inspection: `src/repl/session.test.ts`, `src/intent/fast-path.test.ts`
- `.planning/phases/17-multi-turn-session-context/17-CONTEXT.md` — all implementation decisions

### Secondary (MEDIUM confidence)
- `.planning/STATE.md` — accumulated project decisions (Phase 14-16 patterns)
- `.planning/REQUIREMENTS.md` — SESS-01 definition and out-of-scope rules

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new dependencies; existing stack fully understood from code inspection
- Architecture: HIGH — all integration points identified from current source; patterns derived from existing code style
- Pitfalls: HIGH — sourced from code inspection of actual integration seams and test patterns; 1 LOW item (abort status recording) flagged as open question

**Research date:** 2026-03-22
**Valid until:** 2026-04-22 (stable codebase; no external dependencies change)
