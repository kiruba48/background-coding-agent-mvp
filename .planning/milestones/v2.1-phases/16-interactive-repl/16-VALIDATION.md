---
phase: 16
slug: interactive-repl
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-20
---

# Phase 16 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest ^4.0.18 |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `npx vitest run src/repl/ src/cli/commands/repl.test.ts` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run src/repl/ src/cli/commands/repl.test.ts`
- **After every plan wave:** Run `npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 16-01-01 | 01 | 1 | CLI-02 | unit | `npx vitest run src/cli/commands/repl.test.ts` | ❌ W0 | ⬜ pending |
| 16-01-02 | 01 | 1 | CLI-02 | unit | `npx vitest run src/repl/session.test.ts` | ❌ W0 | ⬜ pending |
| 16-01-03 | 01 | 1 | CLI-02 | unit (mock rl SIGINT) | `npx vitest run src/cli/commands/repl.test.ts` | ❌ W0 | ⬜ pending |
| 16-01-04 | 01 | 1 | CLI-02 | unit (mock runAgent) | `npx vitest run src/cli/commands/repl.test.ts` | ❌ W0 | ⬜ pending |
| 16-01-05 | 01 | 1 | CLI-02 | unit | `npx vitest run src/repl/session.test.ts` | ❌ W0 | ⬜ pending |
| 16-01-06 | 01 | 1 | CLI-02 | unit (mock runAgent + docker) | `npx vitest run src/repl/session.test.ts` | ❌ W0 | ⬜ pending |
| 16-01-07 | 01 | 1 | CLI-02 | unit (mock fs) | `npx vitest run src/cli/commands/repl.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/repl/session.ts` — session core module (new file)
- [ ] `src/repl/session.test.ts` — unit tests for session core
- [ ] `src/repl/types.ts` — SessionInput, SessionResult types
- [ ] `src/cli/commands/repl.ts` — CLI adapter (new file)
- [ ] `src/cli/commands/repl.test.ts` — unit tests for CLI adapter

*Existing infrastructure: vitest.config.ts, vi.mock patterns for readline and runAgent — all established*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Double Ctrl+C force-kills Docker container | CLI-02 | Requires real Docker container + timing | 1. Start REPL, run a task 2. Press Ctrl+C twice rapidly 3. Verify container killed immediately |
| History persists across sessions | CLI-02 | Requires actual file I/O across process boundaries | 1. Start REPL, run a task 2. Exit 3. Restart REPL 4. Press Up arrow, verify history |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
