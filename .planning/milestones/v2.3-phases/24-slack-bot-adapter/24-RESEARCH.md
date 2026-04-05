# Phase 24: Slack Bot Adapter - Research

**Researched:** 2026-04-01
**Domain:** @slack/bolt Socket Mode adapter, Block Kit interactive components, async agent pipeline integration
**Confidence:** HIGH (core patterns verified via official docs and npm registry)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Bot identity & threading**
- Initial reply to app_mention shows parsed intent summary (task type, repo, dep/description) with Block Kit formatting, same info as REPL confirm step — buttons below
- Progress updates: start + finish only — one message when agent starts ("Running..."), one when done (result or PR link). No periodic updates.
- Block Kit sections for structured content (intent display, buttons), mrkdwn for status/result messages
- Display name and icon use Slack app config defaults — no code-side overrides, user configures in Slack app manifest
- All messages in the same thread as the triggering mention (SLCK-05)

**Confirmation UX**
- "Proceed" click: update the original message to replace buttons with "Confirmed — running..." (prevents double-click), then fire-and-forget the agent run
- "Cancel" click: update the original message inline to replace buttons with "Cancelled" — no extra thread noise
- No confirmation timeout — buttons stay active until clicked. Slack's 3-second interaction deadline handled by ack()
- Anyone in the channel can click confirm/cancel — no requester-only restriction. Works for team workflows.

**Error & edge cases**
- Agent failure: post thread reply with brief error summary from RetryResult — no stack traces, no log attachments
- Concurrent tasks: allowed — multiple users (or same user) can run tasks simultaneously. Each mention gets its own independent thread and session state.
- Config validation: SLACK_BOT_TOKEN and SLACK_APP_TOKEN validated at startup (fail fast). GITHUB_TOKEN checked per-task (only needed for PR creation). Missing project in registry → thread error message.
- Rate limits: trust Bolt SDK's built-in retry for rate-limited API calls — no custom handling

**Session lifecycle**
- Per-thread ReplState: each app_mention creates a fresh ReplState tied to that thread_ts. `Map<threadTs, ReplState>`. No cross-thread state sharing.
- Immediate cleanup: delete the thread's ReplState from the map as soon as the agent run completes (success or failure). Prevents memory leak.
- Auto-PR: Slack tasks always set `createPr: true` — PRs created automatically on success. No post-hoc `pr` command in Slack (no need to listen for follow-up messages in threads).
- Restart behavior: in-flight tasks lost on process restart. Pending confirmation buttons expire naturally (Bolt stops receiving actions). Accepted for v2.3.

### Claude's Discretion
- Exact Block Kit layout structure for intent display and button arrangement
- Slack app manifest contents (scopes, event subscriptions, Socket Mode config)
- How to structure the Slack adapter module (single file vs directory)
- Pino logging integration for Slack events
- Whether to extract a shared `SlackThreadReporter` helper or inline say() calls

### Deferred Ideas (OUT OF SCOPE)
- **SLCK-08**: Multiple concurrent pending confirmations keyed by user ID + channel — future milestone
- **SLCK-09**: Persistent Slack conversation history across bot restarts (database-backed) — future milestone
- **SLCK-10**: Scoping dialogue in Slack via Block Kit modals — future milestone
- **Post-hoc PR in Slack**: Listening for 'pr' in threads after task completion — could revisit if auto-PR proves insufficient
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| SLCK-01 | Slack bot listens for app_mention events via Bolt Socket Mode | Bolt 4.6.0 App + socketMode:true + app.event('app_mention') pattern confirmed |
| SLCK-02 | Bot parses mentioned text through existing intent parser and displays parsed intent in thread | event.text (strip `<@BOT_ID>` prefix), call processInput() or parseIntent() directly; reply with thread_ts |
| SLCK-03 | Bot presents Block Kit buttons (Proceed / Cancel) for task confirmation | Block Kit sections + button elements, action_id per button, confirmed via official docs |
| SLCK-04 | Bot executes confirmed tasks asynchronously (ack within 3 seconds, fire-and-forget agent run) | ack() must be called before any async I/O; fire-and-forget pattern after ack(); 3-second Slack deadline |
| SLCK-05 | All bot responses appear in the same thread as the triggering mention | say({ thread_ts }) or client.chat.postMessage({ thread_ts }) — thread_ts is event.ts from app_mention |
| SLCK-06 | Bot posts PR link as final thread message when PR is created | PRResult.url available from GitHubPRCreator.create(); post via client.chat.postMessage to thread |
| SLCK-07 | Bot implements SessionCallbacks interface for channel-agnostic integration with existing pipeline | SessionCallbacks.confirm implemented as Block Kit button prompt; clarify as thread message; getSignal per-thread AbortController |
</phase_requirements>

