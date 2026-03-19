---
phase: 10-agent-sdk-integration
plan: 01
subsystem: orchestrator
tags: [claude-agent-sdk, hooks, audit, security, tdd, vitest]

# Dependency graph
requires: []
provides:
  - ClaudeCodeSession class wrapping @anthropic-ai/claude-agent-sdk query()
  - PreToolUse security hook blocking outside-repo and sensitive file writes
  - PostToolUse audit hook logging file mutations via Pino
  - SDKResultMessage subtype -> SessionResult status mapping
  - 15 unit tests covering SDK-01 through SDK-10 requirements
affects: [10-agent-sdk-integration plan 02, RetryOrchestrator wiring]

# Tech tracking
tech-stack:
  added: ["@anthropic-ai/claude-agent-sdk@0.2.77"]
  patterns:
    - "HookCallback pattern: buildPreToolUseHook/buildPostToolUseHook factory functions"
    - "Mutable counter ref { count: number } for toolCallCount in PostToolUse hook"
    - "query() generator wrapped in try/finally with generator.return() for cleanup"
    - "AbortController stored on class instance, nulled in finally block"

key-files:
  created:
    - src/orchestrator/claude-code-session.ts
    - src/orchestrator/claude-code-session.test.ts
  modified:
    - package.json
    - package-lock.json

key-decisions:
  - "maxBudgetUsd set to 2.00 USD per session — 6-40x safety margin above typical task cost"
  - "toolCallCount counted via PostToolUse hook counter (not num_turns which counts API round-trips)"
  - "error_max_budget_usd maps to turn_limit status (terminal, no retry) — same as error_max_turns"
  - "systemPrompt left undefined — userMessage passed as prompt only (end-state pattern)"
  - "settingSources: [] — no filesystem config imported, isolation guaranteed"

patterns-established:
  - "PreToolUse hook: check file_path ?? path (both field names exist in SDK tools)"
  - "PreToolUse deny: return { systemMessage, hookSpecificOutput: { hookEventName, permissionDecision: 'deny', permissionDecisionReason } }"
  - "PostToolUse hook: increment counterRef.count and logger.info audit event with type:'audit'"
  - "Generator cleanup: queryGen.return(undefined) in finally block wrapped in try/catch"

requirements-completed: [SDK-01, SDK-02, SDK-03, SDK-04, SDK-05, SDK-06, SDK-07, SDK-08, SDK-09, SDK-10]

# Metrics
duration: 18min
completed: 2026-03-17
---

# Phase 10 Plan 01: Agent SDK Integration - ClaudeCodeSession Summary

**ClaudeCodeSession class wrapping @anthropic-ai/claude-agent-sdk query() with PreToolUse security hooks, PostToolUse audit logging, and full SessionResult interface compatibility**

## Performance

- **Duration:** 18 min
- **Started:** 2026-03-17T12:49:20Z
- **Completed:** 2026-03-17T13:07:20Z
- **Tasks:** 1 (TDD: RED -> GREEN -> verify)
- **Files modified:** 4 (2 created, 2 modified)

## Accomplishments

- Installed @anthropic-ai/claude-agent-sdk@0.2.77 as production dependency
- Implemented ClaudeCodeSession with start()/run()/stop() matching AgentSession interface
- PreToolUse hook blocks writes to paths outside workspaceDir and to .env, .git/, .pem, .key, private_key patterns
- PostToolUse hook increments toolCallCount counter and logs structured audit events with type:'audit' via Pino
- SDKResultMessage subtype mapping: success->'success', error_max_turns->'turn_limit', error_max_budget_usd->'turn_limit', error_during_execution->'failed'
- 15 unit tests covering all SDK-01 through SDK-10 requirements, all passing

## Task Commits

Each task was committed atomically:

1. **Task 1: Install SDK and create ClaudeCodeSession with TDD** - `da5317c` (feat)

## Files Created/Modified

- `src/orchestrator/claude-code-session.ts` - ClaudeCodeSession class wrapping SDK query() (~265 lines)
- `src/orchestrator/claude-code-session.test.ts` - 15 unit tests for SDK requirements (~310 lines)
- `package.json` - Added @anthropic-ai/claude-agent-sdk dependency
- `package-lock.json` - Updated lockfile

## Decisions Made

- **maxBudgetUsd = 2.00**: Set per-session budget cap at $2.00 USD, giving 6-40x safety margin above typical task cost ($0.05-0.30). Exhaustion maps to turn_limit (terminal, no retry).
- **toolCallCount via PostToolUse hook**: Used mutable `{ count: number }` ref incremented in PostToolUse callback instead of `num_turns` (which counts API round-trips, not tool invocations).
- **systemPrompt left undefined**: userMessage passed as `prompt` parameter only, following end-state prompting pattern from Spotify research. System prompt construction deferred to Plan 02 if needed.
- **settingSources: []**: Explicitly empty to prevent any filesystem config leaking into sandboxed runs.
- **error_max_budget_usd -> turn_limit**: Budget exhaustion is terminal (same as maxTurns), prevents RetryOrchestrator from wasting retries on an already-expensive session.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- The `import.*query.*claude-agent-sdk` grep pattern in acceptance criteria does not match multi-line imports. The import is present in the file (confirmed: `claude-agent-sdk` appears in the import block). This is a pattern specificity issue in the criteria, not a code issue.
- Pre-existing integration test files (agent.test.ts, container.test.ts, session.test.ts) use a standalone script pattern with no `describe` blocks — vitest reports them as "no test suite found". These failures pre-date this plan and are not regressions.

## Next Phase Readiness

- ClaudeCodeSession is complete and fully tested
- Ready to wire into RetryOrchestrator in Plan 02 (conditional ClaudeCodeSession | AgentSession based on useSDK flag)
- SessionConfig needs `useSDK?: boolean` field in Plan 02

---
*Phase: 10-agent-sdk-integration*
*Completed: 2026-03-17*
