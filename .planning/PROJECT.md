# Background Coding Agent

## What This Is

A background coding agent platform that automates software maintenance and code change tasks in isolated Docker containers. Users interact via conversational interface (interactive REPL, one-shot CLI, or Slack bot) — natural language input is parsed into structured task parameters (dependency updates or generic code change instructions), optionally scoped through follow-up questions, confirmed with the user, then executed by the Claude Agent SDK (`query()`) inside Alpine containers with iptables network isolation. Changes are verified by a context-aware pipeline (build/test/lint for code, lint-only for config, zero-diff detection for no-ops, + MCP mid-session self-check + LLM Judge with refactoring awareness), and only verified changes produce GitHub PRs for human review.

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
- ✓ Generic task type with scope-fenced end-state prompting for any explicit code change — v2.2
- ✓ Intent parser generalization — `generic` taskType, refactoring verb guard, taskCategory — v2.2
- ✓ Zero-diff detection with distinct status through CLI/REPL — v2.2
- ✓ Config-only verification routing (lint+judge only, skip build+test) — v2.2
- ✓ LLM Judge enriched with refactoring NOT-scope-creep entries — v2.2
- ✓ GA structured outputs API migration (intent parser + judge) — v2.2
- ✓ REPL post-hoc PR creation — `pr` command creates PR for last task — v2.3
- ✓ Conversational scoping dialogue — optional pre-execution questions tighten generic task prompts — v2.3
- ✓ Follow-up task referencing — enriched session history enables "now add tests for that" — v2.3
- ✓ Slack bot adapter — full pipeline via @slack/bolt Socket Mode with Block Kit confirm — v2.3
- ✓ SessionCallbacks extensibility — channel-agnostic adapters (CLI, Slack, future MCP) — v2.3
- ✓ Git worktree isolation — each session in its own sibling worktree with PID-sentinel orphan detection — v2.4
- ✓ Docker mounts worktree (not main checkout) for concurrent execution without branch conflicts — v2.4
- ✓ Post-hoc PR uses stored `lastWorktreeBranch` — worktree branch is authoritative — v2.4
- ✓ Repo exploration tasks — `investigation` task type with 4 subtypes (git-strategy, ci-checks, project-structure, general) — v2.4
- ✓ Read-only Docker enforcement — `:ro` workspace mount + PreToolUse hook blocking Write/Edit — v2.4
- ✓ Investigation reports displayed inline in REPL and posted as Slack thread messages — v2.4
- ✓ Distinct exit codes for `vetoed` (2) and `turn_limit` (3); `SessionTimeoutError` dead code removed — v2.4
- ✓ Cancelled tasks recorded as `cancelled` in session history (not `failed`) — v2.4
- ✓ configOnly verifier routed through injected `retryConfig.verifier` — v2.4
- ✓ Slack dead code removed (`buildIntentBlocks`, `buildStatusMessage`); Slack multi-turn history populated — v2.4

### Active

## Current Milestone: v3.0 Program Automator

**Goal:** Evolve the agent from a single-session chore automator into a program automator that can drive arbitrary **sweeping refactors** — any task shaped as "find all occurrences of X, transform to Y, verify Z" — across an entire repository. New task types must be addable as declarative recipes, not as new code phases.

**The shift in one sentence:** Stop treating a session as the unit of work. Make a **RefactorRun** the unit of work, and let sessions become replaceable workers against a persistent ledger, driven by a declarative recipe.

**Target features:**
- Sweeping-refactor task type with read-only discovery pass
- RefactorRun orchestrator (multi-session, persistent ledger, long-lived worktree)
- Differential verification against a baseline snapshot (not absolute green)
- Read-only `/context/` bundle mount + recipe-driven judge scope
- Declarative recipe format + generic recipe runner (4 slots: discovery / transform / verify / context)
- Task-agnostic capability toolbox (`config_edit`, `ast_query/rewrite`, `import_rewrite`, `rewrite_run`, `test_baseline/compare`, `doc_retrieve`)
- Conversational recipe authoring (four-question interview emits recipe drafts)

**Out of v3.0 scope:**
- Full language-to-language rewrites (Java → Kotlin) — defer to v4
- Multi-repo fleet orchestration — one repo per run
- Live-environment verification (prod-shaped DBs, live services)
- Creative/subjective tasks (visual polish)

#### Deferred (future milestone)

