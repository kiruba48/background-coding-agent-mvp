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

## Milestone: v1.1 — End-to-End Pipeline

**Shipped:** 2026-03-11
**Phases:** 3 | **Plans:** 8 | **Timeline:** 9 days

### What Was Built
- GitHub PR creation with Octokit (branch, push, PR with rich description)
- Maven dependency update task type with end-state prompting
- npm dependency update task type with shared verifier architecture
- Host-side npm install preVerify hook for lockfile regeneration
- Prompt module decoupled from CLI types

### What Worked
- End-state prompting pattern (describe desired outcome, not steps) — agent performs better
- Shared verifier architecture: npm verifier reused Maven patterns with minimal new code
- Prompt module separation: clean boundary between CLI and agent instructions

### What Was Inefficient
- MVN-05/NPM-05 (changelog links) deferred due to Docker network isolation — known limitation
- No formal milestone audit run for v1.1

### Key Lessons
1. End-state prompting > step-by-step instructions for agent tasks
2. Build-system detection belongs in composite verifier, not task-specific verifiers
3. Milestone audits should be run before archiving — catches gaps early

---

## Milestone: v2.0 — Claude Agent SDK Migration

**Shipped:** 2026-03-19
**Phases:** 4 | **Plans:** 8 | **Timeline:** 3 days

### What Was Built
- ClaudeCodeSession wrapping Agent SDK `query()` with PreToolUse/PostToolUse hooks
- Deleted 1,989 lines of legacy infrastructure (AgentSession, AgentClient, ContainerManager)
- In-process MCP verifier server (`mcp__verifier__verify`) for mid-session self-correction
- Multi-stage Alpine Docker container with iptables network isolation and non-root execution
- 271 tests across 8+ test suites, all passing

