# Project Research Summary

**Project:** background-coding-agent v2.1 — Conversational Mode
**Domain:** Conversational agent interface (REPL + intent parser + project registry + multi-turn sessions) layered onto an existing CLI-based coding agent platform
**Researched:** 2026-03-19
**Confidence:** HIGH

## Executive Summary

The v2.1 milestone adds a conversational input layer to a fully-functioning v2.0 system. The correct framing is an **input normalization gateway**: natural language and explicit flags both converge on the same `RunOptions` struct before reaching `runAgent()`. Everything from `RetryOrchestrator` down — Docker isolation, verification pipeline, LLM Judge, PR creation — is untouched. The risk surface is entirely in the new input layer, and the key architectural constraint is that these components must never reach into the execution layer.

The recommended approach is four sequential components built in dependency order: (1) project registry and `runAgent()` extraction (pure infrastructure, no LLM), (2) intent parser using `@anthropic-ai/sdk` structured output with a Haiku model for single-turn JSON extraction, (3) REPL loop with `node:readline` and clarification flow, and (4) multi-turn session context propagation. New dependencies are minimal: `conf` for the project registry and `zod` for the intent schema; the REPL uses the built-in `node:readline`. One new binary (`bg-agent`) coexists alongside the existing `background-agent` binary — no existing CLI consumers are broken.

The dominant risks are security (prompt injection via repo files into the planning context) and correctness (version hallucination by the intent parser). Both must be prevented at the point of initial implementation, not retrofitted. Secondary risks are operational: SIGINT handler conflicts between the REPL and `runAgent()`, registry file corruption from concurrent writes, and backward compatibility breakage for existing CI scripts using explicit flags. All nine identified critical pitfalls have clear prevention strategies documented in PITFALLS.md.

---

## Key Findings

### Recommended Stack

The v2.1 stack additions are minimal by design. `node:readline` (built-in, zero dependency) handles the interactive REPL loop with history, tab completion, and signal events. `conf@^15.1.0` handles the project registry as an OS-native config file (ESM-native, TypeScript declarations, atomic writes, correct platform paths on macOS and Linux). `zod@^4.3.6` provides the intent schema and native `z.toJSONSchema()` for the structured output call — the Agent SDK already accepts Zod 4 as a peer dep. All agent execution uses the existing `@anthropic-ai/claude-agent-sdk` and `@anthropic-ai/sdk` already installed as production dependencies.

**Core technologies:**
- `node:readline` (built-in): Interactive REPL — zero dependency, stable in Node.js 20, supports persistent history via `'history'` event
- `conf@^15.1.0`: Project registry persistence — ESM-native, atomic writes, correct OS config dirs, direct successor to configstore
- `zod@^4.3.6`: Intent parser schema — `z.toJSONSchema()` built-in eliminates need for a separate converter; compatible with Agent SDK
- `@anthropic-ai/sdk` (already installed): Intent parsing via single-turn structured output — `messages.create()` with `output_config.format`; NOT `query()`, which is for multi-turn agentic loops
- `@anthropic-ai/claude-agent-sdk` (already installed): Multi-turn session context via `resume: sessionId` option on `query()`

**Version constraints:** `conf@^15` requires Node.js 20+, which matches the project baseline exactly.

### Expected Features

All new features are additive. The explicit-flag CLI (`--task-type`, `--dep`, `--target-version`, `--repo`) must remain fully functional in v2.1 — this is a hard compatibility requirement, not a nice-to-have.

**Must have (P1 — v2.1 launch):**
- LLM intent parser — extracts `{taskType, dep, targetVersion, repo}` with `confidence` and `clarification_needed` fields; rejects hallucinated versions by design
- One-shot natural language mode — positional arg detected → parse → confirm → run existing pipeline
- Interactive REPL — `node:readline` loop, Ctrl+C cancels current run (not REPL), Ctrl+D/`exit` quits
- Echo confirmed plan — print parsed intent before any agent run; always prompt `Proceed? [Y/n]`
- Project registry — auto-register cwd (only if `.git` or build manifest present), `--project name` flag for short-name routing
- Graceful ambiguity handling — when `clarification_needed: true`, ask exactly one targeted question

**Should have (P2 — after P1 validated):**
- Context-first repo scan — read `package.json`/`pom.xml` before parsing to surface current versions; reduces clarification turns
- Persistent REPL history — `~/.bg-agent-history`, 1,000-entry cap
- Multi-turn session context — last 5 parsed intents injected into intent parser; in-memory only, bounded by token cap
- `--print` non-interactive flag — suppresses confirm prompt, outputs structured JSON for CI scripting

