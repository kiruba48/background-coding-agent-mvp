# Feature Research

**Domain:** Conversational coding agent — REPL enhancements, Slack adapter, cross-task referencing
**Researched:** 2026-03-25
**Confidence:** HIGH (core patterns verified against official docs and existing codebase), MEDIUM (Slack integration specifics)

---

## Context

This milestone (v2.3) adds four features to the existing background coding agent. Already shipped and not re-researched: REPL + one-shot CLI, LLM intent parser with fast-path regex + verb guard, confirm-before-execute with inline correction, generic task type with scope-fenced end-state prompting, multi-turn sessions with bounded history injection, GitHub PR creation with Octokit, RetryOrchestrator with composite verifier + LLM Judge, SessionCallbacks injection for channel-agnostic I/O, project registry.

The research question: what do conversational scoping dialogue, post-hoc PR creation, follow-up task referencing, and Slack bot interface each require — and what are the expected interaction patterns?

---

## Feature Landscape

### Table Stakes (Users Expect These)

Features that users of a multi-turn agent REPL expect once sessions feel "conversational." Missing these makes the experience feel rigid.

| Feature | Why Expected | Complexity | Notes | Depends On |
|---------|--------------|------------|-------|-----------|
| Post-hoc PR creation via REPL command | "Make a PR" typed after a successful run is the most natural workflow. Forcing users to include "and create PR" upfront requires knowing ahead of time. Most REPL-style tools (git, npm) support deferred decisions. | LOW | Store `RetryResult` + confirmed intent on `ReplState.lastResult`. Add `pr` / `create pr` as a recognized REPL command that invokes `GitHubPRCreator` with stored context. No change to the pipeline. See memory: `project_repl_post_hoc_pr.md`. | `RetryResult` type (exists in `src/types.ts`), `ReplState` (minor extension), `GitHubPRCreator` (already built) |
| Optional scoping questions before generic task confirmation | For generic tasks, users expect the agent to ask about scope constraints before running, not fail silently or over-edit. Industry pattern: CLI tools ask clarifying questions before destructive or wide-ranging operations. | MEDIUM | Trigger only for `generic` taskType, not dep updates (those are already parameterized). Three questions max: target files/dirs, test update expectation, exclusion list. Each answer appended to SCOPE block of `buildGenericPrompt`. Skip-on-empty (user presses Enter) is essential — don't block on it. See memory: `project_generic_task_prompts.md`. | `buildGenericPrompt` (exists in `src/prompts/generic.ts`), confirm-loop (extend, not replace) |
| Follow-up commands can reference the previous task outcome | "Now add tests for that" or "Create a PR for what you just did" are expected follow-up inputs. Without referencing the last result, the REPL forgets what just happened the moment the result block renders. | LOW | Already partially in place: `TaskHistoryEntry` is injected into LLM parser as history context. What's missing: `ReplState.lastResult` is not stored — the `RetryResult` is discarded after `renderResultBlock()`. Store it. Intent parser already receives `history` — augment the history entry to include description (not just `dep`). | `ReplState` (minor extension), `processInput` return path, `TaskHistoryEntry` type |
| Slack bot responds in thread to the triggering mention | When an app_mention triggers an agent run, all subsequent messages (confirmation prompt, progress, PR link) must appear in the same Slack thread. Slack users expect threaded responses from bots. | MEDIUM | Use `thread_ts` from the event to route all replies into the same thread. The `SessionCallbacks` architecture already decouples I/O — a Slack adapter injects Slack-specific `confirm`, `clarify`, and progress callbacks. Confirmation via interactive message buttons (Block Kit). | `SessionCallbacks` (exists), Slack Bolt `@slack/bolt`, Block Kit interactive buttons |

### Differentiators (Competitive Advantage)

Features that raise the quality of the conversational experience beyond what's expected.

