---
phase: 8
slug: maven-dependency-update
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-05
---

# Phase 8 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.0.18 |
| **Config file** | package.json (vitest key or script) |
| **Quick run command** | `npx vitest run src/orchestrator/verifier.test.ts src/prompts/maven.test.ts` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run --reporter=verbose`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 08-01-01 | 01 | 1 | MVN-01 | unit | `npx vitest run src/cli/index.test.ts -x` | No - W0 | pending |
| 08-01-02 | 01 | 1 | MVN-02 | unit | `npx vitest run src/prompts/maven.test.ts -x` | No - W0 | pending |
| 08-02-01 | 02 | 1 | MVN-03 | unit | `npx vitest run src/orchestrator/verifier.test.ts -x` | Yes (extend) | pending |
| 08-02-02 | 02 | 1 | MVN-04 | unit | `npx vitest run src/orchestrator/retry.test.ts -x` | Yes (existing covers) | pending |
| 08-03-01 | 03 | 2 | MVN-01..04 | integration | `npx vitest run` | No - W0 | pending |

*Status: pending / green / red / flaky*

---

## Wave 0 Requirements

- [ ] `src/prompts/maven.test.ts` — stubs for MVN-02 (prompt generation)
- [ ] `src/orchestrator/verifier.test.ts` — extend with Maven verifier tests (MVN-03)
- [ ] `src/cli/index.test.ts` — CLI validation tests for --dep/--target-version conditional requirement (MVN-01)

*Existing infrastructure (vitest) covers framework needs. No new test deps required.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| MVN-05 changelog link | MVN-05 | DEFERRED — requires network access | N/A — out of scope this phase |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
