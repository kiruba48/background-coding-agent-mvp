# Pitfalls Research

**Domain:** v3.0 Program Automator — Adding sweeping-refactor / mass-migration capability to an existing single-session background coding agent
**Researched:** 2026-04-08
**Confidence:** HIGH (first-party codebase analysis + verified against external sources for external tooling claims)

---

## Critical Pitfalls

Mistakes that cause RefactorRun state corruption, silent mis-verification, toolchain failures that block whole phases, or architecture decisions that force rewrites before v3.0 ships.

---

### Pitfall 1: Long-Lived Worktree Diverges from Main After Baseline Capture

**What goes wrong:**
A RefactorRun creates one worktree and one branch at run start and keeps them alive across dozens of chunk sessions. Meanwhile, the main branch (`main`) receives unrelated commits from other engineers. By chunk 30, the run's branch is 200+ commits behind `main`. Merge conflicts accumulate silently. When the run eventually opens a PR, the diff is unreadable — it shows everything from chunks AND every missed merge from `main`. The human reviewer can no longer reason about what the agent changed.

A worse variant: the differential verifier captured a baseline at run start against the worktree at commit SHA `abc123`. By chunk 30, unrelated changes on the run's branch (from periodic `git merge main`) have shifted test counts, lint warning counts, and build artifacts. The baseline snapshot is now stale relative to the current worktree state. Differential comparisons produce false positives (new lint warnings that came from a merge, not the agent's chunk).

**Why it happens:**
The single-session agent (v2.4) used ephemeral worktrees removed on completion. v3.0 keeps the worktree alive indefinitely. Nobody considered "what happens to this branch over days." The baseline was designed to be captured once at run start and compared across all chunks — that invariant breaks as soon as a merge happens.

**How to avoid:**
- The RefactorRun's worktree branch must be **append-only during a run** — no merges from main while the run is active. Document this as an invariant in `RefactorRun` schema.
- The baseline snapshot must be **re-captured after any merge** that touches the run's branch. Since merges should not happen mid-run, the safest rule is: forbid `git merge` and `git rebase` on the run's branch while `RefactorRun.status === 'running'`. The runner checks this before each chunk.
- Expose a `agent refactor pause <run-id>` command that allows the user to consciously pause, merge main, re-capture baseline, and resume.
- The `RefactorRun` data model must store both the `baselineSha` (commit at which baseline was captured) and the current `headSha`. If they diverge (a merge happened), the runner detects this and refuses to continue until the user explicitly re-baselines.

**Warning signs:**
- `git log --oneline main..run-branch | wc -l` grows by more than chunk commits between sessions
- The baseline's test count differs from the current worktree's test count at the start of a new session
- Lint warning count in the differential verifier jumps by more than expected for a single chunk

**Phase to address:** Phase 29 (RefactorRun Orchestrator) — the worktree reuse path must include baseline divergence detection from day one. Phase 30 (Differential Verification) must treat a diverged baseline as a blocking error, not a warning.

---

### Pitfall 2: Ledger State Is Corrupted by Process Crash Mid-Chunk

**What goes wrong:**
The per-chunk worker loop: pop pending target → spawn session → on success mark `done` + record commit SHA → on failure mark `failed`. If the host process crashes between "mark `done`" and "commit SHA recorded," the ledger shows the target as done but no commit SHA exists for it. On resume, the orchestrator skips the target (it is `done`) but the expected commit is missing from the branch's history. The run eventually "completes" but the PR is missing changes for that target.

A second variant: the session runs, commits to the worktree, but crashes before the ledger write. On resume, the orchestrator re-pops the same target (it is still `pending`), spawns a new session, and the agent sees the previous commit's changes already in the worktree. It either does nothing (zero-diff, marks failed for wrong reason) or double-applies the transform producing a corrupt result.

**Why it happens:**
The ledger write and the git commit are two separate operations with no atomic coordination. The existing single-session agent did not have a persistent ledger — verification and PR creation were one shot. Introducing a ledger without atomic commit-then-ledger-update is the classic distributed systems mistake.

**How to avoid:**
- **Commit-then-ledger, in that order.** The worker loop must: (1) agent commits to worktree branch, (2) record commit SHA in ledger as `done`. If step 2 crashes, the re-pop on resume will see the target as `pending` and re-run it. The agent will find the prior changes already applied. The agent must be instructed via the prompt: "Check if the target site has already been transformed before applying changes." For deterministic transforms, re-running is idempotent by design. For `end-state-prompt` transforms, instruct the agent to detect prior application.
- **Never update ledger before the agent completes.** The in-progress state (`target.status = 'in-progress'`) is ephemeral — written at chunk start, cleared on crash recovery. Use a PID file on the ledger entry to detect orphaned in-progress entries on resume.
- **The ledger file itself must be written atomically.** Use write-to-temp-then-rename pattern (same as `conf@15` does internally). Never mutate the JSON in place.

**Warning signs:**
- `agent refactor status` shows a target as `done` but `git log --oneline run-branch | grep <target-file>` shows no commit touching it
- Resume after crash re-processes a target and the agent reports "already transformed" or produces a zero-diff
- The ledger JSON is malformed (partial write mid-crash) and the entire run fails to load

**Phase to address:** Phase 29 (RefactorRun Orchestrator) — the data model must define the commit-then-ledger invariant explicitly. Phase 29-01-PLAN.md must include a crash-recovery scenario test.

---

### Pitfall 3: Differential Verification Has No Flaky-Test Awareness — Baseline Is Poisoned

**What goes wrong:**
The baseline is captured at run start. The baseline records: test X passed, test Y passed. Chunk 1 runs. Post-chunk verification sees: test X failed. The differential verifier marks chunk 1 as failed. But test X is a flaky integration test that fails ~15% of the time regardless of code changes. The agent retries up to 3 times; all 3 retries also see test X fail (it is flaky at 15%). The target is marked permanently `failed`. The run completes with 30 skipped targets, all due to flaky baseline.

Worse: the baseline itself was captured when test X happened to pass. A subsequent re-capture (after pausing and re-baselining) also captures it as passed. Every chunk session that runs when test X flakes appears to have caused a regression.

**Why it happens:**
The existing composite verifier treats all test failures as equal. The v2.4 implementation does not know about flakiness. The differential verifier is designed to say "same tests pass" — but "same" is undefined when some tests are non-deterministic.

**How to avoid:**
- Capture the baseline **twice** (two consecutive full test runs) at run start. Tests that differ between the two captures are flagged as `known_flaky` in the baseline. The differential verifier skips known-flaky tests when comparing post-chunk results.
- The `VerifyBlock.baseline` in the recipe schema should support a `flaky_retry_count` field. Default: 2 baseline captures, 1 test run per chunk. For repos with high flakiness, this can be 3 + 2.
- The `test_baseline` capability tool must expose a `--runs N` option that captures N runs and computes the stable-pass set.
- Emit a warning at run start if more than 5% of tests are flagged as `known_flaky` — the repo is too unstable for differential verification. Block the run start unless the recipe explicitly sets `allow_flaky_baseline: true`.

