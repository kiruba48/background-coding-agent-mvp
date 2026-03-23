# Project Research Summary

**Project:** background-coding-agent v2.2 — Generic Deterministic Task Support
**Domain:** Agentic coding pipeline — extending structured dependency-update tasks to arbitrary explicit code change instructions
**Researched:** 2026-03-23
**Confidence:** HIGH

## Executive Summary

The v2.2 milestone is an incremental extension of a fully operational v2.1 system. The entire execution layer (RetryOrchestrator, ClaudeCodeSession, compositeVerifier, LLM Judge, GitHubPRCreator) remains unchanged. All v2.2 changes are confined to the input-to-prompt path: adding a `generic` task type to the intent schema, replacing the one-liner stub in `buildPrompt()` with a proper `buildGenericPrompt()` function, and adding a `taskCategory` field to improve the confirmation display. No new npm packages are required. The work is pure TypeScript logic changes to existing modules. One required migration accompanies this work: the intent parser currently uses the deprecated beta structured outputs API and must be moved to the GA `client.messages.create()` with `output_config.format` before v2.2 ships.

The recommended approach is strict adherence to the existing end-state prompting discipline (established in TASK-04 / Spotify research) applied to generic tasks. The core insight is that generic tasks fail not because of execution infrastructure gaps, but because of thin prompts with no scope constraints. A `buildGenericPrompt()` that wraps the user's verbatim instruction with an explicit SCOPE block and end-state success criteria gives the agent the same bounding that the Maven/npm prompt builders provide for dependency updates. The LLM Judge already handles arbitrary diffs against arbitrary task descriptions and requires no structural changes — only a prompt enrichment to reduce false-veto rate on refactoring diffs. The compositeVerifier already skips gracefully on missing build configs, which is sufficient for most config-only changes without adding a new verification path, though config-only detection with syntax-only verification is needed to prevent pre-existing lint violations from being treated as agent-introduced errors.

The primary risks are all prompt and wiring risks, not architectural ones. The top three: (1) the thin generic stub producing unbounded agent behavior — prevented by scope fencing in `buildGenericPrompt()`; (2) the fast-path regex misclassifying refactoring instructions (e.g., "replace axios with fetch") as dependency updates — prevented by adding a refactoring verb guard before dep-name matching; and (3) retry messages losing the scope constraint when `originalTask` is set to raw user description instead of the full expanded prompt — prevented by passing the output of `buildPrompt()` as `originalTask`, not the user's `description` field. All three must be addressed in the initial implementation, not retrofitted after the fact.

---

## Key Findings

### Recommended Stack

No new packages are needed for v2.2. The existing stack — `@anthropic-ai/sdk@^0.80.0`, `@anthropic-ai/claude-agent-sdk@^0.2.81`, Zod 4, simple-git, Vitest, ESLint v10 — covers all requirements. The only mandatory change is migrating from the deprecated beta structured outputs API (`client.beta.messages.create()` with `betas: ['structured-outputs-2025-11-13']`) to the GA `client.messages.create()` with `output_config.format`. The beta endpoint removal timeline is unannounced but confirmed deprecated, and the v2.2 schema expansion is a natural forcing function for this migration.

**Core technologies:**
- `@anthropic-ai/sdk@^0.80.0`: Intent parsing via GA structured outputs — no beta header, `output_config.format`
- `@anthropic-ai/claude-agent-sdk@^0.2.81`: Agent execution via `query()` — unchanged for generic tasks
- `Zod 4`: `IntentSchema` extension — `description: z.string().nullable()` and `taskCategory: z.enum([...]).optional()` are additive and backward compatible
- `claude-haiku-4-5-20251001`: Intent parsing model — fastest/cheapest; correct for the 15s interactive path; Haiku 3 retiring April 19, 2026 (project already on Haiku 4.5)
- `path.extname()` + `git diff --name-only`: Config-only change detection — already available via `simple-git` and Node built-ins

**What NOT to add:** No AST parsers (tree-sitter, `@typescript-eslint/parser`), no LangChain, no `js-yaml`/`jsonschema` for config validation, no task queue systems. All are over-engineering for changes that the existing LLM Judge and compositeVerifier already handle.

### Expected Features

