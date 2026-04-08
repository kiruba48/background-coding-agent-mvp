# Roadmap: Background Coding Agent

## Milestones

- ✅ **v1.0 Foundation** — Phases 1-6 (shipped 2026-03-02)
- ✅ **v1.1 End-to-End Pipeline** — Phases 7-9 (shipped 2026-03-11)
- ✅ **v2.0 Claude Agent SDK Migration** — Phases 10-13 (shipped 2026-03-19)
- ✅ **v2.1 Conversational Mode** — Phases 14-17 (shipped 2026-03-22)
- ✅ **v2.2 Deterministic Task Support** — Phases 18-20 (shipped 2026-03-25)
- ✅ **v2.3 Conversational Scoping & REPL Enhancements** — Phases 21-24 (shipped 2026-04-05)
- ✅ **v2.4 Git Worktree & Repo Exploration** — Phases 25-27 (shipped 2026-04-07)
- 🚧 **v3.0 Program Automator** — Phases 28-34 (in progress)

## Phases

<details>
<summary>✅ v1.0 Foundation (Phases 1-6) — SHIPPED 2026-03-02</summary>

- [x] Phase 1: Foundation & Security (4/4 plans) — completed 2026-01-27
- [x] Phase 2: CLI & Orchestration (3/3 plans) — completed 2026-02-06
- [x] Phase 3: Agent Tool Access (2/2 plans) — completed 2026-02-12
- [x] Phase 4: Retry & Context Engineering (2/2 plans) — completed 2026-02-17
- [x] Phase 5: Deterministic Verification (2/2 plans) — completed 2026-02-18
- [x] Phase 6: LLM Judge Integration (2/2 plans) — completed 2026-02-28

Full details: [v1.0-ROADMAP.md](milestones/v1.0-ROADMAP.md)

</details>

<details>
<summary>✅ v1.1 End-to-End Pipeline (Phases 7-9) — SHIPPED 2026-03-11</summary>

- [x] Phase 7: GitHub PR Creation (2/2 plans) — completed 2026-03-02
- [x] Phase 8: Maven Dependency Update (3/3 plans) — completed 2026-03-05
- [x] Phase 9: npm Dependency Update (3/3 plans) — completed 2026-03-11

Full details: [v1.1-ROADMAP.md](milestones/v1.1-ROADMAP.md)

</details>

<details>
<summary>✅ v2.0 Claude Agent SDK Migration (Phases 10-13) — SHIPPED 2026-03-19</summary>

- [x] Phase 10: Agent SDK Integration (2/2 plans) — completed 2026-03-17
- [x] Phase 11: Legacy Deletion (2/2 plans) — completed 2026-03-18
- [x] Phase 12: MCP Verifier Server (2/2 plans) — completed 2026-03-18
- [x] Phase 13: Container Strategy (2/2 plans) — completed 2026-03-19

Full details: [v2.0-ROADMAP.md](milestones/v2.0-ROADMAP.md)

</details>

<details>
<summary>✅ v2.1 Conversational Mode (Phases 14-17) — SHIPPED 2026-03-22</summary>

- [x] Phase 14: Infrastructure Foundation (3/3 plans) — completed 2026-03-19
- [x] Phase 15: Intent Parser + One-Shot Mode (3/3 plans) — completed 2026-03-20
- [x] Phase 16: Interactive REPL (2/2 plans) — completed 2026-03-20
- [x] Phase 17: Multi-Turn Session Context (2/2 plans) — completed 2026-03-22

Full details: [v2.1-ROADMAP.md](milestones/v2.1-ROADMAP.md)

</details>

<details>
<summary>✅ v2.2 Deterministic Task Support (Phases 18-20) — SHIPPED 2026-03-25</summary>

- [x] Phase 18: Intent Parser Generalization (2/2 plans) — completed 2026-03-23
- [x] Phase 19: Generic Prompt Builder (2/2 plans) — completed 2026-03-24
- [x] Phase 20: Verification & Safety (2/2 plans) — completed 2026-03-24

