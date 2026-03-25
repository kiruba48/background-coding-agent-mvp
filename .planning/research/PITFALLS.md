# Pitfalls Research

**Domain:** v2.3 — Adding conversational scoping dialogue, REPL post-hoc PR creation, cross-task follow-up referencing, and Slack bot interface to an existing CLI agent platform
**Researched:** 2026-03-25
**Confidence:** HIGH (derived from direct code analysis of the v2.2 codebase and targeted investigation of each integration surface)

---

## Critical Pitfalls

Mistakes that either break existing safety guarantees, introduce silent data corruption in session state, or require rewriting shared infrastructure that other features depend on.

---

### Pitfall 1: Scoping Dialogue Breaks the Existing Confirm-Before-Execute Contract

**What goes wrong:**
The current flow is: parse → confirm → execute. The confirm step is owned by `SessionCallbacks.confirm`, which uses readline inside `repl.ts`. Conversational scoping inserts follow-up questions between parse and confirm. If scoping questions are implemented as a new readline prompt sequence inside `processInput()` (the session core), the session core now owns I/O directly — which breaks the SessionCallbacks injection pattern that was specifically designed to decouple I/O from session logic.

The symptom: scoping works in the CLI REPL but the Slack bot adapter has no readline. When the Slack adapter tries to call `processInput()` with its callbacks, it hits the new hardcoded readline calls, either crashing or hanging indefinitely waiting for terminal input that will never come.

**Why it happens:**
Scoping questions feel like they belong inside `processInput()` because that is where parsing happens. The instinct is to add the question loop right after intent parsing, before confirmation. But `processInput()` is channel-agnostic by design — it accepts a `callbacks` object precisely so readline is not embedded in it. Adding readline directly in the session core collapses the abstraction.

**How to avoid:**
Scoping must go through `SessionCallbacks`. Add a `scope` callback to the `SessionCallbacks` interface: `scope: (questions: ScopingQuestion[]) => Promise<ScopingAnswer[] | null>`. The session core calls `callbacks.scope(questions)` and receives structured answers. The CLI REPL implements it with readline. The Slack bot implements it with threaded replies. The session core never touches process I/O. Design the scoping questions as a data structure — not a conversation loop — so the callback implementor controls the interaction model.

**Warning signs:**
- `processInput()` or any function called from it imports `readline` or `createInterface`
- Scoping logic creates an `Interface` object without going through a callback
- The Slack adapter cannot reuse `processInput()` without modification

**Phase to address:** Conversational scoping phase — scoping must be added to `SessionCallbacks` before any scoping dialogue code is written.

---

### Pitfall 2: Post-Hoc PR Creation Stores RetryResult on ReplState, Then the State Goes Stale

**What goes wrong:**
The most natural implementation of post-hoc PR creation: store the last `RetryResult` on `ReplState`, then when the user types "create PR" after a successful run, call `GitHubPRCreator` with the stored result. This works for the immediately following task but creates a dangerous stale-state problem for subsequent tasks.

Session flow: task A succeeds → `state.lastResult = resultA` → user starts task B → task B is confirmed → task B runs → user types "create PR" during task B's execution (or cancels B) → `state.lastResult` is still `resultA`, but the git state (current branch, workspace commits) reflects task B's partial work. `GitHubPRCreator` attempts to push, gets the wrong branch, and either fails with a confusing error or creates a PR with the wrong diff.

A subtler variant: task A succeeds, task B is cancelled before execution. `state.lastResult` is `resultA`. The user types "create PR". The workspace git state has been reset by the aborted task B setup, so `diffBase` in `GitHubPRCreator` resolves incorrectly.

**Why it happens:**
`RetryResult` alone is not sufficient to recreate a PR. PR creation requires: the `RetryResult`, the `ResolvedIntent` (for task type, description, category), AND a git workspace in the correct post-run state. Storing `RetryResult` on `ReplState` without the git state anchor is incomplete. The existing PR creation path inside `runAgent()` runs immediately after the agent session, when git state is guaranteed correct. Post-hoc creation breaks that guarantee.

