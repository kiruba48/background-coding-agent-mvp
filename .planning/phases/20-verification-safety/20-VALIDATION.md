---
phase: 20
slug: verification-safety
status: complete
nyquist_compliant: true
wave_0_complete: true
created: 2026-03-24
updated: 2026-03-25
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
| 20-01-01 | 01 | 1 | VERIFY-01 | unit | `npx vitest run src/orchestrator/retry.test.ts -t "zero_diff"` | ✅ | ✅ green |
| 20-01-02 | 01 | 1 | VERIFY-01 | unit | `npx vitest run src/cli/commands/run.test.ts -t "zero_diff"` | ✅ | ✅ green |
| 20-01-03 | 01 | 1 | VERIFY-01 | unit | `npx vitest run src/cli/commands/repl.test.ts -t "zero_diff"` | ✅ | ✅ green |
| 20-02-01 | 02 | 1 | VERIFY-02 | unit | `npx vitest run src/orchestrator/retry.test.ts -t "config"` | ✅ | ✅ green |
| 20-02-02 | 02 | 1 | VERIFY-02 | unit | `npx vitest run src/orchestrator/verifier.test.ts -t "configOnly"` | ✅ | ✅ green |
| 20-02-03 | 02 | 1 | VERIFY-02 | unit | `npx vitest run src/orchestrator/verifier.test.ts` | ✅ | ✅ green |
| 20-03-01 | 03 | 1 | VERIFY-03 | unit | `npx vitest run src/orchestrator/judge.test.ts` | ✅ | ✅ green |
| 20-03-02 | 03 | 1 | VERIFY-03 | unit | `npx vitest run src/orchestrator/judge.test.ts -t "refactor"` | ✅ | ✅ green |
| 20-03-03 | 03 | 1 | VERIFY-03 | unit | `npx vitest run src/orchestrator/judge.test.ts` | ✅ | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [x] New test cases in `src/orchestrator/retry.test.ts` — stubs for VERIFY-01 (zero-diff) and VERIFY-02 (config-only routing)
- [x] New test cases in `src/orchestrator/verifier.test.ts` — stubs for VERIFY-02 (configOnly option)
- [x] Updated mock in `src/orchestrator/judge.test.ts` — mock `messages.create` not `beta.messages.create`; new stubs for VERIFY-03 (enriched prompt)
- [x] Test in `src/cli/commands/repl.test.ts` for VERIFY-01 zero_diff display
- [x] Test in `src/cli/commands/run.test.ts` for VERIFY-01 zero_diff exit code

*Existing infrastructure covers framework installation.*

---

## Manual-Only Verifications

*None — all requirements have automated verification.*

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 15s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** complete

---

## Validation Audit 2026-03-25

| Metric | Count |
|--------|-------|
| Gaps found | 2 |
| Resolved | 2 |
| Escalated | 0 |
