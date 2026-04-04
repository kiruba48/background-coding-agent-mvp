---
created: 2026-04-04T17:24:00.114Z
title: Slack thread-level context persistence
area: slack
files:
  - src/slack/index.ts:75-77
  - src/slack/types.ts:6-30
  - src/slack/adapter.ts:100-105
---

## Problem

Each Slack `app_mention` creates a fresh `ReplState` and the session is deleted from the map once the task completes (via `.finally()`). There's no context carryover between mentions in the same thread — every mention starts from zero with no history or project context.

The REPL preserves context across commands because it holds a persistent `ReplState` with `history` and `currentProject`. Users expect the same conversational continuity in Slack threads.

## Solution

1. Don't delete the session in `.finally()` when the task completes — keep it alive with the completed `ReplState` (history, currentProject populated from the agent run)
2. On a new `app_mention` in the same thread, check if a session already exists for that `threadTs` — if so, reuse its `state` instead of calling `createSessionState()`
3. Guard against re-mention while a task is still running (session.status !== 'done') — reply "A task is already running in this thread"
4. Rely on the existing TTL sweep (30-minute `setInterval`) to eventually clean up idle sessions