Full details: [v2.2-ROADMAP.md](milestones/v2.2-ROADMAP.md)

</details>

<details>
<summary>✅ v2.3 Conversational Scoping & REPL Enhancements (Phases 21-24) — SHIPPED 2026-04-05</summary>

- [x] Phase 21: Post-Hoc PR & State Foundation (2/2 plans) — completed 2026-03-26
- [x] Phase 22: Conversational Scoping Dialogue (2/2 plans) — completed 2026-03-26
- [x] Phase 23: Follow-Up Task Referencing (1/1 plan) — completed 2026-04-01
- [x] Phase 24: Slack Bot Adapter (2/2 plans) — completed 2026-04-05

Full details: [v2.3-ROADMAP.md](milestones/v2.3-ROADMAP.md)

</details>

<details>
<summary>✅ v2.4 Git Worktree & Repo Exploration (Phases 25-27) — SHIPPED 2026-04-07</summary>

- [x] Phase 25: Tech Debt Cleanup (2/2 plans) — completed 2026-04-05
- [x] Phase 26: Git Worktree Isolation (2/2 plans) — completed 2026-04-05
- [x] Phase 27: Repo Exploration Tasks (3/3 plans) — completed 2026-04-06

Full details: [v2.4-ROADMAP.md](milestones/v2.4-ROADMAP.md)

</details>

### v3.0 Program Automator (In Progress)

**Milestone Goal:** Evolve the agent from a single-session chore automator into a program automator that can drive arbitrary **sweeping refactors** — any task shaped as "find all occurrences of X, transform to Y, verify Z" — across an entire repository. New task types must be addable as declarative recipes, not as new code phases.

**The shift in one sentence:** Stop treating a session as the unit of work. Make a **RefactorRun** the unit of work, and let sessions become replaceable workers against a persistent ledger, driven by a declarative recipe.

**What unlocks:**
- Language modernization (e.g., Java value types → records)
- Breaking upgrades with migration guides (e.g., Scio version bumps)
- UI component migrations (e.g., Backstage frontend swap)
- Schema-aware config edits (e.g., YAML/JSON fleet bumps)
- ...and any future task with the same shape — no new phase required.

**What explicitly does NOT ship in v3.0:**
- Full language-to-language rewrites (Java → Kotlin). Different shape, needs equivalence-testing infra. Defer to v4.
- Multi-repo fleet orchestration. One repo per run; wrap externally if needed.
- Live-environment verification (prod-shaped DBs, live services). Defer.
- Creative/subjective tasks (visual polish, "make this nicer"). Not a sweeping refactor.

- [ ] **Phase 28: Sweeping-Refactor Task Type + Discovery Pass** — New intent category, read-only discovery pass producing a typed `targets.json` ledger
- [ ] **Phase 29: RefactorRun Orchestrator** — Multi-session state, long-lived shared worktree/branch, per-chunk worker loop, crash recovery
- [ ] **Phase 30: Differential Verification** — Baseline snapshot at run start (dual-capture flaky detection); verify each chunk against baseline instead of absolute green
- [ ] **Phase 31: Context Bundle Mount + Judge Scope Injection** — Read-only `/context/` mount; judge reads recipe spec as authoritative scope definition
- [ ] **Phase 32: Recipe Format + Recipe Runner** — Declarative YAML recipe schema with Zod strict validation; generic runner executing any recipe across three strategies
- [ ] **Phase 33: Capability Toolbox** — Task-agnostic MCP tools: `config_edit`, `ast_query`/`ast_rewrite`, `import_rewrite`, `rewrite_run`, `test_baseline`/`test_compare`, `doc_retrieve` (Alpine + WASM tree-sitter)
- [ ] **Phase 34: Conversational Recipe Authoring** — Extend Phase 22 scoping dialogue to emit recipe drafts from a four-question interview

