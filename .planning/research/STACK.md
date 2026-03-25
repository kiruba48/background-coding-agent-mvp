# Stack Research

**Domain:** Conversational scoping dialogue, REPL post-hoc PR creation, follow-up task referencing, Slack bot interface — background-coding-agent v2.3
**Researched:** 2026-03-25
**Confidence:** HIGH — npm registry live checks, official Slack docs, and direct codebase inspection

---

## Scope

This file covers ONLY what changes for the v2.3 milestone. The validated existing stack is NOT re-researched:

- Node.js 20, TypeScript (NodeNext / ESM `"type": "module"`)
- `@anthropic-ai/claude-agent-sdk@^0.2.77`, `@anthropic-ai/sdk@^0.80.0`
- Commander.js, Pino, Vitest, ESLint v10, Zod 4, conf@15
- Interactive REPL with readline, intent parser (fast-path regex + LLM)
- SessionCallbacks injection pattern, GitHubPRCreator (Octokit)
- simple-git, write-file-atomic, picocolors, nanospinner

---

## New Stack Addition

One new package is needed for the Slack bot interface. All other v2.3 features are pure TypeScript logic changes to existing modules.

### `@slack/bolt@^4.6.0`

| Field | Value |
|-------|-------|
| Current version | 4.6.0 (released 2025-10-28) |
| Node.js requirement | >=18 (project runs Node.js 20 — compatible) |
| Module format | CommonJS — compatible with ESM host via `esModuleInterop: true` (already enabled in tsconfig.json) |
| Bundled dependencies | `@slack/socket-mode@^2.0.5`, `@slack/web-api@^7.12.0` — no separate install needed |
| Peer dependency | `@types/express@^5.0.0` — install as devDependency for TypeScript types on the receiver |

**Why Bolt over raw `@slack/events-api`:** Bolt is the official Slack SDK for building apps. It ships a `SocketModeReceiver` that handles WebSocket lifecycle, reconnection, and payload acknowledgement — the same concerns that `SessionCallbacks.getSignal()` handles for the REPL. Raw events-api is the legacy SDK, last updated 2022, and does not support Socket Mode or Block Kit interactivity.

**Why Socket Mode over HTTP receiver:** The agent is an internal tool, not a public Slack Marketplace app. Socket Mode requires no public HTTPS URL, no reverse proxy, no ngrok. An app-level token with `connections:write` scope opens a WebSocket to Slack's infrastructure. The bot listens for `app_mention` events and slash commands without exposing any port. Socket Mode is explicitly recommended by Slack for internal tools — official docs confirm marketplace distribution is not allowed via Socket Mode, which is fine for this use case.

**ESM interop:** `@slack/bolt` ships as CommonJS. The project uses `"type": "module"` with `"module": "NodeNext"` and `"esModuleInterop": true` in tsconfig.json. Named imports work: `import { App } from '@slack/bolt'`. The official Slack Bolt TypeScript starter template (bolt-ts-starter-template on GitHub) also uses `"type": "module"` with `@slack/bolt@^4.6.0` and TypeScript — confirmed working pattern.

---

## Changes to Existing Modules

### 1. REPL State — Store `RetryResult` for Post-Hoc PR Creation

**File:** `src/repl/types.ts`

**What changes:** `ReplState` currently tracks `currentProject`, `currentProjectName`, and `history`. Add a `lastResult` field to hold the most recent completed `RetryResult` plus the options and prompt used to produce it.

```typescript
export interface LastRunContext {
  result: RetryResult;
  options: AgentOptions;  // needed to reconstruct PR body
  prompt: string;         // the full prompt sent to the agent
}

export interface ReplState {
  currentProject: string | null;
  currentProjectName: string | null;
  history: TaskHistoryEntry[];
  lastResult: LastRunContext | null;  // new
}
```

