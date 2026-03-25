# Phase 20: Verification & Safety - Research

**Researched:** 2026-03-24
**Domain:** Verification pipeline — zero-diff detection, change-type-aware routing, LLM Judge calibration
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Zero-diff detection:**
- Detect in RetryOrchestrator, after session succeeds but before calling verifier/judge
- Reuse `getWorkspaceDiff()` from `judge.ts` (already handles baseline SHA, committed+staged+unstaged fallback)
- If diff is empty or below `MIN_DIFF_CHARS`, short-circuit immediately — no retry, no verification, no judge
- Add `'zero_diff'` to `RetryResult.finalStatus` union type — distinct from 'success' and 'failed'
- Return immediately on first zero-diff attempt — retrying with the same prompt won't help

**Config-only routing:**
- After zero-diff check passes, get changed file list via `git diff --name-only` against baseline SHA
- Classify as config-only using file extension check: if ALL changed files match config patterns (`.eslintrc*`, `.prettierrc*`, `tsconfig.json`, `.env*`, `*.config.js/ts/mjs/cjs`, etc.), it's config-only
- Routing logic lives in RetryOrchestrator — passes option to compositeVerifier
- Config-only changes: run lint only, skip build and test
- Config-only changes still go through the LLM Judge (catches scope creep regardless of file type)

**Judge calibration:**
- Enrich the existing "NOT scope creep" list in the judge prompt with refactoring-specific entries: updating test files that exercise the renamed/moved/changed symbol; updating imports required by the rename/move; updating type annotations affected by the change
- Keep `originalTask` (full expanded prompt with SCOPE block) as the judge input — already works for generic tasks, no change needed
- Keep `MAX_DIFF_CHARS` at 8000 — v2.2 generic tasks are scoped to simple changes
- Migrate Judge from `client.beta.messages.create()` to GA `client.messages.create()` with `output_config.format` — remove `betas` header, `as any` cast, and `BetaMessage` import. Same migration pattern as Phase 18 intent parser

**User messaging:**
- Zero-diff message: "No changes detected — agent completed without modifying any files. Try rephrasing your instruction or check if the change was already applied."
- Config-only skip: brief notice — "Config-only change detected — skipping build and test verification." via `console.info`
- Messages surface through existing output paths — REPL `session.ts` and CLI `run.ts` add `zero_diff` case to their finalStatus switch statements
- REPL session history records `zero_diff` as a distinct status (not 'failed')

### Claude's Discretion
- Exact config file pattern list (which extensions/filenames count as "config")
- Whether to extract `getWorkspaceDiff` and `getChangedFiles` into a shared utility or import from judge.ts directly
- Test coverage breadth for new pipeline paths
- Exact wording of enriched Judge "NOT scope creep" entries

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| VERIFY-01 | Zero-diff detection runs after agent completes but before verifier — empty diff produces a distinct `zero_diff` outcome with clear user message | `getWorkspaceDiff()` and `MIN_DIFF_CHARS` already exist in `judge.ts`; `RetryOrchestrator.run()` has a clear insertion point after session success at line ~129-143 |
| VERIFY-02 | Change-type-aware verification inspects modified file extensions — config-only changes skip build+test, source changes get full composite verifier | `compositeVerifier()` already has `options?: { skipLint?: boolean }` — extend with `configOnly`; `git diff --name-only` provides the file list; pattern matching on extensions is the classification mechanism |
| VERIFY-03 | LLM Judge prompt is enriched to distinguish legitimate refactoring side-effects (test updates, import changes) from actual scope creep | Judge prompt "NOT scope creep" section is at judge.ts line ~228-230; GA API migration follows the exact Phase 18 pattern |
</phase_requirements>

---

## Summary

Phase 20 is entirely a code-path surgery phase — no new dependencies, no new file modules required. Every building block already exists. The work is: inserting two new checks into `RetryOrchestrator.run()` between session success and verifier invocation; extending `compositeVerifier()` with a `configOnly` option; enriching the judge prompt; migrating the judge API call from beta to GA; and propagating `zero_diff` as a first-class status through the type system and display layers.

