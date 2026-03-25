# Phase 18: Intent Parser Generalization - Research

**Researched:** 2026-03-23
**Domain:** TypeScript intent classification, Anthropic SDK structured outputs API migration
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Verb guard design:**
- Pre-filter check at the top of `fastPathParse()` — before running any dependency patterns
- Six refactoring verbs intercepted: `replace`, `rename`, `move`, `extract`, `migrate`, `rewrite`
- Block unconditionally — if input starts with a refactoring verb, return `null` immediately and force LLM classification
- No extra validation for dep verbs like "update" — the existing regex already requires a package-name-like token; inputs like "update the config file" won't match

**Generic schema shape:**
- Add `'generic'` to `IntentSchema.taskType` enum; remove `'unknown'`
- Remove the `unknown` → `generic` mapping in `parseIntent()` — LLM outputs `'generic'` directly
- Do NOT add a `description` field to the LLM output schema — raw user input is the description (per out-of-scope: "Automatic instruction rewriting")
- `parseIntent()` continues to set `description` from raw input for generic intents (existing behavior)
- Add `taskCategory: z.enum(['code-change', 'config-edit', 'refactor']).nullable()` to schema — LLM classifies the category for confirm loop display
- `dep` and `version` remain in schema but are `null` for generic intents

**GA API migration:**
- Migrate `client.beta.messages.create()` → `client.messages.create()` with `output_config.format`
- Remove `betas: ['structured-outputs-2025-11-13']` header
- Check current SDK version (^0.71.2) supports GA structured outputs; bump only if needed
- Clean types — import `Message` from standard SDK path, remove `as any` and `as BetaMessage` casts. Aim for zero type assertions
- Update all test mocks from `client.beta.messages.create()` to `client.messages.create()` — clean break, no compatibility shim

**Confidence & clarification for generic intents:**
- Low confidence when: instruction is vague ("clean up the code"), spans multiple unrelated changes, or sounds like task discovery ("find all deprecated calls")
- High confidence when: single clear action ("replace axios with fetch", "rename getUserData to fetchUserProfile")
- Clarifications for low-confidence generic intents: narrowed-down interpretations
- Task discovery inputs classified as low-confidence generic with clarifications guiding toward explicit instructions — not rejected outright
- LLM system prompt includes explicit guidance: "generic = any explicit code change instruction (replace, rename, edit config, add/remove code). NOT task discovery, analysis, or multi-repo ops"

### Claude's Discretion
- Exact LLM system prompt wording for generic classification rules
- OUTPUT_SCHEMA structure changes (JSON schema shape for structured outputs)
- Test case selection and coverage breadth
- Whether to add helper types or keep inline

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| INTENT-01 | User can provide any explicit code change instruction and the intent parser classifies it as `generic` task type | Schema enum change (`unknown` → `generic`), system prompt update, `parseIntent()` mapping removal |
| INTENT-02 | Fast-path regex includes verb guard so refactoring instructions ("replace axios with fetch") are not misclassified as dependency updates | Verb guard as first check in `fastPathParse()`, returns `null` to force LLM path |
| INTENT-03 | Intent parser uses GA structured outputs API (`output_config.format`) instead of deprecated beta endpoint | SDK bump to ≥0.80.0, migrate `client.beta.messages.create()` → `client.messages.create()`, remove `betas` header |
</phase_requirements>

## Summary

Phase 18 is a focused refactor of the intent parser module with three independent changes: a verb guard in the fast-path, a schema and system prompt update for generic classification, and an API migration from the deprecated beta structured outputs endpoint to the GA `client.messages.create()` endpoint.

The most significant prerequisite discovered during research is the SDK version. The installed SDK (0.71.2, released 2025-12-05) places `output_config.format` only on `client.beta.messages.create()`. The GA `client.messages.create()` path does not include `output_config` until SDK 0.80.0 (released 2026-03-18). Implementing INTENT-03 requires bumping `@anthropic-ai/sdk` from `^0.71.2` to `^0.80.0`. This is a non-trivial dependency bump that must happen in its own task before the API migration code is written.

