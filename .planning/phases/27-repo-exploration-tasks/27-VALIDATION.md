---
phase: 27
slug: repo-exploration-tasks
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-06
---

# Phase 27 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest |
| **Config file** | vitest.config.ts |
| **Quick run command** | `npx vitest run src/intent/fast-path.test.ts src/prompts/exploration.test.ts` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run src/intent/fast-path.test.ts src/prompts/exploration.test.ts`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 27-01-01 | 01 | 1 | EXPLR-01 | unit | `npx vitest run src/intent/fast-path.test.ts` | ❌ W0 | ⬜ pending |
| 27-01-02 | 01 | 1 | EXPLR-01 | unit | `npx vitest run src/intent/index.test.ts` | ✅ | ⬜ pending |
| 27-02-01 | 02 | 1 | EXPLR-02 | unit | `npx vitest run src/prompts/exploration.test.ts` | ❌ W0 | ⬜ pending |
| 27-02-02 | 02 | 1 | EXPLR-02 | unit | `npx vitest run src/prompts/index.test.ts` | ❌ W0 | ⬜ pending |
| 27-03-01 | 03 | 2 | EXPLR-03 | unit | `npx vitest run src/agent/index.test.ts` | ✅ | ⬜ pending |
| 27-03-02 | 03 | 2 | EXPLR-04 | unit | `npx vitest run src/orchestrator/claude-code-session.test.ts` | ✅ | ⬜ pending |
| 27-03-03 | 03 | 2 | EXPLR-04 | unit | `npx vitest run src/cli/docker/index.test.ts` | ✅ | ⬜ pending |
| 27-04-01 | 04 | 3 | EXPLR-05 | unit | `npx vitest run src/repl/session.test.ts` | ✅ | ⬜ pending |
| 27-04-02 | 04 | 3 | EXPLR-05 | unit | `npx vitest run src/slack/adapter.test.ts` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/intent/fast-path.test.ts` — add `explorationFastPath()` describe block with test cases for all subtypes + action verb guard
- [ ] `src/prompts/exploration.test.ts` — new file, covers `buildExplorationPrompt()` for all 4 subtypes
- [ ] `src/prompts/index.test.ts` — add investigation dispatch case

*Existing test files (agent/index.test.ts, claude-code-session.test.ts, docker/index.test.ts, repl/session.test.ts, slack/adapter.test.ts) already exist — add cases inline.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Docker `:ro` mount actually blocks writes | EXPLR-04 | Requires running Docker container | Run `docker run` with `:ro` mount, attempt `touch /workspace/test` — should fail |
| Full exploration flow produces readable report | EXPLR-05 | End-to-end integration | Run REPL, type "explore the branching strategy", verify markdown report output |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