- [ ] Tab completion for project names and common task patterns
- [ ] --yes flag for auto-proceed on high-confidence parses (CI/scripting)
- [ ] Multi-file migration support with scoped planning phase before execution
- [ ] Task discovery mode — separate analysis mode that identifies where changes are needed

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
- Task discovery/analysis ("find all deprecated calls") — requires explicit user instructions; agent can't validate self-defined scope
- Complex multi-file migrations (Scio, Backstage) — deferred to future milestone after generic path proven in v2.2
- Hardcoded task-type handlers per category — generic execution path proven in v2.2
- Mid-run input injection in Slack — breaks Docker isolation invariant; all scoping happens pre-confirmation
- Persistent cross-session Slack history — stale context causes misparses; sessions reset on restart
- Slack auto-execute without confirmation — removes human-in-the-loop trust model

## Shipped: v2.4 Git Worktree & Repo Exploration (2026-04-07)

Git worktree isolation so concurrent agent sessions never conflict — `WorktreeManager` with PID-sentinel orphan detection, runAgent try/finally lifecycle, Docker mounts the worktree (not the main checkout), REPL startup `pruneOrphans`, and post-hoc PR branch support via `lastWorktreeBranch`. Read-only repo exploration task type (`investigation`) with fast-path intent classification, 4-subtype exploration prompts, Docker `:ro` mount, PreToolUse Write/Edit block, and report display in REPL + Slack. Accumulated tech debt cleared: distinct exit codes, dead-code removal (`SessionTimeoutError`, `buildIntentBlocks`, `buildStatusMessage`), correct `cancelled` history recording, configOnly verifier routed through dependency injection, and Slack multi-turn history population.

## Shipped: v2.3 Conversational Scoping & REPL Enhancements (2026-04-05)

REPL post-hoc PR creation (`pr` command), conversational scoping dialogue (up to 3 optional questions for generic tasks), follow-up task referencing via enriched session history, and Slack bot adapter (`@slack/bolt` Socket Mode with Block Kit confirm/cancel, async agent execution, PR link posting). SessionCallbacks interface extended with `askQuestion`, `onMessage`, `onPrCreated` for channel-agnostic adapters.

## Shipped: v2.2 Deterministic Task Support (2026-03-25)

Generalized the agent beyond dependency updates to handle any explicit code change instruction. Added generic task type with scope-fenced end-state prompting, refactoring verb guard in intent parser, zero-diff detection, config-only verification routing, and LLM Judge enrichment for refactoring awareness. Migrated both intent parser and judge to GA structured outputs API.

## Shipped: v2.1 Conversational Mode (2026-03-22)

Replaced rigid CLI flags with conversational interface. Users interact via REPL or one-shot CLI, natural language is parsed to structured intents (fast-path regex + LLM fallback), context is scanned from repo manifests, and multi-turn follow-ups inherit session history.

## Shipped: v2.0 Claude Agent SDK Migration (2026-03-19)

Replaced the custom agent loop with the Claude Agent SDK. Deleted 1,989 lines of hand-built infrastructure. Agent now runs inside Docker with iptables network isolation and can self-verify mid-session via MCP.

## Context

**Shipped v1.0** (Foundation) with 5,460 LOC TypeScript across 6 phases in 35 days.
**Shipped v1.1** (End-to-End Pipeline) with 3 phases: GitHub PR creation, Maven dependency update, npm dependency update.
**Shipped v2.0** (Claude Agent SDK Migration) with 4 phases in 3 days. 8,167 LOC TypeScript, 271 tests.
**Shipped v2.1** (Conversational Mode) with 4 phases in 4 days. 13,780 LOC TypeScript, 513 tests.
**Shipped v2.2** (Deterministic Task Support) with 3 phases in 3 days. 15,941 LOC TypeScript, 575 tests.
**Shipped v2.3** (Conversational Scoping & REPL Enhancements) with 4 phases in 11 days. 18,121 LOC TypeScript, 696 tests.
**Shipped v2.4** (Git Worktree & Repo Exploration) with 3 phases in 3 days. 20,328 LOC TypeScript, 798 tests.

**Tech stack:** Node.js 20, TypeScript (NodeNext), Docker (Alpine, multi-stage), Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), Anthropic SDK (LLM Judge + intent parser), Commander.js, Pino, Vitest, ESLint v10, Zod, conf@15, @slack/bolt@^4.6.0. Git worktrees via `execFile` + Node built-ins (no `simple-git` dependency).

**Architecture:** CLI → {REPL | one-shot | Slack bot} → Intent Parser (fast-path regex + LLM with verb guard + action verb guard for exploration) → Scoping Dialogue (generic tasks) → Confirm → runAgent() → Docker lifecycle → **Investigation bypass** (read-only ClaudeCodeSession) OR **Worktree lifecycle** (WorktreeManager.create → RetryOrchestrator → zero-diff check → config-only routing → ClaudeCodeSession (`query()`) → verifier → judge → PR → WorktreeManager.remove in finally). Docker container (iptables, non-root UID 1001, `:rw` for regular tasks / `:ro` for investigation). Built-in tools (Read, Write, Edit, Bash, Glob, Grep). PreToolUse hook for security + read-only enforcement, PostToolUse hook for audit. MCP verifier server for mid-session self-check. Composite verifier (build+test+lint for code, lint-only for config) as outer gate. LLM Judge (Claude Haiku 4.5, GA structured output, refactoring-aware) evaluates scope post-verification. Post-hoc PR creation via REPL `pr` command using stored `lastWorktreeBranch`.

