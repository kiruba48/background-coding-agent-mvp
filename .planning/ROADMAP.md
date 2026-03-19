# Roadmap: Background Coding Agent

## Milestones

- ✅ **v1.0 Foundation** — Phases 1-6 (shipped 2026-03-02)
- ✅ **v1.1 End-to-End Pipeline** — Phases 7-9 (shipped 2026-03-11)
- 🚧 **v2.0 Claude Agent SDK Migration** — Phases 10-13 (in progress)

## Phases

<details>
<summary>✅ v1.0 Foundation (Phases 1-6) — SHIPPED 2026-03-02</summary>

- [x] Phase 1: Foundation & Security (4/4 plans) — completed 2026-01-27
- [x] Phase 2: CLI & Orchestration (3/3 plans) — completed 2026-02-06
- [x] Phase 3: Agent Tool Access (2/2 plans) — completed 2026-02-12
- [x] Phase 4: Retry & Context Engineering (2/2 plans) — completed 2026-02-17
- [x] Phase 5: Deterministic Verification (2/2 plans) — completed 2026-02-18
- [x] Phase 6: LLM Judge Integration (2/2 plans) — completed 2026-02-28

Full details: [v1.0-ROADMAP.md](milestones/v1.0-ROADMAP.md)

</details>

<details>
<summary>✅ v1.1 End-to-End Pipeline (Phases 7-9) — SHIPPED 2026-03-11</summary>

- [x] Phase 7: GitHub PR Creation (2/2 plans) — completed 2026-03-02
- [x] Phase 8: Maven Dependency Update (3/3 plans) — completed 2026-03-05
- [x] Phase 9: npm Dependency Update (3/3 plans) — completed 2026-03-11

Full details: See archived phase details below.

</details>

### 🚧 v2.0 Claude Agent SDK Migration (In Progress)

**Milestone Goal:** Replace ~1,200 lines of custom agent infrastructure with the Claude Agent SDK `query()` call. Delete AgentSession, AgentClient, and ContainerManager. Gain built-in tools, auto context compression, native hooks, and an optional MCP verifier server.

- [x] **Phase 10: Agent SDK Integration** - Replace AgentSession with AgentSdkSession wrapping `query()`; all security defaults established (completed 2026-03-17)
- [x] **Phase 11: Legacy Deletion** - Delete agent.ts, session.ts, container.ts and their ~650 lines of tests (completed 2026-03-18)
- [x] **Phase 12: MCP Verifier Server** - Expose compositeVerifier as `mcp__verifier__verify` tool for mid-session self-correction (completed 2026-03-18)
- [x] **Phase 13: Container Strategy** - Run Agent SDK inside Docker with network isolation equivalent to v1.1 (completed 2026-03-19)

## Phase Details

### Phase 7: GitHub PR Creation
**Goal**: Users can run any verified agent task and have it automatically create a GitHub PR with full context (branch, diff, verification results, judge verdict, risk flags)
**Depends on**: Phase 6 (LLM Judge Integration — v1.0)
**Requirements**: PR-01, PR-02, PR-03, PR-04, PR-05, PR-06, PR-07
**Success Criteria** (what must be TRUE):
  1. After a successful agent run, a GitHub PR exists on the target repo with no manual steps
  2. The PR branch name is auto-generated from task context (e.g., `agent/update-spring-boot-3.2`) and user can override it via a CLI flag
  3. The PR body contains the original task prompt, a summary of changes, and diff stats
  4. The PR body shows verification results (build/test/lint pass) and LLM Judge verdict with reasoning
  5. The PR body flags potential breaking changes so a human reviewer knows what to scrutinize
**Plans**: 2 total
- [x] **07-01** — GitHubPRCreator service (types, dependencies, pr-creator module, 37 tests)
- [x] **07-02** — Wire GitHubPRCreator into CLI (`--create-pr`, `--branch` flags)