**How to avoid:**
Store a `LastCompletedTask` structure on `ReplState` that includes: `retryResult`, `intent` (the full `ResolvedIntent`), and `completedAt` timestamp. Before calling `GitHubPRCreator` post-hoc, verify git state: run `git log --oneline -1` in `intent.repo` and confirm the commit matches what the session produced. If the workspace has diverged (newer commits from task B), refuse with a clear message: "The workspace has changed since that task completed. Post-hoc PR creation is only safe immediately after the task." The `completedAt` timestamp provides a UI-level signal: warn if more than one subsequent task has run since the stored result.

**Warning signs:**
- `ReplState` stores `RetryResult` but not the associated `ResolvedIntent` or a git state anchor
- No check that git HEAD matches the session's result before attempting post-hoc PR push
- "create PR" accepted at any point in the session, not just immediately after a successful task

**Phase to address:** REPL post-hoc PR creation phase — `LastCompletedTask` type and git state verification must be designed before the UI for "create PR" command is built.

---

### Pitfall 3: Follow-Up Referencing Inherits the Wrong Repo When Multiple Projects Are Active

**What goes wrong:**
The current follow-up mechanism in `parseIntent()` inherits `taskType` and `repo` from `history[last]`. This works well for the common case: user runs one task, follows up on the same task. But with cross-task follow-up referencing, the user can say "create a PR for that" referring to task 3 in a 5-task session where tasks 4 and 5 ran against a different project. `history[last]` is task 5's repo. The reference resolution picks up task 5's repo and tries to create a PR for task 3's result in the wrong repository.

A related variant: the user says "do the same thing in the other project." The intent parser inherits the `taskType` from the last history entry but should use the description from a *different* history entry. There is no index-based reference in the current model — only "the last one."

**Why it happens:**
`TaskHistoryEntry` only stores enough data to inherit `taskType` and `repo` for the very common "also update X" follow-up pattern. It does not store a `RetryResult` reference, and there is no way to address specific history entries by index. Cross-task referencing requires history entries to be addressable, not just the most recent one.

**How to avoid:**
Add an integer `id` (1-indexed session counter) to `TaskHistoryEntry`. When follow-up language includes positional references ("that one", "the second task", "task 2", "the auth task"), the intent parser should extract the reference and resolve it against the history by id or by description match, not by defaulting to `history[last]`. For the MVP: extend `TaskHistoryEntry` with `id` and `description` (truncated task description). The LLM parser receives history with these fields and can resolve positional references. If resolution is ambiguous, return `confidence: 'low'` with clarification options listing the matching history entries.

**Warning signs:**
- Follow-up referencing always uses `history[history.length - 1]` regardless of what the user referred to
- "create PR for task 2" resolves to the most recent task instead of task 2
- `TaskHistoryEntry` has no `id` field or description field for disambiguation

**Phase to address:** Follow-up referencing phase — `TaskHistoryEntry` schema extension and reference resolution in `llmParse` must be decided before implementation starts, because changing the schema affects all existing history-aware code paths.

---

### Pitfall 4: Slack Adapter Leaks Session State Across Concurrent Users

**What goes wrong:**
The REPL session state (`ReplState`) is a single in-memory object owned by the CLI process. In the Slack bot, multiple users can send messages simultaneously. If the Slack adapter shares a single `ReplState` and a single `registry`, user A's task in progress can be corrupted by user B's task updating `state.currentProject`. User B types "update lodash" and the `state.currentProject` gets set to user B's repo just as user A's confirmation loop is reading it to set up the agent run.

A harder-to-detect variant: `parseIntent` uses `process.cwd()` as the repo fallback. In the CLI REPL, `cwd` is the user's shell directory. In the Slack bot, `cwd` is the bot process working directory — meaningless for any user's task. If user A does not specify a project and the Slack adapter falls through to `cwd` fallback, they get the bot's working directory as their repo path.

**Why it happens:**
`ReplState` is designed as a per-session singleton. The CLI REPL has one session. The Slack bot has N concurrent users each with independent context. The codebase has no session isolation mechanism for multi-user scenarios because it was not a requirement until now. `process.cwd()` as a fallback is only reasonable in a single-user CLI context.