Full details: [v3.0-ROADMAP.md](milestones/v3.0-ROADMAP.md)

## Phase Details

### Phase 28: Sweeping-Refactor Task Type + Discovery Pass
**Goal**: The agent accepts a new `sweeping-refactor` task type and, given a target description, produces a structured target list (`targets.json` of `{file, locator, kind}` entries) as a read-only first step — no edits, no PR.
**Depends on**: Phase 27 (reuses investigation-mode plumbing for read-only execution)
**Requirements**: REFAC-01, REFAC-02, REFAC-03
**Success Criteria** (what must be TRUE):
  1. The intent parser routes phrases like "modernize all POJOs to records" or "migrate YAML image tags" to the `sweeping-refactor` task type without a type flag
  2. Running discovery on a repo writes a `targets.json` to the state store containing an array of `{file, locator, kind}` entries
  3. A discovery pass cannot write or edit files — enforced by the existing PreToolUse Write/Edit block from Phase 27
  4. Discovery output is deterministic given the same repo, recipe discovery block, and tool versions — verified by running discovery twice and diffing output byte-for-byte
**Plans**: 2 plans

Plans:
- [ ] 28-01-PLAN.md — Intent parser `sweeping-refactor` category, fast-path verbs, LLM parser extension
- [ ] 28-02-PLAN.md — Discovery prompt builder, structured `targets.json` output, state store persistence

### Phase 29: RefactorRun Orchestrator
**Goal**: A `RefactorRun` entity persists across sessions — it owns a long-lived worktree and branch, a target ledger (pending/in-progress/done/failed/skipped), and drives per-chunk sessions until the ledger is exhausted.
**Depends on**: Phase 28 (consumes `targets.json` and `RefactorRun` data types)
**Requirements**: REFAC-04, REFAC-05, REFAC-06, REFAC-07
**Success Criteria** (what must be TRUE):
  1. Starting a refactor run creates one worktree and one branch that persists across multiple sessions — `WorktreeManager` gains a `worktree_kind: persistent` sentinel and the orphan scan skips persistent entries entirely
  2. The orchestrator pops the next pending target, spawns a scoped session for that chunk, and on success commits then marks the target `done` in the JSON ledger (commit-then-ledger ordering invariant — never write ledger before git commit completes)
  3. A chunk failure marks the target `failed` with a reason and continues to the next pending target — the run does not abort on a single failure
  4. `agent refactor resume <run-id>` picks up exactly where the run left off, including after a process crash (`kill -9` recovery test is an explicit success criterion)
  5. Per-task-type session envelope config is honored: a sweeping-refactor chunk can exceed the default 10-turn/5-minute limits (configurable, bounded)
**Plans**: 3 plans

Plans:
- [ ] 29-01-PLAN.md — `RefactorRun` data model, JSON state store with `write-file-atomic` writes to `.bg-agent-runs/<runId>/`, `WorktreeManager` reuse path with `worktree_kind` sentinel
- [ ] 29-02-PLAN.md — Worker loop: pop → spawn session → commit → mark ledger → repeat; `agent refactor start/status` CLI subcommands
- [ ] 29-03-PLAN.md — `agent refactor resume`, crash recovery, `kill -9` recovery test, per-task-type envelope config

### Phase 30: Differential Verification
**Goal**: Instead of requiring an absolute green build/test/lint result, the composite verifier compares against a **baseline snapshot** captured at run start — "same tests pass, no new lint classes, build still green" — so long-running refactors can't silently regress chunks they already finished.
**Depends on**: Phase 29 (baseline lives on the `RefactorRun`)
**Requirements**: REFAC-08, REFAC-09, REFAC-10
**Note**: Phases 30 and 31 are parallelizable — they share no source files.
**Success Criteria** (what must be TRUE):
  1. Starting a refactor run captures a baseline record using a dual-capture protocol: the test suite runs twice at baseline time; tests that differ between runs are flagged `known_flaky` and excluded from differential comparison (a warning is emitted if >5% of tests are flaky)
  2. After each chunk, the composite verifier fails the chunk if any previously-passing test now fails, if a new lint class appears, or if the build regresses — even when the chunk's own edits look fine in isolation
  3. Recipes may declare invariants (e.g., "no new public API surface") that the verifier enforces alongside the baseline comparison
  4. A chunk is allowed to add new tests; dropping a pre-existing test is blocked unless the recipe explicitly permits it via `allow_dropped_tests: true`
