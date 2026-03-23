# Stack Research

**Domain:** Generic deterministic task support — background-coding-agent v2.2
**Researched:** 2026-03-23
**Confidence:** HIGH — primary sources are official Anthropic docs, live model API, and direct codebase inspection

---

## Scope

This file covers ONLY what changes for the v2.2 milestone: generic task type, prompt enrichment for arbitrary code changes, and verification flexibility for config-only changes.

Validated existing stack (Node.js 20, TypeScript ESM/NodeNext, `@anthropic-ai/claude-agent-sdk@^0.2.77`, `@anthropic-ai/sdk@^0.80.0`, Commander.js, Pino, Vitest, ESLint v10, Zod 4, conf@15, simple-git, write-file-atomic, picocolors, octokit) is NOT re-researched here.

---

## New Stack Additions

**None.** No new npm packages are required. Every capability needed for v2.2 is already in the dependency tree.

The work for this milestone is entirely in TypeScript logic changes to existing modules.

---

## Changes to Existing Modules

### 1. Intent Parser — Add `generic` Task Type

**File:** `src/intent/types.ts` and `src/intent/llm-parser.ts`

**What changes:** `IntentSchema.taskType` currently enumerates `'npm-dependency-update' | 'maven-dependency-update' | 'unknown'`. Add `'generic'` as an explicit task type. `'unknown'` remains for genuinely ambiguous parses; `'generic'` means the LLM recognized a valid code change instruction that isn't a dependency update.

**Why not just use `'unknown'`:** The existing code treats `unknown` as a pass-through fallback. Making `generic` explicit lets the intent display, confirm loop, and prompt builder handle it distinctly — showing the user's raw instruction in the confirmation screen and routing to the enriched generic prompt builder without confusion with error cases.

**What the Zod schema change looks like:**

```typescript
export const IntentSchema = z.object({
  taskType: z.enum([
    'npm-dependency-update',
    'maven-dependency-update',
    'generic',   // <-- new
    'unknown',
  ]),
  dep: z.string().nullable(),
  version: z.enum(['latest']).nullable(),
  confidence: z.enum(['high', 'low']),
  createPr: z.boolean(),
  clarifications: z.array(z.object({ label: z.string(), intent: z.string() })),
  description: z.string().nullable(),  // <-- new: raw instruction for generic tasks
});
```

The `description` field carries the normalized user instruction through to `buildPrompt()`. It must be `nullable()` to preserve backward compatibility (dependency tasks set it `null`).

**LLM parser system prompt addition:** Extend `INTENT_SYSTEM_PROMPT` with rules for when to emit `'generic'`: use it for explicit code change instructions (refactors, method replacements, config edits, etc.) where the intent is clear but it is not a dependency update. Keep `'unknown'` for genuinely ambiguous input. Set `description` to the user's instruction verbatim (normalized, not paraphrased) when `taskType` is `'generic'`.

---

### 2. Structured Outputs API — Migrate Off Beta Header

**File:** `src/intent/llm-parser.ts`

**Current code** (line 91–103 in the existing file):
```typescript
response = await client.beta.messages.create({
  // ...
  betas: ['structured-outputs-2025-11-13'],
  output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
} as any) as BetaMessage;
```

**What changes:** Structured outputs reached GA in November 2025. The beta header `structured-outputs-2025-11-13` and `client.beta.messages.create()` are deprecated. Migrate to the standard `client.messages.create()` with `output_config.format`.

**Why this matters for v2.2:** The `any` cast and `BetaMessage` import are tech debt that will break when Anthropic removes the beta endpoint. v2.2 adds a more complex `IntentSchema` (with `generic` + `description`); migrating to GA now avoids the risk of the deprecated API rejecting larger schemas.

**Replacement pattern:**
```typescript
import Anthropic from '@anthropic-ai/sdk';
import type { Message } from '@anthropic-ai/sdk/resources/messages.js';

// No beta import needed
const response = await client.messages.create({
  model: 'claude-haiku-4-5-20251001',
  max_tokens: 512,
  stream: false,
  system: systemPrompt,
  messages: [{ role: 'user', content: userContent }],
  output_config: {
    format: {
      type: 'json_schema',
      schema: OUTPUT_SCHEMA,
    },
  },
}) as Message;
```

