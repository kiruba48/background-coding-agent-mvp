# Phase 23: Follow-Up Task Referencing - Research

**Researched:** 2026-04-01
**Domain:** REPL session state enrichment, LLM prompt engineering, TypeScript interface extension
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**History block content**
- Each history entry shows: taskType, dep, repo, status, Task description, and Changes summary (truncated finalResponse)
- All task statuses get the enriched format (success, failed, zero_diff, cancelled) — failed tasks still provide useful follow-up context
- Dep updates use finalResponse for the Changes line same as generic tasks — no special casing
- Scope hints from Phase 22 are NOT included in the history block — description + summary is sufficient
- Changes line is omitted entirely when finalResponse is empty/undefined — no placeholder text

**Reference resolution**
- Prompt guidance only — no new schema fields on the intent output
- Add a paragraph to INTENT_SYSTEM_PROMPT explaining reference patterns: "that/it" = most recent, "task N" = Nth entry, keyword match = scan Task descriptions
- Auto-inherit repo from referenced task — user can override with explicit "in project-x"
- Raw user input used as description — no rewriting to expand references (end-state prompting discipline)

**Change summary extraction**
- Simple truncation: first 300 chars of finalResponse, cut at last sentence boundary (period/exclamation/question mark)
- Minimum 50 chars before accepting a sentence boundary — prevents cutting at a tiny first sentence
- Store raw finalResponse on TaskHistoryEntry, truncate only when buildHistoryBlock() formats the LLM prompt
- New `finalResponse?: string` field on TaskHistoryEntry

**Data flow**
- Declare `let taskResult: RetryResult | undefined` before try block in processInput()
- Assign in try block (same pattern as historyStatus)
- Pass `taskResult?.finalResponse` to appendHistory() in finally block
- appendHistory() stores full finalResponse on the TaskHistoryEntry

**Edge case handling**
- Empty history + follow-up reference ("add tests for that"): LLM resolves naturally — no session_history block means no context, so confidence = 'low' with clarifications
- Out-of-bounds positional reference ("task 3" with 2 entries): LLM handles it — it can see history has only 2 entries, will set low confidence
- No special pre-parse detection code for either case — existing clarification flow handles ambiguity

### Claude's Discretion
- Exact wording of the system prompt reference resolution paragraph
- Whether to add a `summarize()` utility function or inline the truncation logic
- Test structure and coverage approach

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| FLLW-03 | Follow-up inputs like "now add tests for that" can reference previous task outcome via enriched history | TaskHistoryEntry gains `finalResponse?` field; buildHistoryBlock() enriches XML output with Task/Changes lines; INTENT_SYSTEM_PROMPT gains reference resolution guidance paragraph; together these enable the LLM to resolve pronoun and positional references against real task outcomes |
</phase_requirements>

---

## Summary

Phase 23 is a focused enrichment of the existing session history pipeline. The full data pipeline already exists: `processInput()` captures `RetryResult` after task completion (for Phase 21 post-hoc PR); `appendHistory()` writes `TaskHistoryEntry` to `ReplState.history`; `buildHistoryBlock()` formats history into an XML block injected into the LLM prompt; and `INTENT_SYSTEM_PROMPT` already has a conditional follow-up guidance paragraph appended when history is non-empty. The changes are additive and contained in three files.

The core work is: (1) add `finalResponse?: string` to `TaskHistoryEntry` in `src/repl/types.ts`; (2) update the data flow in `processInput()` to capture `taskResult?.finalResponse` and pass it through `appendHistory()`; (3) extend `buildHistoryBlock()` to emit `Task:` and `Changes:` lines per entry (omitting Changes when finalResponse is absent); (4) extend `INTENT_SYSTEM_PROMPT` with a reference resolution paragraph covering pronoun/positional/keyword reference patterns.

The truncation logic (first 300 chars, cut at last sentence boundary >= 50 chars) is a utility function that belongs in `buildHistoryBlock()`. The decision to store raw finalResponse and truncate only at format time is correct — it keeps the stored state flexible and avoids irreversible data loss if the format changes later.

