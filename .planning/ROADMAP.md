# Roadmap: Background Coding Agent

## Milestones

- ✅ **v1.0 Foundation** — Phases 1-6 (shipped 2026-03-02)
- ✅ **v1.1 End-to-End Pipeline** — Phases 7-9 (shipped 2026-03-11)
- ✅ **v2.0 Claude Agent SDK Migration** — Phases 10-13 (shipped 2026-03-19)
- ✅ **v2.1 Conversational Mode** — Phases 14-17 (shipped 2026-03-22)
- ✅ **v2.2 Deterministic Task Support** — Phases 18-20 (shipped 2026-03-25)
- 🚧 **v2.3 Conversational Scoping & REPL Enhancements** — Phases 21-24 (in progress)

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

### v2.3 Conversational Scoping & REPL Enhancements (In Progress)

**Milestone Goal:** Improve agent effectiveness through pre-execution scoping dialogue, post-hoc PR creation, follow-up task referencing, and Slack bot interface.

- [x] **Phase 21: Post-Hoc PR & State Foundation** — REPL `pr` command + ReplState/TaskHistoryEntry enrichment that all subsequent phases depend on (completed 2026-03-26)
- [ ] **Phase 22: Conversational Scoping Dialogue** — Up to 3 optional pre-confirm questions for generic tasks injected into the SCOPE block
- [ ] **Phase 23: Follow-Up Task Referencing** — Enriched LLM history block so follow-up inputs can reference previous task outcomes
- [ ] **Phase 24: Slack Bot Adapter** — `@slack/bolt` Socket Mode adapter implementing SessionCallbacks for full channel-agnostic integration

## Phase Details

### Phase 21: Post-Hoc PR & State Foundation
**Goal**: Users can create a GitHub PR for the last completed task directly from the REPL without having specified `--create-pr` upfront, and the ReplState/TaskHistoryEntry schema is extended once to serve follow-up referencing in Phase 23
**Depends on**: Phase 20 (v2.2 shipped)
**Requirements**: PR-01, PR-02, PR-03, PR-04, FLLW-01, FLLW-02
**Success Criteria** (what must be TRUE):
  1. User types `pr` or `create pr` in the REPL after a successful task and a GitHub PR is created for that task without re-running the agent
  2. User types `pr` when no task has completed in the session and receives the message "No completed task in this session" without any PR attempt
  3. User sees a task summary line ("Creating PR for: [description] ([project])") before the PR is created, giving them a chance to verify intent
  4. User types "create a PR for that" in the REPL and it is handled as the post-hoc PR meta-command, not dispatched to the Docker agent
  5. TaskHistoryEntry records include task description and the stored RetryResult so subsequent phases can reference them
**Plans:** 2/2 plans complete

Plans:
- [x] 21-01-PLAN.md — ReplState/TaskHistoryEntry schema extension + state retention after runAgent
- [x] 21-02-PLAN.md — PR meta-command handler in processInput() + repl.ts display

### Phase 22: Conversational Scoping Dialogue
**Goal**: Users running generic tasks in the REPL are asked up to 3 optional scoping questions (target files, test updates, exclusions) before the confirm step, and their answers are merged into the agent prompt SCOPE block
**Depends on**: Phase 21
**Requirements**: SCOPE-01, SCOPE-02, SCOPE-03, SCOPE-04, SCOPE-05
**Success Criteria** (what must be TRUE):
  1. User submitting a generic task is prompted with up to 3 scoping questions (target files, test scope, exclusions) before the confirmation step
  2. User pressing Enter on any scoping question skips that question and no constraint is added to the prompt
  3. User sees the assembled SCOPE block displayed at the confirm step so they can review the merged constraints before the agent runs
  4. User submitting a dependency update task (Maven or npm) receives no scoping questions — the dialogue is bypassed entirely
  5. Scoping I/O is routed through SessionCallbacks.askQuestion so Slack and other adapters can implement or skip it without touching session core
**Plans:** 2 plans

Plans:
- [ ] 22-01-PLAN.md — Intent schema extension + runScopingDialogue + buildGenericPrompt SCOPE HINTS + processInput integration
- [ ] 22-02-PLAN.md — CLI askQuestion callback + displayIntent scope hints rendering

### Phase 23: Follow-Up Task Referencing
**Goal**: Follow-up inputs like "now add tests for that" resolve correctly to the previous task because the LLM history block includes agent change summaries alongside task descriptions
**Depends on**: Phase 21
**Requirements**: FLLW-03
**Success Criteria** (what must be TRUE):
  1. User types a follow-up like "now add tests for that" and the intent parser correctly resolves "that" to the previous task's subject without ambiguity
  2. The enriched history block passed to the LLM intent parser includes the agent's change summary (truncated to 300 chars) alongside the task description
  3. History entries are addressable by position ("task 2", "the auth task") so follow-ups are not forced to always reference the most recent task
**Plans**: TBD

Plans:
- [ ] 23-01: Enrich appendHistory() with finalResponse from stored RetryResult + buildHistoryBlock() update

### Phase 24: Slack Bot Adapter
**Goal**: Users can trigger the full agent pipeline (parse intent, confirm via Block Kit buttons, execute asynchronously, receive PR link) by mentioning the bot in a Slack channel, using the same pipeline as the REPL with no modifications to session core
**Depends on**: Phase 23 (all SessionCallbacks stable)
**Requirements**: SLCK-01, SLCK-02, SLCK-03, SLCK-04, SLCK-05, SLCK-06, SLCK-07
**Success Criteria** (what must be TRUE):
  1. User mentions the bot in a Slack channel with a task description and receives a threaded reply showing the parsed intent within a few seconds
  2. User clicks "Proceed" on the Block Kit confirmation buttons and the bot acknowledges within 3 seconds while the agent runs asynchronously in the background
  3. User clicks "Cancel" on the confirmation buttons and the task is aborted with a cancellation message in the thread
  4. All bot messages (intent display, confirmation buttons, status updates, PR link) appear in the same thread as the triggering mention
  5. When an agent run produces a PR, the bot posts the PR URL as the final message in the thread
  6. Two users triggering tasks simultaneously in the same channel each get independent per-user session state with no cross-contamination
**Plans**: TBD

Plans:
- [ ] 24-01: Slack Bolt app setup + Socket Mode + app_mention listener + per-user ReplState map
- [ ] 24-02: SessionCallbacks adapter (Block Kit confirm, thread replies, async fire-and-forget, onPrCreated)

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
| 22. Conversational Scoping Dialogue | v2.3 | 0/2 | Planning | - |
| 23. Follow-Up Task Referencing | v2.3 | 0/1 | Not started | - |
| 24. Slack Bot Adapter | v2.3 | 0/2 | Not started | - |
