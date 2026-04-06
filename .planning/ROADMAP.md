# Roadmap: Background Coding Agent

## Milestones

- ✅ **v1.0 Foundation** — Phases 1-6 (shipped 2026-03-02)
- ✅ **v1.1 End-to-End Pipeline** — Phases 7-9 (shipped 2026-03-11)
- ✅ **v2.0 Claude Agent SDK Migration** — Phases 10-13 (shipped 2026-03-19)
- ✅ **v2.1 Conversational Mode** — Phases 14-17 (shipped 2026-03-22)
- ✅ **v2.2 Deterministic Task Support** — Phases 18-20 (shipped 2026-03-25)
- ✅ **v2.3 Conversational Scoping & REPL Enhancements** — Phases 21-24 (shipped 2026-04-05)
- 🚧 **v2.4 Git Worktree & Repo Exploration** — Phases 25-27 (in progress)

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

Full details: [v1.1-ROADMAP.md](milestones/v1.1-ROADMAP.md)

</details>

<details>
<summary>✅ v2.0 Claude Agent SDK Migration (Phases 10-13) — SHIPPED 2026-03-19</summary>

- [x] Phase 10: Agent SDK Integration (2/2 plans) — completed 2026-03-17
- [x] Phase 11: Legacy Deletion (2/2 plans) — completed 2026-03-18
- [x] Phase 12: MCP Verifier Server (2/2 plans) — completed 2026-03-18
- [x] Phase 13: Container Strategy (2/2 plans) — completed 2026-03-19

Full details: [v2.0-ROADMAP.md](milestones/v2.0-ROADMAP.md)

</details>

<details>
<summary>✅ v2.1 Conversational Mode (Phases 14-17) — SHIPPED 2026-03-22</summary>

- [x] Phase 14: Infrastructure Foundation (3/3 plans) — completed 2026-03-19
- [x] Phase 15: Intent Parser + One-Shot Mode (3/3 plans) — completed 2026-03-20
- [x] Phase 16: Interactive REPL (2/2 plans) — completed 2026-03-20
- [x] Phase 17: Multi-Turn Session Context (2/2 plans) — completed 2026-03-22

Full details: [v2.1-ROADMAP.md](milestones/v2.1-ROADMAP.md)

</details>

<details>
<summary>✅ v2.2 Deterministic Task Support (Phases 18-20) — SHIPPED 2026-03-25</summary>

- [x] Phase 18: Intent Parser Generalization (2/2 plans) — completed 2026-03-23
- [x] Phase 19: Generic Prompt Builder (2/2 plans) — completed 2026-03-24
- [x] Phase 20: Verification & Safety (2/2 plans) — completed 2026-03-24

Full details: [v2.2-ROADMAP.md](milestones/v2.2-ROADMAP.md)

</details>

<details>
<summary>✅ v2.3 Conversational Scoping & REPL Enhancements (Phases 21-24) — SHIPPED 2026-04-05</summary>

- [x] Phase 21: Post-Hoc PR & State Foundation (2/2 plans) — completed 2026-03-26
- [x] Phase 22: Conversational Scoping Dialogue (2/2 plans) — completed 2026-03-26
- [x] Phase 23: Follow-Up Task Referencing (1/1 plan) — completed 2026-04-01
- [x] Phase 24: Slack Bot Adapter (2/2 plans) — completed 2026-04-05

Full details: [v2.3-ROADMAP.md](milestones/v2.3-ROADMAP.md)

</details>

### v2.4 Git Worktree & Repo Exploration (In Progress)

**Milestone Goal:** Enable concurrent agent runs via git worktree isolation, add read-only repo exploration tasks, and clean up accumulated tech debt.

- [x] **Phase 25: Tech Debt Cleanup** — Fix exit codes, remove dead code, correct configOnly verifier bypass, populate Slack history (completed 2026-04-05)
- [x] **Phase 26: Git Worktree Isolation** — WorktreeManager with create/remove/prune, workspaceDir seam, readOnly Docker flag (completed 2026-04-05)
- [ ] **Phase 27: Repo Exploration Tasks** — Investigation task type, read-only Docker enforcement, report display in REPL and Slack

## Phase Details

### Phase 25: Tech Debt Cleanup
**Goal**: Establish a clean, fully-verified codebase baseline before any feature work — fix all enumerated debt items so Phase 26's diff is unambiguously feature-only
**Depends on**: Nothing (first phase of milestone)
**Requirements**: DEBT-01, DEBT-02, DEBT-03, DEBT-04, DEBT-05, DEBT-06
**Success Criteria** (what must be TRUE):
  1. CLI exits with a distinct non-zero code when a task is vetoed, hits the turn limit, or is cancelled — not the generic failure code
  2. `SessionTimeoutError` no longer appears anywhere in `src/errors.ts` or its imports
  3. Cancelling a running task records `cancelled` in session history — not `failed`
  4. The configOnly path in `retry.ts` calls `retryConfig.verifier` instead of directly calling `compositeVerifier`
  5. `buildIntentBlocks` and `buildStatusMessage` are absent from the Slack module, and Slack multi-turn thread sessions have populated history
