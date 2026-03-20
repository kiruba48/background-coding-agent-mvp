---
phase: 15
slug: intent-parser-one-shot-mode
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-20
---

# Phase 15 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | jest 29.x + ts-jest |
| **Config file** | jest.config.ts |
| **Quick run command** | `npx jest --testPathPattern intent` |
| **Full suite command** | `npx jest` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx jest --testPathPattern intent`
- **After every plan wave:** Run `npx jest`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 15-01-01 | 01 | 0 | INTENT-01 | unit | `npx jest --testPathPattern intent/parser` | ❌ W0 | ⬜ pending |
| 15-01-02 | 01 | 1 | INTENT-02 | unit | `npx jest --testPathPattern intent/fast-path` | ❌ W0 | ⬜ pending |
| 15-01-03 | 01 | 1 | INTENT-03 | unit | `npx jest --testPathPattern intent/clarifier` | ❌ W0 | ⬜ pending |
| 15-02-01 | 02 | 2 | CLI-01 | unit | `npx jest --testPathPattern intent/one-shot` | ❌ W0 | ⬜ pending |
| 15-02-02 | 02 | 2 | CLI-03 | integration | `npx jest --testPathPattern intent/confirm` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/intent/parser.test.ts` — stubs for INTENT-01 (natural language → structured intent)
- [ ] `tests/intent/fast-path.test.ts` — stubs for INTENT-02 (obvious pattern resolution without LLM)
- [ ] `tests/intent/clarifier.test.ts` — stubs for INTENT-03 (ambiguous input clarification)
- [ ] `tests/intent/one-shot.test.ts` — stubs for CLI-01 (one-shot command handler)
- [ ] `tests/intent/confirm.test.ts` — stubs for CLI-03 (confirm/redirect flow)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Readline confirm prompt UX | CLI-03 | Interactive TTY required | Run `bg-agent 'update recharts'`, verify confirm prompt appears, type 'y' to proceed |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
