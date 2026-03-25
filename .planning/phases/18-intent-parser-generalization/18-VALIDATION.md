---
phase: 18
slug: intent-parser-generalization
status: complete
nyquist_compliant: true
wave_0_complete: true
created: 2026-03-23
audited: 2026-03-25
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
| 18-01-01 | 01 | 1 | INTENT-02 | unit | `npx vitest run src/intent/fast-path.test.ts` | Yes | ✅ green |
| 18-01-02 | 01 | 1 | INTENT-03 | unit | `npx tsc --noEmit` | Yes | ✅ green |
| 18-02-01 | 02 | 2 | INTENT-01 | unit | `npx vitest run src/intent/types.test.ts src/intent/index.test.ts` | Yes | ✅ green |
| 18-02-02 | 02 | 2 | INTENT-03 | unit | `npx vitest run src/intent/llm-parser.test.ts` | Yes | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Requirement-to-Test Cross-Reference

| Requirement | Test File(s) | Key Assertions | Status |
|-------------|-------------|----------------|--------|
| INTENT-01 | `types.test.ts:37`, `types.test.ts:68`, `index.test.ts:187` | generic accepted, unknown rejected, generic passthrough with description+taskCategory | COVERED |
| INTENT-02 | `fast-path.test.ts:266-311` | 10 test cases: 6 verbs blocked, case insensitive, PR suffix, 2 regression guards for dep verbs | COVERED |
| INTENT-03 | `llm-parser.test.ts:61`, `llm-parser.test.ts:69` | messages.create called (not beta), betas undefined, output_config present | COVERED |

**Test count:** 132 tests across 6 files, all passing.

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements. Files exist and only need updates, not creation.

---

## Manual-Only Verifications

All phase behaviors have automated verification.

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
| Gaps found | 0 |
| Resolved | 0 |
| Escalated | 0 |