**Defer (P3 — v2+):**
- Confidence auto-proceed (`--yes`) — defer until confirm step is proven to be main friction
- Slack/webhook trigger — separate product domain; architecture must not block it
- Multi-dep batch mode — defer until focus model is proven insufficient
- Cross-session persistent context — staleness risk outweighs benefit

### Architecture Approach

v2.1 adds a new `src/cli/repl/` module and a new `bin/bg-agent` entry point that produce `RunOptions` objects and call the already-stable `runAgent()` function. The execution layer (`RetryOrchestrator`, `ClaudeCodeSession`, `compositeVerifier`, `llmJudge`, Docker, MCP verifier server) is entirely unchanged. The only modifications to existing files are: extracting `runAgent()` from Commander's action handler so it is importable, adding a `freeform` task type to `prompts/index.ts`, extending `types.ts` with `ParsedIntent`/`RegistryEntry`/`SessionContextState`, and adding an optional `signal?: AbortSignal` to `RunOptions` for REPL-controlled cancellation.

**Major components (all new):**
1. `InputRouter` (`src/cli/repl/input-router.ts`) — detects one-shot vs. REPL mode from argv; drives REPL read/run/print loop
2. `IntentParser` (`src/cli/repl/intent-parser.ts`) — single structured-output `messages.create()` call; Haiku 4.5; returns `ParsedIntent`; never outputs specific version numbers
3. `ProjectRegistry` (`src/cli/registry/project-registry.ts`) — reads/writes `conf`-managed JSON; validates directories before registration; atomic writes via `conf`
4. `ContextScanner` (`src/cli/repl/context-scanner.ts`) — extracts structured facts from `package.json`/`pom.xml`; feeds intent parser; never dumps raw file content into prompts
5. `ClarificationLoop` (`src/cli/repl/clarification-loop.ts`) — displays plan, waits for confirmation or targeted clarification question
6. `SessionContext` (`src/cli/repl/session-context.ts`) — in-memory multi-turn state; bounded history (token cap); cleared on process exit

**Patterns to follow:**
- Intent parser as thin API wrapper (single call, not `query()`) — same pattern as existing LLM Judge
- Input normalization gateway — all paths produce `RunOptions` before reaching `runAgent()`
- REPL owns signal handling — `runAgent()` accepts `AbortSignal`, never registers `process.once('SIGINT')` when called from REPL mode
- Fresh workspace per task — `SessionContext` persists user-level state; each task still gets a new Docker container and git clone

### Critical Pitfalls

1. **Intent parser hallucinating version numbers** — The parser must output `"latest"` or `null` for versions, never a specific version string. Version resolution happens downstream via `npm view` or `mvn dependency:get`, not in the LLM call. Enforce this in the Zod schema.

2. **Prompt injection via repo file content** — Context-first repo scan must never dump raw file content into the planning prompt. All repo content must be inside XML-delimited quarantine sections with an explicit system instruction to treat it as untrusted data. Extract structured facts (dep names, current versions) rather than raw file text.

3. **Multi-turn stale workspace across tasks** — The REPL session context (user conversation history) must not be conflated with the execution workspace. Each REPL task that calls `runAgent()` gets a fresh Docker container and `git clone`. Session context is passed as prompt text, not as shared filesystem state.

4. **SIGINT handler conflict** — `runAgent()` currently uses `process.once('SIGINT')` which is consumed after the first call. In REPL mode `runAgent()` is called multiple times. Fix: add `signal?: AbortSignal` to `RunOptions`; the REPL owns signal handling and calls `abortController.abort()`. Must be resolved in Phase 14 before any agent runs from the REPL.

5. **Backward compatibility breakage** — The explicit-flag CLI must work identically in v2.1. A compatibility test using the v2.0 flag syntax must be a required pass criterion for the REPL/one-shot phase.

---

## Implications for Roadmap

Based on the dependency graph in ARCHITECTURE.md and the pitfall-to-phase mapping in PITFALLS.md, four phases are indicated in strict dependency order. Phase numbers continue from v2.0's Phase 13.

### Phase 14: Infrastructure Foundation — Registry + runAgent() Extraction

**Rationale:** `runAgent()` must be importable before any new entry point can call it — this is the hard prerequisite for all subsequent phases. Project registry has no LLM dependency and can be fully tested in isolation. The SIGINT refactor (`AbortSignal`) must happen here before any agent runs from the REPL, because retrofitting it after Phase 16 exists is structurally risky.

