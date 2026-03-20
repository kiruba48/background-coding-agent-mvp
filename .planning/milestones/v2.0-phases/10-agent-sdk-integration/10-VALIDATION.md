---
phase: 10
slug: agent-sdk-integration
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-17
---

# Phase 10 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest ^4.0.18 |
| **Config file** | none — uses package.json test script |
| **Quick run command** | `npx vitest run src/orchestrator/claude-code-session.test.ts` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run src/orchestrator/claude-code-session.test.ts`
- **After every plan wave:** Run `npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 10-01-01 | 01 | 1 | SDK-01 | unit | `npx vitest run src/orchestrator/claude-code-session.test.ts` | ❌ W0 | ⬜ pending |
| 10-01-02 | 01 | 1 | SDK-02 | unit | `npx vitest run src/orchestrator/claude-code-session.test.ts` | ❌ W0 | ⬜ pending |
| 10-01-03 | 01 | 1 | SDK-03 | unit | `npx vitest run src/orchestrator/claude-code-session.test.ts` | ❌ W0 | ⬜ pending |
| 10-01-04 | 01 | 1 | SDK-04 | unit | `npx vitest run src/orchestrator/claude-code-session.test.ts` | ❌ W0 | ⬜ pending |
| 10-01-05 | 01 | 1 | SDK-05 | unit | `npx vitest run src/orchestrator/claude-code-session.test.ts` | ❌ W0 | ⬜ pending |
| 10-01-06 | 01 | 1 | SDK-06 | unit | `npx vitest run src/orchestrator/claude-code-session.test.ts` | ❌ W0 | ⬜ pending |
| 10-01-07 | 01 | 1 | SDK-07 | unit | `npx vitest run src/orchestrator/claude-code-session.test.ts` | ❌ W0 | ⬜ pending |
| 10-01-08 | 01 | 1 | SDK-08 | unit | `npx vitest run src/orchestrator/claude-code-session.test.ts` | ❌ W0 | ⬜ pending |
| 10-01-09 | 01 | 1 | SDK-09 | unit | `npx vitest run src/orchestrator/claude-code-session.test.ts` | ❌ W0 | ⬜ pending |
| 10-01-10 | 01 | 1 | SDK-10 | unit | `npx vitest run src/orchestrator/claude-code-session.test.ts` | ❌ W0 | ⬜ pending |
| 10-02-01 | 02 | 1 | SDK-01 | unit | `npx vitest run src/orchestrator/retry.test.ts` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/orchestrator/claude-code-session.test.ts` — stubs for SDK-01 through SDK-10
- [ ] `src/orchestrator/claude-code-session.ts` — ClaudeCodeSession implementation file

*Existing tests in `src/orchestrator/retry.test.ts` must remain green throughout.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| End-to-end SDK query() with real API | SDK-01 | Requires ANTHROPIC_API_KEY and live API | Run `node dist/cli/index.js run --task-type maven-dependency-update` against a test repo |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
