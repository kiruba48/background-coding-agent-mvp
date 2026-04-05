# Requirements: Background Coding Agent

**Defined:** 2026-04-05
**Core Value:** The full verification loop must work: agent changes code, deterministic verifiers catch failures, LLM Judge catches scope creep, and only verified changes proceed.

## v2.4 Requirements

Requirements for git worktree isolation, repo exploration tasks, and tech debt cleanup.

### Worktree Isolation

- [ ] **WKTREE-01**: Agent session creates a git worktree in a sibling directory with UUID-suffixed branch name before Docker container starts
- [ ] **WKTREE-02**: Docker container bind-mounts the worktree directory (not main repo) as the workspace volume
- [ ] **WKTREE-03**: Worktree is automatically removed in a finally block after task completion (success, failure, veto, zero-diff, cancelled)
- [ ] **WKTREE-04**: Startup orphan scan prunes stale worktrees from crashed sessions using PID sentinel files
- [ ] **WKTREE-05**: Host-side git operations (commit, push) execute against the worktree path, not the main repo checkout

### Repo Exploration

- [ ] **EXPLR-01**: Intent parser recognizes exploration intents (explore, investigate, analyze, "check the CI", "what is the branching strategy") and routes to `investigation` task type
- [ ] **EXPLR-02**: Structured exploration prompts with 3 subtypes: git-strategy, ci-checks, project-structure
- [ ] **EXPLR-03**: Exploration tasks skip composite verifier, LLM Judge, and PR creation — return report via finalResponse
- [ ] **EXPLR-04**: PreToolUse hook blocks Write/Edit/destructive-Bash tools when session is read-only
- [ ] **EXPLR-05**: Exploration report displayed inline in REPL and posted as thread message in Slack

### Tech Debt

- [x] **DEBT-01**: Exit code switch includes explicit cases for `vetoed`, `turn_limit`, and `cancelled` statuses
- [x] **DEBT-02**: `SessionTimeoutError` dead code removed from `src/errors.ts`
- [x] **DEBT-03**: Cancelled tasks recorded as `cancelled` (not `failed`) in session history
- [x] **DEBT-04**: `retry.ts` configOnly path routes through `retryConfig.verifier` instead of direct `compositeVerifier` call
- [x] **DEBT-05**: Slack dead code removed (`buildIntentBlocks`, `buildStatusMessage`)
- [x] **DEBT-06**: Slack multi-turn history populated in thread sessions

## Future Requirements

Deferred to v2.5+.

### Worktree Enhancements

- **WKTREE-06**: SIGINT cleanup handler prunes known worktrees on process exit
- **WKTREE-07**: Worktree branch name shown at confirm step before execution

### Exploration Enhancements

- **EXPLR-06**: Exploration subtype: security scan (analyze dependencies for known vulnerabilities)
- **EXPLR-07**: Exploration results stored in session history for follow-up referencing

### Pipeline Enhancements

- **PIPE-01**: Parallel agent execution orchestration (queue multiple tasks, run in parallel worktrees)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Shared worktree across multi-turn REPL tasks | Breaks one-container-per-task isolation invariant (PROJECT.md constraint) |
| Exploration tasks that write code as side-effect | Mixing read/write breaks scope contract and verifier's diff criterion |
| Auto-cleanup of worktree branches after PR merge | Requires polling GitHub API or webhooks — no queue/webhook infrastructure |
| Worktrees stored inside the repo directory | Git rejects paths inside repo; sibling is the correct convention |
| Exploration tasks with network access | Security model is non-negotiable — Docker + iptables isolation applies to all task types |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| DEBT-01 | Phase 25 | Complete |
| DEBT-02 | Phase 25 | Complete |
| DEBT-03 | Phase 25 | Complete |
| DEBT-04 | Phase 25 | Complete |
| DEBT-05 | Phase 25 | Complete |
| DEBT-06 | Phase 25 | Complete |
| WKTREE-01 | Phase 26 | Pending |
| WKTREE-02 | Phase 26 | Pending |
| WKTREE-03 | Phase 26 | Pending |
| WKTREE-04 | Phase 26 | Pending |
| WKTREE-05 | Phase 26 | Pending |
| EXPLR-01 | Phase 27 | Pending |
| EXPLR-02 | Phase 27 | Pending |
| EXPLR-03 | Phase 27 | Pending |
| EXPLR-04 | Phase 27 | Pending |
| EXPLR-05 | Phase 27 | Pending |

**Coverage:**
- v2.4 requirements: 16 total
- Mapped to phases: 16
- Unmapped: 0

---
*Requirements defined: 2026-04-05*
*Last updated: 2026-04-05 — traceability updated after roadmap creation*