**Must have (table stakes — v2.2 launch):**
- Generic intent class — intent parser outputs `{taskType: 'generic', description: string}` for non-dep-update instructions; fast-path regex still fires first; `generic` is an explicit valid output, distinct from `unknown` (error/ambiguous)
- Generic task executor with scope constraint — `buildGenericPrompt()` wraps user instruction with SCOPE block and end-state success criteria; routes through existing RetryOrchestrator unchanged
- Zero-diff detection — after agent run, inspect diff size before calling composite verifier; if empty, emit `zero_diff` terminal state with clear user message; do not create PR
- Change-type-aware verification — post-run file extension inspection; config/data only (.json, .yaml, .toml, .env, etc.) applies syntax-only check; any source file triggers full composite verifier
- LLM Judge routing verified — integration test confirms generic tasks reach the same judge path as dep-update tasks; no new judge infrastructure

**Should have (competitive differentiators):**
- `taskCategory` field in IntentSchema (`code-change` / `config-change` / `dependency-update`) — improves confirmation display ("generic change (code-change)" vs "generic task"); optional and additive; does not affect execution logic
- Structured outputs API migration off beta header — reduces risk of breaking change when Anthropic removes deprecated endpoint
- Scope warning in confirm loop for unbounded task language ("all", "every", "everywhere") — prevents turn limit exhaustion on large-surface tasks
- Judge prompt enrichment for generic tasks — adds preamble: test file changes that exercise renamed/moved code are always in scope; reduces false-veto rate on correct refactoring diffs

**Defer (v2.3+):**
- Multi-file migration support — ~41% pass rate on SWE-bench; partial migrations leave repo in broken state; requires a scoped planning phase before execution
- Task discovery mode ("find places that need this change") — changes the agent's contract from "apply instruction" to "decide what needs changing"; LLM Judge cannot validate agent-defined scope
- Custom verifier profiles per file type — 80% of the value is covered by the change-type-aware verifier already planned for v2.2

### Architecture Approach

The v2.2 architecture is a confined additive extension. The execution layer is entirely unchanged. All changes live in two layers: the input layer (intent schema + LLM parser gain `taskCategory`; confirm loop display updated cosmetically) and the prompt layer (new `src/prompts/generic.ts` replaces the `default` branch stub in `buildPrompt()`). The critical invariant: `originalTask` passed to `RetryOrchestrator.run()` must be the full expanded prompt from `buildPrompt()`, not the raw user description — otherwise retry attempts lose the scope constraint and attempt 2 drifts wider than attempt 1.

**Major components:**
1. `src/prompts/generic.ts` (NEW) — `buildGenericPrompt(description: string): string`; wraps user instruction with SCOPE block ("Do not modify files unrelated to the task...") and end-state success criteria following the Maven/npm builder pattern
2. `src/intent/types.ts` (MODIFIED) — adds optional `taskCategory` to `IntentSchema`/`ResolvedIntent`; adds `description: z.string().nullable()` for generic tasks; additive Zod changes, backward compatible
3. `src/intent/llm-parser.ts` (MODIFIED) — migrates from beta to GA structured outputs API; adds `taskCategory` to `OUTPUT_SCHEMA` and one sentence to system prompt
4. `src/prompts/index.ts` (MODIFIED) — adds `case 'generic'` dispatching to `buildGenericPrompt()`; removes one-liner stub
5. `src/intent/confirm-loop.ts` (MODIFIED) — cosmetic only: displays `taskCategory` label for generic tasks

**Build order (strict):** Phase 1: `buildGenericPrompt()` + prompt dispatch (pure function, testable in isolation). Phase 2: intent schema + `taskCategory` field (additive). Phase 3: confirm loop display + end-to-end integration test (quality gate for milestone). No phase should require changes to `retry.ts`, `claude-code-session.ts`, or `verifier.ts` — if it does, the design has gone wrong.

**Key architectural patterns to enforce:**
- End-state prompting: description verbatim as task statement, never paraphrased
- Additive schema extensions: new fields are always optional/nullable; existing callers require no changes
- Verifier remains build-system agnostic: never route by task type; always detect by build system presence
- No hardcoded task-type handlers per category: one `generic` type with one `buildGenericPrompt()` covers all

### Critical Pitfalls

1. **Thin generic prompt produces unbounded agent behavior** — The current `default` branch in `buildPrompt()` is just `"You are a coding agent. Your task: ${description}. Work in the current directory."` with no scope fence. The agent sprawls: 15-line rename becomes a 400-line PR across 20 files. Prevention: `buildGenericPrompt()` must always emit an explicit SCOPE block around the user's description. Unit test must assert scope constraint prose is present in every output.

2. **Fast-path misclassifies refactoring instructions as dependency updates** — "replace axios with fetch" matches the dep-name fast-path (`dep: "axios"`, `taskType: 'npm-dependency-update'`). The agent removes `axios` from `package.json` instead of replacing call sites. Prevention: add a refactoring verb guard (`replace`, `rename`, `move`, `extract`, `migrate`, `rewrite`) before dep-name matching; route to LLM parser if verb is detected. Add explicit test cases in `fast-path.test.ts`.