The `LastRunContext` shape gives `GitHubPRCreator` exactly what it needs: the `RetryResult` (verification results, judge verdict, session results) plus the `AgentOptions` (repo, taskType, dep) to derive branch name and PR body. No new data structures required beyond the types already defined in `src/types.ts`.

**Why this is the right place:** `ReplState` is already the mutable session container owned by the REPL loop. Storing `lastResult` here follows the pattern for `history` and `currentProject`. `processInput()` in `src/repl/session.ts` has full access to update it after `runAgent()` returns.

### 2. REPL Session — `create pr` Command Handler

**File:** `src/repl/session.ts`

**What changes:** Add a `create pr` / `pr` command branch in `processInput()`, evaluated before intent parsing. When the user types `create pr` (or `pr`):
- If `state.lastResult` is null → print "No completed task in this session."
- If `state.lastResult.result.finalStatus !== 'success'` → print "Last task did not succeed; cannot create PR."
- Otherwise → call `GitHubPRCreator` with the stored context and post the PR URL.

No new callback signatures needed — `GitHubPRCreator` is already a direct call in `runAgent()`. The REPL invokes it directly here with the stored options.

**Why not route through intent parser:** The memory file (`project_repl_post_hoc_pr.md`) identifies the core problem: "a follow-up 'create a PR' input parses as a new generic task instead of acting on the previous run." Adding a hardcoded command branch (like `history` and `exit`) bypasses intent parsing for known REPL meta-commands. This is the same pattern used for `history`, `exit`, and `quit` — consistent with existing session.ts structure.

### 3. Intent Parser — Scoping Questions for Generic Tasks

**Files:** `src/intent/types.ts`, `src/repl/types.ts`, `src/repl/session.ts`, `src/repl/confirm-loop.ts`

**What changes:** After intent parsing returns a `generic` task, and before the confirm loop, inject a brief scoping dialogue that asks up to three questions and populates a `ScopingContext` object. The answers feed into the `SCOPE` block of `buildGenericPrompt()`.

```typescript
// In src/intent/types.ts
export interface ScopingContext {
  fileScope?: string;       // "Which files/directories should this touch?"
  updateTests?: boolean;    // "Should tests be updated?"
  excludedFiles?: string;   // "Any files that must NOT change?"
}
```

The scoping dialogue is:
- Only triggered for `generic` tasks (not dependency updates — those are already well-scoped)
- Optional — the user can press Enter to skip any question and use auto-detected scope
- Implemented with `readline/promises` (already imported in confirm-loop.ts)
- Responses are appended to the `description` passed into `buildGenericPrompt()` as scope constraints

**Why inline in the existing readline flow:** The existing `confirm-loop.ts` already manages a readline conversation with the user (`confirmLoop` function). The scoping dialogue uses the same `createInterface` pattern. No new readline instances, no new dependencies.

**How ScopingContext feeds into buildGenericPrompt:** The generic prompt's `SCOPE` block accepts optional constraints. When `ScopingContext.fileScope` is set, it appends "Only modify files in: X" to the scope block. When `excludedFiles` is set, it appends "Do NOT modify: X". `updateTests: false` appends "Do NOT update test files."

### 4. Slack Adapter — Thin Wrapper Over processInput()

**File:** `src/slack/index.ts` (new module)

**What it does:** Initializes `@slack/bolt` App with Socket Mode, listens for `app_mention` events and optionally a `/agent` slash command, and routes each message through the existing `processInput()` function with a Slack-specific `SessionCallbacks` implementation.

**SessionCallbacks mapping for Slack:**

| Callback | Slack implementation |
|----------|---------------------|
| `confirm` | Post a message with Block Kit buttons (Approve / Correct). Listen for `action` event on the block. Return the resolved intent or null. |
| `clarify` | Post an ephemeral message with Block Kit button options. Listen for `action` event. Return the selected intent string. |
| `getSignal` | Create a fresh `AbortController` per message, stored in a per-channel map. |
| `onAgentStart` | Post "Running agent..." update to the thread. |
| `onAgentEnd` | Update the thread message with the result. |