**Primary recommendation:** Implement as two tasks — Task 1: types + data flow + truncation utility; Task 2: prompt engineering (buildHistoryBlock format + INTENT_SYSTEM_PROMPT paragraph) + tests.

---

## Standard Stack

### Core
| Component | Version | Purpose | Why Standard |
|-----------|---------|---------|--------------|
| vitest | ^4.0.18 | Unit test runner | Already the project test framework |
| TypeScript | project-wide | Type safety for interface extensions | Already the project language |

No new dependencies. All changes are in-process TypeScript modifications to existing modules.

**Installation:** No new packages required.

---

## Architecture Patterns

### Files Changed

```
src/
├── repl/
│   ├── types.ts          # Add finalResponse?: string to TaskHistoryEntry
│   └── session.ts        # Capture taskResult, pass finalResponse to appendHistory()
└── intent/
    └── llm-parser.ts     # Extend buildHistoryBlock(), extend INTENT_SYSTEM_PROMPT
```

### Pattern 1: TaskHistoryEntry Field Addition

**What:** Add an optional field to the existing `TaskHistoryEntry` interface following the established pattern of optional fields with `?`.

**When to use:** Extending persisted-in-session history with task outcome data.

**Existing pattern in src/repl/types.ts:**
```typescript
export interface TaskHistoryEntry {
  taskType: TaskType;
  dep: string | null;
  version: string | null;
  repo: string;
  status: 'success' | 'failed' | 'cancelled' | 'zero_diff';
  description?: string;  // FLLW-01: optional field pattern
}
```

**New field follows same convention:**
```typescript
export interface TaskHistoryEntry {
  // ... existing fields ...
  description?: string;   // FLLW-01
  finalResponse?: string; // FLLW-03: raw agent response for Changes summary
}
```

### Pattern 2: processInput() try/finally Data Capture

**What:** Mirror the existing `historyStatus` variable pattern to capture `taskResult` before the finally block.

**Existing pattern in src/repl/session.ts (lines 247-279):**
```typescript
let historyStatus: TaskHistoryEntry['status'] = 'failed';
try {
  const result = await runAgent(agentOptions, agentContext);
  // ...
  historyStatus = result.finalStatus === 'success' ? 'success' : ...;
  return { action: 'continue', result, intent: confirmed };
} catch (err) {
  historyStatus = err instanceof Error && err.name === 'AbortError' ? 'cancelled' : 'failed';
  throw err;
} finally {
  callbacks.onAgentEnd?.();
  appendHistory(state, {
    // ... uses historyStatus ...
  });
}
```

**New taskResult variable mirrors exactly:**
```typescript
let historyStatus: TaskHistoryEntry['status'] = 'failed';
let taskResult: RetryResult | undefined;
try {
  const result = await runAgent(agentOptions, agentContext);
  taskResult = result; // Capture unconditionally — all statuses provide context
  // ...
} finally {
  appendHistory(state, {
    // ...
    finalResponse: taskResult?.finalResponse,
  });
}
```

**Key insight:** `RetryResult` does NOT have a `finalResponse` field directly — the field lives on `SessionResult` inside `sessionResults[]`. The last `SessionResult.finalResponse` is the agent's final text. Access pattern:
```typescript
taskResult?.sessionResults?.at(-1)?.finalResponse
```

This is critical: `src/types.ts` shows `RetryResult.sessionResults: SessionResult[]` and `SessionResult.finalResponse: string`. There is NO `finalResponse` on `RetryResult` itself.

### Pattern 3: buildHistoryBlock() Format Extension

**Existing format (src/intent/llm-parser.ts lines 68-73):**
```typescript
function buildHistoryBlock(history: TaskHistoryEntry[]): string {
  const lines = history.map((h, i) =>
    `  ${i + 1}. ${escapeXml(h.taskType)} | dep: ${escapeXml(h.dep ?? 'none')} | repo: ${escapeXml(path.basename(h.repo))} | status: ${escapeXml(h.status)}`
  );
  return `<session_history>\nPrevious tasks this session (most recent last):\n${lines.join('\n')}\n</session_history>`;
}
```

