---
phase: 23
slug: follow-up-task-referencing
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-01
---

# Phase 23 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest ^4.0.18 |
| **Config file** | vitest.config.ts (project root) |
| **Quick run command** | `npx vitest run src/repl/session.test.ts src/intent/llm-parser.test.ts` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run src/repl/session.test.ts src/intent/llm-parser.test.ts`
- **After every plan wave:** Run `npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 23-01-01 | 01 | 1 | FLLW-03 | unit | `npx vitest run src/repl/session.test.ts` | ✅ extend | ⬜ pending |
| 23-01-02 | 01 | 1 | FLLW-03 | unit | `npx vitest run src/repl/session.test.ts` | ✅ extend | ⬜ pending |
| 23-01-03 | 01 | 1 | FLLW-03 | unit | `npx vitest run src/intent/llm-parser.test.ts` | ✅ extend | ⬜ pending |
| 23-01-04 | 01 | 1 | FLLW-03 | unit | `npx vitest run src/intent/llm-parser.test.ts` | ✅ extend | ⬜ pending |
| 23-01-05 | 01 | 1 | FLLW-03 | unit | `npx vitest run src/intent/llm-parser.test.ts` | ❌ new | ⬜ pending |
| 23-01-06 | 01 | 1 | FLLW-03 | unit | `npx vitest run src/intent/llm-parser.test.ts` | ✅ extend | ⬜ pending |
| 23-01-07 | 01 | 1 | FLLW-03 | unit | `npx vitest run src/intent/llm-parser.test.ts` | ✅ extend | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

*Existing infrastructure covers all phase requirements. Only test extensions and new test cases needed within existing test files.*

---

## Manual-Only Verifications

*All phase behaviors have automated verification.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
