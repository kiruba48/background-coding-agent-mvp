---
phase: 24-slack-bot-adapter
plan: "01"
subsystem: slack
tags: [slack, bolt, block-kit, session-callbacks, tdd]
dependency_graph:
  requires: [src/repl/types.ts, src/intent/types.ts, src/types.ts, src/agent/index.ts]
  provides: [src/slack/types.ts, src/slack/blocks.ts, src/slack/adapter.ts]
  affects: []
tech_stack:
  added: ["@slack/bolt@^4.6.0"]
  patterns: [deferred-promise, session-callbacks-adapter, tdd-red-green]
key_files:
  created:
    - src/slack/types.ts
    - src/slack/blocks.ts
    - src/slack/blocks.test.ts
    - src/slack/adapter.ts
    - src/slack/adapter.test.ts
  modified:
    - package.json
    - package-lock.json
decisions:
  - "KnownBlock/Block imported from @slack/web-api (re-exported by @slack/bolt) — not directly from @slack/bolt"
  - "WebClient mock uses function (not arrow function) for vitest constructor compatibility — same pattern as Phase 21 GitHubPRCreator mock"
  - "confirm callback sets pendingConfirm after postMessage resolves — tests must wait >0ms for pendingConfirm to be available"
  - "askQuestion intentionally omitted from buildSlackCallbacks — scoping dialogue bypassed for Slack v2.3 per CONTEXT.md"
metrics:
  duration: "5 minutes"
  completed: "2026-04-02"
  tasks_completed: 2
  tasks_total: 2
  files_created: 5
  files_modified: 2
---

# Phase 24 Plan 01: Slack Bot Adapter — Pure Logic Layer Summary

**One-liner:** Block Kit builder functions and SessionCallbacks adapter factory for Slack bot with deferred-promise confirm pattern, backed by @slack/bolt and 27 unit tests.

## What Was Built

### src/slack/types.ts
Type definitions for the Slack adapter:
- `ThreadSession` — per-thread session data (ReplState, AbortController, pendingConfirm deferred, confirmationMessageTs, intent)
- `SlackContext` — Slack API call context (WebClient, channel, threadTs)

### src/slack/blocks.ts
Block Kit builder functions:
- `buildConfirmationBlocks(intent)` — Section with task summary + actions block with Proceed (primary, `proceed_task`) and Cancel (danger, `cancel_task`) buttons
- `buildIntentBlocks(intent)` — Section-only display of intent details (no buttons)
- `buildStatusMessage(text)` — Single mrkdwn section block for status updates
- `stripMention(text)` — Removes `<@BOTID>` patterns via regex

### src/slack/adapter.ts
SessionCallbacks factory and mention processing pipeline:
- `buildSlackCallbacks(ctx, session)` — Implements `SessionCallbacks` for Slack: confirm posts Block Kit and blocks on deferred promise; clarify auto-selects first option; onAgentStart posts "Running..."; no askQuestion (v2.3)
- `processSlackMention(text, ctx, session, registry)` — Full pipeline: parse intent → clarify (if low-confidence) → confirm via Block Kit → fire-and-forget agent run → post result/PR link

### Tests
- `blocks.test.ts`: 15 tests covering all Block Kit builder functions and stripMention
- `adapter.test.ts`: 12 tests covering buildSlackCallbacks methods and processSlackMention flows

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] KnownBlock/Block imported from wrong module**
- **Found during:** Task 1 (TypeScript compilation check)
- **Issue:** `import type { KnownBlock, Block } from '@slack/bolt'` causes TS2614 — these types are not named exports from @slack/bolt
- **Fix:** Changed import to `from '@slack/web-api'` (the correct source, re-exported by @slack/bolt)
- **Files modified:** src/slack/blocks.ts
- **Commit:** afde706

**2. [Rule 1 - Bug] WebClient mock used arrow function (vitest constructor incompatibility)**
- **Found during:** Task 2 (test run)
- **Issue:** `vi.fn().mockImplementation(() => ({ ... }))` fails as constructor in vitest — same known issue as Phase 21 GitHubPRCreator mock
- **Fix:** Changed to `vi.fn().mockImplementation(function (this: any) { this.chat = ... })` with explicit `this` typing
- **Files modified:** src/slack/adapter.test.ts
- **Commit:** afde706

**3. [Rule 1 - Bug] confirm test timing race condition**
- **Found during:** Task 2 (test timeout at 5000ms)
- **Issue:** Test called `session.pendingConfirm?.resolve()` synchronously before `pendingConfirm` was set — the property is assigned inside the async confirm callback after `postMessage` resolves
- **Fix:** Added `await new Promise<void>(resolve => setTimeout(resolve, 10))` before accessing `session.pendingConfirm` — allows the postMessage microtask to complete
- **Files modified:** src/slack/adapter.test.ts
- **Commit:** afde706

## Verification Results

```
npx vitest run src/slack/ — 27/27 tests pass (2 test files)
npx tsc --noEmit — 0 type errors
```

## Self-Check: PASSED
