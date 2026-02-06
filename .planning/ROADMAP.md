# Roadmap: Background Coding Agent

## Overview

Building a trustworthy background coding agent platform in 10 phases. Starting with secure Docker isolation and SDK integration, progressing through orchestration, tool access controls, and verification loops, culminating in two complete task implementations (Maven and npm dependency updates). The architecture proves the "student driver with dual controls" pattern: agent autonomy constrained by deterministic verification and LLM Judge oversight.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Foundation & Security** - Docker isolation and Anthropic SDK integration
- [ ] **Phase 2: CLI & Orchestration** - User interface and session lifecycle management
- [ ] **Phase 3: Agent Tool Access** - Safe file, Git, and Bash operations
- [ ] **Phase 4: Retry & Context Engineering** - Resilient execution with error context
- [ ] **Phase 5: Deterministic Verification** - Build, test, and lint checks
- [ ] **Phase 6: LLM Judge Integration** - Scope control and quality gate
- [ ] **Phase 7: PR Creation** - GitHub integration and output mechanism
- [ ] **Phase 8: Maven Dependency Updates** - MVP use case implementation
- [ ] **Phase 9: npm Dependency Updates** - Second task type implementation
- [ ] **Phase 10: Verification Plugin System** - Extensibility for custom verifiers

## Phase Details

### Phase 1: Foundation & Security
**Goal**: Agent can execute in isolated Docker container with no external network access and communicate via Anthropic SDK
**Depends on**: Nothing (first phase)
**Requirements**: EXEC-01, EXEC-02
**Success Criteria** (what must be TRUE):
  1. Container spawns with non-root user and isolated workspace
  2. Container has no external network access (network mode: none)
  3. Agent SDK can send/receive messages to Claude API from orchestrator
  4. Container can be torn down cleanly after session
**Plans**: 4 plans in 3 waves

Plans:
- [x] 01-01-PLAN.md — Project setup + Docker image (Wave 1)
- [x] 01-02-PLAN.md — Container lifecycle management (Wave 2)
- [x] 01-03-PLAN.md — Anthropic SDK integration (Wave 2)
- [x] 01-04-PLAN.md — End-to-end session integration (Wave 3)

### Phase 2: CLI & Orchestration
**Goal**: User can trigger agent runs via CLI and orchestrator manages full session lifecycle with safety limits
**Depends on**: Phase 1
**Requirements**: CLI-01, CLI-02, CLI-03, CLI-04, CLI-05, EXEC-03, EXEC-04
**Success Criteria** (what must be TRUE):
  1. User can run CLI command with task type and target repo parameters
  2. Orchestrator spawns Docker container for agent session
  3. Session respects turn limit (10 turns maximum)
  4. Session respects timeout (5 minutes maximum)
  5. Structured JSON logs capture full session for debugging
  6. Session state tracked (pending, running, success, failed, vetoed)
**Plans**: 3 plans in 2 waves

Plans:
- [x] 02-01-PLAN.md — Structured logging (Pino) + session lifecycle enhancement (Wave 1)
- [ ] 02-02-PLAN.md — CLI entry point with Commander.js + run command (Wave 2)
- [x] 02-03-PLAN.md — Metrics collector + Docker health check (Wave 1)

### Phase 3: Agent Tool Access
**Goal**: Agent can read files, edit code, and perform Git operations within safe boundaries
**Depends on**: Phase 2
**Requirements**: TOOL-01, TOOL-02, TOOL-03, TOOL-04
**Success Criteria** (what must be TRUE):
  1. Agent can read any file in workspace via Read tool
  2. Agent can edit files in workspace via Edit tool
  3. Agent can run Git status, diff, add, and commit (but not push)
  4. Agent can run allowlisted Bash commands (rg, cat, head, tail, find, wc)
  5. Tool attempts outside allowlist are rejected with clear error
**Plans**: TBD

Plans:
- [ ] 03-01: TBD
- [ ] 03-02: TBD

### Phase 4: Retry & Context Engineering
**Goal**: Agent can recover from failures with summarized error context and retry intelligently
**Depends on**: Phase 3
**Requirements**: EXEC-05, EXEC-06
**Success Criteria** (what must be TRUE):
  1. Failed verification triggers retry with error context (up to 3 retries)
  2. Verification errors are summarized before being sent to agent (not raw dumps)
  3. Agent receives actionable feedback ("3 tests failed in AuthModule" not 10K lines)
  4. Retry counter is enforced (max 3 retries)
  5. Session terminates cleanly after max retries exhausted
**Plans**: TBD

Plans:
- [ ] 04-01: TBD
- [ ] 04-02: TBD