**Plans**: 2 plans

Plans:
- [ ] 30-01-PLAN.md — Baseline capture at run start with dual-capture flaky-test detection, baseline storage on `RefactorRun`
- [ ] 30-02-PLAN.md — `DifferentialVerifier` (higher-order function wrapping `compositeVerifier`, does not modify its signature), invariant check hooks, `TestResult[]` structured output

### Phase 31: Context Bundle Mount + Judge Scope Injection
**Goal**: The sandbox can mount an external read-only `/context/` directory (migration guides, API maps, schemas) that the agent is told about, and the LLM Judge receives the recipe's scope definition as the authoritative "what is in scope" signal — stopping it from vetoing legitimate mechanical changes.
**Depends on**: Phase 29
**Note**: Phases 30 and 31 are parallelizable — they share no source files.
**Requirements**: REFAC-11, REFAC-12, REFAC-13
**Success Criteria** (what must be TRUE):
  1. `agent refactor start --context-bundle ./guide/` mounts the bundle at `/context/` with `:ro` inside the sandbox; the agent prompt references its availability
  2. The context bundle cannot be written by the agent — enforced at Docker mount level and PreToolUse hook level (defence in depth)
  3. The LLM Judge prompt includes the recipe's `transformation.spec` as the scope definition; a 400-line mechanical diff matching the spec must NOT be vetoed — this is an explicit regression test success criterion
  4. A run without a context bundle, and all existing task types (generic, dep-update, investigation), behave identically to v2.4 (no regression)
**Plans**: 2 plans

Plans:
- [ ] 31-01-PLAN.md — ContainerManager context-bundle mount, PreToolUse hook coverage, agent prompt plumbing
- [ ] 31-02-PLAN.md — Judge prompt extension: `recipeSpec` param with inverted framing ("does diff match spec?"), vetoed-diff regression test suite; bypass judge entirely for `deterministic` strategy

### Phase 32: Recipe Format + Recipe Runner
**Goal**: A refactor run is fully specified by a declarative YAML recipe with four slots — discovery, transformation, verification, context. A generic runner reads the recipe and executes it using the infrastructure from Phases 28-31. **Adding a new task type is writing a recipe, not writing code.**
**Depends on**: Phases 28, 29, 30, 31
**Requirements**: REFAC-14, REFAC-15, REFAC-16, REFAC-17, REFAC-18
**Success Criteria** (what must be TRUE):
  1. A recipe YAML validates against the v3.0 recipe schema (see Appendix A in `milestones/v3.0-ROADMAP.md`); the Zod schema uses `strict()` on the top-level object — any unknown key is a validation error with a clear, field-level error message
  2. The runner supports all three transformation strategies — `deterministic`, `end-state-prompt`, `doc-grounded` — and routes each to the correct execution path
  3. Three reference recipes ship with v3.0 and run end-to-end against fixture repos: one `deterministic` (YAML config bump), one `end-state-prompt` (mechanical code rewrite), one `doc-grounded` (breaking upgrade with migration guide in context bundle)
  4. Recipe execution is reproducible: same repo + same recipe + same tool versions produces the same ledger outcome (modulo LLM non-determinism for prompt-driven chunks)
  5. A new task type can be added by authoring a recipe file alone — no changes to the runner, orchestrator, or intent parser
**Plans**: 3 plans

