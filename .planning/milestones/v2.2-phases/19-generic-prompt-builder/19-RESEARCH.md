# Phase 19: Generic Prompt Builder - Research

**Researched:** 2026-03-24
**Domain:** TypeScript prompt builder, intent display, async refactor, PR creator adaptation
**Confidence:** HIGH

## Summary

Phase 19 is a pure in-codebase engineering phase — no external libraries, no new dependencies, no infrastructure changes. The work is fully constrained by reading existing source files. Every pattern needed already exists in `npm.ts`, `maven.ts`, `confirm-loop.ts`, `context-scanner.ts`, and `pr-creator.ts`. The task is to replicate those patterns for the `generic` task type path.

The only structural change with ripple effects is making `buildPrompt()` async (from `string` to `Promise<string>`). This touches one call site in `src/agent/index.ts` (line 169), one mock in `src/agent/index.test.ts`, and tests in `src/prompts/npm.test.ts` and `src/prompts/maven.test.ts` that call `buildPrompt()` synchronously. Everything else is additive.

The PR creator adaptation is straightforward: `generateBranchName()` already accepts any string, so passing `taskCategory/slug-of-description` requires no function signature changes — only the calling code in `GitHubPRCreator.create()` needs a conditional for generic tasks.

**Primary recommendation:** Implement `buildGenericPrompt()` first (isolated, testable in isolation), then wire async `buildPrompt()`, then update `displayIntent()`, then adapt PR creator. Each step is independently testable.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Scope fence design:**
- Instruction-derived scope fence: parse key terms from user instruction, generate natural-language SCOPE block
- User instruction included verbatim in the prompt — no paraphrasing or rewriting (per REQUIREMENTS.md out-of-scope: "Automatic instruction rewriting")
- SCOPE block follows the npm/maven pattern: explicit "Do NOT" list (no unrelated deps, no unrelated files, no restructuring, no style changes)
- Include end-state "After your changes, the following should be true:" block derived from the instruction — follows established pattern from npm.ts/maven.ts
- Include "Work in the current directory." line at the end — consistent with existing builders

**Repo context injection:**
- Use existing `readManifestDeps()` from `context-scanner.ts` for manifest summary (package.json deps, pom.xml deps)
- Fetch manifest at prompt-build time inside `buildGenericPrompt()`, not during intent parsing
- Add `repoPath?: string` to `PromptOptions` interface — buildGenericPrompt() uses it to call readManifestDeps()
- If readManifestDeps() returns 'No manifest found', omit the CONTEXT block entirely — agent self-discovers
- Make `buildPrompt()` async (returns `Promise<string>`) since readManifestDeps() is async — update callers (agent/index.ts, tests)

**Confirm loop display:**
- Display `taskCategory` ('code-change', 'config-edit', 'refactor') in the Task line instead of raw 'generic'
- Add "Action:" line showing the raw user instruction (description field)
- Truncate description at 80 characters with ellipsis in display — full text still used in prompt
- Layout for generic tasks:
  ```
  Parsed Intent:
    Task:     code-change
    Action:   replace axios with fetch
    Project:  my-app
    PR:       yes
  ```
- Dep/Version lines hidden when null (already the case — just verify)

**Retry prompt preservation:**
- Existing flow is correct: `buildPrompt()` output passed as `originalTask` to `orchestrator.run()` — retries reuse the same string
- No separate caching needed — just verify generic path follows the same flow as npm/maven
- Prompt is built once, includes SCOPE + CONTEXT + end-state, and survives all retry attempts unchanged

**PR creator adaptation:**
- Adapt `GitHubPRCreator` for generic tasks: derive branch name from taskCategory + short slug of description (e.g., 'code-change/replace-axios-with-fetch')
- PR title uses the instruction text — meaningful for reviewers
- PR body includes the instruction and taskCategory label

