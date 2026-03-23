# Feature Research

**Domain:** Generic code-change agent — arbitrary explicit instructions (config updates, refactors, method replacements)
**Researched:** 2026-03-23
**Confidence:** HIGH (core patterns verified against multiple sources), MEDIUM (edge cases and classifier behavior)

---

## Context

This milestone (v2.2) adds a **generic task type** to the existing background coding agent. Already built and not re-researched: REPL + one-shot CLI, LLM intent parser with fast-path regex, confirm-before-execute flow, Maven/npm dependency update handlers, composite verifier (build+test+lint), LLM Judge, retry loop, Docker isolation, MCP mid-session self-check, project registry, multi-turn sessions.

The research question: what does a generic task executor need to work reliably on explicit but diverse instructions?

---

## Feature Landscape

### Table Stakes (Users Expect These)

Features a generic code-change path must have. Their absence makes the platform feel unreliable for anything beyond dependency updates.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Pass user instruction as end-state prompt to agent | User's words are the spec — no translation loss; any LLM intermediate rewrite is a source of error | LOW | Already the established project pattern. Dep-update handlers translate natural language into dep+version; generic path just passes instruction through. Adding this is a routing change, not new infrastructure. |
| Intent parser recognizes generic instructions | Parser currently produces `maven-dependency-update` or `npm-dependency-update`. Everything else must land somewhere, not crash | LOW | Add `generic` as a valid intent type output. Fast-path regex still runs first; if no dep-update pattern is detected, LLM classifier fires with `generic` as an allowed classification. |
| LLM Judge fires on generic tasks | Scope creep is more likely on vague instructions than on typed dep updates. Users expect the safety net to still apply | LOW | Judge is already generic — it compares final diff against original prompt. No new judge logic needed; generic tasks must route through the same judge path. Verify by test. |
| Retry loop handles generic failure context | When agent produces a broken change, it must see the error and the diff together | LOW | RetryOrchestrator already supports this. Generic tasks use the same retry path. No new code. |
| End-to-end autonomous execution after confirm | "No user input after task confirmation until PR" is the milestone contract. Generic path must not introduce interactive mid-run steps | LOW | Architecture already enforces this. Risk: agent making ambiguous decisions mid-run and pausing. Prevention: system prompt must include explicit scope constraint and decision-making guidance. |
| Graceful handling of zero-diff outcome | Agent searches, finds no applicable change site, makes no changes. Without handling, this produces an empty PR or silent success that confused users | MEDIUM | After agent run, check diff before handing to verifier. If diff is empty, surface as a distinct terminal state. Do not create a PR. This is the most common failure mode for generic tasks on well-specified but already-compliant codebases. |

### Differentiators (Competitive Advantage)

Features that make the generic path trustworthy rather than just functional. These are where reliability comes from, not functionality.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Change-type-aware verification | Config-only changes (JSON/YAML/properties) do not need a 2–3 minute build+test run. Skipping heavy verification for config-only changes reduces cycle time and avoids false failures (e.g., lint fails on unrelated issues) | MEDIUM | After agent run, inspect modified file extensions. If all changed files are config/data files (.json, .yaml, .yml, .properties, .toml, .env, .ini), run lint only. If any source file (.ts, .js, .java, .py, .go, .rb) changed, run full composite verifier. Already planned as part of v2.2 build-system detection work. |
| Scope constraint in generic task system prompt | Generic agents are known to sprawl into adjacent code. SWE-bench data shows this is the primary failure mode. A single explicit constraint ("touch only files directly relevant to the instruction, nothing else") reduces scope drift without requiring new infrastructure | LOW | Prompt engineering only. This is a critical correctness feature masquerading as a low-complexity one. Must be tested against real generic tasks, not just dep updates. |
| Zero-diff as explicit terminal state | Most agents silently succeed with empty output or produce hollow PRs. Treating zero-diff as a named failure state with a clear user message is a quality differentiator that competitors lack | LOW | Diff-size check before verifier. New `zero_diff` session state alongside existing `success`, `failed`, `vetoed`. User message: "Agent ran successfully but made no changes. Your instruction may already be satisfied, or the agent could not locate the relevant code." |
| Instruction enrichment via existing clarification flow | Context-first clarification already scans repo manifests and proposes a plan before confirm. For generic tasks, the plan shown to the user during confirmation is the scope contract that the Judge validates against. Making this visible and user-correctable before the run increases first-run success rate | MEDIUM | No new infrastructure. Key change: ensure the clarification prompt for generic tasks surfaces the agent's intended target files and approach, not just the raw instruction. The user's correction at confirm time updates the scope that the Judge uses. |

