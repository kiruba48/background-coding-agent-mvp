---
phase: 26
slug: git-worktree-isolation
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-05
---

# Phase 26 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.0.18 |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `npx vitest run src/agent/worktree-manager.test.ts src/agent/index.test.ts` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~2 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run src/agent/worktree-manager.test.ts src/agent/index.test.ts`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 5 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 26-01-01 | 01 | 0 | WKTREE-01 | unit | `npx vitest run src/agent/worktree-manager.test.ts` | Wave 0 | ⬜ pending |
| 26-01-02 | 01 | 0 | WKTREE-03 | unit | `npx vitest run src/agent/worktree-manager.test.ts` | Wave 0 | ⬜ pending |
| 26-01-03 | 01 | 0 | WKTREE-04 | unit | `npx vitest run src/agent/worktree-manager.test.ts` | Wave 0 | ⬜ pending |
| 26-02-01 | 02 | 1 | WKTREE-02 | unit | `npx vitest run src/agent/index.test.ts` | Exists (new tests) | ⬜ pending |
| 26-02-02 | 02 | 1 | WKTREE-03 | unit | `npx vitest run src/agent/index.test.ts` | Exists (new tests) | ⬜ pending |
| 26-02-03 | 02 | 1 | WKTREE-05 | unit | `npx vitest run src/agent/index.test.ts` | Exists (new tests) | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/agent/worktree-manager.test.ts` — stubs for WKTREE-01 (create, buildPath, PID write), WKTREE-03 (remove), WKTREE-04 (pruneOrphans)
- [ ] New test cases in `src/agent/index.test.ts` — stubs for WKTREE-02 (workspaceDir swap), WKTREE-03 (finally cleanup), WKTREE-05 (branchOverride passthrough)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Two concurrent sessions create separate worktrees | WKTREE-01 | Requires two processes running simultaneously | Start two REPL sessions on same repo, verify separate worktree dirs created |
| Crash recovery prunes orphaned worktrees | WKTREE-04 | Requires simulating process crash (kill -9) | Create worktree, kill process, restart REPL, verify orphan pruned |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 5s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
