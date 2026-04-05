---
phase: 21
slug: post-hoc-pr-state-foundation
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-25
---

# Phase 21 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest |
| **Config file** | vitest.config.ts |
| **Quick run command** | `npx vitest run src/repl/session.test.ts` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run src/repl/session.test.ts`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 21-01-01 | 01 | 1 | FLLW-01, FLLW-02 | unit | `npx vitest run src/repl/session.test.ts` | ✅ | ⬜ pending |
| 21-01-02 | 01 | 1 | PR-04 | unit | `npx vitest run src/repl/session.test.ts` | ✅ | ⬜ pending |
| 21-02-01 | 02 | 2 | PR-01 | unit | `npx vitest run src/repl/session.test.ts` | ✅ | ⬜ pending |
| 21-02-02 | 02 | 2 | PR-02 | unit | `npx vitest run src/repl/session.test.ts` | ✅ | ⬜ pending |
| 21-02-03 | 02 | 2 | PR-03 | unit | `npx vitest run src/repl/session.test.ts` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements. `src/repl/session.test.ts` already has full mock infrastructure for `runAgent`, `parseIntent`, and `ProjectRegistry`. Only a new `vi.mock` for `GitHubPRCreator` is needed (added in Plan 21-02).

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| PR confirmation line displayed before creation | PR-03 | Display output verification | Type `pr` after successful task, verify "Creating PR for: [desc] ([project])" appears before URL |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