**New format adds Task and optional Changes lines:**
```typescript
function summarize(raw: string): string {
  if (!raw || raw.length <= 300) return raw;
  const truncated = raw.slice(0, 300);
  // Find last sentence boundary at >= 50 chars
  const match = truncated.slice(50).search(/[.!?]/);
  if (match === -1) return truncated;
  return truncated.slice(0, 50 + match + 1);
}

function buildHistoryBlock(history: TaskHistoryEntry[]): string {
  const lines = history.flatMap((h, i) => {
    const header = `  ${i + 1}. ${escapeXml(h.taskType)} | dep: ${escapeXml(h.dep ?? 'none')} | repo: ${escapeXml(path.basename(h.repo))} | status: ${escapeXml(h.status)}`;
    const taskLine = h.description ? `     Task: ${escapeXml(h.description)}` : null;
    const changesLine = h.finalResponse ? `     Changes: ${escapeXml(summarize(h.finalResponse))}` : null;
    return [header, taskLine, changesLine].filter(Boolean) as string[];
  });
  return `<session_history>\nPrevious tasks this session (most recent last):\n${lines.join('\n')}\n</session_history>`;
}
```

### Pattern 4: INTENT_SYSTEM_PROMPT Extension

**Existing follow-up guidance (appended conditionally when history exists, lines 101-103):**
```typescript
const systemPrompt = hasHistory
  ? INTENT_SYSTEM_PROMPT + '\n\nWhen the user says "also X", "now do X", "X too", or similar follow-up phrases, inherit taskType and repo from the most recent session_history entry unless the user explicitly specifies a different project.'
  : INTENT_SYSTEM_PROMPT;
```

