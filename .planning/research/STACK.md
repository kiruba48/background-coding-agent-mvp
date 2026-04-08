# Stack Research

**Domain:** v3.0 Program Automator — sweeping-refactor capability additions to background-coding-agent
**Researched:** 2026-04-08
**Confidence:** HIGH for YAML/JSON schema/BM25/ledger choices (official docs + npm verified), MEDIUM for tree-sitter WASM approach (workaround path, not first-party Alpine support), MEDIUM for rewrite-tool bridging (CLI invocation pattern confirmed, offline pre-seeding not officially documented)

---

## Scope

This file covers ONLY what changes for v3.0. The validated existing stack is not re-researched:

- Node.js 20, TypeScript (NodeNext / ESM `"type": "module"`)
- `@anthropic-ai/claude-agent-sdk`, `@anthropic-ai/sdk`
- `simple-git@^3.32.3`, Commander.js, Pino, Vitest, ESLint v10, Zod@^4.x, conf@15
- `@slack/bolt@^4.6.0`, `octokit@^5.0.5`, `write-file-atomic@^7.0.0`
- Docker (Alpine, multi-stage), `git`, `bash`, `ripgrep` already in image
- In-process MCP verifier server

**Note on Zod:** v2.4 STACK.md references `Zod 4` — confirmed Zod v4.x (latest 4.3.6 as of research date) is already in use. v3.0 recipe schema validation should use the existing Zod instance, not add AJV unless JSON Schema external file validation is specifically required.

---

## Capability-to-Library Mapping

Before the table, here is the decision for each v3.0 capability:

| Capability | Decision | Library/Approach |
|------------|----------|-----------------|
| Recipe YAML load + schema validate | `yaml@^2.8.3` (`parseDocument`) + Zod (existing) | No new schema validator needed |
| YAML roundtrip-safe edit (comments) | `yaml@^2.8.3` with `parseDocument` AST | Already decided above — one library for both |
| JSON-Schema file validation (schema_validate recipe slot) | `ajv@^8.18.0` | New dep, pure JS, no native, Alpine-safe |
| Tree-sitter AST query/rewrite (Java/Python/TS) | `web-tree-sitter@^0.22.4` + `tree-sitter-wasms@^0.1.13` (WASM path) | Avoids glibc/musl native build issue |
| BM25 doc_retrieve over context bundle | `wink-bm25-text-search@^3.1.2` | Pure JS, no native, no network, no embeddings |
| Persistent RefactorRun ledger | `better-sqlite3@^12.8.0` | Alpine musl prebuilds available since 2021 |
| OpenRewrite bridge (Java repos) | CLI invocation: `mvn -o org.openrewrite.maven:rewrite-maven-plugin:run` | No Node library — CLI-only, Maven local repo pre-seeded at image build |
| jscodeshift bridge (JS/TS repos) | CLI invocation: `npx jscodeshift` or direct `node_modules/.bin/jscodeshift` | `jscodeshift@^17.3.0` pre-installed in image; no Node API needed |
| semgrep bridge (search/pattern) | CLI invocation: `semgrep --config <pattern> --json` | Python binary pre-seeded in image; `pip install semgrep` at image build |

---

## Recommended Stack