The existing code is well-structured for this. `getWorkspaceDiff()` in `judge.ts` is already exported and handles the baseline SHA logic that zero-diff detection needs. `compositeVerifier()` already has an options bag — adding `configOnly` is a clean extension. The REPL `renderResultBlock()` in `repl.ts` and REPL history in `session.ts` both have clear spots to handle the new `zero_diff` case.

The most risk in this phase is the config-only file classification: the pattern list must be comprehensive enough to catch real config files but conservative enough to never misclassify source files. The test coverage for the new pipeline paths (zero-diff short-circuit, config-only routing, judge API migration) is the main deliverable alongside the production code.

**Primary recommendation:** Implement zero-diff first (smallest blast radius), then config-only routing, then judge enrichment + API migration. Each is independently testable and sequentially builds on the prior step.

---

## Standard Stack

No new libraries required. All work is internal to the existing codebase.

### Core (already present)
| Module | Purpose | Usage in Phase 20 |
|--------|---------|-------------------|
| `src/orchestrator/judge.ts` | `getWorkspaceDiff()`, `captureBaselineSha()`, `MIN_DIFF_CHARS` | Reused for zero-diff detection; judge prompt enriched; API migrated |
| `src/orchestrator/verifier.ts` | `compositeVerifier()` with `options` bag | Extended with `configOnly` option |
| `src/orchestrator/retry.ts` | `RetryOrchestrator.run()` — main orchestration loop | Zero-diff check and config-only classification inserted here |
| `src/types.ts` | `RetryResult.finalStatus` union, `RetryConfig` | Add `'zero_diff'` to union |
| `src/agent/index.ts` | `runAgent()` PR creation guard | Must skip PR for `zero_diff` |
| `src/repl/session.ts` | `processInput()` history recording | Record `zero_diff` as distinct status |
| `src/cli/commands/repl.ts` | `renderResultBlock()` result display | Add `zero_diff` case |
| `src/cli/commands/run.ts` | `mapStatusToExitCode()` | Add `zero_diff` mapping |
| `src/repl/types.ts` | `TaskHistoryEntry.status` union | Add `'zero_diff'` |
| `@anthropic-ai/sdk` | Anthropic client | Migrate from `beta.messages.create` to `messages.create` |

**Installation:** None needed.

---

## Architecture Patterns

### Recommended Insertion Point for Zero-Diff and Config-Only Checks

The `RetryOrchestrator.run()` loop has a clear sequence:

```
session success → [INSERT HERE] → preVerify → verifier → judge → return
```

Both checks belong between session success (line ~129) and the `!this.retryConfig.verifier` early-return (line ~146). This preserves the invariant that the verifier and judge only run on non-trivial, non-zero-diff changes.

### Pattern 1: Zero-Diff Short-Circuit

```typescript
// In RetryOrchestrator.run(), after sessionResult.status check passes

// Zero-diff detection: skip all verification if agent made no changes
const diffForCheck = await getWorkspaceDiff(this.config.workspaceDir, baselineSha);
if (!diffForCheck || diffForCheck.length < MIN_DIFF_CHARS) {
  return {
    finalStatus: 'zero_diff',
    attempts: attempt,
    sessionResults,
    verificationResults,
    judgeResults,
  };
}
```

Key points:
- Import `getWorkspaceDiff` and `MIN_DIFF_CHARS` from `./judge.js` at top of `retry.ts`
- Return immediately — no retry, the same prompt will produce the same empty result
- `zero_diff` is a terminal outcome, not a retry trigger

### Pattern 2: Config-Only Classification

