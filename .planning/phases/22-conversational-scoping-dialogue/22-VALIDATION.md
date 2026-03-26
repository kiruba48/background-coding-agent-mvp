---
phase: 22
slug: conversational-scoping-dialogue
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-26
---

# Phase 22 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | jest 29.x + ts-jest |
| **Config file** | jest.config.ts |
| **Quick run command** | `npx jest --testPathPattern='scoping\|scope' --no-coverage` |
| **Full suite command** | `npx jest --no-coverage` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx jest --testPathPattern='scoping\|scope' --no-coverage`
- **After every plan wave:** Run `npx jest --no-coverage`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 22-01-01 | 01 | 1 | SCOPE-01 | unit | `npx jest --testPathPattern='scoping' --no-coverage` | ❌ W0 | ⬜ pending |
| 22-01-02 | 01 | 1 | SCOPE-02 | unit | `npx jest --testPathPattern='scoping' --no-coverage` | ❌ W0 | ⬜ pending |
| 22-01-03 | 01 | 1 | SCOPE-04 | unit | `npx jest --testPathPattern='scoping' --no-coverage` | ❌ W0 | ⬜ pending |
| 22-01-04 | 01 | 1 | SCOPE-05 | unit | `npx jest --testPathPattern='scoping' --no-coverage` | ❌ W0 | ⬜ pending |
| 22-02-01 | 02 | 2 | SCOPE-03 | integration | `npx jest --testPathPattern='scope' --no-coverage` | ❌ W0 | ⬜ pending |
| 22-02-02 | 02 | 2 | SCOPE-03 | manual | N/A | N/A | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/scoping-dialogue.test.ts` — stubs for SCOPE-01, SCOPE-02, SCOPE-04, SCOPE-05
- [ ] `tests/scope-display.test.ts` — stubs for SCOPE-03

*Existing jest infrastructure covers framework needs. Only test files need creation.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| SCOPE block visible at confirm step in REPL | SCOPE-03 | Requires visual terminal inspection | 1. Run REPL 2. Enter generic task 3. Answer scoping questions 4. Verify SCOPE block appears before confirm |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
