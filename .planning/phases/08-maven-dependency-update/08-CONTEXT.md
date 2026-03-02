# Phase 8: Maven Dependency Update - Context

**Gathered:** 2026-03-02
**Status:** Ready for planning

<domain>
## Phase Boundary

End-to-end Maven dependency update: user specifies groupId:artifactId and target version via CLI, agent updates pom.xml (including multi-module projects), adapts code if the new version has breaking API changes, verifies with compile + test, and creates a PR with a changelog link. Restore, rollback, and scheduled updates are out of scope.

</domain>

<decisions>
## Implementation Decisions

### CLI input design
- New `maven-update` subcommand via Commander.js (not extending generic `run`)
- Positional arguments: `background-agent maven-update org.springframework:spring-boot 3.2.0 -r ./repo`
  - First positional: `groupId:artifactId` (colon-delimited)
  - Second positional: target version
- Inherits all existing `run` flags: `--turn-limit`, `--timeout`, `--max-retries`, `--no-judge`, `--create-pr`, `--branch`, `-r/--repo`
- `--create-pr` defaults to ON for `maven-update` (user can opt out with `--no-create-pr`)
- `--task-type` is implicit ("maven-dependency-update") — not exposed as a flag

### Agent prompt strategy
- Step-by-step playbook prompt (not goal-only): find pom.xml → locate dependency → update version → compile → fix errors → test → commit
- Handle multi-module Maven projects: agent searches all pom.xml files in the project tree
- Use project's Maven wrapper (`./mvnw`) if present, fall back to `mvn`
- Enable network access for Maven tasks (sandbox currently has `--network none`; Maven needs to resolve dependencies)
- Expand `bash_command` tool allowlist to include `mvn` and `./mvnw` (reuses existing tool infrastructure)

### Changelog sourcing
- Convention-based URL patterns from groupId: map known orgs (Spring, Jackson, etc.) to GitHub release URLs
- Fallback to Maven Central artifact page (`search.maven.org/artifact/{g}/{a}/{v}`)
- When changelog can't be determined: show Maven Central link + note ("Changelog not found automatically — check the project's GitHub releases")
- Link only in PR body — no summary of what changed (avoids hallucination risk)

### Breaking change response
- Use existing RetryOrchestrator retry loop (up to `maxRetries`, default 3) — no separate fix-then-verify inner loop
- Verifier runs `mvn compile` then `mvn test` (both must pass)
- On all retries exhausted: clean failure (exit code 1), no PR created
- No semver-aware behavior — same playbook regardless of version jump magnitude

### Claude's Discretion
- Exact playbook prompt wording and Maven-specific instructions
- How to detect and navigate parent POM vs child module version declarations
- `bash_command` allowlist implementation details
- Network enablement mechanism in ContainerManager

</decisions>

<specifics>
## Specific Ideas

- CLI UX should feel like a purpose-built tool, not a wrapper around the generic `run` command
- The Maven update is the first "task-specific" subcommand — it sets the pattern for `npm-update` (Phase 9)
- Failure should be clean and informative, not produce broken PRs

</specifics>

<code_context>
## Existing Code Insights

### Reusable Assets
- `RetryOrchestrator` (`src/orchestrator/retry.ts`): Already handles retry-with-error-context loop — Maven update plugs in directly
- `GitHubPRCreator` (`src/orchestrator/pr-creator.ts`): PR creation, branch naming, breaking change detection — reuse for Maven PR
- `compositeVerifier` (`src/orchestrator/verifier.ts`): Verification pipeline — needs Maven-specific verifier added
- `AgentSession` (`src/orchestrator/session.ts`): Tool definitions and Docker execution — `bash_command` allowlist lives here
- `runAgent()` (`src/cli/commands/run.ts`): Orchestration flow — maven-update subcommand will share most of this logic

### Established Patterns
- Commander.js for CLI (`src/cli/index.ts`): Single command currently; subcommands are a supported pattern
- Pino structured logging throughout orchestrator layer
- Tool-based agent architecture: read_file, edit_file, git_operation, grep, bash_command, list_files
- `ContainerManager` handles Docker lifecycle; network mode configured at container creation

### Integration Points
- `src/cli/index.ts`: Add `maven-update` subcommand alongside existing `run` command
- `src/orchestrator/session.ts`: Expand `COMMAND_PATHS` and allowlist for Maven commands
- `src/orchestrator/container.ts`: Network mode configuration for Maven tasks
- `src/orchestrator/verifier.ts`: Maven-specific verification (compile + test)
- `src/orchestrator/pr-creator.ts`: Changelog link section in PR body

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 08-maven-dependency-update*
*Context gathered: 2026-03-02*