```typescript
// After zero-diff check passes (diff is non-trivial)
// Determine if all changed files are config files

async function getChangedFiles(workspaceDir: string, baselineSha?: string): Promise<string[]> {
  try {
    const args = baselineSha
      ? ['diff', baselineSha, '--name-only']
      : ['diff', 'HEAD~1', 'HEAD', '--name-only'];
    const { stdout } = await execFileAsync('git', args, { cwd: workspaceDir });
    return stdout.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

const CONFIG_FILE_PATTERNS = [
  /^\.eslintrc(\.[a-z]+)?$/,
  /^\.prettierrc(\.[a-z]+)?$/,
  /^tsconfig(\.[a-z]+)?\.json$/,
  /^\.env(\.[a-z]+)?$/,
  /^.*\.config\.(js|ts|mjs|cjs|mts|cts)$/,
  /^jest\.config\.[a-z]+$/,
  /^vite\.config\.[a-z]+$/,
  /^vitest\.config\.[a-z]+$/,
  /^babel\.config\.[a-z]+$/,
  /^\.babelrc(\.[a-z]+)?$/,
  /^\.stylelintrc(\.[a-z]+)?$/,
  /^\.editorconfig$/,
  /^\.nvmrc$/,
  /^\.node-version$/,
  /^Dockerfile(\.[a-z]+)?$/,
  /^docker-compose(\.[a-z.-]+)?\.yml$/,
];

function isConfigFile(filename: string): boolean {
  const basename = path.basename(filename);
  return CONFIG_FILE_PATTERNS.some(p => p.test(basename));
}

const changedFiles = await getChangedFiles(this.config.workspaceDir, baselineSha);
const configOnly = changedFiles.length > 0 && changedFiles.every(isConfigFile);
```

Then pass `configOnly` to `compositeVerifier`:

```typescript
verification = await this.retryConfig.verifier(this.config.workspaceDir, { configOnly });
```

And in `compositeVerifier()`:

```typescript
export async function compositeVerifier(
  workspaceDir: string,
  options?: { skipLint?: boolean; configOnly?: boolean }
): Promise<VerificationResult> {
  if (options?.configOnly) {
    console.info('[Verifier] Config-only change detected — skipping build and test verification.');
    // Run lint only
    const lintResult = await lintVerifier(workspaceDir);
    // ... aggregate as before, all other verifiers return passed: true
  }
  // ... existing full path unchanged
}
```

### Pattern 3: Judge GA API Migration

The beta→GA pattern is established in Phase 18 (`src/intent/llm-parser.ts`). Apply the same transformation to `judge.ts`:

```typescript
// BEFORE (beta API)
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
const response = await client.beta.messages.create({
  // ...
  betas: ['structured-outputs-2025-11-13'],
  output_config: { format: { type: 'json_schema', schema: { ... } } },
} as any) as BetaMessage;

// AFTER (GA API)
// Remove the BetaMessage import entirely
const response = await client.messages.create({
  // ...
  // Remove betas array
  output_config: { format: { type: 'json_schema', schema: { ... } } },
});
// No type assertions needed — response.content[0].text works directly
```

### Pattern 4: Zero-Diff Display

**In `src/cli/commands/repl.ts` `renderResultBlock()`:**
```typescript
// Add zero_diff to the statusColor switch
const statusColor =
  result.finalStatus === 'success'
    ? pc.green
    : result.finalStatus === 'zero_diff'
    ? pc.yellow
    : result.finalStatus === 'cancelled'
    ? pc.yellow
    : pc.red;
```

And print the zero-diff message below the result block when `finalStatus === 'zero_diff'`.

**In `src/cli/commands/run.ts` `mapStatusToExitCode()`:**
```typescript
case 'zero_diff': return 0;  // technically successful (agent ran but found nothing to change)
```

Or alternatively `return 1` if callers expect non-zero when no work was done. The locked decision says "No PR is created and no verifier runs" but doesn't specify exit code — this is Claude's discretion territory. Recommending exit code 0 (agent completed successfully, just nothing changed).

**In `src/repl/session.ts`:**
```typescript
historyStatus = result.finalStatus === 'success'
  ? 'success'
  : result.finalStatus === 'zero_diff'
  ? 'zero_diff'   // needs to be added to TaskHistoryEntry.status union
  : 'failed';
```

**In `src/repl/types.ts` `TaskHistoryEntry.status`:**
```typescript
status: 'success' | 'failed' | 'cancelled' | 'zero_diff';
```

**In `src/agent/index.ts` PR creation guard:**
```typescript
// BEFORE
if (options.createPr && retryResult.finalStatus === 'success') {

// AFTER — already guards correctly on 'success' only; zero_diff never reaches here
// No change needed — but verify the guard is correct after adding zero_diff to types
```

### Pattern 5: Judge Prompt Enrichment

Current "NOT scope creep" entries in `judge.ts` line ~228-230:
```
- NOT scope creep: fixing compilation errors caused by the primary change, updating imports required by the change, updating tests that directly test the changed code
- NOT scope creep: lockfile changes (package-lock.json, yarn.lock, pnpm-lock.yaml) — these are regenerated externally after the agent runs, not by the agent itself. Lockfile diffs are stripped from this diff.
```

