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

## Milestone: v2.2 — Deterministic Task Support

**Shipped:** 2026-03-25
**Phases:** 3 | **Plans:** 6 | **Timeline:** 3 days

### What Was Built
- Generic task type with `buildGenericPrompt` — scope-fenced end-state prompts for any explicit code change instruction
- Intent parser generalization — `generic` taskType replacing `unknown`, refactoring verb guard, taskCategory classification
- Zero-diff detection — empty diffs caught before verifier/judge with distinct `zero_diff` status through entire stack
- Config-only verification routing — config changes skip build+test, run lint+judge only
- LLM Judge enrichment — four NOT-scope-creep entries for mechanical rename consequences (tests, imports, types, docs)
- GA structured outputs API migration for both intent parser and judge (off deprecated beta endpoint)

### What Worked
- Single generic execution path: one `buildGenericPrompt` function handles all non-dep-update tasks without category-specific handlers
- Verb guard placement: before PR_SUFFIX strip prevents false positive on "replace X and create PR" compound instructions
- Zero-diff as terminal status: same prompt can't produce different result, so retry is pointless — clean early exit
- Config-only routing preserves judge invocation while skipping build+test — catches config syntax errors without false failures
- TDD RED/GREEN pattern continued from v2.0: every plan started with failing tests

### What Was Inefficient
- SUMMARY frontmatter `requirements_completed` still not populated for Phases 19-20 (same gap as v1.0-v2.1)
- Some one-liner fields missing from SUMMARY.md files — inconsistent frontmatter across plans
- Latent coupling: retry.ts calls compositeVerifier directly for configOnly path rather than through retryConfig.verifier
- Nyquist validation only partial for all three phases

### Patterns Established
- Generic prompt pattern: `buildGenericPrompt(description, repoPath?)` with conditional CONTEXT block
- Change-type routing: `isConfigFile` helper + `getChangedFilesFromBaseline` for config-vs-code classification
- NOT-scope-creep guidance: explicit entries in judge prompt for mechanical refactoring consequences
- GA API migration pattern: `client.messages.create` with `output_config.format` replacing `client.beta.messages.create`

### Key Lessons
1. Generic execution path with good prompting outperforms per-category handlers (SWE-bench data confirmed)
2. Refactoring verb guard must fire before other regex patterns — ordering matters in fast-path
3. Zero-diff should be a terminal status (no retry) — saves time and API costs
4. Config-only routing needs both basename and full-path checking for patterns like `.github/workflows/*.yml`
5. SUMMARY frontmatter consistency remains the #1 documentation gap — should be enforced by tooling

### Cost Observations
- Model mix: balanced profile (sonnet for execution, haiku for intent parsing + judge)
- Plan execution: 6 plans in 3 days (~0.5 days/plan)
- Notable: Fastest milestone yet by wall-clock time — well-scoped 3-phase structure with clear dependencies

---

## Milestone: v2.3 — Conversational Scoping & REPL Enhancements

**Shipped:** 2026-04-05
**Phases:** 4 | **Plans:** 7 | **Timeline:** 11 days

### What Was Built
- REPL `pr` command for post-hoc PR creation from last completed task
- Conversational scoping dialogue with up to 3 optional pre-execution questions merged into SCOPE block
- Follow-up task referencing via enriched session history (300-char summaries, positional addressing)
- Slack bot adapter via @slack/bolt Socket Mode with Block Kit confirm/cancel and async agent execution
- SessionCallbacks extended with `askQuestion`, `onMessage`, `onPrCreated` for channel-agnostic adapters

### What Worked
- SessionCallbacks optional-method design: Slack adapter cleanly skips scoping dialogue without any special-casing
- Deferred-promise pattern for Slack confirmations: bridges async Bolt event handlers to synchronous session pipeline
- Fire-and-forget IIFE for agent runs in Slack: decouples from Bolt's 3-second ack requirement
- TDD RED/GREEN pattern continued: every plan started with failing tests — zero regressions across 121 new tests
- Phase 21 as single schema extension point: prevented schema divergence across Phases 22-24

