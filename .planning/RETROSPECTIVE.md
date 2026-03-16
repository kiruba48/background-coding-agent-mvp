# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

## Milestone: v1.0 — Foundation

**Shipped:** 2026-03-02
**Phases:** 6 | **Plans:** 15 | **Timeline:** 35 days

### What Was Built
- Docker sandbox with non-root user, network-none, read-only rootfs, and process limits
- CLI-driven orchestration with Commander.js, Pino structured logging, and metrics tracking
- Six agent tools (read_file, edit_file, git_operation, grep, bash_command, list_files) with security boundaries
- RetryOrchestrator with ErrorSummarizer (2000-char digest cap, regex-based extraction)
- Composite verifier pipeline (build + test + lint running in parallel)
- LLM Judge via Claude Haiku 4.5 structured output with fail-open semantics and veto budget

### What Worked
- Phase-by-phase incremental build: each phase cleanly layered on previous work
- Security-first architecture: path validation, allowlists, and network isolation from Phase 1
- Host-side git execution avoided container permission issues entirely
- Vitest adoption: native ESM support, zero config, fast execution
- ErrorSummarizer pattern: deterministic regex beats LLM summarization for structured output
- Fresh AgentSession per retry prevents context window exhaustion

### What Was Inefficient
- SUMMARY frontmatter `requirements_completed` not populated for Phases 1-3 and 6 (older format)
- REQUIREMENTS.md checkboxes went stale — manual checkbox tracking is error-prone
- Phase 3 took 27.4 min (2x other phases) due to security boundary complexity
- Documentation field name divergence (`maxJudgeRetries` vs `maxJudgeVetoes`) during Phase 6 implementation

### Patterns Established
- Agent tools: read-only operations in container, write operations on host via `writeFileAtomic`
- Security layers: validatePath (4 defenses) + operation allowlists + flag validation
- Verification pipeline: compositeVerifier → RetryOrchestrator → LLM Judge (sequential gates)
- Test pattern: vi.mock at module level, direct `executeTool` casting for unit tests
- CLI pattern: POSIX exit codes (0/1/2/124/130/143) for shell scripting

### Key Lessons
1. Host-side execution for git ops is non-negotiable when container user differs from host user
2. Error summarization should be deterministic (regex) not LLM-based — faster, cheaper, more predictable
3. Fail-open for optional services (LLM Judge) prevents pipeline brittleness
4. SUMMARY frontmatter should be populated consistently from Phase 1 — retrofit is painful
5. Exit code switch statements need explicit cases for all status values, not `default` fallthrough

### Cost Observations
- Model mix: Balanced profile (sonnet for agents, haiku for judge)
- Plan execution avg: 4.8 min/plan
- Notable: Phase 3 was the outlier (13.7 min/plan) due to tool security complexity; all other phases averaged 3-4 min/plan

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Timeline | Phases | Plans | Key Change |
|-----------|----------|--------|-------|------------|
| v1.0 | 35 days | 6 | 15 | Initial architecture established |

### Cumulative Quality

| Milestone | Tests | Test Framework | LOC |
|-----------|-------|----------------|-----|
| v1.0 | 90 | Vitest | 5,460 |

### Top Lessons (Verified Across Milestones)

1. Security boundaries should be established in Phase 1 and layered incrementally
2. Deterministic verification beats LLM-based checking for structured output (build errors, test failures)