**Confidence:** HIGH — verified against [official structured outputs docs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) and Anthropic blog post confirming GA with no beta header required. The `output_format` → `output_config.format` rename is confirmed in Anthropic release notes and [verified in a Vercel AI SDK issue](https://github.com/vercel/ai/issues/12298) showing both old and new parameter names.

**Model stays the same:** `claude-haiku-4-5-20251001` is the current fastest model. Claude Haiku 3 (`claude-3-haiku-20240307`) is deprecated and will be retired April 19, 2026 — confirmed from [official model docs](https://platform.claude.com/docs/en/about-claude/models/overview).

---

### 3. Prompt Builder — Enriched Generic Prompt

**File:** `src/prompts/index.ts` (and new `src/prompts/generic.ts`)

**Current state:** The `default` branch in `buildPrompt()` emits a thin one-liner:
```typescript
return `You are a coding agent. Your task: ${options.description ?? options.taskType}. Work in the current directory.`;
```

This is insufficient for arbitrary code changes. The agent has no context about what kind of change it is, what scope is acceptable, or what success looks like.

**What changes:** Extract a `buildGenericPrompt(description: string, repoContext?: GenericRepoContext)` function in a new `src/prompts/generic.ts` file. The prompt follows the same end-state prompting discipline established for Maven and npm tasks (Spotify research, TASK-04): describe desired outcome state, explicit scope constraints, and what "done" looks like.

**`GenericRepoContext` shape** (populated by context scanner before calling `buildPrompt()`):
```typescript
interface GenericRepoContext {
  hasTypeScript: boolean;    // tsconfig.json present → tsc will run
  hasTests: boolean;         // vitest/jest config or test script present
  changeScope: 'config-only' | 'code';  // influences verifier selection
}
```

**Prompt structure for generic tasks:**
```
You are a coding agent. Your task: <description>

SCOPE: Make only the changes necessary to accomplish this task. Do NOT:
- Modify files unrelated to the task
- Refactor, reformat, or reorganize code beyond what is required
- Add, remove, or update dependencies unless explicitly instructed

After your changes, the following should be true:
- <description> has been accomplished
- All existing tests still pass (if a test suite exists)
- No new lint errors have been introduced

Work in the current directory.
```

The `description` is the user's verbatim normalized instruction from the intent parser — never paraphrased by LLM. This preserves the project invariant that version numbers and task specifics come from the user, not from LLM inference.

**Why a separate file:** Follows the existing pattern (`maven.ts`, `npm.ts`) and keeps `index.ts` as pure dispatch logic. Makes the generic prompt independently testable.

---

### 4. Verification — Config-Only Change Detection

**File:** `src/orchestrator/verifier.ts`

**What changes:** Add a `changeScope` classifier that detects whether the agent's diff touches only config/non-code files (e.g., `.json`, `.yaml`, `.toml`, `.xml` property files, `.env`, docs) versus TypeScript/JavaScript source. When `changeScope` is `'config-only'`, skip the TypeScript build verifier and test verifier — they add 30–120 seconds of latency for changes that cannot affect compiled output.

**Why this is safe:** The compositeVerifier already skips gracefully when no tsconfig/vitest config is present. Config-only detection extends this: when the changed files are only data/config formats, `tsc --noEmit` will pass trivially (no source changed) but wastes time. The lint verifier still runs — it catches JSON syntax errors and yaml formatting issues if ESLint is configured for them.

**How to detect config-only scope:** Read the git diff from the workspace before running verifiers. Use `git diff --name-only HEAD` (or against stash baseline) and classify file extensions.

```typescript
const CONFIG_EXTENSIONS = new Set([
  '.json', '.yaml', '.yml', '.toml', '.xml',
  '.properties', '.env', '.ini', '.conf',
  '.md', '.txt', '.rst',
]);

function classifyChangeScope(changedFiles: string[]): 'config-only' | 'code' {
  const hasCodeFile = changedFiles.some(f => {
    const ext = path.extname(f).toLowerCase();
    return !CONFIG_EXTENSIONS.has(ext);
  });
  return hasCodeFile ? 'code' : 'config-only';
}
```

**Integration:** `compositeVerifier()` already accepts an `options` parameter (`{ skipLint?: boolean }`). Extend this to `{ skipLint?: boolean; skipBuildAndTest?: boolean }`. The caller (retry orchestrator) passes `skipBuildAndTest: true` when `changeScope === 'config-only'`.

**No new packages required:** `git diff --name-only` is already used in the codebase (lint verifier uses `git stash` for baseline detection). `simple-git` is already installed if a programmatic API is preferred over `execFileAsync`.

---

### 5. Context Scanner — Repo Context for Generic Prompt Enrichment

**File:** `src/intent/context-scanner.ts`

**What changes:** The existing `readManifestDeps()` returns a string for LLM injection. Add a parallel `scanRepoContext(repoPath: string): Promise<GenericRepoContext>` function that returns the structured `GenericRepoContext` shape used by `buildGenericPrompt()`.

This scanner reads the same files already accessed by the verifiers (tsconfig.json, vitest.config.*, package.json) — no new filesystem operations. It is a thin coordinator that assembles boolean flags from existing detection logic.

**Why this is in context-scanner, not verifier:** The prompt builder needs this context at task setup time, before the agent runs. The verifier runs after. Placing detection in context-scanner keeps concerns separated: context-scanner answers "what does this repo look like?", verifier answers "did the agent break anything?".

---

## What NOT to Add

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| AST parser (tree-sitter, @typescript-eslint/parser direct) | Config-only detection only needs file extension classification, not AST analysis. AST parsing adds 5–15MB of native binaries and build complexity. | `path.extname()` on `git diff --name-only` output |
| LangChain / LLM orchestration frameworks | Generic task execution is still a single agent `query()` call. No chaining, no vector stores, no retrieval. | `@anthropic-ai/claude-agent-sdk` `query()` (already installed) |
| `js-yaml` / `jsonschema` for config validation | Config-only changes go through LLM Judge for scope validation, not schema validation. Adding config-specific validators creates false confidence in a space the LLM Judge already covers. | LLM Judge (existing) |
| Task queue / job system (Bull, BullMQ, pg-boss) | v2.2 is still synchronous CLI execution. Queue triggers are explicitly out of scope per PROJECT.md. | Direct `runAgent()` call (existing) |
| Separate `generic` task-type handler module | PROJECT.md explicitly rejects "hardcoded task-type handlers per category." Generic execution path goes through the same `buildPrompt()` → `runAgent()` → `compositeVerifier()` pipeline as dependency tasks. | `buildGenericPrompt()` called from existing `buildPrompt()` dispatch |
| Newer Claude model for intent parsing (Sonnet 4.6) | Haiku 4.5 is the fastest and cheapest model, appropriate for the interactive intent parse path (15s timeout). Sonnet 4.6 costs 3x more and adds latency. | `claude-haiku-4-5-20251001` (already in use) |

---

## Version Compatibility

| Package | Version in Use | Notes |
|---------|----------------|-------|
| `@anthropic-ai/sdk` | `^0.80.0` (latest as of 2026-03-23) | `messages.create()` with `output_config.format` — no beta header. Verified GA in official docs. |
| `@anthropic-ai/claude-agent-sdk` | `^0.2.81` (latest as of 2026-03-23) | No changes to Agent SDK usage. `query()` remains the execution path for all task types. |
| `zod` | `^4.3.6` (latest as of 2026-03-23) | `z.toJSONSchema()` used to convert `IntentSchema` for structured output. Adding `description: z.string().nullable()` is backward compatible — existing callers that omit it get `null`. |
| `claude-haiku-4-5-20251001` | Current model, API alias `claude-haiku-4-5` | Confirmed current fastest model in [official model docs](https://platform.claude.com/docs/en/about-claude/models/overview). Claude Haiku 3 retiring April 19, 2026 — not relevant since project already uses Haiku 4.5. |

---

## Installation

```bash
# No new packages required for v2.2.
# Ensure existing packages are at current versions:
npm install
```

---

## Alternatives Considered

| Recommended | Alternative | Why Not |
|-------------|-------------|---------|
| File extension classification for config-only detection | Semantic analysis via AST or tree-sitter | Massive complexity increase for marginal accuracy gain. Extensions are accurate enough: `.ts`/`.js` files are code; `.json`/`.yaml`/`.toml` files are config. Edge cases (e.g., `jest.config.ts`) get classified as code — conservative and safe. |
| `client.messages.create()` (GA structured outputs) | `client.beta.messages.create()` with beta header | Beta header is deprecated. Removal timeline unannounced but confirmed deprecated. Migrating now avoids a future breaking change. |
| `generic` as explicit enum value in IntentSchema | Reusing `unknown` for generic tasks | `unknown` semantics are "couldn't classify." `generic` means "classified as a valid generic instruction." Conflating them breaks the confirm loop display and makes prompt dispatch ambiguous. |
| Inline `GenericRepoContext` from context-scanner | Full repo analysis (file count, language stats) | Over-engineering. The prompt builder needs three boolean flags. Everything else is the LLM agent's job to discover at runtime via its built-in tools (Read, Glob, Grep). |

---

## Sources

- [Anthropic Structured Outputs GA docs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) — `output_config.format`, no beta header required, GA on Haiku 4.5 / Sonnet 4.5+ (HIGH confidence — official Anthropic docs, verified 2026-03-23)
- [Anthropic Models Overview](https://platform.claude.com/docs/en/about-claude/models/overview) — `claude-haiku-4-5-20251001` confirmed current fastest model, Claude Haiku 3 deprecation April 19 2026 (HIGH confidence — official Anthropic docs, verified 2026-03-23)
- [Anthropic structured outputs blog post](https://claude.com/blog/structured-outputs-on-the-claude-developer-platform) — GA announcement confirming `output_config.format` replaces `output_format`, no beta header (HIGH confidence — official Anthropic, verified 2026-03-23)
- `src/intent/types.ts`, `src/intent/llm-parser.ts`, `src/prompts/index.ts`, `src/orchestrator/verifier.ts`, `src/intent/context-scanner.ts` — direct codebase inspection of current module boundaries and integration points (HIGH confidence — source of truth)
- `package.json` — confirmed installed versions: `@anthropic-ai/sdk@^0.80.0`, `@anthropic-ai/claude-agent-sdk@^0.2.77`, `zod@^4.3.6` (HIGH confidence — live file)
- npm registry (live) — `@anthropic-ai/sdk@0.80.0`, `@anthropic-ai/claude-agent-sdk@0.2.81`, `zod@4.3.6` as of 2026-03-23 (HIGH confidence — npm show commands executed in project)
- [PROJECT.md constraint](../../.planning/PROJECT.md) — "Hardcoded task-type handlers per category — generic execution path preferred" (HIGH confidence — project decision, directly quoted)

---
*Stack research for: Generic deterministic task support — config updates, refactors, method replacements (background-coding-agent v2.2)*
*Researched: 2026-03-23*