---

## Summary

The Slack adapter for this project wraps the existing `processInput()` pipeline with a `@slack/bolt` (v4.6.0) Socket Mode app. Socket Mode routes all Slack events over a WebSocket (using an `xapp-` app token), eliminating the need for a public HTTP endpoint. The adapter listens for `app_mention` events, strips the `<@BOT_ID>` prefix from the message text, and feeds that text into the existing session pipeline as a `SessionCallbacks` implementor.

The critical constraint in Bolt's interaction model is the **3-second acknowledgment deadline**: when a button action arrives, `ack()` must be called immediately before any async work (agent execution, PR creation, or even another API call). The pattern is: `await ack()`, update the original message to remove buttons (preventing double-click), then launch the agent run as a fire-and-forget `Promise` not awaited in the handler. All Slack API calls for threading must use `client.chat.postMessage({ thread_ts })` rather than `respond()` — the `respond()` function has a known limitation where it ignores `thread_ts` parameters and posts to the main channel.

The existing `SessionCallbacks` contract fits naturally: `confirm` becomes a Block Kit buttons message, `clarify` becomes a thread text message with numbered options, `getSignal` returns a per-thread `AbortController` signal. `askQuestion` is intentionally not implemented (scoping dialogue bypassed in Slack v2.3, which the optional `?` design handles gracefully). The session state `Map<threadTs, ReplState>` is held in module-level memory and cleaned up immediately when a task finishes.

**Primary recommendation:** Build `src/slack/` as a directory with `index.ts` (Bolt app setup + entry point), `adapter.ts` (SlackSessionCallbacks implementing the interface), `blocks.ts` (Block Kit builders), and add a `slack` subcommand to the existing Commander CLI.

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @slack/bolt | 4.6.0 | Bolt framework: Socket Mode, event/action routing, Slack Web API client | Official Slack-maintained SDK; bundles socket-mode transport, Web API client, TypeScript types |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| pino | 10.x (already installed) | Structured logging for Bolt events | Already in project; pass to `logger` option in Bolt App constructor |
| commander | 14.x (already installed) | CLI entry point extension for `slack` subcommand | Already in project; extend existing `program` |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| @slack/bolt Socket Mode | Bolt HTTP mode | HTTP mode requires a public URL or reverse proxy; Socket Mode works behind firewalls with no endpoint config |
| @slack/bolt Socket Mode | Raw @slack/socket-mode + @slack/web-api | More control, but @slack/bolt bundles both, adds action routing, and handles ack() lifecycle |

**Installation:**
```bash
npm install @slack/bolt
```

**Version verification:**
```bash
npm view @slack/bolt version
# => 4.6.0 (verified 2026-04-01)
```

---

## Architecture Patterns

### Recommended Project Structure
```
src/
├── slack/
│   ├── index.ts          # Bolt App init, event/action registration, startSlack() entry
│   ├── adapter.ts        # SlackSessionCallbacks — implements SessionCallbacks for Slack
│   └── blocks.ts         # Block Kit builder functions (intent display, buttons, status)
└── cli/
    └── index.ts          # Extend with 'slack' subcommand (existing file)
```

