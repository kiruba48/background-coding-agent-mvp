---
phase: 24-slack-bot-adapter
plan: "02"
subsystem: slack
tags: [slack, bolt, socket-mode, cli, tdd, event-handlers]
dependency_graph:
  requires: [src/slack/types.ts, src/slack/adapter.ts, src/slack/blocks.ts, src/repl/session.ts, src/agent/registry.ts]
  provides: [src/slack/index.ts, src/cli/commands/slack.ts]
  affects: [src/cli/index.ts]
tech_stack:
  added: []
  patterns: [socket-mode-bolt, fire-and-forget, deferred-promise, tdd-red-green]
key_files:
  created:
    - src/slack/index.ts
    - src/slack/index.test.ts
    - src/cli/commands/slack.ts
  modified:
    - src/cli/index.ts
decisions:
  - "handleAppMention, handleProceedAction, handleCancelAction exported as named functions for direct testability without full Bolt app"
  - "getThreadSessions() getter exported to expose module-level Map for test assertions and cleanup"
  - "Mock client cast as 'any' in tests to avoid TS2352 — Pick<WebClient, 'chat'> is structurally too wide for inline mock objects"
  - "ProjectRegistry mock uses function (not arrow) in vi.fn().mockImplementation for vitest constructor compatibility"
  - "Two-promise blocking pattern (mockReturnValueOnce with pending promises) used to test concurrent session independence"
metrics:
  duration: "4 minutes"
  completed: "2026-04-02"
  tasks_completed: 2
  tasks_total: 3
  files_created: 3
  files_modified: 1
---

# Phase 24 Plan 02: Slack Bot Adapter — Bolt Wiring & CLI Summary

**One-liner:** Bolt app with Socket Mode event/action handlers, per-thread session Map with fire-and-forget agent pipeline, and CLI slack subcommand — 12 new unit tests, zero regressions in 682-test suite.

## What Was Built

### src/slack/index.ts
Bolt app wiring layer connecting event/action routing to the pure adapter logic from Plan 01:
- `validateConfig()` — fast-fail on missing SLACK_BOT_TOKEN / SLACK_APP_TOKEN at startup
- `handleAppMention(event, client)` — creates fresh ThreadSession per thread, calls processSlackMention as fire-and-forget with `.catch().finally()` for error handling and cleanup
- `handleProceedAction(ack, body, client)` — acks first (3-second deadline), updates message to remove buttons, resolves deferred pendingConfirm with session intent, double-click guard via !pendingConfirm check
- `handleCancelAction(ack, body, client)` — acks first, updates message to "Cancelled.", resolves pendingConfirm with null, deletes session from Map
- `startSlack()` — validates config, creates Bolt App in socketMode:true with LogLevel.WARN, registers event/action handlers, starts app
- `getThreadSessions()` — exports the module-level Map for test access

### src/slack/index.test.ts
12 unit tests covering:
- Config validation (missing SLACK_BOT_TOKEN / SLACK_APP_TOKEN)
- handleAppMention: session keyed by threadTs, stripped text passed to processSlackMention, empty text error, two independent concurrent sessions, thread_ts inheritance
- handleProceedAction: ack-first ordering, message update, resolve deferred confirm, session-expired error, double-click guard
- handleCancelAction: ack-first ordering, message update to "Cancelled.", null resolve, session deletion, silent return on missing session

### src/cli/commands/slack.ts
CLI slack subcommand with dynamic import of startSlack():
- `createSlackCommand()` — returns Commander Command for 'slack' subcommand
- Dynamic `import('../../slack/index.js')` inside action handler — @slack/bolt not loaded for non-slack CLI invocations

### src/cli/index.ts (modified)
- Added `import { createSlackCommand } from './commands/slack.js'`
- Added `program.addCommand(createSlackCommand())` after createProjectsCommand()

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] ProjectRegistry mock used arrow function (vitest constructor incompatibility)**
- **Found during:** Task 1 (test run after GREEN phase)
- **Issue:** `vi.fn().mockImplementation(() => ({}))` fails as constructor in vitest — same known issue as Phase 21 GitHubPRCreator and Phase 24 Plan 01 WebClient mocks
- **Fix:** Changed to `vi.fn().mockImplementation(function (this: any) { this.register = vi.fn(); ... })`
- **Files modified:** src/slack/index.test.ts
- **Commit:** 6e7d490

**2. [Rule 1 - Bug] Concurrent session test race condition**
- **Found during:** Task 1 (test failure on "two independent sessions" test)
- **Issue:** mockProcessSlackMention resolved immediately, causing `.finally(() => threadSessions.delete(threadTs))` to run before assertions — first session was deleted before `expect(has('100.000')).toBe(true)`
- **Fix:** Used `mockReturnValueOnce(pendingPromise)` to create blocking promises that keep sessions alive during assertion window
- **Files modified:** src/slack/index.test.ts
- **Commit:** 6e7d490

**3. [Rule 1 - Bug] TypeScript TS2352 cast errors in test file**
- **Found during:** Task 2 (npx tsc --noEmit check)
- **Issue:** `client as Parameters<typeof handleAppMention>[1]` fails TS2352 — mock object's chat property is missing 11 methods from Pick<WebClient, 'chat'>
- **Fix:** Changed to `client as any` pattern for mock client casts in test file — consistent with adapter.test.ts approach
- **Files modified:** src/slack/index.test.ts
- **Commit:** 0a88c57

## Checkpoint

**Task 3 (human-verify):** Awaiting user verification of full Slack bot flow in a real workspace. Automated verification (all tests pass, TypeScript clean) is complete.

## Verification Results

```
npx vitest run src/slack/ — 39/39 tests pass (3 test files)
npx vitest run — 682/682 tests pass (28 test files, no regressions)
npx tsc --noEmit — 0 type errors
npx tsx src/cli/index.ts slack --help — "Start the Slack bot adapter (Socket Mode)"
```

## Self-Check: PASSED
