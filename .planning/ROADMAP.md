# Roadmap: Background Coding Agent

## Milestones

- ✅ **v1.0 Foundation** — Phases 1-6 (shipped 2026-03-02)
- 🚧 **v1.1 End-to-End Pipeline** — Phases 7-9 (in progress)

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

### 🚧 v1.1 End-to-End Pipeline (In Progress)

**Milestone Goal:** Ship the complete pipeline — agent takes a dependency update task, executes in Docker, verifies changes, and creates a GitHub PR with full context.

- [x] **Phase 7: GitHub PR Creation** - Agent creates richly-described PRs on GitHub after successful verification
- [ ] **Phase 8: Maven Dependency Update** - Full Maven dep update task: CLI → Docker agent → verify → PR
- [ ] **Phase 9: npm Dependency Update** - Full npm dep update task: CLI → Docker agent → verify → PR

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
**Prep (from Phase 7 audit)**: Add barrel exports to `src/orchestrator/index.ts`, fix 07-01-SUMMARY.md frontmatter/docs
**Success Criteria** (what must be TRUE):
  1. User runs CLI with Maven dep coordinates and target version; agent locates and updates the version in pom.xml
  2. Agent runs Maven build and tests inside Docker; verification failure triggers retry with error context
  3. When the new version has breaking API changes, agent attempts code fixes before declaring failure
  4. The resulting PR body includes a link to the dependency changelog or release notes
**Plans**: 3 plans
Plans:
- [ ] 08-01-PLAN.md — CLI flags (--dep, --target-version) and prompt module with Maven prompt builder
- [ ] 08-02-PLAN.md — Maven build-system detection in composite verifier + error summarizers
- [ ] 08-03-PLAN.md — Wire prompt module into run.ts (integration)

### Phase 9: npm Dependency Update
**Goal**: Users can update an npm package end-to-end — specify package name and target version in the CLI, agent updates package.json and lockfile, adapts code if needed, and creates a PR with a changelog link
**Depends on**: Phase 7 (GitHub PR Creation)
**Requirements**: NPM-01, NPM-02, NPM-03, NPM-04, NPM-05
**Success Criteria** (what must be TRUE):
  1. User runs CLI with npm package name and target version; agent updates version in package.json and regenerates the lockfile
  2. Agent runs build and tests inside Docker; verification failure triggers retry with error context
  3. When the new version has breaking API changes, agent attempts code fixes before declaring failure
  4. The resulting PR body includes a link to the dependency changelog or release notes
**Plans**: TBD

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
| 8. Maven Dependency Update | v1.1 | 0/3 | Planned | - |
| 9. npm Dependency Update | v1.1 | 0/TBD | Not started | - |