| Feature | Value Proposition | Complexity | Notes | Depends On |
|---------|-------------------|------------|-------|-----------|
| Scoping dialogue answers are user-correctable at confirm step | Showing the user the final assembled prompt scope (after scoping answers are merged in) at the confirm step means the scope contract is visible and fixable before the run. Most agents hide the prompt. | LOW | The existing `displayIntent` function in `confirm-loop.ts` already shows `description`. Extend it to also render the assembled SCOPE block when scoping answers are present. Zero new infrastructure. | Scoping dialogue (above), `displayIntent` in `confirm-loop.ts` |
| `pr` command gracefully handles no-result state | A `pr` command that fails silently or crashes when there's no last result is worse than no `pr` command. Clear error: "No completed task in this session — run a task first." | LOW | Guard on `ReplState.lastResult` being null. Single `console.log` with helpful message. The post-hoc PR feature needs this to feel finished. | Post-hoc PR (table stakes) |
| Slack confirmation via Block Kit buttons, not text input | Text-based Y/n confirmation in Slack is awkward (users must type a reply). Block Kit buttons ("Proceed" / "Cancel") are the standard Slack UX pattern for approvals. | MEDIUM | Send an interactive message with two actions: `proceed_action` and `cancel_action`. Listen for action callbacks with the same `message_ts` to update the original message. The button handler calls `processInput` with the confirmed intent. Uses `ack()` + async background execution (Slack requires ack within 3 seconds; agent runs take 60-300 seconds, so fire-and-forget pattern is required). | Slack Bolt `@slack/bolt`, Block Kit, 3-second ack constraint |
| Slack posts PR link as final thread message | When the agent finishes and a PR is created, posting the PR URL as the last message in the thread gives users a direct action without leaving Slack. | LOW | `onAgentEnd` callback posts to thread. `SessionCallbacks.onAgentEnd` already exists; Slack adapter just provides a Slack-specific implementation. | Post-hoc PR table-stakes feature, thread_ts tracking |

### Anti-Features (Commonly Requested, Often Problematic)

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Slack bot accepts multi-turn corrections after task starts | "While the agent is running, I want to redirect it" sounds useful | The agent is already running in Docker with no mechanism for mid-run input injection. Adding a mid-run input channel would require a side-channel into the container, breaking the isolation invariant and making the run non-deterministic. | All scoping happens pre-confirmation. Scoping dialogue collects constraints before the run. User cancels (Ctrl+C / "Cancel" button) and restarts if direction needs to change. |
| Scoping dialogue for dependency update tasks | Could ask "which version?" before confirm | Dep updates are already fully parameterized (`dep`, `version` sentinel). The intent parser extracts these precisely. Adding scoping questions would introduce unnecessary friction for the common case. | Scoping dialogue is `generic` taskType only. Dep updates use the existing fast-path + confirm flow. |
| Persistent cross-session history so follow-ups survive restart | "Remember what I was working on yesterday" | Stale context causes misparses. PROJECT.md explicitly rejects this: "stale context causes misparses, sessions reset on restart." Cross-session memory requires a serialization strategy that risks injecting outdated or conflicting context. | Single-session history (`ReplState.history`, max 10 entries). On restart, fresh state. Users reference prior work explicitly in their next command. |
| Slack bot auto-executes without a confirmation step | Reduces clicks — "just do it" | Removes the human-in-the-loop safety model that is core to the project's trust contract. Auto-execute violates the project's "never auto-execute without confirmation" constraint. | Block Kit buttons make confirmation fast (one click). The confirm step is non-negotiable. |
| Scoping dialogue asks unlimited follow-up questions | More information = better results | Each round-trip in Slack adds latency and user friction. Research on clarification dialogues shows diminishing returns beyond 2-3 targeted questions. More questions signals the system is underconfident, eroding trust. | Maximum 3 scoping questions, all optional (skip with Enter/empty submit). Questions are fixed (files, test-update expectation, exclusion list) — not dynamically generated per-task. |
| Slack bot stores confirmed intent in Slack message metadata | Avoids needing bot-side state | Slack message metadata requires parsing the action payload back into an intent, which introduces a serialization round-trip and type safety issues. The action payload includes the `block_id` / `action_id` but not the full `ResolvedIntent`. | Bot-side state: store `pendingConfirmations: Map<string, ResolvedIntent>` keyed on `message_ts`. Clean up on action receipt. Small in-memory map — no persistence needed. |

---

## Feature Dependencies

```
Post-Hoc PR Creation
    └──requires──> ReplState.lastResult (new field on existing ReplState)
    └──requires──> RetryResult stored after agent run in processInput()
    └──uses──>     GitHubPRCreator (already built, no changes)
    └──requires──> `pr` command handler in REPL loop (currently unrecognized)

Scoping Dialogue
    └──requires──> Generic task identification (taskType === 'generic', already in parser)
    └──requires──> buildGenericPrompt SCOPE block (already in src/prompts/generic.ts)
    └──enhances──> buildGenericPrompt — answers merge into SCOPE block
    └──uses──>     SessionCallbacks.clarify (exists but only for low-confidence clarifications)

Follow-Up Task Referencing
    └──requires──> TaskHistoryEntry includes description (currently only dep/version/taskType/repo)
    └──requires──> ReplState.lastResult for "create PR for last task" pattern
    └──uses──>     LLM intent parser history injection (already implemented)
    └──enhances──> Post-Hoc PR Creation (follow-up input "create a pr" routes to stored lastResult)

Slack Bot Interface
    └──requires──> SessionCallbacks (already built — Slack adapter is a new implementation)
    └──requires──> processInput() (already built — takes text + state + callbacks)
    └──requires──> @slack/bolt installed and configured
    └──requires──> Slack app credentials (Bot Token, Signing Secret)
    └──requires──> In-memory pendingConfirmations map (new, trivial)
    └──uses──>     parseIntent() (already built)
    └──uses──>     runAgent() (already built)
    └──uses──>     GitHubPRCreator (already built)
    └──conflicts─> Auto-execute without confirm (must not do this — safety model)

Scoping Dialogue ──feeds──> Follow-Up Task Referencing
    (scoping answers become part of description stored in history)

Post-Hoc PR Creation ──requires──> Follow-Up Task Referencing
    (detecting "create pr" as follow-up to last result requires lastResult in state)
```