Plans:
- [ ] 32-01-PLAN.md — Recipe schema definition (Zod `strict()`), YAML loader, validator, field-level error reporting
- [ ] 32-02-PLAN.md — Recipe runner: slot execution (discovery → transform → verify), three-strategy dispatch
- [ ] 32-03-PLAN.md — Three reference recipes (YAML config bump, code rewrite, doc-grounded upgrade) + fixture repos

### Phase 33: Capability Toolbox
**Goal**: A small, **task-agnostic** set of reusable MCP tools that recipes call as primitives. Each is broadly useful across many recipes; adding a new tool is a small PR, not a roadmap phase.
**Depends on**: Phase 32 (recipes reference tools by name; tools validated in context before adding more)
**Requirements**: REFAC-19, REFAC-20, REFAC-21
**Note**: Keep Alpine as the Docker base image. Use `web-tree-sitter` WASM path (not native `tree-sitter` bindings) — confirmed Alpine-safe; ABI smoke test required. Use `yaml@2.x` `parseDocument()` for `config_edit` (not `js-yaml`). Pre-seed Maven cache at image build time; enforce `-o` offline flag at runtime.
**Success Criteria** (what must be TRUE):
  1. The following MCP tools exist, are exposed only to sweeping-refactor task types, and have unit + integration tests:
     - `config_edit` — roundtrip-safe YAML/JSON edits preserving comments and formatting (uses `yaml@2.x`)
     - `ast_query` / `ast_rewrite` — `web-tree-sitter` WASM-backed structural search and edit; image build includes smoke test parsing a fixture Java file and asserting non-null result
     - `import_rewrite` — rename/replace imports and symbols across a language's module system
     - `rewrite_run` — invoke a pre-registered OpenRewrite / jscodeshift / semgrep recipe by id (all three pass offline smoke tests with no external TCP connections)
     - `test_baseline` / `test_compare` — capture and diff test result sets for differential verification
     - `doc_retrieve` — BM25 lookup over the mounted context bundle (index stored in `RefactorRun` state directory, not inside the `:ro` bundle mount; >0 results pre-flight check before first chunk)
  2. Each tool is usable independently from recipes (can be called from a generic session) — tools are general-purpose, not recipe-coupled
  3. The three reference recipes from Phase 32 together exercise every tool at least once
**Plans**: 3 plans

Plans:
- [ ] 33-01-PLAN.md — `config_edit` (`yaml@2.x` `parseDocument()`, comment preservation unit test) and `doc_retrieve` (BM25 via `wink-bm25-text-search`, in-state-dir index)
- [ ] 33-02-PLAN.md — `ast_query` / `ast_rewrite` (`web-tree-sitter` + `tree-sitter-wasms@0.1.13`, ABI smoke test), `import_rewrite`
- [ ] 33-03-PLAN.md — `rewrite_run` (OpenRewrite offline Maven cache pre-seeded in Dockerfile, jscodeshift global install, semgrep with `--metrics=off`), `test_baseline` / `test_compare`

### Phase 34: Conversational Recipe Authoring
**Goal**: Users don't hand-write YAML. When the scoping dialogue detects a sweeping-refactor shape, it asks four questions — *what marks a target site, what should it become, how do we know it still works, any docs I should read?* — and emits a recipe draft the user confirms in REPL or Slack.
**Depends on**: Phase 32 (emits valid recipes against stable schema), Phase 22 (scoping dialogue integration point)
**Requirements**: REFAC-22, REFAC-23, REFAC-24
**Note**: A confirmed recipe must return >0 targets from a discovery dry-run before the full run starts; a recipe producing zero targets is an explicit failure (almost always a query bug).
**Success Criteria** (what must be TRUE):
  1. In the REPL and in Slack, a user phrase matching a sweeping-refactor shape triggers the four-question interview instead of the normal scoping dialogue
  2. The interview produces a recipe that validates against the Phase 32 schema without manual edits
  3. The user sees a human-readable summary of the recipe (not raw YAML) before confirming; advanced users can `/edit recipe` to see and tweak the YAML
  4. A confirmed recipe runs a discovery dry-run; if zero targets are found the user is warned and the run does not start; if targets are found, a `RefactorRun` starts immediately and the user can monitor with `agent refactor status <run-id>`