### Claude's Discretion
- Exact wording of the SCOPE "Do NOT" items beyond the core four
- How to extract key terms from instruction for the SCOPE subject line
- Branch name slug generation (length limits, character sanitization)
- Test coverage breadth for the new builder and display changes

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| PROMPT-01 | Generic prompt builder constructs end-state prompt from user instruction + repo context (language, build tool, manifest summary) | `buildGenericPrompt(description, repoPath?)` follows npm/maven pattern; `readManifestDeps()` provides manifest summary; async `buildPrompt()` wires the path |
| PROMPT-02 | Generic task system prompt includes explicit scope constraint preventing agent from touching unrelated files | SCOPE block using "Do NOT" list — exact pattern from npm.ts line 33-38 and maven.ts line 26-30; instruction-derived subject line |
| PROMPT-03 | Confirm loop displays instruction summary and planned approach for generic tasks (not just dep/version fields) | `displayIntent()` gets a generic branch: shows taskCategory on Task line, adds Action line with truncated description |
</phase_requirements>

## Standard Stack

### Core (all pre-existing — no new installs)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| TypeScript | ^5.x (project) | All source files | Project language |
| vitest | ^1.x (project) | Test framework | Already used across all test files |
| picocolors | pre-existing | Terminal color in displayIntent | Already imported in confirm-loop.ts |

**Installation:** No new packages needed.

## Architecture Patterns

### Existing Project Structure (relevant paths)
```
src/
├── prompts/
│   ├── index.ts         # buildPrompt() dispatch + PromptOptions — MODIFY
│   ├── npm.ts           # Pattern to replicate
│   ├── maven.ts         # Pattern to replicate
│   └── generic.ts       # NEW — buildGenericPrompt()
├── intent/
│   ├── confirm-loop.ts  # displayIntent() — MODIFY
│   ├── context-scanner.ts  # readManifestDeps() — read-only import
│   └── types.ts         # ResolvedIntent, TaskCategory — read-only
├── agent/
│   └── index.ts         # buildPrompt() call site — MODIFY (add await + repoPath)
└── orchestrator/
    └── pr-creator.ts    # GitHubPRCreator.create() + generateBranchName() — MODIFY
```

### Pattern 1: End-State Prompt Builder (npm/maven pattern)
**What:** Pure function, returns string, structured as: header line → SCOPE block → After your changes block → Work in the current directory.
**When to use:** All task types — this is the established project pattern.
**Example (from npm.ts):**
```typescript
// Source: src/prompts/npm.ts
return [
  firstLine,
  '',
  `SCOPE: Only modify what is necessary to update ${packageName}. Do NOT:`,
  `- Add, remove, or update any other dependencies`,
  `- Change scripts, project configuration, or unrelated fields in package.json`,
  `- Reformat or reorganize package.json beyond the targeted version change`,
  `- Modify files unrelated to the ${packageName} version update`,
  '',
  `After your changes, the following should be true:`,
  afterChangesVersion,
  `- Only the ${packageName} version line in package.json has changed`,
  '',
  `Work in the current directory.`,
].join('\n');
```

### Pattern 2: Async buildPrompt() dispatch
**What:** Switch on taskType, `case 'generic'` calls `await buildGenericPrompt(options.description, options.repoPath)`.
**When to use:** `buildGenericPrompt()` is the only async builder — others remain sync internally.

```typescript
// Source: src/prompts/index.ts (current sync signature — becomes async)
export async function buildPrompt(options: PromptOptions): Promise<string> {
  switch (options.taskType) {
    case 'generic': {
      return buildGenericPrompt(options.description ?? '', options.repoPath);
    }
    // ... existing cases unchanged ...
  }
}
```

Callers that become async:
- `src/agent/index.ts:169` — already in async `runAgent()`, just add `await`
- Test files that call `buildPrompt()` for non-generic types — add `await`, update vitest mock to `mockResolvedValue`

### Pattern 3: Conditional displayIntent() branch
**What:** Check `intent.taskType === 'generic'` inside `displayIntent()`, swap Task line value from raw taskType to taskCategory, add Action line.
**When to use:** Already pattern used for inherited fields (`intent.inheritedFields?.includes('taskType')`).

```typescript
// Source: src/intent/confirm-loop.ts (current displayIntent)
const taskLabel = intent.taskType === 'generic'
  ? (intent.taskCategory ?? 'generic')
  : intent.taskType;
console.log(`    Task:    ${pc.cyan(taskLabel)}${taskSuffix}`);
if (intent.taskType === 'generic' && intent.description) {
  const truncated = intent.description.length > 80
    ? intent.description.slice(0, 80) + '...'
    : intent.description;
  console.log(`    Action:  ${pc.cyan(truncated)}`);
}
```