**Warning signs:**
- More than 2 targets marked `failed` in a row all show the same test failing in their failure reason
- `git diff` of the failed chunk shows no changes touching the failing test's source file
- The failing test's name contains `integration`, `e2e`, `flaky`, or `random`

**Phase to address:** Phase 30 (Differential Verification) — the baseline capture must include flaky-detection from the start. Phase 30-01-PLAN.md must specify the dual-capture protocol before writing any comparison logic.

---

### Pitfall 4: LLM Judge Vetoes Legitimate Sweeping Changes Because the Diff Is Large

**What goes wrong:**
The existing LLM Judge (Claude Haiku 4.5) is prompted to detect scope creep. Its training includes: "2000-line diffs are suspicious." A chunk that converts 15 POJOs to records in a single file produces a 400-line diff — all mechanical, all in-scope. The judge sees "400 lines changed" and fires "scope exceeds task description." The chunk is vetoed. The orchestrator marks it `failed` (veto). 60% of all chunks veto.

The refactoring-awareness added in v2.2 helps for single-session tasks but was calibrated for single-file, 50-100 line diffs. The judge's implicit prior is "a generic task changes one thing in one file." Sweeping refactors violate this prior structurally.

**Why it happens:**
The judge was extended in v2.2 with NOT-scope-creep examples for refactoring. But the examples were for small, single-session refactors. The judge has no concept of "this diff is correct for a recipe that says convert all POJOs to records." Without the recipe's transformation spec as scope definition, the judge is evaluating the diff against an empty spec.

**How to avoid:**
- Phase 31 (Judge Scope Injection) must feed the recipe's `transformation.spec` into the judge prompt as the authoritative scope definition. The judge prompt should be restructured: instead of "does this diff exceed the task description?" it should be "does this diff match the transformation spec? Flag only diffs that go **beyond** the spec." This is the inversion of the current framing.
- The judge prompt must explicitly state the strategy context: "This is a `deterministic` / `end-state-prompt` / `doc-grounded` transformation. Diffs matching the strategy are always in scope."
- For `deterministic` transforms: the judge should be bypassed entirely (the diff is produced by a capability tool, not the LLM; no scope judgment needed).
- Add a `chunk_scope.must_touch` and `chunk_scope.must_not_touch` check as a **pre-judge filter**. If the diff only touches files matching `must_touch` and avoids `must_not_touch`, the judge is given that context before rendering a verdict.
- The judge veto rate across reference recipes must be measured in Phase 31's success criteria. A recipe that causes >10% veto rate is a sign of miscalibration.

**Warning signs:**
- Judge veto messages mention "extensive changes" or "goes beyond described scope" for chunks that only touch files matching `chunk_scope.must_touch`
- Judge vetoes a chunk whose diff only contains changes matching the recipe's transformation spec verbatim
- Veto rate increases as chunk size (number of targets per chunk) increases — suggests size bias, not quality signal

**Phase to address:** Phase 31 (Context Bundle Mount + Judge Scope Injection) — this is the primary deliverable of that phase. Phase 31-02-PLAN.md must include a vetoed-diff regression test suite with reference recipes before delivering judge scope injection.

---

### Pitfall 5: Discovery Produces a Non-Deterministic Target List

**What goes wrong:**
The Phase 28 success criterion explicitly requires: "Discovery output is deterministic given the same repo, recipe discovery block, and tool versions." But two runs of the same grep/ast_query discovery on the same repo produce different `targets.json` ordering. On Linux, directory traversal order is inode-dependent. On macOS, HFS+ and APFS have different sort orders. The target list is unsorted.

Why this matters: chunks are processed in ledger order. If two discovery runs produce different orderings, two runs of the same recipe produce different ledger sequences. A target that succeeds on run 1 may fail on run 2 because it appeared in a different chunk that had a different cross-file dependency context.

Second issue: the `custom` discovery tool (LLM-driven discovery) is inherently non-deterministic. The agent may identify 47 targets on one run and 52 on another for the same repo. These extra targets cause "spurious new targets" appearing on resume that were absent from the original ledger.

**Why it happens:**
Filesystem traversal is not sorted by default in ripgrep (`--sort path` must be explicitly passed). tree-sitter AST queries return results in tree-walk order, which is deterministic for a given file but depends on which files are visited and in what order. The `custom` discovery prompt produces LLM output which is temperature-dependent.

**How to avoid:**
- All discovery tools must explicitly sort their output by `file` + `locator` before writing `targets.json`. This must be enforced in the runner, not left to each tool implementation.
- Discovery runs are always the read-only first pass (Phase 27 plumbing reused). The `targets.json` is written once and treated as immutable for the duration of the run. On resume, discovery is never re-run — the existing `targets.json` is loaded as-is.
- For `custom` discovery: set temperature to 0 and require structured JSON output (same pattern as the intent parser). Even so, flag `custom` discovery in the recipe schema docs as "may produce different results across runs due to LLM non-determinism." Warn at run start if the recipe uses `custom` discovery.
- The discovery tool implementations must pass `--sort-files` to ripgrep and sort tree-sitter results by file path + byte offset before returning.

**Warning signs:**
- Two discovery runs on the same repo produce `targets.json` files with different lengths
- Resume of a paused run shows targets in a different order than the original run's ledger
- `targets.json` ordering differs between macOS and Linux CI environments for the same repo

**Phase to address:** Phase 28 (Discovery Pass) — sorting must be built into the discovery output contract, not added later. The success criterion "deterministic output" must be verified with a test that runs discovery twice and diffs the output.

---

### Pitfall 6: WorktreeManager "Reuse Existing" Path Conflicts with Orphan Detection

**What goes wrong:**
v2.4 ships orphan detection: at startup, scan for stale worktrees whose PID is dead and prune them. v3.0 adds a "reuse existing" path to `WorktreeManager`: on `agent refactor resume`, the orchestrator looks up the run's worktree path and calls `WorktreeManager.reuse(path)` instead of `WorktreeManager.create(...)`.

If the host process crashes mid-run and the user later calls `agent refactor resume`, the startup orphan scan runs first. It finds the RefactorRun's worktree: PID is dead (the host was killed). The orphan scan removes it. Then `resume` tries to find the worktree — it is gone. The run's branch still exists in git (the orphan scan removes the directory but calls `git worktree prune`, which only removes the `.git/worktrees/<name>` metadata — not the branch itself). But the worktree directory is gone. `resume` tries `git worktree add <path> <branch>` but the branch exists, which is normally fine, UNLESS the worktree was partially set up before the crash.

**Why it happens:**
The orphan detection logic was written for ephemeral worktrees (v2.4: remove everything on PID dead). RefactorRun worktrees are long-lived and should survive crashes. The same "PID is dead → remove" heuristic that is correct for ephemeral sessions is wrong for persistent RefactorRun worktrees.