The verb guard and schema changes are straightforward surgical edits with clear insertion points documented in the codebase. The test layer changes are well-scoped: the mock in `llm-parser.test.ts` points at `client.beta.messages.create` and must move to `client.messages.create` as a clean break (no shim).

**Primary recommendation:** Bump `@anthropic-ai/sdk` to `^0.80.0` first (Task A), then implement verb guard (Task B), schema + prompt changes (Task C), and API migration (Task D). All four changes are in `src/intent/` only.

## Standard Stack

### Core (verified against installed versions)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@anthropic-ai/sdk` | 0.71.2 installed → **bump to ^0.80.0** | Anthropic API client, structured outputs | GA `output_config.format` only on ≥0.80.0 |
| `zod` | ^4.3.6 (installed) | Schema validation for `IntentSchema` | Already the project standard |
| `vitest` | ^4.0.18 (installed) | Test runner | Already the project standard |

**Version verification:**
```bash
npm view @anthropic-ai/sdk version  # confirmed: 0.80.0 is latest (2026-03-18)
npm view zod version                # ^4.3.6 current
```

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `picocolors` | installed | Confirm loop display | Already used in `confirm-loop.ts` |
| `typescript` | ^5.7.2 | Type checking, zero `as any` goal | Enforce strict types after migration |

## Architecture Patterns

### Affected Files (all in `src/intent/`)

```
src/intent/
├── types.ts             # IntentSchema: add 'generic', remove 'unknown', add taskCategory
├── fast-path.ts         # Add verb guard as first check in fastPathParse()
├── llm-parser.ts        # Migrate to client.messages.create, update OUTPUT_SCHEMA, system prompt
├── index.ts             # Remove unknown→generic mapping; LLM now outputs 'generic' directly
├── fast-path.test.ts    # Add verb guard test cases
├── llm-parser.test.ts   # Update mock: client.beta.messages.create → client.messages.create
├── types.test.ts        # Update: 'unknown' cases → 'generic'; add taskCategory tests
└── index.test.ts        # Update: remove unknown→generic mapping test, add generic direct test
```

### Pattern 1: Verb Guard in Fast-Path

**What:** First check in `fastPathParse()` — before FOLLOW_UP_PATTERNS and DEPENDENCY_PATTERNS.

**When to use:** Any input starting with a refactoring verb (`replace`, `rename`, `move`, `extract`, `migrate`, `rewrite`) must skip the dep-update fast path entirely.

**Current `fastPathParse()` entry point (`fast-path.ts`):**
```typescript
export function fastPathParse(input: string): FastPathResult | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // INSERT VERB GUARD HERE — before PR suffix strip, before any patterns
  const REFACTORING_VERB_GUARD = /^(?:replace|rename|move|extract|migrate|rewrite)\s/i;
  if (REFACTORING_VERB_GUARD.test(trimmed)) return null;

  // Strip PR suffix before matching dependency patterns
  const createPr = PR_SUFFIX.test(trimmed);
  // ... rest unchanged
```

**Key insight:** Returning `null` from `fastPathParse()` is the existing protocol for "fall through to LLM". The verb guard follows this same protocol — no new return type needed.

**Edge case confirmed safe:** "replace" alone (no space after) will not match because the pattern requires `\s` after the verb. "replace" with a package name like "replace axios with fetch" will match and return null correctly.

### Pattern 2: IntentSchema and OUTPUT_SCHEMA Update

**What:** Replace `'unknown'` with `'generic'` in the `taskType` enum; add `taskCategory`.

**Current `types.ts` IntentSchema:**
```typescript
taskType: z.enum(['npm-dependency-update', 'maven-dependency-update', 'unknown']),
```

**Target:**
```typescript
taskType: z.enum(['npm-dependency-update', 'maven-dependency-update', 'generic']),
taskCategory: z.enum(['code-change', 'config-edit', 'refactor']).nullable(),
```