**How to avoid:**
The Slack adapter must create a **per-user** (or per-channel) `ReplState` instance, not share one. Use a `Map<userId, ReplState>` keyed by Slack user ID (or channel ID for channel-scoped bots). Each `SessionCallbacks` implementation must also be per-request — callbacks close over the per-user state. The `cwd` fallback in `parseIntent` must be overridable: the Slack adapter should always require an explicit project name or channel-default project, never falling back to `process.cwd()`. Enforce this by passing a sentinel `repoPath: '__require_explicit__'` or by checking whether the adapter has a default project configured before calling `parseIntent`.

**Warning signs:**
- The Slack adapter creates one `ReplState` at bot startup and reuses it for all messages
- `parseIntent` calls in the Slack adapter can reach the `usedCwdFallback = true` path
- `createSessionState()` called once at module load rather than per incoming message

**Phase to address:** Slack adapter phase — per-user session isolation must be the first architectural decision, before any message handling code is written.

---

### Pitfall 5: Scoping Questions Increase LLM Latency on Every Generic Task

**What goes wrong:**
Conversational scoping adds LLM calls (to generate questions) on top of the existing intent parse LLM call. For a 3-question scoping dialogue, the total pre-execution latency becomes: fast-path check (fast) + intent parse LLM (2-4s) + scoping question generation LLM (2-4s) + user response wait (N seconds) + confirmation (0.5s). For users who know exactly what they want, this is pure friction.

A related problem: the scoping question generator fires for every `generic` task, including cases where the user's description is already fully scoped ("rename the `getUser` method in `src/auth/UserService.ts` to `fetchUser`" — file path specified, symbol specified, no ambiguity). The system asks "which file should be changed?" even though the answer is in the input.

**Why it happens:**
If scoping is implemented as an unconditional step in the generic task pipeline, it runs regardless of description completeness. The system does not distinguish between "rename getFoo in auth.ts" (fully scoped) and "rename getFoo" (needs scoping). Running the full scoping LLM call on a fully-scoped description wastes 2-4 seconds and produces irrelevant questions that confuse the user.

**How to avoid:**
Gate scoping behind a completeness check, not a task type check. Before calling the scoping LLM, heuristically score the description for scope completeness: does it include a file path or module name? Does it name both the before and after state? Does it include a scope qualifier like "in the auth module"? Only invoke scoping when the description scores below a completeness threshold. The threshold can be simple and cheap to compute — no LLM call needed for the gate itself. Scoping questions are opt-in based on description quality, not mandatory for all generic tasks.

**Warning signs:**
- Scoping LLM call fires for tasks whose descriptions already include file paths and symbol names
- Total pre-execution latency for a simple generic task exceeds 10 seconds
- Scoping questions ask "which file?" when the user already specified `src/auth/UserService.ts`

**Phase to address:** Conversational scoping phase — the completeness gate must be designed alongside the scoping dialogue, not added as a later optimization.

---

### Pitfall 6: Post-Hoc "create PR" Command Parsed as a Task Instruction

**What goes wrong:**
The user types "create a PR for that last task." The intent parser sees this as a natural language task instruction. The fast-path does not match. The LLM parser runs and may classify it as `taskType: 'generic'`, `description: 'create a PR for that last task'`. The agent is dispatched into Docker with this as its prompt, spends turns searching for what "that last task" means, finds nothing meaningful, and returns a `zero_diff` or `failed` result. The user never gets the PR.

A related variant: the user types "also create a PR" mid-correction (after a correction to an existing intent). The correction loop in `confirmCb` calls `reparse("also create a PR")` which routes through `parseIntent`, producing an intent for a new task rather than flagging PR creation for the current one.

**Why it happens:**
"Create PR" is a meta-command about the session, not a code change task. The intent parser is designed to extract code change tasks from natural language. It has no concept of session meta-commands. All non-quit, non-history, non-empty inputs are routed through `parseIntent`. The command vocabulary is hardcoded to `'exit'`, `'quit'`, and `'history'` in `processInput()`. "Create PR" is not in that list.

**How to avoid:**
Add a meta-command recognition layer in `processInput()` before `parseIntent` is called. Pattern-match on "create pr", "make pr", "open pr", "pr for that", "pr for last", "make a pull request" (and variations) and route to the post-hoc PR creation path directly. Do not dispatch these phrases through the intent parser — they are unambiguous session commands, not task descriptions. The pattern list can be a small regex set; no LLM call needed. This also prevents LLM token waste on non-task inputs.

