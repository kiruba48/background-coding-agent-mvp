---
phase: 17
slug: multi-turn-session-context
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-22
---

# Phase 17 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest ^4.0.18 |
| **Config file** | vitest.config.ts |
| **Quick run command** | `npx vitest run src/repl/session.test.ts src/intent/fast-path.test.ts src/intent/index.test.ts src/intent/llm-parser.test.ts src/intent/confirm-loop.test.ts` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run src/repl/session.test.ts src/intent/fast-path.test.ts`
- **After every plan wave:** Run `npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 17-01-01 | 01 | 1 | SESS-01 | unit | `npx vitest run src/repl/session.test.ts` | ✅ (needs new cases) | ⬜ pending |
| 17-01-02 | 01 | 1 | SESS-01 | unit | `npx vitest run src/intent/fast-path.test.ts` | ✅ (needs new cases) | ⬜ pending |
| 17-01-03 | 01 | 1 | SESS-01 | unit | `npx vitest run src/intent/llm-parser.test.ts` | ✅ (needs new cases) | ⬜ pending |
| 17-01-04 | 01 | 1 | SESS-01 | unit | `npx vitest run src/intent/confirm-loop.test.ts` | ✅ (needs new cases) | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements. New test cases are additions to existing test files, not new files.

*"Existing infrastructure covers all phase requirements."*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Follow-up UX feels natural in real REPL | SESS-01 | Subjective experience | Run REPL, do "update lodash in myrepo", then "also do express" — verify context inherited |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
