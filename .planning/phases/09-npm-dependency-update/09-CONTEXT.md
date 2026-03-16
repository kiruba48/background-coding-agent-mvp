# Phase 9: npm Dependency Update - Context

**Gathered:** 2026-03-11
**Status:** Ready for planning

<domain>
## Phase Boundary

Full npm dependency update pipeline: user specifies package name and target version via CLI flags, agent updates package.json in Docker, host-side post-step regenerates lockfile via `npm install`, build/tests verified, retries on failure with error context, and creates a PR on success. npm-only (no yarn/pnpm). Changelog/release notes links deferred (same as MVN-05 — no network in Docker).

</domain>

<decisions>
## Implementation Decisions

### Package manager scope
- npm only — no yarn or pnpm support in this phase
- Task type: `npm-dependency-update` (matches `maven-dependency-update` naming pattern)
- If project has no package-lock.json, proceed anyway — edit package.json regardless, skip lockfile regen
- Docker image has Node.js/npm pre-installed (Alpine base already includes it)

### --dep validation
- Minimal validation for npm: non-empty, no control characters or whitespace — don't enforce npm naming rules
- Keep Maven's strict groupId:artifactId validation unchanged
- Validation is task-type-aware: `depRequiringTaskTypes` array adds `npm-dependency-update`, but npm branch does minimal format checks
- Agent detects bad package names in its first turn — cheap to fail, no need for CLI-side npm name regex
- Update --dep help text to show both formats: `'Dependency to update (e.g., org.springframework:spring-core for Maven, lodash for npm)'`

### npm verification commands
- Add `npm run build` and `npm test` verifiers to composite verifier (if those scripts exist in package.json)
- Follows the Maven pattern — build-system detection based on package.json scripts
- Run both npm verifiers AND existing tsc/vitest verifiers — let all applicable verifiers run, composite aggregates errors
- Just use `npm test` (whatever scripts.test maps to) — don't detect specific test runners
- Ordering in composite: TS Build > Vitest > Maven Build > Maven Test > **npm Build > npm Test** > Lint

### Lockfile strategy
- Host-side post-step: orchestrator runs `npm install` on host after agent finishes in Docker, before verification
- Follows existing host-side pattern (like git operations that run on host because Docker can't write .git/)
- Agent stays fully sandboxed (no network) — edits package.json only
- Lockfile is regenerated on host, then committed with the PR
- Mount target repo's node_modules into Docker read-only so npm run build/test work with existing deps
- If `npm install` fails on host (invalid version, registry down): fail the run with clear error, no retry — agent can't fix registry issues
- npm-only for now — no equivalent host-side step for Maven (Maven handles deps during `mvn compile`)

### Breaking change handling
- Same as Maven: use existing RetryOrchestrator retry loop
- Agent updates package.json, build/test fails due to breaking API, verifier catches it, retry with error context, agent fixes code
- 10 turns per attempt x 3 retries = 30 total turns max

### Claude's Discretion
- Exact end-state prompt wording for npm (within end-state format constraint)
- `buildNpmPrompt()` implementation in prompts module
- npm verifier implementation details (how to detect scripts in package.json)
- Error summarization for npm build/test failures
- Where in RetryOrchestrator to hook the host-side npm install step
- How to report remaining errors on final failure

</decisions>

<specifics>
## Specific Ideas

- Host-side npm install is the key architectural addition — extends the existing host-side execution pattern (git ops) to package management
- End-state prompting per project decision: "Update package X to version Y, codebase should build and tests should pass" — not step-by-step
- Minimal --dep validation gives the agent freedom — the agent is smart enough to figure out if a package name is valid
- The composite verifier grows naturally: each build system adds its own detectors, all run in parallel where safe

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `RetryOrchestrator` (retry.ts): Full retry loop with verification + judge — handles breaking change retries
- `compositeVerifier` (verifier.ts): Build-system detection pattern established with Maven verifiers — npm follows same pattern
- `buildPrompt()` (prompts/index.ts): Dispatcher with switch on taskType — add `npm-dependency-update` case
- `buildMavenPrompt()` (prompts/maven.ts): Template for end-state prompt builder — npm version follows same structure
- `GitHubPRCreator` (pr-creator.ts): PR creation with full context — works as-is for npm tasks
- `depRequiringTaskTypes` array (cli/index.ts:65): Extensible list — just push `npm-dependency-update`
- `runMavenGoal()` helper (verifier.ts): Shared pattern for running build-system commands with timeout, ENOENT, error handling — npm verifiers can follow same pattern

### Established Patterns
- CLI validation in src/cli/index.ts before runAgent() — npm validation goes in the existing depRequiringTaskTypes block
- Host-side execution via execFileAsync — established for git, extends to npm install
- Build-system detection: check for marker file (pom.xml, package.json), skip if absent
- Error summarization via ErrorSummarizer class — add npm-specific summarizers

### Integration Points
- `src/cli/index.ts`: Add `npm-dependency-update` to depRequiringTaskTypes, update --dep help text, add minimal npm validation branch
- `src/prompts/index.ts`: Add `npm-dependency-update` case to buildPrompt() switch
- New: `src/prompts/npm.ts` with buildNpmPrompt()
- `src/orchestrator/verifier.ts`: Add npmBuildVerifier() and npmTestVerifier(), wire into compositeVerifier()
- `src/orchestrator/retry.ts` or new hook: Host-side npm install post-step between agent run and verification

</code_context>

<deferred>
## Deferred Ideas

- yarn/pnpm support — separate phase if demand warrants it
- Changelog/release notes link in PR body (NPM-05) — same constraint as MVN-05, requires network access or convention-based URL construction
- "Update all outdated deps" mode — user specifies single dep for now (BAT-01 in future requirements)
- Conversational agent loop — future milestone, major architectural change

</deferred>

---

*Phase: 09-npm-dependency-update*
*Context gathered: 2026-03-11*
