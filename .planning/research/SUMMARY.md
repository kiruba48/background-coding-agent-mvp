# Project Research Summary

**Project:** Background Coding Agent — v3.0 Program Automator
**Domain:** Automated sweeping-refactor / mass-migration capability added to an existing multi-session background coding agent
**Researched:** 2026-04-08
**Confidence:** HIGH (all four research files are based on direct source code analysis, official library docs, and first-party issue trackers)

---

## Executive Summary

v3.0 evolves the background coding agent from a single-session chore automator into a program automator. The architectural shift is precise: stop treating a Claude Agent SDK session as the unit of work and make a `RefactorRun` the unit of work. Sessions become replaceable, scoped workers that pop a target from a persistent ledger, transform one file or one target group, commit to a long-lived branch, and mark the ledger entry done or failed before exiting. The `RefactorRun` survives process crashes, resumes from where it left off, and drives any recipe by reading a declarative YAML spec — not new code. The closest analogues are OpenRewrite (Java LST-backed transforms), Sourcegraph Batch Changes (declarative multi-repo specs), and jscodeshift (JS/TS AST codemods). v3.0 goes beyond all three by supporting LLM-backed transformation, a read-only doc-grounded context bundle, and conversational recipe authoring.

The recommended implementation path follows the natural data dependency chain: Phase 28 (discovery infrastructure) feeds Phase 29 (RefactorRun orchestrator with persistent ledger), which unlocks Phase 30 (differential verification) and Phase 31 (context bundle + judge scope injection) in parallel, which together enable Phase 32 (recipe format and runner), which is exercised and extended by Phase 33 (capability toolbox) and finally Phase 34 (conversational recipe authoring). Every v3.0 feature is additive — the seven new phases modify or extend existing components rather than replacing them, and the existing generic/dep-update/investigation task paths are entirely untouched.

The critical risks fall into three categories. First, state integrity: the RefactorRun ledger and git worktree must stay in sync across process crashes via a commit-then-ledger ordering invariant and atomic JSON writes. Second, verification correctness: the existing composite verifier was designed for absolute-green baselines; v3.0 requires differential comparison against a captured baseline, with flaky-test awareness (dual-capture protocol) and judge scope injection (recipe spec as authoritative scope definition, not diff size). Third, toolchain isolation: tree-sitter native bindings fail on Alpine musl — the WASM path (`web-tree-sitter` + `tree-sitter-wasms`) is the confirmed resolution; OpenRewrite and semgrep must be pre-seeded in the Docker image with offline-mode enforcement or they will hang on the iptables network barrier.

---

## Conflict Resolutions

Two explicit conflicts were identified between the research files. Both are resolved here. Plans must use these decisions and must not reopen them.

### Conflict 1: Ledger Storage — `better-sqlite3` vs JSON + Atomic Rename

**Decision: JSON + atomic rename for v3.0. `better-sqlite3` deferred to v3.1+ if `max_parallel > 1` ships.**

ARCHITECTURE.md makes the stronger argument for the current scope. The RefactorRun orchestrator is single-process and serial (`max_parallel: 1` enforced in v3.0). SQLite's transaction isolation provides no benefit over atomic JSON writes when there is only one writer. `better-sqlite3` requires a native addon compiled separately for macOS/glibc (host developer machine) and Alpine/musl (Docker image) — a two-platform build burden that the multi-stage Dockerfile handles but complicates the development loop. The `conf@15` pattern and `write-file-atomic` (both already in the project) provide all the crash-safety needed for single-process serial writes.

STACK.md's case for SQLite (crash safety, atomic chunk updates, query by status) is technically sound but premature for v3.0. For a 500-target run with serial execution, scanning a 500-entry JSON array for pending targets is negligible (< 1ms). SQL queries over 500 rows add no measurable benefit.

The correct trigger for SQLite is v3.1 parallel execution, where multiple writers contend for the same ledger and transaction isolation becomes essential. At that point, `better-sqlite3@12.8.0` with WAL mode is the right choice. The JSON ledger schema maps directly to the SQL schema STACK.md proposes, making the migration mechanical.

**Implication for Phase 29:** Use `RefactorStateStore` with `write-file-atomic` writes to `.bg-agent-runs/<runId>/state.json` and `targets.json`. Do not add `better-sqlite3` to package.json.

### Conflict 2: Docker Base Image for Phase 33 — Alpine vs Debian-slim

