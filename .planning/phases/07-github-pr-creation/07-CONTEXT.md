# Phase 7: GitHub PR Creation - Context

**Gathered:** 2026-03-02
**Status:** Ready for planning

<domain>
## Phase Boundary

Automatically create a GitHub PR after a successful agent run (verification + judge passed). The PR includes full context: branch, diff, verification results, judge verdict, and breaking change flags. This is the final step in the agent pipeline — turning verified local changes into a reviewable PR.

</domain>

<decisions>
## Implementation Decisions

### Branch naming & git flow
- Branch name format: `agent/<slugified-task-terms>` (e.g., `agent/update-spring-boot-3.2`)
- Slugify key terms from the task prompt — deterministic, no extra LLM call
- Prefix is always `agent/`
- `--branch` CLI flag provides full replacement (user controls entire name, no forced prefix)
- If branch already exists on remote: fail with clear error message including the conflicting branch name
- User must resolve manually or use `--branch` to specify a different name

### PR body content & format
- Structured markdown sections with headers (not tables or compact format)
- Section order: Task Prompt, Changes Summary, Diff Stats, Verification Results, Judge Verdict, Breaking Changes
- Change summary: agent's `finalResponse` for narrative + `git diff --stat` for numbers (both combined)
- Verification results: pass/fail badges up front (e.g., Build, Tests, Lint) with `<details>` blocks containing full output
- Judge verdict: verdict badge prominently displayed, reasoning in a collapsible `<details>` block
- Breaking changes section always present — shows "None detected" when clean (reassures reviewers)

### Breaking change detection
- Two sources combined: diff heuristics + LLM Judge reasoning
- Diff heuristics: conservative set — deleted public functions/classes, changed method signatures, removed/renamed exports
- Judge reasoning: extract any breaking change signals from judge's analysis
- Presentation: dedicated warning section with a list of each detected break (file + description)
- Breaking changes section is informational, not blocking — PR still gets created

### Pipeline integration
- PR creation is a new step in `runAgent()` (run.ts), called after `RetryOrchestrator` returns success
- RetryOrchestrator stays untouched — PR creation is a post-success concern
- Opt-in via `--create-pr` CLI flag (no PR by default — agent runs stay local unless asked)
- Authentication: `GITHUB_TOKEN` environment variable only. Fail with clear error if not set when `--create-pr` is used
- PR creation failure is non-fatal: log the error, print the branch name so user can create PR manually, exit code still 0

### Claude's Discretion
- Exact slugification algorithm for branch names
- PR body markdown styling details
- How to extract breaking change signals from judge reasoning text
- Exact heuristic implementation for diff-based breaking change detection
- How to handle edge cases like empty diffs or workspace with no git remote

</decisions>

<specifics>
## Specific Ideas

- PR should feel like a complete handoff — reviewer should understand what happened without reading agent logs
- "None detected" in breaking changes section is important for reviewer confidence
- Keep it GitHub-native — standard markdown, no custom rendering dependencies

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `RetryResult` (types.ts): Contains `sessionResults`, `verificationResults`, `judgeResults` — all data needed for PR body
- `SessionResult.finalResponse`: Agent's narrative of what it did — use for change summary
- `JudgeResult.verdict` + `JudgeResult.reasoning`: Direct source for judge section
- `VerificationResult.errors[]`: Each has `type` (build/test/lint/judge) and `summary` — maps to verification badges

### Established Patterns
- Host-side git execution via `execFileAsync` in session.ts — push will follow same pattern
- `runAgent()` in run.ts is the orchestration entry point — PR step goes here after retry loop
- CLI option validation happens before `runAgent()` call — `--create-pr` and `--branch` parsed there

### Integration Points
- `runAgent()` return: currently returns exit code — needs access to `RetryResult` for PR body data
- `git_operation` in session.ts: currently supports status/diff/add/commit — push needs to be added as host-side operation (not container tool)
- CLI `run.ts`: where `--create-pr` and `--branch` flags will be parsed

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 07-github-pr-creation*
*Context gathered: 2026-03-02*