### Phase 8: Maven Dependency Update
**Goal**: Users can update a Maven dependency end-to-end — specify groupId:artifactId and target version in the CLI, agent updates pom.xml, adapts code if needed, and creates a PR with a changelog link
**Depends on**: Phase 7 (GitHub PR Creation)
**Requirements**: MVN-01, MVN-02, MVN-03, MVN-04, MVN-05
**Success Criteria** (what must be TRUE):
  1. User runs CLI with Maven dep coordinates and target version; agent locates and updates the version in pom.xml
  2. Agent runs Maven build and tests inside Docker; verification failure triggers retry with error context
  3. When the new version has breaking API changes, agent attempts code fixes before declaring failure
  4. The resulting PR body includes a link to the dependency changelog or release notes
**Plans**: 3 plans
Plans:
- [x] 08-01-PLAN.md — CLI flags (--dep, --target-version) and prompt module with Maven prompt builder
- [x] 08-02-PLAN.md — Maven build-system detection in composite verifier + error summarizers
- [x] 08-03-PLAN.md — Wire prompt module into run.ts (integration)

### Phase 9: npm Dependency Update
**Goal**: Users can update an npm package end-to-end — specify package name and target version in the CLI, agent updates package.json in Docker, host-side post-step regenerates lockfile, build/tests verified, and creates a PR on success
**Depends on**: Phase 7 (GitHub PR Creation)
**Requirements**: NPM-01, NPM-02, NPM-03, NPM-04, NPM-05
**Success Criteria** (what must be TRUE):
  1. User runs CLI with npm package name and target version; agent updates version in package.json and regenerates the lockfile
  2. Agent runs build and tests inside Docker; verification failure triggers retry with error context
  3. When the new version has breaking API changes, agent attempts code fixes before declaring failure
  4. The resulting PR body includes a link to the dependency changelog or release notes
**Plans**: 3 plans
Plans:
- [x] 09-01-PLAN.md — npm prompt builder and CLI validation for npm-dependency-update
- [x] 09-02-PLAN.md — npm build/test verifiers in composite verifier + error summarizers
- [x] 09-03-PLAN.md — Host-side npm install post-step (preVerify hook in retry loop)

### Phase 10: Agent SDK Integration
**Goal**: Users can run agent tasks driven by the Claude Agent SDK `query()` call with all v1.1 security guarantees preserved and established as defaults from day one
**Depends on**: Phase 9 (npm Dependency Update — v1.1)
**Requirements**: SDK-01, SDK-02, SDK-03, SDK-04, SDK-05, SDK-06, SDK-07, SDK-08, SDK-09, SDK-10
**Success Criteria** (what must be TRUE):
  1. Running `node dist/cli/index.js run --task-type maven-dependency-update ...` completes successfully using `query()` instead of AgentSession — existing RetryOrchestrator integration tests still pass
  2. File edits outside the repo path and to `.env` or `.git` files are blocked by the PreToolUse hook and logged as rejected attempts
  3. Every file change (Edit/Write tool calls) appears in the session audit log with path, tool name, and timestamp — via PostToolUse hook
  4. `WebSearch` and `WebFetch` tool calls are refused by the SDK without prompting — `disallowedTools` enforced at session start
  5. When the agent exhausts `maxTurns: 10`, `SessionResult.status` is `"turn_limit"` — not `"failed"` — so RetryOrchestrator does not retry an exhausted session
**Plans**: 2 plans
Plans:
- [x] 10-01-PLAN.md — Install SDK, implement ClaudeCodeSession with security hooks and TDD test suite
- [x] 10-02-PLAN.md — Wire ClaudeCodeSession into RetryOrchestrator and CLI (--use-sdk flag)

### Phase 11: Legacy Deletion
**Goal**: All custom agent infrastructure code is deleted and the codebase contains no references to AgentSession, AgentClient, or ContainerManager — the only agent runtime is the SDK
**Depends on**: Phase 10 (Agent SDK Integration — all tests green)
**Requirements**: DEL-01, DEL-02, DEL-03, DEL-04, DEL-05
**Success Criteria** (what must be TRUE):
  1. `agent.ts`, `session.ts`, and `container.ts` no longer exist in `src/`; no import of these files anywhere in the codebase
  2. `dockerode` and `@types/dockerode` are absent from `package.json` and `node_modules`
  3. The test suite has the same or greater coverage of `AgentSdkSession` behaviors as the deleted tests had for `AgentSession` — `npm test` reports all tests passing
  4. LLM Judge still produces structured scope-creep verdicts after its `@anthropic-ai/sdk` dependency is resolved