**Test suite:** 798 unit tests (Vitest), 100% passing. Integration tests require Docker + API key.

**Known tech debt:** CLI-05 partial (cost tracking); REPL renders redundant status box after investigation report (cosmetic); CLI `run` command lacks `--task-type investigation` and `explorationSubtype` forwarding; SUMMARY.md frontmatter sparse for some plans (hygiene); Nyquist validation partial across phases 18-27.

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
| Generic execution path over task-type handlers | One `generic` type with `buildGenericPrompt()` covers all non-dep instructions | ✓ Good — scope-fenced prompts proven effective |
| Refactoring verb guard in fast-path | Prevents "replace axios with fetch" from misclassifying as dep update | ✓ Good — blocks 6 verb patterns before PR_SUFFIX |
| GA structured outputs API | Migrate off deprecated beta endpoint for intent parser + judge | ✓ Good — zero type assertions, clean API surface |
| End-state prompting discipline | Description verbatim as task statement, never paraphrased or rewritten | ✓ Good — outperforms step-by-step on capable models |
| Config-only verification routing | Config changes skip build+test to avoid false failures from pre-existing issues | ✓ Good — lint catches config syntax errors |
| Zero-diff as distinct status | Empty diffs are not retried (same prompt can't produce different result) | ✓ Good — clean signal through CLI/REPL |
| TaskHistoryEntry schema extended once in Phase 21 | Single extension point for retryResult + intent prevents schema divergence | ✓ Good — Phase 23 adds finalResponse only, no new schema change |
| SessionCallbacks methods always optional | `askQuestion?`, `onMessage?`, `onPrCreated?` graceful degradation | ✓ Good — Slack adapter skips scoping dialogue cleanly |
| Scoping dialogue skipped in Slack v2.3 | Optional `askQuestion` handles this; document as known limitation | ✓ Good — defer to SLCK-10 (Block Kit modals) |
| Per-user ReplState in Slack | `Map<userId, ReplState>` per incoming message prevents cross-user corruption | ✓ Good — independent sessions verified |
| Deferred-promise pattern for Slack confirm | pendingConfirm resolver stored on ThreadSession, resolved by action handler | ✓ Good — clean async bridge between Bolt events and session pipeline |
| Fire-and-forget agent in Slack | processSlackMention fires void async IIFE, decoupled from Bolt 3s ack timing | ✓ Good — no timeout issues |
| Sibling git worktrees via `execFile` + Node built-ins | No `simple-git` dependency; `.bg-agent-<repoBasename>-<suffix>` path convention; git rejects worktrees inside repo | ✓ Good — zero new deps, clean lifecycle |
| PID sentinel JSON stores both pid + branch | Enables branch cleanup even when worktree dir already removed; `process.kill(pid, 0)` with EPERM-as-alive is conservative | ✓ Good — orphan scan reliable across crashes |
| WorktreeManager single-use (one per session) | No shared state, no instance pooling; `pruneOrphans` is static | ✓ Good — simple lifecycle, no leaks |
| try/finally worktree cleanup in runAgent | Removes worktree on every exit path (success, failure, veto, zero-diff, cancelled, throw) | ✓ Good — no worktree accumulation |
| Investigation bypass between Docker and worktree lifecycles | Docker runs (needs `:ro` mount), worktree/orchestrator/verifier/judge/PR all skipped — clean separation | ✓ Good — exploration path trivially fast |
| Read-only enforcement at two layers | Docker `:ro` mount (OS-level) + PreToolUse hook denying Write/Edit (SDK-level) — defence in depth | ✓ Good — neither layer can be bypassed |
| Action verb guard in explorationFastPath | Prevents "update X" / "fix Y" from misclassifying as exploration; guard fires before pattern matching | ✓ Good — no false-positive investigations |
| Host-side `.reports/` write | Agent never writes files (even in non-read-only mode); REPL writes on `/\bsave\b/i` match in user input | ✓ Good — keeps exploration truly read-only |
| Injected verifier in retry.ts (configOnly path) | `retryConfig.verifier` always used — no direct `compositeVerifier` import; testable, mockable | ✓ Good — removes hot-path coupling |
| Exported `appendHistory` from session.ts | REPL and Slack adapters share the same bounded-history append logic | ✓ Good — no duplication across adapters |

---
*Last updated: 2026-04-08 after v3.0 milestone start*
