# Phase 18: Intent Parser Generalization - Context

**Gathered:** 2026-03-23
**Status:** Ready for planning

<domain>
## Phase Boundary

The intent parser correctly classifies any explicit code change instruction as `generic` task type and migrates off the deprecated beta structured outputs API. This phase does NOT build the generic prompt or modify verification — those are Phases 19 and 20.

</domain>

<decisions>
## Implementation Decisions

### Verb guard design
- Pre-filter check at the top of `fastPathParse()` — before running any dependency patterns
- Six refactoring verbs intercepted: `replace`, `rename`, `move`, `extract`, `migrate`, `rewrite`
- Block unconditionally — if input starts with a refactoring verb, return `null` immediately and force LLM classification
- No extra validation for dep verbs like "update" — the existing regex already requires a package-name-like token; inputs like "update the config file" won't match

### Generic schema shape
- Add `'generic'` to `IntentSchema.taskType` enum; remove `'unknown'`
- Remove the `unknown` → `generic` mapping in `parseIntent()` — LLM outputs `'generic'` directly
- Do NOT add a `description` field to the LLM output schema — raw user input is the description (per out-of-scope: "Automatic instruction rewriting")
- `parseIntent()` continues to set `description` from raw input for generic intents (existing behavior)
- Add `taskCategory: z.enum(['code-change', 'config-edit', 'refactor']).nullable()` to schema — LLM classifies the category for confirm loop display
- `dep` and `version` remain in schema but are `null` for generic intents

### GA API migration
- Migrate `client.beta.messages.create()` → `client.messages.create()` with `output_config.format`
- Remove `betas: ['structured-outputs-2025-11-13']` header
- Check current SDK version (^0.71.2) supports GA structured outputs; bump only if needed
- Clean types — import `Message` from standard SDK path, remove `as any` and `as BetaMessage` casts. Aim for zero type assertions
- Update all test mocks from `client.beta.messages.create()` to `client.messages.create()` — clean break, no compatibility shim

### Confidence & clarification for generic intents
- Low confidence when: instruction is vague ("clean up the code"), spans multiple unrelated changes, or sounds like task discovery ("find all deprecated calls")
- High confidence when: single clear action ("replace axios with fetch", "rename getUserData to fetchUserProfile")
- Clarifications for low-confidence generic intents: narrowed-down interpretations — e.g., `{label: 'Replace axios calls with fetch', intent: 'replace axios with fetch in all source files'}`
- Task discovery inputs classified as low-confidence generic with clarifications guiding toward explicit instructions — not rejected outright
- LLM system prompt includes explicit guidance: "generic = any explicit code change instruction (replace, rename, edit config, add/remove code). NOT task discovery, analysis, or multi-repo ops"

### Claude's Discretion
- Exact LLM system prompt wording for generic classification rules
- OUTPUT_SCHEMA structure changes (JSON schema shape for structured outputs)
- Test case selection and coverage breadth
- Whether to add helper types or keep inline

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Intent parser implementation
- `src/intent/types.ts` — IntentSchema Zod definition, ResolvedIntent interface, ClarificationOption type
- `src/intent/fast-path.ts` — Fast-path regex patterns, DEPENDENCY_PATTERNS, detectTaskType(), verb guard insertion point
- `src/intent/llm-parser.ts` — LLM structured outputs call, OUTPUT_SCHEMA, system prompt, BetaMessage import
- `src/intent/index.ts` — parseIntent() coordinator, unknown→generic mapping (to be removed), description assignment

### Tests
- `src/intent/fast-path.test.ts` — Regex pattern tests, negative cases
- `src/intent/llm-parser.test.ts` — Mock structured outputs, beta header verification (to be updated)
- `src/intent/types.test.ts` — Schema validation tests

### Confirm loop
- `src/intent/confirm-loop.ts` — Interactive confirmation UI, needs to display taskCategory for generic tasks

### Requirements
- `.planning/REQUIREMENTS.md` — INTENT-01, INTENT-02, INTENT-03 requirements

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `fastPathParse()` in `fast-path.ts` — insert verb guard as first check before existing patterns
- `IntentSchema` in `types.ts` — extend enum, add taskCategory field
- `parseIntent()` in `index.ts` — already maps unknown→generic and sets description from input
- `OUTPUT_SCHEMA` in `llm-parser.ts` — JSON schema for structured outputs, needs new fields

### Established Patterns
- Zod schema → JSON schema conversion for structured outputs (existing pattern in llm-parser.ts)
- Fast-path returns `null` to signal "fall through to LLM" — verb guard follows same pattern
- `ResolvedIntent.description` already populated for generic tasks — downstream consumers expect this

### Integration Points
- `confirm-loop.ts` — needs to display `taskCategory` label for generic tasks (Phase 18 scope: schema only, display in Phase 19)
- `src/prompts/index.ts` — consumes `ResolvedIntent.taskType` for prompt selection (Phase 19 builds generic prompt)
- `src/agent/runner.ts` — consumes `ResolvedIntent` to configure agent session

</code_context>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 18-intent-parser-generalization*
*Context gathered: 2026-03-23*