### Pattern 1: Socket Mode App Initialization
**What:** Create a Bolt App with `socketMode: true`, passing bot token, app token, and a pino-compatible logger.
**When to use:** Always — Socket Mode is the only supported mode for this deployment.
**Example:**
```typescript
// Source: https://docs.slack.dev/apis/events-api/using-socket-mode/
import { App, LogLevel } from '@slack/bolt';

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,       // xoxb- token
  appToken: process.env.SLACK_APP_TOKEN,     // xapp- token
  socketMode: true,
  logLevel: LogLevel.INFO,                   // or pass a pino adapter
});

await app.start();
```

### Pattern 2: app_mention Handler — Threading Pattern
**What:** Receive app_mention event, extract clean text, determine thread_ts for all replies.
**When to use:** Entry point for all Slack-triggered tasks.
**Example:**
```typescript
// Source: https://docs.slack.dev/reference/events/app_mention/
// Source: https://github.com/slackapi/bolt-js/issues/642
app.event('app_mention', async ({ event, client, say }) => {
  // event.ts is the message timestamp — use as thread_ts for ALL replies from this bot
  // event.thread_ts is populated if mention was inside an existing thread; event.ts otherwise
  const threadTs = event.thread_ts ?? event.ts;

  // Strip the bot mention prefix: "<@U0BOTID> do the thing" → "do the thing"
  const text = event.text.replace(/<@[A-Z0-9]+>\s*/g, '').trim();

  // All subsequent messages in this conversation use threadTs
  await client.chat.postMessage({
    channel: event.channel,
    thread_ts: threadTs,
    text: 'Parsing intent...',
  });
});
```

**Key insight:** `event.ts` is the timestamp of the bot-mention message itself. Using it as `thread_ts` for the first reply creates the thread. All subsequent replies (including `say()` calls) must pass this same `thread_ts` to stay in the thread.

### Pattern 3: Block Kit Confirmation — Button Action with 3-Second Ack
**What:** Post Block Kit buttons; handle Proceed/Cancel within the 3-second ack window; fire-and-forget agent.
**When to use:** Core confirmation flow.
**Example:**
```typescript
// Source: https://docs.slack.dev/tools/bolt-js/concepts/actions/
// Source: https://github.com/slackapi/bolt-js/issues/963

// --- Post the confirmation message with buttons ---
await client.chat.postMessage({
  channel: event.channel,
  thread_ts: threadTs,
  blocks: buildConfirmationBlocks(intent),  // from blocks.ts
  text: 'Confirm task',  // fallback text for notifications
});

// --- Button action handler ---
app.action('proceed_task', async ({ ack, body, client }) => {
  // MUST ack() first — before any async work — Slack 3-second deadline
  await ack();

  // Update message to remove buttons (prevent double-click)
  const channel = (body as BlockAction).channel?.id ?? body.container.channel_id;
  const messageTs = body.message?.ts;   // ts of the confirmation message
  const threadTs = body.message?.thread_ts ?? messageTs;

  await client.chat.update({
    channel,
    ts: messageTs!,
    text: 'Confirmed — running...',
    blocks: [],   // replace buttons with plain text
  });

  // Fire-and-forget: do NOT await — Slack's connection would timeout
  void runAgentInBackground(channel, threadTs, /* session state from Map */);
});
```

**Critical:** `ack()` before any async I/O. Using `void` for fire-and-forget intentionally.

### Pattern 4: Updating Original Message (replace_original via client.chat.update)
**What:** Replace button blocks with a status text to prevent double-click.
**When to use:** After Proceed or Cancel button is clicked.
**Example:**
```typescript
// Source: https://github.com/slackapi/bolt-js/issues/963
// NOTE: respond() does NOT work for threads — use client.chat.update() instead
await client.chat.update({
  channel: channelId,
  ts: confirmationMessageTs,   // ts of the message containing buttons
  text: 'Confirmed — running...',
  blocks: [],   // empty blocks removes all Block Kit formatting
});
```