**Warning signs:**
- "create PR" typed after a successful task runs a new agent session with description "create PR"
- `processInput()` calls `parseIntent` for input that contains "pr", "pull request", or "create PR" variants
- No unit test covers the "create PR" input routing in `processInput()`

**Phase to address:** REPL post-hoc PR creation phase — the meta-command recognizer must be implemented alongside the PR creation path so it is never routed through the agent.

---

### Pitfall 7: Slack Adapter Bypasses the Confirm-Before-Execute Safety Gate

**What goes wrong:**
The Slack bot receives a message: "update lodash to 4.17.21 in my-project." The adapter parses intent, gets a high-confidence result, and — to avoid a multi-message round-trip with the user — calls `runAgent()` directly without the confirm step. The task runs, a PR is created, and the user gets a Slack reply with the PR link. This feels like a good UX. But the confirm step exists for a reason: it is the human-in-the-loop safety gate. Bypassing it means: wrong repo → PR against wrong project. Wrong task type → unintended change. Prompt injection via Slack message → unchecked agent execution.

The subtler variant: the Slack adapter implements confirmation as a Slack interactive button ("Yes / No / Correct"). The user clicks "Yes." But the confirm callback does not support correction-loop follow-up — the only options are yes and no. A user who wants to redirect ("actually do this in the other project") cannot, so they click yes even though the intent is slightly wrong, leading to a PR against the wrong repo or with the wrong version.

**Why it happens:**
Slack interactive confirmation adds complexity: the adapter must store pending intents keyed by message ID, handle button click events, correlate them back to the waiting `confirm` callback, and implement timeouts. Developers often skip this and implement a simpler "just run it" flow for high-confidence intents.

**How to avoid:**
Never call `runAgent()` without going through `SessionCallbacks.confirm`, even in the Slack adapter. The confirmation interaction model can differ (Slack button vs. readline), but the confirm step must always exist. Implement pending-intent storage with a timeout (e.g., 5 minutes: if not confirmed within 5 minutes, the intent expires). Support at least a text correction in the Slack confirmation reply — the user can reply with a correction, which routes through `reparse`, the same way the REPL confirm loop does. The `SessionCallbacks` abstraction exists precisely to make this implementable per-channel without touching the session core.

**Warning signs:**
- The Slack adapter calls `runAgent()` or `processInput()` without going through `callbacks.confirm`
- High-confidence intents are auto-executed without user acknowledgment
- The Slack confirmation UX only supports yes/no with no correction path

**Phase to address:** Slack adapter phase — confirm callback implementation must be the first thing built, before any message handling, to establish the correct architecture from the start.

---

### Pitfall 8: TaskHistoryEntry Missing RetryResult Reference Breaks Post-Hoc PR for Earlier Tasks

**What goes wrong:**
`TaskHistoryEntry` currently stores `taskType`, `dep`, `version`, `repo`, and `status`. It does not store the `RetryResult`. Post-hoc PR creation for "the last task" can work by storing `lastResult` separately on `ReplState`. But cross-task follow-up referencing ("create PR for task 2") requires that `RetryResult` be retrievable for any history entry, not just the last one.

If `RetryResult` is not stored in `TaskHistoryEntry`, the only PR-eligible task is always the most recent one. A user who ran 3 tasks and wants to create a PR for task 1 cannot, even though task 1 succeeded. The history command shows all three tasks but only the last one is actionable.

**Why it happens:**
`TaskHistoryEntry` was designed for intent parsing context only: the history tells the LLM parser what was recently done so it can resolve follow-up task references. Storing `RetryResult` in history was out of scope because there was no post-hoc PR feature. Now that both features are being added in the same milestone, there is a risk of implementing them with incompatible data models: post-hoc PR uses `state.lastResult`, cross-task referencing uses `history[n]`, and neither feeds into the other.

**How to avoid:**
Extend `TaskHistoryEntry` to include an optional `retryResult?: RetryResult` and `intent?: ResolvedIntent` (the confirmed intent, not the raw parse). Store these on every history entry when the task completes. The `MAX_HISTORY_ENTRIES` cap (currently 10) applies the same way — old entries are evicted. This gives both features a single source of truth: post-hoc PR for the last task reads `history[last].retryResult`, cross-task referencing reads `history[n].retryResult` by index. The `ReplState.lastResult` shortcut is then unnecessary and should be removed to avoid two sources of truth diverging.