### Anti-Features (Commonly Requested, Often Problematic)

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Per-category task-type handlers (refactor-handler, config-handler, rename-handler, etc.) | Feels like it gives more control over specific scenarios | Combinatorial maintenance burden. Every new category requires a handler. Generic end-state prompting already works for localized changes per SWE-bench research. PROJECT.md explicitly rejects this. | Single generic execution path with good end-state prompting and scope constraints in system prompt |
| Agent asks user for clarification during the run | Catches ambiguity that the confirm step missed | Breaks the "no user input after confirm" invariant. Makes runs non-deterministic and hard to script. Introduce a blocking interactive state mid-Docker-run. | Shift all clarification to the pre-confirm stage. Context-first scan + clarification prompt already does this. If agent cannot determine the right action without a mid-run question, the task was underspecified at confirm time. |
| Step-by-step instructions injected into generic prompt | Teams want to guide the agent's approach | Research confirms end-state prompting outperforms step-by-step on capable models. Step-by-step causes the agent to follow steps mechanically even when a step is wrong, rather than using judgment. This is the established project decision (TASK-04). | End-state prompting: describe desired outcome, constraint, and what "done" looks like. Let the agent plan its own steps. |
| Multi-file migration as a generic task in v2.2 | Users will try "migrate all usages of X to Y across the codebase" | Exceeds reliable single-run scope. SWE-bench data shows multi-file changes have only ~41% pass rate vs ~40% for single-file, but the failures are harder to diagnose and retry. Context window pressure causes partial migrations that leave the codebase in a broken intermediate state. | Explicitly out of scope for v2.2. Document limit in the REPL. Tell users to split into single-file or single-module tasks. |
| Task discovery ("find places that need this change") | Discovery before application seems helpful | Changes the agent's contract from "apply this instruction" to "decide what needs changing." When scope is agent-defined, the LLM Judge cannot validate it — it has no ground truth to compare against. | Require explicit instruction: user specifies what to change and where. Task discovery is a separate analysis mode deferred to v2.3+. |
| Automatic instruction rewriting/strengthening before sending to agent | LLM pre-processes vague user instruction into a more specific prompt | Introduces a hidden translation layer. If the rewritten instruction is wrong, the user cannot see or correct it. Violates the "user's words are the spec" principle. | Show the agent's interpretation at confirm time (via clarification flow). If wrong, user corrects it explicitly before the run. |

---

## Feature Dependencies

```
Generic Intent Class (catch-all output from parser)
    └──requires──> LLM Intent Parser (already built)
                       └──requires──> REPL / one-shot CLI (already built)

Generic Task Executor
    └──requires──> Generic Intent Class
    └──requires──> End-state prompt construction (new: build prompt from user instruction + repo context)
    └──uses──>     ClaudeCodeSession / RetryOrchestrator (already built, no changes)

Zero-Diff Detection
    └──requires──> Post-run diff extraction (new, runs before outer verifier)
    └──blocks──>   Composite Verifier (verifier only runs if diff is non-empty)

Change-Type-Aware Verifier
    └──requires──> Build-system detection (already planned for v2.2)
    └──requires──> Post-run file list inspection (new, LOW complexity)
    └──uses──>     Composite Verifier (already built, selects subset)

LLM Judge on Generic Tasks
    └──requires──> Generic task routes through same pipeline as dep-update tasks
    └──uses──>     LLM Judge (already built, no changes)

Scope Constraint in System Prompt
    └──requires──> Generic Task Executor (where system prompt is constructed)
    └──enhances──> LLM Judge accuracy (tighter scope = more precise validation)
```