### Pattern 5: SessionCallbacks Implementation for Slack
**What:** Implement the existing `SessionCallbacks` interface using Slack API calls.
**When to use:** The `adapter.ts` module.
**Example:**
```typescript
// Source: src/repl/types.ts (existing interface)
import type { SessionCallbacks } from '../repl/types.js';

function buildSlackCallbacks(
  client: WebClient,
  channel: string,
  threadTs: string,
  confirmationMessageTsRef: { value: string | null },
): SessionCallbacks {
  const abortController = new AbortController();

  return {
    confirm: async (intent, _reparse, _scopeHints) => {
      // Post Block Kit confirmation buttons
      const result = await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        blocks: buildConfirmationBlocks(intent),
        text: 'Confirm task',
      });
      confirmationMessageTsRef.value = result.ts as string;
      // Return a Promise that resolves when Proceed is clicked (stored in per-thread pendingMap)
      return await waitForConfirmation(threadTs);
    },
    clarify: async (clarifications) => {
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: clarifications.map((c, i) => `${i + 1}. ${c.label}`).join('\n'),
      });
      // Slack v2.3: return first option automatically (no interactive clarification)
      return clarifications[0]?.intent ?? null;
    },
    getSignal: () => abortController.signal,
    onAgentStart: async () => {
      await client.chat.postMessage({ channel, thread_ts: threadTs, text: 'Running...' });
    },
    onAgentEnd: async () => { /* posting result is handled explicitly */ },
    // askQuestion intentionally omitted — scoping dialogue bypassed for Slack v2.3
  };
}
```

### Pattern 6: Per-Thread State Map
**What:** Map from `threadTs` to in-flight session data (ReplState, AbortController, pending confirm resolver).
**When to use:** Module-level in `src/slack/index.ts`.
**Example:**
```typescript
interface ThreadSession {
  state: ReplState;
  abortController: AbortController;
  // Pending confirm: resolve with confirmed intent or null (cancel)
  pendingConfirm?: {
    resolve: (intent: ResolvedIntent | null) => void;
  };
  confirmationMessageTs?: string;
}

const threadSessions = new Map<string, ThreadSession>();

// Cleanup after agent completes (success or failure):
threadSessions.delete(threadTs);
```

