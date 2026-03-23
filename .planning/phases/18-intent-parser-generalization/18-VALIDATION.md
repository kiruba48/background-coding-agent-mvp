---
phase: 18
slug: intent-parser-generalization
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-23
---

# Phase 18 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest ^4.0.18 |
| **Config file** | none — vitest auto-discovers |
| **Quick run command** | `npx vitest run src/intent/` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run src/intent/`
- **After every plan wave:** Run `npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 18-01-01 | 01 | 1 | INTENT-01 | unit | `npx vitest run src/intent/types.test.ts` | Yes (update) | ⬜ pending |
| 18-01-02 | 01 | 1 | INTENT-01 | unit | `npx vitest run src/intent/index.test.ts` | Yes (update) | ⬜ pending |
| 18-01-03 | 01 | 1 | INTENT-02 | unit | `npx vitest run src/intent/fast-path.test.ts` | Yes (add cases) | ⬜ pending |
| 18-01-04 | 01 | 1 | INTENT-03 | unit | `npx vitest run src/intent/llm-parser.test.ts` | Yes (update mock) | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements. Files exist and only need updates, not creation.

---

## Manual-Only Verifications

All phase behaviors have automated verification.

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
