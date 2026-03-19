# Feature Research

**Domain:** Conversational agent interface — REPL, intent parsing, one-shot CLI, project registry, multi-turn sessions
**Researched:** 2026-03-19
**Confidence:** HIGH (table stakes verified against established CLI tool patterns, REPL conventions, and Claude Agent SDK docs)

---

## Context

This replaces the v2.0 migration feature landscape. v2.0 is shipped.

**Existing foundation (do not re-research):**
- CLI with Commander.js, `--task-type`, `--dep`, `--target-version`, `--repo` flags
- Agent executes in Docker container with iptables network isolation
- Verification pipeline (build/test/lint + MCP mid-session + LLM Judge)
- GitHub PR creation with rich context
- Maven and npm dependency update task types
- Retry loop with error summarization
- Claude Agent SDK `query()` with PreToolUse/PostToolUse hooks

**What this research covers:**
Interactive REPL, one-shot CLI mode, LLM intent parser, context-first clarification (scan repo → propose plan → confirm), project registry, multi-turn session context.

---

## Feature Landscape

### Table Stakes (Users Expect These)

Features a conversational developer agent must have. Missing these makes the interface feel worse than the flags-based CLI it replaces.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **One-shot natural language mode** | `bg-agent 'update recharts to 2.15'` must work without flags | LOW | Positional argument detected → route to intent parser; no REPL loop opened. Deep Agents CLI, pipe-agent: both auto-detect stdin/arg and run non-interactively. |
| **Interactive REPL with prompt** | All conversational agents (Claude Code, aider, open-interpreter) provide a `>` prompt loop | LOW | Node.js `readline` / `node:readline/promises` handles line editing, history, Ctrl+C exit natively. No third-party dep needed. |
| **REPL command history (persistent)** | Up-arrow to recall previous tasks is table stakes for any terminal REPL | LOW | Node.js `repl.REPLServer` built-in: persists to `~/.node_repl_history`. With `readline`, persist manually to `~/.bg-agent-history`. |
| **Clear exit semantics** | `exit`, `quit`, Ctrl+C, Ctrl+D must all work predictably | LOW | Standard readline events: `SIGINT`, `close`. Must flush any in-progress state before exit. |
| **Echo confirmed plan before executing** | Users expect the agent to confirm what it's about to do before running a 5-min task | LOW | Print structured summary: task type, dep, version, repo. Prompt `Proceed? [Y/n]`. Claude Code and Conductor both do this. |
| **Graceful handling of ambiguous input** | "update recharts" without a version should ask, not fail silently or guess wrong | MEDIUM | Ask exactly one targeted question. Research: adding clarifying questions reduced error rates 27% and ambiguity retries from 4.1 to 1.3 per session. |
| **Status feedback during execution** | User must know the agent is running, not hung | LOW | Print "Running agent... (turn N/10)" lines to stderr. Same pattern as CLI `--verbose` mode already. |
| **Error messages in plain English** | Verification failure must surface as human-readable output, not raw JSON | LOW | Already done in CLI; REPL must preserve same behavior. |

### Differentiators (Competitive Advantage)