**Warning signs:**
- `TaskHistoryEntry` does not include `retryResult` or `intent`
- `ReplState` adds `lastResult` as a separate field parallel to `history`
- "create PR for task 1" cannot work because `history[0].retryResult` is undefined

**Phase to address:** Both post-hoc PR and follow-up referencing phases — `TaskHistoryEntry` schema extension must happen in the first phase that touches history, before either feature is fully implemented.

---

## Technical Debt Patterns

Shortcuts that seem reasonable but create long-term problems.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Add scoping readline calls directly in `processInput()` | Faster to implement | Breaks Slack adapter; session core is no longer channel-agnostic | Never — always route through `SessionCallbacks` |
| Share one `ReplState` across all Slack users | Simple implementation | Cross-user state corruption; wrong repo selected for different users | Never for multi-user bot; acceptable for single-user DM-only bot if documented |
| Auto-execute high-confidence Slack intents without confirm | Smooth Slack UX | Removes safety gate; enables misparse-to-execution without human check | Never — confirm is non-negotiable per PROJECT.md constraints |
| Store `lastResult` as separate `ReplState` field instead of in `TaskHistoryEntry` | Simpler for just post-hoc PR | Two sources of truth diverge; cross-task referencing cannot use it | Only if cross-task referencing is explicitly deferred to a later milestone |
| Implement "create PR" by routing through intent parser | No new command recognizer needed | Agent dispatched for meta-commands; LLM token waste; PR never gets created | Never — meta-commands must bypass the intent parser |
| Skip completeness gate and always run scoping questions for generic tasks | Simpler logic | Every generic task waits 2-4s extra even when fully scoped | Only in v2.3 spike/prototype, must be gated before shipping |

---

## Integration Gotchas

Common mistakes when wiring new features into the existing pipeline.

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| `SessionCallbacks` ↔ scoping dialogue | Add `readline` calls inside `processInput()` | Extend `SessionCallbacks` with a `scope` callback; session core calls it; CLI REPL and Slack implement it independently |
| `ReplState` ↔ post-hoc PR | Store only `RetryResult` on `lastResult` field | Extend `TaskHistoryEntry` with `retryResult` and `intent`; remove separate `lastResult` field |
| `processInput()` ↔ "create PR" input | Route "create PR" through `parseIntent` | Pattern-match on PR meta-commands before `parseIntent` is called; route directly to post-hoc creation path |
| `GitHubPRCreator` ↔ post-hoc PR | Call `creator.create()` without checking git state | Verify git HEAD matches the session result's baseline before pushing; refuse if workspace has diverged |
| Slack adapter ↔ `ReplState` | Create one `ReplState` for the bot process | Create per-user `ReplState` keyed by Slack user ID; garbage-collect idle sessions after inactivity timeout |
| Slack adapter ↔ `parseIntent` | Allow cwd fallback in Slack context | Require explicit project name or channel-default project in Slack; pass `repoPath` explicitly, never rely on `process.cwd()` |
| History follow-up ↔ `TaskHistoryEntry` | Use only `history[last]` for all cross-task references | Add `id` field to `TaskHistoryEntry`; extract positional references ("task 2", "the auth task") in LLM parser and resolve by id |
| Scoping dialogue ↔ intent confidence | Run scoping even for `confidence: 'high'` intents | Only run scoping for `taskType: 'generic'` intents that lack file/module/symbol scope qualifiers; skip for high-confidence dep updates entirely |

---

## Performance Traps

