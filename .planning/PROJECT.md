# Background Coding Agent

## What This Is

A background coding agent platform that automates software maintenance tasks in isolated Docker containers. The agent engine (Anthropic SDK) executes in sandboxed environments with no network access, makes changes verified by a three-layer pipeline (build/test/lint + LLM Judge), and produces results for human review. v1.0 ships the complete verification architecture; next milestones add PR creation and task type implementations.

## Core Value

The full verification loop must work: agent changes code, deterministic verifiers catch failures, LLM Judge catches scope creep, and only verified changes proceed. Without this, the platform can't be trusted.

## Requirements

### Validated

- ✓ CLI triggers agent runs with task type and target repo — v1.0
- ✓ Agent executes in isolated Docker container with non-root user, no network — v1.0
- ✓ Agent can read files, edit code, run Git ops, search with grep, run allowlisted bash — v1.0
- ✓ Turn limit (10) and timeout (5 min) cap agent sessions — v1.0
- ✓ Structured JSON logging captures full session for debugging — v1.0
- ✓ Session state tracked (pending, running, success, failed, vetoed) — v1.0
- ✓ Deterministic verifiers check build, tests, linting pass — v1.0
- ✓ LLM Judge evaluates changes against original prompt for scope creep — v1.0
- ✓ Failed verification triggers retry with summarized error context (max 3) — v1.0
- ✓ Judge veto prevents PR creation even if deterministic checks pass — v1.0

### Active

- [ ] Successful verification creates PR with descriptive body and metadata
- [ ] Maven dependency update task type implemented end-to-end
- [ ] npm dependency update task type implemented end-to-end
- [ ] Custom verifiers can be added via plugin system
- [ ] Cost per run metric tracked

### Out of Scope

- Queue/webhook triggers — CLI only for MVP, architecture should support later
- Auto-merge — human approval required (trust model)
- Slack/notification integrations — manual PR review sufficient
- Multi-repo batch operations — single repo per run
- Real-time streaming UI — CLI output sufficient
- Mobile app — not applicable

## Context

**Shipped v1.0** with 5,460 LOC TypeScript across 6 phases in 35 days.

**Tech stack:** Node.js 20, TypeScript (NodeNext), Docker (Alpine 3.18), Anthropic SDK, Commander.js, Pino, Vitest, ESLint v10.

**Architecture:** CLI → RetryOrchestrator → AgentSession → Docker container (network-none, non-root). Agent communicates via Anthropic SDK agentic loop. Tools execute in container (read-only) or host-side (git, edit). Composite verifier (build+test+lint) feeds into retry loop. LLM Judge (Claude Haiku 4.5, structured output) evaluates scope post-verification.

**Test suite:** 90 unit tests (Vitest), 100% passing. Integration tests require Docker + API key.

**Known tech debt from v1.0:** CLI-05 partial (cost tracking), exit code switch missing explicit vetoed/turn_limit cases, SessionTimeoutError dead code, stale documentation field names. See [v1.0-MILESTONE-AUDIT.md](milestones/v1.0-MILESTONE-AUDIT.md).

## Constraints

- **Isolation**: Agent must run in Docker with no external network access — security non-negotiable
- **Verification**: Never skip verification loop — core to trust model
- **Human approval**: PRs require human merge — no auto-merge
- **Turn limits**: Agent sessions capped to prevent runaway costs
- **Single task**: One change type per agent session to maintain focus

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Docker sandbox (not subprocess) | Full isolation required for security model | ✓ Good — NetworkMode:none + non-root proven secure |
| Anthropic SDK direct (not Claude Code CLI) | More control, lower overhead, better tool customization | ✓ Good — agentic loop works reliably |
| Host-side git execution | Container user can't write .git/ directory | ✓ Good — avoids permission issues entirely |
| Retry on verification failure | Agent can often self-correct with error context | ✓ Good — RetryOrchestrator pattern clean |
| LLM Judge fail-open | Judge unavailability shouldn't block pipeline | ✓ Good — fail-open + skipped flag for observability |
| ESLint recommended (not strict) | Warnings don't fail verification, pragmatic baseline | ✓ Good — avoids false positives |
| Vitest over Jest | Native ESM/NodeNext support, no transpilation | ✓ Good — zero config needed |
| Pino over Winston | 5x faster, production-grade structured JSON | ✓ Good — clean logging throughout |
| Commander.js for CLI | Industry standard, automatic help generation | ✓ Good — minimal boilerplate |
| PR description as spec | Keeps documentation with the change | — Pending (Phase 7) |
| Maven first, npm later | Prove architecture with one type before extending | — Pending (Phase 8) |

---
*Last updated: 2026-03-02 after v1.0 milestone*
