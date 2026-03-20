---
phase: 12-mcp-verifier-server
plan: 02
subsystem: orchestrator
tags: [mcp, verifier, claude-code-session, sdk, system-prompt, hooks]

# Dependency graph
requires:
  - phase: 12-01
    provides: createVerifierMcpServer factory and formatVerifyDigest
  - phase: 10-sdk-integration
    provides: ClaudeCodeSession with query() structure
provides:
  - ClaudeCodeSession.run() wired with mcpServers: { verifier } in query() options
  - systemPrompt with preset:claude_code and mcp__verifier__verify instruction appended
  - PostToolUse matcher extended to mcp__verifier__verify for audit logging
  - mcp_server_registered log event at session start
affects:
  - Every agent session (MCP server registered on every run() call)
  - 12-CONTEXT.md (MCP-02 requirement implemented)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "createVerifierMcpServer called per run() — server bound to session workspaceDir"
    - "systemPrompt preset:claude_code with append field for additive instruction injection"
    - "PostToolUse matcher union (Write|Edit|mcp__verifier__verify) captures both file writes and MCP tool calls"
    - "vi.mock('../mcp/verifier-server.js') pattern for testing MCP-dependent session code"

key-files:
  created: []
  modified:
    - src/orchestrator/claude-code-session.ts
    - src/orchestrator/claude-code-session.test.ts

key-decisions:
  - "createVerifierMcpServer called inside run() (not constructor) — bound to workspaceDir at session time"
  - "mcp_server_registered log before try block — fires before query() starts, gives clear lifecycle signal"
  - "PostToolUse matcher extended to include mcp__verifier__verify — MCP verify calls are audited same as file writes"

patterns-established:
  - "TDD for session wiring: mock external module (verifier-server.js), test query() call args directly"
  - "Mock pattern: vi.mock('../mcp/verifier-server.js', () => ({ createVerifierMcpServer: vi.fn().mockReturnValue(...) }))"

requirements-completed: [MCP-02]

# Metrics
duration: 86s
completed: 2026-03-18
---

# Phase 12 Plan 02: MCP Verifier Server Wiring Summary

**MCP verifier server wired into ClaudeCodeSession.run() via mcpServers option with system prompt instruction and extended PostToolUse audit hook**

## Performance

- **Duration:** ~86 seconds
- **Started:** 2026-03-18T15:52:33Z
- **Completed:** 2026-03-18T15:53:59Z
- **Tasks:** 1 (TDD: RED + GREEN phases)
- **Files modified:** 2

## Accomplishments

- `ClaudeCodeSession.run()` creates `verifierServer = createVerifierMcpServer(workspaceDir)` before each query() call
- `mcpServers: { verifier: verifierServer }` added to query() options — agent can call `mcp__verifier__verify` mid-session
- `systemPrompt` set to `{ type: 'preset', preset: 'claude_code', append: '...call mcp__verifier__verify...' }` — agent instructed to self-verify before stopping
- `mcp_server_registered` log emitted with `{ type: 'mcp', server: 'verifier', tools: ['verify'] }` at session start
- PostToolUse matcher extended from `'Write|Edit'` to `'Write|Edit|mcp__verifier__verify'` — MCP tool calls audited
- 20 session tests pass (16 original + 4 new), full suite green (251 tests), TypeScript compiles cleanly
- RetryOrchestrator remains unmodified — outer compositeVerifier gate unchanged

## Task Commits

TDD task had two commits:

1. **RED phase: failing tests** - `498a5ac` (test)
2. **GREEN phase: implementation** - `e5185d5` (feat)

## Files Created/Modified

- `/Users/kiruba/code/Projects/ai/background-coding-agent/src/orchestrator/claude-code-session.ts` - Import, verifier server creation, mcpServers option, systemPrompt option, extended PostToolUse matcher
- `/Users/kiruba/code/Projects/ai/background-coding-agent/src/orchestrator/claude-code-session.test.ts` - vi.mock for verifier-server.js, 4 new tests (17-20)

## Decisions Made

- `createVerifierMcpServer` is called inside `run()` rather than in the constructor — the server captures `workspaceDir` at call time, which matches the session's resolved workspace path
- MCP log placed before the `try` block (same level as preHook/postHook creation) — clear lifecycle signal before any query activity
- Mock returns `{ type: 'sdk', name: 'verifier', instance: {} }` which is structurally compatible with what query() expects for mcpServers values without triggering actual server initialization

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## Next Phase Readiness

- Phase 12 is complete: MCP server implemented (Plan 01) and wired (Plan 02)
- The full in-process verification loop is now active: agent runs → calls mcp__verifier__verify mid-session → compositeVerifier runs → PASS/FAIL digest returned to agent → agent fixes failures before stopping → RetryOrchestrator outer gate runs final compositeVerifier as backstop
- Phase 13 (Container Strategy) is the next phase

## Self-Check: PASSED

- src/orchestrator/claude-code-session.ts: FOUND
- src/orchestrator/claude-code-session.test.ts: FOUND
- 12-02-SUMMARY.md: FOUND
- Commit 498a5ac (RED phase): FOUND
- Commit e5185d5 (GREEN phase): FOUND

---
*Phase: 12-mcp-verifier-server*
*Completed: 2026-03-18*