**Decision: Alpine remains correct. The WASM path resolves the conflict. Other Phase 33 tools are independently Alpine-safe.**

PITFALLS.md's Debian-slim recommendation applies specifically to the native `tree-sitter` Node.js bindings, which are glibc-linked and fail on Alpine musl. STACK.md's chosen path (`web-tree-sitter` + `tree-sitter-wasms`) is pure WASM — no native compilation, no glibc/musl distinction. These two recommendations do not conflict; they address different implementation paths. Since the WASM path is selected, the Debian-slim recommendation is moot for tree-sitter.

Evaluating remaining Phase 33 tools against Alpine:

| Tool | Alpine-safe? | Reason |
|------|-------------|--------|
| `config_edit` (`yaml@2.x`) | Yes | Pure JS |
| `ast_query/ast_rewrite` (`web-tree-sitter` WASM) | Yes | WASM, no native binding |
| `doc_retrieve` (`wink-bm25-text-search`) | Yes | Pure JS |
| `import_rewrite` | Yes | Pure JS |
| `test_baseline/compare` | Yes | Calls existing compositeVerifier |
| `rewrite_run` (semgrep) | Yes | Official Semgrep image uses Alpine 3.23 |
| `rewrite_run` (OpenRewrite via Maven) | Yes | JVM, not native Node binding |
| `rewrite_run` (jscodeshift) | Yes | Pure Node.js |

**Implication for Phase 33:** Keep Alpine as the Docker base image. Phase 33-02-PLAN.md must include an ABI smoke test (run `ast_query` against a fixture Java file; assert result is non-null) to confirm `tree-sitter-wasms@0.1.13` grammar files are built against the same tree-sitter ABI version as `web-tree-sitter@0.22.4`.

---

## Key Findings

### Recommended Stack

All v3.0 capabilities map to a set of new npm dependencies and Docker image additions with no ambiguity. The full existing stack (Node.js 20, TypeScript NodeNext, Claude Agent SDK, Zod@4, conf@15, write-file-atomic, Pino, Vitest, ESLint v10) is unchanged and untouched. See `.planning/research/STACK.md` for full rationale.