**Plans**: 2 plans

Plans:
- [ ] 25-01-PLAN.md — Fix exit codes, remove dead SessionTimeoutError, correct cancelled history recording
- [ ] 25-02-PLAN.md — Route configOnly through injected verifier, remove Slack dead code, populate Slack history

### Phase 26: Git Worktree Isolation
**Goal**: Every agent session operates in its own git worktree so concurrent runs on the same repo never conflict — Docker container mounts the worktree, not the main checkout
**Depends on**: Phase 25
**Requirements**: WKTREE-01, WKTREE-02, WKTREE-03, WKTREE-04, WKTREE-05
**Success Criteria** (what must be TRUE):
  1. Starting two agent sessions on the same repo concurrently produces two separate worktrees on two UUID-suffixed branches, with neither session touching the main checkout's working tree
  2. After a task completes (success, failure, veto, zero-diff, or cancellation), the worktree directory and branch are removed — no worktrees accumulate across runs
  3. Restarting the process after a simulated crash finds and prunes any worktree whose PID sentinel file references a dead process
  4. Git operations from the agent (commit, push) land on the worktree branch — the main branch HEAD does not move during a run
**Plans**: 2 plans

Plans:
- [ ] 26-01-PLAN.md — WorktreeManager class with create, remove, buildWorktreePath, pruneOrphans + unit tests
- [ ] 26-02-PLAN.md — Integrate WorktreeManager into runAgent(), REPL orphan scan, post-hoc PR branch support

### Phase 27: Repo Exploration Tasks
**Goal**: Users can ask the agent to investigate a repo (git strategy, CI setup, project structure) and receive a structured report — no code changes, no PR, no verifier run
**Depends on**: Phase 26
**Requirements**: EXPLR-01, EXPLR-02, EXPLR-03, EXPLR-04, EXPLR-05
**Success Criteria** (what must be TRUE):
  1. Typing "explore the branching strategy" or "check the CI setup" in the REPL routes to the `investigation` task type without requiring the user to specify a task type flag
  2. The agent returns a readable report (not a diff, not a PR link) directly in the REPL output; the same report appears as a thread message in Slack
  3. An exploration session where the agent attempts to write or edit a file is blocked at the PreToolUse hook — the file is not created and the session continues
  4. Completing an exploration task does not trigger the composite verifier, the LLM Judge, or PR creation
**Plans**: 3 plans

Plans:
- [ ] 27-01-PLAN.md — Intent parsing: investigation type, exploration fast-path, LLM parser extension, exploration prompt builder
- [ ] 27-02-PLAN.md — Pipeline: Docker :ro mount, PreToolUse read-only hook, runAgent investigation bypass
- [ ] 27-03-PLAN.md — Display: REPL report inline output, Slack report thread posting, createPr guard

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
| 11. Legacy Deletion | v2.0 | 2/2 | Complete | 2026-03-18 |
| 12. MCP Verifier Server | v2.0 | 2/2 | Complete | 2026-03-18 |
| 13. Container Strategy | v2.0 | 2/2 | Complete | 2026-03-19 |
| 14. Infrastructure Foundation | v2.1 | 3/3 | Complete | 2026-03-19 |
| 15. Intent Parser + One-Shot Mode | v2.1 | 3/3 | Complete | 2026-03-20 |
| 16. Interactive REPL | v2.1 | 2/2 | Complete | 2026-03-20 |
| 17. Multi-Turn Session Context | v2.1 | 2/2 | Complete | 2026-03-22 |
| 18. Intent Parser Generalization | v2.2 | 2/2 | Complete | 2026-03-23 |
| 19. Generic Prompt Builder | v2.2 | 2/2 | Complete | 2026-03-24 |
| 20. Verification & Safety | v2.2 | 2/2 | Complete | 2026-03-24 |
| 21. Post-Hoc PR & State Foundation | v2.3 | 2/2 | Complete | 2026-03-26 |
| 22. Conversational Scoping Dialogue | v2.3 | 2/2 | Complete | 2026-03-26 |
| 23. Follow-Up Task Referencing | v2.3 | 1/1 | Complete | 2026-04-01 |
| 24. Slack Bot Adapter | v2.3 | 2/2 | Complete | 2026-04-05 |
| 25. Tech Debt Cleanup | 2/2 | Complete    | 2026-04-05 | - |
| 26. Git Worktree Isolation | 2/2 | Complete    | 2026-04-05 | - |
| 27. Repo Exploration Tasks | 1/3 | In Progress|  | - |
