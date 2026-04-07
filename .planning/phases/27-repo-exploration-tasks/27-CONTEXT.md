# Phase 27: Repo Exploration Tasks - Context

**Gathered:** 2026-04-06
**Status:** Ready for planning

<domain>
## Phase Boundary

Users can ask the agent to investigate a repo (git strategy, CI setup, project structure) and receive a structured report — no code changes, no PR, no verifier run. The agent runs in a read-only Docker container and returns findings via finalResponse.

</domain>

<decisions>
## Implementation Decisions

### Intent recognition
- Dual detection: fast-path regex patterns + LLM fallback (same approach as dependency updates)
- Add EXPLORATION_PATTERNS regex list matching verbs like "explore", "investigate", "analyze", "check the CI", "branching strategy", etc.
- Exploration-first heuristic: if input contains read verbs (explore/investigate/analyze/check) and NO action verbs (update/fix/add/remove), classify as investigation
- LLM parser handles ambiguous cases that fast-path can't resolve
- Routes to `investigation` task type (4th type alongside npm-dependency-update, maven-dependency-update, generic)

### Exploration subtypes
- 4 subtypes: git-strategy, ci-checks, project-structure, general (fallback)
- Auto-detect subtype from user phrasing — "check the CI" → ci-checks, "branching strategy" → git-strategy, "project structure" → project-structure
- Falls back to "general" when subtype can't be determined (e.g., "tell me about this repo")
- Registry pattern for extensibility: each subtype is a config object (name, keywords, prompt template) in an array — adding a new subtype (e.g., security-scan from EXPLR-06) = adding one object

### Exploration prompts
- Common base prompt + subtype-specific FOCUS section injected
- Base preamble: read-only constraints, structured markdown report output, no code changes
- Subtype section defines the investigation focus and expected report sections
- End-state prompting discipline applies — describe desired report, not investigation steps

### Report format & display
- Agent's finalResponse IS the report — no post-processing or structured JSON extraction
- Prompt instructs agent to produce markdown with sections appropriate to subtype
- REPL: print full report inline to stdout (same spot where PR links/status messages appear)
- Slack: single thread message with full markdown report
- File output: if user asks to save the report, host-side code writes finalResponse to `.reports/` directory after session completes — agent never writes files

### Read-only enforcement
- Docker workspace mounted as `:ro` — OS-level enforcement, no Bash command can write files regardless of what agent tries
- PreToolUse hook blocks Write and Edit tools entirely — gives agent fast feedback ("blocked: read-only session") before Docker mount would reject the write
- No Bash command blocklist/allowlist needed — `:ro` mount handles it at OS level
- Report file writing happens host-side from finalResponse, not inside the container

### Pipeline bypass
- Investigation tasks skip: composite verifier, LLM Judge, PR creation
- `zero_diff` result must not surface as failure — task-type-aware result rendering
- Exploration tasks do NOT create worktrees — use `:ro` Docker mount from Phase 26 infrastructure only
- No retry loop needed — exploration either produces a report or fails

### Claude's Discretion
- Whether "general" fallback exploration uses a guided checklist or is fully open-ended
- Exact regex patterns for EXPLORATION_PATTERNS
- Error handling when agent produces no useful report
- Exact markdown structure of report per subtype

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements
- `.planning/REQUIREMENTS.md` — EXPLR-01 through EXPLR-05 define the five acceptance criteria for repo exploration

### Architecture context
- `.planning/PROJECT.md` — Key decisions table documents Docker isolation model, host-side git execution, end-state prompting discipline, generic execution path pattern
- `.planning/phases/26-git-worktree-isolation/26-CONTEXT.md` — Worktree lifecycle decisions, Docker mount patterns, workspaceDir seam documentation

### Existing integration points
- `src/intent/types.ts` — TaskType definition (TASK_TYPES array), IntentSchema, ResolvedIntent interface — investigation type added here
- `src/intent/fast-path.ts` — DEPENDENCY_PATTERNS, REFACTORING_VERB_GUARD, fastPathParse(), detectTaskType() — exploration patterns added here
- `src/intent/llm-parser.ts` — LLM classification logic — needs investigation type support
- `src/prompts/index.ts` — buildPrompt() dispatcher that switches on taskType — new investigation branch added here
- `src/prompts/generic.ts` — buildGenericPrompt() as reference for common-base + section pattern
- `src/orchestrator/claude-code-session.ts` — buildPreToolUseHook() — read-only Write/Edit blocking added here
- `src/orchestrator/retry.ts` — RetryOrchestrator.run() — skip verifier/judge/retry for investigation type
- `src/agent/index.ts` — runAgent() — skip worktree creation, mount :ro, skip PR creation for investigation
- `src/cli/docker/index.ts` — buildDockerRunArgs() — workspace :ro mount option (currently :rw at line 79)
- `src/repl/session.ts` — processInput() — report display and optional file write to .reports/
- `src/slack/adapter.ts` — processSlackMention() — report posting as thread message
- `src/cli/commands/run.ts` — mapStatusToExitCode() — investigation results need appropriate exit code
- `src/types.ts` — RetryResult.finalStatus — investigation-specific status handling

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `DEPENDENCY_PATTERNS` / `REFACTORING_VERB_GUARD` in fast-path.ts: Established pattern for regex-based intent detection — EXPLORATION_PATTERNS follows the same convention
- `buildGenericPrompt()` in prompts/generic.ts: Base + section injection pattern that exploration prompts will mirror
- `buildPreToolUseHook()` in claude-code-session.ts: Existing hook architecture supports adding read-only checks alongside sensitive file checks
- Docker `--read-only` flag already in buildDockerRunArgs(): Container filesystem is already read-only except mounted volumes — changing `:rw` to `:ro` on workspace mount is the key change

### Established Patterns
- `workspaceDir` seam flows through entire pipeline: Changing mount mode at Docker level propagates read-only enforcement without touching intermediate code
- Fast-path → LLM fallback dual detection: Proven pattern for dependency updates, same approach for exploration
- `finalResponse` in SessionResult: Already captures agent's final text output — exploration report uses this existing field
- `skipDockerChecks` / `skipWorktree` option pattern: `skipVerification` / `readOnly` follows the same AgentContext convention

### Integration Points
- `runAgent()` in src/agent/index.ts: Primary insertion point — skip worktree, mount :ro, skip verifier/judge/PR
- `buildDockerRunArgs()` in src/cli/docker/index.ts: Mount mode switch from `:rw` to `:ro`
- Intent parser chain: fast-path.ts → llm-parser.ts → types.ts for new investigation type
- REPL session.ts: Display finalResponse as report, optionally write to .reports/ host-side
- Slack adapter.ts: Post finalResponse as thread message (existing pattern)

</code_context>

<specifics>
## Specific Ideas

- Report file saved to `.reports/` directory with descriptive name when user explicitly asks to save it
- Host-side file write from finalResponse keeps the read-only contract clean — agent never writes files

</specifics>

<deferred>
## Deferred Ideas

- EXPLR-06: Security scan subtype (analyze dependencies for known vulnerabilities) — deferred to v2.5+
- EXPLR-07: Exploration results stored in session history for follow-up referencing — deferred to v2.5+

</deferred>

---

*Phase: 27-repo-exploration-tasks*
*Context gathered: 2026-04-06*
