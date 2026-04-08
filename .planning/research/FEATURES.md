# Feature Research

**Domain:** Background coding agent — v3.0 sweeping-refactor / program automator capability
**Researched:** 2026-04-08
**Confidence:** HIGH (OpenRewrite/jscodeshift/semgrep/Sourcegraph patterns from official docs + engineering blog posts), MEDIUM (AI-specific multi-session orchestration — limited direct analogues, inferred from codemod patterns + DAPLab agent failure research)

---

## Context

This research covers v3.0 only — the "sweeping refactor" milestone. Already shipped and not re-researched: REPL/one-shot/Slack interfaces, intent parser, confirm-before-execute, generic + dep-update task types, composite verifier + LLM Judge, RetryOrchestrator, post-hoc PR creation, SessionCallbacks, conversational scoping dialogue, follow-up referencing, git worktree isolation, investigation/exploration tasks.

The research question: what do users of sweeping-refactor tools expect, what differentiates a trustworthy tool from a dangerous one, and what must the v3.0 agent explicitly NOT do?

**Comparators analyzed:**
- OpenRewrite (Java/JVM automated refactoring, recipe-based, LST-backed)
- jscodeshift (JS/TS AST-based codemod toolkit)
- semgrep (pattern-based search and autofix)
- Sourcegraph Batch Changes (declarative batch change spec across repos)
- Facebook codemod (Python text-based, original "large-scale codebase refactor" tool)
- Webflow's codemod practice (real-world 20,000+ line codemod experience)
- DAPLab 9 Critical Failure Patterns of Coding Agents (Columbia University, 2026-01)

**Feature categories used in this document:**
1. Discovery — finding where changes need to happen
2. Transformation — executing the change per site
3. Verification — proving the change is correct and bounded
4. Orchestration — managing a multi-session run to completion
5. Recipes / Declarative Spec — expressing "what to do" without writing code
6. Context — external reference material agents need to read
7. UX — how users author, monitor, and recover a run

---

## Feature Landscape

### Table Stakes (Users Expect These)

Features users assume exist once a tool promises "sweeping refactor." Missing these makes the tool feel broken or untrustworthy.