3. **Retry message loses scope constraint** — `RetryOrchestrator.run()` receives `originalTask` from the raw user `description`, not the full expanded prompt. Retry attempt 2 has no SCOPE block and drifts wider. Prevention: `originalTask` must be the output of `buildPrompt()` — store as `expandedPrompt` at task start and pass that. Assert in `retry.test.ts` that retry message contains scope constraint text.

4. **LLM Judge false-vetoes correct refactoring diffs** — Judge prompt is calibrated for dep-update diffsets. For a method rename, the Judge may veto test file changes as "outside stated scope" even when they are clearly required updates. Prevention: add generic-task preamble to judge prompt ("For refactoring tasks, test updates that directly exercise the changed symbol are always in scope"). Run fixture tests before shipping.

5. **Config-change tasks trigger pre-existing lint violations as retryable errors** — Adding `"no-console": "error"` to `.eslintrc` causes the verifier to report 200 new violations; agent retries by removing all `console.log` calls across the repo — massive unintended side effect. Prevention: config-only detection (all changed files are config extensions) must route to syntax-only verification, not the full composite verifier pipeline.

---

## Implications for Roadmap

Based on combined research, the following phase structure is recommended. The dependency order is driven by: (a) `buildGenericPrompt()` is a pure function with no runtime dependencies — testable first; (b) the intent schema change is additive and independent; (c) the end-to-end integration test is the milestone quality gate and comes last.

### Phase 1: Intent Parser — Generic Type, taskCategory, and Structured Outputs Migration

**Rationale:** Everything in v2.2 depends on the parser producing a valid `generic` intent. The structured outputs migration from beta to GA must happen before schema expansion — combining them reduces risk and eliminates the `any` cast. Fast-path disambiguation guard prevents the misclassification pitfall before the first generic task is executed.
**Delivers:** Parser produces `{taskType: 'generic', description: string, taskCategory?: 'code-change' | 'config-change' | 'dependency-update'}` for non-dep-update instructions; `description: z.string().nullable()` added to IntentSchema; fast-path gains refactoring verb guard; `client.messages.create()` with GA `output_config.format` replaces beta API.
**Addresses:** Generic intent class (table stakes), structured outputs tech debt.
**Avoids:** Pitfall 4 (fast-path misclassification), deprecated API breakage.
**Research flag:** Standard patterns — official Anthropic GA docs are high-confidence; additive Zod extension is well-understood. Skip research-phase.

### Phase 2: Generic Prompt Builder

**Rationale:** The prompt builder is the highest-impact change for correctness. It can be built and fully unit-tested before any other v2.2 work lands. Scope fencing must be in the initial implementation — not added after an incident with a runaway generic task. The retry `originalTask` wiring is also resolved here to prevent scope loss on retry.
**Delivers:** `src/prompts/generic.ts` with `buildGenericPrompt(description: string): string` following the Maven/npm end-state pattern; `buildPrompt()` dispatch wired with `case 'generic'`; `originalTask` wired to full expanded prompt in RetryOrchestrator call site; unit tests assert scope constraint prose in all outputs and that retry message contains scope fence text.
**Addresses:** Generic task executor with scope constraint (table stakes).
**Avoids:** Pitfall 1 (thin prompt, unbounded behavior), Pitfall 7 (retry scope loss).
**Research flag:** Standard patterns — same template as `maven.ts`/`npm.ts`; pure TypeScript function. Skip research-phase.

### Phase 3: Change-Type-Aware Verification and Zero-Diff Detection

**Rationale:** Must be built before the first config-change task runs. Zero-diff detection must gate the verifier before build/test run on an empty diff. Config-only verification failure (Pitfall 3) is a high-recovery-cost incident — builds must be protected from it from day one.
**Delivers:** Post-run `git diff --name-only` inspection classifying changes as `config-only` or `code`; `zero_diff` terminal state with clear user message (no PR created); config-only path applies JSON/YAML syntax check only; code-change path runs full composite verifier unchanged.
**Addresses:** Zero-diff detection (table stakes), change-type-aware verification (table stakes).
**Avoids:** Pitfall 3 (config change triggers pre-existing lint failures as retryable errors), Pitfall 6 (MCP mid-session verifier running irrelevant build systems — partially mitigated; full fix is in Phase 4).
**Research flag:** The MCP mid-session verifier `changedFiles` hint (Pitfall 6) is a design gap: how to pass file-extension hints through the MCP protocol boundary without a schema change is unresolved. Targeted investigation needed during this phase's planning.