**Block Kit for confirmation:** Use `section` + `actions` blocks with button elements. Button `action_id` values encode the intent (Approve → proceed, Decline → cancel). The `ack()` call acknowledges within 3 seconds (Slack requirement). Actual agent execution runs after `ack()` in a deferred callback.

**Thread-scoped state:** Each incoming message creates a pending `AgentRun` keyed by `channel:ts`. This is an in-memory `Map` on the adapter. No persistent store needed — concurrent runs per channel are sequential (one active run per channel, queue or reject if busy).

**Why no separate queue library (Bull, BullMQ):** The agent runs in Docker containers on the same machine as the bot process. Concurrency control via an in-memory Map is sufficient for a team-internal tool. A full job queue would require Redis and adds operational complexity. If the bot process restarts, pending runs are lost — acceptable for an internal tool. If multi-machine deployment becomes needed, add a queue at that point.

---

## What NOT to Add

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `@slack/events-api` | Legacy HTTP-only SDK, last updated 2022, no Socket Mode support, no Block Kit interactive message handling. | `@slack/bolt@^4.6.0` (bundles `@slack/socket-mode` and `@slack/web-api`) |
| `@slack/web-api` (separate install) | Already bundled by `@slack/bolt`. Installing separately risks version mismatches between Bolt's internal `@slack/web-api` and a separately installed one. | Use `app.client` from the Bolt App instance |
| `@slack/socket-mode` (separate install) | Bundled by `@slack/bolt@^4.6.0` as `@slack/socket-mode@^2.0.5`. Direct install not needed when using Bolt. | `socketMode: true` in Bolt App constructor |
| Redis / BullMQ / pg-boss | v2.3 Slack bot is a single-process internal tool. Job queue adds Redis dependency, operational overhead, and persistence complexity for no benefit at this scale. | In-memory `Map` per channel in the Slack adapter |
| ngrok / public HTTPS endpoint | Required for HTTP receiver mode but not needed with Socket Mode. Adds infrastructure complexity. | Socket Mode (app-level token with `connections:write`) |
| Persistent cross-session context store | PROJECT.md explicitly rejects: "Persistent cross-session context — stale context causes misparses, sessions reset on restart." | In-memory `ReplState` per REPL session; Slack adapter uses per-message context |
| `express` / HTTP server | Only needed for HTTP receiver mode. Socket Mode has no inbound port. | Bolt's built-in `SocketModeReceiver` (no HTTP server required) |
| A conversation state database | Follow-up task referencing works within a session by extending `TaskHistoryEntry` with `RetryResult` reference (already tracked in `lastResult`). No cross-session persistence needed. | `ReplState.lastResult` + `ReplState.history` |
| Separate LLM call for scoping questions | Scoping dialogue uses static question templates. Generating questions via LLM adds latency and cost for no accuracy benefit — the three canonical questions (file scope, test updates, exclusions) cover the useful space. | Static readline prompts in confirm-loop.ts |

---

## Installation

```bash
# One new production dependency:
npm install @slack/bolt@^4.6.0

# One new dev dependency (TypeScript types for the Express receiver, peer dep of @slack/bolt):
npm install -D @types/express@^5.0.0
```

---

## Version Compatibility

| Package | Version | Notes |
|---------|---------|-------|
| `@slack/bolt` | `^4.6.0` (latest as of 2026-03-25) | Requires Node.js >=18 — project is Node.js 20, compatible. Bundles `@slack/socket-mode@^2.0.5` and `@slack/web-api@^7.12.0`. |
| `@slack/bolt` + `"type": "module"` | CJS package in ESM project | Works with `esModuleInterop: true` (already in tsconfig.json). Named import `import { App } from '@slack/bolt'` is confirmed in official Bolt TypeScript starter template using the same `"type": "module"` setup. |
| `@types/express` | `^5.0.0` | Peer dependency of `@slack/bolt@4.6.0`. Needed only for TypeScript to type-check the HTTP receiver code path (even if not using it). `skipLibCheck: true` is already in tsconfig.json but installing the types avoids potential downstream issues. |