**Plans**: 2 plans

Plans:
- [ ] 34-01-PLAN.md — Four-question interview logic (`RecipeInterviewDialogue`), `RecipeDraft` emission, human-readable summary, `/edit recipe` path
- [ ] 34-02-PLAN.md — REPL + Slack wiring, `agent refactor status` command, dry-run gate (zero-target guard)

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Foundation & Security | v1.0 | 4/4 | Complete | 2026-01-27 |
| 2. CLI & Orchestration | v1.0 | 3/3 | Complete | 2026-02-06 |
| 3. Agent Tool Access | v1.0 | 2/2 | Complete | 2026-02-12 |
| 4. Retry & Context Engineering | v1.0 | 2/2 | Complete | 2026-02-17 |
| 5. Deterministic Verification | v1.0 | 2/2 | Complete | 2026-02-18 |
| 6. LLM Judge Integration | v1.0 | 2/2 | Complete | 2026-02-28 |
| 7. GitHub PR Creation | v1.1 | 2/2 | Complete | 2026-03-02 |
| 8. Maven Dependency Update | v1.1 | 3/3 | Complete | 2026-03-05 |
| 9. npm Dependency Update | v1.1 | 3/3 | Complete | 2026-03-11 |
| 10. Agent SDK Integration | v2.0 | 2/2 | Complete | 2026-03-17 |
| 11. Legacy Deletion | v2.0 | 2/2 | Complete | 2026-03-18 |
| 12. MCP Verifier Server | v2.0 | 2/2 | Complete | 2026-03-18 |
| 13. Container Strategy | v2.0 | 2/2 | Complete | 2026-03-19 |
| 14. Infrastructure Foundation | v2.1 | 3/3 | Complete | 2026-03-19 |
| 15. Intent Parser + One-Shot Mode | v2.1 | 3/3 | Complete | 2026-03-20 |
| 16. Interactive REPL | v2.1 | 2/2 | Complete | 2026-03-20 |
| 17. Multi-Turn Session Context | v2.1 | 2/2 | Complete | 2026-03-22 |
| 18. Intent Parser Generalization | v2.2 | 2/2 | Complete | 2026-03-23 |
| 19. Generic Prompt Builder | v2.2 | 2/2 | Complete | 2026-03-24 |
| 20. Verification & Safety | v2.2 | 2/2 | Complete | 2026-03-24 |
| 21. Post-Hoc PR & State Foundation | v2.3 | 2/2 | Complete | 2026-03-26 |
| 22. Conversational Scoping Dialogue | v2.3 | 2/2 | Complete | 2026-03-26 |
| 23. Follow-Up Task Referencing | v2.3 | 1/1 | Complete | 2026-04-01 |
| 24. Slack Bot Adapter | v2.3 | 2/2 | Complete | 2026-04-05 |
| 25. Tech Debt Cleanup | v2.4 | 2/2 | Complete | 2026-04-05 |
| 26. Git Worktree Isolation | v2.4 | 2/2 | Complete | 2026-04-05 |
| 27. Repo Exploration Tasks | v2.4 | 3/3 | Complete | 2026-04-06 |
| 28. Sweeping-Refactor Task Type + Discovery | v3.0 | 0/2 | Not started | — |
| 29. RefactorRun Orchestrator | v3.0 | 0/3 | Not started | — |
| 30. Differential Verification | v3.0 | 0/2 | Not started | — |
| 31. Context Bundle Mount + Judge Scope | v3.0 | 0/2 | Not started | — |
| 32. Recipe Format + Recipe Runner | v3.0 | 0/3 | Not started | — |
| 33. Capability Toolbox | v3.0 | 0/3 | Not started | — |
| 34. Conversational Recipe Authoring | v3.0 | 0/2 | Not started | — |