### Phase 4: LLM Judge Calibration, Confirm Loop, and MCP Verifier Scope

**Rationale:** Judge prompt enrichment and confirm loop changes are independent of execution but must land before the integration test. The MCP mid-session verifier scope issue (Pitfall 6) belongs here as the full resolution to what Phase 3 partially addressed.
**Delivers:** Judge prompt updated with generic-task preamble (test updates for renamed/moved code are always in scope); confirm loop shows `taskCategory` label for generic tasks; scope warning printed for unbounded task language ("all", "every", "everywhere"); MCP verifier inspects `git diff` at call time to skip inapplicable build systems.
**Addresses:** Instruction enrichment / confirm display (differentiator), turn limit warning (differentiator), LLM Judge calibration for generic tasks.
**Avoids:** Pitfall 2 (Judge false-veto), Pitfall 5 (turn limit exhaustion on large-scope tasks), Pitfall 6 (MCP runs irrelevant build systems).
**Research flag:** Judge prompt changes are prompt engineering only — standard patterns. MCP verifier scope resolution depends on codebase-specific MCP protocol details; inspect `src/mcp/` during planning.

### Phase 5: End-to-End Integration, Security Hardening, and Quality Gate

**Rationale:** Integration test is the milestone quality gate and cannot run until Phases 1–4 are complete. Security hardening (PreToolUse block-list, `description` sanitization) belongs here as a ship-blocking requirement, not optional polish.
**Delivers:** Full pipeline integration test for both code-change and config-change generic tasks (NL input → intent parse → confirm → agent session → verifier → judge → result); PreToolUse block-list for `.github/workflows`, `.env`, `CODEOWNERS`; `description` field length limit and XML escaping; `zero_diff` as distinct session history state (separate from `failed`).
**Addresses:** LLM Judge routing verified (table stakes), security block-list, `zero_diff` as distinct state (P2).
**Avoids:** Security mistakes (generic scope enabling `.env` reads, workflow file modifications), silent false success from empty diffs not being tracked distinctly.
**Research flag:** Security patterns are well-documented (OWASP MCP Top 10 MCP02:2025). Standard patterns — skip research-phase.

### Phase Ordering Rationale

- Phase 1 first: Parser must produce `generic` before prompt builder can be tested end-to-end (though the builder can be unit-tested in isolation from Phase 1).
- Phase 2 before Phase 5: The prompt builder is the core output; the integration test validates it.
- Phase 3 before Phase 5: Change-type-aware verification must exist before the integration test validates it.
- Phase 4 can overlap with Phase 3: Judge prompt and confirm loop changes are independent of the verification strategy; can be built in parallel if resourcing allows.
- Phase 5 last: Quality gate for everything above.
- No phase touches `retry.ts`, `claude-code-session.ts`, `verifier.ts`, `judge.ts`, or `pr-creator.ts` structurally — only `judge.ts` receives a prompt-text update.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 3 (MCP verifier scope):** Passing `changedFiles` hints through the MCP protocol boundary without a schema change is the one genuine design gap in the research. Inspect `src/mcp/` during planning to determine whether a `changedFiles` param can be added to the existing `verify` tool schema or whether an alternative mechanism (e.g., reading `git diff` server-side at verify call time) is cleaner.

Phases with standard patterns (skip research-phase):
- **Phase 1:** API migration is covered by official Anthropic GA structured outputs docs at HIGH confidence; additive Zod schema extension is a well-understood pattern.
- **Phase 2:** `buildGenericPrompt()` follows the exact same template as `maven.ts` and `npm.ts`; the scope block structure and end-state assertion pattern are directly transferable.
- **Phase 4:** All changes are prompt engineering or display-only cosmetic changes; no new infrastructure.
- **Phase 5:** Integration test patterns are established in the existing test suite; security block-list patterns from OWASP MCP Top 10.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All packages verified against live npm registry and official Anthropic docs on 2026-03-23; no new packages required; GA structured outputs API confirmed with official docs |
| Features | HIGH (core), MEDIUM (edge cases) | Core patterns verified against Anthropic best practices docs and SWE-bench data; LLM Judge false-veto rate for generic tasks on this specific judge prompt is untested — probabilistic |
| Architecture | HIGH | First-party codebase analysis; all integration points directly verified in source; component boundaries, build order, and unchanged-layer scope are confirmed, not inferred |
| Pitfalls | HIGH | Derived from direct v2.1 codebase analysis + IEEE TSE 2025 LLM-as-judge research + OWASP MCP Top 10 2025; all critical pitfalls have specific file-level prevention strategies |