**The matching `OUTPUT_SCHEMA` in `llm-parser.ts` must update in sync:**
```typescript
taskType: { type: 'string', enum: ['npm-dependency-update', 'maven-dependency-update', 'generic'] },
taskCategory: { anyOf: [
  { type: 'string', enum: ['code-change', 'config-edit', 'refactor'] },
  { type: 'null' }
]},
// Add 'taskCategory' to required array
```

**`index.ts` change:** Remove the `unknown → generic` mapping. After the schema change, `llmResult.taskType === 'unknown'` is no longer a valid value; the mapping line must be deleted and the `isGeneric` logic updated:

```typescript
// BEFORE:
const isGeneric = llmResult.taskType === 'unknown';
return {
  taskType: isGeneric ? 'generic' : llmResult.taskType,
  ...
};

// AFTER:
const isGeneric = llmResult.taskType === 'generic';
return {
  taskType: llmResult.taskType,   // LLM outputs 'generic' directly
  taskCategory: isGeneric ? llmResult.taskCategory : undefined,
  ...
};
```

### Pattern 3: GA API Migration

**What:** In `llm-parser.ts`, swap `client.beta.messages.create()` → `client.messages.create()`.

**SDK version gate:** This pattern is only valid with SDK ≥0.80.0. In 0.71.2, `client.messages.create()` does not accept `output_config`.

**Current code (`llm-parser.ts` lines 89–103):**
```typescript
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
// ...
let response: BetaMessage;
response = await client.beta.messages.create({
  // ...
  betas: ['structured-outputs-2025-11-13'],
  output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
} as any) as BetaMessage;
```

**Target:**
```typescript
import type { Message } from '@anthropic-ai/sdk/resources/messages/messages.js';
// ...
let response: Message;
response = await client.messages.create({
  model: 'claude-haiku-4-5-20251001',
  max_tokens: 512,
  stream: false,
  system: systemPrompt,
  messages: [...],
  output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
  // NO betas header
});
```

**Type shapes confirmed in SDK 0.80.0:**
- `OutputConfig.format` is `JSONOutputFormat | null`
- `JSONOutputFormat` is `{ type: 'json_schema', schema: { [key: string]: unknown } }`
- `Message` is at `@anthropic-ai/sdk/resources/messages/messages.js`
- `OutputConfig` is at `@anthropic-ai/sdk/resources/messages/messages.js`
- Import from top-level `@anthropic-ai/sdk` works too: `import type { Message } from '@anthropic-ai/sdk'`

**Response parsing is unchanged:** The response still has `content[0].type === 'text'` and `content[0].text` in the GA API. No change needed to the JSON parsing block.

### Pattern 4: System Prompt Update

**What:** Replace dep-update-focused system prompt with one that classifies `generic` correctly.

**Current system prompt (relevant excerpt):**
```
1. taskType: 'npm-dependency-update', 'maven-dependency-update', or 'unknown'
...
Rules:
- If the user's request doesn't match a dependency update pattern, set taskType to 'unknown'.
- For unknown task types, set dep to null and confidence to 'high' (pass through as generic task).
```

**Target additions:**
- Change enum in rule 1: `'npm-dependency-update', 'maven-dependency-update', or 'generic'`
- Add rule: `"generic = any explicit code change instruction (replace, rename, edit config, add/remove code). NOT task discovery, analysis, or multi-repo ops"`
- Update taskCategory rule: `"For generic tasks, classify as 'code-change', 'config-edit', or 'refactor'"`
- Update confidence rules: high when single clear action; low when vague, multi-concern, or task discovery
- Change `taskType: 'unknown'` references to `taskType: 'generic'` throughout

### Anti-Patterns to Avoid

