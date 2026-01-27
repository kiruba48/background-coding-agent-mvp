# Requirements: Background Coding Agent

## v1 Requirements

### Execution & Isolation

- [x] **EXEC-01**: Agent executes in isolated Docker container with non-root user
- [x] **EXEC-02**: Container has no external network access (network isolation)
- [ ] **EXEC-03**: Turn limit caps agent sessions at 10 turns maximum
- [ ] **EXEC-04**: Timeout terminates sessions exceeding 5 minutes
- [ ] **EXEC-05**: Agent can retry on failure with error context (max 3 retries)
- [ ] **EXEC-06**: Verification errors are summarized, not dumped raw (context engineering)

### Tool Access

- [ ] **TOOL-01**: Agent can read files from workspace via Read tool
- [ ] **TOOL-02**: Agent can edit files in workspace via Edit tool
- [ ] **TOOL-03**: Agent can run Git operations: status, diff, add, commit (not push)
- [ ] **TOOL-04**: Agent can run allowlisted Bash commands: rg, cat, head, tail, find, wc
- [ ] **TOOL-05**: Custom verifiers can be added via plugin system

### Verification

- [ ] **VERIFY-01**: Build verification confirms code compiles after changes
- [ ] **VERIFY-02**: Test verification confirms existing tests pass
- [ ] **VERIFY-03**: Lint verification confirms no style issues introduced
- [ ] **VERIFY-04**: LLM Judge evaluates changes against original prompt for scope creep
- [ ] **VERIFY-05**: Failed verification triggers retry with summarized error context
- [ ] **VERIFY-06**: LLM Judge veto prevents PR creation even if deterministic checks pass

### PR Integration

- [ ] **PR-01**: Successful verification creates PR on target repository
- [ ] **PR-02**: PR description explains what changed and why
- [ ] **PR-03**: PR includes diff of all changes
- [ ] **PR-04**: PR includes metadata: agent session ID, verification results
- [ ] **PR-05**: PR includes AI-generated change summary

### CLI & Orchestration

- [ ] **CLI-01**: CLI command triggers agent run with task type and target repo
- [ ] **CLI-02**: Orchestrator spawns, monitors, and tears down containers
- [ ] **CLI-03**: Structured JSON logging captures full session for debugging
- [ ] **CLI-04**: Session state tracked (pending, running, success, failed, vetoed)
- [ ] **CLI-05**: Metrics tracked: merge rate, veto rate, cost per run, time per session

### Task Types

- [ ] **TASK-01**: Maven dependency update task implemented end-to-end
- [ ] **TASK-02**: npm dependency update task implemented end-to-end
- [ ] **TASK-03**: Task type is configurable via CLI parameter
- [ ] **TASK-04**: Prompts use end-state format (describe outcome, not steps)

---

## v2 Requirements (Deferred)

### Task Types
- Config file updates
- Simple refactors
- Pluggable task type system (marketplace potential)

### Scale Features
- Queue/webhook triggers (currently CLI only)
- Batch operations across multiple repos
- Real-time streaming UI

### Advanced Features
- Break-aware updates (handle breaking API changes)
- Diff-based prompting (reduce token costs)
- Rollback mechanism (track agent changes for easy revert)

---

## Out of Scope

- **Auto-merge** — Human approval always required (trust model)
- **Multi-repo batch operations** — Single repo per run for MVP
- **Real-time streaming UI** — CLI output sufficient
- **Slack/notification integrations** — Manual PR review sufficient
- **Full terminal access** — Security risk, allowlisted commands only
- **Dynamic tool fetching** — Static tools at spawn time (predictability)

---

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| EXEC-01 | Phase 1 | Complete |
| EXEC-02 | Phase 1 | Complete |
| EXEC-03 | Phase 2 | Pending |
| EXEC-04 | Phase 2 | Pending |
| EXEC-05 | Phase 4 | Pending |
| EXEC-06 | Phase 4 | Pending |
| TOOL-01 | Phase 3 | Pending |
| TOOL-02 | Phase 3 | Pending |
| TOOL-03 | Phase 3 | Pending |
| TOOL-04 | Phase 3 | Pending |
| TOOL-05 | Phase 10 | Pending |
| VERIFY-01 | Phase 5 | Pending |
| VERIFY-02 | Phase 5 | Pending |
| VERIFY-03 | Phase 5 | Pending |
| VERIFY-04 | Phase 6 | Pending |
| VERIFY-05 | Phase 5 | Pending |
| VERIFY-06 | Phase 6 | Pending |
| PR-01 | Phase 7 | Pending |
| PR-02 | Phase 7 | Pending |
| PR-03 | Phase 7 | Pending |
| PR-04 | Phase 7 | Pending |
| PR-05 | Phase 7 | Pending |
| CLI-01 | Phase 2 | Pending |
| CLI-02 | Phase 2 | Pending |
| CLI-03 | Phase 2 | Pending |
| CLI-04 | Phase 2 | Pending |
| CLI-05 | Phase 2 | Pending |
| TASK-01 | Phase 8 | Pending |
| TASK-02 | Phase 9 | Pending |
| TASK-03 | Phase 8 | Pending |
| TASK-04 | Phase 8 | Pending |

---
*Last updated: 2026-01-27 after Phase 1 completion*
