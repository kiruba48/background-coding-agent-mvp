# Roadmap: Background Coding Agent

## Milestones

- ✅ **v1.0 Foundation** — Phases 1-6 (shipped 2026-03-02)
- ✅ **v1.1 End-to-End Pipeline** — Phases 7-9 (shipped 2026-03-11)
- ✅ **v2.0 Claude Agent SDK Migration** — Phases 10-13 (shipped 2026-03-19)
- ✅ **v2.1 Conversational Mode** — Phases 14-17 (shipped 2026-03-22)
- 🚧 **v2.2 Deterministic Task Support** — Phases 18-20 (in progress)

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

### 🚧 v2.2 Deterministic Task Support (In Progress)

**Milestone Goal:** Generalize the agent beyond dependency updates to handle any explicit code change instruction — config edits, simple refactors, method replacements — with fully autonomous execution from task spec to PR.

- [x] **Phase 18: Intent Parser Generalization** - Add `generic` task type, refactoring verb guard, and migrate to GA structured outputs API (completed 2026-03-23)
- [ ] **Phase 19: Generic Prompt Builder** - Build scope-fenced prompt, wire dispatch, update confirm loop display
- [ ] **Phase 20: Verification & Safety** - Zero-diff detection, change-type-aware verification, LLM Judge calibration

## Phase Details

### Phase 18: Intent Parser Generalization
**Goal**: The intent parser correctly classifies any explicit code change instruction as `generic` and migrates off the deprecated beta structured outputs API
**Depends on**: Phase 17 (v2.1 complete)
**Requirements**: INTENT-01, INTENT-02, INTENT-03
**Success Criteria** (what must be TRUE):
  1. User types "replace axios with fetch" and the parsed intent has `taskType: 'generic'`, not `taskType: 'npm-dependency-update'`
  2. User types any explicit code change instruction (not a dep update) and the intent schema produces `{taskType: 'generic', description: string}` with no parse error
  3. The fast-path regex skips to the LLM parser when a refactoring verb (`replace`, `rename`, `move`, `extract`, `migrate`, `rewrite`) precedes a package name
  4. Intent parsing calls `client.messages.create()` with `output_config.format` — no `betas` header, no beta endpoint
**Plans**: 2 plans

Plans:
- [ ] 18-01-PLAN.md — SDK bump to ^0.80.0 and refactoring verb guard in fast-path
- [ ] 18-02-PLAN.md — Schema generalization (generic type + taskCategory) and GA API migration

### Phase 19: Generic Prompt Builder
**Goal**: Agent sessions for generic tasks receive a scope-fenced end-state prompt derived from the user's instruction, and users see a meaningful task summary before confirming
**Depends on**: Phase 18
**Requirements**: PROMPT-01, PROMPT-02, PROMPT-03
**Success Criteria** (what must be TRUE):
  1. User confirms a generic task and the agent prompt contains an explicit SCOPE block preventing modification of files unrelated to the stated instruction
  2. Agent prompt incorporates repo context (detected language, build tool, manifest summary) alongside the verbatim user instruction
  3. User sees a confirmation display with the instruction summary and `taskCategory` label (e.g., "code-change") before execution begins — not just dep/version fields
  4. On retry, the second attempt receives the same scope-fenced prompt as the first attempt — the SCOPE block is not lost between retries
**Plans**: TBD

Plans:
- [ ] 19-01: TBD

### Phase 20: Verification & Safety
**Goal**: The verification pipeline handles generic task outcomes correctly — empty diffs are surfaced immediately, config-only changes skip the build pipeline, and the LLM Judge does not veto correct refactoring diffs
**Depends on**: Phase 19
**Requirements**: VERIFY-01, VERIFY-02, VERIFY-03
**Success Criteria** (what must be TRUE):
  1. Agent completes a task but produces no file changes — user sees a `zero_diff` message explaining nothing changed; no PR is created and no verifier runs
  2. User makes a config-only change (e.g., edits `.eslintrc.json`) — verification runs a syntax check only; pre-existing lint violations in source files are not reported as agent-introduced errors
  3. User makes a code change (edits `.ts` files) — full composite verifier (build + test + lint) runs unchanged
  4. Agent renames a function and updates its call sites and test files — LLM Judge does not veto the result as scope creep; test file changes exercising the renamed symbol are treated as in-scope
**Plans**: TBD

Plans:
- [ ] 20-01: TBD

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
| 18. Intent Parser Generalization | 2/2 | Complete    | 2026-03-23 | - |
| 19. Generic Prompt Builder | v2.2 | 0/? | Not started | - |
| 20. Verification & Safety | v2.2 | 0/? | Not started | - |