- **Updating OUTPUT_SCHEMA without updating IntentSchema in sync:** The schema drives both Zod validation and the JSON schema sent to the API. They must match exactly or `IntentSchema.parse()` will throw on valid API responses.
- **Keeping the `unknown → generic` mapping after removing `'unknown'` from the enum:** After the enum change, Zod will throw on any LLM response containing `taskType: 'unknown'`. The mapping removal in `index.ts` must happen at the same time as the schema change.
- **Calling `client.messages.create()` with `output_config` before SDK bump:** SDK 0.71.2 does not accept `output_config` on the GA path — TypeScript will error and the runtime will fail.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Structured output guarantee | Custom JSON extraction regex | `output_config.format` with `json_schema` | Grammar-constrained generation; no regex fragility |
| Zod schema → JSON schema | Manual JSON schema object | Keep the existing `OUTPUT_SCHEMA` pattern | The project already hand-maintains it; it works |
| Response type parsing after API call | New parsing layer | Existing `block.type === 'text'` + `IntentSchema.parse(JSON.parse(block.text))` | GA API response shape is identical to beta for text content |

**Key insight:** The GA API migration is purely about which method is called — the response parsing code (`content[0]`, `block.type`, `block.text`) is unchanged. No new parsing layer is needed.

## Common Pitfalls

### Pitfall 1: SDK Version Mismatch
**What goes wrong:** `client.messages.create()` does not accept `output_config` in SDK 0.71.2 — TypeScript error at compile time, runtime failure in tests.
**Why it happens:** Structured outputs graduated from `client.beta` to `client.messages` only in SDK 0.80.0.
**How to avoid:** Bump `@anthropic-ai/sdk` to `^0.80.0` before writing the migration code. Run `npm install` and verify compile step passes.
**Warning signs:** TS error "Object literal may only specify known properties" on `output_config` in `messages.create()`.

### Pitfall 2: Schema and Enum Out of Sync
**What goes wrong:** `IntentSchema` says `taskType` accepts `'generic'` but `OUTPUT_SCHEMA` still has `'unknown'` (or vice versa), causing `IntentSchema.parse()` to throw on valid LLM responses.
**Why it happens:** Two representations of the same schema must be updated together — the Zod schema in `types.ts` and the JSON schema object in `llm-parser.ts`.
**How to avoid:** Change both in the same task. Run `vitest run src/intent/types.test.ts` immediately after.
**Warning signs:** `LlmParseError: LLM returned invalid JSON or schema mismatch` in tests.

### Pitfall 3: `unknown → generic` Mapping Left in Place
**What goes wrong:** After removing `'unknown'` from the enum, any LLM response with `taskType: 'unknown'` will fail Zod parsing before reaching the mapping. But if the mapping is left in `index.ts` it's dead code that obscures intent.
**Why it happens:** The mapping (`isGeneric = llmResult.taskType === 'unknown'`) predates the enum change and was the previous workaround.
**How to avoid:** Remove the mapping when updating the schema. The new pattern is: LLM outputs `'generic'` directly, `index.ts` reads it directly.

### Pitfall 4: Test Mock Points at Wrong Path
**What goes wrong:** `llm-parser.test.ts` mocks `client.beta.messages.create`. After migration, the production code calls `client.messages.create`. The mock will never be hit — all test assertions pass vacuously and the real function throws "undefined is not a function".
**Why it happens:** `vi.mock('@anthropic-ai/sdk', ...)` must return an object matching the new structure: `{ default: function MockAnthropic() { return { messages: { create: mockCreate } } } }`.
**How to avoid:** Update the mock in `llm-parser.test.ts` at the same time as the production change. Remove the `beta.messages.create` path from the mock entirely.
**Warning signs:** Tests pass but the mock assertion `expect(mockCreate).toHaveBeenCalledOnce()` fails.

### Pitfall 5: Verb Guard Placed After PR Suffix Strip
**What goes wrong:** "replace axios with fetch and create PR" strips the PR suffix first to produce "replace axios with fetch", then the verb guard fires. If the verb guard fires before stripping, the check still works because `replace` remains at the start. But placing it after the strip is also fine — the key is it must run before any dependency pattern matching.
**Why it happens:** Reading the insertion point incorrectly in the existing code.
**How to avoid:** The locked decision says "before running any dependency patterns". Insert BEFORE the `createPr = PR_SUFFIX.test(trimmed)` line, not after. This is the safest position — it fires on the raw input, immediately after the null-check for empty string.