### Anti-Patterns to Avoid
- **Awaiting agent run inside action handler:** `await runAgent(...)` inside the `app.action()` callback will hold the connection past Slack's 3-second deadline, causing interaction failure. Always fire-and-forget with `void`.
- **Using respond() for threads:** `respond()` ignores `thread_ts`. Use `client.chat.postMessage()` with explicit `thread_ts` for all threaded messages (confirmed by bolt-js GitHub issue #963).
- **Posting ANSI escape sequences to Slack:** The existing `session.ts` uses `picocolors` for terminal output. The Slack adapter must NOT forward `console.log` output to Slack. Only explicitly constructed Slack API calls should post messages.
- **Calling processInput() for Slack:** `processInput()` in `session.ts` handles REPL meta-commands (history, quit, pr) and uses `console.log` directly. The Slack adapter should call `parseIntent()` and `runAgent()` directly (or refactor processInput) to avoid REPL-only logic and terminal output leaking.
- **Initializing state at module load:** Per CONTEXT.md decision, call `createSessionState()` per app_mention, not at module load. Module-level init would share state across threads.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| WebSocket connection to Slack | Custom WS client | @slack/bolt Socket Mode | Handles reconnection, heartbeats, envelope ack, token refresh |
| Slack API rate limit retries | Custom retry loop | @slack/bolt built-in retry | Bolt wraps all Web API calls with retry logic |
| Action routing by action_id | Manual payload dispatch | `app.action('action_id', ...)` | Type-safe routing built into Bolt |
| Event routing | Switch statement on event.type | `app.event('app_mention', ...)` | Bolt parses and routes; TypeScript types included |
| Slack request verification | HMAC check | Bolt handles automatically | Missing verification is a security vulnerability |

**Key insight:** Bolt's value is the routing, ack lifecycle, and verification. Any part of that replaced manually will either have security gaps or miss the 3-second ack window.

---

## Common Pitfalls

### Pitfall 1: Missing ack() Before Async Work
**What goes wrong:** The action handler awaits agent execution before calling `ack()`. Slack times out after 3 seconds and marks the interaction as failed.
**Why it happens:** Developers assume ack() can come after processing.
**How to avoid:** ALWAYS `await ack()` as the absolute first statement in every action handler.
**Warning signs:** Users see "This app didn't respond" error in Slack after button clicks.

### Pitfall 2: respond() Not Threaded
**What goes wrong:** Using `respond({ thread_ts })` to reply in a thread fails — response posts to channel root instead.
**Why it happens:** Slack API limitation; `response_url` doesn't support threaded replies (bolt-js issue #963).
**How to avoid:** Always use `client.chat.postMessage({ channel, thread_ts })` for ALL messages, never `respond()`.
**Warning signs:** Bot replies appear in main channel instead of thread.

### Pitfall 3: processInput() Has REPL Side-Effects
**What goes wrong:** Calling `processInput()` from the Slack adapter routes through REPL meta-commands (history, quit, pr) and emits `console.log` with ANSI codes to stdout, not to Slack.
**Why it happens:** `processInput()` was designed for terminal use only.
**How to avoid:** The Slack adapter must call `parseIntent()` and `runAgent()` directly rather than going through `processInput()`. Alternatively, the plan could add a `mode` parameter to processInput to skip REPL-only branches — but calling sub-steps directly is cleaner.
**Warning signs:** Terminal gets bot message output; Slack gets nothing.

### Pitfall 4: thread_ts vs ts Confusion
**What goes wrong:** Using `event.ts` as the `thread_ts` but the bot was mentioned inside an existing thread — replies go to a new thread instead of the parent thread.
**Why it happens:** `event.thread_ts` is only populated when the mention is inside a thread; `event.ts` is always the mention message timestamp.
**How to avoid:** Use `const threadTs = event.thread_ts ?? event.ts`. This handles both root-channel mentions and in-thread mentions correctly.
**Warning signs:** Bot creates extra threads instead of continuing existing ones.

### Pitfall 5: Double-Click Race Condition
**What goes wrong:** User double-clicks "Proceed"; two separate agent runs launch for the same task.
**Why it happens:** Both clicks trigger `app.action('proceed_task')` before either can update the message.
**How to avoid:** The context decision is to update (replace) the original confirmation message to remove buttons as the first thing after `ack()`. Optionally, the `threadSessions` map can guard: if a session is already running for a given `threadTs`, post "Already running" and return.
**Warning signs:** Two agent runs for same task visible in logs.

### Pitfall 6: TypeScript type errors on body.container
**What goes wrong:** `body.container` is typed as `StringIndexed` in Bolt's type definitions, causing TypeScript errors when accessing `channel_id` or `message_ts` fields.
**Why it happens:** Bolt uses a loose type for the container to accommodate multiple payload types.
**How to avoid:** Cast as needed: `(body.container as { channel_id: string; message_ts: string })`. Alternatively, prefer `body.channel?.id` (available on `BlockAction`) and `body.message?.ts` which have proper types.
**Warning signs:** TypeScript compile errors `Property 'channel_id' does not exist on type 'StringIndexed'`.

---

## Code Examples

### Bolt App Init with Socket Mode
```typescript
// Source: https://docs.slack.dev/apis/events-api/using-socket-mode/
import { App, LogLevel } from '@slack/bolt';

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,    // Required: xoxb- bot token
  appToken: process.env.SLACK_APP_TOKEN, // Required: xapp- app-level token
  socketMode: true,
  logLevel: LogLevel.WARN,               // Reduce noise; use pino for app logs
});

await app.start();
// App is now connected via WebSocket, no port binding needed
```

### app_mention Event Handler
```typescript
// Source: https://docs.slack.dev/reference/events/app_mention/
// Source: bolt-js issues #642, #1017
import type { AppMentionEvent } from '@slack/bolt';

app.event('app_mention', async ({ event, client }) => {
  // Preserve thread context: use existing thread_ts if mention is inside a thread
  const threadTs = (event as AppMentionEvent & { thread_ts?: string }).thread_ts ?? event.ts;

  // Strip all @-mentions from input text
  const rawText = event.text.replace(/<@[A-Z0-9]+>\s*/g, '').trim();

  if (!rawText) {
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: 'Please include a task description after the mention.',
    });
    return;
  }

  // Store session keyed by threadTs; process task asynchronously
  // ... create ThreadSession, call processTask(rawText, event.channel, threadTs, client)
});
```

### Block Kit Confirmation Blocks Builder
```typescript
// Source: https://docs.slack.dev/reference/block-kit/
import type { ResolvedIntent } from '../intent/types.js';
import type { Block, KnownBlock } from '@slack/bolt';

export function buildConfirmationBlocks(intent: ResolvedIntent): (KnownBlock | Block)[] {
  const summary = intent.taskType === 'generic'
    ? `*Task:* ${intent.description ?? 'No description'}`
    : `*Dep update:* ${intent.dep} → ${intent.version ?? 'latest'}`;

  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Intent confirmed*\n${summary}\n*Repo:* ${intent.repo}` },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Proceed' },
          style: 'primary',
          action_id: 'proceed_task',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Cancel' },
          style: 'danger',
          action_id: 'cancel_task',
        },
      ],
    },
  ];
}
```

### Action Handler with ack() First
```typescript
// Source: https://docs.slack.dev/tools/bolt-js/concepts/actions/
import type { BlockAction } from '@slack/bolt';

