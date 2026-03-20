# Phase 16: Interactive REPL - Context

**Gathered:** 2026-03-20
**Status:** Ready for planning

<domain>
## Phase Boundary

Users can start `bg-agent` with no arguments and enter an interactive session where they issue multiple tasks conversationally. Correct signal handling (Ctrl+C cancels task, Ctrl+D exits), Docker build check at startup only, persistent history across sessions. No multi-turn context (Phase 17), no new task types, no Slack integration.

</domain>

<decisions>
## Implementation Decisions

### Architecture — channel-agnostic split
- Session core in `src/repl/session.ts` — channel-agnostic loop (takes input string, returns structured result via parseIntent → confirmLoop → runAgent)
- CLI adapter in `src/cli/commands/repl.ts` — owns readline, prompt rendering, colors, history, Ctrl+C handling
- This split enables future Slack/MCP adapter to plug into the same session core without refactoring

### Prompt & session UX
- Project-aware prompt: starts as `bg> `, changes to `myapp> ` once a project is resolved from the first task
- Status banner at startup: tool name, version, Docker status, registered project count, then hint line
- Structured result block between tasks: boxed card showing status, attempts, verify result, judge verdict, PR link
- `exit` command or Ctrl+D to quit the REPL session

### Signal handling
- **Ctrl+C at idle prompt:** Clear current line, show fresh prompt (shell-like behavior)
- **Ctrl+C during confirm prompt (Proceed? [Y/n]):** Cancel the current task, return to REPL prompt (treat as "no")
- **Ctrl+C during running task:** Print "Cancelling..." immediately, abort via AbortSignal, show cancelled result block when cleanup finishes, return to REPL prompt
- **Double Ctrl+C during task:** Force-kill the Docker container immediately (skip 5s grace period), show "cancelled (forced)" result block, return to REPL prompt — does NOT exit the REPL
- **Ctrl+D at idle prompt:** Clean exit of REPL session
- Per-task AbortController: REPL creates a fresh AbortController for each task, signal handlers in the REPL adapter manage the lifecycle (not in the session core)

### History persistence
- Location: `~/.config/background-agent/history` (alongside existing conf config.json)
- Max entries: 500
- readline's built-in history file support for read/write

### Startup checks
- Docker check (assertDockerRunning + ensureNetworkExists + buildImageIfNeeded) runs once at REPL startup
- If Docker is not running: show error and exit immediately (no REPL entry)
- If image build needed: show spinner with "Building agent image..." status message
- Banner shows Docker ready status + registered project count after checks pass
- `runAgent()` API extended with `skipDockerChecks` option in AgentContext — REPL adapter sets true, one-shot path keeps default (false)

### Claude's Discretion
- Internal session core API shape (how input/result are passed)
- readline configuration details (completer, terminal options)
- Spinner implementation for Docker build (ora, nanospinner, or manual)
- Result block rendering implementation (box-drawing characters, colors)
- How to detect conf config dir path for history file colocation

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Architecture & entry points
- `src/cli/index.ts` — Current CLI entry point with signal handlers and one-shot/flag routing (REPL path goes here)
- `src/cli/commands/one-shot.ts` — Full parse→confirm→run flow pattern to replicate in REPL loop
- `src/agent/index.ts` — runAgent() public API (needs skipDockerChecks addition to AgentContext)

### Intent & confirm
- `src/intent/index.ts` — parseIntent(), fastPathParse() exports for REPL to reuse
- `src/intent/confirm-loop.ts` — confirmLoop() with readline — REPL needs its own readline instance, not per-call
- `src/intent/types.ts` — ResolvedIntent type that flows through the session

### Docker lifecycle
- `src/cli/docker/index.ts` — assertDockerRunning(), ensureNetworkExists(), buildImageIfNeeded() — called at REPL startup only

### Registry
- `src/agent/registry.ts` — ProjectRegistry for project-aware prompt and short name resolution

### Requirements
- `.planning/REQUIREMENTS.md` — CLI-02 requirement definition

### Prior phase context
- `.planning/phases/14-infrastructure-foundation/14-CONTEXT.md` — runAgent() API design, AbortSignal threading, cancellation UX decisions
- `.planning/phases/15-intent-parser-one-shot-mode/15-CONTEXT.md` — Intent parser, confirm flow, channel-agnostic design decisions

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `parseIntent()` + `fastPathParse()` (src/intent/index.ts): Same parsing pipeline for REPL input
- `confirmLoop()` (src/intent/confirm-loop.ts): Confirm flow — but creates its own readline, REPL may need to adapt or pass one in
- `runAgent()` (src/agent/index.ts): Library call with AbortSignal support — REPL calls this per-task
- `displayIntent()` (src/intent/confirm-loop.ts): Renders parsed intent block — reusable in REPL
- `mapStatusToExitCode()` (src/cli/commands/run.ts): Maps RetryResult status to exit codes
- `ProjectRegistry` (src/agent/registry.ts): CRUD + resolve for project-aware prompt
- `autoRegisterCwd()` (src/cli/auto-register.ts): Auto-register repos on first use
- `createLogger()` (src/cli/utils/logger.ts): Pino logger factory with redaction

### Established Patterns
- AbortController per operation with signal threading (Phase 14 pattern)
- Commander.js for CLI entry — REPL triggered when no positional arg and no required flags
- `node:readline/promises` already used in one-shot for interactive prompts
- `conf@^15` stores config in `~/.config/background-agent/` — history file goes alongside

### Integration Points
- `src/cli/index.ts`: When no `input` arg and no `--task-type`, launch REPL instead of showing help
- `AgentContext` interface (src/agent/index.ts): Add `skipDockerChecks?: boolean` field
- `runAgent()` internals: Conditionally skip Docker checks when flag is set
- Phase 17 will add session history to the session core — design for extensibility

</code_context>

<specifics>
## Specific Ideas

- The channel-agnostic split is intentionally forward-looking: same session core works for CLI REPL and future Slack/MCP adapter (INTG-01)
- Project-aware prompt gives users orientation without needing to specify the repo repeatedly — key UX win for multi-task sessions
- Double Ctrl+C force-kills the container but stays in the REPL — the escape hatch is Ctrl+D, not repeated interrupts
- Startup banner with Docker status gives confidence the system is ready before the first prompt appears

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 16-interactive-repl*
*Context gathered: 2026-03-20*