### Dependency Notes

- **Generic Intent Class is the critical path entry:** Everything else in v2.2 depends on having a valid `generic` intent output from the parser. Build this first.
- **Zero-diff detection must precede the verifier:** Running a 2–3 minute build on an empty diff is wasteful and produces misleading error messages. The zero-diff check is a pre-verifier gate.
- **Change-type-aware verifier requires build-system detection first:** Detection was already planned. File extension inspection is the consumer of that detection work.
- **Judge requires no changes:** It already operates on `{originalPrompt, diff}`. Generic tasks provide the same inputs. Verify this routes correctly in integration tests.
- **Scope constraint has no code dependencies:** It is prompt engineering applied during generic task executor construction. Low complexity, high impact on correctness.

---

## MVP Definition

### Launch With (v2.2)

Minimum for the generic task path to be trustworthy end-to-end.

- [ ] **Generic intent class** — Intent parser outputs `{taskType: 'generic', instruction: string}` for non-dep-update instructions. Fast-path regex still fires first. LLM classifier adds `generic` as a valid type. No translation of the instruction — pass through verbatim.
- [ ] **Generic task executor** — Builds agent prompt from `instruction` + repo context (manifest summary, language, build tool). System prompt includes explicit scope constraint: "touch only files directly relevant to the instruction." Routes through existing RetryOrchestrator and ClaudeCodeSession unchanged.
- [ ] **Zero-diff detection** — After agent run, inspect diff size before calling composite verifier. If diff is empty, record `zero_diff` terminal state, surface a clear message to user, do not create PR.
- [ ] **Change-type-aware verification** — Inspect changed file extensions post-run. All config/data files → lint only. Any source file → full composite verifier. Build-system detection feeds this decision.
- [ ] **LLM Judge routing verified** — Integration test confirms generic tasks hit the same judge path as dep-update tasks. No new judge code.

### Add After Validation (v2.2.x)

- [ ] **`zero_diff` as distinct session history state** — Record `zero_diff` separately from `failed` for observability. Trigger: want to distinguish "agent ran and found nothing to change" from "agent ran and produced broken output." Currently both would be `failed`.
- [ ] **Instruction enrichment hint at confirm step** — When intent is `generic`, clarification prompt shows the agent's planned target scope (files, approach) before user confirms. Trigger: generic tasks showing high wrong-scope rates in real usage.

### Future Consideration (v2.3+)

- [ ] **Multi-file migration support** — Needs a scoped planning phase before execution to prevent partial migrations. Requires proof-of-concept on complex real-world repos. Defer until generic path is stable.
- [ ] **Task discovery mode** — Separate analysis mode that does not produce code changes. Different agent session contract; requires new Judge evaluation strategy.
- [ ] **Custom verifier profiles per file type** — E.g., run only ESLint for JS-only changes. The change-type-aware verifier covers 80% of the value with less complexity.

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Generic intent class | HIGH | LOW | P1 |
| Generic task executor with scope constraint | HIGH | LOW | P1 |
| Zero-diff detection | HIGH | LOW | P1 |
| Change-type-aware verification | HIGH | MEDIUM | P1 |
| LLM Judge routing for generics | HIGH | LOW (verify only) | P1 |
| `zero_diff` as distinct session state | MEDIUM | LOW | P2 |
| Instruction enrichment at confirm step | MEDIUM | LOW | P2 |
| Multi-file migration | MEDIUM | HIGH | P3 |
| Task discovery mode | MEDIUM | HIGH | P3 |

