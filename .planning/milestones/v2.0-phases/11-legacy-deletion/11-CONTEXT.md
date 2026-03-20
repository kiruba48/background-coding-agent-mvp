# Phase 11: Legacy Deletion - Context

**Gathered:** 2026-03-17
**Status:** Ready for planning

<domain>
## Phase Boundary

Delete all custom agent infrastructure code (agent.ts, session.ts, container.ts and their tests), remove dockerode dependency, clean up all imports/re-exports, and simplify RetryOrchestrator to SDK-only path. The only agent runtime after this phase is ClaudeCodeSession.

</domain>

<decisions>
## Implementation Decisions

### Deletion order & safety
- Single atomic delete — all 6 legacy files removed in one commit (agent.ts, session.ts, container.ts + 3 test files)
- All legacy types deleted (AgentClientOptions, SessionConfig from session.ts) — no aliases or deprecated re-exports
- RetryOrchestrator simplified to ClaudeCodeSession only — remove the if/else conditional branch entirely
- Barrel file (index.ts) clean sweep — remove all legacy re-exports, only export ClaudeCodeSession, RetryOrchestrator, and active types

### LLM Judge SDK dependency
- Keep `@anthropic-ai/sdk` as production dependency — Judge uses structured output (BetaMessage) which requires the raw SDK
- This aligns with REQUIREMENTS.md: full SDK removal is explicitly out of scope
- Remove `dockerode` + `@types/dockerode` from package.json — container.ts is the only consumer, Phase 13 will add its own strategy if needed

### CLI flag cleanup
- Remove `--no-use-sdk` flag completely from Commander options
- Remove `useSDK` property from types.ts / SessionConfig
- No deprecation warning or error message — clean removal

### Test coverage transfer
- Behavioral equivalence, not line-for-line parity — ensure ClaudeCodeSession tests cover the same behaviors (security hooks, status mapping, error handling, turn limits)
- Review deleted test behaviors and verify ClaudeCodeSession tests (345 LOC) already cover them; add missing behavioral tests if gaps found
- retry.test.ts: swap MockAgentSession → MockClaudeCodeSession, keep same test logic
- judge.test.ts: swap AgentSession mock references → ClaudeCodeSession

### Claude's Discretion
- Exact order of operations within the atomic commit (delete files, update imports, update package.json)
- Whether to run `npm install` to regenerate lockfile after dockerode removal, or leave for CI
- Any additional dead code discovered during import cleanup (e.g., types only used by legacy files)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements
- `.planning/REQUIREMENTS.md` §Legacy Deletion — DEL-01 through DEL-05, the 5 requirements Phase 11 must satisfy
- `.planning/ROADMAP.md` §Phase 11 — Success criteria (4 must-be-TRUE statements)

### Prior phase context
- `.planning/phases/10-agent-sdk-integration/10-CONTEXT.md` — Coexistence strategy, security hook design, ClaudeCodeSession interface decisions
- `.planning/STATE.md` §Accumulated Context — LLM Judge migration decision (keep SDK), useSDK flag semantics

### Files to delete
- `src/orchestrator/agent.ts` — AgentClient (273 LOC) — replaced by SDK built-in agentic loop
- `src/orchestrator/session.ts` — AgentSession (667 LOC) — replaced by ClaudeCodeSession
- `src/orchestrator/container.ts` — ContainerManager (226 LOC) — replaced by future spawnClaudeCodeProcess
- `src/orchestrator/agent.test.ts` — AgentClient tests (247 LOC)
- `src/orchestrator/session.test.ts` — AgentSession tests (482 LOC)
- `src/orchestrator/container.test.ts` — ContainerManager tests (83 LOC)

### Files to modify
- `src/orchestrator/retry.ts` — Remove AgentSession import, remove conditional branch, always use ClaudeCodeSession
- `src/orchestrator/retry.test.ts` — Swap MockAgentSession → MockClaudeCodeSession
- `src/orchestrator/judge.test.ts` — Swap AgentSession mock references → ClaudeCodeSession
- `src/orchestrator/index.ts` — Remove legacy re-exports (AgentClient, AgentSession, ContainerManager, AgentClientOptions, SessionConfig)
- `src/cli/commands/run.ts` — Remove --no-use-sdk flag and useSDK references
- `src/types.ts` — Remove useSDK property from SessionConfig (if defined there)
- `package.json` — Remove dockerode + @types/dockerode

### Migration reference
- `BRIEF.md` — What to delete/keep/modify analysis (Spotify migration reference)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `ClaudeCodeSession` (claude-code-session.ts): Already implements the full SessionResult interface — direct replacement
- `ClaudeCodeSession` test suite (345 LOC): Already covers security hooks, status mapping, error handling via TDD
- Pino logger: Unchanged — audit trail format stays the same

### Established Patterns
- Fresh session per retry attempt — preserved, ClaudeCodeSession already follows this
- End-state prompting via `prompts/` module — unchanged
- Composite verifier runs post-session — unchanged boundary
- LLM Judge keeps `@anthropic-ai/sdk` for structured output — unchanged

### Integration Points
- `RetryOrchestrator.run()` line 78: `new AgentSession(this.config)` → remove, always `new ClaudeCodeSession()`
- `RetryOrchestrator` line 29: `activeSession: AgentSession | ClaudeCodeSession` → just `ClaudeCodeSession`
- `cli/commands/run.ts` line 25: `useSDK` property → delete
- `orchestrator/index.ts` lines 10-27: Legacy exports → delete

</code_context>

<specifics>
## Specific Ideas

- This is a pure deletion/cleanup phase — no new functionality
- ~1,978 lines of code being removed, zero lines of new production code expected
- The atomic approach reflects confidence in Phase 10's ClaudeCodeSession — it's been the default path already

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 11-legacy-deletion*
*Context gathered: 2026-03-17*