Add after existing entries:
```
- NOT scope creep: updating test files that exercise the renamed, moved, or otherwise changed symbol — tests must match the code they test
- NOT scope creep: updating import paths and import statements required by a rename or file move — these are mechanical consequences, not independent decisions
- NOT scope creep: updating TypeScript type annotations, interface names, or type aliases that reference the changed symbol — type consistency is required by the language
- NOT scope creep: updating string literals or comments that reference the renamed symbol by name, if the agent was asked to rename it
```

### Anti-Patterns to Avoid

- **Calling `getWorkspaceDiff()` twice:** Zero-diff detection reads the diff, then later `llmJudge()` reads it again. This is acceptable (two git commands total, fast), but if performance becomes an issue, cache the diff in the orchestrator and pass it to both.
- **Zero-diff as retry trigger:** Never retry on zero-diff — the same prompt sent again will produce the same empty result. Return immediately.
- **Config-only skipping lint entirely:** Config-only changes STILL run lint. Only build and test are skipped. This is intentional — an `.eslintrc.json` edit could introduce a parse error.
- **Hardcoding `changedFiles` in verifier signature:** Routing classification belongs in RetryOrchestrator, not inside `compositeVerifier`. The verifier receives the `configOnly: boolean` decision, not the raw file list.
- **Treating `zero_diff` as failure in history:** REPL history should record it as distinct from 'failed' so follow-up context is accurate ("the last task produced no changes" is different from "the last task failed").

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Workspace diff retrieval | Custom git invocation | `getWorkspaceDiff()` from `judge.ts` | Already handles baseline SHA, fallback chain, maxBuffer |
| Baseline SHA capture | Inline git rev-parse | `captureBaselineSha()` from `judge.ts` | Already called in orchestrator; result is already stored as `baselineSha` |
| Changed files list | Re-implementing `getWorkspaceDiff` for names | `git diff --name-only` with same baseline SHA | Simple one-liner once the SHA is known |
| Structured output parsing | Manual JSON.parse on free text | Anthropic GA structured outputs API with `output_config.format` | Guaranteed schema-valid response |

---

## Common Pitfalls

### Pitfall 1: Zero-Diff Check Using Wrong Baseline
**What goes wrong:** Calling `getWorkspaceDiff()` without the `baselineSha` parameter falls back to `HEAD~1..HEAD`, which misses uncommitted staged/unstaged changes the agent may have made without committing.
**Why it happens:** `baselineSha` is already captured and stored at the top of `RetryOrchestrator.run()` — it must be threaded to the new check.
**How to avoid:** Always pass `baselineSha` to `getWorkspaceDiff()` in the zero-diff check. The variable is already in scope.
**Warning signs:** Tests show zero-diff is not detected even when the agent made no commits.

### Pitfall 2: Config-Only Misclassification
**What goes wrong:** A file like `src/config/appConfig.ts` gets classified as config-only because it has "config" in the name, causing build+test to be skipped for a source file change.
**Why it happens:** Naive glob matching on file names rather than well-defined patterns.
**How to avoid:** Match against known config file patterns using regex anchored at the basename. Never match files in `src/`, `lib/`, or similar source directories unless the file is a known dotfile or config extension.
**Warning signs:** Integration test that edits a `.ts` source file gets routed through config-only path.

### Pitfall 3: Judge Test Mocking Stale After API Migration
**What goes wrong:** After migrating `judge.ts` from `client.beta.messages.create` to `client.messages.create`, existing tests mock `beta.messages.create` and the tests pass vacuously (mock not invoked, judge fails open).
**Why it happens:** The mock in `judge.test.ts` explicitly mocks the beta path. After migration, the production code calls a different path.
**How to avoid:** Update the mock in `judge.test.ts` to mock `messages.create` (not `beta.messages.create`) as part of the migration task. Verify at least one test asserts on the mock being called.
**Warning signs:** `mockCreate` call count is 0 in tests after migration.