### Phase 5: Deterministic Verification
**Goal**: Changes are automatically verified for buildability, test pass rate, and lint compliance
**Depends on**: Phase 4
**Requirements**: VERIFY-01, VERIFY-02, VERIFY-03, VERIFY-05
**Success Criteria** (what must be TRUE):
  1. Build verification confirms code compiles after changes
  2. Test verification confirms existing tests still pass
  3. Lint verification confirms no new style issues introduced
  4. Failed verification triggers retry with summarized error context
  5. All three verifiers (build/test/lint) must pass to proceed
**Plans**: TBD

Plans:
- [ ] 05-01: TBD
- [ ] 05-02: TBD
- [ ] 05-03: TBD

### Phase 6: LLM Judge Integration
**Goal**: Changes are evaluated for scope creep and intent alignment, with veto power over PRs
**Depends on**: Phase 5
**Requirements**: VERIFY-04, VERIFY-06
**Success Criteria** (what must be TRUE):
  1. LLM Judge receives diff and original prompt for evaluation
  2. Judge evaluates changes against original task for scope creep
  3. Judge veto prevents PR creation even if deterministic checks pass
  4. Judge feedback is included in session logs for debugging
  5. Veto rate tracked as key metric (target ~25%)
**Plans**: TBD

Plans:
- [ ] 06-01: TBD
- [ ] 06-02: TBD

### Phase 7: PR Creation
**Goal**: Successful verification creates descriptive PR with metadata for human review
**Depends on**: Phase 6
**Requirements**: PR-01, PR-02, PR-03, PR-04, PR-05
**Success Criteria** (what must be TRUE):
  1. Verified changes create PR on target repository
  2. PR description explains what changed and why
  3. PR includes full diff of all changes
  4. PR includes metadata (agent session ID, verification results)
  5. PR includes AI-generated change summary
  6. PR is created but NOT auto-merged (human approval required)
**Plans**: TBD

Plans:
- [ ] 07-01: TBD
- [ ] 07-02: TBD

### Phase 8: Maven Dependency Updates
**Goal**: Agent can update Maven dependencies end-to-end with proper verification
**Depends on**: Phase 7
**Requirements**: TASK-01, TASK-03, TASK-04
**Success Criteria** (what must be TRUE):
  1. Agent can parse pom.xml and identify dependencies to update
  2. Agent can update dependency versions in pom.xml
  3. Task type is configurable via CLI parameter (maven-dependency-update)
  4. Prompt uses end-state format (describe outcome, not steps)
  5. Full workflow works: trigger -> update -> verify -> PR creation
  6. Maven multi-module projects are handled correctly
**Plans**: TBD

Plans:
- [ ] 08-01: TBD
- [ ] 08-02: TBD

### Phase 9: npm Dependency Updates
**Goal**: Agent can update npm dependencies end-to-end with lockfile handling
**Depends on**: Phase 8
**Requirements**: TASK-02
**Success Criteria** (what must be TRUE):
  1. Agent can parse package.json and identify dependencies to update
  2. Agent can update dependency versions in package.json
  3. Agent handles package-lock.json or yarn.lock correctly
  4. Agent respects peer dependency constraints
  5. Full workflow works: trigger -> update -> verify -> PR creation
**Plans**: TBD

Plans:
- [ ] 09-01: TBD
- [ ] 09-02: TBD

### Phase 10: Verification Plugin System
**Goal**: Custom verifiers can be added via plugin system for extensibility
**Depends on**: Phase 9
**Requirements**: TOOL-05
**Success Criteria** (what must be TRUE):
  1. Plugin interface defined for custom verifiers
  2. Custom verifier can be registered via plugin configuration
  3. Custom verifier runs in verification loop alongside built-in verifiers
  4. Custom verifier failures trigger retry with context like built-in verifiers
  5. Documentation explains how to create custom verifier plugin
**Plans**: TBD

Plans:
- [ ] 10-01: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 9 -> 10

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation & Security | 4/4 | Complete | 2026-01-27 |
| 2. CLI & Orchestration | 2/3 | In progress | - |
| 3. Agent Tool Access | 0/0 | Not started | - |
| 4. Retry & Context Engineering | 0/0 | Not started | - |
| 5. Deterministic Verification | 0/0 | Not started | - |
| 6. LLM Judge Integration | 0/0 | Not started | - |
| 7. PR Creation | 0/0 | Not started | - |
| 8. Maven Dependency Updates | 0/0 | Not started | - |
| 9. npm Dependency Updates | 0/0 | Not started | - |
| 10. Verification Plugin System | 0/0 | Not started | - |