Patterns that work at small scale but fail as usage grows.

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Scoping LLM call on every generic task regardless of description completeness | Adds 2-4s to every generic task; users with fully-scoped descriptions are penalized | Completeness gate before scoping LLM call; skip if description already specifies file + symbol | Every generic task from day one |
| Per-message `ProjectRegistry` instantiation in Slack adapter | Creates new `conf` store reader on every Slack message; filesystem reads on hot path | Instantiate registry once at Slack bot startup; pass as a shared read-only dependency | After ~10 messages/minute |
| Storing full `RetryResult` in `TaskHistoryEntry` with large `sessionResults` arrays | `ReplState` memory grows with each session; old session data not GC'd | Cap `sessionResults` stored in history entries (keep only `finalStatus`, `attempts`, `judgeResults`); store full result only for `lastCompleted` | After ~20 tasks in a long-running REPL session |
| Pending Slack intent storage with no expiry | Memory leak if users start tasks and never confirm | Add expiry to pending intent map; evict after 5 minutes with a timeout Slack reply | After ~50 abandoned Slack confirmations |

---

## Security Mistakes

Domain-specific security issues introduced by the new features.

| Mistake | Risk | Prevention |
|---------|------|------------|
| Slack message body used as `description` without length check | Long Slack messages (up to 40,000 chars) exceed `MAX_INPUT_LENGTH` and bypass the guard in `processInput()` that only applies after parsing | Apply `MAX_INPUT_LENGTH` check at Slack adapter entry point, before calling `processInput()` |
| Slack bot responds in public channels with git diff content or PR diffs | Sensitive code diffs visible to all channel members | Send PR URLs only in public channels; send full result details only in DMs or ephemeral messages |
| Post-hoc PR creation reads `GITHUB_TOKEN` in the Slack bot process | Token in bot process environment; leakage risk if bot logs are not sanitized | Apply same token-sanitization logic from `GitHubPRCreator.sanitize()` to all Slack reply messages; never log token in any Slack-facing code path |
| Pending Slack intent stored with repo path and task description | If Slack message storage is compromised, repo paths and task descriptions are exposed | Store only intent hash in Slack message metadata; keep full intent in bot process memory keyed by hash; never serialize full `ResolvedIntent` to Slack metadata |

---

## UX Pitfalls

Common user experience mistakes in the new features.

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Scoping questions asked after intent is already confirmed | User has already said "yes" and now gets questioned; feels like being second-guessed | Scoping happens before the confirm step, not after — user sees parsed intent + scoping answers together in the confirm display |
| "create PR" accepted after a failed or zero_diff task | User expects a PR, gets an error message about no successful run; confusion | "create PR" command should check `lastCompleted.retryResult.finalStatus === 'success'` before proceeding; show clear message if last task was not successful |
| Post-hoc PR command available but no indication in the REPL prompt or result block | Users never discover the feature exists | Add "  [type 'create pr' to open a pull request]" hint to the result block when `finalStatus === 'success'` and `createPr` was not set |
| Slack bot takes 5+ seconds to respond to "confirm" before starting the agent run | Users think the bot is broken or their click was missed | Slack adapter should respond with an intermediate "Starting agent run..." message immediately when confirm is received, before the agent executes |
| Scoping answers are silently ignored if the user cancels mid-dialogue | User provided 2 of 3 scoping answers, then pressed Ctrl+C; next run re-asks all questions with no memory | Scoping answers are not persisted — this is correct behavior; state clearly that scoping is per-run |

---

## "Looks Done But Isn't" Checklist

Things that appear complete but are missing critical pieces.

- [ ] **Scoping callback:** Verify `SessionCallbacks.scope` is defined and that `processInput()` calls it — NOT that readline is called directly inside `processInput()`; check that removing the readline import from `repl/session.ts` does not break compilation
- [ ] **Post-hoc PR git state check:** Verify that typing "create PR" after running task A then task B against a different repo creates a PR for task A in task A's repo (not task B's) — requires checking `history[last-with-success].intent.repo` not `state.currentProject`
- [ ] **"create PR" meta-command routing:** Verify "create a pull request for the last task" does NOT dispatch an agent session — check that `processInput()` returns before calling `parseIntent` for PR meta-command inputs
- [ ] **Per-user Slack state:** Verify two simultaneous Slack users cannot corrupt each other's `currentProject` — requires a test with two concurrent `processInput()` calls using different user-scoped states
- [ ] **TaskHistoryEntry with result:** Verify `history[n].retryResult` is populated after a successful task completes — not undefined; check `session.test.ts` after `processInput()` returns
- [ ] **Scoping completeness gate:** Verify "rename `getUser` in `src/auth/UserService.ts` to `fetchUser`" does NOT trigger scoping questions — fully-scoped descriptions should pass through without scoping LLM call
- [ ] **Post-hoc PR hint in result block:** Verify the result block shows the "create pr" hint only when `finalStatus === 'success'` and `createPr` was not already set — does not appear for `zero_diff`, `failed`, or cancelled runs
- [ ] **Slack `cwd` fallback blocked:** Verify the Slack adapter never reaches the `usedCwdFallback` path in `parseIntent()` — requires that all Slack inputs either specify a project name or the adapter rejects the message before calling `parseIntent`