### Pattern 4: PR creator generic branch naming
**What:** In `GitHubPRCreator.create()`, when `opts.taskType === 'generic'`, build branch input from `taskCategory/description-slug` instead of passing raw `taskType` to `generateBranchName()`.
**When to use:** `opts.taskType === 'generic'` — all other task types use existing path unchanged.

`generateBranchName()` already handles slugification (lowercase, replace non-alphanumeric with hyphens, collapse, trim, append date+hex). The only question is what string to pass. Decision: `${taskCategory}/${shortSlug}` where shortSlug truncates description to a reasonable length (e.g., 40 chars) before slugification.

PR title for generic: `opts.description` (verbatim, up to a character limit) rather than `Agent: generic YYYY-MM-DD`.

### Anti-Patterns to Avoid
- **Rewriting the user instruction:** The `description` field flows verbatim. Do NOT rephrase or summarize it — per REQUIREMENTS.md out-of-scope and TASK-04 decisions.
- **Building `buildGenericPrompt()` as sync with a workaround:** It must be async because `readManifestDeps()` is async. Do not try to pre-fetch manifests to keep buildPrompt sync.
- **Forgetting to update the `index.test.ts` mock:** `buildPrompt` is mocked as `vi.fn().mockReturnValue(...)` — must become `vi.fn().mockResolvedValue(...)` once buildPrompt is async.
- **Skipping the "No manifest found" guard:** The CONTEXT block must be entirely omitted (not shown as empty) when readManifestDeps returns 'No manifest found'.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Manifest reading | Custom file reader | `readManifestDeps()` from context-scanner.ts | Already handles package.json + pom.xml, tested for all edge cases |
| Branch name slugification | Custom slug function | `generateBranchName(inputString)` from pr-creator.ts | Already handles lowercase, hyphen collapsing, trim, date+hex suffix |
| Terminal colors in display | `\x1b[...m` escape codes | `picocolors` (already imported) | Already used in every displayIntent line |

## Common Pitfalls

### Pitfall 1: Async mock not updated in agent/index.test.ts
**What goes wrong:** After making `buildPrompt()` return `Promise<string>`, the existing mock `vi.fn().mockReturnValue('Fix the bug')` returns a string directly. `await buildPrompt(...)` on a string gives the string, but TypeScript will complain and the mock will not behave correctly in tests that check mock.calls and mock.results.
**Why it happens:** The mock was written when `buildPrompt()` was synchronous.
**How to avoid:** Change mock to `vi.fn().mockResolvedValue('Fix the bug')` in `src/agent/index.test.ts` at the same time as the signature change.
**Warning signs:** TypeScript compiler error `Type 'string' is not assignable to type 'Promise<string>'` in test file.

### Pitfall 2: Existing buildPrompt tests become async
**What goes wrong:** `npm.test.ts` and `maven.test.ts` call `buildPrompt(...)` synchronously and pass the result directly to `expect(result).toContain(...)`. Once `buildPrompt` is async, `result` is a Promise, not a string.
**Why it happens:** Tests were correct when function was synchronous.
**How to avoid:** Add `await` to each `buildPrompt(...)` call in both test files and mark test callbacks as `async`.
**Warning signs:** `expect(result).toContain(...)` passes on a Promise object (falsy match) rather than failing loudly in some vitest versions.

### Pitfall 3: taskCategory is nullable on ResolvedIntent
**What goes wrong:** `intent.taskCategory` is typed as `TaskCategory | null | undefined`. Using it directly as a display string without a null guard causes 'null' to appear in the Task line.
**Why it happens:** The IntentSchema refine only enforces taskCategory is non-null when taskType is 'generic', but TypeScript sees the field as nullable.
**How to avoid:** Use `intent.taskCategory ?? 'generic'` as the fallback in displayIntent.

### Pitfall 4: PR title length
**What goes wrong:** `opts.description` (the full instruction) can be long. GitHub PR titles are displayed in lists and 200+ character titles truncate poorly.
**Why it happens:** No length constraint is documented in the decision.
**How to avoid:** Truncate PR title to a reasonable limit (e.g., 72 chars). This is Claude's discretion per CONTEXT.md.