---

## Alternatives Considered

| Recommended | Alternative | Why Not |
|-------------|-------------|---------|
| `@slack/bolt` with Socket Mode | Raw WebSocket to Slack (no SDK) | Slack's WebSocket protocol requires app-level token negotiation, heartbeat handling, reconnection logic, and payload envelope parsing. Bolt handles all of this. No benefit to reimplementing. |
| `@slack/bolt` with Socket Mode | `@slack/bolt` with HTTP receiver + Express | HTTP receiver requires a public HTTPS endpoint with a valid SSL cert. Adds infrastructure dependency (load balancer, SSL termination) for an internal tool. Socket Mode is simpler and equally capable for this use case. |
| `create pr` as hardcoded REPL command | Intent parser detection of "create PR for last task" | The memory file (`project_repl_post_hoc_pr.md`) identifies exactly this failure mode: "a follow-up 'create a PR' input parses as a new generic task." Hardcoded command is reliable. |
| Static scoping questions (readline) | LLM-generated scoping questions | Static questions are deterministic, have zero latency, and cover the useful space. LLM-generated questions would require an API call, add 500ms–2s latency, and could produce inconsistent question phrasing that confuses users. |
| In-memory `Map` for Slack concurrency | Redis + BullMQ | Adds Redis operational dependency with no benefit for a single-process internal tool. Job durability is not required — if the process restarts, the user retries. |

---

## Sources

- npm registry live: `npm show @slack/bolt version` → `4.6.0`, released 2025-10-28 (HIGH confidence — live npm registry)
- npm registry live: `npm show @slack/bolt engines` → `node: >=18` (HIGH confidence — live npm registry)
- npm registry live: `npm show @slack/bolt dependencies` → `@slack/socket-mode@^2.0.5` bundled (HIGH confidence — live npm registry)
- [Slack Bolt Socket Mode docs](https://docs.slack.dev/tools/bolt-js/concepts/socket-mode/) — `socketMode: true` + `appToken` init pattern, no public URL needed (HIGH confidence — official Slack docs)
- [Slack Socket Mode overview](https://api.slack.com/apis/socket-mode) — internal tools appropriate use case, marketplace restriction confirmed (HIGH confidence — official Slack docs)
- [bolt-ts-starter-template package.json](https://raw.githubusercontent.com/slack-samples/bolt-ts-starter-template/main/package.json) — `"type": "module"`, `@slack/bolt@^4.6.0`, TypeScript 5.9.3 confirmed working together (HIGH confidence — official Slack GitHub sample)
- `tsconfig.json` (project): `"esModuleInterop": true`, `"module": "NodeNext"`, `"skipLibCheck": true` — CJS/ESM interop already configured (HIGH confidence — live project file)
- `src/repl/types.ts` — `ReplState`, `SessionCallbacks`, `TaskHistoryEntry` interfaces (HIGH confidence — live source)
- `src/types.ts` — `RetryResult`, `AgentOptions` interfaces (HIGH confidence — live source)
- `src/repl/confirm-loop.ts` — readline pattern for REPL dialogue (HIGH confidence — live source)
- `.claude/projects/memory/project_repl_post_hoc_pr.md` — "RetryResult discarded after renderResultBlock(); follow-up 'create a PR' misparses as generic task" (HIGH confidence — project memory)
- `.claude/projects/memory/project_generic_task_prompts.md` — scoping questions and ScopingContext shape (HIGH confidence — project memory)
- `.claude/projects/memory/project_conversational_interface.md` — Slack adapter as thin layer over processInput() (HIGH confidence — project memory)

---
*Stack research for: Conversational scoping dialogue, REPL post-hoc PR creation, follow-up task referencing, Slack bot interface (background-coding-agent v2.3)*
*Researched: 2026-03-25*