**How to avoid:**
- The PID sentinel file must carry a `worktree_kind` field: `ephemeral` (v2.4 single-session) or `persistent` (v3.0 RefactorRun). The orphan scan must skip `persistent` worktrees entirely — only the `agent refactor` commands manage them.
- The `RefactorRun` ledger (not the PID sentinel) is the source of truth for persistent worktrees. On `resume`, check the ledger for the worktree path, verify the path exists (or re-create it via `git worktree add <path> <branch>`), and proceed.
- Add a test: crash-simulate a RefactorRun (kill PID), run startup scan, verify the run's worktree is still present.

**Warning signs:**
- `agent refactor resume` reports "worktree not found" after a crash
- `git worktree list` shows the run's branch is checked out nowhere after a crashed resume attempt
- The orphan scan log shows it removed a worktree whose associated branch still has RefactorRun ledger entries

**Phase to address:** Phase 29 (RefactorRun Orchestrator) — the `worktree_kind` field must be defined in Phase 29-01-PLAN.md (data model) before writing the `WorktreeManager` reuse path in Phase 29-02.

---

### Pitfall 7: Differential Verification Baseline Drifts Due to Formatter-Induced Churn

**What goes wrong:**
The baseline captures lint warning counts by class. On chunk 1, the agent edits a Java file. The `config_edit` or `ast_rewrite` tool writes the file back without running the repo's formatter. The formatter (`spotless`, `prettier`, `gofmt`) considers the reformatting it would apply as "lint differences." The differential verifier sees new lint warnings on untouched lines — the warnings are from formatting, not from the chunk's logic. Chunk 1 fails verification.

Or the reverse: the baseline was captured in an environment where the formatter was not installed. The chunk session runs with the formatter installed (different Docker image layer). Post-chunk verification sees zero lint warnings but the baseline had 50 formatter warnings. The chunk appears to have "fixed" 50 warnings it did not touch.

**Why it happens:**
The composite verifier (v2.4) runs `eslint`, `tsc --noEmit`, and language-specific linters. It does not account for formatter-induced differences. In a single-session run this is acceptable because the baseline and the post-session state are in the same container image. In a multi-session run, the Docker image may be rebuilt between sessions, changing formatter versions.

**How to avoid:**
- The baseline capture and every post-chunk verification must run in the same Docker image version. Pin the Docker image SHA in the `RefactorRun` data model at run start. If the image SHA changes mid-run (updated image), emit a warning and require the user to re-baseline.
- The recipe's `VerifyBlock.baseline` list supports `formatter_diff`. When set, the baseline runs `git diff` after a dry-run formatter pass and stores the expected formatter diff. Post-chunk verification re-runs the same formatter pass and diffs against the stored diff. Only net-new formatter divergences are failures.
- The `config_edit` and `ast_rewrite` capability tools must run the repo's formatter on any file they modify before committing. This is the "clean handoff" invariant: capability tools leave files in a formatter-clean state.

**Warning signs:**
- Post-chunk lint failure report shows warnings on lines not in the chunk's diff
- The failing lint warnings are formatting-style ("trailing whitespace", "indentation") rather than logic warnings
- Lint failure count spikes after a Docker image update mid-run

**Phase to address:** Phase 30 (Differential Verification) and Phase 33 (Capability Toolbox) — Phase 30 must specify formatter-aware baseline capture; Phase 33 must enforce post-edit formatter invocation in `config_edit` and `ast_rewrite`.

---

### Pitfall 8: tree-sitter ABI Version Mismatch Between Host and Sandbox

**What goes wrong:**
The `ast_query` / `ast_rewrite` tools in Phase 33 use tree-sitter Node.js bindings. The Docker sandbox runs `node:20-alpine`. The tree-sitter npm package bundles pre-compiled native bindings (`.node` files). The `tree-sitter-java` grammar was compiled against tree-sitter-cli 0.22.x. The runtime `tree-sitter` package in the sandbox is 0.21.x. The ABI versions are incompatible. On first `ast_query` call in a session, the sandbox crashes with `Error: Module version mismatch. Expected X, got Y.`