### Core Technologies (new for v3.0)

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| `yaml` | `^2.8.3` | YAML recipe load AND roundtrip-safe config editing | `parseDocument()` is the only pure-JS YAML parser that preserves comments in a mutable AST. `js-yaml` does not. This one library covers both Phase 32 (recipe loading) and Phase 33 (`config_edit` tool). Dual-licensed ISC. |
| `ajv` | `^8.18.0` | JSON Schema validation for `schema_validate` recipe invariant | Fastest JSON schema validator (codegen-based). Pure JavaScript — zero native deps. Alpine-safe. Already transitively present in most Node projects (16,000+ dependents). Draft-04 through 2020-12 supported. |
| `web-tree-sitter` | `^0.22.4` | AST query/rewrite runtime (WASM-based) | The native `tree-sitter` npm package has prebuilt binaries linked against glibc — not compatible with Alpine's musl without compilation. `web-tree-sitter` is pure WASM, no native build, works in any Node.js ≥16 environment. |
| `tree-sitter-wasms` | `^0.1.13` | Pre-compiled WASM grammar files for 36 languages | Provides `tree-sitter-java.wasm` (430 kB), `tree-sitter-typescript.wasm` (2.34 MB), `tree-sitter-python.wasm` (476 kB) among 36 languages. Ships as a single npm package, binaries are static files, no compilation needed. Maintained by Sourcegraph. |
| `wink-bm25-text-search` | `^3.1.2` | BM25 full-text retrieval over mounted context bundles | Pure JavaScript, no native deps, no network calls, in-memory indexing. Exactly what `doc_retrieve` MCP tool needs: build index from `/context/` files, query by recipe template string. No embeddings model required. |
| `better-sqlite3` | `^12.8.0` | Persistent RefactorRun ledger across sessions | Synchronous API fits the serialized, single-process RefactorRun orchestrator. Alpine musl prebuilds have been available since PR#641 (Nov 2021) — confirmed working for Node 20 / amd64. Latest v12.8.0 requires Node.js ≥20 (matches current stack). |

### Supporting Libraries (new for v3.0)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `wink-nlp` | `^1.14.3` | Optional tokenizer/stemmer for `wink-bm25-text-search` | Use when context bundle is prose documentation; provides stemming and stop-word removal for better BM25 recall. Not required if bundle is structured data (API maps, YAML schemas). |
| `ajv-formats` | `^3.0.1` | JSON Schema `format` keywords (uri, date, email, etc.) | Use alongside `ajv` when recipe schema or target JSON schemas use `format` keywords. Pure JS, zero native. |

### Docker Image Additions (pre-seeded tools)

These are NOT npm packages — they are binaries installed in the Alpine Docker image at build time. No network access at runtime.

| Tool | Install Method | Purpose | Notes |
|------|---------------|---------|-------|
| `jscodeshift@17.3.0` | `npm install -g jscodeshift` in Dockerfile | JS/TS codemod bridge for `rewrite_run` | Pure Node.js; install globally during image build. Available as `jscodeshift` CLI inside container. Node 16+ required. |
| `semgrep` (latest stable) | `pip install semgrep` in Dockerfile | Pattern-based search/rewrite bridge | Python binary, statically linked. Semgrep's own Docker image uses Alpine 3.23 — installation on Alpine is officially supported. Runs offline, code never uploaded by default. |
| OpenRewrite via Maven wrapper | Maven local repo pre-seeded during image build with `mvn dependency:resolve` | Java recipe execution bridge | Invoke as `mvn -o org.openrewrite.maven:rewrite-maven-plugin:run` with `-o` (offline) flag once Maven local repo is populated. No network at runtime. |

---

## Decision Rationale (Detailed)

### YAML: `yaml@2.x` vs `js-yaml` — Choose `yaml`

**Chosen:** `yaml@^2.8.3` via `parseDocument()`