app.action('proceed_task', async ({ ack, body, client }) => {
  await ack();  // MUST be first — Slack's 3-second deadline

  const b = body as BlockAction;
  const channelId = b.channel?.id!;
  const confirmMsgTs = b.message?.ts!;
  const threadTs = (b.message as { thread_ts?: string })?.thread_ts ?? confirmMsgTs;

  // Replace confirmation buttons with status text (prevent double-click)
  await client.chat.update({
    channel: channelId,
    ts: confirmMsgTs,
    text: 'Confirmed — running...',
    blocks: [],
  });

  // Resolve pending confirm Promise (stored in threadSessions map)
  const session = threadSessions.get(threadTs);
  session?.pendingConfirm?.resolve(session.state.lastIntent ?? null);
});

app.action('cancel_task', async ({ ack, body, client }) => {
  await ack();

  const b = body as BlockAction;
  const channelId = b.channel?.id!;
  const confirmMsgTs = b.message?.ts!;
  const threadTs = (b.message as { thread_ts?: string })?.thread_ts ?? confirmMsgTs;

  await client.chat.update({
    channel: channelId,
    ts: confirmMsgTs,
    text: 'Cancelled.',
    blocks: [],
  });

  const session = threadSessions.get(threadTs);
  session?.pendingConfirm?.resolve(null);  // null = cancelled
  threadSessions.delete(threadTs);
});
```

### Slack App Manifest (YAML)
```yaml
# Source: https://docs.slack.dev/reference/app-manifest/
_metadata:
  major_version: 2

display_information:
  name: "Background Coding Agent"

features:
  bot_user:
    display_name: "coding-agent"
    always_online: false

oauth_config:
  scopes:
    bot:
      - app_mentions:read   # receive app_mention events
      - chat:write          # post messages
      - channels:history    # read message history (for context if needed)