## Code Examples

### Verb Guard (Source: existing fast-path.ts pattern + locked CONTEXT.md decision)
```typescript
// fast-path.ts — insert at top of fastPathParse(), after empty-string guard
const REFACTORING_VERB_GUARD = /^(?:replace|rename|move|extract|migrate|rewrite)\s/i;

export function fastPathParse(input: string): FastPathResult | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Verb guard: refactoring instructions force LLM classification
  if (REFACTORING_VERB_GUARD.test(trimmed)) return null;

  // ... rest of existing code unchanged
}
```

### GA API Call (Source: SDK 0.80.0 type definitions, official Anthropic docs)
```typescript
// llm-parser.ts — after SDK bump to ^0.80.0
import type { Message } from '@anthropic-ai/sdk/resources/messages/messages.js';
// Remove: import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';

let response: Message;
try {
  response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    stream: false,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
    output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
    // No betas array
  });
} catch (err) { ... }
```

### Updated Test Mock (Source: existing llm-parser.test.ts structure)
```typescript
// llm-parser.test.ts — after migration
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: function MockAnthropic() {
      return {
        messages: {        // was: beta.messages
          create: mockCreate,
        },
      };
    },
  };
});
```

### Updated IntentSchema (Source: CONTEXT.md locked decision)
```typescript
// types.ts
export const IntentSchema = z.object({
  taskType: z.enum(['npm-dependency-update', 'maven-dependency-update', 'generic']),
  // Remove 'unknown' — LLM outputs 'generic' directly
  dep: z.string().nullable(),
  version: z.enum(['latest']).nullable(),
  confidence: z.enum(['high', 'low']),
  createPr: z.boolean(),
  taskCategory: z.enum(['code-change', 'config-edit', 'refactor']).nullable(),
  clarifications: z.array(z.object({
    label: z.string(),
    intent: z.string(),
  })),
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `client.beta.messages.create()` + `betas: ['structured-outputs-2025-11-13']` | `client.messages.create()` + `output_config.format` (no betas header) | SDK 0.80.0 (2026-03-18) | Remove beta header, remove `as any` cast, clean import path |
| `taskType: 'unknown'` + post-hoc mapping to 'generic' | `taskType: 'generic'` directly from LLM | Phase 18 | One less indirection; schema is honest |
| No verb guard in fast-path | Verb guard as first check | Phase 18 | Prevents "replace axios with fetch" from matching dep update pattern |

**Deprecated/outdated:**
- `betas: ['structured-outputs-2025-11-13']`: Removed in SDK 0.80.0 GA migration
- `client.beta.messages.create()` for structured outputs: Use `client.messages.create()` from SDK ≥0.80.0
- `import type { BetaMessage }`: Replace with `import type { Message }` from GA path
- `taskType: 'unknown'` in IntentSchema: Replace with `'generic'`

## Open Questions

1. **`ResolvedIntent.taskCategory` field**
   - What we know: CONTEXT.md says to add `taskCategory` to the LLM schema output; `confirm-loop.ts` display is Phase 19 scope
   - What's unclear: Whether `ResolvedIntent` in `types.ts` also needs a `taskCategory?: string | null` field added (needed for `parseIntent()` to pass it through to callers)
   - Recommendation: Add `taskCategory?: 'code-change' | 'config-edit' | 'refactor' | null` to `ResolvedIntent` so it's available when Phase 19 needs to display it. Low risk — it's additive.

2. **`stream: false` in `client.messages.create()` after SDK bump**
   - What we know: The current call includes `stream: false`; the GA `MessageCreateParamsNonStreaming` likely has `stream?: false`
   - What's unclear: Whether `stream: false` is accepted or if it should be omitted
   - Recommendation: Keep `stream: false` for explicitness; the TypeScript compiler will error if it's not accepted.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest ^4.0.18 |
| Config file | none — vitest auto-discovers |
| Quick run command | `npx vitest run src/intent/` |
| Full suite command | `npm test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| INTENT-01 | LLM outputs `taskType: 'generic'` and `parseIntent()` passes it through directly | unit | `npx vitest run src/intent/types.test.ts src/intent/index.test.ts` | Yes (update existing) |
| INTENT-01 | `IntentSchema` rejects `taskType: 'unknown'` | unit | `npx vitest run src/intent/types.test.ts` | Yes (update existing) |
| INTENT-01 | `IntentSchema` accepts `taskType: 'generic'` with `taskCategory` | unit | `npx vitest run src/intent/types.test.ts` | Yes (update existing) |
| INTENT-02 | `fastPathParse('replace axios with fetch')` returns `null` | unit | `npx vitest run src/intent/fast-path.test.ts` | Yes (add cases) |
| INTENT-02 | `fastPathParse('rename getUserData to fetchUserProfile')` returns `null` | unit | `npx vitest run src/intent/fast-path.test.ts` | Yes (add cases) |
| INTENT-02 | `fastPathParse('replace axios with fetch and create PR')` returns `null` | unit | `npx vitest run src/intent/fast-path.test.ts` | Yes (add cases) |
| INTENT-02 | `fastPathParse('update recharts')` still returns dep result (not blocked) | unit | `npx vitest run src/intent/fast-path.test.ts` | Yes (existing) |
| INTENT-03 | `client.messages.create` is called (not `client.beta.messages.create`) | unit | `npx vitest run src/intent/llm-parser.test.ts` | Yes (update mock) |
| INTENT-03 | No `betas` array in the call args | unit | `npx vitest run src/intent/llm-parser.test.ts` | Yes (update existing assertion) |

