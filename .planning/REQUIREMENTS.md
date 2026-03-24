# Requirements: Background Coding Agent

**Defined:** 2026-03-23
**Core Value:** The full verification loop must work: agent changes code, deterministic verifiers catch failures, LLM Judge catches scope creep, and only verified changes proceed.

## v2.2 Requirements

Requirements for Deterministic Task Support milestone. Each maps to roadmap phases.

### Intent Parsing

- [x] **INTENT-01**: User can provide any explicit code change instruction and the intent parser classifies it as `generic` task type
- [x] **INTENT-02**: Fast-path regex includes verb guard so refactoring instructions ("replace axios with fetch") are not misclassified as dependency updates
- [x] **INTENT-03**: Intent parser uses GA structured outputs API (`output_config.format`) instead of deprecated beta endpoint

### Prompt & Execution

- [x] **PROMPT-01**: Generic prompt builder constructs end-state prompt from user instruction + repo context (language, build tool, manifest summary)
- [x] **PROMPT-02**: Generic task system prompt includes explicit scope constraint preventing agent from touching unrelated files
- [x] **PROMPT-03**: Confirm loop displays instruction summary and planned approach for generic tasks (not just dep/version fields)

### Verification & Safety

- [ ] **VERIFY-01**: Zero-diff detection runs after agent completes but before verifier — empty diff produces a distinct `zero_diff` outcome with clear user message
- [ ] **VERIFY-02**: Change-type-aware verification inspects modified file extensions — config-only changes skip build+test, source changes get full composite verifier
- [ ] **VERIFY-03**: LLM Judge prompt is enriched to distinguish legitimate refactoring side-effects (test updates, import changes) from actual scope creep

## Future Requirements

### v2.3+ Complex Migrations

- **MIGRATE-01**: Multi-file migration support with scoped planning phase before execution
- **MIGRATE-02**: Task discovery mode — separate analysis mode that identifies where changes are needed
- **MIGRATE-03**: Custom verifier profiles per file type

### Deferred from Active

- **DEFER-01**: Follow-up tasks can explicitly reference previous task results
- **DEFER-02**: Tab completion for project names and common task patterns
- **DEFER-03**: --yes flag for auto-proceed on high-confidence parses (CI/scripting)
- **DEFER-04**: Slack bot interface using same intent parser and project registry

## Out of Scope

| Feature | Reason |
|---------|--------|
| Per-category task-type handlers (refactor-handler, config-handler) | Generic execution path with good prompting outperforms category-specific handlers (SWE-bench data) |
| Mid-run user clarification | Breaks "no user input after confirm" invariant; shift all clarification to pre-confirm stage |
| Step-by-step prompt injection | End-state prompting outperforms step-by-step on capable models (established project decision TASK-04) |
| Task discovery ("find all deprecated calls") | Changes agent contract from "apply instruction" to "decide what needs changing"; Judge cannot validate agent-defined scope |
| Automatic instruction rewriting | Hidden translation layer; if rewritten instruction is wrong, user cannot see or correct it |
| Multi-file migrations in v2.2 | Exceeds reliable single-run scope; partial migrations leave codebase broken; defer to v2.3+ |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| INTENT-01 | Phase 18 | Complete |
| INTENT-02 | Phase 18 | Complete |
| INTENT-03 | Phase 18 | Complete |
| PROMPT-01 | Phase 19 | Complete |
| PROMPT-02 | Phase 19 | Complete |
| PROMPT-03 | Phase 19 | Complete |
| VERIFY-01 | Phase 20 | Pending |
| VERIFY-02 | Phase 20 | Pending |
| VERIFY-03 | Phase 20 | Pending |

**Coverage:**
- v2.2 requirements: 9 total
- Mapped to phases: 9
- Unmapped: 0 ✓

---
*Requirements defined: 2026-03-23*
*Last updated: 2026-03-23 — traceability filled after roadmap creation*