settings:
  socket_mode_enabled: true
  event_subscriptions:
    bot_events:
      - app_mention
  interactivity:
    is_enabled: true
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Bolt v3.x HTTP mode (requires public URL) | Bolt v4.x Socket Mode (WebSocket, no public URL needed) | Bolt v3.x release (2022) | No ngrok/public endpoint needed; works behind corporate firewalls |
| @slack/events-api + @slack/interactive-messages | @slack/bolt (unified SDK) | ~2020 | Single package handles events, actions, and Web API client |
| Separate @slack/web-api package | @slack/bolt includes web-api client | Bolt v3+ | No separate install needed for client API calls |

**Deprecated/outdated:**
- `@slack/events-api` + `@slack/interactive-messages`: These separate packages were the pre-Bolt pattern; all new apps should use `@slack/bolt`.
- Bolt v3 `processBeforeResponse` option: replaced by natural async/await patterns in v4.

---

## Open Questions

1. **Clarify flow for Slack v2.3**
   - What we know: `clarify` in `SessionCallbacks` receives an array of intent options. The context says scoping dialogue is skipped via `askQuestion` not implemented. But `clarify` (for low-confidence intent) IS part of the contract.
   - What's unclear: For v2.3, should `clarify` auto-select the first option silently, post numbered options to thread and wait for user reply, or post options and auto-select with a note?
   - Recommendation: Auto-select first option silently (or post "I interpreted this as: [option 1]" before proceeding) to keep the interaction fast. Waiting for a text reply would require message event listeners on threads — significant added complexity not in scope.

2. **Pino-to-Bolt logger adapter**
   - What we know: Bolt accepts a `logger` option conforming to its `Logger` interface (methods: `debug`, `info`, `warn`, `error`, `setLevel`, `getLevel`, `setName`). Pino has a slightly different interface.
   - What's unclear: Whether the Pino instance can be passed directly or requires a thin adapter.
   - Recommendation: Write a 10-line `PinoLoggerAdapter` wrapper that wraps pino and satisfies Bolt's `Logger` interface. No external library needed.

3. **Confirm callback — async Promise resolution across handlers**
   - What we know: The `confirm` callback in `SessionCallbacks` must return a `Promise<ResolvedIntent | null>` that resolves when the user clicks a button. This means the `app_mention` handler must await a promise that a separate `app.action` handler resolves.
   - What's unclear: The cleanest pattern for this cross-handler communication.
   - Recommendation: Store a `{ resolve, reject }` pair in the `threadSessions` Map when the confirm message is posted. The action handler looks up the entry by `threadTs` and calls `resolve()`. This is a standard deferred-promise pattern.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.x (existing) |
| Config file | none — vitest auto-discovers `*.test.ts` files |
| Quick run command | `npx vitest run src/slack/` |
| Full suite command | `npx vitest run` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SLCK-01 | Bolt app starts with socketMode:true | unit (startup validation) | `npx vitest run src/slack/index.test.ts` | Wave 0 |
| SLCK-02 | app_mention text stripped of bot mention, passed to parseIntent | unit | `npx vitest run src/slack/adapter.test.ts` | Wave 0 |
| SLCK-03 | buildConfirmationBlocks() returns correct Block Kit structure | unit | `npx vitest run src/slack/blocks.test.ts` | Wave 0 |
| SLCK-04 | Action handler calls ack() before any async work; agent launched fire-and-forget | unit | `npx vitest run src/slack/adapter.test.ts` | Wave 0 |
| SLCK-05 | All reply calls include correct thread_ts | unit | `npx vitest run src/slack/adapter.test.ts` | Wave 0 |
| SLCK-06 | PRResult.url posted as final thread message | unit | `npx vitest run src/slack/adapter.test.ts` | Wave 0 |
| SLCK-07 | SlackSessionCallbacks implements all required SessionCallbacks methods | unit (type-level + runtime) | `npx vitest run src/slack/adapter.test.ts` | Wave 0 |