`js-yaml` has explicitly rejected comment-preservation support (GitHub issue #689: "Support option to keep comments — closed as wontfix"). Its `load()` / `dump()` pipeline discards all comments.

`yaml@2.x` (`eemeli/yaml`) is the only Node.js YAML library where `parseDocument()` returns a full AST with `comment`, `commentBefore`, and `spaceBefore` properties on each node. Mutating the AST and calling `doc.toString()` produces YAML with comments intact. This is required for `config_edit` to be a first-class tool (e.g., bumping `image.tag` in a Helm values file without stripping all operator comments).

**Caveat:** The docs note that trailing comment attachment "is not completely stable" — they may shift to a sibling node after a roundtrip cycle. This is acceptable for the `config_edit` use case (value edits, not comment edits), and is a known limitation to document in `config_edit`'s tool description.

Latest stable: v2.8.3 (March 21, 2025). A v3.0.0-0 pre-release exists but is not used — wait for stable v3.

**Why not `enhanced-yaml`:** It is a thin wrapper over `yaml@2.x` that uses the original source string to re-align comments. Adds a dependency for marginal gain. Using `yaml` directly with `parseDocument` AST mutation is the canonical approach and requires zero wrappers.

### JSON Schema Validator: `ajv` vs Zod — Use Both for Different Purposes

**Recipe schema (internal):** Use existing **Zod** (already in project). Zod is TypeScript-first, co-located with the TypeScript types, and produces better developer-facing error messages. The recipe schema (Appendix A in the roadmap) is a TypeScript data structure — Zod is the right tool.

**External JSON Schema validation (`schema_validate` recipe invariant):** Use **`ajv@8.x`**. The recipe's `verification.schema` field points to a user-supplied JSON Schema file (e.g., `./schemas/values.schema.json`). AJV loads and compiles arbitrary JSON Schema files at runtime, which is not what Zod is designed for. AJV supports JSON Schema Draft-04 through 2020-12. Pure JS, no native deps, Alpine-safe. Version 8.18.0 (Feb 2025) adds `sideEffects: false` for tree-shaking.

**Do NOT use:** `jsonschema` (npm) — slower, less actively maintained. `zod-to-json-schema` — not for runtime validation of external schema files.

### Tree-Sitter: WASM vs Native — Choose WASM

**Chosen:** `web-tree-sitter@^0.22.4` + `tree-sitter-wasms@^0.1.13`

The native `tree-sitter` Node.js package (`tree-sitter` npm, latest v0.22.4 with Node bindings) ships prebuilt `.node` binaries linked against **glibc**. Alpine Linux uses **musl libc**. These binaries will fail with "symbol not found" errors unless compiled from source in Alpine with C and Rust compilers. Issue #597 in the tree-sitter repository was closed in 2020 with "not in published builds, compile from source on Alpine" — there is no official fix. Requiring compilation adds significant Docker image build complexity and time.

`web-tree-sitter` is the official WebAssembly port of the tree-sitter runtime. It runs in any JavaScript engine that supports WebAssembly (Node.js ≥ 12 via V8). No native compilation. No glibc/musl distinction. Grammar `.wasm` files load via `Language.load(wasmPath)`.

`tree-sitter-wasms@0.1.13` (Sourcegraph fork, actively maintained) ships 36 prebuilt grammar WASM files including:
- `tree-sitter-java.wasm` (430 kB)
- `tree-sitter-typescript.wasm` (2.34 MB)
- `tree-sitter-python.wasm` (476 kB)
- Plus Kotlin, Rust, Go, C#, Ruby, and 28 more

These are static `.wasm` files baked into the image — no runtime downloads needed.

**Performance note:** WASM tree-sitter is slower than native bindings. For the RefactorRun use case (query a file, rewrite, move on), per-file latency is acceptable. This is not a language server running on every keystroke.

**Version note:** `node-tree-sitter` (native) is at v0.22.4. `web-tree-sitter` is also at v0.22.4. These are versioned together with the tree-sitter core grammar interface. Ensure `tree-sitter-wasms` grammar WASM files are built against the same tree-sitter ABI version as `web-tree-sitter`.

**Why not `@vscode/tree-sitter-wasm`:** Microsoft's package is specifically for VS Code's internal use and includes TypeScript and some web languages but does not cover Java or Python with a stable public API contract.

### BM25: `wink-bm25-text-search` — Only Viable Choice

**Chosen:** `wink-bm25-text-search@^3.1.2`

Requirements for `doc_retrieve`:
1. Pure JavaScript — no native binaries (Alpine safety)
2. No network calls at query time
3. No embedding model — just term frequency statistics
4. In-memory index built from files at container startup
5. Maintained library (not abandoned)

`wink-bm25-text-search@3.1.2` (winkJS, MIT license) satisfies all five. Pure JS, in-memory, BM25F algorithm, configurable k1/b/k parameters, field weighting, works in Node.js and browser. The index is built from JSON documents: split context bundle files into chunks, index with field weights for title/body/section, query with the recipe's `retrieval_query_template`.

**Alternatives rejected:**
- `lunr.js` — TF-IDF not BM25; lower recall for technical documentation
- `flexsearch` — faster for large indexes but BM25 not the default algorithm; overkill
- `elasticlunr` — abandoned (last commit 2016)
- Any vector/embedding search — explicitly out of scope (no embeddings, no network)

### Persistent Ledger: `better-sqlite3` vs JSON files vs `conf`

**Chosen:** `better-sqlite3@^12.8.0`

The RefactorRun ledger is the most architecturally significant new data store in v3.0. It needs:
1. Survives process crashes (Phase 29: `agent refactor resume`)
2. Atomic updates per chunk (mark target done + record commit SHA atomically)
3. Query by run-id, status, target locator
4. Works in the host Node.js process (not inside Docker)

**JSON files** (with `write-file-atomic` already in project): Viable for simple key-value state but atomic partial updates across multiple targets require read-modify-write with locking. Querying by status requires full file parse every time. Adequate for ledgers with <50 targets, brittle for 500+ targets across a large repo.

**`conf`** (already in project for project registry): Designed for user preferences, not transactional ledger data. No transaction semantics. Not the right abstraction.

**`better-sqlite3@12.8.0`**: Synchronous API (no async needed for the serial orchestrator), WAL mode for crash safety, transactions for atomic chunk updates, simple SQL queries for status counts. Alpine musl prebuilds have been shipping since November 2021 (PR #641, issue #619 resolved). Latest v12.8.0 requires Node.js ≥20 (matches current stack). Multi-stage Dockerfile already used — `npm install` in build stage compiles/fetches the native addon there; runtime stage copies `node_modules/`.

**Native Node.js `node:sqlite`:** As of April 2026, this module is in "Active development" (stability 1.1) and requires the `--experimental-sqlite` CLI flag. Not production-ready. Revisit for v4.0.

**SQLite schema for RefactorRun:**
```sql
CREATE TABLE refactor_runs (
  id TEXT PRIMARY KEY,
  recipe_name TEXT NOT NULL,
  recipe_version TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  worktree_path TEXT,
  branch TEXT,
  status TEXT NOT NULL,  -- pending|running|complete|failed
  baseline_json TEXT,    -- JSON blob for differential verification
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE refactor_targets (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES refactor_runs(id),
  file TEXT NOT NULL,
  locator TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,  -- pending|in-progress|done|failed|skipped
  commit_sha TEXT,
  error_reason TEXT,
  updated_at INTEGER NOT NULL
);
```

### OpenRewrite Bridge: CLI Only

**Not a Node.js library.** OpenRewrite is a Java ecosystem tool. The bridge invocation pattern:

```
mvn -o org.openrewrite.maven:rewrite-maven-plugin:run \
  -Drewrite.activeRecipes=<recipe.fully.qualified.Name>
```

The `-o` (offline) flag tells Maven to use the local repository only — no network. The Maven local repository (`~/.m2/repository`) must be pre-seeded at Docker image build time by running `mvn dependency:resolve` with network access. This is the standard pattern for air-gapped Maven builds.

At runtime (no network), the `rewrite_run` MCP tool calls `execFile('mvn', [...])` from inside the container. The rewrite plugin JAR, recipe JARs, and all transitive deps must be in the image's Maven local repo.

**Why not `@openrewrite/rewrite` npm package:** Does not exist. OpenRewrite has no Node.js library API.

### jscodeshift Bridge: CLI pre-installed in image

`jscodeshift@17.3.0` (latest, March 24, 2025) is a pure Node.js package. Install it globally in the Docker image during build (`npm install -g jscodeshift`). The `rewrite_run` tool calls it as a subprocess:

```
jscodeshift --transform <recipe.js> --extensions ts,tsx <files...>
```

Or for bundled transforms registered by recipe id, call `node_modules/.bin/jscodeshift` with the transform file path.

jscodeshift v17.x is a significant version jump (from v0.x) reflecting maturity. Node.js 16+ required. Alpine compatible (pure Node.js, no native).

### semgrep Bridge: Python binary in image

`semgrep` is a Python package. Pre-install in Docker image with `pip install semgrep`. Semgrep's own official Docker image uses Alpine (confirmed: bumped Alpine 3.21 → 3.22 → 3.23 in recent releases), so Alpine compatibility is first-class. At runtime, `rewrite_run` invokes:

```
semgrep --config <pattern.yaml> --json <path>
```

Semgrep never uploads code by default. Runs offline once installed.

---

## Installation

```bash
# New npm dependencies for v3.0 (host-side, Node.js process)
npm install yaml@^2.8.3 ajv@^8.18.0 ajv-formats@^3.0.1
npm install web-tree-sitter@^0.22.4 tree-sitter-wasms@^0.1.13
npm install wink-bm25-text-search@^3.1.2
npm install better-sqlite3@^12.8.0

# Optional (for wink-nlp tokenizer/stemmer with BM25)
npm install wink-nlp@^1.14.3 wink-eng-lite-web-model

# Type stubs
npm install -D @types/better-sqlite3
```

```dockerfile
# Additions to Dockerfile (agent sandbox image — build stage)

# jscodeshift (JS/TS codemods)
RUN npm install -g jscodeshift@17.3.0

# semgrep (pattern-based transforms)
RUN pip3 install --no-cache-dir semgrep

# OpenRewrite recipes pre-seeded in Maven local repo
# (requires network at image build time, not at runtime)
RUN mvn dependency:resolve \
    -Dartifact=org.openrewrite.maven:rewrite-maven-plugin:LATEST \
    && mvn dependency:resolve \
    -Dartifact=org.openrewrite.recipe:rewrite-migrate-java:LATEST
```

---

## Alternatives Considered

| Recommended | Alternative | Why Not |
|-------------|-------------|---------|
| `yaml@2.x` with `parseDocument` | `js-yaml` | `js-yaml` explicitly does NOT preserve comments (issue #689 closed wontfix). Cannot do roundtrip-safe edits. |
| `yaml@2.x` with `parseDocument` | `enhanced-yaml` (npm) | Thin wrapper over `yaml@2.x`. Adds dep for marginal gain. Using `parseDocument` directly is the canonical API. |
| `ajv@8.x` for external JSON Schema | `zod-to-json-schema` + Zod | AJV validates arbitrary user-supplied `.json` schema files. Zod validates TypeScript-typed structures. Different problems. |
| `web-tree-sitter` + `tree-sitter-wasms` | `tree-sitter` native npm | Native binaries linked against glibc — fails on Alpine musl. Issue #597 closed without Alpine fix. Compile-from-source adds build complexity. |
| `web-tree-sitter` + `tree-sitter-wasms` | `@vscode/tree-sitter-wasm` | Microsoft-internal package. Does not include Java grammar. No public API stability contract. |
| `wink-bm25-text-search` | `lunr.js` | TF-IDF, not BM25. Lower recall for technical documentation retrieval. |
| `wink-bm25-text-search` | Embedding-based vector search | Requires embedding model (heavy dep), network or GPU. Explicitly out of scope per recipe schema design (`retrieval: none | bm25`). |
| `better-sqlite3` | JSON files + `write-file-atomic` | No transaction semantics for atomic per-chunk ledger updates. Full-parse queries for large ledgers. Not crash-safe for concurrent writes. |
| `better-sqlite3` | `conf` (already in project) | `conf` is for user preferences. No transactions, no SQL queries, no relational structure. Wrong abstraction for a multi-table run ledger. |
| `better-sqlite3` | `node:sqlite` (built-in) | Experimental (`--experimental-sqlite` flag required) as of Node.js 22 / April 2026. Not production-ready. |
| OpenRewrite CLI invocation | `@openrewrite/rewrite` npm package | Does not exist. No Node.js library API for OpenRewrite. |

---

## What NOT to Add

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `js-yaml` | Does not preserve YAML comments. Roundtrip will silently strip all operator/user comments. | `yaml@2.x` with `parseDocument` |
| `tree-sitter` (native npm) | glibc-linked prebuilds fail on Alpine musl. Requires compiling from source with C + Rust toolchains in Dockerfile. | `web-tree-sitter` + `tree-sitter-wasms` |
| Any vector/embedding library (`langchain`, `transformers.js`, `hnswlib`) | v3.0 `doc_retrieve` is BM25-only per recipe schema. Heavy deps, network for model download, no-network constraint violated. | `wink-bm25-text-search` |
| `node:sqlite` experimental | Requires `--experimental-sqlite` flag; API stability not guaranteed; breaks clean startup. | `better-sqlite3@12.x` |
| `typeorm` or `prisma` for ledger | Massive deps for a single-table ledger. ORM migrations, codegen, and runtime complexity far exceed needs. | `better-sqlite3` with raw SQL |
| `execa` | `node:child_process.execFile` (already used in 6+ files in the project) handles all subprocess invocations. | `node:child_process.execFile` + `promisify` |
| Additional YAML roundtrip library (`yaml-js`, `yaml-ast-parser`) | These are old, unmaintained forks. `yaml@2.x` is the actively maintained successor with full YAML 1.2 spec coverage. | `yaml@2.x` |

---

## Stack Patterns by Variant

**If adding a new language grammar for `ast_query`/`ast_rewrite`:**
- Check if `tree-sitter-wasms@0.1.13` already includes it (36 languages covered)
- If not: download the prebuilt `.wasm` file from the language's official GitHub releases and add to `docker/grammars/`
- Register the language in the `AstCapabilityTool` language registry — no code change to the runner

**If a recipe uses `strategy: deterministic` with `capability: config_edit`:**
- Use `yaml@2.x` `parseDocument` → mutate → `doc.toString()` for YAML
- Use `JSON.parse` / `JSON.stringify` with `jsonc-parser` (already a VS Code/TypeScript dep if present) for JSON with comments
- No tree-sitter needed; no LLM per chunk — fastest path

**If a recipe uses `strategy: end-state-prompt` or `doc-grounded`:**
- The Claude Agent SDK session gets the `ast_query`, `ast_rewrite`, `import_rewrite` MCP tools exposed
- The recipe's `allowed_tools` field gates which tools the session may call
- `doc_retrieve` tool is only added to the session tool list when `context.bundle` is set and `context.retrieval === 'bm25'`

**If the target repo is Maven/Gradle (Java):**
- OpenRewrite via `mvn -o rewrite:run` is available as `rewrite_run` tool
- `ast_query`/`ast_rewrite` use `tree-sitter-java.wasm` grammar
- `import_rewrite` uses Java-specific import scanning logic

**If the target repo is npm (JS/TS):**
- jscodeshift available as `rewrite_run` tool
- `ast_query`/`ast_rewrite` use `tree-sitter-typescript.wasm` grammar

---

## Version Compatibility

| Package | Version | Alpine musl | Node 20 | Notes |
|---------|---------|-------------|---------|-------|
| `yaml` | `^2.8.3` | Pure JS — yes | Yes | TypeScript typings require TS ≥5.9; set `skipLibCheck: true` for older TS |
| `ajv` | `^8.18.0` | Pure JS — yes | Yes | `"sideEffects": false` since 8.18.0 enables tree-shaking |
| `ajv-formats` | `^3.0.1` | Pure JS — yes | Yes | Peer dep on `ajv@^8.0.0` |
| `web-tree-sitter` | `^0.22.4` | WASM — yes | Yes | Must match ABI of grammar .wasm files |
| `tree-sitter-wasms` | `^0.1.13` | Static files — yes | N/A | Grammar WASM files built against same tree-sitter ABI as `web-tree-sitter@0.22.4` |
| `wink-bm25-text-search` | `^3.1.2` | Pure JS — yes | Yes | CommonJS module; import via `createRequire` under NodeNext |
| `better-sqlite3` | `^12.8.0` | Native + musl prebuilds — yes | Requires ≥20 | Alpine musl prebuilds available since v7.x (2021); v12.8.0 minimum Node 20 enforced |
| `jscodeshift` (image) | `17.3.0` | Pure Node.js — yes | Requires ≥16 | Install globally in Docker build stage |
| `semgrep` (image) | latest stable | Alpine officially supported | N/A (Python) | Official Semgrep Docker image uses Alpine 3.23 |

---

## Sources

- [github.com/eemeli/yaml releases](https://github.com/eemeli/yaml/releases) — v2.8.3 latest stable confirmed (HIGH confidence)
- [eemeli.org/yaml/v2/ — comment preservation docs](https://eemeli.org/yaml/v2/) — `parseDocument` comment handling verified (HIGH confidence)
- [nodeca/js-yaml#689](https://github.com/nodeca/js-yaml/issues/689) — wontfix on comment preservation confirmed (HIGH confidence)
- [github.com/tree-sitter/tree-sitter issues#597](https://github.com/tree-sitter/tree-sitter/issues/597) — Alpine glibc issue closed without fix (HIGH confidence)
- [github.com/tree-sitter/node-tree-sitter releases](https://github.com/tree-sitter/node-tree-sitter/releases) — v0.22.4 latest, v0.26 requires Node 24 (HIGH confidence)
- [unpkg tree-sitter-wasms@latest/out/](https://app.unpkg.com/tree-sitter-wasms@latest/files/out) — Java, TypeScript, Python WASM files confirmed at v0.1.13 (HIGH confidence)
- [web-tree-sitter npm](https://www.npmjs.com/package/web-tree-sitter) — WASM runtime, no native compilation (HIGH confidence)
- [github.com/winkjs/wink-bm25-text-search](https://github.com/winkjs/wink-bm25-text-search) — v3.1.2, pure JS, no native (HIGH confidence)
- [github.com/WiseLibs/better-sqlite3 issues#619](https://github.com/WiseLibs/better-sqlite3/issues/619) — musl/Alpine prebuilds added 2021, confirmed working (HIGH confidence)
- [github.com/WiseLibs/better-sqlite3 releases](https://github.com/WiseLibs/better-sqlite3/releases) — v12.8.0 latest, Node ≥20 required (HIGH confidence)
- [github.com/ajv-validator/ajv releases](https://github.com/ajv-validator/ajv/releases) — v8.18.0 latest, pure JS confirmed (HIGH confidence)
- [github.com/facebook/jscodeshift releases](https://github.com/facebook/jscodeshift/releases) — v17.3.0 latest (March 2025) (HIGH confidence)
- [docs.openrewrite.org offline invocation](https://docs.openrewrite.org/running-recipes/running-rewrite-on-a-maven-project-without-modifying-the-build) — `-o` offline flag, Maven local repo pre-seeding (MEDIUM confidence — docs confirm offline flag but don't document image pre-seeding explicitly)
- [semgrep.dev docs/semgrep-ci/packages-in-semgrep-docker](https://semgrep.dev/docs/semgrep-ci/packages-in-semgrep-docker) — Alpine 3.23 base confirmed (HIGH confidence)
- WebSearch: Zod v4.3.6 current version confirmed — already in project per v2.4 STACK.md (HIGH confidence)

---
*Stack research for: v3.0 Program Automator — sweeping-refactor capability additions*
*Researched: 2026-04-08*