### Sampling Rate
- **Per task commit:** `npx vitest run src/intent/`
- **Per wave merge:** `npm test`
- **Phase gate:** `npm test` full suite green before `/gsd:verify-work`

### Wave 0 Gaps
None — existing test infrastructure covers all phase requirements. Files exist and only need updates, not creation.

## Sources

### Primary (HIGH confidence)
- SDK 0.80.0 installed locally at `/tmp/sdk-check/node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts` — confirmed `output_config?: OutputConfig` on `MessageCreateParamsBase`, `OutputConfig.format: JSONOutputFormat | null`, `JSONOutputFormat { type: 'json_schema', schema: {...} }`
- `@anthropic-ai/sdk` CHANGELOG.md (installed 0.71.2) — confirmed structured outputs added as beta in v0.69.0 (2025-11-14); GA endpoint confirmed absent in 0.71.2
- Project source `src/intent/llm-parser.ts` — confirmed `client.beta.messages.create()` with `betas: ['structured-outputs-2025-11-13']` is the current call
- Project source `src/intent/fast-path.ts` — confirmed insertion point for verb guard
- Project source `src/intent/types.ts` — confirmed `'unknown'` in enum, no `taskCategory` field
- Official Anthropic docs `platform.claude.com/docs/en/build-with-claude/structured-outputs` — confirmed GA `client.messages.create()` with `output_config.format`, no betas header required

### Secondary (MEDIUM confidence)
- `npm view @anthropic-ai/sdk version` output: `0.80.0` — latest published version
- SDK 0.80.0 `resources/messages/messages.d.ts` line 1881: `output_config?: OutputConfig` on `MessageCreateParamsBase`

### Tertiary (LOW confidence)
None.

## Metadata

**Confidence breakdown:**
- SDK version gate: HIGH — verified by installing SDK 0.80.0 and inspecting type definitions
- Verb guard insertion point: HIGH — read actual source code
- Schema change details: HIGH — locked in CONTEXT.md, confirmed against existing types.ts
- GA API call shape: HIGH — verified in SDK 0.80.0 type definitions and official docs
- Test update scope: HIGH — read all test files directly

**Research date:** 2026-03-23
**Valid until:** 2026-04-23 (SDK 0.80.0 is current; structured outputs are GA and stable)