### What Worked
- TDD RED/GREEN pattern: every plan started with failing tests, then implementation — zero regressions
- SDK migration was surgical: ClaudeCodeSession as drop-in replacement, RetryOrchestrator unchanged
- Phase parallelism: Phases 12 and 13 were independent (both depend on Phase 10, not each other)
- Extremely fast execution: 8 plans in 3 days (~0.4 days/plan vs v1.0's 2.3 days/plan)
- Mock callback extraction helper (`extractCallback`) solved variable-arity `execFile` mock issue cleanly

### What Was Inefficient
- SUMMARY frontmatter `requirements_completed` not populated for Phases 11 and 13 — same gap as v1.0
- Nyquist validation drafts exist but none are fully compliant — should be built into plan execution
- STATE.md accumulated context grew stale (still referenced Phase 10 as current during Phase 13)
- ROADMAP progress table had misaligned columns for phases 11-13 (missing milestone column)

### Patterns Established
- SDK hook factories: `buildPreToolUseHook(workspaceDir)` / `buildPostToolUseHook(logger, counterRef)`
- MCP server in-process pattern: `createSdkMcpServer` with zero-arg tool and digest formatting
- Docker helper module: `assertDockerRunning` → `ensureNetworkExists` → `buildImageIfNeeded` → `buildDockerRunArgs`
- `spawnClaudeCodeProcess` override: SDK spawns Docker instead of local Claude Code CLI

### Key Lessons
1. SDK migration is best done as parallel tracks (session wrapper → wiring → deletion → new features) rather than big-bang rewrite
2. `settingSources: []` is critical for agent isolation — filesystem config must never leak in
3. Budget exhaustion (`error_max_budget_usd`) should map to terminal status — don't retry expensive failures
4. Docker entrypoint DNS resolution needs retry loop — `dig` can fail on cold start
5. Mock `execFile` in tests needs default `beforeEach` implementation or finally-block cleanup hangs all tests

### Cost Observations
- Model mix: balanced profile (sonnet for agents, haiku for judge)
- Plan execution avg: ~6 min/plan (but huge variance: 86s for MCP wiring to 17.5m for Dockerfile)
- Notable: v2.0 was 3.5x faster per-plan than v1.0 — SDK abstractions reduced boilerplate dramatically

---

## Milestone: v2.1 — Conversational Mode

**Shipped:** 2026-03-22
**Phases:** 4 | **Plans:** 10 | **Timeline:** 4 days

### What Was Built
- runAgent() library extraction with AbortSignal threading for graceful mid-task cancellation
- Project registry (conf@15) with CLI subcommands (list/add/remove) and auto-registration of cwd
- Intent parser: fast-path regex for obvious dependency patterns, LLM fallback (Haiku 4.5 structured output) for ambiguous input
- Confirm-before-execute flow with inline correction support (non-y/n input treated as redirect)
- Context scanner reading package.json/pom.xml to inject repo context before LLM parse
- Interactive REPL with readline, Ctrl+C cancellation (per-task, not session), persistent history, Docker pre-check
- Multi-turn session context: bounded history injection into intent parser for follow-up disambiguation

### What Worked
- Channel-agnostic architecture: SessionCallbacks injection pattern decouples I/O from session logic — REPL, Slack, MCP adapters can share processInput()
- Fast-path before LLM: obvious patterns (e.g., "update recharts") resolved in microseconds, no API call
- Zod schema enforcement: version numbers never come from LLM (sentinel 'latest' or null) — prevents hallucinated versions
- History snapshot pattern: `[...state.history]` passed to parseIntent prevents mutation leaking post-run state into mock assertions
- Follow-up detection order: follow-up patterns checked BEFORE standard patterns in fast-path, ensuring "also update lodash" hits the right path

### What Was Inefficient
- SUMMARY frontmatter `requirements_completed` still not populated for some plans (INFRA-02, REG-01) — same gap as v1.0/v2.0
- Cancelled task status recorded as 'failed' in session history — missing ternary branch discovered only during audit
- `inheritedFields` documented as Set<> in plans but implemented as Array<> — doc/code divergence
- STATE.md accumulated context grew very large (77 lines of decisions) — should be pruned during execution, not only at milestone boundary
- No test for return-based cancellation path (only throw-based AbortError covered)

### Patterns Established
- Intent parser layering: fast-path regex → context scan → LLM fallback → confirm loop
- Follow-up disambiguation: history injection with bounded token budget, graceful degradation when no history
- REPL signal ownership: readline owns SIGINT in REPL mode; process signal handlers only in one-shot mode
- Dynamic imports: `import('./commands/repl.js')` keeps REPL code out of one-shot path
- Factory injection for test isolation: registry tests use injected createConf rather than mocking conf internals

### Key Lessons
1. Signal handling ownership must be decided early — REPL readline and process SIGINT handlers conflict if both active
2. Dynamic imports for conditional features prevent loading unused code (nanospinner, readline) in the other path
3. Zod schema enforcement is the right place to block LLM hallucination for specific fields (versions)
4. Inline correction in confirm loops (treating non-y/n as redirect) is better UX than forced rejection + separate prompt
5. STATE.md accumulated context should be pruned periodically, not only at milestone boundaries — it reached 77 lines

### Cost Observations
- Model mix: balanced profile (sonnet for execution agents, haiku for intent parsing + judge)
- Plan execution avg: ~1 day/phase (2.5 plans/day)
- Notable: v2.1 added 10 plans in 4 days, fastest per-phase velocity yet — intent parser and REPL were well-decomposed

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Timeline | Phases | Plans | Key Change |
|-----------|----------|--------|-------|------------|
| v1.0 | 35 days | 6 | 15 | Initial architecture established |
| v1.1 | 9 days | 3 | 8 | End-state prompting, task types |
| v2.0 | 3 days | 4 | 8 | SDK migration, 1,989 lines deleted |
| v2.1 | 4 days | 4 | 10 | Conversational interface (REPL + intent parser) |

### Cumulative Quality

| Milestone | Tests | Test Framework | LOC |
|-----------|-------|----------------|-----|
| v1.0 | 90 | Vitest | 5,460 |
| v1.1 | ~120 | Vitest | ~7,060 |
| v2.0 | 271 | Vitest | 8,167 |
| v2.1 | 513 | Vitest | 13,780 |

### Top Lessons (Verified Across Milestones)

1. Security boundaries should be established in Phase 1 and layered incrementally
2. Deterministic verification beats LLM-based checking for structured output (build errors, test failures)
3. SUMMARY frontmatter `requirements_completed` must be populated during execution, not retrofitted
4. End-state prompting outperforms step-by-step instructions for agent tasks
5. SDK abstractions dramatically reduce per-plan execution time (2.3 → 1.1 → 0.4 → 0.4 days/plan)
6. Channel-agnostic architecture (callback injection) pays off immediately — enables multiple entry points without duplication
