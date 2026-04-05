---
phase: 24
slug: slack-bot-adapter
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-04-01
---

# Phase 24 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.x (existing) |
| **Config file** | none — vitest auto-discovers `*.test.ts` files |
| **Quick run command** | `npx vitest run src/slack/` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run src/slack/`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 24-01-01 | 01 | 1 | SLCK-01 | unit | `npx vitest run src/slack/index.test.ts` | ❌ W0 | ⬜ pending |
| 24-01-02 | 01 | 1 | SLCK-02 | unit | `npx vitest run src/slack/adapter.test.ts` | ❌ W0 | ⬜ pending |
| 24-02-01 | 02 | 1 | SLCK-03 | unit | `npx vitest run src/slack/blocks.test.ts` | ❌ W0 | ⬜ pending |
| 24-02-02 | 02 | 1 | SLCK-04 | unit | `npx vitest run src/slack/adapter.test.ts` | ❌ W0 | ⬜ pending |
| 24-02-03 | 02 | 1 | SLCK-05 | unit | `npx vitest run src/slack/adapter.test.ts` | ❌ W0 | ⬜ pending |
| 24-02-04 | 02 | 1 | SLCK-06 | unit | `npx vitest run src/slack/adapter.test.ts` | ❌ W0 | ⬜ pending |
| 24-02-05 | 02 | 1 | SLCK-07 | unit | `npx vitest run src/slack/adapter.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/slack/index.test.ts` — stubs for SLCK-01 (app startup validation)
- [ ] `src/slack/adapter.test.ts` — stubs for SLCK-02, SLCK-04, SLCK-05, SLCK-06, SLCK-07
- [ ] `src/slack/blocks.test.ts` — stubs for SLCK-03 (Block Kit structure assertions)
- [ ] `npm install @slack/bolt` — package not yet in dependencies

*Existing vitest infrastructure covers the rest — no new config needed.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Slack Socket Mode connects to real workspace | SLCK-01 | Requires real Slack app credentials and workspace | Configure app tokens, run `npm run slack`, verify "Connected" log |
| Block Kit buttons render correctly in Slack UI | SLCK-03 | Visual rendering only testable in Slack client | Post confirmation message, verify buttons appear with correct labels |
| Concurrent users get independent sessions | SLCK-07 | Requires two simultaneous Slack users | Two users mention bot simultaneously, verify independent threads |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
