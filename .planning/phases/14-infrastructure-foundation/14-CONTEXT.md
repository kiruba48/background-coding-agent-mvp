# Phase 14: Infrastructure Foundation - Context

**Gathered:** 2026-03-19
**Status:** Ready for planning

<domain>
## Phase Boundary

Extract runAgent() as an importable, cancellable function and build a project registry for short name → repo path resolution. These are prerequisites for conversational entry points (Phase 15+). No REPL, no intent parsing, no natural language handling.

</domain>

<decisions>
## Implementation Decisions

### Registry behavior
- Exact match only for short name resolution — no fuzzy/prefix matching
- Name conflicts on manual registration: prompt user to confirm overwrite (interactive mode), error in non-interactive
- Full CRUD: `bg-agent projects list`, `bg-agent projects remove <name>` (re-register replaces, no separate update command)
- Storage via `conf@^15` in OS-appropriate config dir (~/.config/background-agent/config.json)

### Auto-registration UX
- Triggers on any bg-agent invocation in a cwd that has `.git`, `package.json`, or `pom.xml`
- Assigned name: directory basename (e.g., `/Users/kiruba/code/myapp` → `myapp`)
- Notification: one-line notice on first registration ("Registered project: myapp → /path/to/myapp")
- Conflict handling: skip silently if name already registered to a different path (don't overwrite auto)

### runAgent() public API
- New top-level module: `src/agent/index.ts` exports `runAgent()`
- Returns full `RetryResult` (status, attempts, session results, verification results, judge results)
- Caller provides logger via options (falls back to no-op logger if omitted)
- `runAgent()` handles Docker lifecycle internally (assertDockerRunning, ensureNetwork, buildImage) — callers don't need Docker knowledge
- Signature shape: `runAgent(options: AgentOptions, context: { logger?, signal? }): Promise<RetryResult>`

### Cancellation UX
- Clean abort: kill container, discard workspace changes, return 'cancelled' status. No partial results.
- 5-second grace period: signal abort to SDK, wait 5s for graceful shutdown, then docker kill
- New `'cancelled'` status added to `RetryResult.finalStatus` union type
- On cancellation, reset workspace to baseline SHA (git reset --hard to pre-agent state)

### Claude's Discretion
- Internal module structure within src/agent/
- How to wire AbortSignal through RetryOrchestrator → ClaudeCodeSession (threading strategy)
- Commander.js subcommand structure for `projects` commands
- Config schema design within conf

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Architecture & current implementation
- `src/cli/commands/run.ts` — Current runAgent() implementation to be extracted (signal handlers, orchestrator instantiation, exit code mapping)
- `src/orchestrator/retry.ts` — RetryOrchestrator that runAgent() wraps (retry loop, verification, judge)
- `src/orchestrator/claude-code-session.ts` — ClaudeCodeSession with existing AbortController/timeout pattern (lines 220-385)
- `src/types.ts` — SessionConfig, SessionResult, RetryResult, VerificationResult type definitions

### Docker integration
- `src/cli/docker/index.ts` — Docker lifecycle functions (assertDockerRunning, ensureNetworkExists, buildImageIfNeeded) to be internalized by runAgent()

### Requirements
- `.planning/REQUIREMENTS.md` — INFRA-01, INFRA-02, REG-01, REG-02 requirement definitions

### Prior research decisions
- `.planning/STATE.md` §Accumulated Context — conf@^15 chosen, AbortSignal must happen in Phase 14

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `RetryOrchestrator` (src/orchestrator/retry.ts): Already manages session lifecycle, verification, and judge — runAgent() wraps this
- `ClaudeCodeSession` (src/orchestrator/claude-code-session.ts): Already has internal AbortController for timeout — needs external signal threading
- Docker functions (src/cli/docker/index.ts): assertDockerRunning(), ensureNetworkExists(), buildImageIfNeeded() — move into runAgent() scope
- `captureBaselineSha()` (src/orchestrator/judge.ts): Records HEAD before agent runs — reuse for cancellation reset
- Pino logger factory (src/cli/utils/logger.ts): Existing logger creation pattern with redaction

### Established Patterns
- AbortController per session with timeout guard (ClaudeCodeSession:246-254) — extend to accept external signal
- Process signal handlers in run.ts that call orchestrator.stop() — replace with AbortSignal threading
- Commander.js subcommands pattern (currently only `run`) — extend with `projects` subcommand group
- Exit code mapping: 0/1/124/130/143 — add cancelled case

### Integration Points
- CLI entry (src/cli/index.ts): Commander action currently calls run.ts directly — will import from src/agent/ instead
- `conf@^15` is a new dependency — needs package.json addition
- RetryResult type (src/types.ts): Add 'cancelled' to finalStatus union
- REPL (Phase 16) and one-shot (Phase 15) will both import from src/agent/index.ts

</code_context>

<specifics>
## Specific Ideas

- runAgent() should feel like a library call — import it, pass options, get a result. No process.exit() inside.
- Registry should be Slack-ready: short names work the same whether typed in a terminal or sent via future Slack integration (INTG-01)
- Auto-registration is zero-friction: developers shouldn't have to think about it. Just `cd myapp && bg-agent 'update lodash'` and it works.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 14-infrastructure-foundation*
*Context gathered: 2026-03-19*
