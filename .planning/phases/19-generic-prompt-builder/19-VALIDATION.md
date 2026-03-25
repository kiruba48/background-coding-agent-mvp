---
phase: 19
slug: generic-prompt-builder
status: complete
nyquist_compliant: true
wave_0_complete: true
created: 2026-03-24
audited: 2026-03-25
---

# Phase 19 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest ^1.x |
| **Config file** | vitest.config.ts |
| **Quick run command** | `npm test` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npm test`
- **After every plan wave:** Run `npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 19-01-01 | 01 | 1 | PROMPT-01, PROMPT-02 | unit | `npm test -- src/prompts/generic.test.ts` | ✅ | ✅ green |
| 19-01-02 | 01 | 1 | PROMPT-01 | unit | `npm test -- src/prompts/generic.test.ts` | ✅ | ✅ green |
| 19-01-03 | 01 | 1 | PROMPT-01 | unit | `npm test -- src/prompts/npm.test.ts src/prompts/maven.test.ts` | ✅ | ✅ green |
| 19-01-04 | 01 | 1 | PROMPT-03 | unit | `npm test -- src/intent/confirm-loop.test.ts` | ✅ | ✅ green |
| 19-01-05 | 01 | 1 | PROMPT-03 | unit | `npm test -- src/orchestrator/pr-creator.test.ts` | ✅ | ✅ green |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements.

- [x] `src/prompts/generic.test.ts` — stubs for PROMPT-01, PROMPT-02 (buildGenericPrompt unit tests) — 12 tests
- [x] `src/agent/index.test.ts` mock update — `mockReturnValue` → `mockResolvedValue` (async buildPrompt)
- [x] `src/prompts/npm.test.ts` + `src/prompts/maven.test.ts` — add `await` to buildPrompt calls

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Retry preserves same prompt | PROMPT-02 | Requires multi-session flow | Run generic task, fail it, verify retry uses same prompt string |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 15s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-03-25

---

## Validation Audit 2026-03-25

| Metric | Count |
|--------|-------|
| Gaps found | 0 |
| Resolved | 0 |
| Escalated | 0 |

**Test suite:** 573 tests, 0 failures, 25 test files.
**Requirements covered:** PROMPT-01 (12 tests), PROMPT-02 (4 tests), PROMPT-03 (15 tests).