**Delivers:** `src/cli/registry/project-registry.ts` (with `conf`, atomic writes, `.git` validation guard); `runAgent()` extracted as importable function; `AbortSignal` wired into `RunOptions`; `bin/bg-agent` stub entry point; updated `types.ts` with `ParsedIntent`, `RegistryEntry`, `SessionContextState`.

**Addresses:** Project registry (P1); `--project` flag; one-shot mode infrastructure

**Avoids:** Registry file corruption (atomic writes from day one); SIGINT handler conflict (AbortSignal designed in before REPL exists); bad auto-registration of non-project directories (`.git` guard in registry)

### Phase 15: Intent Parser + One-Shot Mode

**Rationale:** Intent parser is the critical path dependency for REPL, one-shot mode, and context scan (FEATURES.md dependency graph). Building and unit-testing the parser before the REPL means confidence in the parsing logic is established first. One-shot mode (`bg-agent 'update recharts to 2.7.0'`) becomes fully functional at the end of this phase.

**Delivers:** `src/cli/repl/intent-parser.ts` (Haiku structured output, version sentinel enforcement, fast-path for explicit flags); `src/cli/repl/context-scanner.ts` (structured fact extraction, quarantine delimiters, `.env` exclusion); `InputRouter` one-shot path; `ClarificationLoop` (plan echo + confirm prompt); end-to-end one-shot workflow working.

**Addresses:** LLM intent parser (P1); one-shot natural language mode (P1); echo confirmed plan (P1); graceful ambiguity handling (P1); context-first repo scan (P2)

**Avoids:** Version hallucination (Zod schema enforces sentinel values — `"latest"` or `null`, never specific versions); prompt injection (quarantine delimiters in initial implementation, not as hardening); token cost inflation (fast-path bypasses LLM for explicit flag input)

### Phase 16: Interactive REPL Loop + Session State

**Rationale:** Requires Phase 15's intent parser and Phase 14's `runAgent()` extraction. REPL loop is straightforward once these exist — it is the read/run/print wrapper around already-working components. Docker image build check should be moved to REPL startup here (not per-task) to avoid a perceptible pause on every command.

**Delivers:** `src/cli/repl/input-router.ts` REPL mode (readline loop, Ctrl+C/Ctrl+D semantics, spinner feedback during Docker and context scan); `src/cli/repl/session-context.ts` (in-memory state, resolved project, task history); `bg-agent` with no args opens interactive prompt; persistent readline history; Docker build check moved to REPL startup.

**Addresses:** Interactive REPL (P1); persistent REPL history (P2); status feedback during execution (table stakes); clear exit semantics (table stakes)

**Avoids:** SIGINT conflict (AbortSignal from Phase 14 consumed here); Docker build check per task (moved to startup); UX freeze with no feedback during long operations

### Phase 17: Multi-Turn Session Context Propagation

**Rationale:** Requires a stable REPL (Phase 16). Multi-turn context is a pure enhancement — it only changes what is passed to the intent parser for disambiguation of follow-up inputs. Bounded history and token cap must be in the initial design to avoid context window overflow in long sessions (Pitfall 8).

**Delivers:** `SessionContext` history accumulation with sliding window (last N tasks as structured facts); hard token budget enforced before each intent parser call; rolling summary for older turns; follow-up inputs like "now do lodash too" correctly inherit project context without sharing execution workspace.

**Addresses:** Multi-turn session context (P2)

**Avoids:** Context window overflow (hard token cap — suggested 2,000 tokens for history, to be validated during planning); stale workspace contamination (fresh container per task confirmed as session invariant)

### Phase Ordering Rationale

- Phase 14 before all others: `runAgent()` exportability is a compile-time dependency, and the `AbortSignal` refactor cannot safely be added after REPL code exists.
- Phase 15 before Phase 16: the REPL loop has no value without an intent parser to dispatch tasks.
- Phase 16 before Phase 17: multi-turn context requires a running REPL session to accumulate history.
- `ContextScanner` is bundled into Phase 15 (not a separate phase) because it shares a data contract with `IntentParser` and the injection-quarantine requirement applies to both simultaneously.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 17 (Multi-Turn Sessions):** Context bounding strategies and token budget sizing for bounded history are under-documented in the research. Recommend `/gsd:research-phase` to validate the sliding window approach and the 2,000-token history cap before implementation.