### Pitfall 4: `RetryConfig.verifier` Signature Mismatch
**What goes wrong:** Adding `configOnly` option to `compositeVerifier` requires changing how `RetryOrchestrator` calls the verifier — but `RetryConfig.verifier` is typed as `(workspaceDir: string) => Promise<VerificationResult>` with no options.
**Why it happens:** The verifier is stored as a callback in `RetryConfig`; the orchestrator calls it as `this.retryConfig.verifier(workspaceDir)`. Passing options requires either changing the type or creating a closure at binding time.
**How to avoid:** Two valid approaches — (a) bind `configOnly` at the call site via closure: `() => compositeVerifier(workspaceDir, { configOnly })` called with the flag determined inline, OR (b) change `RetryConfig.verifier` signature to accept options. Approach (a) is the least-invasive change. The orchestrator determines `configOnly` and then calls the verifier directly with the flag — no signature change needed if the `verifier` function reference is replaced by a direct `compositeVerifier` call at the point where the orchestrator knows `configOnly`.
**Warning signs:** TypeScript compiler error on verifier call site after adding options parameter.

### Pitfall 5: MCP Verifier Server Receives `configOnly` Incorrectly
**What goes wrong:** `verifier-server.ts` calls `compositeVerifier(workspaceDir, { skipLint: true })` mid-session. If `compositeVerifier` signature changes, the MCP server call must be updated to preserve `skipLint: true`.
**Why it happens:** The MCP verifier is a separate caller of `compositeVerifier` — it won't automatically inherit the `configOnly` logic from the orchestrator.
**How to avoid:** MCP server does NOT need `configOnly` routing — it's called mid-session by the agent itself, not after-session by the orchestrator. Preserve `{ skipLint: true }` as-is. The `compositeVerifier` signature change just adds an optional property — existing callers with `{ skipLint: true }` are unaffected.
**Warning signs:** MCP verifier tests fail after the `compositeVerifier` signature change.

---

## Code Examples

### Zero-Diff Insertion in retry.ts

```typescript
// Source: src/orchestrator/retry.ts — after sessionResult.status !== 'success' guard
// Import additions at top of retry.ts:
import { captureBaselineSha, getWorkspaceDiff, MIN_DIFF_CHARS } from './judge.js';

// In RetryOrchestrator.run(), after the 'session failed' early return (~line 142):

// Zero-diff check: if agent made no meaningful changes, surface immediately.
// Retrying with the same prompt will not produce different results.
const workspaceDiff = await getWorkspaceDiff(this.config.workspaceDir, baselineSha);
if (!workspaceDiff || workspaceDiff.length < MIN_DIFF_CHARS) {
  logger?.info({ attempt }, 'Zero diff detected — agent produced no meaningful changes');
  return {
    finalStatus: 'zero_diff',
    attempts: attempt,
    sessionResults,
    verificationResults,
    judgeResults,
  };
}
```

### Config-Only Classification in retry.ts

```typescript
// After zero-diff check passes, before calling verifier
// Uses same baselineSha already in scope

const changedFiles = await getChangedFilesFromBaseline(this.config.workspaceDir, baselineSha);
const configOnly = changedFiles.length > 0 && changedFiles.every(isConfigFile);

if (configOnly) {
  logger?.info({ changedFiles }, 'Config-only change detected');
}

// When calling verifier:
verification = await this.retryConfig.verifier(this.config.workspaceDir);
// BUT since RetryConfig.verifier has no options, call compositeVerifier directly:
//   compositeVerifier(this.config.workspaceDir, { configOnly })
// This means the verifier field in RetryConfig.verifier is bypassed for config-only.
// Recommended: replace the generic verifier callback call with a direct compositeVerifier
// call when configOnly is known, OR thread configOnly through a closure at binding time.
```

### Judge Prompt Enriched "NOT Scope Creep" Section

```typescript
// Source: src/orchestrator/judge.ts — judgePrompt constant, around line 228
`   - NOT scope creep: fixing compilation errors caused by the primary change, updating imports required by the change, updating tests that directly test the changed code
   - NOT scope creep: lockfile changes (package-lock.json, yarn.lock, pnpm-lock.yaml) — these are regenerated externally after the agent runs, not by the agent itself. Lockfile diffs are stripped from this diff.
   - NOT scope creep: updating test files that exercise the renamed, moved, or changed symbol — tests must stay consistent with the code they test
   - NOT scope creep: updating import paths and import statements required by a rename or file move — these are mechanical consequences of the rename, not independent decisions
   - NOT scope creep: updating TypeScript type annotations, interface names, or type aliases that reference the changed symbol — type consistency is a language requirement
   - NOT scope creep: updating string literals or documentation comments that name the renamed symbol, if the task explicitly asked for a rename`
```

