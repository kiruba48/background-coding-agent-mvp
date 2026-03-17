---
gsd_state_version: 1.0
milestone: v2.0
milestone_name: Claude Agent SDK Migration
status: executing
stopped_at: Phase 11 context gathered
last_updated: "2026-03-17T19:35:44.278Z"
last_activity: 2026-03-17 — Plan 10-01 complete, ClaudeCodeSession implemented
progress:
  total_phases: 7
  completed_phases: 4
  total_plans: 10
  completed_plans: 10
  percent: 14
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-16)

**Core value:** The full verification loop must work: agent changes code, deterministic verifiers catch failures, LLM Judge catches scope creep, and only verified changes proceed.
**Current focus:** Phase 10 — Agent SDK Integration

## Current Position

Phase: 10 of 13 (Agent SDK Integration)
Plan: 1 of 2 (ClaudeCodeSession complete)
Status: In progress
Last activity: 2026-03-17 — Plan 10-01 complete, ClaudeCodeSession implemented

Progress: [█░░░░░░░░░] 14% (v2.0 phases)

## Performance Metrics

**Velocity (from v1.0 + v1.1):**
- Total plans completed: 23 (v1.0: 15, v1.1: 8)
- v1.0 average: ~2.3 days/plan across 6 phases
- v1.1 average: ~1.1 days/plan across 3 phases

**By Phase (v2.0):**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 10. SDK Integration | TBD | - | - |
| 11. Legacy Deletion | TBD | - | - |
| 12. MCP Verifier | TBD | - | - |
| 13. Container Strategy | TBD | - | - |

*Updated after each plan completion*
| Phase 10 P02 | 15m | 2 tasks | 7 files |

## Accumulated Context

### Decisions

- [v2.0 planning]: `allowedTools` is an auto-approval list, not a blocklist. Always pair with `disallowedTools: ["WebSearch", "WebFetch"]` for network isolation at tool layer.
- [v2.0 planning]: Stop hooks do not fire on maxTurns — do not rely on them for verification triggers. RetryOrchestrator remains the authoritative quality gate.
- [v2.0 planning]: Full `@anthropic-ai/sdk` removal is out of scope — LLM Judge keeps it for structured output. Phase 11 must decide: migrate Judge to `query()`, keep as peer dep, or constrained JSON prompt.
- [v2.0 planning]: Phase 13 MVP uses `--network bridge` + firewall rules. Full Unix proxy socket pattern deferred to v2.1.
- [10-01]: maxBudgetUsd = 2.00 USD per session — 6-40x safety margin above typical task cost ($0.05-0.30); exhaustion maps to turn_limit (terminal).
- [10-01]: toolCallCount counted via PostToolUse hook counter ref, not num_turns (which counts API round-trips).
- [10-01]: error_max_budget_usd maps to turn_limit status (same as error_max_turns) — prevents RetryOrchestrator from retrying expensive failed sessions.
- [10-01]: settingSources: [] — no filesystem config imported into agent sessions; isolation guaranteed.
- [Phase 10-02]: useSDK defaults to true via !== false check — undefined and true both select ClaudeCodeSession path; safe default-on pattern
- [Phase 10-02]: Commander.js --no-use-sdk sets options.useSdk = false; wired as options.useSdk !== false in runAgent to preserve undefined-as-true semantics

### Pending Todos

None.

### Blockers/Concerns

- [Phase 11]: LLM Judge migration path undecided — three options (migrate to `query()`, keep `@anthropic-ai/sdk` as peer dep, constrained JSON prompt). Decide before Phase 11 planning.
- [Phase 13]: Unix proxy socket implementation specifics not detailed. Flag for deep research before Phase 13 planning.
- [Phase 13]: Validate whether Agent SDK bundles Claude Code CLI binary or requires separate global install — affects Dockerfile.

## Session Continuity

Last session: 2026-03-17T19:35:44.276Z
Stopped at: Phase 11 context gathered
Resume file: .planning/phases/11-legacy-deletion/11-CONTEXT.md
Next action: Execute Plan 10-02 (RetryOrchestrator wiring with --use-sdk flag)
