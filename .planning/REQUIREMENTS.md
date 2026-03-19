# Requirements: Background Coding Agent

**Defined:** 2026-03-19
**Core Value:** The full verification loop must work: agent changes code, deterministic verifiers catch failures, LLM Judge catches scope creep, and only verified changes proceed.

## v2.1 Requirements

Requirements for conversational mode. Each maps to roadmap phases.

### Infrastructure

- [ ] **INFRA-01**: runAgent() extracted as importable function callable from REPL and one-shot paths
- [ ] **INFRA-02**: runAgent() accepts AbortSignal for graceful mid-task cancellation

### Intent Parsing

- [ ] **INTENT-01**: User can describe a task in natural language and get structured intent (task type, repo, dep, version)
- [ ] **INTENT-02**: Obvious patterns (e.g. "update recharts") are resolved via fast-path heuristic without LLM call
- [ ] **INTENT-03**: Intent parser reads package.json/pom.xml to inject repo context before parsing ambiguous input

### CLI Modes

- [ ] **CLI-01**: User can run a single task via positional arg (bg-agent 'update recharts') and exit
- [ ] **CLI-02**: User can start interactive REPL session with bg-agent (no args)
- [ ] **CLI-03**: User sees parsed intent and proposed plan before execution, can confirm or redirect

### Project Registry

- [ ] **REG-01**: User can register and resolve project short names to repo paths
- [ ] **REG-02**: Terminal sessions auto-register cwd into project registry on first use

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
| INFRA-01 | — | Pending |
| INFRA-02 | — | Pending |
| INTENT-01 | — | Pending |
| INTENT-02 | — | Pending |
| INTENT-03 | — | Pending |
| CLI-01 | — | Pending |
| CLI-02 | — | Pending |
| CLI-03 | — | Pending |
| REG-01 | — | Pending |
| REG-02 | — | Pending |
| SESS-01 | — | Pending |

**Coverage:**
- v2.1 requirements: 11 total
- Mapped to phases: 0
- Unmapped: 11

---
*Requirements defined: 2026-03-19*
*Last updated: 2026-03-19 after initial definition*