**Plans**: 2 plans
Plans:
- [ ] 11-01-PLAN.md — Migrate SessionConfig to types.ts, delete 6 legacy files, update all imports, simplify RetryOrchestrator, remove dockerode
- [ ] 11-02-PLAN.md — Clean test mocks, add vitest.config.ts, full test suite verification sweep

### Phase 12: MCP Verifier Server
**Goal**: The agent can call `mcp__verifier__verify` mid-session to self-check its changes before stopping — reducing outer retry consumption for fixable build failures
**Depends on**: Phase 10 (Agent SDK Integration)
**Requirements**: MCP-01, MCP-02, MCP-03
**Success Criteria** (what must be TRUE):
  1. An agent session that introduces a build failure can call `mcp__verifier__verify` and receive the build error output as a tool response — without consuming a full outer retry
  2. `mcp/verifier-server.ts` runs in-process with no external HTTP server or spawned process — `createSdkMcpServer()` pattern only
  3. The outer RetryOrchestrator remains the authoritative quality gate — a mid-session verify call passing does not bypass the post-session compositeVerifier run
**Plans**: 2 plans
Plans:
- [ ] 12-01-PLAN.md — MCP verifier server factory module with createVerifierMcpServer() and formatVerifyDigest()
- [ ] 12-02-PLAN.md — Wire MCP server into ClaudeCodeSession query() options with systemPrompt and PostToolUse matcher

### Phase 13: Container Strategy
**Goal**: Production agent runs execute inside a Docker container with network isolation equivalent to v1.1 — API calls reach Anthropic, nothing else does
**Depends on**: Phase 10 (Agent SDK Integration)
**Requirements**: CTR-01, CTR-02, CTR-03, CTR-04
**Success Criteria** (what must be TRUE):
  1. The orchestrator process runs inside Docker; `docker run` starts the full pipeline and stdio connects host to container via `spawnClaudeCodeProcess`
  2. Agent API calls to `api.anthropic.com` succeed from within the container; all other outbound connections are blocked
  3. The container process runs as non-root user (UID 1001) — `whoami` inside the container does not return `root`
  4. `ANTHROPIC_API_KEY` is injected at runtime via `-e` flag (not baked into image); host-side proxy pattern deferred to v2.1
**Plans**: 2 plans
Plans:
- [ ] 13-01-PLAN.md — Dockerfile + entrypoint.sh + Docker helper module with unit tests
- [ ] 13-02-PLAN.md — Wire spawnClaudeCodeProcess into ClaudeCodeSession and Docker readiness into CLI

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Foundation & Security | v1.0 | 4/4 | Complete | 2026-01-27 |
| 2. CLI & Orchestration | v1.0 | 3/3 | Complete | 2026-02-06 |
| 3. Agent Tool Access | v1.0 | 2/2 | Complete | 2026-02-12 |
| 4. Retry & Context Engineering | v1.0 | 2/2 | Complete | 2026-02-17 |
| 5. Deterministic Verification | v1.0 | 2/2 | Complete | 2026-02-18 |
| 6. LLM Judge Integration | v1.0 | 2/2 | Complete | 2026-02-28 |
| 7. GitHub PR Creation | v1.1 | 2/2 | Complete | 2026-03-02 |
| 8. Maven Dependency Update | v1.1 | 3/3 | Complete | 2026-03-05 |
| 9. npm Dependency Update | v1.1 | 3/3 | Complete | 2026-03-11 |
| 10. Agent SDK Integration | v2.0 | 2/2 | Complete | 2026-03-17 |
| 11. Legacy Deletion | 2/2 | Complete    | 2026-03-18 | - |
| 12. MCP Verifier Server | 2/2 | Complete    | 2026-03-18 | - |
| 13. Container Strategy | 2/2 | Complete    | 2026-03-19 | - |