### Pitfall 5: Branch name with forward slash
**What goes wrong:** `generateBranchName()` takes a flat string and produces `agent/<slug>-date-hex`. If we pass `code-change/replace-axios-with-fetch`, the slash passes through and the final branch becomes `agent/code-change/replace-axios-with-fetch-2026-03-24-a1b2c3` — which is valid git but may confuse some tools.
**Why it happens:** The slash is treated as a path separator by `generateBranchName`'s current implementation — it does NOT strip slashes (only `[^a-z0-9]+` → hyphen). Wait: actually `/` matches `[^a-z0-9]+` and becomes a hyphen. So `code-change/replace-axios-with-fetch` slugifies to `code-change-replace-axios-with-fetch`.
**How to avoid:** Let `generateBranchName()` handle the slugification naturally — pass the desired human label and let the function clean it. Verified: `/` matches the non-alphanumeric regex and becomes `-`.

## Code Examples

Verified patterns from existing source files:

### buildGenericPrompt() — structure to follow (based on npm.ts/maven.ts)
```typescript
// NEW: src/prompts/generic.ts
export async function buildGenericPrompt(
  description: string,
  repoPath?: string,
): Promise<string> {
  const lines: string[] = [
    `You are a coding agent. ${description}`,
    '',
    `SCOPE: Only make changes necessary to accomplish the stated task. Do NOT:`,
    `- Modify files unrelated to the task`,
    `- Add or remove dependencies unless the task explicitly requires it`,
    `- Restructure the codebase or reorganize files beyond what the task requires`,
    `- Apply stylistic or formatting changes outside of modified code`,
    '',
    `After your changes, the following should be true:`,
    `- ${description}`,
    `- No files outside the task scope have been modified`,
    '',
  ];

  if (repoPath) {
    const manifestDeps = await readManifestDeps(repoPath);
    if (manifestDeps !== 'No manifest found') {
      lines.splice(lines.length - 1, 0,
        `CONTEXT:`,
        manifestDeps,
        '',
      );
    }
  }

  lines.push(`Work in the current directory.`);
  return lines.join('\n');
}
```

### PromptOptions extension
```typescript
// Source: src/prompts/index.ts (current interface — to extend)
export interface PromptOptions {
  taskType: string;
  dep?: string;
  targetVersion?: string;
  description?: string;
  repoPath?: string;  // ADD: for buildGenericPrompt() manifest lookup
}
```

### buildPrompt() call site update (agent/index.ts)
```typescript
// Source: src/agent/index.ts line 169 — current sync call
const prompt = buildPrompt({
  taskType: options.taskType,
  dep: options.dep,
  targetVersion: resolvedVersion,
  description: options.description,
});

// BECOMES: add await + repoPath
const prompt = await buildPrompt({
  taskType: options.taskType,
  dep: options.dep,
  targetVersion: resolvedVersion,
  description: options.description,
  repoPath: options.repo,
});
```

### readManifestDeps() — already works, no changes needed
```typescript
// Source: src/intent/context-scanner.ts
export async function readManifestDeps(repoPath: string): Promise<string>
// Returns: 'No manifest found' | 'package.json dependencies: ...\npackage.json devDependencies: ...'
```

### generateBranchName() — no signature change needed
```typescript
// Source: src/orchestrator/pr-creator.ts
export function generateBranchName(taskType: string): string
// Input: 'code-change/replace axios with fetch'
// Output: 'agent/code-change-replace-axios-with-fetch-2026-03-24-a1b2c3'
// Reason: '/' and ' ' both match [^a-z0-9]+ and become '-'
```

## State of the Art

| Old Approach | Current Approach | Notes |
|--------------|------------------|-------|
| Sync `buildPrompt()` returning string | Async `buildPrompt()` returning `Promise<string>` | Phase 19 change — required for `readManifestDeps()` |
| Generic tasks fell through to bare fallback: `"You are a coding agent. Your task: X. Work in the current directory."` | Full end-state prompt with SCOPE + CONTEXT + After block | Phase 19 change |
| `displayIntent` showed raw 'generic' taskType | Shows `taskCategory` label + Action line | Phase 19 change |

## Open Questions

1. **PR title character limit for generic tasks**
   - What we know: GitHub renders PR titles in list views; very long titles truncate
   - What's unclear: No explicit limit stated in CONTEXT.md decisions
   - Recommendation: Truncate at 72 chars with ellipsis (standard git commit subject convention); this is Claude's discretion

