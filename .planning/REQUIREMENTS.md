# Requirements: Background Coding Agent

**Defined:** 2026-03-25
**Core Value:** The full verification loop must work: agent changes code, deterministic verifiers catch failures, LLM Judge catches scope creep, and only verified changes proceed.

## v2.3 Requirements

Requirements for milestone v2.3 Conversational Scoping & REPL Enhancements. Each maps to roadmap phases.

### Post-Hoc PR Creation

- [ ] **PR-01**: User can type `pr` or `create pr` in REPL to create a GitHub PR for the last completed task
- [ ] **PR-02**: User sees clear error message when no completed task exists ("No completed task in this session")
- [ ] **PR-03**: User sees task summary before PR is created ("Creating PR for: [description] ([project])")
- [ ] **PR-04**: `create pr` / `create a pr` natural language input routes to post-hoc PR flow, not intent parser

### Conversational Scoping

- [ ] **SCOPE-01**: User is asked up to 3 optional scoping questions before confirm for generic tasks (target files, test update, exclusions)
- [ ] **SCOPE-02**: User can skip any scoping question by pressing Enter (no constraint added)
- [ ] **SCOPE-03**: Scoping answers are merged into buildGenericPrompt SCOPE block for agent execution
- [ ] **SCOPE-04**: Assembled SCOPE block is displayed at confirm step so user can review before proceeding
- [ ] **SCOPE-05**: Scoping questions only trigger for generic taskType, not dependency updates

### Follow-Up Referencing

- [ ] **FLLW-01**: TaskHistoryEntry includes task description so follow-up inputs have context
- [ ] **FLLW-02**: RetryResult is stored on ReplState after each task completion for cross-task referencing
- [ ] **FLLW-03**: Follow-up inputs like "now add tests for that" can reference previous task outcome via enriched history

### Slack Bot

- [ ] **SLCK-01**: Slack bot listens for app_mention events via Bolt Socket Mode
- [ ] **SLCK-02**: Bot parses mentioned text through existing intent parser and displays parsed intent in thread
- [ ] **SLCK-03**: Bot presents Block Kit buttons (Proceed / Cancel) for task confirmation
- [ ] **SLCK-04**: Bot executes confirmed tasks asynchronously (ack within 3 seconds, fire-and-forget agent run)
- [ ] **SLCK-05**: All bot responses appear in the same thread as the triggering mention
- [ ] **SLCK-06**: Bot posts PR link as final thread message when PR is created
- [ ] **SLCK-07**: Bot implements SessionCallbacks interface for channel-agnostic integration with existing pipeline

## Future Requirements

Deferred to future release. Tracked but not in current roadmap.

### Slack Bot Enhancements

- **SLCK-08**: Bot supports multiple concurrent pending confirmations keyed by user ID + channel
- **SLCK-09**: Persistent Slack conversation history across bot restarts (database-backed)
- **SLCK-10**: Scoping dialogue in Slack via Block Kit modals

### Scoping Enhancements

- **SCOPE-06**: Dynamic scoping questions generated per-task by LLM (instead of fixed 3 questions)

### REPL Enhancements

- **REPL-01**: Tab completion for project names and common task patterns
- **REPL-02**: --yes flag for auto-proceed on high-confidence parses (CI/scripting)

### Task Execution

- **TASK-01**: Multi-file migration support with scoped planning phase before execution
- **TASK-02**: Task discovery mode — separate analysis mode that identifies where changes are needed

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Mid-run input injection in Slack | Breaks Docker isolation invariant; all scoping happens pre-confirmation |
| Scoping dialogue for dependency updates | Dep updates are already fully parameterized; scoping adds friction |
| Persistent cross-session REPL history | Stale context causes misparses; sessions reset on restart |
| Slack auto-execute without confirmation | Removes human-in-the-loop trust model |
| Slack message metadata for intent storage | Serialization round-trip issues; bot-side Map is simpler |
| Unlimited scoping follow-up questions | Diminishing returns beyond 2-3; erodes trust |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| PR-01 | Phase 21 | Pending |
| PR-02 | Phase 21 | Pending |
| PR-03 | Phase 21 | Pending |
| PR-04 | Phase 21 | Pending |
| SCOPE-01 | Phase 22 | Pending |
| SCOPE-02 | Phase 22 | Pending |
| SCOPE-03 | Phase 22 | Pending |
| SCOPE-04 | Phase 22 | Pending |
| SCOPE-05 | Phase 22 | Pending |
| FLLW-01 | Phase 21 | Pending |
| FLLW-02 | Phase 21 | Pending |
| FLLW-03 | Phase 23 | Pending |
| SLCK-01 | Phase 24 | Pending |
| SLCK-02 | Phase 24 | Pending |
| SLCK-03 | Phase 24 | Pending |
| SLCK-04 | Phase 24 | Pending |
| SLCK-05 | Phase 24 | Pending |
| SLCK-06 | Phase 24 | Pending |
| SLCK-07 | Phase 24 | Pending |

**Coverage:**
- v2.3 requirements: 19 total
- Mapped to phases: 19
- Unmapped: 0 ✓

---
*Requirements defined: 2026-03-25*
*Last updated: 2026-03-25 after roadmap creation*
