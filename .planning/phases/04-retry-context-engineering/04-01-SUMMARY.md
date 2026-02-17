---
phase: 04-retry-context-engineering
plan: 01
subsystem: orchestration
tags: [retry, context-engineering, error-summarization, orchestration, typescript]

# Dependency graph
requires:
  - phase: 01-foundation
    provides: AgentSession, SessionConfig, SessionResult types for wrapping
  - phase: 02-cli-orchestration
    provides: pino logger injection pattern used in RetryOrchestrator.run()
  - phase: 03-agent-tool-access
    provides: AgentSession tool implementations (unchanged, used by retry)

provides:
  - RetryOrchestrator class wrapping AgentSession in outer retry loop (src/orchestrator/retry.ts)
  - ErrorSummarizer class with regex-based error extraction (src/orchestrator/summarizer.ts)
  - VerificationError, VerificationResult, RetryConfig, RetryResult type interfaces (src/types.ts)

affects: [phase-05-verification, phase-06-llm-judge, phase-10-plugin-verifiers]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Outer retry loop: RetryOrchestrator wraps AgentSession, fresh session per attempt"
    - "Error context injection: original task first, error digest second in retry messages"
    - "Regex-based error summarization: extract key lines only, cap at 2000 chars"
    - "Session-level failure distinction: timeout/turn_limit/failed are terminal, not retried"
    - "Forward-compatible verifier interface: Phase 5 plugs in via retryConfig.verifier callback"

key-files:
  created:
    - src/orchestrator/retry.ts
    - src/orchestrator/summarizer.ts
  modified:
    - src/types.ts

key-decisions:
  - "Fresh AgentSession per retry attempt prevents context window exhaustion from accumulated conversation history"
  - "Session-level failures (timeout, turn_limit, failed) are terminal and not retried — only verification failures trigger retry"
  - "Error digest hard-capped at 2000 chars to stay under 500 tokens for context window protection"
  - "Original task always first in retry message (primary directive), error context second (secondary information)"
  - "No backoff delay between retries — verification failures are not transient, delay adds no value"
  - "Synchronous ErrorSummarizer methods — string manipulation only, no I/O, deterministic and free"

patterns-established:
  - "Retry pattern: loop 1..maxRetries, fresh AgentSession per attempt, stop on session failure, retry on verification failure"
  - "Message structure pattern: [original-task]\n---\nPREVIOUS ATTEMPT N FAILED VERIFICATION:\n[digest]\n---\nFix the issues above..."
  - "Error summarizer pattern: regex extraction -> slice(0, 5) -> remaining count -> hard cap at 2000 chars"

requirements-completed:
  - EXEC-05
  - EXEC-06

# Metrics
duration: 2min
completed: 2026-02-17
---

# Phase 4 Plan 01: Retry Orchestration & Error Summarization Summary

**RetryOrchestrator outer loop with regex-based ErrorSummarizer, fresh AgentSession per attempt, and VerificationResult type system for Phase 5 verifier integration**

## Performance

- **Duration:** 2 min
- **Started:** 2026-02-17T10:58:58Z
- **Completed:** 2026-02-17T11:00:46Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments

- Added VerificationError, VerificationResult, RetryConfig, RetryResult type interfaces to src/types.ts for forward-compatible Phase 5 verifier integration
- Created ErrorSummarizer with 4 static synchronous methods for regex-based error extraction (build/test/lint + digest builder), capping output at 2000 chars
- Created RetryOrchestrator implementing outer retry loop: fresh AgentSession per attempt, session-level failures terminal, verification failures trigger retry with error context in initial message

## Task Commits

Each task was committed atomically:

1. **Task 1: Add verification/retry types and create ErrorSummarizer** - `32c70d6` (feat)
2. **Task 2: Create RetryOrchestrator with outer retry loop** - `4f35f22` (feat)

## Files Created/Modified

- `src/types.ts` - Added VerificationError, VerificationResult, RetryConfig, RetryResult interfaces after SessionResult
- `src/orchestrator/summarizer.ts` - New: ErrorSummarizer with summarizeBuildErrors, summarizeTestFailures, summarizeLintErrors, buildDigest static methods
- `src/orchestrator/retry.ts` - New: RetryOrchestrator wrapping AgentSession in outer retry loop with buildRetryMessage helper

## Decisions Made

- Fresh AgentSession per retry (not conversation continuation) — prevents context window exhaustion from accumulated history per Anthropic/Spotify production patterns
- Session-level failures are terminal — retrying timeouts or turn-limit failures would just waste time on the same intractable task
- Hard cap of 2000 chars on error digest — protects agent context window, derived from Spotify's "under 500 tokens" recommendation
- Original task always first in retry message — avoids Pitfall 5 (agent focuses on fixing errors instead of completing objective)
- Synchronous ErrorSummarizer — regex on structured build output is deterministic and free; async LLM summarization costs tokens and adds latency

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- RetryOrchestrator and ErrorSummarizer are ready for Phase 5 verifier integration
- Phase 5 plugs verifiers via `retryConfig.verifier?: (workspaceDir: string) => Promise<VerificationResult>` callback
- VerificationResult interface is stable and forward-compatible with Phase 6 LLM Judge verifier
- `src/orchestrator/index.ts` needs RetryOrchestrator and ErrorSummarizer exports (Plan 04-02 will handle this)

---
*Phase: 04-retry-context-engineering*
*Completed: 2026-02-17*
