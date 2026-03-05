# Phase 8: Maven Dependency Update - Context

**Gathered:** 2026-03-05
**Status:** Ready for planning

<domain>
## Phase Boundary

Full Maven dependency update pipeline: user specifies groupId:artifactId and target version via CLI flags, agent updates pom.xml in Docker, runs build/tests via build-system-aware verification, retries on failure with error context, and creates a PR on success. Changelog/release notes links are deferred (MVN-05 removed from this phase).

</domain>

<decisions>
## Implementation Decisions

### CLI input design
- New flags: `--dep <groupId:artifactId>` and `--target-version <version>`
- `--dep` uses colon-separated format for groupId:artifactId (familiar Maven convention)
- `--target-version` is a separate flag for the desired version
- Both flags are conditionally required: CLI validates they are present when `-t maven-dependency-update` (and later npm-dependency-update)
- Keep existing `-t` / `--task-type` flag approach — no subcommands for now
- Subcommand redesign deferred to conversational agent iteration

### Agent prompt strategy
- End-state prompting (established project decision from Spotify research, TASK-04)
- Describe the desired outcome, not the steps — agent plans its own approach
- Agent discovers current version itself by reading pom.xml (no host-side pre-reading)
- Agent handles multi-module projects naturally without explicit prompt instructions
- Separate prompt-builder module (`prompts/` or similar) with a function per task type (e.g., `buildMavenPrompt(dep, version)`) — clean separation for Phase 9 npm addition

### Verification approach
- Build-system detection in the existing composite verifier (not task-specific verifiers)
- Verifier detects `pom.xml` in workspace and runs Maven commands (`mvn compile`, `mvn test`)
- This scales to any task type — dependency updates, refactors, migrations all use the same verifier
- Phase 9 adds npm detection to the same verifier; future build systems (Gradle, Cargo) follow the same pattern
- No combinatorial explosion of task-type x build-system verifiers

### Breaking change handling
- Use the existing RetryOrchestrator retry loop — no separate breaking-change mechanism
- Agent updates pom.xml, build fails due to breaking API changes, verifier catches it, retry with error context, agent fixes code
- 10 turns per attempt x 3 retries = 30 total turns max (user can override with --turn-limit)
- If all retries exhausted: fail with exit code 1, log what was tried, show remaining compilation errors, no PR created
- User sees exactly what broke and can fix manually

### Claude's Discretion
- Exact end-state prompt wording (within end-state format constraint)
- Prompt module file structure and naming
- Build-system detection implementation details in composite verifier
- How to report remaining errors on final failure
- Maven command flags and options used in verification

</decisions>

<specifics>
## Specific Ideas

- End-state prompting per Spotify research: "Update dependency X to version Y, codebase should build and tests should pass" — not step-by-step instructions
- Build-system detection makes the verifier truly generic — adding new task types requires zero verifier changes
- Conversational agent mode (point at repo, natural language requests) is the future direction — batch CLI is the stepping stone

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `RetryOrchestrator` (retry.ts): Full retry loop with verification + judge — handles breaking change retries out of the box
- `compositeVerifier` (verifier.ts): Currently generic build/test/lint — will be extended with Maven build-system detection
- `GitHubPRCreator` (pr-creator.ts): PR creation with branch naming, diff stats, verification results, judge verdict
- `AgentClient.runAgenticLoop()` (agent.ts): Agentic loop with tool execution — prompt is passed as `userMessage`
- Current prompt in run.ts line 84: `"You are a coding agent. Your task: ${options.taskType}. Work in the current directory."` — will be replaced by prompt module

### Established Patterns
- CLI validation in `src/cli/index.ts` before `runAgent()` call — `--dep` and `--target-version` validation goes here
- Host-side git execution via `execFileAsync` in session.ts
- End-state prompting principle (TASK-04, research/ARCHITECTURE.md Pattern 1)

### Integration Points
- `src/cli/index.ts`: Add `--dep` and `--target-version` option definitions + conditional validation
- `src/cli/commands/run.ts`: `RunOptions` interface needs `dep` and `targetVersion` fields; prompt construction switches to prompt module
- `src/orchestrator/verifier.ts`: Add build-system detection (pom.xml check) and Maven command execution
- New: `src/prompts/` module with task-type-specific prompt builders

</code_context>

<deferred>
## Deferred Ideas

- Conversational agent loop — user starts agent, points at repo, makes natural language requests (like Claude Code). Major architectural change, future milestone.
- Changelog/release notes link in PR body (MVN-05) — requires network access or convention-based URL construction. Revisit when conversational mode adds network capability.
- Subcommand-based CLI (e.g., `background-agent maven-update`) — redesign when moving to conversational mode.
- "Update all outdated deps" mode — user specifies single dep for now (BAT-01 in future requirements).

</deferred>

---

*Phase: 08-maven-dependency-update*
*Context gathered: 2026-03-05*
