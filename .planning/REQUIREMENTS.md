# Requirements: Background Coding Agent — v3.0 Program Automator

**Defined:** 2026-04-08
**Core Value:** The full verification loop must work — agent changes code, deterministic verifiers catch failures, LLM Judge catches scope creep, and only verified changes proceed.

**Milestone Goal:** Evolve the agent from a single-session chore automator into a program automator that drives arbitrary sweeping refactors ("find all X, transform to Y, verify Z") across an entire repository. New task types are added as declarative YAML recipes, not as new code phases.

## v3.0 Requirements

Requirements for this milestone. Each maps to exactly one roadmap phase. Derived from the success criteria in `.planning/milestones/v3.0-ROADMAP.md` and the research findings in `.planning/research/SUMMARY.md`.

### Discovery — Sweeping-Refactor Task Type

- [ ] **REFAC-01**: User can describe a sweeping refactor in natural language ("modernize all POJOs to records", "migrate all YAML image tags") and have it routed to the `sweeping-refactor` task type without an explicit type flag
- [ ] **REFAC-02**: A discovery pass produces a structured `targets.json` ledger of `{file, locator, kind}` entries persisted to the run's state directory
- [ ] **REFAC-03**: Discovery is read-only (cannot write or edit files) and deterministic (same repo + same recipe + same tool versions → byte-identical output)

### Orchestration — RefactorRun

- [ ] **REFAC-04**: User can start a `RefactorRun` that owns a long-lived worktree and branch persisting across multiple per-chunk sessions
- [ ] **REFAC-05**: A chunk failure marks the target `failed` with a reason and the run continues to the next pending target (non-aborting on single failures)
- [ ] **REFAC-06**: User can run `agent refactor resume <run-id>` to pick up exactly where the run left off, including after a process crash
- [ ] **REFAC-07**: Sweeping-refactor chunks honor a configurable per-task-type session envelope that may exceed the default 10-turn / 5-minute limits (bounded)

### Verification — Differential

- [ ] **REFAC-08**: Starting a refactor run captures a baseline record (build result, full test result set, lint warning counts by class)
- [ ] **REFAC-09**: After each chunk, the verifier fails the chunk if any previously-passing test now fails, a new lint class appears, or the build regresses against the baseline — even when the chunk's own diff looks fine
- [ ] **REFAC-10**: Recipes may declare invariants (e.g., "no new public API surface", "no dropped pre-existing tests") that the verifier enforces alongside the baseline comparison

### Context Bundle & Judge Scope

- [ ] **REFAC-11**: User can mount an external read-only context bundle at `/context/` inside the sandbox via `agent refactor start --context-bundle <path>`; the agent prompt references its availability and the bundle cannot be written by the agent
- [ ] **REFAC-12**: The LLM Judge prompt receives the recipe's transformation spec as the authoritative scope definition; diffs matching the spec are not vetoed as scope creep even when large
- [ ] **REFAC-13**: A run without a context bundle, and existing task types (generic, dep-update, investigation), behave identically to v2.4 (no regression)

### Recipes — Format & Runner

- [ ] **REFAC-14**: A recipe YAML validates against the v3.0 recipe schema (Appendix A); invalid recipes are rejected before run start with a clear, field-level error
- [ ] **REFAC-15**: The recipe runner supports all three transformation strategies — `deterministic`, `end-state-prompt`, `doc-grounded` — and routes each to the correct execution path
- [ ] **REFAC-16**: Three reference recipes ship with v3.0 and run end-to-end against fixture repos: one `deterministic` (YAML config bump), one `end-state-prompt` (mechanical code rewrite), one `doc-grounded` (breaking upgrade with migration guide in context bundle)
- [ ] **REFAC-17**: Recipe execution is reproducible — same repo + same recipe + same tool versions produces the same ledger outcome (modulo LLM non-determinism for prompt-driven chunks)
- [ ] **REFAC-18**: A new task type can be added by authoring a recipe file alone — no changes to runner, orchestrator, or intent parser

### Capability Toolbox