2. **SCOPE subject line for instructions that have no clear "key terms"**
   - What we know: The instruction is passed verbatim as the SCOPE subject. For a short instruction like "refactor the auth module" this works well. For longer instructions, the first line may be verbose.
   - What's unclear: Whether to extract a "key phrase" or use the full description
   - Recommendation: Use the full description as-is for the SCOPE subject line (verbatim per CONTEXT.md). Keep it simple.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest (vitest.config.ts present, 526 tests currently passing) |
| Config file | `/Users/kiruba/code/Projects/ai/background-coding-agent/vitest.config.ts` |
| Quick run command | `npm test` |
| Full suite command | `npm test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PROMPT-01 | `buildGenericPrompt(description, repoPath)` returns prompt with instruction + manifest deps | unit | `npm test -- src/prompts/generic.test.ts` | Wave 0 |
| PROMPT-01 | `buildGenericPrompt` omits CONTEXT block when manifest not found | unit | `npm test -- src/prompts/generic.test.ts` | Wave 0 |
| PROMPT-01 | `buildPrompt({taskType:'generic', description, repoPath})` dispatches correctly | unit | `npm test -- src/prompts/generic.test.ts` | Wave 0 |
| PROMPT-02 | Prompt includes SCOPE block with "Do NOT" lines | unit | `npm test -- src/prompts/generic.test.ts` | Wave 0 |
| PROMPT-02 | Prompt includes "After your changes, the following should be true:" | unit | `npm test -- src/prompts/generic.test.ts` | Wave 0 |
| PROMPT-02 | Prompt includes "Work in the current directory." | unit | `npm test -- src/prompts/generic.test.ts` | Wave 0 |
| PROMPT-03 | `displayIntent` shows taskCategory not 'generic' for generic tasks | unit | `npm test -- src/intent/confirm-loop.test.ts` | ✅ (extend) |
| PROMPT-03 | `displayIntent` shows Action line with description for generic tasks | unit | `npm test -- src/intent/confirm-loop.test.ts` | ✅ (extend) |
| PROMPT-03 | `displayIntent` truncates description at 80 chars | unit | `npm test -- src/intent/confirm-loop.test.ts` | ✅ (extend) |

### Sampling Rate
- **Per task commit:** `npm test`
- **Per wave merge:** `npm test`
- **Phase gate:** All 526+ tests green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/prompts/generic.test.ts` — covers PROMPT-01, PROMPT-02 (new file, new builder)
- [ ] `src/agent/index.test.ts` mock update — `mockReturnValue` → `mockResolvedValue` (existing file, requires edit when buildPrompt goes async)
- [ ] `src/prompts/npm.test.ts` + `src/prompts/maven.test.ts` — add `await` to buildPrompt calls (existing files, requires edit when buildPrompt goes async)

## Sources

### Primary (HIGH confidence)
- Direct read of `src/prompts/npm.ts` — SCOPE block structure, "After your changes" pattern, "Work in the current directory" line
- Direct read of `src/prompts/maven.ts` — same pattern confirmed
- Direct read of `src/prompts/index.ts` — current `buildPrompt()` sync signature, `PromptOptions` interface, switch dispatch
- Direct read of `src/intent/confirm-loop.ts` — `displayIntent()` current behavior, conditional field display pattern
- Direct read of `src/intent/context-scanner.ts` — `readManifestDeps()` signature and return value semantics
- Direct read of `src/agent/index.ts` — `buildPrompt()` call site at line 169, `runAgent()` async context
- Direct read of `src/orchestrator/pr-creator.ts` — `generateBranchName()` slugification regex, `GitHubPRCreator.create()` signature
- Direct read of `src/agent/index.test.ts` — mock pattern for `buildPrompt` (`mockReturnValue` → needs `mockResolvedValue`)
- Direct read of `src/prompts/npm.test.ts`, `maven.test.ts` — sync `buildPrompt()` call sites that need `await`

### Secondary (MEDIUM confidence)
- N/A — all findings from direct source inspection

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all pre-existing, no new dependencies
- Architecture: HIGH — directly read from source files, patterns are explicit
- Pitfalls: HIGH — derived from direct code inspection of affected call sites and mock patterns

**Research date:** 2026-03-24
**Valid until:** Stable for duration of Phase 19 (pure in-codebase change, no external dependencies)