Features that make this conversational interface meaningfully better than just wrapping the existing flags CLI.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **LLM intent parser** | Natural language → structured `{taskType, dep, targetVersion, repo}` without users memorizing flag syntax | MEDIUM | Single Anthropic SDK call with structured output (tool_use). Use Claude Haiku 3.5 (same as Judge) for cost efficiency. Schema: `{taskType, dep, targetVersion, repo, confidence, clarification_needed}`. |
| **Context-first repo scan** | Agent scans `package.json` / `pom.xml` before asking questions — surfaces current version, suggests target version | MEDIUM | Before intent parsing, read manifest file. Inject into intent parser prompt: "Current recharts: 2.12.7, latest: 2.15.0". Reduces clarification turns. |
| **Project registry** | `bg-agent` in any registered project just works — no `--repo /long/path/to/project` | MEDIUM | JSON file at `~/.bg-agent/projects.json`. `{name: string, path: string, registeredAt: string}[]`. Auto-register cwd on first use (or explicit `bg-agent register`). |
| **Multi-turn session context** | Follow-up in REPL: "now do lodash too" understands context from previous task | HIGH | Maintain conversation window: last N parsed intents + outcomes. Inject as context into intent parser. Scope: last 5 tasks, same session. Do NOT persist across REPL restarts (scope creep risk). |
| **`--print` / non-interactive one-shot** | `bg-agent --print 'update recharts' | jq` for scripting and CI pipelines | LOW | Flag that suppresses REPL, disables confirm prompt, outputs structured JSON result to stdout. Deep Agents and pipe-agent both implement this. |
| **Registry short-name routing** | `bg-agent 'update recharts' --project myapp` instead of full path | LOW | Resolves `myapp` → path from `~/.bg-agent/projects.json`. Fallback: cwd if no `--project` given. |
| **Confidence threshold for auto-proceed** | High-confidence parses (`confidence >= 0.9`) skip manual confirmation in `--yes` mode | MEDIUM | `--yes` flag: if `confidence >= 0.9`, skip confirm prompt and run. If lower, always confirm regardless of flag. Prevents silent misparses. |

### Anti-Features (Commonly Requested, Often Problematic)

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| **Persistent multi-turn context across REPL sessions** | "It should remember I worked on myapp last week" | Context from old sessions becomes stale, incorrect, and misleading. A dep updated last week may be different from today's state. | Project registry records session outcomes. Fresh context scan at start of each task. |
| **Auto-execute without confirmation** | "It's annoying to type Y every time" | Removes human-in-the-loop for a destructive operation (modifying code, creating PRs). Verification does not catch all unintended changes. | `--yes` flag as opt-in. Default always confirms. |
| **Free-form follow-up that modifies previous agent output** | "Actually, also update the peer dep" after a PR is already created | Re-running an agent against already-modified code creates merge conflicts and overlapping PRs. | Start a new REPL task on the already-changed branch. Warn user if git status shows uncommitted changes. |
| **LLM parsing of flags** | "Could the intent parser understand `--dep lodash --target 4.18`?" | This is just the existing CLI. Adding LLM parsing to flag input adds latency and failure modes for zero benefit. | Keep Commander.js for flag mode. Intent parser only runs on positional/freeform text. |
| **Slack bot / webhook trigger in v2.1** | "I want to trigger from Slack" | Adds authentication, event subscription, workspace management scope. Completely separate problem from conversational REPL. | Project.md explicitly defers Slack to a later milestone. Architecture should not block this, but do not implement in v2.1. |
| **"Update all outdated deps"** | Convenient sounding | Single-turn agent with focus constraint is the trust model. Bulk updates destroy focus, cause scope creep, and make LLM Judge evaluation meaningless. | Iterate: one dep per REPL task. Multi-dep support can be a later research milestone. |
| **Intent parser that silently falls back to best guess** | Reduce friction | Silent wrong parses cause real damage (wrong dep updated, wrong version). | Always surface parse result to user. If `confidence < 0.7`, explain what was inferred and ask to confirm or correct. |

---

## Feature Dependencies

```
[Project Registry]
    └──required by──> [Registry short-name routing]
    └──required by──> [cwd auto-register]

[LLM Intent Parser]
    └──required by──> [One-shot natural language mode]
    └──required by──> [Interactive REPL]
    └──enhances──>    [Context-first repo scan]  (scan feeds parser context)

[Interactive REPL]
    └──requires──>    [LLM Intent Parser]
    └──requires──>    [Echo confirmed plan]
    └──enhances──>    [Multi-turn session context]

[Context-first repo scan]
    └──enhances──>    [LLM Intent Parser]         (reduces clarification turns)
    └──enhances──>    [Graceful ambiguity handling]

[Multi-turn session context]
    └──requires──>    [Interactive REPL]           (no context across one-shot runs)
    └──conflicts──>   [Persistent cross-session context]  (see anti-features)

[One-shot mode]
    └──requires──>    [LLM Intent Parser]
    └──conflicts──>   [Multi-turn session context]  (no session in one-shot)

[--print / non-interactive flag]
    └──requires──>    [One-shot mode]
    └──conflicts──>   [Interactive REPL]
```

