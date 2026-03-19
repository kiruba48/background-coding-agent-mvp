# Phase 10: Agent SDK Integration - Context

**Gathered:** 2026-03-16
**Status:** Ready for planning

<domain>
## Phase Boundary

Replace AgentSession with a ClaudeCodeSession wrapper around Claude Agent SDK `query()`. All v1.1 security guarantees preserved via hooks-based safety model. RetryOrchestrator integration unchanged. Legacy code stays in repo (unused) until Phase 11 deletes it.

</domain>

<decisions>
## Implementation Decisions

### Coexistence strategy
- Side-by-side with `--use-sdk` CLI flag (Commander.js boolean option on `run` command)
- Default: `true` (SDK path is primary; `--no-use-sdk` falls back to legacy AgentSession)
- RetryOrchestrator instantiates ClaudeCodeSession or AgentSession based on flag
- Both paths must have passing test suites — existing AgentSession tests untouched, new ClaudeCodeSession gets its own test suite
- Phase 11 removes the flag and legacy path

### Security hook design
- **PreToolUse hook**: Repo-scoped + deny list — block writes outside repo path, block .env, .git/, and secrets file patterns
- **Block behavior**: Return tool error message to agent explaining why blocked + log as security audit event. Agent sees rejection and can adjust.
- **Bash access**: Trust SDK's `acceptEdits` permission model — no command allowlist in hook. Agent gets full Bash capability (npm, mvn, tsc, etc.)
- **Turn counting**: Blocked tool attempts count toward maxTurns — prevents unbounded blocked-call loops

### Error & status mapping
- ClaudeCodeSession returns the exact same `SessionResult` interface (sessionId, status, toolCallCount, duration, finalResponse, error)
- SDK-specific data (cost, tokens) logged via Pino but NOT added to SessionResult — RetryOrchestrator unchanged
- `maxTurns` exhaustion maps to `'turn_limit'` status (terminal, no retry) — same as v1
- API error retry delegated entirely to SDK's built-in 429/529 handling — no custom retry wrapper. SDK gives up → `'failed'` status
- `maxBudgetUsd` set with a sensible default per session (researcher to determine appropriate value). SDK-09 requirement.

### Audit trail format
- PostToolUse hook captures: file path, tool name (Edit/Write), ISO timestamp
- Only file mutations logged as audit events (Edit, Write) — not reads/searches
- Blocked tool attempts (from PreToolUse) also logged as security audit events with path, tool, reason, timestamp
- All audit events go inline with existing Pino structured JSON logger, tagged with `type: 'audit'`
- No separate audit file — single log stream

### Claude's Discretion
- Exact ClaudeCodeSession class structure and internal implementation
- How SDK query() options are configured (model, systemPrompt construction)
- Default value for maxBudgetUsd (determine during research)
- How to extract toolCallCount and duration from SDK response
- Test mocking strategy for SDK query() calls

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Agent SDK
- `BRIEF.md` — Migration analysis: what to delete/keep/modify, target architecture, what we gain/lose
- `BRIEF.md` §Target Architecture — The exact architecture diagram Phase 10 is building toward

### Requirements
- `.planning/REQUIREMENTS.md` §SDK Integration — SDK-01 through SDK-10, the 10 requirements Phase 10 must satisfy
- `.planning/ROADMAP.md` §Phase 10 — Success criteria (5 must-be-TRUE statements)

### Existing code to modify
- `src/orchestrator/retry.ts` — RetryOrchestrator: swap AgentSession instantiation for conditional SDK/legacy path
- `src/orchestrator/session.ts` — Current AgentSession: understand interface that ClaudeCodeSession must match
- `src/orchestrator/agent.ts` — Current AgentClient: understand what SDK replaces (tool dispatch, API retry)
- `src/types.ts` — SessionResult, RetryConfig interfaces that must be preserved
- `src/cli/commands/run.ts` — CLI command: add --use-sdk flag

### Project decisions (STATE.md)
- `.planning/STATE.md` §Accumulated Context — `disallowedTools` list, stop hook limitations, `@anthropic-ai/sdk` retention for Judge

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `SessionResult` interface (types.ts): Must be preserved exactly — ClaudeCodeSession returns this
- `RetryConfig` interface (types.ts): verifier/judge/preVerify hooks — unchanged
- `RetryOrchestrator` (retry.ts): Outer loop stays, only session instantiation changes
- `ErrorSummarizer` (summarizer.ts): Retry message construction — fully reusable
- Pino logger: Already structured JSON, audit events fit naturally

### Established Patterns
- Fresh session per retry attempt — CRITICAL design principle, preserved with SDK
- End-state prompting via `prompts/` module — systemPrompt feeds into SDK's `systemPrompt` option
- Composite verifier runs post-session, outside agent — unchanged boundary
- LLM Judge as separate evaluation — unchanged, keeps `@anthropic-ai/sdk`

### Integration Points
- `RetryOrchestrator.run()` line 70: `new AgentSession(this.config)` → conditional `new ClaudeCodeSession()` or `new AgentSession()`
- `cli/commands/run.ts`: Add `--use-sdk` boolean option, pass to SessionConfig
- `orchestrator/index.ts`: Export new ClaudeCodeSession alongside existing exports

</code_context>

<specifics>
## Specific Ideas

- Side-by-side approach chosen specifically for safe rollback — if SDK has surprises, `--no-use-sdk` reverts to proven path
- Agent SDK `query()` is still batch/programmatic (not conversational) — same interaction model as v1, just better engine underneath
- Conversational agent loop is a future milestone beyond v2.0

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 10-agent-sdk-integration*
*Context gathered: 2026-03-16*