| Feature | Category | Why Expected | Complexity | Notes | Depends On (v2.4 assets) |
|---------|----------|--------------|------------|-------|--------------------------|
| Read-only discovery pass before any edits | Discovery | Every serious codemod tool (jscodeshift `--dry`, semgrep `--dryrun`, OpenRewrite `rewrite:discover`) separates find from fix. Users who can't see the target list before committing to a run will not trust the tool. | LOW | Reuses investigation-mode read-only plumbing from Phase 27. Produces a typed `targets.json` (file + locator + kind). Must be deterministic: same repo + same recipe = same target list. | Phase 27 investigation mode (`PreToolUse` Write/Edit block, `:ro` Docker mount) |
| Per-chunk isolation (one session per target or file) | Transformation | Facebook's codemod explicitly recommends "PRs small enough that a reviewer can fully understand them." Airbnb/Webflow: large monolithic codemods fail on edge cases at scale. DAPLab: agents lose context as file count grows — per-chunk scoping is the mitigation. | MEDIUM | Each chunk session operates on a single file or small group. Failure of one chunk must not block others. Session gets only the relevant target context, not the full codebase description. | Existing `ClaudeCodeSession` + `RetryOrchestrator`; extend to accept a scoped work unit |
| Continue-on-chunk-failure (skip, not abort) | Orchestration | Real codemods (Webflow's report: "had to save some parts for later") encounter files that require manual intervention. Users expect the tool to proceed to the next target, not stop the whole run. | MEDIUM | Per-target ledger with `pending / in-progress / done / failed / skipped` states. Failed chunks are logged with reason; run continues. User can inspect and re-run failed chunks manually or after recipe fix. | New — no direct v2.4 analogue; closest: `RetryOrchestrator` which aborts on veto |
| Persistent run state with resume capability | Orchestration | A 200-file migration run that crashes at file 87 must resume at file 88, not restart at file 1. Sourcegraph Batch Changes and OpenRewrite both expose progress dashboards and resumable execution. | HIGH | `RefactorRun` entity with persistent ledger (JSON/SQLite). `agent refactor resume <run-id>` command. Ledger records commit SHA per completed chunk so state is accurate even after process restart. | Phase 26 worktree `PID sentinel` pattern; extend to full run ledger |
| Differential verification (relative to baseline, not absolute green) | Verification | A repo with a pre-existing failing test cannot gate each chunk on "absolute green build." OpenRewrite does not require a clean baseline — it validates that the recipe's changes don't make things worse. Sourcegraph Batch Changes similarly tracks CI status deltas per changeset. | HIGH | Capture a baseline snapshot (build result, test pass/fail set, lint counts) at run start. After each chunk: fail only if a previously-passing test now fails, a new lint class appears, or the build regresses. A pre-broken test does not block progress. | Existing `compositeVerifier`; extend with baseline delta comparison |
| Chunk diff scoped to recipe-declared target files | Verification | The LLM Judge in v2.x vetoes "scope creep" but has no formal definition of what's in scope. For sweeping refactors this is inverted: a 50-file diff is expected; editing `pom.xml` is not. Users expect the verifier to enforce declared scope boundaries. | MEDIUM | `chunk_scope.must_touch` / `must_not_touch` glob assertions run on every chunk's diff. Judge receives the recipe's transformation spec as the authoritative scope definition. | Existing LLM Judge; add recipe-spec injection (Phase 31) |
| Human-readable run status / progress view | UX | Sourcegraph Batch Changes burndown chart, OpenRewrite's `rewrite:run` console output showing per-file results — users need to see how far a run has progressed without reading raw logs. | LOW | `agent refactor status <run-id>` prints ledger summary: total targets, done/failed/skipped/pending counts, list of failed chunks with reasons. No UI dashboard needed — CLI output is sufficient per PROJECT.md. | New REPL/CLI command; depends on ledger |
| Dry-run / preview mode | Discovery | Every codemod tool offers this. jscodeshift `--dry --print`, semgrep `--dryrun`, Sourcegraph `src batch preview`. Users will not run a 500-file migration blind. | LOW | Dry-run: execute discovery pass, print target list, print per-chunk transformation plan (for deterministic strategy) or spec summary (for prompt strategies). Do not create worktree or ledger. Distinct from running discovery as the first stage of a real run. | Phase 28 discovery pass; add `--dry` flag that stops after discovery |
| Idempotent re-run (same recipe + already-done targets = no-op) | Orchestration | OpenRewrite design note: "recipes are safe to re-run." If a target is already `done` in the ledger, re-running the recipe must skip it, not transform it twice. | LOW | Ledger `done` state gates re-processing. Hash of recipe content stored per run — if recipe changes, warn and require explicit `--force-restart`. | Persistent ledger |

### Differentiators (Competitive Advantage)

Features that raise the quality of v3.0 above baseline codemod tools. These are where the LLM-backed agent adds value that static codemods cannot.

| Feature | Category | Value Proposition | Complexity | Notes | Depends On (v2.4 assets) |
|---------|----------|-------------------|------------|-------|--------------------------|
| Doc-grounded transformation (context bundle + retrieval) | Context | Static codemods require a human to encode all migration rules into the codemod script. With a context bundle (migration guide PDFs, API maps, changelogs), the agent can look up "how to migrate `PipelineFactory.create()`" at transformation time. Sourcegraph and OpenRewrite have no analogue — they require pre-encoded rules. | HIGH | Read-only `/context/` mount at Docker level. BM25 retrieval (`doc_retrieve` MCP tool) over the mounted bundle — no embeddings, no network. Agent queries the bundle before each chunk edit. Particularly valuable for breaking-upgrade recipes (e.g., Scio v1→v2). | Phase 27 `:ro` mount pattern; new MCP tool `doc_retrieve` |
| Declarative YAML recipe (task type as data, not code) | Recipes | OpenRewrite requires writing Java visitors. jscodeshift requires writing JS transform functions. In v3.0, a new task type is a YAML file with four slots: discovery, transformation, verification, context. No code change to the agent infrastructure. This is the single biggest extensibility advantage over existing tools. | HIGH | Recipe schema validation at load time. Three transformation strategies (deterministic / end-state-prompt / doc-grounded) cover the full range without adding strategy-specific code paths. The runner dispatches on strategy. | New — no v2.4 analogue; Phase 32 |
| Conversational recipe authoring (four-question interview) | UX | No existing codemod tool generates its own spec from a conversation. Sourcegraph requires writing a batch spec file. OpenRewrite requires finding the right recipe from the catalog. In v3.0, a user says "modernize all POJOs to records" and the scoping dialogue emits a validated recipe. | HIGH | Extend Phase 22 scoping dialogue to detect sweeping-refactor shape and run the four-question interview: (1) what marks a target site? (2) what should it become? (3) how do we know it worked? (4) any docs I should read? Output is a recipe draft the user reviews before confirming. | Phase 22 scoping dialogue; Phase 32 recipe schema |
| Deterministic transformation path (no LLM per chunk) | Transformation | For structural tasks (YAML key set, import rename), using an LLM per chunk is slower, more expensive, and introduces non-determinism. OpenRewrite's strength is LST-backed deterministic transforms. v3.0 adds this via `config_edit`, `ast_rewrite`, `import_rewrite` capability tools. For eligible recipes, the agent is bypassed entirely for transformation. | MEDIUM | `deterministic` strategy in recipe routes to a direct capability tool call — no Claude session spawned per chunk. Fastest and cheapest path. `rewrite_run` bridges to OpenRewrite/jscodeshift/semgrep toolchains already pre-seeded in the Docker image. | New MCP toolbox (Phase 33); pre-seeded Docker image |
| AST-backed structural discovery (`ast_query`) | Discovery | grep-based discovery misses aliased imports, re-exports, and symbol renames. OpenRewrite's LST and semgrep's pattern matching both catch structural patterns that text search misses. tree-sitter covers Java, Python, TypeScript, Go, and more. | HIGH | `ast_query` MCP tool: tree-sitter backed, exposes named preset patterns (e.g., "classes with only final fields and getters") plus raw tree-sitter queries. Output is the standard `{file, locator, kind}` shape consumed by all downstream slots. | New MCP tool (Phase 33) |
| Recipe versioning tied to run history | Recipes | If a recipe changes mid-migration, already-completed chunks were processed under the old recipe. OpenRewrite has no explicit recipe versioning for partial runs. v3.0 stores the recipe content hash per run in the ledger, detecting version drift and warning the user. | LOW | Recipe YAML has a `version` field (semver). Run ledger stores recipe version + content hash. On resume: if recipe has changed, warn: "Recipe changed since run start. Re-run affected chunks with `--force`?" | Persistent ledger |
| Chunk scope enforcement at verifier level | Verification | Sourcegraph Batch Changes delegates scope to the batch spec author — there's no enforcement that a changeset's diff stays within declared boundaries. v3.0 enforces `must_touch` / `must_not_touch` glob assertions on every chunk's diff, making scope leakage impossible, not just undesirable. | MEDIUM | Extend composite verifier with a diff-scope check pass. Runs before the LLM Judge. A chunk that touches `pom.xml` when the recipe says `must_not_touch: ["**/pom.xml"]` fails immediately with a clear error, not a vague judge veto. | Existing `compositeVerifier`; extend in Phase 30 |

### Anti-Features (The Agent Must NOT Do These)

These are features commonly requested in refactoring tools that create serious trust, correctness, or safety problems. Each has a specific warning explaining the risk.

| Feature | Category | Why Requested | Why Dangerous — WARNING | Alternative |
|---------|----------|---------------|-------------------------|-------------|
| Auto-merge PRs when CI passes | Orchestration | "Reduce toil — if 200 files all pass CI, just merge them all." | **WARNING: Removes human-in-the-loop. PROJECT.md constraint: "Auto-merge — human approval required (trust model)." An LLM-generated change that passes CI can still be semantically wrong — wrong variable renamed, wrong API equivalent chosen. No automated signal proves semantic correctness. Sourcegraph Batch Changes supports auto-merge as an opt-in; it is explicitly out of scope for this project.** | All chunks create PRs for human review. `agent refactor status` provides a bulk view. GitHub's merge queue can batch-merge approved PRs. |
| One giant PR for the whole run | Orchestration | "Easier to review one PR than 200 small ones." | **WARNING: A 200-file PR is not reviewable — it creates the illusion of review. When something goes wrong (and it will for edge-case files), it is impossible to identify which chunk introduced the regression. Airbnb's codemod engineering blog explicitly recommends per-slice PRs for large transforms. Merging a bad chunk atomically with 199 good ones blocks rollback.** | One PR per chunk (or per-file for deterministic transforms). Small PRs can be merged quickly once reviewer spot-checks a representative sample. |
| Silent skip of unmodified files | Transformation | "Don't create PRs for files where nothing changed." | **WARNING: Silently skipping a file is fine, but conflating "nothing changed" with "no change was needed" is dangerous. If the discovery pass returned a target but the transformation produced a zero-diff, this is an anomaly that deserves logging, not silent discard. A zero-diff on a targeted site usually means the transformation failed or the discovery was wrong.** | Log zero-diff chunks with `skipped: zero_diff` status in the ledger. Surface in `status` output. Let user inspect. Do not create a PR for zero-diff chunks, but do record them. Reuse the existing zero-diff detection from v2.2. |
| Parallel chunk execution (multi-thread) | Orchestration | "200 files in parallel would be 10x faster." | **WARNING: Parallel writes to the same worktree produce merge conflicts. Parallel writes to separate worktrees require worktree sharding — N worktrees × N branches × N PRs. Merging N branches back to main requires conflict resolution that is not automated. The recipe schema supports `max_parallel > 1` as a forward-looking field, but the runner in v3.0 must enforce `max_parallel: 1`. DAPLab research: agents already lose context in single-file refactors; parallelism compounds this. Defer to v3.1 with explicit conflict resolution strategy.** | Sequential per-chunk execution (max_parallel: 1). Deterministic strategy chunks are fast enough that sequential execution is acceptable for most real-world recipe sizes. |
| LLM-generated discovery (pure prompt, no structural tool) | Discovery | "Just ask the agent to find all POJOs — it knows what a POJO is." | **WARNING: LLM discovery is non-deterministic. Running the same prompt twice may return different file lists. A discovery pass that returns different targets on retry makes differential verification meaningless and run resumption unreliable. Martin Fowler's codemod article: "Relying solely on the cases you can anticipate is not enough" — this applies even more to LLM enumeration of targets.** | Discovery must use a structural tool (grep, ast_query, config_query, import_scan). `custom` / prompt-based discovery is permitted in the recipe schema as a fallback but must be flagged as non-deterministic and forces the user to confirm. The runner warns: "Custom discovery is non-deterministic. Targets will be frozen at first run." |
| Transformation that spans multiple unrelated files in one session | Transformation | "The agent is smart enough to update the class and its callers in one session." | **WARNING: Cross-file sessions violate per-chunk isolation. The agent loses track of which changes belong to which target (DAPLab failure pattern 8: "codebase awareness — agents mix up components"). LLM Judge cannot scope-check a diff that spans 10 unrelated files. Retry context grows until it exceeds the session budget. Webflow: "Never refactor multiple patterns simultaneously."** | Chunk strategy `per-file` or `per-target`. If a transformation requires updating both a class and its callers, the recipe must declare both as targets and process them as adjacent chunks in sequence (same branch, ordered). |
| Recipe authoring without schema validation | Recipes | "Let me just write free-form YAML." | **WARNING: An unvalidated recipe can silently produce the wrong target list (wrong glob), the wrong transformation (typo in capability args), or no verification (empty baseline array). OpenRewrite enforces recipe typing; Sourcegraph Batch Changes validates the spec before execution. Running a 500-file migration against a malformed recipe wastes compute and time.** | Validate recipe against the v3.0 JSON Schema before run start. Reject with a clear, field-level error message. Never start a `RefactorRun` with an invalid recipe. |
| Context bundle access from the transformation write path | Context | "Let the agent write updated docs into the context bundle to share knowledge across chunks." | **WARNING: The context bundle is a read-only reference. Allowing writes to it during a run would let one chunk's output corrupt a later chunk's reference material. This is especially dangerous for doc-grounded strategies where the retrieval query could return agent-generated text as if it were authoritative documentation.** | Context bundle is always mounted `:ro` at Docker level and blocked by the `PreToolUse` hook. Agent can read from `/context/`; writes to `/context/` are hard-blocked. If a chunk produces documentation artifacts, they go into the repo, not the bundle. |
| Automatic rollback on run failure | Orchestration | "If any chunk fails, undo all changes from this run automatically." | **WARNING: Automatic rollback discards all progress from already-completed chunks. For a 150-target run that fails at target 120, rolling back loses 119 successful transforms. The correct behaviour is to leave the worktree/branch intact, mark the failed chunk, and let the user decide whether to proceed (after fixing the recipe), skip, or abandon the run.** | `agent refactor status` shows what succeeded and what failed. User can manually revert a specific chunk's commit from the shared branch. `agent refactor abandon <run-id>` deletes the run branch if the user wants a clean slate. |
| Expanding recipe scope mid-run | Recipes | "We found more targets — let me add them to the same run." | **WARNING: Adding targets mid-run invalidates the baseline snapshot captured at run start. New targets added after baseline capture will be verified against a baseline that includes changes already committed by earlier chunks. This can produce false differential-verification passes.** | All targets are frozen at discovery time. To add new targets, start a new run from the same recipe. |

---

## Feature Dependencies

```
v3.0 Feature Graph:

[Phase 28] Discovery Pass
    └──reuses──> Phase 27 investigation mode (read-only Docker, PreToolUse hook)
    └──produces──> targets.json (typed target list)
    └──required by──> Phase 29 RefactorRun Orchestrator

[Phase 29] RefactorRun Orchestrator
    └──consumes──> targets.json from Phase 28
    └──extends──> Phase 26 WorktreeManager (add "reuse existing" path)
    └──extends──> v2.x RetryOrchestrator (wrap in chunk loop)
    └──required by──> Phase 30 Differential Verification
    └──required by──> Phase 31 Context Bundle Mount
    └──required by──> Phase 32 Recipe Runner

[Phase 30] Differential Verification
    └──extends──> Existing compositeVerifier (add baseline delta comparison)
    └──extends──> Existing LLM Judge (add recipe-spec scope injection)
    └──depends on──> Phase 29 (baseline lives on RefactorRun)

[Phase 31] Context Bundle Mount + Judge Scope Injection
    └──extends──> Phase 27 `:ro` Docker mount pattern (add /context/ mount)
    └──extends──> Existing LLM Judge prompt (add recipe spec as authoritative scope)
    └──depends on──> Phase 29 (run config carries context bundle path)

[Phase 32] Recipe Format + Runner
    └──depends on──> Phases 28, 29, 30, 31 (all infrastructure must exist)
    └──defines──> YAML schema with four slots: discovery / transformation / verification / context
    └──enables──> Adding new task types as YAML files (no code change)
    └──required by──> Phase 33 Capability Toolbox (tools referenced by name in recipes)
    └──required by──> Phase 34 Recipe Authoring

[Phase 33] Capability Toolbox (MCP tools)
    └──depends on──> Phase 32 (recipes reference tools by name)
    └──new tools: config_edit, ast_query/ast_rewrite, import_rewrite, rewrite_run, test_baseline/test_compare, doc_retrieve
    └──rewrite_run──bridges──> OpenRewrite / jscodeshift / semgrep (pre-seeded in Docker image)
    └──doc_retrieve──uses──> Phase 31 /context/ mount

[Phase 34] Conversational Recipe Authoring
    └──depends on──> Phase 32 (must emit valid recipes)
    └──extends──> Phase 22 scoping dialogue (adds sweeping-refactor detection + 4-question interview)
    └──wires into──> REPL + Slack adapters for `agent refactor status` command

Discovery ──independent──> Capability Toolbox
    (discovery tools like ast_query also used in Toolbox; toolbox adds write-side variants)

Differential Verification ──independent──> Context Bundle Mount
    (both depend on RefactorRun but do not depend on each other)
```

### Dependency Notes

- **Phase 28 depends on Phase 27's read-only plumbing.** The `PreToolUse` Write/Edit block and `:ro` Docker mount are already shipped. Discovery pass is a targeted reuse, not a rebuild.
- **Phase 29 is the architectural keystone.** Every other v3.0 phase depends on `RefactorRun` existing. It must ship before Phase 30/31/32 can proceed.
- **Phase 30 differential verification is a critical unlock.** Without it, the existing composite verifier will reject legitimate chunks in repos with pre-broken tests (known tech debt: `baseline_build_check.md`). v3.0 cannot be trusted without differential verification.
- **Phase 33 tools are not coupled to Phase 32 recipes.** Tools are general-purpose MCP capabilities. A generic session (not a recipe run) can call `config_edit` or `ast_query` directly. This is an explicit design decision: tools are the extension point, not recipes.
- **Phase 34 (recipe authoring) is last for good reason.** It emits Phase 32 recipe YAML. If the schema changes during Phases 29-33, Phase 34 authoring must match. Building it last avoids chasing a moving target.

---

## MVP Definition

### Launch With (v3.0 — minimum to deliver "sweeping refactor" value)

- [ ] **Discovery pass (Phase 28)** — Without target discovery, there is no "sweeping" in sweeping refactor. This is the foundation.
- [ ] **RefactorRun orchestrator with persistent ledger (Phase 29)** — Multi-session state is what makes this a program automator, not just a bigger single session.
- [ ] **Differential verification (Phase 30)** — Without this, the verifier will block legitimate progress in any repo with pre-existing failures. Not shipping this makes v3.0 unusable in real codebases.
- [ ] **Context bundle mount (Phase 31)** — Required to unlock doc-grounded recipes (Scio migrations, breaking upgrades). Without this, v3.0 can only handle mechanical rewrites.
- [ ] **Recipe format + runner (Phase 32)** — The recipe is the user-facing contract. Without it, users must write code to use the agent, which defeats the "new task type = YAML file" goal.
- [ ] **Three reference recipes that run end-to-end** — Proof that the system works: one deterministic (YAML bump), one end-state-prompt (POJO→record), one doc-grounded (Scio upgrade).

### Add After Validation (v3.0.x)

- [ ] **Capability toolbox: `rewrite_run` bridge (Phase 33)** — Adds OpenRewrite/jscodeshift/semgrep as deterministic transformation backends. High value but not needed for the first reference recipes (which use `config_edit` and `ast_rewrite`). Trigger: recipe authors need OpenRewrite recipes they already own.
- [ ] **Conversational recipe authoring (Phase 34)** — High UX value but users can hand-write recipes against the schema for the first validated runs. Trigger: recipe authoring feedback shows YAML as a barrier.
- [ ] **`import_rewrite` tool** — Needed for Scio-class import-rename migrations. Add once doc-grounded strategy is validated against a real import-scan discovery recipe.

### Future Consideration (v3.1+)

- [ ] **Parallel chunk execution (max_parallel > 1)** — Requires worktree sharding + conflict resolution strategy. Defer explicitly per anti-features section.
- [ ] **Multi-repo fleet orchestration** — One repo per run is a v3.0 constraint. Wrap externally (shell scripts calling `agent refactor start` per repo) until demand is clear.
- [ ] **Live-environment verification** — Prod-shaped DBs, live services. Different trust model and infrastructure. Defer.
- [ ] **Full language-to-language rewrites (Java → Kotlin)** — Different shape, needs equivalence-testing infrastructure. Defer to v4.

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Discovery pass (Phase 28) | HIGH | LOW (reuses investigation mode) | P1 |
| RefactorRun ledger + orchestrator (Phase 29) | HIGH | HIGH | P1 |
| Differential verification (Phase 30) | HIGH | MEDIUM | P1 |
| Context bundle mount (Phase 31) | HIGH | LOW | P1 |
| Recipe format + runner (Phase 32) | HIGH | HIGH | P1 |
| `config_edit` + `doc_retrieve` tools (Phase 33a) | HIGH | MEDIUM | P1 |
| `ast_query` / `ast_rewrite` tools (Phase 33b) | HIGH | HIGH | P1 |
| Three reference recipes end-to-end (Phase 32) | HIGH | MEDIUM | P1 |
| `rewrite_run` bridge to OpenRewrite/jscodeshift (Phase 33c) | MEDIUM | HIGH | P2 |
| `test_baseline` / `test_compare` tools (Phase 33d) | MEDIUM | MEDIUM | P2 |
| Conversational recipe authoring (Phase 34) | HIGH | HIGH | P2 |
| `agent refactor status` CLI command | HIGH | LOW | P1 |
| Dry-run / preview mode | HIGH | LOW | P1 |
| Chunk scope enforcement (must_touch / must_not_touch) | HIGH | LOW | P1 |
| Recipe schema validation at load time | HIGH | LOW | P1 |
| Idempotent re-run (skip done targets) | HIGH | LOW | P1 |
| Run resume after crash | HIGH | MEDIUM | P1 |
| Recipe versioning + drift detection | MEDIUM | LOW | P2 |
| `import_rewrite` tool | MEDIUM | MEDIUM | P2 |
| Parallel chunk execution (max_parallel > 1) | MEDIUM | HIGH | P3 |

**Priority key:**
- P1: Required for v3.0 milestone
- P2: Add after P1 validated in real usage (v3.0.x or v3.1)
- P3: Future milestone

---

## Competitor Feature Analysis

| Feature | OpenRewrite | jscodeshift | semgrep | Sourcegraph Batch Changes | v3.0 Approach |
|---------|-------------|-------------|---------|--------------------------|---------------|
| Discovery mechanism | LST scan (structural, type-aware) | Custom AST visitor code | Pattern matching (semantic-ish) | User-written steps (search + arbitrary bash) | Pluggable: grep / ast_query / config_query / import_scan / custom |
| Transformation strategy | Visitor code (Java) | Transform function (JS) | Rule fix template | Arbitrary bash + Docker steps | Three strategies: deterministic tool / end-state-prompt / doc-grounded |
| External reference material | None built-in | None | None | None (external docs in steps) | Read-only `/context/` bundle + BM25 retrieval via `doc_retrieve` |
| Declarative spec format | YAML recipe (Java visitor refs) | None (code only) | YAML rule file | YAML batch spec | YAML recipe with four enforced slots |
| Verification after transform | Relies on user's CI | None built-in | None built-in | Monitors CI on PRs | Differential verification (baseline delta) + LLM Judge + chunk scope enforcement |
| Partial run / resume | Not supported | Not applicable (single CLI run) | Not applicable | Retries individual changesets | Persistent ledger, `agent refactor resume <run-id>` |
| Progress tracking | Per-recipe console output | Console per-file output | Console output | Dashboard (burndown chart, per-changeset status) | `agent refactor status <run-id>` CLI summary |
| Multi-strategy (same tool) | No (always visitors) | No (always AST transform) | No (always pattern+fix) | No | Yes — same runner dispatches three strategies based on recipe |
| Conversational authoring | No (catalog search) | No | No | No | Four-question interview emits recipe draft |
| LLM-backed transformation | No | No | Semgrep Assistant (AI suggestions, not automated) | No | Yes (end-state-prompt + doc-grounded strategies) |

---

## Sources

- Martin Fowler: [Refactoring with Codemods to Automate API Changes](https://martinfowler.com/articles/codemods-api-refactoring.html) — HIGH confidence; composition over monoliths, AST-based transformation, test-driven approach, edge case handling
- OpenRewrite Docs: [Recipes](https://docs.openrewrite.org/concepts-and-explanations/recipes) — HIGH confidence; LST, recipe structure, deterministic visitor pattern
- OpenRewrite Docs: [Getting Started](https://docs.openrewrite.org/running-recipes/getting-started) — HIGH confidence; `rewrite:discover` command, baseline expectations
- Sourcegraph: [Batch Changes Design](https://sourcegraph.com/docs/batch_changes/explanations/batch_changes_design) — HIGH confidence; declarative spec, local execution, reconciliation model
- Sourcegraph: [Tracking Changesets](https://sourcegraph.com/docs/batch-changes/tracking-existing-changesets) — MEDIUM confidence; per-changeset status tracking, burndown chart
- Webflow Engineering: [Codemods and large-scale refactors at Webflow](https://webflow.com/blog/codemods-and-large-scale-refactors-at-webflow) — HIGH confidence; real-world 20,000+ line codemod, test-driven fixtures, staged rollout, "saved some parts for later" pattern
- Semgrep Docs: [Autofix](https://semgrep.dev/docs/writing-rules/autofix) — HIGH confidence; pattern-based fix, dry-run mode, AST-based autofix correctness rates
- jscodeshift GitHub: [facebook/jscodeshift](https://github.com/facebook/jscodeshift) — HIGH confidence; `--dry --print` flags, file-by-file processing, no built-in error code on failure (known limitation)
- DAPLab Columbia University: [9 Critical Failure Patterns of Coding Agents](https://daplab.cs.columbia.edu/general/2026/01/08/9-critical-failure-patterns-of-coding-agents.html) — HIGH confidence; agent context loss at scale, repeated code, cross-component mismatch — directly informs per-chunk isolation requirement
- Toptal: [Refactoring With Codemods and jscodeshift](https://www.toptal.com/developers/javascript/write-code-to-rewrite-your-code) — MEDIUM confidence; jscodeshift transform anatomy, import aliasing edge cases
- Airbnb Engineering: [Turbocharged JavaScript Refactoring with Codemods](https://medium.com/airbnb-engineering/turbocharged-javascript-refactoring-with-codemods-b0cae8b326b9) — MEDIUM confidence; per-slice PRs, codemod coordination overhead
- OpenRewrite GitHub: [rewrite-codemods (jscodeshift bridge)](https://github.com/openrewrite/rewrite-codemods) — MEDIUM confidence; OpenRewrite wrapping jscodeshift codemods as recipes, confirms `rewrite_run` bridge pattern is viable
- PROJECT.md + v3.0-ROADMAP.md (Appendix A Recipe Schema) — HIGH confidence; authoritative source for the v3.0 feature set, constraints, and recipe design decisions

---

*Feature research for: sweeping-refactor / program automator (background-coding-agent v3.0)*
*Researched: 2026-04-08*