**New npm dependencies (host-side):**
- `yaml@^2.8.3` — YAML recipe loading AND roundtrip-safe config editing. The only Node.js YAML library with comment-preserving `parseDocument()` AST. `js-yaml` explicitly rejected comment preservation (issue #689, closed wontfix). Required for Phase 32 (recipe loader) and Phase 33 (`config_edit` tool).
- `ajv@^8.18.0` + `ajv-formats@^3.0.1` — Runtime validation of user-supplied JSON Schema files for the `schema_validate` recipe invariant. Pure JS, no native deps, Alpine-safe. Zod handles internal TypeScript schemas; AJV handles arbitrary external `.json` schema files at runtime.
- `web-tree-sitter@^0.22.4` + `tree-sitter-wasms@^0.1.13` — Tree-sitter AST query/rewrite over WASM. The native `tree-sitter` npm package uses glibc-linked prebuilds that fail on Alpine musl. The WASM path has no native compilation and works in any Node.js ≥16. `tree-sitter-wasms` provides 36 prebuilt grammar `.wasm` files including Java (430 kB), TypeScript (2.34 MB), and Python (476 kB).
- `wink-bm25-text-search@^3.1.2` — Pure JS BM25 text retrieval for the `doc_retrieve` MCP tool. In-memory index built at run start from the mounted `/context/` bundle. No embeddings, no network, no native deps.
- `@types/better-sqlite3` (dev-only, for future reference) — Not added now; SQLite deferred to v3.1.

**New Docker image additions (pre-seeded binaries, not npm-imported at runtime):**
- `jscodeshift@17.3.0` — Installed globally in the build stage. Pure Node.js, Alpine-compatible.
- `semgrep` (latest stable via `pip install semgrep`) — Semgrep's official Docker image uses Alpine 3.23; first-class Alpine support confirmed.
- OpenRewrite recipes pre-seeded in Maven local repo — Built at image build time with network access via `mvn dependency:resolve`; runtime invocation uses `-o` (offline) flag.

### Expected Features

See `.planning/research/FEATURES.md` for the full feature dependency graph and competitor analysis.

**Must have (table stakes — ship with v3.0):**
- Read-only discovery pass before any edits — produces typed `targets.json`; enforced by existing Phase 27 PreToolUse Write/Edit block
- Per-chunk isolation (one session per target or file) — prevents LLM context loss per DAPLab failure patterns
- Continue-on-failure (skip chunk, not abort run) — expected by all serious codemod tools (Webflow, OpenRewrite)
- Persistent `RefactorRun` with resume capability — survives process crashes; `agent refactor resume <run-id>`
- Differential verification against a captured baseline — repos with pre-broken tests must not block legitimate progress
- `agent refactor status <run-id>` — human-readable progress summary (done/failed/skipped/pending counts, last commit SHA)
- Dry-run / preview mode (`--dry` flag stops after discovery, prints target list)
- Idempotent re-run (done targets in ledger = no-op; recipe content hash stored per run)
- Recipe schema validation at load time (Zod strict schema — rejects unknown top-level keys)
- Chunk scope enforcement (`must_touch` / `must_not_touch` glob assertions on every chunk's diff)

**Should have (differentiators — ship with v3.0 or v3.0.x):**
- Declarative YAML recipe format with four slots — adding a new task type = writing a YAML file, not writing code
- Doc-grounded transformation via read-only `/context/` bundle + BM25 `doc_retrieve` — no analogue in OpenRewrite, jscodeshift, or semgrep
- Three transformation strategies (deterministic / end-state-prompt / doc-grounded) in one runner
- AST-backed structural discovery (`ast_query`) — catches aliased imports and structural patterns that grep misses
- Deterministic transformation path (`config_edit`, `ast_rewrite`) — bypasses LLM per chunk; fastest and cheapest path
- Three reference recipes running end-to-end (one per strategy)
- Conversational recipe authoring (four-question interview → validated recipe draft)

**Defer to v3.0.x or v3.1+:**
- `rewrite_run` bridge to OpenRewrite/jscodeshift/semgrep — high value but not required for first three reference recipes
- `import_rewrite` tool — needed for Scio-class import-rename migrations; add after doc-grounded strategy is validated
- Parallel chunk execution (`max_parallel > 1`) — requires worktree sharding and conflict resolution; explicitly deferred to v3.1

**Anti-features (must not build in any phase):**
- Auto-merge PRs when CI passes — removes human-in-the-loop (PROJECT.md hard constraint)
- One giant PR for the whole run — unreviewable; mid-run rollback is impossible
- Automatic rollback on run failure — discards all completed-chunk progress
- Cross-file sessions in one chunk (multiple unrelated files) — violates per-chunk isolation; DAPLab failure pattern 8
- Expanding recipe scope mid-run — invalidates baseline snapshot

### Architecture Approach

v3.0 adds a new top-level `src/refactor/` module that is the exclusive home for all new types, state store, orchestrator, runner, and discovery components. The module boundary means all seven new phases can be built and tested in isolation — none of the new types need to be imported by `src/orchestrator/`, `src/agent/`, or `src/intent/` until the specific narrow integration points are wired. See `.planning/research/ARCHITECTURE.md` for the full component classification (NEW / MODIFIED / UNTOUCHED at file level).

**New components (key):**
1. `src/refactor/orchestrator.ts` (`RefactorOrchestrator`) — multi-chunk loop: pop target, call `runAgent()`, commit, mark ledger, repeat
2. `src/refactor/state-store.ts` (`RefactorStateStore`) — JSON ledger with atomic rename writes to `.bg-agent-runs/<runId>/`
3. `src/refactor/runner.ts` (`RecipeRunner`) — recipe validation, strategy dispatch, top-level run lifecycle
4. `src/refactor/diff-verifier.ts` (`DifferentialVerifier`) — higher-order function wrapping `compositeVerifier` with baseline delta comparison (does NOT modify `compositeVerifier` signature)
5. `src/refactor/discovery.ts` (`DiscoveryPassRunner`) — read-only `runAgent()` session; `targets.json` written host-side by parsing `finalResponse`
6. `src/mcp/tools/` (6 files) — `config_edit`, `ast_query/rewrite`, `import_rewrite`, `rewrite_run`, `test_baseline/compare`, `doc_retrieve`
7. `src/cli/commands/refactor.ts` — `agent refactor start/resume/status` subcommands

**Modified components (key, all additive):**
- `src/agent/index.ts` — three new `AgentContext` flags: `skipWorktreeCleanup`, `contextBundlePath`, `envelopeConfig` (~30 lines)
- `src/agent/worktree-manager.ts` — `PidSentinel.runId` field and `worktree_kind: ephemeral | persistent`; `pruneOrphans` skips persistent entries (~20 lines)
- `src/orchestrator/claude-code-session.ts` — conditional capability MCP server registration; second `-v` context mount (~20 lines)
- `src/orchestrator/judge.ts` — optional `recipeSpec` param; inverted framing ("does diff match spec?") (~15 lines)
- `src/orchestrator/verifier.ts` — `testVerifier` returns structured `TestResult[]` for differential comparison (~20 lines)

**Untouched (complete list):** `retry.ts`, `pr-creator.ts`, `summarizer.ts`, `metrics.ts`, all existing prompt builders, all Slack components, all existing test files, all intent components except narrow additions.

### Critical Pitfalls

The 15 pitfalls in PITFALLS.md fall into five groups: state integrity (Pitfalls 1, 2, 6, 14), verification correctness (Pitfalls 3, 4, 7), toolchain isolation (Pitfalls 8, 9, 10), recipe design (Pitfalls 11, 12, 13, 15), and UX (implicit). The five highest-severity pitfalls by phase-blocking potential:

1. **Orphan scan destroys RefactorRun worktrees after host crash (Phase 29)** — The v2.4 orphan scan correctly removes ephemeral worktrees with dead PIDs. RefactorRun worktrees are long-lived and must survive crashes. Add `worktree_kind: ephemeral | persistent` to the PID sentinel; orphan scan skips `persistent` entries entirely. If this is skipped, `agent refactor resume` fails with "worktree not found" after every crash.

2. **Ledger corrupted by crash between git commit and ledger write (Phase 29)** — The ordering invariant is commit-then-ledger, not ledger-then-commit. On resume, the orchestrator re-pops a target that is still `pending` (because the ledger write never completed), spawns a new session, and the agent finds the prior transformation already in the worktree. The agent must be instructed via the per-chunk prompt to check for prior application. For deterministic transforms, re-running is idempotent by design.

3. **LLM Judge vetoes legitimate 400-line sweeping-change diffs (Phase 31)** — The existing judge was calibrated for single-file, 50-100 line generic tasks. Without the recipe's `transformation.spec` as authoritative scope definition, it fires on diff size. Phase 31 must pass `transformation.spec` to the judge and invert framing from "does this exceed the task?" to "does this match the spec?" For `deterministic` strategy: bypass judge entirely.

4. **Differential verifier poisoned by flaky tests (Phase 30)** — A single flaky test that passes at baseline capture but fails during chunk verification marks every chunk as failed. Prevention: dual-capture protocol — run the test suite twice at baseline time; tests that differ between runs are flagged `known_flaky` and skipped by the differential verifier. Emit a warning if >5% of tests are flaky.

5. **tree-sitter native bindings fail silently on Alpine musl (Phase 33)** — `ast_query` returns empty results rather than erroring. The WASM path (`web-tree-sitter` + `tree-sitter-wasms`) resolves this entirely. The image build must include a smoke test: parse a fixture Java file and assert the result is non-null.

---

## Implications for Roadmap

The v3.0 roadmap is already defined in `.planning/milestones/v3.0-ROADMAP.md` (Phases 28-34). This section adds per-phase integration guidance and research flags for the plan authors.

### Phase 28: Sweeping-Refactor Task Type + Discovery Pass
**Rationale:** Foundation phase — introduces the new task type into the intent pipeline and produces the `targets.json` that all downstream phases consume. Lowest risk phase (reuses Phase 27's read-only plumbing).
**Delivers:** `sweeping-refactor` intent routing (fast-path verbs: "modernize all", "migrate all", "convert all"), `DiscoveryPassRunner`, `RefactorRun` types + `RefactorStateStore` (data model only, orchestrator in Phase 29), sorted `targets.json` output.
**Key pitfall to address here:** Sort `targets.json` by `(file, locator)` in the discovery runner before writing. Verify with a test that runs discovery twice on the same fixture repo and diffs the output byte-for-byte.
**Research flag:** No additional research needed — well-established patterns (fast-path intent + Phase 27 read-only investigation mode).

### Phase 29: RefactorRun Orchestrator
**Rationale:** The architectural keystone. Every other v3.0 phase builds on the `RefactorRun` entity, persistent ledger, long-lived worktree, and per-chunk worker loop. Phases 30, 31, 32 cannot be built without it.
**Delivers:** `RefactorOrchestrator`, `RefactorStateStore` (JSON + write-file-atomic), `WorktreeManager` reuse path with `worktree_kind` sentinel, `BaselineCapture`, `agent refactor start/resume/status` CLI subcommands.
**Key pitfalls that must be addressed in Phase 29 plans (all blocking):**
  - Commit-then-ledger ordering invariant — never write ledger before git commit completes
  - `worktree_kind: persistent` in PID sentinel to block orphan scan
  - Three-check verification in `WorktreeManager.reuse()`: path exists, HEAD SHA matches `lastCommitSha`, branch matches `RefactorRun.branch`
  - UUID v4 run IDs (not sequential integers or name-based strings)
  - `baselineSha` stored on `RefactorRun`; divergence check before each chunk
**Research flag:** No additional research needed. Phase 29-03-PLAN.md (resume and crash recovery) must include a kill-9 recovery scenario test as an explicit success criterion.

### Phase 30: Differential Verification
**Rationale:** Without differential verification, the existing composite verifier blocks legitimate refactor chunks in repos with pre-broken tests. This resolves the known tech debt item `baseline_build_check.md`. v3.0 is unusable in real codebases without this phase.
**Delivers:** `DifferentialVerifier` (higher-order function, does not modify `compositeVerifier` signature), `BaselineCapture` with dual-capture flaky-test detection, `TestResult[]` structured output from `testVerifier`.
**Key pitfall to address here:** Dual-capture baseline. Run the test suite twice at baseline time. Tests that differ between the two captures = `known_flaky` set excluded from differential comparison. A single capture poisons the run. Emit a warning and block run start if >5% of tests are flagged flaky.
**Research flag:** No additional research needed. The dual-capture flaky detection protocol is well-understood from Gradle/JUnit flakiness detection literature.

### Phase 31: Context Bundle Mount + Judge Scope Injection
**Rationale:** Two independent concerns sharing one phase because they share the Phase 29 prerequisite and no source files. Phase 30 can build in parallel with Phase 31.
**Delivers:** Second `-v` mount (`contextBundlePath:/context:ro`), system prompt context bundle reference, `recipeSpec` param to `llmJudge()` with inverted framing, vetoed-diff regression test suite.
**Key pitfall (high severity):** Judge veto rate must be measured against the three reference recipes. A recipe that causes >10% veto rate indicates miscalibration. A vetoed-diff regression test — 400-line mechanical diff matching the recipe spec exactly must NOT veto — must be a Phase 31 success criterion.
**Research flag:** No additional research needed.

### Phase 32: Recipe Format + Recipe Runner
**Rationale:** The user-facing contract. Cannot be built until Phases 28-31 exist. Must ship three reference recipes running end-to-end as the acceptance gate.
**Delivers:** Recipe Zod schema (`strict()` on top-level object, rejects unknown keys), YAML loader with field-level error messages, `RecipeRunner` with three-strategy dispatch, three reference recipes (deterministic YAML bump, end-state-prompt POJO-to-records, doc-grounded Scio upgrade).
**Key pitfall to address here:** Zod `strict()` on the top-level recipe object — any unknown key is a validation error. This is the mechanical enforcement of the four-slot constraint and must be in Phase 32-01-PLAN.md as an explicit success criterion.
**Research flag:** Recipe schema is fully specified in Appendix A of v3.0-ROADMAP.md. No schema design research needed. Phase 32-03-PLAN.md must specify whether Scio fixture repo is real or synthetic.

### Phase 33: Capability Toolbox
**Rationale:** Tools are general-purpose MCP capabilities exercised by the Phase 32 reference recipes. Building Phase 33 after Phase 32 ensures tools are validated in context before adding more.
**Delivers:** Six MCP tool files, updated Docker image with jscodeshift + semgrep + OpenRewrite Maven cache, BM25 index stored in `RefactorRun` state directory (NOT inside the `:ro` context bundle).
**Key pitfalls by plan:**
  - Phase 33-01: `config_edit` must use `yaml@2.x` `parseDocument()`, not `js-yaml`. Unit test must assert that only the target key's line changes in a `git diff` on a 40-line commented YAML file.
  - Phase 33-02: `ast_query/ast_rewrite` must use `web-tree-sitter` WASM. Image build must include smoke test: `ast_query` on a fixture Java file returns non-null results.
  - Phase 33-03: `rewrite_run` must use `-o` (offline) Maven flag. Docker image build must pre-seed Maven cache. Semgrep must use local rules only. All three tools must pass an offline smoke test (no TCP connections to external hosts, verified by Docker network audit).
  - `doc_retrieve` index must be stored in the `RefactorRun` state directory, not inside the `:ro` bundle mount. Build index at run start; include a pre-flight check that verifies `doc_retrieve` returns >0 results before the first chunk starts.
**Research flag:** Phase 33-03 (rewrite_run bridge) needs careful Dockerfile design for Maven cache pre-seeding. The exact set of OpenRewrite recipe JARs to pre-seed depends on which recipes the Phase 32 reference recipe uses — determine during Phase 33 planning.

### Phase 34: Conversational Recipe Authoring
**Rationale:** Built last because it emits Phase 32 recipe YAML. Schema must be stable before authoring UX can be validated.
**Delivers:** `RecipeInterviewDialogue` (four-question interview → `RecipeDraft`), human-readable recipe summary before confirmation, `agent refactor status` wired to REPL and Slack, `/edit recipe` path.
**Key pitfall to address here:** Dry-run gate — a confirmed recipe must return >0 targets from a discovery dry-run before the full run starts. A recipe producing zero targets is almost always a query bug. This must be a Phase 34 success criterion, not a future enhancement.
**Research flag:** No additional research needed. Phase 22 scoping dialogue infrastructure is the integration point.

### Phase Ordering Rationale

- Phase 28 before Phase 29: Phase 29 consumes `targets.json` and the `RefactorRun` data types defined in Phase 28.
- Phase 29 before everything else: Every v3.0 phase depends on `RefactorRun`, `RefactorStateStore`, and `runAgent()`'s new `skipWorktreeCleanup` flag.
- Phase 30 and Phase 31 in parallel: They share no source files. Phase 30 touches `verifier.ts` + `diff-verifier.ts`. Phase 31 touches `claude-code-session.ts`, `docker/index.ts`, `judge.ts`. Both require only Phase 29.
- Phase 32 after both 30 and 31: `RecipeRunner` calls `DifferentialVerifier` (Phase 30) and passes `recipeSpec` to the judge (Phase 31). Both must exist before end-to-end testing is possible.
- Phase 33 after Phase 32: Reference recipes exercise capability tools. Building tools without recipes makes it impossible to validate tool correctness in context.
- Phase 34 last: Emits Phase 32 recipe YAML. Schema must be stable before authoring UX can be built and validated.

### Research Flags

**Phases that may need targeted research during plan execution:**
- **Phase 33-03:** Maven offline cache pre-seeding in the Docker image. The approach is documented in OpenRewrite docs but the exact set of recipe JARs to pre-seed for the reference recipes needs to be determined.
- **Phase 33-03:** Semgrep version pinning. Identify which semgrep versions make network calls on startup even with `--metrics=off`; pin to a verified-clean version.

**Phases with standard patterns (no pre-work research needed):**
- **Phase 28:** Fast-path intent routing is established in this codebase (Phases 15, 18, 27).
- **Phase 29:** Crash-recovery and state store patterns are well-understood. Kill-9 test harness design is the only implementation uncertainty.
- **Phase 30:** Differential verification pattern is directly analogous to OpenRewrite's delta-only approach.
- **Phase 31:** Judge prompt extension follows Phase 22's injection pattern.
- **Phase 32:** Recipe schema is fully specified in Appendix A of v3.0-ROADMAP.md.
- **Phase 34:** Four-question interview follows Phase 22's `runScopingDialogue()` pattern.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All library choices verified against official docs, npm registry, and first-party issue trackers. Alpine compatibility confirmed. WASM path removes the only MEDIUM-confidence item (native musl compatibility). SQLite deferred to v3.1 removes the two-platform build risk. |
| Features | HIGH | Comparator analysis (OpenRewrite, jscodeshift, semgrep, Sourcegraph Batch Changes) from official docs. DAPLab failure patterns from Columbia University 2026 paper. Anti-features grounded in real-world codemod experience (Webflow, Airbnb). |
| Architecture | HIGH | Based on direct source code analysis of all integration-relevant v2.4 files. Component classification (NEW / MODIFIED / UNTOUCHED) is derived from reading the actual source. Integration points are specific (file + line-count estimate). |
| Pitfalls | HIGH | 15 pitfalls identified, all grounded in first-party codebase analysis or first-party issue trackers (tree-sitter, semgrep, OpenRewrite, eemeli/yaml). Patreon TypeScript migration case study (7 years, 11,000 files) validates cross-file dependency ordering pitfall. |

**Overall confidence:** HIGH

### Gaps to Address During Planning

- **OpenRewrite recipe JAR set:** Determine the exact Maven artifact coordinates and transitive deps to pre-seed during Phase 33-03 planning, not before.
- **`test_baseline`/`test_compare` tool API surface:** The tool's exact interface and how it interacts with language-specific test runners (Maven Surefire, npm test, pytest) must be specified in Phase 33-03-PLAN.md.
- **Scio migration fixture:** The `doc-grounded` reference recipe requires a fixture repo and context bundle. Phase 32-03-PLAN.md must decide whether to use a real Scio fixture or a synthetic one.
- **`agent refactor status` output format:** The research specifies what the command must show but the exact CLI formatting is a UX decision for Phase 29 or Phase 34.

---

## Sources

### Primary (HIGH confidence)
- `.planning/milestones/v3.0-ROADMAP.md` — Phase specs, Appendix A recipe schema, success criteria
- `.planning/PROJECT.md` — Key Decisions table, architectural invariants, constraints
- Direct source code analysis: `src/agent/index.ts`, `src/agent/worktree-manager.ts`, `src/orchestrator/retry.ts`, `src/orchestrator/verifier.ts`, `src/orchestrator/claude-code-session.ts`, `src/orchestrator/judge.ts`, `src/cli/docker/index.ts`, `src/mcp/verifier-server.ts`, `src/intent/index.ts`, `src/types.ts`, `src/repl/session.ts`
- [github.com/eemeli/yaml](https://github.com/eemeli/yaml/releases) — v2.8.3 latest; `parseDocument` comment preservation verified
- [github.com/nodeca/js-yaml#689](https://github.com/nodaca/js-yaml/issues/689) — wontfix comment preservation confirmed
- [github.com/tree-sitter/tree-sitter issues#597](https://github.com/tree-sitter/tree-sitter/issues/597) — Alpine glibc issue closed without fix
- [tree-sitter/node-tree-sitter issue #169](https://github.com/tree-sitter/node-tree-sitter/issues/169) — ABI version mismatch confirmed
- [github.com/WiseLibs/better-sqlite3 issues#619](https://github.com/WiseLibs/better-sqlite3/issues/619) — Alpine musl prebuilds confirmed since 2021
- [github.com/ajv-validator/ajv releases](https://github.com/ajv-validator/ajv/releases) — v8.18.0 pure JS confirmed
- [semgrep/semgrep issue #3147](https://github.com/semgrep/semgrep/issues/3147) and [#8793](https://github.com/semgrep/semgrep/issues/8793) — network calls in offline use confirmed
- [docs.openrewrite.org offline invocation](https://docs.openrewrite.org/running-recipes/running-rewrite-on-a-maven-project-without-modifying-the-build) — `-o` offline flag confirmed
- [unpkg tree-sitter-wasms@latest/out/](https://app.unpkg.com/tree-sitter-wasms@latest/files/out) — Java, TypeScript, Python WASM files confirmed at v0.1.13
- [semgrep.dev docs/packages-in-semgrep-docker](https://semgrep.dev/docs/semgrep-ci/packages-in-semgrep-docker) — Alpine 3.23 base confirmed
- OpenRewrite Docs, Sourcegraph Batch Changes Docs, jscodeshift GitHub, Webflow Engineering Blog, Airbnb Engineering Blog, DAPLab Columbia University 2026 paper, Patreon TypeScript migration case study, Gradle Flaky Test Detection Guide

### Secondary (MEDIUM confidence)
- [docs.openrewrite.org](https://docs.openrewrite.org) — offline Maven cache pre-seeding is inferred practice, not officially documented as a Docker recipe
- [Termdock: Git worktree conflicts with AI agents](https://www.termdock.com/en/blog/git-worktree-conflicts-ai-agents) — worktree divergence patterns
- [Upsun: Git worktrees for parallel AI agents](https://devcenter.upsun.com/posts/git-worktrees-for-parallel-ai-coding-agents/) — merge-early patterns
- [Augment Code: Git worktrees](https://www.augmentcode.com/guides/git-worktrees-parallel-ai-agent-execution) — lockfile divergence in separate worktrees

---
*Research completed: 2026-04-08*
*Ready for roadmap: yes*