- [ ] **REFAC-19**: The capability toolbox MCP tools (`config_edit`, `ast_query`, `ast_rewrite`, `import_rewrite`, `rewrite_run`, `test_baseline`, `test_compare`, `doc_retrieve`) ship with unit and integration tests, and are exposed only to sweeping-refactor task types
- [ ] **REFAC-20**: Each capability tool is usable independently from recipes (callable from a generic session) — tools are general-purpose, not recipe-coupled
- [ ] **REFAC-21**: The three reference recipes in REFAC-16 together exercise every capability tool at least once

### Conversational Recipe Authoring

- [ ] **REFAC-22**: In the REPL and Slack, a user phrase matching a sweeping-refactor shape triggers a four-question interview (target marker, end state, success check, optional docs) that emits a recipe draft validating against the Phase 32 schema without manual edits
- [ ] **REFAC-23**: User sees a human-readable summary of the recipe (not raw YAML) before confirming; advanced users can `/edit recipe` to see and tweak the YAML
- [ ] **REFAC-24**: A confirmed recipe immediately starts a `RefactorRun`; user can monitor progress with `agent refactor status <run-id>` (done/failed/skipped/pending counts, last commit SHA)

## Future Requirements

Acknowledged but deferred — not in v3.0 scope.

### Parallelism

- **REFAC-F1**: Parallel chunk execution (`max_parallel > 1`) — requires worktree sharding and conflict resolution. Defer to v3.1.
- **REFAC-F2**: SQLite ledger backend (`better-sqlite3`) — required when multiple writers contend for the same ledger; v3.0 uses JSON + atomic-rename for serial execution.

### Multi-Repo

- **REFAC-F3**: Multi-repo fleet orchestration. v3.0 is one repo per run; wrap externally if needed.

### Language Rewrites

- **REFAC-F4**: Full language-to-language rewrites (Java → Kotlin). Different shape, needs equivalence-testing infrastructure. Defer to v4.

## Out of Scope

Explicitly excluded from v3.0. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Auto-merge PRs when CI passes | Removes human-in-the-loop trust model (PROJECT.md hard constraint) |
| One giant PR for the whole run | Unreviewable; mid-run rollback impossible |
| Automatic rollback on run failure | Discards completed-chunk progress |
| Cross-file sessions in one chunk | Violates per-chunk isolation; DAPLab failure pattern |
| Expanding recipe scope mid-run | Invalidates baseline snapshot |
| Live-environment verification (prod-shaped DBs, live services) | Defer; sandbox is air-gapped |
| Creative/subjective tasks ("make this nicer") | Not a sweeping refactor — different problem shape |
| Plugin registry for transformation strategies | Strategy-dispatch only (deterministic / end-state-prompt / doc-grounded); no fifth strategy or class hierarchy |
| LLM-generated discovery targets | Discovery must be deterministic; LLM may assist via `custom` discovery prompt but output is structurally validated |

## Traceability

Updated by the roadmapper. Each requirement maps to exactly one phase.

| Requirement | Phase | Status |
|-------------|-------|--------|
| REFAC-01 | Phase 28 | Pending |
| REFAC-02 | Phase 28 | Pending |
| REFAC-03 | Phase 28 | Pending |
| REFAC-04 | Phase 29 | Pending |
| REFAC-05 | Phase 29 | Pending |
| REFAC-06 | Phase 29 | Pending |
| REFAC-07 | Phase 29 | Pending |
| REFAC-08 | Phase 30 | Pending |
| REFAC-09 | Phase 30 | Pending |
| REFAC-10 | Phase 30 | Pending |
| REFAC-11 | Phase 31 | Pending |
| REFAC-12 | Phase 31 | Pending |
| REFAC-13 | Phase 31 | Pending |
| REFAC-14 | Phase 32 | Pending |
| REFAC-15 | Phase 32 | Pending |
| REFAC-16 | Phase 32 | Pending |
| REFAC-17 | Phase 32 | Pending |
| REFAC-18 | Phase 32 | Pending |
| REFAC-19 | Phase 33 | Pending |
| REFAC-20 | Phase 33 | Pending |
| REFAC-21 | Phase 33 | Pending |
| REFAC-22 | Phase 34 | Pending |
| REFAC-23 | Phase 34 | Pending |
| REFAC-24 | Phase 34 | Pending |

**Coverage:**
- v3.0 requirements: 24 total
- Mapped to phases: 24
- Unmapped: 0 ✓

---
*Requirements defined: 2026-04-08*
*Last updated: 2026-04-08 after initial v3.0 definition*