### Dependency Notes

- **LLM Intent Parser is the critical path**: REPL, one-shot mode, and context-first scan all depend on it. Build and test intent parser first (Phase 1).
- **Project registry is independent**: Can be built in parallel with intent parser. No LLM dependency — pure JSON file + CLI commands.
- **Multi-turn context requires REPL**: Only meaningful in an interactive loop. Do not implement for one-shot mode.
- **Context-first scan enhances intent parser**: Read manifest before parsing to inject current version data. Reduces from "what version?" clarification to auto-proposing the right version.
- **One-shot and REPL conflict**: Same binary entry point must detect which mode to enter. Detection logic: positional arg present → one-shot; no arg → REPL.

---

## MVP Definition

### Launch With (v2.1)

Minimum viable conversational interface — what's needed to replace the flags CLI for the primary use case (dependency updates).

- [ ] **LLM intent parser** — extracts `{taskType, dep, targetVersion, repo}` from freeform text. Structured output with `confidence` field. Claude Haiku 3.5 call. Core of everything else.
- [ ] **One-shot natural language mode** — `bg-agent 'update recharts to 2.15'` runs the full existing pipeline. Single positional arg detected, parsed, confirm prompt, execute.
- [ ] **Interactive REPL** — `bg-agent` with no args opens `>` prompt. Each task parses, confirms, executes. Ctrl+C aborts current task. Ctrl+D / `exit` quits.
- [ ] **Echo confirmed plan** — before any agent run, print: `Task: npm-dependency-update | Dep: recharts | Version: 2.15.0 | Repo: /path/to/project. Proceed? [Y/n]`
- [ ] **Project registry** — `~/.bg-agent/projects.json`. Auto-register cwd on first use. `bg-agent register [name]` for explicit registration. `--project name` flag to select.
- [ ] **Graceful ambiguity handling** — if intent parser sets `clarification_needed: true`, ask the minimum clarifying question before proceeding.

### Add After Validation (v1.x)

Features to add once core REPL loop is used and validated.

- [ ] **Context-first repo scan** — trigger: intent parser confidence is <0.85 for version selection. Scan manifest to auto-propose version, reducing clarification loops.
- [ ] **Persistent REPL history** — trigger: users report re-typing same commands. `~/.bg-agent-history` file, 1000 entry cap.
- [ ] **Multi-turn session context** — trigger: users use follow-up commands ("now do lodash too") and hit confusion. Last 5 parsed intents injected into intent parser prompt.
- [ ] **`--print` / non-interactive flag** — trigger: CI integration requests. Outputs structured JSON, suppresses confirm prompt.

### Future Consideration (v2+)

Features to defer until product-market fit is established.

- [ ] **Confidence threshold auto-proceed** (`--yes`) — defer until user behavior shows confirm step is the main friction.
- [ ] **Slack / webhook trigger** — separate problem domain; architecture must not block it, but do not implement now.
- [ ] **Multi-dep batch mode** — defer until focus model is proven insufficient.
- [ ] **Cross-session persistent context** — defer; likely never needed given staleness risk.

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| LLM intent parser | HIGH | MEDIUM | P1 |
| One-shot natural language mode | HIGH | LOW (builds on parser) | P1 |
| Interactive REPL | HIGH | LOW | P1 |
| Echo confirmed plan | HIGH | LOW | P1 |
| Project registry | HIGH | LOW | P1 |
| Graceful ambiguity handling | HIGH | MEDIUM | P1 |
| Context-first repo scan | MEDIUM | MEDIUM | P2 |
| Persistent REPL history | LOW | LOW | P2 |
| Multi-turn session context | MEDIUM | HIGH | P2 |
| `--print` non-interactive flag | MEDIUM | LOW | P2 |
| Confidence auto-proceed (`--yes`) | LOW | LOW | P3 |
| Slack / webhook | LOW (now) | HIGH | P3 |