### What Was Inefficient
- SUMMARY frontmatter `requirements_completed` still not populated consistently (21-02, 24-01) — persistent gap since v1.0
- Dead code shipped: `buildIntentBlocks` exported/tested but never called in production; `buildStatusMessage` imported but unused
- Slack multi-turn history not populated: `processSlackMention` doesn't call `appendHistory` after agent run
- Nyquist validation still partial for all 4 phases — same gap as v2.0-v2.2
- 11-day timeline (vs 3 days for v2.2) — Phase 24 Slack adapter required deeper research and more complex async patterns

### Patterns Established
- Post-hoc meta-command interception: PR_COMMANDS regex checked before intent parser dispatch in processInput
- Scoping dialogue threading: `scopeHints` array threaded through AgentOptions → PromptOptions → buildGenericPrompt SCOPE HINTS
- History enrichment: `summarize()` utility for 300-char sentence-boundary truncation of agent output
- Slack adapter factory: `createSlackCallbacks(app, threadTs)` returns SessionCallbacks implementation
- Per-thread state isolation: `Map<threadTs, ThreadSession>` prevents cross-user contamination

### Key Lessons
1. Optional callback methods (`askQuestion?`) are the cleanest way to handle feature gaps across adapters — no feature flags needed
2. Deferred-promise pattern bridges event-driven UIs (Slack buttons) to sequential pipelines elegantly
3. Dead code should be caught before merge — `buildIntentBlocks` was designed, tested, but never wired in
4. Slack's 3-second ack constraint fundamentally shapes architecture — fire-and-forget is the only viable pattern for long-running agent tasks
5. SUMMARY frontmatter consistency remains the #1 documentation gap across all milestones — needs tooling enforcement