### Testing Strategy for Bolt
Bolt handlers are not directly testable (they're registered on an App instance). The recommended pattern (verified from bolt-js issue #383) is:

1. **Extract pure functions** from handlers into exported functions in `adapter.ts`:
   - `buildSlackCallbacks(client, channel, threadTs)` — pure factory, testable
   - `stripMention(text: string): string` — pure function, testable
   - `processSlackMention(text, channel, threadTs, client, registry)` — business logic, testable with mocked client

2. **Mock the Slack client:** stub only methods used (`chat.postMessage`, `chat.update`) as `vi.fn()`.

3. **Mock processInput/parseIntent/runAgent** using existing vitest `vi.mock()` pattern (matches session.test.ts pattern).

4. **Test action handlers** by calling the exported handler function directly with a fake `body` and mock `ack`, `client`.

### Sampling Rate
- **Per task commit:** `npx vitest run src/slack/`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/slack/index.test.ts` — covers SLCK-01 (app startup validation)
- [ ] `src/slack/adapter.test.ts` — covers SLCK-02, SLCK-04, SLCK-05, SLCK-06, SLCK-07
- [ ] `src/slack/blocks.test.ts` — covers SLCK-03 (Block Kit structure assertions)
- [ ] Install: `npm install @slack/bolt` — package not yet in dependencies

*(Existing vitest infrastructure covers the rest — no new config needed)*

---

## Sources

### Primary (HIGH confidence)
- `npm view @slack/bolt version` — version 4.6.0 confirmed 2026-04-01
- [Using Socket Mode - Slack Developer Docs](https://docs.slack.dev/apis/events-api/using-socket-mode/) — SLACK_BOT_TOKEN, SLACK_APP_TOKEN setup, socketMode:true config
- [app_mention event - Slack Developer Docs](https://docs.slack.dev/reference/events/app_mention/) — payload fields (type, user, text, ts, channel, event_ts)
- [App manifest reference - Slack Developer Docs](https://docs.slack.dev/reference/app-manifest/) — Socket Mode YAML manifest structure, scopes
- [Listening & responding to actions - Slack Developer Docs](https://docs.slack.dev/tools/bolt-js/concepts/actions/) — action handler pattern, ack() requirement
- [bolt-js block-action.ts TypeScript types](https://github.com/slackapi/bolt-js/blob/main/src/types/actions/block-action.ts) — BlockAction interface, body.message.ts, body.channel

### Secondary (MEDIUM confidence)
- [bolt-js issue #963](https://github.com/slackapi/bolt-js/issues/963) — respond() does NOT work for threads; use client.chat.postMessage with thread_ts
- [bolt-js issue #642](https://github.com/slackapi/bolt-js/issues/642) — thread reply pattern, thread_ts usage
- [bolt-js issue #383](https://github.com/slackapi/bolt-js/issues/383) — unit testing strategy: extract named functions, stub client methods
- [bolt-js issue #1017](https://github.com/slackapi/bolt-js/issues/1017) — post-action threading pattern, body.container.channel_id usage

### Tertiary (LOW confidence)
- WebSearch: thread_ts present in app_mention when mention is inside existing thread — confirmed by Go SDK type definitions and community reports, but Slack's official app_mention doc does not explicitly list it

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — @slack/bolt 4.6.0 verified from npm registry; Socket Mode is official Slack recommendation
- Architecture: HIGH — patterns confirmed from official Slack docs and bolt-js source types
- Pitfalls: HIGH (respond() thread limitation) / MEDIUM (TypeScript container typing) — both confirmed from bolt-js GitHub issues
- Validation architecture: HIGH — existing vitest pattern in project; test strategy from official bolt-js testing guidance

**Research date:** 2026-04-01
**Valid until:** 2026-05-01 (Bolt is relatively stable; check for breaking changes in @slack/bolt 4.x if delayed)
