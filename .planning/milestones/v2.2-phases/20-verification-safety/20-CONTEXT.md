# Phase 20: Verification & Safety - Context

**Gathered:** 2026-03-24
**Status:** Ready for planning

<domain>
## Phase Boundary

The verification pipeline handles generic task outcomes correctly — empty diffs are surfaced immediately, config-only changes skip the build pipeline, and the LLM Judge does not veto correct refactoring diffs. This phase does NOT add new task types, change the prompt builder, or modify the intent parser — those are Phases 18-19 (complete).

</domain>

<decisions>
## Implementation Decisions

### Zero-diff detection
- Detect in RetryOrchestrator, after session succeeds but before calling verifier/judge
- Reuse `getWorkspaceDiff()` from `judge.ts` (already handles baseline SHA, committed+staged+unstaged fallback)
- If diff is empty or below `MIN_DIFF_CHARS`, short-circuit immediately — no retry, no verification, no judge
- Add `'zero_diff'` to `RetryResult.finalStatus` union type — distinct from 'success' and 'failed'
- Return immediately on first zero-diff attempt — retrying with the same prompt won't help

### Config-only routing
- After zero-diff check passes, get changed file list via `git diff --name-only` against baseline SHA
- Classify as config-only using file extension check: if ALL changed files match config patterns (`.eslintrc*`, `.prettierrc*`, `tsconfig.json`, `.env*`, `*.config.js/ts/mjs/cjs`, etc.), it's config-only
- Routing logic lives in RetryOrchestrator — passes option to compositeVerifier
- Config-only changes: run lint only, skip build and test
- Config-only changes still go through the LLM Judge (catches scope creep regardless of file type)

### Judge calibration
- Enrich the existing "NOT scope creep" list in the judge prompt with refactoring-specific entries:
  - Updating test files that exercise the renamed/moved/changed symbol
  - Updating imports required by the rename/move
  - Updating type annotations affected by the change
- Keep `originalTask` (full expanded prompt with SCOPE block) as the judge input — already works for generic tasks, no change needed
- Keep `MAX_DIFF_CHARS` at 8000 — v2.2 generic tasks are scoped to simple changes, complex migrations deferred to v2.3+
- Migrate Judge from `client.beta.messages.create()` to GA `client.messages.create()` with `output_config.format` — same migration pattern as Phase 18 intent parser. Remove `betas` header, `as any` cast, and `BetaMessage` import

### User messaging
- Zero-diff message: short + actionable — "No changes detected — agent completed without modifying any files. Try rephrasing your instruction or check if the change was already applied."
- Config-only skip: brief notice — "Config-only change detected — skipping build and test verification." Appears in verification summary output
- Messages surface through existing output paths — REPL `session.ts` and CLI `run.ts` add `zero_diff` case to their finalStatus switch statements. Config-only notice comes from verifier console.info logs
- REPL session history records `zero_diff` as a distinct status (not 'failed') — queryable for follow-up context

### Claude's Discretion
- Exact config file pattern list (which extensions/filenames count as "config")
- Whether to extract `getWorkspaceDiff` and `getChangedFiles` into a shared utility or import from judge.ts directly
- Test coverage breadth for new pipeline paths
- Exact wording of enriched Judge "NOT scope creep" entries

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Verification pipeline
- `src/orchestrator/verifier.ts` — compositeVerifier and individual verifiers (build, test, lint, maven, npm). Config-only routing adds a new option here
- `src/orchestrator/retry.ts` — RetryOrchestrator.run() — zero-diff check and config-only classification insert here, after session success
- `src/mcp/verifier-server.ts` — MCP verifier wrapper, calls compositeVerifier with skipLint option

### LLM Judge
- `src/orchestrator/judge.ts` — llmJudge(), getWorkspaceDiff(), captureBaselineSha(), judge prompt with "NOT scope creep" list. GA API migration + prompt enrichment happen here

### Types
- `src/types.ts` — RetryResult.finalStatus union (add 'zero_diff'), RetryConfig, VerificationResult, JudgeResult

### Agent runner (caller)
- `src/agent/index.ts` — runAgent() creates orchestrator, handles PR creation. Must skip PR for zero_diff

### REPL + CLI (display)
- `src/repl/session.ts` — Handles RetryResult display in REPL, session history recording
- `src/cli/commands/run.ts` — Handles RetryResult display in CLI one-shot mode
- `src/cli/commands/repl.ts` — REPL command entry point, may need zero_diff exit code mapping

### REPL types
- `src/repl/types.ts` — ReplState, session history types (add zero_diff status)

### Requirements
- `.planning/REQUIREMENTS.md` — VERIFY-01 (zero-diff), VERIFY-02 (change-type-aware), VERIFY-03 (Judge calibration)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `getWorkspaceDiff()` in `judge.ts` — already handles baseline SHA with fallback chain, reuse for zero-diff detection
- `captureBaselineSha()` in `judge.ts` — already called in RetryOrchestrator.run() and stored as `baselineSha`
- `compositeVerifier()` already accepts `options?: { skipLint?: boolean }` — extend with `{ configOnly?: boolean }` pattern
- `ErrorSummarizer` in `summarizer.ts` — may need zero-diff summary format

### Established Patterns
- RetryOrchestrator post-session flow: session success → preVerify hook → verifier → judge → return. Zero-diff and config-only checks insert between session success and preVerify
- `compositeVerifier` options pattern (`{ skipLint }`) — extend with `{ configOnly }` for skipping build+test
- `RetryResult.finalStatus` is a string union in types.ts — add `'zero_diff'` to the union
- Judge beta→GA migration pattern established in Phase 18 (`llm-parser.ts`): replace `client.beta.messages.create` → `client.messages.create`, remove `betas` header, use `output_config.format`, remove type assertions

### Integration Points
- `RetryOrchestrator.run()` line ~130-145 — insert zero-diff check after session success, before verifier
- `compositeVerifier()` signature — add `configOnly` option to skip build+test
- `runAgent()` line ~191 — PR creation guard must check for `zero_diff` status
- `src/repl/session.ts` — result display switch statement needs `zero_diff` case
- `src/cli/commands/run.ts` — exit code mapping needs `zero_diff` case
- `judge.ts` line ~214-234 — judge prompt text, enrich "NOT scope creep" section
- `judge.ts` line ~242-277 — beta API call, migrate to GA

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

*Phase: 20-verification-safety*
*Context gathered: 2026-03-24*
