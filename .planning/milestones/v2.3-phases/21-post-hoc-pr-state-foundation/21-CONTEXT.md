# Phase 21: Post-Hoc PR & State Foundation - Context

**Gathered:** 2026-03-25
**Status:** Ready for planning

<domain>
## Phase Boundary

REPL `pr` command to create a GitHub PR for the last completed task without having specified `--create-pr` upfront, plus ReplState/TaskHistoryEntry schema enrichment that Phase 23 (follow-up referencing) depends on. No new task types, no agent re-runs, no changes to the intent parser pipeline.

</domain>

<decisions>
## Implementation Decisions

### Meta-command detection
- Exact match set: `pr`, `create pr`, `create a pr` (case-insensitive, trimmed)
- Intercepted in `processInput()` in session.ts before `parseIntent()` runs — same location as exit/quit/history
- Anything else containing "pr" (e.g., "fix the PR template") flows to intent parser normally

### PR confirmation flow
- Summary + auto-proceed: show "Creating PR for: [description] ([project])" then create immediately
- No Y/n confirmation — user explicitly typed `pr`, that IS the intent
- Reuse existing `GitHubPRCreator.create()` directly — it already accepts taskType, originalTask, and RetryResult
- After success, display PR URL only: "PR created: https://github.com/org/repo/pull/123"

### State retention
- Add `lastRetryResult?: RetryResult` and `lastIntent?: ResolvedIntent` to ReplState
- Overwritten on each new task completion, cleared implicitly by next task
- PR eligibility: success only — `lastRetryResult.finalStatus === 'success'` required
- Allow duplicate PRs — let GitHub API handle conflicts (no prCreated tracking flag)

### TaskHistoryEntry enrichment
- Add `description?: string` field to TaskHistoryEntry (FLLW-01)
- Populated from `intent.description` verbatim for generic tasks
- For dependency updates, format as "update {dep} to {version}"
- Consistent with end-state prompting discipline — never rewritten

### Error handling
- No completed task: "No completed task in this session" (PR-02, covers both never-ran and last-failed)
- No GITHUB_TOKEN: clear error message — GitHubPRCreator's existing validation handles this
- PR creation failure: surface the API error from PRResult.error

### Claude's Discretion
- Exact placement of meta-command check within processInput() control flow
- Whether to log PR creation events via Pino
- SessionOutput shape — whether to add prResult field or reuse existing patterns

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements
- `.planning/REQUIREMENTS.md` — PR-01 through PR-04 (post-hoc PR), FLLW-01 and FLLW-02 (state enrichment)
- `.planning/ROADMAP.md` §Phase 21 — success criteria, plan breakdown, dependency chain

### Core implementation files
- `src/repl/types.ts` — ReplState, TaskHistoryEntry, SessionCallbacks, SessionOutput interfaces
- `src/repl/session.ts` — processInput() where meta-command intercept goes, appendHistory() where description is populated
- `src/orchestrator/pr-creator.ts` — GitHubPRCreator.create() to be reused for post-hoc PR
- `src/types.ts` — RetryResult type definition (stored on ReplState)
- `src/cli/commands/repl.ts` — REPL loop, SessionCallbacks implementation, display logic

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `GitHubPRCreator.create()`: Already takes taskType, originalTask, RetryResult — can be called directly from `pr` command handler
- `processInput()` meta-command pattern: exit/quit/history exact-match checks at lines 37-64 — PR intercept follows same pattern
- `appendHistory()`: History append function at session.ts:24-29 — extend to include description field

### Established Patterns
- Meta-commands use exact string matching with `.trim().toLowerCase()` before intent parser runs
- SessionOutput `{ action: 'continue' | 'quit', result?, intent? }` carries results back to REPL loop
- ReplState initialized via `createSessionState()` with null defaults — new optional fields follow same pattern

### Integration Points
- `processInput()` in session.ts — add PR command check between history check and parseIntent() call
- `appendHistory()` in session.ts — add description parameter, populate from intent
- REPL loop in repl.ts — display PR URL after processInput() returns with PR result
- `runAgent()` return path in session.ts — store RetryResult and intent on ReplState after task completion

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

*Phase: 21-post-hoc-pr-state-foundation*
*Context gathered: 2026-03-25*