### Cost Observations
- Model mix: balanced profile (sonnet for execution, haiku for intent parsing + judge)
- Plan execution: 7 plans in 11 days (~1.6 days/plan, slower than v2.2's 0.5 days/plan)
- Notable: Phase 24 (Slack) was the complexity driver — required Bolt SDK research, async patterns, and Block Kit design

---

## Milestone: v2.4 — Git Worktree & Repo Exploration

**Shipped:** 2026-04-07
**Phases:** 3 | **Plans:** 7 | **Timeline:** 3 days

### What Was Built
- `WorktreeManager` class with create/remove/buildWorktreePath/pruneOrphans using Node built-ins (no `simple-git`)
- PID-sentinel-based orphan detection (`{pid, branch}` JSON in `.bg-agent-pid`) with `process.kill(pid, 0)` liveness check
- runAgent() try/finally worktree lifecycle — cleanup on success, failure, veto, zero-diff, cancelled, and throw
- REPL startup `pruneOrphans` scan + post-hoc PR branch support via `lastWorktreeBranch` in ReplState
- Docker `:ro` workspace mount + PreToolUse hook blocking Write/Edit for investigation tasks
- `investigation` task type in intent pipeline — fast-path patterns, action verb guard, LLM parser extension
- `buildExplorationPrompt` with 4-subtype registry (git-strategy, ci-checks, project-structure, general)
- runAgent investigation bypass between Docker and worktree lifecycles — skips orchestrator/verifier/judge/PR
- REPL inline report display + `.reports/<ts>-<subtype>.md` host-side save on "save" keyword
- Slack thread message posting for investigation reports + `createPr` guard
- Tech debt cleared: distinct exit codes (2 vetoed, 3 turn_limit), `SessionTimeoutError` removed, cancelled history fix, configOnly verifier injection, Slack dead code removed, Slack multi-turn history populated

### What Worked
- Phase ordering: tech debt cleanup first (Phase 25) so Phase 26's diff was unambiguously feature-only
- TDD (RED → GREEN per task) enforced across all 7 plans — test suite grew by 102 tests
- Injected verifier pattern in retry.ts removed hot-path coupling to compositeVerifier and made configOnly testable
- Defence-in-depth for read-only: OS-level (`:ro` mount) + SDK-level (PreToolUse hook) — neither layer bypassable
- Action verb guard in explorationFastPath prevented "update X" from being misclassified as exploration
- try/finally worktree cleanup covered every exit path from day one — no cleanup leaks observed
- Host-side `.reports/` write keeps exploration truly read-only even without `:ro` mount (for REPL path)
- Cross-phase integration was clean: 16/16 requirements satisfied, 5/5 integration checks, 6/6 E2E flows on first audit run

### What Was Inefficient
- SUMMARY.md `requirements-completed` frontmatter still sparse despite prior milestone lessons (plans 25-01, 26-02, 27-01, 27-02 had zero REQs listed)
- Nyquist validation partial across all 3 phases (25 missing VALIDATION.md; 26/27 have `nyquist_compliant: false`)
- REPL renders redundant status box after investigation report (cosmetic; easy fix deferred)
- CLI `run` command forgot to forward `explorationSubtype` — REPL/Slack parity gap caught only in audit
- Temp file cleanup: 8 stray docs at repo root (C4-ARCHITECTURE.md, phase-*-code-review.md, etc.) untracked during execution

### Patterns Established
- Sibling worktree path convention: `.bg-agent-<repoBasename>-<suffix>` (git rejects worktrees inside repo)
- PID sentinel: store both `pid` and `branch` so branch cleanup works even if worktree dir was deleted mid-run
- EPERM-as-alive: conservative — we'd rather skip cleanup than delete a live agent's worktree
- Investigation bypass sits between Docker lifecycle and worktree lifecycle — Docker needs `:ro` mount, worktree is irrelevant
- Effective-variable pattern: `effectiveWorkspaceDir` / `effectiveBranchOverride` seam threads worktree state into downstream consumers without wrapper types

### Key Lessons
1. Tech debt cleanup as a dedicated phase before feature work pays off — Phase 26's diff became trivially reviewable
2. Defence in depth for security-critical flags (read-only) means both OS-level and SDK-level enforcement, with either layer sufficient
3. Worktree isolation must cover every exit path; a single missing `finally` branch leaves orphans
4. Audit findings of type `tech_debt` (not `gaps_found`) can ship — the distinction between "broken" and "ugly" matters
5. SUMMARY frontmatter hygiene still drifts despite being a v1.0 lesson — consider tooling to enforce at commit time
6. Exploration-as-read-only-task is a clean orthogonal axis — same pipeline with bypass + `:ro` works without new architecture

### Cost Observations
- Model mix: balanced profile (sonnet for execution, haiku for intent + judge)
- Plan execution: 7 plans in 3 days (~0.43 days/plan — back to v2.2 pace after v2.3's Slack complexity slowdown)
- Notable: Phase 27 was faster than expected because Phase 25's dead code removal + Phase 26's worktree infra left a clean surface

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Timeline | Phases | Plans | Key Change |
|-----------|----------|--------|-------|------------|
| v1.0 | 35 days | 6 | 15 | Initial architecture established |
| v1.1 | 9 days | 3 | 8 | End-state prompting, task types |
| v2.0 | 3 days | 4 | 8 | SDK migration, 1,989 lines deleted |
| v2.1 | 4 days | 4 | 10 | Conversational interface (REPL + intent parser) |
| v2.2 | 3 days | 3 | 6 | Generic task support, verification routing |
| v2.3 | 11 days | 4 | 7 | Scoping dialogue, post-hoc PR, Slack bot |
| v2.4 | 3 days | 3 | 7 | Git worktree isolation, read-only exploration tasks, tech debt cleanup |

### Cumulative Quality

| Milestone | Tests | Test Framework | LOC |
|-----------|-------|----------------|-----|
| v1.0 | 90 | Vitest | 5,460 |
| v1.1 | ~120 | Vitest | ~7,060 |
| v2.0 | 271 | Vitest | 8,167 |
| v2.1 | 513 | Vitest | 13,780 |
| v2.2 | 575 | Vitest | 15,941 |
| v2.3 | 696 | Vitest | 18,121 |
| v2.4 | 798 | Vitest | 20,328 |

### Top Lessons (Verified Across Milestones)

1. Security boundaries should be established in Phase 1 and layered incrementally
2. Deterministic verification beats LLM-based checking for structured output (build errors, test failures)
3. SUMMARY frontmatter `requirements_completed` must be populated during execution, not retrofitted
4. End-state prompting outperforms step-by-step instructions for agent tasks
5. SDK abstractions dramatically reduce per-plan execution time (2.3 → 1.1 → 0.4 → 0.4 → 0.5 → 1.6 days/plan)
6. Channel-agnostic architecture (callback injection) pays off immediately — enables multiple entry points without duplication
7. Generic execution path with scope-fenced prompting outperforms per-category handlers for code change tasks
8. Optional callback methods are the cleanest adapter abstraction — no feature flags, no conditionals, just `?.` invocation
9. Dead code detection should happen before merge, not during milestone audit — exported-but-unused is easy to miss
