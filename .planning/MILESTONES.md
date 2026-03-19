# Milestones

## v2.0 Claude Agent SDK Migration (Shipped: 2026-03-19)

**Phases completed:** 4 phases (10-13), 8 plans, ~14 tasks
**Timeline:** 3 days (2026-03-16 → 2026-03-19)
**LOC:** 8,167 TypeScript | **Commits:** ~30 | **Tests:** 271 unit tests

**Key accomplishments:**
- Replaced custom agent loop with Claude Agent SDK `query()` — ClaudeCodeSession with PreToolUse security hooks and PostToolUse audit logging
- Deleted 1,989 lines of legacy infrastructure (AgentSession, AgentClient, ContainerManager) — SDK is the sole agent runtime
- Built in-process MCP verifier server enabling agent mid-session self-correction without consuming outer retries
- Multi-stage Alpine Docker container with iptables network isolation, non-root execution (UID 1001), and Claude Code CLI 2.1.79
- All 22 requirements satisfied, 271 tests passing, zero legacy references remaining

**Known gaps (accepted as tech debt):**
- SUMMARY frontmatter `requirements_completed` missing for DEL-01..04, CTR-01..04 (documentation gap, not code gap)
- Human verification pending: network isolation runtime enforcement (iptables in live Docker)
- Nyquist validation drafts exist but not fully compliant for phases 10-13

**Archives:** [v2.0-ROADMAP.md](milestones/v2.0-ROADMAP.md) | [v2.0-REQUIREMENTS.md](milestones/v2.0-REQUIREMENTS.md) | [v2.0-MILESTONE-AUDIT.md](milestones/v2.0-MILESTONE-AUDIT.md)

---

## v1.0 Foundation (Shipped: 2026-03-02)

**Phases completed:** 6 phases, 15 plans
**Timeline:** 35 days (2026-01-25 → 2026-02-28)
**LOC:** 5,460 TypeScript | **Commits:** 84 | **Tests:** 90 unit tests

**Key accomplishments:**
- Secure Docker container isolation (non-root user, network-none, read-only rootfs)
- CLI-driven orchestration with turn limits, timeouts, and structured JSON logging
- Safe agent tool access (file read/edit, Git, grep, bash allowlist) with path traversal protection
- Intelligent retry loop with error summarization (max 3 retries, 2000-char digest cap)
- Deterministic verification pipeline (build + test + lint composite verifier)
- LLM Judge with scope-creep detection, veto power, and fail-open semantics

**Known gaps (accepted as tech debt):**
- CLI-05 partial: cost per run metric not tracked
- Exit code switch lacks explicit `case 'vetoed'` and `case 'turn_limit'`
- Documentation uses stale field name `maxJudgeRetries` (code uses `maxJudgeVetoes`)
- `SessionTimeoutError` dead code in `src/errors.ts`

**Archives:** [v1.0-ROADMAP.md](milestones/v1.0-ROADMAP.md) | [v1.0-REQUIREMENTS.md](milestones/v1.0-REQUIREMENTS.md) | [v1.0-MILESTONE-AUDIT.md](milestones/v1.0-MILESTONE-AUDIT.md)

---

## v1.1 End-to-End Pipeline (Shipped: 2026-03-11)

**Phases completed:** 3 phases, 8 plans
**Timeline:** 9 days (2026-03-02 → 2026-03-11)
**LOC added:** ~1,600 TypeScript | **Tests added:** ~30

**Key accomplishments:**
- GitHub PR creation with Octokit (branch, push, PR with rich description)
- Maven dependency update task type with end-state prompting
- npm dependency update task type with shared verifier architecture
- Host-side npm install preVerify hook for lockfile regeneration
- Prompt module decoupled from CLI types (extensible to new task types)

**Known gaps (accepted as tech debt):**
- MVN-05 (changelog links) deferred — Docker has no network access
- NPM-05 (changelog links) deferred — same reason
- v1.1 milestone audit not formally run

---