Phases with standard patterns (skip research-phase):
- **Phase 14 (Infrastructure):** `conf` and `runAgent()` refactoring are well-documented at HIGH confidence. `AbortSignal` is a standard Node.js pattern.
- **Phase 15 (Intent Parser):** STACK.md fully documents `output_config.format` from official Anthropic docs. The intent parser pattern mirrors the existing LLM Judge (`orchestrator/judge.ts`) — same model, same SDK, same structured-output approach.
- **Phase 16 (REPL):** `node:readline` is documented at HIGH confidence. REPL loop is a standard read/run/print pattern with no novel integrations.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All sources are official Anthropic docs, official Node.js docs, and live npm registry data verified 2026-03-19 |
| Features | HIGH | Table stakes verified against established CLI tools (Claude Code, aider, Deep Agents); differentiators validated by Anthropic engineering blog and research papers (clarification reduces errors 27%) |
| Architecture | HIGH | Integration analysis based on first-party codebase (`src/`) and official Agent SDK docs; specific file and function names are verified against existing v2.0 code |
| Pitfalls | HIGH | Critical pitfalls sourced from OWASP 2025, CVE records, quantified hallucination research (arXiv 2406.10279, 5.2% commercial LLM hallucination rate), and first-party code analysis |

**Overall confidence:** HIGH

### Gaps to Address

- **Multi-turn context token budgeting:** The 2,000-token cap for history is a suggested heuristic in PITFALLS.md, not a validated figure. Validate during Phase 17 planning with actual intent parser prompt sizes to set the correct cap.
- **`npm view` / `mvn dependency:get` version resolution:** PITFALLS.md recommends resolving `"latest"` sentinel to an actual version via registry lookup before passing to the agent. The exact integration point (inside `ContextScanner`, inside `IntentParser`, or a separate resolver step in `InputRouter`) is unspecified in ARCHITECTURE.md and should be resolved during Phase 15 planning.
- **`--print` JSON output schema:** FEATURES.md lists `--print` as P2 but does not define the exact JSON schema for structured output. Define during Phase 15 or 16 planning to avoid exit-code and output-format drift between one-shot and REPL paths.
- **`promptOverride` for freeform tasks:** ARCHITECTURE.md introduces `promptOverride?: string` on `RunOptions` for tasks that do not fit existing task types. The prompt builder for freeform tasks is unspecified. Confirm scope during Phase 15 planning — freeform task support may be out of v2.1 scope.

---

## Sources

### Primary (HIGH confidence)
- [Anthropic Agent SDK — TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript) — `Options` type, `continue`/`resume`/`session_id`
- [Anthropic Agent SDK — Work with Sessions](https://platform.claude.com/docs/en/agent-sdk/sessions) — session file location, `listSessions()`
- [Anthropic Agent SDK — Structured Outputs](https://platform.claude.com/docs/en/agent-sdk/structured-outputs) — `outputFormat`, `structured_output` on result
- [Claude API — Structured Outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) — `output_config.format`, no beta header required
- [Node.js v20 Readline API](https://nodejs.org/api/readline.html) — `createInterface` options, `'history'` event, SIGINT handling patterns
- [conf GitHub README](https://github.com/sindresorhus/conf) — API, TypeScript generics, atomic writes, platform-specific config paths
- [OWASP Top 10 for LLM Applications 2025 — LLM01 Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)
- [Package Hallucinations by Code Generating LLMs (arXiv 2406.10279)](https://arxiv.org/abs/2406.10279) — 5.2% hallucination rate for commercial LLMs; version numbers more hallucinated than names
- [Indirect Prompt Injection via GitHub README (EMNLP 2025)](https://aclanthology.org/2025.emnlp-demos.55.pdf) — CVE-2025-54135/54136; repo scan injection attack
- Existing codebase `src/` — first-party analysis of `run.ts`, `types.ts`, `retry.ts`, `judge.ts` (v2.0)

### Secondary (MEDIUM confidence)
- [Ambig-SWE: Active questioning in agentic AI (arXiv 2502.13069)](https://arxiv.org/html/2502.13069v3) — clarification reduces errors 27%, ambiguity retries from 4.1 to 1.3 per session
- [Intent-Driven NLI: Hybrid LLM + Intent Classification (Medium 2025)](https://medium.com/data-science-collective/intent-driven-natural-language-interface-a-hybrid-llm-intent-classification-approach-e1d96ad6f35d) — fast-path classification pattern
- [Google Conductor: context-driven development for Gemini CLI](https://developers.googleblog.com/conductor-introducing-context-driven-development-for-gemini-cli/) — plan-before-execute pattern validation
- [Agent State Management — AgentMemo 2026](https://agentmemo.ai/blog/agent-state-management-guide.html) — multi-turn state management patterns
- [Containing Agent Chaos: Dagger Container Use](https://dagger.io/blog/agent-container-use) — fresh-container-per-task rationale

---
*Research completed: 2026-03-19*
*Ready for roadmap: yes*
