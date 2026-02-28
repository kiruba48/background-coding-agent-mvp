# Phase 6: LLM Judge Integration - Context

**Gathered:** 2026-02-28
**Status:** Ready for planning

<domain>
## Phase Boundary

Changes are evaluated for scope creep and intent alignment, with veto power over PRs. The LLM judge runs after all deterministic verifiers pass, receives the diff + original task, and returns a binary verdict. Judge veto prevents PR creation even if build/test/lint pass. This is the semantic safety layer complementing Phase 5's deterministic checks.

</domain>

<decisions>
## Implementation Decisions

### Judge Strictness
- Causally-linked scope evaluation: allow any change that's a direct consequence of the task (lockfile updates, transitive import fixes, auto-formatter on touched files)
- Veto only changes unrelated to the task (modifying unrelated files, adding features not requested)
- Binary APPROVE/VETO verdict only — no soft warnings or three-tier system
- Full diff evaluated in a single API call (not file-by-file)
- Truncate lockfile diffs (package-lock.json, pom.xml.lock) before sending to judge — replace with note like "+ lockfile updated". Saves tokens, lockfile changes are expected for dependency tasks

### Veto Feedback
- Judge provides reasoning + specific files/changes that triggered veto (actionable feedback for retry)
- Use existing VerificationError format with new `'judge'` type added to the union
- Veto reasoning goes in `summary` field, full structured judge response in `rawOutput`
- Flows through existing ErrorSummarizer pipeline unchanged
- Veto reason shown in CLI output alongside build/test/lint results
- When retry succeeds after veto, final output includes attempt history (e.g., "Attempt 1: vetoed (scope creep in utils.ts), Attempt 2: approved") — full transparency

### Retry Policy
- 1 retry after judge veto (matches Spotify's ~50% correction rate data)
- Separate retry budget from verification retries — verification gets maxRetries (3), judge gets 1 independently
- Fresh AgentSession per judge retry (consistent with "never reuse sessions" pattern in RetryOrchestrator)
- After both attempts vetoed, final status = `'vetoed'` (new value added to RetryResult.finalStatus)
- `'vetoed'` status aligns with existing MetricsCollector.SessionStatus which already has `'vetoed'`

### Judge Model
- Configurable model via environment variable: `JUDGE_MODEL` (defaults to `claude-haiku-4-5-20251001`)
- Haiku 4.5 as default — sufficient for binary scope classification, 5x cheaper than Sonnet
- Judge is disableable: `JUDGE_ENABLED=false` env var or `--no-judge` CLI flag. ON by default.
- Track judge token usage (input/output tokens) and cost in MetricsCollector, reported separately from agent session cost

### Claude's Discretion
- Judge system prompt wording and chain-of-thought instructions
- Exact token truncation threshold for lockfiles
- How to structure the diff + task prompt for optimal judge accuracy
- Whether to use beta structured outputs (SDK 0.71.2) or upgrade to SDK 0.78.0 with zodOutputFormat

</decisions>

<specifics>
## Specific Ideas

- Spotify's production pattern (1,500+ PRs, Dec 2025): judge runs post-verification, binary verdict, 1 retry on veto, ~25% veto rate with ~50% correction on retry — this is our reference architecture
- "Student driver with dual controls" mental model: deterministic verifiers catch technical failures, judge catches semantic failures
- Judge should NOT be part of compositeVerifier — it's a separate post-verification step in RetryOrchestrator

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `@anthropic-ai/sdk` v0.71.2: Already installed, beta structured outputs available via `anthropic.beta.messages.create`
- `ErrorSummarizer`: Existing build/test/lint error summarization — judge errors flow through same pipeline
- `MetricsCollector`: Already tracks `vetoCount`, `vetoRate`, `SessionStatus` includes `'vetoed'`

### Established Patterns
- `VerificationResult { passed, errors[], durationMs }`: Standard verifier return type — judge returns same shape
- `VerificationError { type, summary, rawOutput }`: Union type `'build' | 'test' | 'lint' | 'custom'` — add `'judge'`
- `RetryOrchestrator.run()`: Fresh session per attempt, original task always first, error digest as secondary info
- `RetryConfig { maxRetries, verifier? }`: Judge config will extend this (separate field, not same verifier)

### Integration Points
- `RetryOrchestrator.run()` (src/orchestrator/retry.ts:130): After `verification.passed` check — insert judge call before returning success
- `RetryConfig` (src/types.ts:49): Add optional `judge` field for judge function
- `RetryResult.finalStatus` (src/types.ts:58): Add `'vetoed'` to union
- `VerificationError.type` (src/types.ts:32): Add `'judge'` to union
- `run.ts` (src/cli/commands/run.ts): Wire judge config, handle `--no-judge` flag, show veto in CLI output

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 06-llm-judge-integration*
*Context gathered: 2026-02-28*
