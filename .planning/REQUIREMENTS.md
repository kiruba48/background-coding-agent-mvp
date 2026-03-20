# Requirements: Background Coding Agent

**Defined:** 2026-03-19
**Core Value:** The full verification loop must work: agent changes code, deterministic verifiers catch failures, LLM Judge catches scope creep, and only verified changes proceed.

## v2.1 Requirements

Requirements for conversational mode. Each maps to roadmap phases.

### Infrastructure

- [x] **INFRA-01**: runAgent() extracted as importable function callable from REPL and one-shot paths
- [x] **INFRA-02**: runAgent() accepts AbortSignal for graceful mid-task cancellation

### Intent Parsing

- [x] **INTENT-01**: User can describe a task in natural language and get structured intent (task type, repo, dep, version)
- [x] **INTENT-02**: Obvious patterns (e.g. "update recharts") are resolved via fast-path heuristic without LLM call
- [x] **INTENT-03**: Intent parser reads package.json/pom.xml to inject repo context before parsing ambiguous input

### CLI Modes

- [ ] **CLI-01**: User can run a single task via positional arg (bg-agent 'update recharts') and exit
- [ ] **CLI-02**: User can start interactive REPL session with bg-agent (no args)
- [x] **CLI-03**: User sees parsed intent and proposed plan before execution, can confirm or redirect

### Project Registry

- [x] **REG-01**: User can register and resolve project short names to repo paths
- [x] **REG-02**: Terminal sessions auto-register cwd into project registry on first use

### Multi-Turn Sessions

- [ ] **SESS-01**: REPL session maintains context from prior tasks for follow-up disambiguation

## Future Requirements

Deferred to v2.2+.

### Multi-Turn Enhancement

- **SESS-02**: Follow-up tasks can explicitly reference previous task results ("fix the errors from that")

### Advanced CLI

- **CLI-04**: Tab completion for project names and common task patterns
- **CLI-05**: Command history persistence across REPL sessions

### Integrations

- **INTG-01**: Slack bot interface using same intent parser and project registry
- **INTG-02**: --yes flag to auto-proceed for high-confidence parses (CI/scripting)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Shared workspace across multi-turn tasks | Breaks one-container-per-task isolation invariant |
| Auto-execute without confirmation | Removes human-in-the-loop trust model |
| Persistent cross-session context | Stale context causes misparses — sessions reset on restart |
| Custom verifier plugins | Deferred from v2.0, not related to conversational mode |
| Real-time streaming UI | CLI output sufficient for v2.1 |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| INFRA-01 | Phase 14 | Complete |
| INFRA-02 | Phase 14 | Complete |
| REG-01 | Phase 14 | Complete |
| REG-02 | Phase 14 | Complete |
| INTENT-01 | Phase 15 | Complete |
| INTENT-02 | Phase 15 | Complete |
| INTENT-03 | Phase 15 | Complete |
| CLI-01 | Phase 15 | Pending |
| CLI-03 | Phase 15 | Complete |
| CLI-02 | Phase 16 | Pending |
| SESS-01 | Phase 17 | Pending |

**Coverage:**
- v2.1 requirements: 11 total
- Mapped to phases: 11
- Unmapped: 0

---
*Requirements defined: 2026-03-19*
*Last updated: 2026-03-19 after roadmap creation*
