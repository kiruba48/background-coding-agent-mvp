---
phase: 14
slug: infrastructure-foundation
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-19
---

# Phase 14 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 3.x |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `npx vitest run --reporter=verbose` |
| **Full suite command** | `npx vitest run --reporter=verbose` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run --reporter=verbose`
- **After every plan wave:** Run `npx vitest run --reporter=verbose`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 14-01-01 | 01 | 1 | INFRA-01 | unit | `npx vitest run src/agent/index.test.ts` | ❌ W0 | ⬜ pending |
| 14-01-02 | 01 | 1 | INFRA-01 | unit | `npx vitest run src/cli/commands/run.test.ts` | ❌ W0 | ⬜ pending |
| 14-02-01 | 02 | 1 | INFRA-02 | unit | `npx vitest run src/agent/index.test.ts` | ❌ W0 | ⬜ pending |
| 14-02-02 | 02 | 1 | INFRA-02 | unit | `npx vitest run src/orchestrator/claude-code-session.test.ts` | ❌ W0 | ⬜ pending |
| 14-03-01 | 03 | 2 | REG-01 | unit | `npx vitest run src/agent/registry.test.ts` | ❌ W0 | ⬜ pending |
| 14-03-02 | 03 | 2 | REG-01 | unit | `npx vitest run src/cli/commands/projects.test.ts` | ❌ W0 | ⬜ pending |
| 14-04-01 | 04 | 2 | REG-02 | unit | `npx vitest run src/cli/auto-register.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/agent/index.test.ts` — stubs for INFRA-01 (runAgent importable + returns RetryResult)
- [ ] `src/cli/commands/run.test.ts` — stubs for INFRA-01 (CLI adapter delegates to runAgent)
- [ ] `src/orchestrator/claude-code-session.test.ts` — stubs for INFRA-02 (AbortSignal threading)
- [ ] `src/agent/registry.test.ts` — stubs for REG-01 (register/resolve/remove/list)
- [ ] `src/cli/commands/projects.test.ts` — stubs for REG-01 (Commander subcommands)
- [ ] `src/cli/auto-register.test.ts` — stubs for REG-02 (auto-registration on .git/manifest detection)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| AbortSignal + Docker kill cleanup | INFRA-02 | Requires running Docker container | Start a long task, send SIGINT, verify container stops within 5s and workspace resets |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
