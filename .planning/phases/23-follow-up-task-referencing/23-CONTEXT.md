# Phase 23: Follow-Up Task Referencing - Context

**Gathered:** 2026-03-31
**Status:** Ready for planning

<domain>
## Phase Boundary

Enrich the LLM history block passed to the intent parser so follow-up inputs like "now add tests for that" resolve correctly to the previous task's subject. No new task types, no agent changes, no new meta-commands. The work is: extend TaskHistoryEntry with finalResponse, update buildHistoryBlock() formatting, and update the system prompt with reference resolution guidance.

</domain>

<decisions>
## Implementation Decisions

### History block content
- Each history entry shows: taskType, dep, repo, status, **Task description**, and **Changes summary** (truncated finalResponse)
- All task statuses get the enriched format (success, failed, zero_diff, cancelled) — failed tasks still provide useful follow-up context
- Dep updates use finalResponse for the Changes line same as generic tasks — no special casing
- Scope hints from Phase 22 are NOT included in the history block — description + summary is sufficient
- Changes line is omitted entirely when finalResponse is empty/undefined — no placeholder text

### Reference resolution
- Prompt guidance only — no new schema fields on the intent output
- Add a paragraph to INTENT_SYSTEM_PROMPT explaining reference patterns: "that/it" = most recent, "task N" = Nth entry, keyword match = scan Task descriptions
- Auto-inherit repo from referenced task — user can override with explicit "in project-x"
- Raw user input used as description — no rewriting to expand references (end-state prompting discipline)

### Change summary extraction
- Simple truncation: first 300 chars of finalResponse, cut at last sentence boundary (period/exclamation/question mark)
- Minimum 50 chars before accepting a sentence boundary — prevents cutting at a tiny first sentence
- Store raw finalResponse on TaskHistoryEntry, truncate only when buildHistoryBlock() formats the LLM prompt
- New `finalResponse?: string` field on TaskHistoryEntry

### Data flow
- Declare `let taskResult: RetryResult | undefined` before try block in processInput()
- Assign in try block (same pattern as historyStatus)
- Pass `taskResult?.finalResponse` to appendHistory() in finally block
- appendHistory() stores full finalResponse on the TaskHistoryEntry

### Edge case handling
- Empty history + follow-up reference ("add tests for that"): LLM resolves naturally — no session_history block means no context, so confidence = 'low' with clarifications
- Out-of-bounds positional reference ("task 3" with 2 entries): LLM handles it — it can see history has only 2 entries, will set low confidence
- No special pre-parse detection code for either case — existing clarification flow handles ambiguity

### Claude's Discretion
- Exact wording of the system prompt reference resolution paragraph
- Whether to add a `summarize()` utility function or inline the truncation logic
- Test structure and coverage approach

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements
- `.planning/REQUIREMENTS.md` — FLLW-03 (follow-up referencing)
- `.planning/ROADMAP.md` §Phase 23 — success criteria, plan breakdown, dependency on Phase 21

### Core implementation files
- `src/repl/types.ts` — TaskHistoryEntry (add finalResponse field), ReplState, MAX_HISTORY_ENTRIES
- `src/repl/session.ts` — processInput() data flow (capture taskResult in try, pass to appendHistory in finally), appendHistory()
- `src/intent/llm-parser.ts` — buildHistoryBlock() (format enriched entries), INTENT_SYSTEM_PROMPT (add reference resolution guidance), llmParse()
- `src/types.ts` — RetryResult type (finalResponse field source)

### Prior phase context
- `.planning/phases/21-post-hoc-pr-state-foundation/21-CONTEXT.md` — TaskHistoryEntry schema, lastRetryResult on ReplState, appendHistory patterns

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `buildHistoryBlock()` in llm-parser.ts:68-73 — existing history formatter, extend with Task/Changes lines
- `appendHistory()` in session.ts:69-74 — existing history append, add finalResponse parameter
- `escapeXml()` in llm-parser.ts:63-65 — already used for history block XML escaping
- INTENT_SYSTEM_PROMPT already has follow-up phrase handling ("also X", "now do X") — extend with positional/keyword reference guidance

### Established Patterns
- TaskHistoryEntry fields are optional with `?` — finalResponse follows same convention
- History block uses XML tags (`<session_history>`) for LLM prompt structure
- System prompt conditionally appends follow-up guidance when history exists (llm-parser.ts:101-103)
- `historyStatus` variable pattern in processInput() try/finally — reuse for taskResult

### Integration Points
- `processInput()` try/finally block in session.ts:248-280 — add taskResult variable, pass to appendHistory
- `buildHistoryBlock()` in llm-parser.ts — add Task and Changes lines per entry
- `INTENT_SYSTEM_PROMPT` in llm-parser.ts — add reference resolution paragraph
- `TaskHistoryEntry` in types.ts — add finalResponse field

</code_context>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 23-follow-up-task-referencing*
*Context gathered: 2026-03-31*
