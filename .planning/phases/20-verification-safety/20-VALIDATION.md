---
phase: 20
slug: verification-safety
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-24
---

# Phase 20 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 2.x |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `npx vitest run src/orchestrator/ --reporter=verbose` |
| **Full suite command** | `npx vitest run --reporter=verbose` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run src/orchestrator/ --reporter=verbose`
- **After every plan wave:** Run `npx vitest run --reporter=verbose`
- **Before `/gsd:verify-work`:** Full suite must be green (556+ tests)
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 20-01-01 | 01 | 1 | VERIFY-01 | unit | `npx vitest run src/orchestrator/retry.test.ts -t "zero_diff"` | ✅ | ⬜ pending |
| 20-01-02 | 01 | 1 | VERIFY-01 | unit | `npx vitest run src/orchestrator/retry.test.ts` | ✅ | ⬜ pending |
| 20-01-03 | 01 | 1 | VERIFY-01 | unit | `npx vitest run src/cli/commands/repl.test.ts` | ❌ W0 | ⬜ pending |
| 20-02-01 | 02 | 1 | VERIFY-02 | unit | `npx vitest run src/orchestrator/retry.test.ts -t "config"` | ✅ | ⬜ pending |
| 20-02-02 | 02 | 1 | VERIFY-02 | unit | `npx vitest run src/orchestrator/verifier.test.ts -t "configOnly"` | ✅ | ⬜ pending |
| 20-02-03 | 02 | 1 | VERIFY-02 | unit | `npx vitest run src/orchestrator/verifier.test.ts` | ✅ | ⬜ pending |
| 20-03-01 | 03 | 1 | VERIFY-03 | unit | `npx vitest run src/orchestrator/judge.test.ts` | ✅ | ⬜ pending |
| 20-03-02 | 03 | 1 | VERIFY-03 | unit | `npx vitest run src/orchestrator/judge.test.ts -t "refactor"` | ✅ | ⬜ pending |
| 20-03-03 | 03 | 1 | VERIFY-03 | unit | `npx vitest run src/orchestrator/judge.test.ts` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] New test cases in `src/orchestrator/retry.test.ts` — stubs for VERIFY-01 (zero-diff) and VERIFY-02 (config-only routing)
- [ ] New test cases in `src/orchestrator/verifier.test.ts` — stubs for VERIFY-02 (configOnly option)
- [ ] Updated mock in `src/orchestrator/judge.test.ts` — mock `messages.create` not `beta.messages.create`; new stubs for VERIFY-03 (enriched prompt)
- [ ] Check `src/cli/commands/repl.test.ts` existence for VERIFY-01 display test

*Existing infrastructure covers framework installation.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| REPL displays zero_diff message | VERIFY-01 | Visual output format | Run REPL, submit no-op task, verify message shown |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
