# Background Coding Agent

## What This Is

A background coding agent platform that automates software maintenance tasks in isolated Docker containers. Users interact via conversational interface (interactive REPL or one-shot CLI) — natural language input is parsed into structured task parameters, confirmed with the user, then executed by the Claude Agent SDK (`query()`) inside Alpine containers with iptables network isolation. Changes are verified by a three-layer pipeline (build/test/lint + MCP mid-session self-check + LLM Judge), and only verified changes produce GitHub PRs for human review.

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
- ✓ Interactive REPL with freeform natural language task input — v2.1
- ✓ One-shot mode for scripts/CI (`bg-agent 'update recharts'`) — v2.1
- ✓ LLM-powered intent parser extracting task type + params from natural language — v2.1
- ✓ Context-first clarification — agent scans repo, proposes plan, user confirms/redirects — v2.1
- ✓ Project registry mapping short names → repo paths (terminal auto-registers cwd) — v2.1
- ✓ Multi-turn sessions — REPL maintains context across follow-up tasks — v2.1

### Active

#### Current Milestone: v2.2 — Deterministic Task Support

**Goal:** Generalize the agent beyond dependency updates to handle any explicit code change instruction — config edits, simple refactors, method replacements — with fully autonomous execution from task spec to PR.

**Target features:**
- Generic task type that passes user instructions as end-state prompts (not hardcoded task-type handlers)
- Intent parser recognizes generic change instructions alongside dependency updates
- Verification adapts to repo context (build system detection, config-only vs code changes)
- Works end-to-end with no user input after task confirmation until PR

#### Deferred

- [ ] Follow-up tasks can explicitly reference previous task results
- [ ] Tab completion for project names and common task patterns
- [ ] --yes flag for auto-proceed on high-confidence parses (CI/scripting)
- [ ] Slack bot interface using same intent parser and project registry

### Out of Scope

- Queue/webhook triggers — CLI only for now, architecture should support later
- Auto-merge — human approval required (trust model)
- Multi-repo batch operations — single repo per run
- Real-time streaming UI — CLI output sufficient
- Custom verifier plugins — deferred
- Cost per run metric — deferred
- GitLab/Bitbucket PR support — GitHub only for now
- "Update all outdated deps" mode — user specifies dep
- Shared workspace across multi-turn tasks — breaks one-container-per-task isolation invariant
- Auto-execute without confirmation — removes human-in-the-loop trust model
- Persistent cross-session context — stale context causes misparses, sessions reset on restart
- Task discovery/analysis ("find all deprecated calls") — v2.2 requires explicit user instructions
- Complex multi-file migrations (Scio, Backstage) — deferred to v2.3+ after generic path proven
- Hardcoded task-type handlers per category — generic execution path preferred

## Shipped: v2.1 Conversational Mode (2026-03-22)

Replaced rigid CLI flags with conversational interface. Users interact via REPL or one-shot CLI, natural language is parsed to structured intents (fast-path regex + LLM fallback), context is scanned from repo manifests, and multi-turn follow-ups inherit session history.

## Shipped: v2.0 Claude Agent SDK Migration (2026-03-19)

Replaced the custom agent loop with the Claude Agent SDK. Deleted 1,989 lines of hand-built infrastructure. Agent now runs inside Docker with iptables network isolation and can self-verify mid-session via MCP.

## Context

**Shipped v1.0** (Foundation) with 5,460 LOC TypeScript across 6 phases in 35 days.
**Shipped v1.1** (End-to-End Pipeline) with 3 phases: GitHub PR creation, Maven dependency update, npm dependency update.
**Shipped v2.0** (Claude Agent SDK Migration) with 4 phases in 3 days. 8,167 LOC TypeScript, 271 tests.
**Shipped v2.1** (Conversational Mode) with 4 phases in 4 days. 13,780 LOC TypeScript, 513 tests.

**Tech stack:** Node.js 20, TypeScript (NodeNext), Docker (Alpine, multi-stage), Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), Anthropic SDK (LLM Judge + intent parser), Commander.js, Pino, Vitest, ESLint v10, Zod, conf@15.

**Architecture:** CLI → {REPL | one-shot} → Intent Parser (fast-path + LLM) → Confirm → runAgent() → RetryOrchestrator → ClaudeCodeSession (`query()`) → Docker container (iptables, non-root UID 1001). Built-in tools (Read, Write, Edit, Bash, Glob, Grep). PreToolUse hook for security, PostToolUse hook for audit. MCP verifier server for mid-session self-check. Composite verifier (build+test+lint) as outer gate. LLM Judge (Claude Haiku 4.5, structured output) evaluates scope post-verification.

**Test suite:** 513 unit tests (Vitest), 100% passing. Integration tests require Docker + API key.

**Known tech debt:** CLI-05 partial (cost tracking), exit code switch missing explicit vetoed/turn_limit cases, SessionTimeoutError dead code, cancelled tasks recorded as 'failed' in session history, Nyquist validation drafts not fully compliant.

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
| Vitest over Jest | Native ESM/NodeNext support, no transpilation | ✓ Good — zero config needed |
| Pino over Winston | 5x faster, production-grade structured JSON | ✓ Good — clean logging throughout |
| Claude Agent SDK over custom loop | Better tools, auto context compression, less code to maintain | ✓ Good — 1,989 lines deleted, SDK handles tools/hooks natively |
| iptables over NetworkMode:none | API calls need network; iptables allows Anthropic-only | ✓ Good — entrypoint resolves api.anthropic.com, blocks rest |
| In-process MCP verifier | Agent self-checks mid-session, reduces outer retries | ✓ Good — compositeVerifier exposed as mcp__verifier__verify |
| Fast-path regex before LLM | Obvious patterns (dep name only) resolved without API call | ✓ Good — zero latency for common case |
| Haiku 4.5 for intent parsing | Interactive path needs low latency; 15s timeout | ✓ Good — structured output reliable, fast |
| Version numbers never from LLM | Zod schema enforces sentinel ('latest' or null) | ✓ Good — prevents hallucinated versions |
| SessionCallbacks injection | Decouples I/O (readline) from session logic | ✓ Good — enables CLI, Slack, MCP adapters |
| conf@15 for project registry | Atomic writes, ESM-native, cwd isolation for tests | ✓ Good — simple persistent key-value store |

---
*Last updated: 2026-03-23 after v2.2 milestone start*
