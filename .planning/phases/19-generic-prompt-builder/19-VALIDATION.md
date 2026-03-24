---
phase: 19
slug: generic-prompt-builder
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-24
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
| 19-01-01 | 01 | 1 | PROMPT-01, PROMPT-02 | unit | `npm test -- src/prompts/generic.test.ts` | ❌ W0 | ⬜ pending |
| 19-01-02 | 01 | 1 | PROMPT-01 | unit | `npm test -- src/prompts/generic.test.ts` | ❌ W0 | ⬜ pending |
| 19-01-03 | 01 | 1 | PROMPT-01 | unit | `npm test -- src/prompts/index.test.ts` | ✅ (edit) | ⬜ pending |
| 19-01-04 | 01 | 1 | PROMPT-03 | unit | `npm test -- src/intent/confirm-loop.test.ts` | ✅ (extend) | ⬜ pending |
| 19-01-05 | 01 | 1 | PROMPT-03 | unit | `npm test -- src/intent/confirm-loop.test.ts` | ✅ (extend) | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/prompts/generic.test.ts` — stubs for PROMPT-01, PROMPT-02 (buildGenericPrompt unit tests)
- [ ] `src/agent/index.test.ts` mock update — `mockReturnValue` → `mockResolvedValue` (async buildPrompt)
- [ ] `src/prompts/npm.test.ts` + `src/prompts/maven.test.ts` — add `await` to buildPrompt calls

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Retry preserves same prompt | PROMPT-02 | Requires multi-session flow | Run generic task, fail it, verify retry uses same prompt string |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