**Priority key:**
- P1: Must have for v2.1 launch
- P2: Should have, add after P1 validated
- P3: Nice to have, future milestone

---

## Existing System Integration Points

Where new features must wire into the existing pipeline without breaking it.

| New Feature | Integration Point | Risk |
|-------------|-------------------|------|
| LLM intent parser | Produces `{taskType, dep, targetVersion, repo}` — same shape as existing `runAgent()` options | LOW — parser output maps 1:1 to existing flags |
| One-shot mode | New entry path in `src/cli/index.ts` — detect positional arg, call parser, call `runAgent()` | LOW — `runAgent()` already takes structured options |
| Interactive REPL | New `src/cli/repl.ts` module — loop wrapping parser + `runAgent()` | LOW — additive, doesn't touch existing `program.parse()` path |
| Project registry | New `src/registry/` module — read/write `~/.bg-agent/projects.json` | LOW — no coupling to agent pipeline |
| Confirm prompt | Inject between parser output and `runAgent()` call | LOW — can be a thin `src/cli/confirm.ts` utility |
| Context-first scan | Read `package.json` or `pom.xml` in resolved repo path before intent parsing | LOW — file read only, no agent involvement |
| Multi-turn context | Pass last N intents array into intent parser system prompt | MEDIUM — parser prompt contract changes; must not affect one-shot path |

**No existing CLI flag path should be broken.** `background-agent --task-type maven-dependency-update --repo /path ...` must continue to work unchanged. The new interface is additive.

---

## Sources

- [Node.js readline documentation](https://nodejs.org/api/readline.html) — HIGH confidence, official Node.js v25 docs
- [Node.js REPL documentation](https://nodejs.org/api/repl.html) — HIGH confidence, official Node.js v25 docs
- [Intent-Driven Natural Language Interface: Hybrid LLM + Intent Classification Approach](https://medium.com/data-science-collective/intent-driven-natural-language-interface-a-hybrid-llm-intent-classification-approach-e1d96ad6f35d) — MEDIUM confidence, practitioner writeup
- [Ambig-SWE: Interactive Agents to Overcome Underspecificity in Software Engineering](https://arxiv.org/html/2502.13069v3) — MEDIUM confidence, 2025 research paper; clarification reduces errors 27%
- [When agents learn to ask: Active questioning in agentic AI](https://medium.com/@milesk_33/when-agents-learn-to-ask-active-questioning-in-agentic-ai-f9088e249cf7) — MEDIUM confidence, practitioner writeup
- [Deep Agents CLI — stdin pipe and non-interactive mode](https://docs.langchain.com/oss/python/deepagents/cli/overview) — MEDIUM confidence, LangChain official docs; confirms auto-detect stdin pattern
- [Google Conductor: context-driven development for Gemini CLI](https://developers.googleblog.com/conductor-introducing-context-driven-development-for-gemini-cli/) — MEDIUM confidence, official Google blog; validates plan-before-execute pattern
- [Anthropic: Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) — HIGH confidence, Anthropic engineering blog
- [Anthropic: Context Management](https://www.anthropic.com/news/context-management) — HIGH confidence, official Anthropic docs
- [Claude Code Interactive REPL and Workflow Modes](https://oboe.com/learn/mastering-claude-code-for-agentic-development-ivtygx/interactive-repl-and-workflow-modes-1) — MEDIUM confidence, third-party Claude Code guide; confirms REPL design patterns
- [OpenAI Codex Prompting Guide](https://developers.openai.com/cookbook/examples/gpt-5/codex_prompting_guide) — MEDIUM confidence, OpenAI official; confirms plan-confirm pattern

---

*Feature research for: conversational agent interface (v2.1)*
*Researched: 2026-03-19*
