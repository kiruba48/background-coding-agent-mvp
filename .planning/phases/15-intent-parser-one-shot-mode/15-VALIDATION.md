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
| **Framework** | Vitest 4.0.18 |
| **Config file** | vitest.config.ts |
| **Quick run command** | `npx vitest run src/intent/` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run src/intent/`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 15-01-01 | 01 | 1 | INTENT-01 | unit | `npx vitest run src/intent/types.test.ts` | ❌ W0 | ⬜ pending |
| 15-01-02 | 01 | 1 | INTENT-02 | unit | `npx vitest run src/intent/fast-path.test.ts` | ❌ W0 | ⬜ pending |
| 15-01-03 | 01 | 1 | INTENT-03 | unit | `npx vitest run src/intent/context-scanner.test.ts` | ❌ W0 | ⬜ pending |
| 15-02-01 | 02 | 2 | INTENT-01,INTENT-03 | unit | `npx vitest run src/intent/llm-parser.test.ts` | ❌ W0 | ⬜ pending |
| 15-02-02 | 02 | 2 | CLI-03 | unit | `npx vitest run src/intent/confirm-loop.test.ts` | ❌ W0 | ⬜ pending |
| 15-03-01 | 03 | 3 | INTENT-01,INTENT-02 | unit | `npx vitest run src/intent/index.test.ts` | ❌ W0 | ⬜ pending |
| 15-03-02 | 03 | 3 | CLI-01,CLI-03 | integration | `npx vitest run src/intent/one-shot.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/intent/types.test.ts` — stubs for INTENT-01 (intent types and schemas)
- [ ] `src/intent/fast-path.test.ts` — stubs for INTENT-02 (obvious pattern resolution without LLM)
- [ ] `src/intent/context-scanner.test.ts` — stubs for INTENT-03 (manifest reading for context)
- [ ] `src/intent/llm-parser.test.ts` — stubs for INTENT-01/03 (LLM-based parsing)
- [ ] `src/intent/confirm-loop.test.ts` — stubs for CLI-03 (confirm/redirect flow)
- [ ] `src/intent/index.test.ts` — stubs for coordinator
- [ ] `src/intent/one-shot.test.ts` — stubs for CLI-01 (one-shot command handler)

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