### Judge GA API Migration

```typescript
// Source: src/orchestrator/judge.ts — remove beta-specific elements

// REMOVE this import:
// import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';

// REPLACE the API call:
const response = await client.messages.create({
  model,
  max_tokens: 1024,
  stream: false,
  system: 'You are a code review judge evaluating whether an AI agent stayed within the scope of its assigned task.',
  messages: [{ role: 'user', content: judgePrompt }],
  // REMOVE: betas: ['structured-outputs-2025-11-13'],
  output_config: {
    format: {
      type: 'json_schema',
      schema: {
        type: 'object',
        properties: {
          reasoning: { type: 'string', description: 'Step-by-step analysis of scope alignment' },
          verdict: { type: 'string', enum: ['APPROVE', 'VETO'], description: 'Binary verdict: APPROVE if changes align with task, VETO if scope creep detected' },
          veto_reason: { type: 'string', description: 'If vetoed: concise explanation of what exceeded scope (empty string if approved)' },
        },
        required: ['reasoning', 'verdict', 'veto_reason'],
        additionalProperties: false,
      },
    },
  },
  // REMOVE: } as any) as BetaMessage;
});
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Beta structured outputs (`client.beta.messages.create` + `betas` header) | GA structured outputs (`client.messages.create` + `output_config.format`, no `betas`) | Phase 18 established the migration pattern | Removes type assertions and beta dependency |
| No zero-diff detection (verifier runs even on empty changes) | Zero-diff detected in orchestrator, surfaces `zero_diff` status | Phase 20 | Prevents spurious "no verifier errors" on no-op runs |
| Full build+test on all changes | Change-type-aware routing (config-only → lint only) | Phase 20 | Faster feedback, no false failures from pre-existing lint violations |

**Deprecated/outdated:**
- `client.beta.messages.create` with `betas: ['structured-outputs-2025-11-13']`: replaced by GA path in judge.ts as part of this phase
- `BetaMessage` import from `@anthropic-ai/sdk/resources/beta/messages/messages.js`: removed after GA migration

---

## Open Questions

1. **Should `zero_diff` exit code be 0 or 1 in CLI one-shot mode?**
   - What we know: `mapStatusToExitCode()` in `run.ts` currently maps only `success` to 0, all others to 1
   - What's unclear: Whether CI pipelines using this tool expect non-zero when nothing changed
   - Recommendation: Use exit code 0 for `zero_diff` — the agent completed without error; "no changes" is a valid outcome, not a failure. This matches the messaging ("check if change was already applied").

2. **Should `getChangedFiles` be extracted to `judge.ts` alongside `getWorkspaceDiff`?**
   - What we know: Both functions use the same baseline SHA and git invocation pattern
   - What's unclear: Whether future phases will need `getChangedFiles` beyond the orchestrator
   - Recommendation: Add `getChangedFilesFromBaseline()` to `judge.ts` (exported), keeping git-related utilities co-located. Import from there in `retry.ts`.

3. **Should `RetryConfig.verifier` signature change to accept options?**
   - What we know: Currently typed as `(workspaceDir: string) => Promise<VerificationResult>`
   - What's unclear: Whether adding an options parameter would break existing test mocks or callers
   - Recommendation: Do NOT change the `RetryConfig.verifier` signature. Instead, the orchestrator calls `compositeVerifier` directly (it already does) with the `configOnly` flag when routing is needed. The `RetryConfig.verifier` callback is used as-is for the non-config-only path.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (v2.x, detected via `vitest.config.ts`) |
| Config file | `vitest.config.ts` |
| Quick run command | `npx vitest run src/orchestrator/ --reporter=verbose` |
| Full suite command | `npx vitest run --reporter=verbose` |

Current baseline: 556 tests passing across 25 test files.

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| VERIFY-01 | Zero-diff short-circuits with `zero_diff` status | unit | `npx vitest run src/orchestrator/retry.test.ts -t "zero_diff"` | ✅ (retry.test.ts exists — new tests added) |
| VERIFY-01 | Zero-diff does not invoke verifier or judge | unit | `npx vitest run src/orchestrator/retry.test.ts` | ✅ |
| VERIFY-01 | Zero-diff message displayed in REPL result block | unit | `npx vitest run src/cli/commands/repl.test.ts` | Check existence |
| VERIFY-02 | Config-only files classified correctly (pattern matching) | unit | `npx vitest run src/orchestrator/retry.test.ts -t "config"` | ✅ |
| VERIFY-02 | Config-only routes to lint-only verification | unit | `npx vitest run src/orchestrator/verifier.test.ts -t "configOnly"` | ✅ (verifier.test.ts exists — new tests added) |
| VERIFY-02 | Source file changes get full composite verifier | unit | `npx vitest run src/orchestrator/verifier.test.ts` | ✅ |
| VERIFY-03 | Judge GA API called (not beta) | unit | `npx vitest run src/orchestrator/judge.test.ts` | ✅ (judge.test.ts exists — mock updated) |
| VERIFY-03 | Judge approves refactoring diffs (renamed symbol + test updates) | unit | `npx vitest run src/orchestrator/judge.test.ts -t "refactor"` | ✅ |
| VERIFY-03 | Judge enriched prompt contains new "NOT scope creep" entries | unit | `npx vitest run src/orchestrator/judge.test.ts` | ✅ |

### Sampling Rate
- **Per task commit:** `npx vitest run src/orchestrator/ --reporter=verbose`
- **Per wave merge:** `npx vitest run --reporter=verbose`
- **Phase gate:** Full suite green (556+ tests) before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] New test cases in `retry.test.ts` — covers VERIFY-01 (zero-diff) and VERIFY-02 (config-only routing in orchestrator)
- [ ] New test cases in `verifier.test.ts` — covers VERIFY-02 (configOnly option in compositeVerifier)
- [ ] Updated mock in `judge.test.ts` — mock `messages.create` not `beta.messages.create` after GA migration; new test cases for VERIFY-03 (enriched prompt entries)
- Check `src/cli/commands/repl.test.ts` existence for VERIFY-01 display test

---

## Sources

### Primary (HIGH confidence)
- Direct source code inspection: `src/orchestrator/retry.ts` — RetryOrchestrator.run() flow, insertion point identified at line ~129-143
- Direct source code inspection: `src/orchestrator/judge.ts` — `getWorkspaceDiff()`, `MIN_DIFF_CHARS`, judge prompt, beta API call at line ~242-277
- Direct source code inspection: `src/orchestrator/verifier.ts` — `compositeVerifier()` options pattern, `skipLint` precedent
- Direct source code inspection: `src/types.ts` — `RetryResult.finalStatus` union, `RetryConfig` interface
- Direct source code inspection: `src/agent/index.ts` — PR creation guard at line ~191
- Direct source code inspection: `src/repl/session.ts` — history recording, `historyStatus` assignment
- Direct source code inspection: `src/cli/commands/repl.ts` — `renderResultBlock()`, status color logic
- Direct source code inspection: `src/cli/commands/run.ts` — `mapStatusToExitCode()`
- Direct source code inspection: `src/repl/types.ts` — `TaskHistoryEntry.status` union
- Direct source code inspection: `src/mcp/verifier-server.ts` — MCP verifier, `{ skipLint: true }` pattern
- Direct source code inspection: `src/orchestrator/retry.test.ts`, `judge.test.ts`, `verifier.test.ts` — test patterns, mock structure, vitest usage

### Secondary (MEDIUM confidence)
- CONTEXT.md: All locked decisions and implementation guidance — written by project owner with direct knowledge of the codebase

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all modules inspected directly; no new dependencies
- Architecture: HIGH — insertion points identified precisely from source reading; patterns follow established precedents in the codebase (Phase 18 GA migration, `skipLint` options pattern)
- Pitfalls: HIGH — derived from direct code inspection (mock paths, signature types, MCP separate caller)

**Research date:** 2026-03-24
**Valid until:** 2026-04-24 (stable codebase; patterns don't change unless Anthropic SDK changes)