**Priority key:**
- P1: Must have for v2.2 launch
- P2: Add after P1 validated in real usage
- P3: Future milestone

---

## Competitor Feature Analysis

| Feature | Claude Code / Copilot Agent Mode | Cline / Aider | Our Approach |
|---------|----------------------------------|---------------|--------------|
| Generic instruction handling | Yes — full IDE context, user approves each file change | Yes — interactive, user approves per-file diffs | Autonomous post-confirm; no mid-run interaction; Docker-isolated |
| Verification | Build errors fed back in loop; no independent verifier | Compile/lint errors fed back; no LLM Judge | Three-layer: deterministic verifier + LLM Judge + retry loop |
| Scope control | Relies on user to review each change | User approves each change; agent can still sprawl | LLM Judge blocks scope-creep PRs; scope constraint in system prompt |
| Config-only detection | Not differentiated | Not differentiated | Skip build+test for config-only changes |
| Zero-diff handling | Varies; can produce empty commits | User notices; no system-level detection | Explicit `zero_diff` terminal state before verifier runs |
| Human-in-the-loop | Approves each file change during run | Approves each file change during run | Single confirmation before run; full automation after |

---

## Sources

- [LLM-Driven Code Refactoring: Opportunities and Limitations (2025 IDE Workshop)](https://seal-queensu.github.io/publications/pdf/IDE-Jonathan-2025.pdf) — HIGH confidence; LLMs reliable on localized refactors, unreliable on architectural/multi-module. Config 39.5% pass rate on SWE-bench-style tasks.
- [SWE-bench Pro (arXiv 2509.16941)](https://arxiv.org/pdf/2509.16941) — MEDIUM confidence; change category reliability: logic bugs 43.2%, API misuse 40.8%, configuration 39.5%, multi-file 41%, single-file 42.3%.
- [AMBIG-SWE: Interactive Agents to Overcome Ambiguity in Software Engineering (ICLR 2026)](https://arxiv.org/html/2502.13069v1) — MEDIUM confidence; agent clarification strategies for underspecified instructions.
- [Anthropic Engineering — Claude Code Best Practices](https://www.anthropic.com/engineering/claude-code-best-practices) — HIGH confidence; end-state prompting, scope control, CLAUDE.md patterns.
- [How We Prevent AI Agent Drift — DEV Community](https://dev.to/singhdevhub/how-we-prevent-ai-agents-drift-code-slop-generation-2eb7) — MEDIUM confidence; practical scope-limiting strategies for production agents.
- [Augment Code — 11 Prompting Techniques for Agents](https://www.augmentcode.com/blog/how-to-build-your-agent-11-prompting-techniques-for-better-ai-agents) — MEDIUM confidence; end-state vs step-by-step comparison; planning increases SWE-bench pass rate 4%.
- [The Agent That Says No: Verification Beats Generation (Vadim's blog)](https://vadim.blog/verification-gate-research-to-practice) — MEDIUM confidence; Google DORA 2025 correlation: more generation without better verification is net negative.
- [Tweag — Introduction to Agentic Coding](https://www.tweag.io/blog/2025-10-23-agentic-coding-intro/) — MEDIUM confidence; plan specificity: "what will change, where it will change, how success will be verified."
- [LLM as a Judge — Maxim](https://www.getmaxim.ai/articles/llm-as-a-judge-a-practical-reliable-path-to-evaluating-ai-systems-at-scale/) — MEDIUM confidence; LLM Judge for intent drift detection patterns.
- [Spotify Background Coding Agent (referenced in search results)](https://dev.to/singhdevhub/how-we-prevent-ai-agents-drift-code-slop-generation-2eb7) — HIGH confidence; confirms composite verifier + LLM Judge diff-vs-prompt pattern; validates existing project architecture.

---

*Feature research for: generic code-change agent (background-coding-agent v2.2)*
*Researched: 2026-03-23*