**New guidance paragraph to append additionally covers reference resolution:**
The string literal currently uses a single `\n\n` continuation. The new paragraph should be added after or alongside the existing follow-up phrase guidance. Example (exact wording is Claude's discretion):

```
When the user references a previous task with pronouns or positions:
- "that", "it", "the last task" → resolve to the most recent session_history entry (entry N where N = history length)
- "task 2", "the second task" → resolve to the Nth entry by 1-based position; if out of bounds, set confidence to 'low' with a clarification
- keyword references ("the auth task", "the lodash update") → scan Task: lines in session_history for keyword match
- Inherit repo from the referenced entry unless the user says "in project-x" or similar explicit override
```

### Anti-Patterns to Avoid

- **Storing summarized finalResponse on TaskHistoryEntry:** Store raw, truncate in buildHistoryBlock(). Raw data is irreversible to lose.
- **Accessing `result.finalResponse` directly on RetryResult:** The field does not exist there. Use `result.sessionResults.at(-1)?.finalResponse`.
- **Capturing taskResult only on success path:** Capture unconditionally — failed/zero_diff task outcomes still help the LLM understand what happened.
- **Adding placeholder text when finalResponse is empty:** The decision is to omit the Changes line entirely, not emit "No changes" or similar.
- **Scope hints in history block:** Explicitly out of scope — description + Changes summary is sufficient.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Reference resolution logic | Custom pre-parse code to detect pronouns/positions | LLM prompt guidance | The LLM already parses intent and handles ambiguity via clarifications; prompt engineering is the right layer |
| Session boundary detection | Code to detect "empty history + follow-up" | Existing clarification flow | `confidence='low'` + clarifications already handles ambiguous inputs without history |
| XML escaping | Custom sanitizer | Existing `escapeXml()` in llm-parser.ts line 63 | Already handles all five XML special characters: `& < > " '` |

**Key insight:** All reference resolution complexity belongs in the LLM prompt, not in application code. The existing clarification flow (confidence=low + clarifications list) already handles edge cases that can't be resolved.

---

## Common Pitfalls

### Pitfall 1: Wrong Access Path for finalResponse
**What goes wrong:** Accessing `taskResult.finalResponse` when that field does not exist on `RetryResult`.
**Why it happens:** `SessionResult` has `finalResponse: string` but `RetryResult` does not. They are different types.
**How to avoid:** Use `taskResult?.sessionResults?.at(-1)?.finalResponse`. The `at(-1)` accessor handles an empty sessionResults array (returns undefined).
**Warning signs:** TypeScript compiler error "Property 'finalResponse' does not exist on type 'RetryResult'".

### Pitfall 2: Breaking Existing History Tests
**What goes wrong:** Changing `buildHistoryBlock()` format breaks the existing `llm-parser.test.ts` session history tests that assert on the exact string content.
**Why it happens:** Tests currently assert on the inline format `"npm-dependency-update | dep: react | repo: repo | status: success"`. New multi-line format changes this.
**How to avoid:** Review all assertions in the `session history injection` describe block. Tests that assert on string containment (e.g., `toContain('npm-dependency-update')`) will still pass; tests that assert on exact format strings will need updating.
**Warning signs:** Tests in `llm-parser.test.ts` lines 160-222 that assert `toContain` with the exact old format string.

### Pitfall 3: appendHistory() Signature Change Breaks Callers
**What goes wrong:** Adding `finalResponse` parameter to `appendHistory()` without updating all call sites causes TypeScript errors or missing data.
**Why it happens:** `appendHistory()` is called in exactly one place in the finally block of `processInput()`. But adding a required parameter vs. an optional field matters.
**How to avoid:** The `TaskHistoryEntry` field is optional (`finalResponse?:`), so `appendHistory()` receives the full entry object — no signature change needed to appendHistory itself. The change is in the object literal passed at the call site.

### Pitfall 4: summarize() Edge Cases
**What goes wrong:** Truncation regex finds a sentence boundary in the wrong position — e.g., if the text begins with "v2.1. Added..." and period at char 3 satisfies the regex.
**Why it happens:** Searching for `.!?` without anchoring to word boundaries can match version numbers or abbreviations.
**How to avoid:** The minimum 50 chars before accepting a boundary is the protection: `truncated.slice(50).search(/[.!?]/)`. This skips the first 50 characters before looking for a boundary. Test with inputs like "v1.0. Something else..." to verify.

---

## Code Examples

### Accessing finalResponse from RetryResult
```typescript
// Source: src/types.ts — RetryResult.sessionResults: SessionResult[], SessionResult.finalResponse: string
const finalResponse = taskResult?.sessionResults?.at(-1)?.finalResponse;
```

### Summarize Utility (inline or exported)
```typescript
// Truncate to last sentence boundary within 300 chars, with 50-char minimum
function summarize(raw: string): string {
  if (!raw || raw.length <= 300) return raw;
  const truncated = raw.slice(0, 300);
  const searchFrom = 50;
  const match = truncated.slice(searchFrom).search(/[.!?]/);
  if (match === -1) return truncated; // no boundary found — hard cut at 300
  return truncated.slice(0, searchFrom + match + 1);
}
```

### Updated buildHistoryBlock() entry format
```typescript
// Entry with description and changes:
//   1. generic | dep: none | repo: my-repo | status: success
//      Task: add error handling to auth module
//      Changes: Added try/catch blocks in auth.ts. Updated error types.
```

### XML injection prevention for new fields
```typescript
// escapeXml() already handles all five XML chars — use it on description and finalResponse too
const changesLine = h.finalResponse
  ? `     Changes: ${escapeXml(summarize(h.finalResponse))}`
  : null;
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| History block has only status/type/dep/repo | History block adds Task description + Changes summary | Phase 23 | LLM can resolve "that" / "the auth task" to specific prior work |
| Follow-up guidance only covers "also X" / "now do X" | Follow-up guidance covers pronoun + positional + keyword references | Phase 23 | Richer reference resolution without output schema changes |

---

## Open Questions

1. **`summarize()` placement — utility function vs. inline**
   - What we know: Truncation logic is 4-6 lines; used only in `buildHistoryBlock()`
   - What's unclear: Whether a standalone exported `summarize()` function is worth the testing overhead vs. inline logic
   - Recommendation: Export `summarize()` as a named function for isolated unit testability — matches project pattern of exporting small utilities (e.g., `runScopingDialogue` is exported for test isolation)

2. **Exact system prompt wording for reference resolution**
   - What we know: Must cover three patterns: pronoun, positional, keyword
   - What's unclear: How much verbosity is optimal for Haiku (the model used for llmParse)
   - Recommendation: Keep it concise (3-4 bullet points) — Haiku responds well to bullet-listed rules based on existing prompt patterns

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest ^4.0.18 |
| Config file | vitest.config.ts (project root) |
| Quick run command | `npx vitest run src/repl/session.test.ts src/intent/llm-parser.test.ts` |
| Full suite command | `npm test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| FLLW-03 | finalResponse field stored on TaskHistoryEntry after task completion | unit | `npx vitest run src/repl/session.test.ts` | ✅ (extend existing) |
| FLLW-03 | appendHistory() receives finalResponse and stores it | unit | `npx vitest run src/repl/session.test.ts` | ✅ (extend existing) |
| FLLW-03 | buildHistoryBlock() includes Task and Changes lines when present | unit | `npx vitest run src/intent/llm-parser.test.ts` | ✅ (extend existing) |
| FLLW-03 | buildHistoryBlock() omits Changes line when finalResponse absent | unit | `npx vitest run src/intent/llm-parser.test.ts` | ✅ (extend existing) |
| FLLW-03 | summarize() truncates at last sentence boundary >= 50 chars | unit | `npx vitest run src/intent/llm-parser.test.ts` | ❌ new test needed |
| FLLW-03 | system prompt includes reference resolution guidance when history present | unit | `npx vitest run src/intent/llm-parser.test.ts` | ✅ (extend existing check) |
| FLLW-03 | XML escaping applied to description and finalResponse in history block | unit | `npx vitest run src/intent/llm-parser.test.ts` | ✅ (extend existing injection test) |

### Sampling Rate
- **Per task commit:** `npx vitest run src/repl/session.test.ts src/intent/llm-parser.test.ts`
- **Per wave merge:** `npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- None — existing test infrastructure covers all phase requirements; only test extensions and new test cases are needed within existing test files

---

## Sources

### Primary (HIGH confidence)
- Direct code read: `src/repl/types.ts` — confirmed TaskHistoryEntry schema, ReplState shape, ScopeHint pattern
- Direct code read: `src/repl/session.ts` — confirmed processInput() try/finally pattern, appendHistory() signature, historyStatus variable pattern
- Direct code read: `src/intent/llm-parser.ts` — confirmed buildHistoryBlock() format, INTENT_SYSTEM_PROMPT content, llmParse() signature, escapeXml() location
- Direct code read: `src/types.ts` — confirmed RetryResult.sessionResults: SessionResult[] and SessionResult.finalResponse: string (NOT on RetryResult directly)
- Direct code read: `src/repl/session.test.ts` — confirmed existing mock patterns, makeRetryResult() helper, test setup
- Direct code read: `src/intent/llm-parser.test.ts` — confirmed existing session history inject tests, XML escape test patterns
- `.planning/phases/23-follow-up-task-referencing/23-CONTEXT.md` — locked decisions, implementation constraints

### Secondary (MEDIUM confidence)
- `.planning/REQUIREMENTS.md` — FLLW-03 requirement definition, phase traceability
- `.planning/STATE.md` — accumulated project decisions, phase ordering rationale

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new dependencies, existing vitest infrastructure
- Architecture: HIGH — all patterns read directly from current source code
- Pitfalls: HIGH — identified from type inspection (RetryResult shape mismatch is real and would cause runtime/compile error)
- Prompt engineering: MEDIUM — exact wording TBD (Claude's discretion), but pattern is confirmed from existing follow-up guidance

**Research date:** 2026-04-01
**Valid until:** 2026-05-01 (stable codebase, no external dependencies changing)