**Overall confidence:** HIGH

### Gaps to Address

- **LLM Judge false-veto rate for generic tasks:** Research documents the risk and the mitigation (judge prompt enrichment), but the actual false-veto rate against this codebase's specific judge prompt is unknown until tested with real generic task fixtures. Address during Phase 4 execution with fixture-based evaluation before shipping.
- **Turn limit calibration for generic tasks:** The 10-turn limit was calibrated for dependency updates. Whether it is adequate for typical generic tasks (method rename, single-module config change) is untested. Monitor during Phase 5 integration tests; adjust if needed.
- **MCP mid-session verifier `changedFiles` hint:** Pitfall 6 identifies that the MCP verifier runs Maven on TypeScript-only changes. The exact mechanism for passing file-extension hints through the MCP protocol boundary without a breaking schema change is unresolved. This is the only genuine design gap — resolve during Phase 3 planning by inspecting `src/mcp/` tool definitions.

---

## Sources

### Primary (HIGH confidence)
- [Anthropic Structured Outputs GA docs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) — `output_config.format`, no beta header, GA on Haiku 4.5+
- [Anthropic Models Overview](https://platform.claude.com/docs/en/about-claude/models/overview) — `claude-haiku-4-5-20251001` as current fastest; Haiku 3 retirement April 19, 2026
- [Anthropic Structured Outputs blog post](https://claude.com/blog/structured-outputs-on-the-claude-developer-platform) — GA announcement, `output_config.format` replaces `output_format`
- [OWASP MCP Top 10: MCP02:2025 — Privilege Escalation via Scope Creep](https://owasp.org/www-project-mcp-top-10/2025/MCP02-2025%E2%80%93Privilege-Escalation-via-Scope-Creep) — scope creep security patterns in agentic systems
- [On the Effectiveness of LLM-as-a-Judge for Code Evaluation (IEEE TSE 2025)](https://www.computer.org/csdl/journal/ts/2025/08/11071936/2851vlBjr9e) — Judge false positive/negative rates
- `src/prompts/index.ts`, `src/prompts/maven.ts`, `src/prompts/npm.ts` — end-state prompt pattern to follow
- `src/intent/types.ts`, `src/intent/llm-parser.ts`, `src/intent/fast-path.ts`, `src/intent/index.ts` — integration point verification
- `src/orchestrator/verifier.ts`, `src/orchestrator/judge.ts`, `src/orchestrator/retry.ts` — unchanged execution layer confirmation
- `src/agent/index.ts` — preVerify and version resolution guard confirmed sufficient for generic tasks
- `.planning/PROJECT.md` — "generic execution path preferred"; "no hardcoded task-type handlers per category"

### Secondary (MEDIUM confidence)
- [LLM-Driven Code Refactoring: Opportunities and Limitations (IDE 2025 @ ICSE)](https://conf.researchr.org/details/icse-2025/ide-2025-papers/12/LLM-Driven-Code-Refactoring-Opportunities-and-Limitations) — refactoring scope injection requirements; explicit scope+type needed to avoid over-engineering
- [SWE-bench Pro (arXiv 2509.16941)](https://arxiv.org/pdf/2509.16941) — change category reliability: logic bugs 43.2%, configuration 39.5%, multi-file 41%, single-file 42.3%
- [AMBIG-SWE: Interactive Agents to Overcome Ambiguity (ICLR 2026)](https://arxiv.org/html/2502.13069v1) — pre-confirm clarification strategies for underspecified instructions
- [Anthropic Engineering — Claude Code Best Practices](https://www.anthropic.com/engineering/claude-code-best-practices) — end-state prompting, scope control, CLAUDE.md patterns
- [Augment Code — 11 Prompting Techniques for Agents](https://www.augmentcode.com/blog/how-to-build-your-agent-11-prompting-techniques-for-better-ai-agents) — end-state vs step-by-step comparison; planning increases SWE-bench pass rate ~4%
- [How We Prevent AI Agent Drift (DEV Community 2025)](https://dev.to/singhdevhub/how-we-prevent-ai-agents-drift-code-slop-generation-2eb7) — Spotify composite verifier + LLM Judge diff-vs-prompt pattern; validates existing project architecture

### Tertiary (LOW confidence)
- [Your AI Agent Configs Are Probably Broken (DEV Community 2025)](https://dev.to/avifenesh/your-ai-agent-configs-are-probably-broken-and-you-dont-know-it-16n1) — config-only changes produce no build-system feedback signal; needs validation against this specific verifier implementation

---
*Research completed: 2026-03-23*
*Ready for roadmap: yes*
