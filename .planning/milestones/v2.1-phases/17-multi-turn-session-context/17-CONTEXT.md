# Phase 17: Multi-Turn Session Context - Context

**Gathered:** 2026-03-22
**Status:** Ready for planning

<domain>
## Phase Boundary

Follow-up inputs within a REPL session are disambiguated using prior task history, so users can say "now do lodash too" without restating the full context. Session history is in-memory only (no cross-session persistence), bounded, and propagated to the intent parser. Execution isolation is preserved — each task still runs in a fresh Docker container.

</domain>

<decisions>
## Implementation Decisions

### History shape & storage
- Minimal tuple per completed task: `{ taskType, dep, version, repo, status }`
- Extends existing `ReplState` interface with `history: TaskHistoryEntry[]` array
- Session core (`session.ts`) appends to history after `runAgent()` completes (not after confirmation)
- All tasks that reach execution are recorded regardless of outcome (success, failed, cancelled)

### History injection into intent parser
- Add `history?: TaskHistoryEntry[]` field to existing `ParseOptions` interface
- `session.ts` passes `state.history` when calling `parseIntent()`
- Fast-path checks history for follow-up pattern matching (last entry only)
- LLM path receives compact history summary in system prompt for ambiguous follow-ups

### Follow-up resolution logic
- Fast-path extended with follow-up regex patterns: "also X", "now do X", "same for X", "X too"
- When follow-up detected, inherit `taskType` and `repo` from the **last** history entry only
- If follow-up detected but no history exists: strip prefix, re-parse as fresh command (graceful degradation)
- Falls through to LLM if pattern not recognized or ambiguous (e.g., project switch)
- LLM path also receives history — both paths are history-aware

### Bounding strategy
- Fixed window of 10 entries (last 10 tasks)
- When window full, oldest entry drops (`shift()`)
- ~200 tokens when serialized for LLM (~20 tokens per entry, <0.1% of Haiku 4.5 context)
- No summarization or token counting needed — fixed window is sufficient

### Confirm display
- When fields are inherited from session history, annotate the confirm block: `(from session)` next to task type and repo
- User can see what was parsed fresh vs. inherited — builds trust in follow-up mechanism

### REPL `history` command
- Typing `history` in the REPL shows a numbered list of completed tasks: type, dep, repo, status
- Quick way for user to inspect what context follow-ups will inherit

### Claude's Discretion
- Exact follow-up regex patterns (syntax and ordering)
- LLM system prompt format for history injection
- How to format the `(from session)` annotation in confirm display
- `history` command rendering details (colors, spacing)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Session architecture
- `src/repl/session.ts` — Session core with `processInput()` loop. History appended here after execution
- `src/repl/types.ts` — `ReplState`, `SessionCallbacks`, `SessionOutput` interfaces. `ReplState` gets `history` field
- `src/cli/commands/repl.ts` — CLI REPL adapter with readline, signal handling, confirm/clarify callbacks

### Intent parsing
- `src/intent/index.ts` — `parseIntent()` coordinator and `ParseOptions` interface. Gets `history` field
- `src/intent/fast-path.ts` — Fast-path regex parser. Extended with follow-up pattern detection
- `src/intent/llm-parser.ts` — LLM parser using Haiku 4.5 structured output. Gets history in system prompt
- `src/intent/types.ts` — `ResolvedIntent`, `IntentSchema`, `FastPathResult` types
- `src/intent/confirm-loop.ts` — `displayIntent()` function. Extended with `(from session)` annotations

### Prior phase context
- `.planning/phases/15-intent-parser-one-shot-mode/15-CONTEXT.md` — Intent parser design, fast-path patterns, channel-agnostic principle
- `.planning/phases/16-interactive-repl/16-CONTEXT.md` — REPL architecture, ReplState, session core / CLI adapter split

### Requirements
- `.planning/REQUIREMENTS.md` — SESS-01 requirement definition

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `ReplState` (src/repl/types.ts): Already tracks `currentProject` and `currentProjectName` — extend with `history` array
- `parseIntent()` (src/intent/index.ts): Channel-agnostic coordinator — `ParseOptions` is the injection point for history
- `fastPathParse()` (src/intent/fast-path.ts): Regex-based dep extraction — extend with follow-up pattern detection
- `llmParse()` (src/intent/llm-parser.ts): Haiku 4.5 structured output — system prompt gets history summary
- `displayIntent()` (src/intent/confirm-loop.ts): Renders parsed intent block — add `(from session)` annotations
- `processInput()` (src/repl/session.ts): Main loop — append to history after runAgent(), handle `history` command

### Established Patterns
- Channel-agnostic session core / CLI adapter split (Phase 16) — history lives in session core, not adapter
- `ParseOptions` for extending parseIntent() behavior (Phase 15) — add `history` field here
- Zod schema for LLM structured output (intent parser, LLM judge) — same pattern if history changes schema
- Fast-path regex → LLM fallback chain — follow-up detection fits as a fast-path extension

### Integration Points
- `ReplState` interface: Add `history: TaskHistoryEntry[]` field
- `ParseOptions` interface: Add `history?: TaskHistoryEntry[]` field
- `processInput()`: Pass `state.history` to `parseIntent()`, append after execution
- `fastPathParse()`: New follow-up regex patterns, accept history parameter
- `llmParse()`: Accept history parameter, inject into system prompt
- `displayIntent()`: Accept inheritance metadata, render `(from session)` annotations
- REPL main loop: Handle `history` command before dispatching to `processInput()`

</code_context>

<specifics>
## Specific Ideas

- Follow-up should feel instant — fast-path handles obvious cases, no LLM call for "also do lodash"
- Graceful degradation when no history: "also update lodash" just becomes "update lodash" — no error, just works
- Confirm display with `(from session)` annotation gives user confidence that context was inherited correctly
- `history` command is a quick inspection tool, not a feature — keep it simple

</specifics>

<deferred>
## Deferred Ideas

- SESS-02: Follow-up tasks referencing previous task results ("fix the errors from that") — requires rich history with error context, deferred to v2.2+
- Cross-session history persistence — explicitly out of scope per REQUIREMENTS.md (stale context causes misparses)
- Referencing any task in history (not just last) — LLM sees full window but fast-path inherits from last only

</deferred>

---

*Phase: 17-multi-turn-session-context*
*Context gathered: 2026-03-22*