### Dependency Notes

- **Post-hoc PR is the lowest-risk feature:** It requires only a new field on `ReplState`, a check in the result handling path of `processInput`, and a new `pr` command branch. No pipeline changes.
- **Scoping dialogue extends the confirm loop, not the pipeline:** The answers feed into `buildGenericPrompt`. Nothing downstream changes — the agent, verifier, and judge receive a prompt with tighter scope constraints.
- **Follow-up referencing is partially built:** `TaskHistoryEntry` already injects context into the LLM parser. The gap is that `description` is not stored in the history entry, so generic task follow-ups lack the description context. Small schema change.
- **Slack bot requires the most net-new code:** New package (`@slack/bolt`), new event listener, Block Kit message composition, action handler, pending confirmation state, and a Slack-specific `SessionCallbacks` implementation. But it calls the same `processInput` function — no agent logic changes.
- **The 3-second ack constraint is the critical Slack integration pattern:** Slack requires `ack()` within 3 seconds. Agent runs take 60-300 seconds. The pattern is: call `ack()` immediately, then execute the agent in the background, then post results to the thread via `chat.postMessage`. Do not `await` the agent run inside the action handler.

---

## MVP Definition

### Launch With (v2.3)

Minimum for this milestone to deliver value end-to-end.

- [ ] **Post-hoc PR creation** — `ReplState.lastResult` field, `pr` command in REPL, guard for no-result state. Required because this is the most frequently-requested UX gap from multi-turn REPL usage.
- [ ] **Follow-up task referencing: description in history** — Extend `TaskHistoryEntry` to include `description` for generic tasks. Ensures "create PR for last task" + "do this again for that file too" work without re-specifying intent.
- [ ] **Conversational scoping dialogue** — 3 optional pre-confirm questions for generic tasks. Answers merge into `buildGenericPrompt` SCOPE block. Required because generic tasks on complex codebases show scope drift without constraints.
- [ ] **Slack bot interface** — `@slack/bolt` adapter, `app_mention` event listener, Block Kit confirm buttons, async fire-and-forget execution, thread reply with PR link. Required as the fourth target feature in the milestone.

### Add After Validation (v2.3.x)

- [ ] **Scoping dialogue shown in confirm display** — Show assembled SCOPE block at confirm step so user can see how their scoping answers were incorporated. Trigger: scoping answers producing unexpected agent behavior in real usage.
- [ ] **`pr` command shows last task summary before creating PR** — Remind user what task is being PR'd ("Creating PR for: rename X to Y in auth.ts"). Trigger: user confusion about which task the PR is for in long sessions.

### Future Consideration (v2.4+)

- [ ] **Slack bot: multiple concurrent pending confirmations** — Current in-memory map works for single-user usage. Multi-user Slack workspace requires keying by user ID + channel. Trigger: team-shared Slack workspace adoption.
- [ ] **Persistent Slack conversation history across restarts** — Requires a database for the pending confirmations map and session state. Trigger: Slack adapter adoption by teams who want bot restarts to be transparent.
- [ ] **Dynamic scoping questions generated per-task** — LLM generates 1-3 clarifying questions based on the specific instruction. Higher quality than fixed questions but adds an LLM API call on the critical path before the run. Trigger: fixed questions showing low signal-to-noise for specific task types.

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Post-hoc PR creation | HIGH | LOW | P1 |
| Follow-up referencing (description in history) | HIGH | LOW | P1 |
| Conversational scoping dialogue | HIGH | MEDIUM | P1 |
| Slack bot interface | HIGH | MEDIUM-HIGH | P1 |
| Scoping answers shown at confirm step | MEDIUM | LOW | P2 |
| `pr` command task summary before creating | LOW | LOW | P2 |
| Persistent Slack state across restarts | LOW | HIGH | P3 |
| Dynamic per-task scoping questions | MEDIUM | MEDIUM | P3 |

**Priority key:**
- P1: Required for v2.3 milestone
- P2: Add after P1 validated in real usage
- P3: Future milestone

---

## Interaction Pattern Reference

### Scoping Dialogue — Expected Pattern