A second variant documented in the tree-sitter GitHub issue tracker (#3095, #4234): grammars compiled with tree-sitter-cli 0.25+ use ABI version 15, but the tree-sitter Node.js runtime 0.21.x only supports ABI up to 14. All grammar queries silently return empty results rather than throwing, because the language is loaded with a compatibility shim that ignores unsupported node types.

**Why it happens:**
Node.js native modules are ABI-sensitive. Alpine musl libc differs from glibc in ways that affect pre-compiled `.node` binaries — some binaries compiled for glibc will load on Alpine only because musl has a glibc compatibility layer, but that layer is incomplete. The combination of Alpine + musl + tree-sitter native bindings + grammar grammar-version mismatches is a documented failure mode (tree-sitter/node-tree-sitter#169).

**How to avoid:**
- Pin `tree-sitter` and all language grammar packages (`tree-sitter-java`, `tree-sitter-typescript`, etc.) to exact versions in the sandbox Docker image. Never use `latest`. The version matrix must be tested at image build time.
- Use `node:20-bullseye-slim` (Debian-based) for the sandbox layer that runs AST tools, not Alpine, to avoid musl compatibility issues with native bindings. The Alpine base can be used for the outer layer but the AST execution environment must be glibc-based.
- At image build time, run a smoke test: `require('tree-sitter'); require('tree-sitter-java'); parser.parse('class Foo {}')` — if the parse result is null or throws, the build fails.
- The capability toolbox plan (Phase 33-02) must specify the exact version matrix and smoke test as a build gate.

**Warning signs:**
- `ast_query` returns an empty result on a file that obviously contains matching nodes
- The `ast_rewrite` tool runs without error but produces no output diff
- Docker image build logs show native module compilation errors or warnings during `npm install`
- Any `Module version mismatch` error in sandbox logs

**Phase to address:** Phase 33 (Capability Toolbox) — Phase 33-02-PLAN.md must specify the Node.js base image (not Alpine) and version pins for tree-sitter packages before writing any AST tool implementation.

---

### Pitfall 9: OpenRewrite / jscodeshift Invoked via `rewrite_run` Makes Network Calls in an Air-Gapped Sandbox

**What goes wrong:**
The `rewrite_run` tool invokes OpenRewrite (Maven plugin) or jscodeshift by recipe ID. OpenRewrite's Maven plugin, when invoked, fetches recipe artifacts from Maven Central (or Moderne's registry) if the artifact is not already in the local Maven cache. The sandbox has `iptables` rules that only allow `api.anthropic.com`. Maven Central is blocked. The `mvn rewrite:run` invocation hangs for 30 seconds waiting for a TCP timeout, then fails with a connection error. The chunk marks as `failed` with a non-actionable "connection refused" error message.

Semgrep compounds this: when semgrep is invoked with a registry rule ID (e.g., `--config p/python`), it fetches the ruleset from `semgrep.dev`. This is a documented open issue in the Semgrep repo (issue #3147, #8793). Even with `--config ./local-rules.yaml`, semgrep makes a version-check network call on startup in some versions.

**Why it happens:**
The iptables isolation was designed around the Claude Agent SDK's needs (one outbound host: `api.anthropic.com`). Tool invocations that themselves need network access are not accounted for. The Phase 33 roadmap says "toolchain pre-seeded in the sandbox image, no network required" — but pre-seeding only solves the binary, not the recipe artifact fetch.

**How to avoid:**
- For OpenRewrite: pre-seed the Maven local repository (`.m2/cache`) in the Docker image at build time. Run `mvn rewrite:run -Drewrite.recipe=<id> -o` (offline mode) as part of the image build against a dummy project. This populates `.m2/cache` with all recipe artifacts. The runtime invocation then uses `-o` (offline) flag, which fails fast if a recipe is not cached rather than hanging.
- For jscodeshift: bundle the transform scripts in the image. No registry fetch occurs — transforms are invoked by local file path, not npm package name.
- For semgrep: use only local rule files (`--config ./rules/`) and pin the semgrep version to one that does not make version-check calls (verified in the image build smoke test). Document which semgrep versions are verified clean.
- The `rewrite_run` tool's invocation contract must document: "recipe IDs must be pre-seeded in the sandbox image; recipes not in the image will fail immediately, not hang." This is enforced by the `-o` flag and a pre-flight check at tool invocation time.

**Warning signs:**
- `mvn rewrite:run` taking >5 seconds before any output (network wait)
- Chunk failures with "Unable to access jarfile" or "Connection timed out: api.maven.org"
- Semgrep failures with "Registry connection failed" or similar
- The sandbox image build does not include a smoke test for `rewrite_run` invocation in offline mode

**Phase to address:** Phase 33 (Capability Toolbox) — Phase 33-03-PLAN.md. The Docker image build process for `rewrite_run` must include: offline Maven cache pre-seeding, semgrep local-rules-only constraint, and smoke tests for all three tools (OpenRewrite, jscodeshift, semgrep) in no-network mode.

---

### Pitfall 10: YAML Comment Preservation Fails in `config_edit` — Roundtrip Destroys Formatting

**What goes wrong:**
The `config_edit` tool is described as "roundtrip-safe YAML/JSON edits with optional JSON-Schema validation (preserves comments, formatting)." The recipe runs `config_edit` to update `image.tag` in `values.yaml`. The file contains 40 lines of comments (Helm chart documentation). The tool parses the YAML, modifies `image.tag`, and serializes back. The serializer is `js-yaml`. Comments are stripped. Formatting changes (e.g., quoted strings become unquoted, inline maps become block maps). The resulting `values.yaml` diff is 200 lines, not 2 lines. The `formatter_diff` invariant fires. The chunk fails.

**Why it happens:**
`js-yaml` does not support comment preservation — documented in its GitHub issues and confirmed by performance benchmarks (600ms for `yaml` library vs 64ms for `js-yaml`). The `yaml` library (eemeli/yaml) supports comment preservation via roundtrip mode but is significantly slower. For large YAML fleets (100+ files per run), the performance difference matters.

**How to avoid:**
- Use the `yaml` npm package (eemeli/yaml), not `js-yaml`, for the `config_edit` tool. Its `parseDocument()` API supports roundtrip editing that preserves comments, anchors, and formatting.
- Wrap the YAML roundtrip with a property: after `config_edit` runs, the only lines that differ in `git diff` must be the targeted key-value pairs. Enforce this in the `config_edit` unit tests: load a complex YAML file with comments, edit one key, serialize, assert that only that key's line changed.
- For JSON: use `jsonc-parser` (roadmap already specifies this) which preserves comments in JSONC files. For strict JSON (no comments), standard `JSON.parse` / `JSON.stringify` with 2-space indent is sufficient.
- Do not use AST rewrite tools for YAML config edits — tree-sitter's YAML grammar does not preserve formatting reliably across all YAML flavors.

**Warning signs:**
- `config_edit` on a YAML file produces a diff with comment lines removed
- `git diff` after `config_edit` shows formatting changes on lines not containing the target key
- The `formatter_diff` invariant fails on files that `config_edit` touched but did not logically change

**Phase to address:** Phase 33 (Capability Toolbox) — Phase 33-01-PLAN.md. The `config_edit` unit tests must include a roundtrip test with a commented YAML file before the implementation is written. Library choice (`yaml` not `js-yaml`) must be locked in the plan.

---

### Pitfall 11: Chunking Strategy Ignores Cross-File Import Dependencies

**What goes wrong:**
A recipe uses `per-file` chunking strategy. Chunk 1 transforms `Foo.java` — renaming a method from `getBar()` to `bar()`. Chunk 1 commits. The worktree now has `Foo.java` with `bar()` but all callers still reference `getBar()`. Chunk 2 picks up `ServiceA.java` (a caller). The agent is given `ServiceA.java` as its target. But the verifier runs the full build — it fails because `Foo.java`'s method was renamed and `ServiceB.java`, `ServiceC.java` (not yet transformed) still call `getBar()`. The entire build is broken mid-run. Chunks 2 through N all fail verification because chunk 1 introduced a build-breaking rename before all callers were updated.

**Why it happens:**
`per-file` chunking processes files independently. For structural refactors that change public APIs (method renames, class renames, signature changes), the transformation must happen either atomically (all callers in one chunk) or in the correct dependency order (definition last, not first). The recipe author specified `per-file` without considering call-site dependencies.

**How to avoid:**
- The recipe schema's `ChunkingBlock` must document: "For API-changing transforms, use `grouped` strategy with `group_by: module` or specify a topological order via the discovery block." The runner emits a warning if `transformation.spec` contains words like "rename", "move", "replace", and `chunking.strategy` is `per-file`.
- For the reference recipe (POJO to records), the transform preserves the public API — method names are unchanged, getters remain as forwarding methods. The recipe spec must explicitly state "preserve the public API exactly." Phase 32's reference recipes must validate this.
- The `VerifyBlock.chunk_scope.must_not_touch` constraint can enforce this: if `must_not_touch: ["**/*Caller*.java"]`, then the chunk's diff is rejected if it modifies callers without modifying the definition — a signal that the agent is attempting an API-changing operation.
- As a fallback: the `grouped` strategy with `group_by: directory` processes all files in a directory as one chunk, which handles intra-package dependencies for Java.

**Warning signs:**
- Build failure after chunk N with errors in files not in chunk N's target list
- The failing build error message references a method, class, or symbol that was transformed in a prior chunk
- The recipe spec includes the word "rename" but `chunking.strategy` is `per-file`

**Phase to address:** Phase 28 (Discovery Pass) and Phase 32 (Recipe Format + Recipe Runner) — Phase 28's `targets.json` should include a `depends_on` field for known cross-file dependencies. Phase 32's runner must emit a warning when the strategy/spec combination is likely to produce mid-run build breaks.

---

### Pitfall 12: Read-Only Context Bundle Is Accidentally Writable or Index Is Stale

**What goes wrong:**
The context bundle is mounted at `/context/` with `:ro` inside the sandbox. The `doc_retrieve` tool builds a BM25 index over the bundle at first call — it needs to write the index file. If the mount is `:ro`, the index write fails and `doc_retrieve` returns empty results silently (no error surface). The agent proceeds without retrieval context. For `doc-grounded` recipes, this silently degrades every chunk to a generic `end-state-prompt` chunk.

The opposite failure: the BM25 index is pre-built and stored inside the bundle directory, which is then mounted `:ro`. Between the index build and the mount, the bundle files change (the user updates the migration guide). The index is now stale — `doc_retrieve` returns results from the old guide. The agent follows outdated migration instructions and the resulting code is incorrect.

**Why it happens:**
The bundle is user-controlled content. The index is derived content. Storing the index inside the bundle conflates user content with agent-derived cache. The `:ro` mount enforcement (added for security in Phase 31) prevents the index write, which breaks the tool silently.

**How to avoid:**
- Store the BM25 index **outside** the bundle directory, in the `RefactorRun`'s state directory (e.g., `~/.bg-agent/runs/<run-id>/context-index/`). The index is mounted read-write separately from the `:ro` bundle mount. The `doc_retrieve` tool is given both mount paths.
- Rebuild the index at run start (not lazily on first call). Include the bundle directory's content hash in the `RefactorRun` data model. On resume, if the content hash has changed, emit a warning and offer to re-index.
- The `doc-grounded` recipe strategy must fail loudly (not silently) if `doc_retrieve` returns zero results. Add a pre-flight check: before starting chunk sessions for a `doc-grounded` recipe, verify `doc_retrieve` with a known query term from the bundle returns at least one result.

**Warning signs:**
- `doc_retrieve` returns zero results for queries that obviously match bundle content
- The agent in a `doc-grounded` session never calls `doc_retrieve` despite the prompt referencing the context bundle
- The RefactorRun state directory does not contain an index subdirectory after run start

**Phase to address:** Phase 31 (Context Bundle Mount) and Phase 33 (Capability Toolbox) — Phase 31 must specify the two-mount pattern (`:ro` bundle + `:rw` index path) and Phase 33 must implement the pre-flight retrieval check in `doc_retrieve`.

---

### Pitfall 13: Recipe Schema Accumulates a Fifth Slot Under Feature Pressure

**What goes wrong:**
Phase 32 ships with four slots: discovery, transformation, verification, context. During Phase 33 or 34, a user needs "post-processing" (run a formatter on all changed files after the run completes). Someone adds a `postprocess` slot to the schema. Then a Phase 34 user needs "pre-flight" (validate environment before starting). A `preflight` slot is added. By v3.1, the schema has 7 slots, the runner has 7 dispatch paths, and "adding a new task type is writing a recipe" has become "adding a new task type requires understanding 7 slots and their interaction."

**Why it happens:**
The four-slot constraint ("resist adding a fifth") is a design note in the roadmap appendix but is not enforced by any mechanism. Under time pressure, adding a slot is the path of least resistance. The runner's dispatch logic is easy to extend — there is no natural stopping point.

**How to avoid:**
- The rule is explicit in the roadmap: "Every new field should land inside one of the existing slots or be rejected as out-of-scope." Enforce this as an architectural review gate in Phase 32's plan — any PR that adds a top-level key to the recipe schema requires explicit justification and a ROADMAP.md update explaining why no existing slot could accommodate the need.
- `postprocess` belongs in `verification.invariants` (e.g., "formatter produces identical output on all changed files" — the formatter is run as part of verification, not as a separate slot).
- `preflight` belongs in `discovery` (a `custom` discovery that validates environment state and emits zero targets if preconditions are unmet, which aborts the run with a clear message).
- The Zod schema (Phase 32-01) must have `strict()` on the top-level object — any unknown key at the top level is a validation error, not silently ignored. This makes unauthorized slot additions immediately visible.

**Warning signs:**
- A PR adds a new top-level key to the recipe YAML schema without updating the roadmap
- The runner's `executeRecipe()` function gains a new `if/else` branch for a top-level key that is not discovery/transformation/verification/context
- The recipe authoring interview (Phase 34) asks more than four questions

**Phase to address:** Phase 32 (Recipe Format) — the Zod schema's `strict()` call is the mechanical enforcement. The architectural review gate must be documented in Phase 32's plan as an explicit success criterion.

---

### Pitfall 14: `agent refactor resume` Commits to the Wrong Branch After a Crash

**What goes wrong:**
A RefactorRun is running on branch `refactor/pojos-to-records-a3f2b1c9`. The host crashes. The user calls `agent refactor resume <run-id>`. The `WorktreeManager.reuse()` path reconstructs the worktree. But there is a subtle bug: the `git worktree add` call uses `<branch>` from the ledger but the current HEAD of the main repo has advanced. The worktree is created at the new HEAD rather than at the run's last committed SHA. The first post-crash chunk now has a different base than all prior chunks — it sees all the new commits from `main` merged in. The differential verifier fires immediately (new tests from `main` not in the baseline). The chunk fails. The entire resumed run is blocked.

A rarer incident-style failure: the `WorktreeManager.reuse()` resolves the path from the run ID but the RefactorRun ID collides with another run (two runs with similar names). The wrong run's worktree path is returned. The resumed session commits to the wrong branch. This is the "wrong branch commit" incident.

**Why it happens:**
The "reuse existing" path for `WorktreeManager` was not written in v2.4 — it is a new code path in v3.0 with no prior implementation history. Subtle bugs in branch resolution, SHA verification, and ledger-to-worktree mapping are predictable first-implementation failures.

**How to avoid:**
- The `WorktreeManager.reuse()` method must verify: (1) the worktree path exists and is a git worktree, (2) `git -C <path> rev-parse HEAD` equals `RefactorRun.lastCommitSha` (the SHA of the last successful chunk commit), (3) `git -C <path> branch --show-current` equals `RefactorRun.branch`. If any check fails, log and throw — do not proceed silently.
- Run IDs must be globally unique (UUID v4, not sequential integers or name-based strings). The ledger uses the run ID as its primary key. The worktree directory path includes the run ID.
- Add a `agent refactor verify <run-id>` command (or include it in `resume`) that prints the worktree state, current HEAD SHA, and ledger state before starting chunk processing. Useful for post-crash diagnosis.

**Warning signs:**
- Resumed run's first chunk fails with differential verification errors unrelated to the chunk's target
- `git -C <worktree-path> log --oneline -5` shows commits from `main` not in the run's prior history
- Two concurrent RefactorRuns have similar but not identical IDs (sequential numbering)

**Phase to address:** Phase 29 (RefactorRun Orchestrator) — Phase 29-03-PLAN.md (resume and crash recovery) must include the three-check verification protocol and UUID-based run IDs as success criteria.

---

### Pitfall 15: Recipe Authoring UX Produces Syntactically Valid but Semantically Broken Recipes

**What goes wrong:**
Phase 34's four-question interview produces a recipe draft. The user confirms it. The recipe validates against the Zod schema (no structural errors). But the `discovery.query` is a tree-sitter query with a typo: `(class_declaration name: (identifier) @class.name)` instead of the valid `(class_declaration name: (identifier) @name)`. The schema cannot validate tree-sitter query syntax. The discovery pass runs, returns zero targets (query parses but matches nothing), the ledger shows zero pending items, and the run completes immediately with "0 targets found." The user thinks the repo has nothing to refactor.

A second variant: the user answers "what should it become?" with "make it faster" — a subjective instruction. The interview emits `transformation.spec: "make it faster"` — valid schema, but the agent will produce wildly varying and unreviewable chunk results. The LLM Judge has no recipe spec grounding for "faster" and cannot calibrate its scope judgment.

**Why it happens:**
YAML schema validation catches structural errors (wrong key names, wrong types). It cannot validate semantic correctness of tool-specific parameters (query syntax, strategy spec quality). The interview collects four answers and maps them to recipe slots without evaluating whether the answers are coherent.

**How to avoid:**
- For tree-sitter queries: run a syntax validation at recipe load time using `tree-sitter`'s own parser to verify the query string parses without error. Emit a clear error: "Invalid ast_query query syntax at discovery.query: <error message>." Do not rely on "zero results" as the signal.
- For transformation specs: the interview must include a quality check step. After the user answers "what should it become?", the Phase 34 scoping dialogue sends the answer to the LLM with: "Is this a concrete, mechanical transformation that can be expressed as an end-state description? Answer YES or NO with reason." If NO, re-prompt the user.
- Add a `agent refactor dry-run <recipe.yaml> --repo <path>` command that runs discovery-only against a real repo and reports the target count and sample targets. This closes the feedback loop before the user commits to a full run.
- The human-readable recipe summary (Phase 34 success criterion 3) must include the discovery target count from a dry-run, not just the schema fields.

**Warning signs:**
- A run completes with "0 targets found" for a repo that obviously contains the targeted pattern
- The agent's chunk outputs vary widely in scope (some mechanically correct, some making unrelated changes) for the same recipe
- The user reports "it did nothing" after a successful run

**Phase to address:** Phase 34 (Conversational Recipe Authoring) — schema validation extensions (query syntax check, spec quality check, dry-run command) must be in the Phase 34 success criteria, not deferred.

---

## Technical Debt Patterns

Shortcuts that seem reasonable but create long-term problems.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Reuse `ephemeral` orphan cleanup logic for RefactorRun worktrees | No new code needed | Crash recovery removes the run's worktree; resume fails | Never — persistent and ephemeral worktrees need distinct PID sentinel kinds |
| Capture baseline once at run start and never re-capture | Simple implementation | Baseline is stale after any merge; flaky tests appear as regressions in every chunk | Never — baseline must be invalidated on worktree branch change |
| Use `js-yaml` for config_edit (it is already in node_modules) | Faster implementation | Comment destruction fails `formatter_diff` invariants; YAML files balloon in diff | Never — use `eemeli/yaml` for all roundtrip config edits |
| Use Alpine for the AST tool sandbox layer | Smaller Docker image | Native tree-sitter bindings may fail on musl; grammar ABI mismatches are silent | Never for AST tools — use Debian-slim for glibc compatibility |
| Pre-build OpenRewrite image without offline Maven cache | Faster image build | First `rewrite_run` invocation hangs for 30s on network timeout | Never — always pre-seed Maven cache with `-o` flag smoke test |
| Allow `custom` discovery to re-run on resume | Catches new targets added since run start | Non-deterministic target lists; targets that were `done` may re-appear as new targets | Never — discovery output is immutable for a run's lifetime |
| Add a fifth top-level slot to the recipe schema for "postprocess" | Cleaner UX for formatting hooks | Schema complexity grows quadratically with slots; runner dispatch paths multiply | Never — postprocess belongs in verification.invariants |
| Skip judge for deterministic transform chunks ("it is mechanical, no scope creep possible") | Lower API cost | Deterministic tools can still make scope-violating edits if misconfigured | Acceptable — skip judge for `deterministic` strategy only, after Phase 31 judge scope injection is live |

---

## Integration Gotchas

Common mistakes when wiring v3.0 components into the existing pipeline.

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| `WorktreeManager.reuse()` ↔ `RefactorRun` | Re-create worktree at main HEAD on resume | Verify `git -C <worktree> rev-parse HEAD` matches `RefactorRun.lastCommitSha` before chunk processing |
| `compositeVerifier` ↔ differential baseline | Compare against absolute green | Compare against baseline snapshot: only new failures since `baselineSha` are blockers |
| LLM Judge ↔ sweeping-refactor chunks | Current judge prompt evaluates diff size as a proxy for scope | Pass `transformation.spec` as explicit scope definition; invert framing to "does diff match spec?" |
| `doc_retrieve` ↔ `:ro` context bundle | Write BM25 index inside bundle directory | Write index to `RefactorRun` state directory; mount bundle `:ro` and index path `:rw` separately |
| `rewrite_run` ↔ iptables network isolation | Maven/semgrep network calls hang | Pre-seed Maven cache at image build time; use `-o` flag; verify in smoke test at build |
| Discovery output ↔ ledger | Unsorted `targets.json` produces non-deterministic processing order | Enforce sort-by-(file, locator) in discovery runner before writing `targets.json` |
| Ephemeral worktree orphan scan ↔ RefactorRun worktrees | Orphan scan removes live RefactorRun worktrees after host crash | PID sentinel `worktree_kind` field distinguishes ephemeral from persistent |
| Recipe Zod schema ↔ tree-sitter query strings | Schema validates type (string) not syntax | Add query-syntax validation at recipe load time for `ast_query` discovery |
| Intent parser ↔ `sweeping-refactor` task type | "modernize all POJOs" classified as `generic` | Add sweeping-refactor fast-path verbs: "modernize all", "migrate all", "convert all", "replace all occurrences" |
| `test_baseline` / `test_compare` ↔ flaky tests | Single baseline capture treats all failures as stable | Dual-capture protocol: stable-pass set = tests passing in both runs |

---

## Performance Traps

Patterns that work at small scale but fail as usage grows.

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Per-chunk Docker container spin-up for 200-target run | 200 × 3-5s container start = 10-16 minutes overhead, before any work | Container reuse within a RefactorRun session (reuse the same container across multiple chunks if recipe is per-file on same module) | From first run with >50 targets |
| BM25 index rebuilt from scratch at each `doc_retrieve` call | First retrieval takes 2-5s on large bundles; timeout on slow IO | Build index once at run start, cache on disk in run state directory | Bundles >10MB or chunks running concurrently |
| OpenRewrite invoked per-chunk with full Maven project reload | JVM startup + dependency resolution = 20-30s per chunk | Cache the OpenRewrite LST (Lossless Semantic Tree) between chunks in the run; use `rewrite:run` with `--cacheLST` flag | From first run with >10 Java files |
| Discovery with `custom` (LLM-driven) runs a full agent session | Adds 60-120s to run start for a task that could use `grep` | Always prefer deterministic discovery (`grep`, `ast_query`, `config_query`) over `custom`; `custom` is for genuinely complex discovery only | Any run where `custom` discovery is used |
| Differential verifier runs full test suite after every chunk | 200-chunk run × 5-minute test suite = 16 hours | Use `VerifyBlock.test_filter` to limit baseline to tests relevant to the transformed files; use `test_compare` tool for scoped diff | Repos with test suites >2 minutes |

---

## Security Mistakes

Domain-specific security issues in v3.0.

| Mistake | Risk | Prevention |
|---------|------|------------|
| Context bundle contains secrets (API keys, certs) accidentally mounted at `/context/` | Agent reads secrets, includes in `finalResponse`, secrets logged to structured JSON | Scan bundle at mount time for common secret patterns (AWS key regex, PEM headers); warn and block if found |
| Recipe YAML includes arbitrary `bash` in `transformation.args` for a deterministic recipe | Shell injection via recipe file that user hand-edited | Zod schema's `args` field must use a typed union (not `Record<string, unknown>`); no raw shell strings in deterministic recipes |
| `rewrite_run` recipe ID resolves to a network-fetched artifact (semgrep registry rule) at runtime | Network exfiltration via rule fetch in air-gapped sandbox | Enforce that `rewrite_run` invocation uses only pre-registered (build-time) recipe IDs; reject unknown IDs at tool call time |
| RefactorRun ledger stored in world-readable location (`/tmp/`) | Ledger exposes file paths, commit SHAs, and task descriptions | Store ledger in `~/.bg-agent/runs/` with `0600` permissions (user-only read/write) |
| Long-lived worktree branch accumulates agent commits with no review gate | Agent PRs opened for 200 commits without human visibility | Enforce `max_chunks_before_review` in `EnvelopeBlock` (default: 20); pause run and require human PR review before continuing |

---

## UX Pitfalls

Common user experience mistakes in v3.0.

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| `agent refactor status` shows raw ledger JSON | User cannot understand run progress | Show human-readable summary: "47/200 targets done, 3 failed, 150 pending; last commit: <sha>; estimated completion: Xm" |
| Run starts with zero targets and exits silently | User thinks the run worked; recipe had a query bug | Emit loud warning: "Discovery found 0 targets. Verify your recipe's discovery block." and exit non-zero |
| Failed chunks list shows "verification failed" with no detail | User cannot distinguish flaky test from real regression | Include: failing test names, file diff scope, whether the failure was in a file the chunk touched |
| Resume after crash shows no progress indicator | User does not know if resume worked or is stuck | Emit per-chunk progress line: "[29/30] Resuming: processing ServiceB.java (target 29 of 200)" |
| Four-question interview produces recipe user cannot understand | User confirms without reading; incorrect recipes run against production code | Show human-readable summary of recipe semantics (not raw YAML) before confirmation; include "dry-run first" prompt |

---

## "Looks Done But Isn't" Checklist

Things that appear complete but are missing critical pieces.

- [ ] **RefactorRun crash recovery:** Verify that after `kill -9` mid-chunk, `agent refactor resume` correctly identifies the in-progress target, re-processes it, and the final run has no missing commits compared to a crash-free run
- [ ] **Differential baseline flaky-test awareness:** Verify that a known-flaky test does not block chunks — capture baseline twice, confirm the stable-pass set excludes the flaky test, confirm the flaky test's failure in a post-chunk run does not mark the chunk as failed
- [ ] **Judge scope injection:** Verify that a 400-line diff matching the recipe's `transformation.spec` exactly is NOT vetoed — requires a regression test in Phase 31's vetoed-diff suite
- [ ] **Deterministic discovery:** Verify that two discovery runs on the same repo produce byte-identical `targets.json` — test on both macOS and Linux (different filesystem ordering)
- [ ] **`rewrite_run` offline:** Verify that `mvn rewrite:run` in the sandbox with iptables isolation completes without any TCP connection attempts — confirmed by `strace` or Docker network audit in the image smoke test
- [ ] **YAML comment preservation:** Verify that `config_edit` on a 40-line YAML file with 20 comment lines only changes the targeted key's value line — confirmed by unit test with `git diff` assertion
- [ ] **Worktree kind sentinel:** Verify that startup orphan scan does NOT remove a RefactorRun's persistent worktree after the host is killed and restarted
- [ ] **Recipe schema strict mode:** Verify that adding an unknown top-level key to a recipe YAML produces a validation error, not silent acceptance
- [ ] **Context bundle read-only enforcement:** Verify that an agent in a `doc-grounded` session cannot write to `/context/` — confirmed at PreToolUse hook level AND Docker mount level
- [ ] **Cross-file import dependency warning:** Verify that a recipe with `transformation.spec` containing "rename" and `chunking.strategy: per-file` emits a warning before run start

---

## Recovery Strategies

When pitfalls occur despite prevention, how to recover.

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Baseline diverged after unintended merge | MEDIUM | `agent refactor pause <run-id>`; `git reset --hard <pre-merge-sha>` to undo the merge; `agent refactor rebaseline <run-id>` to re-capture baseline; `agent refactor resume` |
| Ledger corrupted (malformed JSON after crash) | MEDIUM | Load the ledger's last-good backup (the atomic write pattern produces `.bak` on each write); or reconstruct from `git log` on the run's branch: `done` targets are those with a commit touching the target file |
| Judge over-vetoing (>50% of chunks vetoed) | LOW | Pause run; verify Phase 31 judge scope injection is active; check that `transformation.spec` is in the judge prompt by examining logs; re-run vetoed chunks with `agent refactor retry <run-id> --failed-only` after fixing judge prompt |
| Discovery returned zero targets (query bug) | LOW | Fix the recipe YAML; delete the run; restart. Discovery is the first step — no work has been committed. Cost is only the time to re-discover. |
| `rewrite_run` hanging on network (missing offline mode) | LOW | Kill the run; rebuild sandbox image with Maven cache pre-seeding; restart run from ledger (resume will re-process failed chunks) |
| tree-sitter ABI mismatch (silent empty results) | HIGH | Rebuild image with correct version pins; all chunks that used `ast_query` or `ast_rewrite` must be marked `failed` in ledger and re-processed — requires auditing which chunks had zero-diff results |
| Agent committed to wrong branch (branch resolution bug) | HIGH | `git log <wrong-branch>` to identify commits; `git cherry-pick` range onto correct branch; `git reset --hard <pre-incident-sha>` on wrong branch; requires manual ledger reconciliation |
| Context bundle stale (BM25 index from old guide) | MEDIUM | Stop run; update bundle; delete index cache from run state directory; resume — index is rebuilt at next `doc_retrieve` call |

---

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Long-lived worktree diverges from main | Phase 29 (RefactorRun Orchestrator) | `RefactorRun` data model includes `baselineSha` and divergence check; test: simulate merge on run branch, verify orchestrator refuses to process next chunk |
| Ledger corruption on crash | Phase 29 (RefactorRun Orchestrator) | Crash-recovery test: kill-9 mid-ledger-write; verify load succeeds from atomic backup |
| Flaky-test baseline poisoning | Phase 30 (Differential Verification) | Dual-capture test: inject a flaky test; verify it appears in `known_flaky` set; verify it does not block chunks |
| Judge over-vetoing sweeping changes | Phase 31 (Judge Scope Injection) | Vetoed-diff regression test suite: 400-line mechanical diff matching spec must not veto |
| Non-deterministic discovery | Phase 28 (Discovery Pass) | Determinism test: two discovery runs on same repo produce byte-identical `targets.json` |
| Orphan scan removes RefactorRun worktree | Phase 29 (RefactorRun Orchestrator) | Worktree kind sentinel test: persistent worktree survives orphan scan after host kill |
| Formatter-induced diff churn | Phase 30 + Phase 33 | `formatter_diff` invariant test: config_edit on commented YAML changes only target key |
| tree-sitter ABI mismatch | Phase 33 (Capability Toolbox) | Image build smoke test: ast_query on fixture Java file returns non-empty results |
| `rewrite_run` network hang | Phase 33 (Capability Toolbox) | Offline smoke test: `mvn rewrite:run -o` in no-network container completes in <30s |
| YAML comment destruction | Phase 33 (Capability Toolbox) | Unit test: roundtrip edit on commented YAML only diffs the target key line |
| Cross-file import dependency breaks build | Phase 28 + Phase 32 | Warning test: recipe with "rename" spec + per-file strategy emits warning before run start |
| Stale context bundle index | Phase 31 + Phase 33 | Pre-flight test: `doc_retrieve` with known query returns >0 results before first chunk starts |
| Recipe schema creep (fifth slot) | Phase 32 (Recipe Format) | Zod `strict()` test: unknown top-level key produces validation error |
| Wrong branch commit on resume | Phase 29-03 (Resume + Crash Recovery) | Three-check verification test: WorktreeManager.reuse() throws on SHA mismatch |
| Semantically invalid recipe from interview | Phase 34 (Recipe Authoring) | Dry-run gate: confirmed recipe must return >0 targets before run starts |

---

## Sources

- [tree-sitter/node-tree-sitter issue #169 — Node module version mismatch](https://github.com/tree-sitter/node-tree-sitter/issues/169) — ABI version mismatch between tree-sitter runtime and grammar binaries — HIGH confidence (first-party issue tracker)
- [tree-sitter/tree-sitter issue #3095 — Rust binding incompatibility](https://github.com/tree-sitter/tree-sitter/issues/3095) — version-specific Language type mismatch across crate versions — HIGH confidence
- [tree-sitter/tree-sitter issue #4234 — Node tests fail after CLI upgrade](https://github.com/tree-sitter/tree-sitter/issues/4234) — grammar regeneration breaks bindings on 0.25.2 — HIGH confidence
- [semgrep/semgrep issue #3147 — Cache rulesets for offline use](https://github.com/semgrep/semgrep/issues/3147) — semgrep rule registry always downloaded at runtime; offline not supported — HIGH confidence (first-party issue tracker)
- [semgrep/semgrep issue #8793 — Offline execution](https://github.com/semgrep/semgrep/issues/8793) — confirmed network calls even with `--metrics=off` and local config — HIGH confidence
- [eemeli/yaml discussions #358 — Performance comparison yaml vs js-yaml](https://github.com/eemeli/yaml/discussions/358) — 600ms vs 64ms; only `yaml` library supports comment preservation — HIGH confidence (official project discussion)
- [Git worktree conflicts with AI agents — Termdock](https://www.termdock.com/en/blog/git-worktree-conflicts-ai-agents) — lockfile divergence, shared .git object DB contention, concurrent git operation corruption — MEDIUM confidence (blog, verified against git docs)
- [Git worktrees for parallel AI coding agents — Upsun](https://devcenter.upsun.com/posts/git-worktrees-for-parallel-ai-coding-agents/) — per-task worktree recommendation, merge-early patterns, additive-only change strategies — MEDIUM confidence
- [Augment Code — Git worktrees for parallel AI agent execution](https://www.augmentcode.com/guides/git-worktrees-parallel-ai-agent-execution) — concurrent npm install lockfile divergence in separate worktrees — MEDIUM confidence
- [Modern Tree-sitter, part 7: pain points — Pulsar Blog](https://blog.pulsar-edit.dev/posts/20240902-savetheclocktower-modern-tree-sitter-part-7/) — ABI compatibility, node bindings fragility — MEDIUM confidence
- [Patreon TypeScript migration — 7 years, 11,000 files](https://www.patreon.com/posts/seven-years-to-152144830) — real-world large-scale codemod: chunking challenges, cross-file dependency ordering, intermediate broken states — HIGH confidence (primary source)
- [Develocity Flaky Test Detection Guide](https://docs.gradle.com/develocity/current/guides/flaky-test-detection-guide/) — flaky test detection patterns, quarantine strategies — HIGH confidence (official Gradle docs)
- [OpenRewrite Maven plugin documentation](https://docs.openrewrite.org/reference/rewrite-maven-plugin) — offline mode (`-o`), LST caching, recipe artifact resolution — HIGH confidence (official docs)
- [Node.js on Alpine — musl vs glibc discrepancies](https://labs.iximiuz.com/tutorials/how-to-choose-nodejs-container-image) — Alpine node images are experimental; musl/glibc differences affect native modules — MEDIUM confidence
- Direct code analysis: `src/orchestrator/retry.ts` (verifier pipeline, baseline SHA capture), `src/agent/index.ts` (WorktreeManager lifecycle), `src/types.ts` (SessionConfig), `.planning/PROJECT.md` (constraints: iptables isolation, worktree lifecycle decisions), `.planning/milestones/v3.0-ROADMAP.md` (Appendix A recipe schema, phase success criteria) — HIGH confidence

---
*Pitfalls research for: v3.0 Program Automator — sweeping-refactor / mass-migration capability added to existing background coding agent*
*Researched: 2026-04-08*
