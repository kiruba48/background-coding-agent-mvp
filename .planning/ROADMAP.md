# Roadmap: Background Coding Agent

## Milestones

- ✅ **v1.0 Foundation** — Phases 1-6 (shipped 2026-03-02)
- ✅ **v1.1 End-to-End Pipeline** — Phases 7-9 (shipped 2026-03-11)
- ✅ **v2.0 Claude Agent SDK Migration** — Phases 10-13 (shipped 2026-03-19)
- 🚧 **v2.1 Conversational Mode** — Phases 14-17 (in progress)

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

### 🚧 v2.1 Conversational Mode (In Progress)

**Milestone Goal:** Replace rigid CLI flags with a conversational interface — REPL + one-shot, natural language in, context-aware plan proposal, same verification pipeline out.

- [x] **Phase 14: Infrastructure Foundation** — Extract runAgent(), wire AbortSignal, build project registry (completed 2026-03-19)
- [x] **Phase 15: Intent Parser + One-Shot Mode** — Natural language → structured intent, fast-path heuristic, context scan, confirm flow, end-to-end one-shot (completed 2026-03-20)
- [x] **Phase 16: Interactive REPL** — readline loop, Ctrl+C/Ctrl+D semantics, Docker build check at startup, persistent history (completed 2026-03-20)
- [x] **Phase 17: Multi-Turn Session Context** — In-memory session history propagated to intent parser for follow-up disambiguation (completed 2026-03-22)

## Phase Details

### Phase 14: Infrastructure Foundation
**Goal**: The execution layer is importable, cancellable, and the project registry is operational — all prerequisites for conversational entry points
**Depends on**: Phase 13 (v2.0 complete)
**Requirements**: INFRA-01, INFRA-02, REG-01, REG-02
**Success Criteria** (what must be TRUE):
  1. `runAgent()` can be imported and called programmatically from a module other than the CLI entry point
  2. Passing an AbortSignal to `runAgent()` causes a running agent task to cancel gracefully without crashing the process
  3. User can register a project short name to a local repo path and resolve it back to that path
  4. Running `bg-agent` in a directory with a `.git` folder or build manifest auto-registers that directory on first use
**Plans:** 3/3 plans complete

Plans:
- [ ] 14-01-PLAN.md — Extract runAgent() and wire AbortSignal threading
- [ ] 14-02-PLAN.md — Build ProjectRegistry with conf and CRUD subcommands
- [ ] 14-03-PLAN.md — Wire CLI adapter, auto-registration, and signal handlers

### Phase 15: Intent Parser + One-Shot Mode
**Goal**: Natural language input is parsed into structured task parameters with a fast path for obvious patterns, and a complete one-shot workflow (parse → confirm → run) is functional from the command line
**Depends on**: Phase 14
**Requirements**: INTENT-01, INTENT-02, INTENT-03, CLI-01, CLI-03
**Success Criteria** (what must be TRUE):
  1. User can type `bg-agent 'update recharts'` and receive a parsed intent showing task type, dep, and (if resolvable) version before any agent run begins
  2. Obvious dependency patterns (dep name only, no ambiguity) are resolved without making an LLM API call
  3. Before executing, the user sees the proposed plan and is prompted to confirm or redirect; the agent does not run until the user confirms
  4. When the intent is ambiguous, the user is asked exactly one targeted clarification question rather than failing or guessing
  5. Package.json or pom.xml data is read from the repo and injected as structured context before the intent parser makes an LLM call on ambiguous input
**Plans:** 3/3 plans complete

Plans:
- [ ] 15-01-PLAN.md — Intent types, fast-path regex parser, and context scanner
- [ ] 15-02-PLAN.md — LLM parser, confirm loop, and "latest" sentinel handling
- [ ] 15-03-PLAN.md — parseIntent() coordinator, one-shot CLI command, and CLI routing

### Phase 16: Interactive REPL
**Goal**: Users can start an interactive session with no arguments and issue multiple tasks conversationally, with correct signal handling and no per-task Docker startup pause
**Depends on**: Phase 15
**Requirements**: CLI-02
**Success Criteria** (what must be TRUE):
  1. Running `bg-agent` with no arguments opens an interactive prompt where the user can type tasks in natural language
  2. Pressing Ctrl+C during an agent run cancels that run and returns to the REPL prompt without exiting the session
  3. Pressing Ctrl+D or typing `exit` cleanly terminates the REPL session
  4. The Docker image build check runs once at REPL startup, not before each task
  5. Command history from the session persists to disk and is available in the next session
**Plans:** 2/2 plans complete

Plans:
- [ ] 16-01-PLAN.md — REPL types, session core (processInput), and AgentContext.skipDockerChecks
- [ ] 16-02-PLAN.md — CLI REPL adapter (readline, signals, history, banner) and CLI routing

### Phase 17: Multi-Turn Session Context
**Goal**: Follow-up inputs within a REPL session are disambiguated using prior task history, so users can say "now do lodash too" without restating the full context
**Depends on**: Phase 16
**Requirements**: SESS-01
**Success Criteria** (what must be TRUE):
  1. A follow-up task in the same REPL session correctly inherits the previously resolved project and repo without the user specifying them again
  2. Session history injected into the intent parser is bounded and does not grow unboundedly within a long session
  3. Each task still runs in a fresh Docker container regardless of session history (execution isolation is preserved)
**Plans:** 2/2 plans complete

Plans:
- [ ] 17-01-PLAN.md — Types, fast-path follow-up detection, LLM history injection, parseIntent coordinator
- [ ] 17-02-PLAN.md — Session history wiring (append, command, parseIntent pass-through), confirm annotations

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
| 15. Intent Parser + One-Shot Mode | 3/3 | Complete    | 2026-03-20 | - |
| 16. Interactive REPL | 2/2 | Complete    | 2026-03-20 | - |
| 17. Multi-Turn Session Context | 2/2 | Complete    | 2026-03-22 | - |