---

## Recovery Strategies

When pitfalls occur despite prevention, how to recover.

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Scoping dialogue hardcoded to readline inside session core | HIGH | Audit all `createInterface` calls added to `repl/session.ts`; extract to `SessionCallbacks.scope`; Slack adapter blocked until refactored |
| Post-hoc PR pushed wrong diff (stale git state) | MEDIUM | Close the wrong PR immediately; `git reset --hard` to baseline SHA in affected repo; re-run task; add git state verification before `creator.create()` |
| Slack shared session state corrupted by concurrent users | HIGH | Restart bot process to clear state; per-user state isolation is a rewrite; no partial fix |
| "create PR" input dispatched agent session in Docker | LOW | Session will produce `zero_diff` or `failed`; add meta-command recognizer to `processInput()`; add regression test |
| `TaskHistoryEntry` schema changed without migrating existing session state | LOW | Session state is in-memory only (no persistence across restarts); restart REPL session; no migration needed |

---

## Pitfall-to-Phase Mapping

How roadmap phases should address these pitfalls.

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Scoping readline in session core (breaks Slack) | Conversational scoping phase | `repl/session.ts` has no `createInterface` import; `SessionCallbacks` has `scope` field; unit test exercises scoping via mock callbacks |
| Post-hoc PR pushed with stale git state | Post-hoc PR phase | Test: run task A, run task B in different repo, type "create PR" — should create PR for task A in task A's repo, not task B's |
| "create PR" parsed as agent task | Post-hoc PR phase | Unit test: `processInput("create a pr for that")` does not call `parseIntent`; returns PR result or error message |
| Missing `retryResult` on `TaskHistoryEntry` | Either post-hoc PR or follow-up referencing phase (whichever is first) | After `processInput()` returns success, `state.history[last].retryResult` is defined |
| Slack per-user state isolation | Slack adapter phase | Concurrent-user test: two users in separate invocations do not share `ReplState` |
| Slack cwd fallback | Slack adapter phase | Slack adapter test: message without project name returns clarification request, not cwd-based parse |
| Slack bypasses confirm gate | Slack adapter phase | No Slack message path calls `runAgent()` without first going through `callbacks.confirm` |
| Scoping runs on fully-scoped descriptions | Conversational scoping phase | "rename X in file.ts to Y" does not trigger scoping LLM call; verified by mock counting scoping invocations |
| Cross-task referencing uses wrong history entry | Follow-up referencing phase | "create PR for task 1" in a 3-task session resolves to `history[0]`, not `history[2]` |

---

## Sources

- Direct code analysis: `src/repl/session.ts` (SessionCallbacks contract, processInput flow), `src/repl/types.ts` (ReplState, TaskHistoryEntry, SessionCallbacks), `src/orchestrator/pr-creator.ts` (GitHubPRCreator, git state assumptions), `src/intent/index.ts` (cwd fallback, history follow-up), `src/cli/commands/repl.ts` (readline ownership, confirm callback implementation) — HIGH confidence; first-party source
- `.planning/PROJECT.md` constraints: "Human approval: PRs require human merge — no auto-merge" and "Auto-execute without confirmation — removes human-in-the-loop trust model" are listed as constraints/out-of-scope — HIGH confidence; confirms confirm gate is non-negotiable
- Memory file: `SessionCallbacks injection — Decouples I/O (readline) from session logic — enables CLI, Slack, MCP adapters` — HIGH confidence; established architectural decision

---
*Pitfalls research for: v2.3 Conversational Scoping & REPL Enhancements — adding scoping dialogue, post-hoc PR creation, cross-task follow-up referencing, and Slack bot to existing CLI agent platform*
*Researched: 2026-03-25*
