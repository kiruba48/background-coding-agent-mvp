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

- ✓ Agent creates GitHub PR with full context (task prompt, diff, verification results, judge verdict) — v1.1
- ✓ Agent auto-generates branch names, user can override via CLI — v1.1
- ✓ Maven dependency update task type — user specifies dep, agent updates and adapts code — v1.1
- ✓ npm dependency update task type — user specifies dep, agent updates and adapts code — v1.1
- ✓ PR body flags potential breaking changes for human reviewer — v1.1

### Active

- [ ] Replace custom AgentSession/AgentClient with Claude Agent SDK `query()`
- [ ] Delete legacy agent infrastructure (~1,200 lines)
- [ ] Run Agent SDK inside Docker container for production isolation
- [ ] Expose composite verifier as MCP server (optional, Spotify pattern)

## Current Milestone: v2.0 Claude Agent SDK Migration

**Goal:** Replace the custom agent loop with the Claude Agent SDK — delete ~1,200 lines of hand-built agent infrastructure, gain 15+ built-in tools, auto context compression, and hooks-based safety model.

**Target features:**
- Claude Agent SDK integration (`query()` replaces AgentSession + AgentClient)
- Legacy agent code deletion (agent.ts, session.ts, container.ts)
- Container strategy (Agent SDK runs inside Docker for isolation)
- MCP verifier server (optional — agent self-verifies within session)

### Out of Scope

- Queue/webhook triggers — CLI only for MVP, architecture should support later
- Auto-merge — human approval required (trust model)
- Slack/notification integrations — manual PR review sufficient
- Multi-repo batch operations — single repo per run
- Real-time streaming UI — CLI output sufficient
- Mobile app — not applicable
- Custom verifier plugins — deferred to v2.1+
- Cost per run metric — deferred to v2.1+
- GitLab/Bitbucket PR support — GitHub only for now
- "Update all outdated deps" mode — user specifies dep for v1.1

## Context

**Shipped v1.0** (Foundation) with 5,460 LOC TypeScript across 6 phases in 35 days.
**Shipped v1.1** (End-to-End Pipeline) with 3 phases: GitHub PR creation, Maven dependency update, npm dependency update.

**Tech stack:** Node.js 20, TypeScript (NodeNext), Docker (Alpine 3.18), Anthropic SDK, Commander.js, Pino, Vitest, ESLint v10.

**Architecture (current — v2.0 will change this):** CLI → RetryOrchestrator → AgentSession → Docker container (network-none, non-root). Agent communicates via Anthropic SDK agentic loop. Tools execute in container (read-only) or host-side (git, edit). Composite verifier (build+test+lint) feeds into retry loop. LLM Judge (Claude Haiku 4.5, structured output) evaluates scope post-verification.

**Architecture (v2.0 target):** CLI → RetryOrchestrator → Claude Agent SDK `query()` → Docker container. Built-in tools (Read, Write, Edit, Bash, Glob, Grep). Hooks for verification and audit. Permission mode: acceptEdits.

**Test suite:** ~100 unit tests (Vitest), 100% passing. Integration tests require Docker + API key.

**Migration reference:** See BRIEF.md for detailed analysis (Spotify's "Honk" agent evolution, what to delete/keep/modify, what we gain/lose).

**Known tech debt:** CLI-05 partial (cost tracking), exit code switch missing explicit vetoed/turn_limit cases, SessionTimeoutError dead code, stale documentation field names.

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
| PR description as spec | Keeps documentation with the change | ✓ Good — shipped in Phase 7 |
| Maven first, npm later | Prove architecture with one type before extending | ✓ Good — Maven (Phase 8) proved pattern, npm (Phase 9) extended cleanly |
| Claude Agent SDK over custom loop | Better tools, auto context compression, less code to maintain (Spotify validated this path) | — Pending (v2.0) |

---
*Last updated: 2026-03-16 after v2.0 milestone start*
