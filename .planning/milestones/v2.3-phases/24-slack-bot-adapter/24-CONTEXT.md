# Phase 24: Slack Bot Adapter - Context

**Gathered:** 2026-04-01
**Status:** Ready for planning

<domain>
## Phase Boundary

`@slack/bolt` Socket Mode adapter implementing SessionCallbacks for full channel-agnostic integration. Users mention the bot in a Slack channel with a task description, receive a threaded reply with parsed intent and Block Kit confirmation buttons, agent runs asynchronously on confirmation, and the PR link is posted in the same thread. No changes to session core, intent parser, or agent pipeline.

</domain>

<decisions>
## Implementation Decisions

### Bot identity & threading
- Initial reply to app_mention shows parsed intent summary (task type, repo, dep/description) with Block Kit formatting, same info as REPL confirm step — buttons below
- Progress updates: start + finish only — one message when agent starts ("Running..."), one when done (result or PR link). No periodic updates.
- Block Kit sections for structured content (intent display, buttons), mrkdwn for status/result messages
- Display name and icon use Slack app config defaults — no code-side overrides, user configures in Slack app manifest
- All messages in the same thread as the triggering mention (SLCK-05)

### Confirmation UX
- "Proceed" click: update the original message to replace buttons with "Confirmed — running..." (prevents double-click), then fire-and-forget the agent run
- "Cancel" click: update the original message inline to replace buttons with "Cancelled" — no extra thread noise
- No confirmation timeout — buttons stay active until clicked. Slack's 3-second interaction deadline handled by ack()
- Anyone in the channel can click confirm/cancel — no requester-only restriction. Works for team workflows.

### Error & edge cases
- Agent failure: post thread reply with brief error summary from RetryResult — no stack traces, no log attachments
- Concurrent tasks: allowed — multiple users (or same user) can run tasks simultaneously. Each mention gets its own independent thread and session state.
- Config validation: SLACK_BOT_TOKEN and SLACK_APP_TOKEN validated at startup (fail fast). GITHUB_TOKEN checked per-task (only needed for PR creation). Missing project in registry → thread error message.
- Rate limits: trust Bolt SDK's built-in retry for rate-limited API calls — no custom handling

### Session lifecycle
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

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements
- `.planning/REQUIREMENTS.md` — SLCK-01 through SLCK-07 (Slack bot requirements), SLCK-08/09/10 (deferred enhancements)
- `.planning/ROADMAP.md` §Phase 24 — success criteria, plan breakdown (24-01 and 24-02), dependency on Phase 23

### Core implementation files
- `src/repl/types.ts` — SessionCallbacks interface (implement for Slack adapter), ReplState, TaskHistoryEntry, SessionOutput
- `src/repl/session.ts` — processInput() pipeline that Slack adapter calls, createSessionState()
- `src/intent/index.ts` — parseIntent() entry point
- `src/agent/index.ts` — runAgent() for agent execution
- `src/orchestrator/pr-creator.ts` — GitHubPRCreator for PR creation
- `src/agent/registry.ts` — ProjectRegistry for repo resolution
- `src/types.ts` — RetryResult, PRResult type definitions

### Prior phase context
- `.planning/phases/21-post-hoc-pr-state-foundation/21-CONTEXT.md` — SessionCallbacks patterns, ReplState conventions, post-hoc PR flow
- `.planning/phases/22-conversational-scoping-dialogue/22-CONTEXT.md` — askQuestion optional pattern, scoping bypass for Slack, adapter contract decisions

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `processInput()` in session.ts: full pipeline (parse → clarify → scope → confirm → run) — Slack adapter wraps this or calls its sub-steps
- `createSessionState()` in session.ts: creates fresh ReplState — called per thread_ts for Slack
- `SessionCallbacks` interface: adapter pattern already proven by CLI — Slack implements confirm (Block Kit buttons), clarify (thread options), getSignal (AbortController per thread)
- `GitHubPRCreator.create()`: PR creation reused directly — Slack sets createPr: true on AgentOptions
- `parseIntent()`: called with message text + project context — same as REPL
- `ProjectRegistry`: project name resolution — Slack messages need to specify project

### Established Patterns
- SessionCallbacks methods are always optional (`?`) with graceful degradation
- `askQuestion` not implemented for Slack in v2.3 — scoping dialogue skipped automatically
- Meta-commands (exit, quit, history, pr) are REPL-specific — Slack adapter doesn't need them
- Agent runs are fire-and-forget after confirmation — async with no blocking

### Integration Points
- New `src/slack/` directory for Slack adapter module
- Bolt app initialization with Socket Mode (SLACK_BOT_TOKEN + SLACK_APP_TOKEN env vars)
- app_mention event handler → parseIntent() → Block Kit confirm → runAgent()
- Block Kit action handlers for Proceed/Cancel button clicks
- Thread-scoped say() calls for all responses
- CLI entry point (commander) needs a new `slack` subcommand or separate bin entry

</code_context>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches

</specifics>

<deferred>
## Deferred Ideas

- **SLCK-08**: Multiple concurrent pending confirmations keyed by user ID + channel — future milestone
- **SLCK-09**: Persistent Slack conversation history across bot restarts (database-backed) — future milestone
- **SLCK-10**: Scoping dialogue in Slack via Block Kit modals — future milestone
- **Post-hoc PR in Slack**: Listening for 'pr' in threads after task completion — could revisit if auto-PR proves insufficient

</deferred>

---

*Phase: 24-slack-bot-adapter*
*Context gathered: 2026-04-01*
