---
phase: 11
slug: legacy-deletion
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-17
---

# Phase 11 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest ^4.0.18 |
| **Config file** | none — default discovery (dist/ exclusion addressed in phase) |
| **Quick run command** | `npx vitest run src/orchestrator/retry.test.ts src/orchestrator/judge.test.ts src/orchestrator/claude-code-session.test.ts` |
| **Full suite command** | `npm test` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run src/orchestrator/retry.test.ts src/orchestrator/judge.test.ts src/orchestrator/claude-code-session.test.ts`
- **After every plan wave:** Run `npm test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 11-01-01 | 01 | 1 | DEL-02 | compile | `npx tsc --noEmit` | N/A (type migration) | ⬜ pending |
| 11-01-02 | 01 | 1 | DEL-01, DEL-02, DEL-03 | compile | `npx tsc --noEmit` | N/A (deletion) | ⬜ pending |
| 11-01-03 | 01 | 1 | DEL-05 | unit | `npx vitest run src/orchestrator/retry.test.ts src/orchestrator/judge.test.ts` | ✅ | ⬜ pending |
| 11-01-04 | 01 | 1 | DEL-04 | manual | `grep dockerode package.json` | N/A (removal) | ⬜ pending |
| 11-01-05 | 01 | 1 | DEL-05 | unit | `npm test` | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| dockerode absent from package.json | DEL-04 | No test — verify by grep | `grep dockerode package.json` should return empty |
| Legacy files no longer exist | DEL-01, DEL-02, DEL-03 | File existence check | `ls src/orchestrator/agent.ts src/orchestrator/session.ts src/orchestrator/container.ts` should all fail |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