```
> rename the fetchUser method to getUser across the codebase

  Parsed Intent:
    Task:    refactor
    Action:  rename the fetchUser method to getUser across the codebase
    Project: my-api

  Before confirming, a few quick scoping questions (press Enter to skip):
  Which files or directories should this touch? (e.g. src/users/): src/
  Should tests be updated too? [Y/n]: y
  Any files that must NOT change? (e.g. generated/): generated/

  Proceed? [Y/n]
```

Key behaviors:
- Questions appear only for `generic` tasks, not dep updates
- All three questions are skippable (Enter = no constraint added)
- Answers appear in the SCOPE block of the prompt, visible to the agent and verifiable by the Judge
- The scoping section appears between intent display and the final `Proceed?` prompt

### Post-Hoc PR Creation — Expected Pattern

```
> rename the fetchUser method to getUser

  [task runs... result block renders...]

  Agent completed successfully.

> create a pr
  Creating PR for: rename the fetchUser method to getUser (my-api)
  PR created: https://github.com/org/my-api/pull/42

> pr
  [same as above — both "pr" and "create a pr" are recognized]

> pr
  No completed task in this session. Run a task first.
  [renders when lastResult is null]
```

Key behaviors:
- `pr` and `create pr` (and natural language "create a PR") all route to the same post-hoc flow
- Requires the last task to have `finalStatus === 'success'` (not `zero_diff`, not `failed`)
- `lastResult` is cleared on session start, not on each task — persists until next task completes
- Zero confirmation prompt needed — user already confirmed the task; the PR is just packaging it

### Slack Bot — Expected Interaction Pattern

```
User in #dev-tools:  @coding-agent rename fetchUser to getUser in my-api

Bot (threaded reply):
  ┌─────────────────────────────────────────────┐
  │  Task:    refactor                           │
  │  Action:  rename fetchUser to getUser        │
  │  Project: my-api                             │
  │  [Proceed]  [Cancel]                         │
  └─────────────────────────────────────────────┘

User clicks [Proceed]

Bot (same thread):  Running... (this may take a few minutes)

Bot (same thread):  Done. PR created: https://github.com/org/my-api/pull/42
```

Key technical constraints:
- `ack()` must be called within 3 seconds of button click (before agent starts)
- Agent runs fire-and-forget: `ack()` first, then launch agent async, then `chat.postMessage` results
- All messages use `thread_ts` from the original `app_mention` event
- Scoping dialogue in Slack is deferred: Block Kit modals could support it but adds significant complexity; in v2.3 the Slack adapter skips the scoping questions (generic tasks use auto-detected scope only)

---

## Sources

- Slack Bolt Node.js: [Acknowledging requests](https://docs.slack.dev/tools/bolt-js/concepts/acknowledge/) — HIGH confidence; 3-second ack constraint, ack-then-process pattern
- Slack Bolt Node.js: [bolt-js reference](https://tools.slack.dev/bolt-js/reference) — HIGH confidence; Socket Mode vs HTTP Mode comparison
- Slack: [Comparing HTTP and Socket Mode](https://docs.slack.dev/apis/events-api/comparing-http-socket-mode/) — HIGH confidence; Socket Mode recommended for private tools, HTTP for production/marketplace
- Slack: [Creating interactive messages](https://api.slack.com/messaging/interactivity) — HIGH confidence; Block Kit interactive components, button action pattern
- Slack: [Responding to app mentions tutorial](https://api.slack.com/tutorials/tracks/responding-to-app-mentions) — HIGH confidence; app_mention event, threaded replies
- Knock: [Creating interactive Slack apps with Bolt and Node.js](https://knock.app/blog/creating-interactive-slack-apps-with-bolt-and-nodejs) — MEDIUM confidence; practical Bolt patterns
- MAC Framework: [Multi-Agent Clarification (arXiv 2512.13154)](https://arxiv.org/pdf/2512.13154) — MEDIUM confidence; research on scoping questions, 2-3 targeted questions is optimal
- Anthropic: [2026 Agentic Coding Trends Report](https://resources.anthropic.com/hubfs/2026%20Agentic%20Coding%20Trends%20Report.pdf) — HIGH confidence; context continuity, follow-up capability as top developer expectation
- EclipseSource: [Structured AI Coding with Task Context](https://eclipsesource.com/blogs/2025/07/01/structure-ai-coding-with-task-context/) — MEDIUM confidence; task context persistence patterns
- Project memory: `project_repl_post_hoc_pr.md`, `project_generic_task_prompts.md`, `project_conversational_interface.md` — HIGH confidence; directly from prior project decisions

---

*Feature research for: conversational scoping, post-hoc PR creation, follow-up referencing, Slack bot (background-coding-agent v2.3)*
*Researched: 2026-03-25*
