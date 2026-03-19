# Background Coding Agent

## What This Is

A background coding agent platform that automates software maintenance tasks in isolated Docker containers. The Claude Agent SDK (`query()`) drives agent sessions inside Alpine containers with iptables network isolation (API-only access). Changes are verified by a three-layer pipeline (build/test/lint + MCP mid-session self-check + LLM Judge), and only verified changes produce GitHub PRs for human review.

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
- ✓ Claude Agent SDK `query()` replaces custom AgentSession/AgentClient — v2.0
- ✓ 1,989 lines of legacy agent infrastructure deleted — v2.0
- ✓ Agent SDK runs inside Docker container with iptables network isolation — v2.0
- ✓ In-process MCP verifier server for mid-session self-correction — v2.0

### Active

- [ ] Interactive REPL with freeform natural language task input
- [ ] One-shot mode for scripts/CI (`bg-agent 'update recharts'`)
- [ ] LLM-powered intent parser extracting task type + params from natural language
- [ ] Context-first clarification — agent scans repo, proposes plan, user confirms/redirects
- [ ] Project registry mapping short names → repo paths (terminal auto-registers cwd)
- [ ] Multi-turn sessions — REPL maintains context across follow-up tasks

## Current Milestone: v2.1 Conversational Mode

**Goal:** Replace rigid CLI flags with a conversational interface — REPL + one-shot, natural language in, context-aware plan proposal, same verification pipeline out.

**Target features:**
- Interactive REPL and one-shot CLI modes
- LLM intent parser (natural language → structured task params)
- Context-first clarification (scan repo → propose plan → confirm)
- Project registry (cwd auto-register, Slack-ready)
- Multi-turn session context

## Shipped: v2.0 Claude Agent SDK Migration (2026-03-19)

Replaced the custom agent loop with the Claude Agent SDK. Deleted 1,989 lines of hand-built infrastructure. Agent now runs inside Docker with iptables network isolation and can self-verify mid-session via MCP.

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
**Shipped v2.0** (Claude Agent SDK Migration) with 4 phases in 3 days. 8,167 LOC TypeScript, 271 tests.

**Tech stack:** Node.js 20, TypeScript (NodeNext), Docker (Alpine, multi-stage), Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), Anthropic SDK (LLM Judge only), Commander.js, Pino, Vitest, ESLint v10.

**Architecture:** CLI → RetryOrchestrator → ClaudeCodeSession (`query()`) → Docker container (iptables, non-root UID 1001). Built-in tools (Read, Write, Edit, Bash, Glob, Grep). PreToolUse hook for security, PostToolUse hook for audit. MCP verifier server for mid-session self-check. Composite verifier (build+test+lint) as outer gate. LLM Judge (Claude Haiku 4.5, structured output) evaluates scope post-verification.

**Test suite:** 271 unit tests (Vitest), 100% passing. Integration tests require Docker + API key.

**Known tech debt:** CLI-05 partial (cost tracking), exit code switch missing explicit vetoed/turn_limit cases, SessionTimeoutError dead code, stale documentation field names, Nyquist validation drafts not fully compliant.

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
| Claude Agent SDK over custom loop | Better tools, auto context compression, less code to maintain (Spotify validated this path) | ✓ Good — 1,989 lines deleted, SDK handles tools/hooks natively |
| iptables over NetworkMode:none | API calls need network; iptables allows Anthropic-only | ✓ Good — entrypoint resolves api.anthropic.com, blocks rest |
| In-process MCP verifier | Agent self-checks mid-session, reduces outer retries | ✓ Good — compositeVerifier exposed as mcp__verifier__verify |
| API key via -e flag (not proxy) | Simpler MVP; Unix socket proxy deferred to v2.1 | ✓ Good — functional, proxy adds complexity without clear need yet |

---
*Last updated: 2026-03-19 after v2.1 milestone started*
