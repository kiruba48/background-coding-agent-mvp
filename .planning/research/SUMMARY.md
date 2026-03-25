# Project Research Summary

**Project:** background-coding-agent v2.3
**Domain:** Conversational coding agent — REPL enhancements, Slack bot interface, cross-task follow-up referencing
**Researched:** 2026-03-25
**Confidence:** HIGH

## Executive Summary

The v2.3 milestone adds four features to an already-operational CLI coding agent (v2.2): REPL post-hoc PR creation, conversational scoping dialogue for generic tasks, follow-up task referencing via enriched session history, and a Slack bot adapter. All four features share a single architectural insight: the existing `SessionCallbacks` injection pattern is the correct extension point. The session core (`processInput()`) is channel-agnostic by design, and all four features either add optional callbacks to that interface or enrich the in-memory `ReplState` / `TaskHistoryEntry` types. No new backend infrastructure is required — the addition of `@slack/bolt@^4.6.0` is the only new dependency.

The recommended build order is strictly dictated by data dependencies: post-hoc PR creation first (establishes `ReplState.lastResult` / `TaskHistoryEntry` enrichment and the meta-command intercept pattern), then scoping dialogue (adds `SessionCallbacks.askQuestion` and `buildGenericPrompt` extension), then follow-up referencing (enriches the LLM history block with `finalResponse` already captured in Phase 1), and finally the Slack adapter (depends on all callbacks being stable). Deviating from this order — particularly building the Slack adapter before the callbacks are finalized — creates rework risk.

The most dangerous pitfalls are not technical complexity but architectural discipline: scoping I/O must never be hardcoded inside the session core (breaks Slack), "create PR" typed in the REPL must be intercepted before the intent parser (or it dispatches a Docker agent session), and the Slack adapter must create per-user `ReplState` instances (shared state causes cross-user corruption). All three are avoidable with correct initial design, but all three have high recovery cost if caught late. The research unanimously points to the `SessionCallbacks` abstraction as the safeguard against all of them.

---

## Key Findings

### Recommended Stack

The v2.3 stack is the v2.2 stack plus one package. The existing Node.js 20 / TypeScript (NodeNext ESM) / Vitest / `@anthropic-ai/claude-agent-sdk` stack is validated and not re-researched. The single new production dependency is `@slack/bolt@^4.6.0` (released 2025-10-28), which ships `@slack/socket-mode` and `@slack/web-api` as bundled dependencies — no separate installs needed. One dev dependency, `@types/express@^5.0.0`, is required as a peer dependency for TypeScript type resolution.

Socket Mode is the correct Bolt receiver for an internal tool: it requires no public HTTPS URL, no reverse proxy, and no ngrok. An app-level token with `connections:write` scope opens a WebSocket to Slack — the official Slack docs explicitly recommend Socket Mode for non-marketplace internal apps. All other v2.3 changes are pure TypeScript logic against existing modules.

**Core technologies:**
- `@slack/bolt@^4.6.0`: Slack bot framework — Socket Mode, Block Kit interactive messages, bundled WebSocket lifecycle management
- `@types/express@^5.0.0` (devDep): Peer dependency for Bolt type resolution — required even when not using the HTTP receiver
- All other packages: no version changes from v2.2

**Critical version requirements:**
- `@slack/bolt@^4.6.0` requires Node.js >=18; project is Node.js 20 — compatible
- CJS/ESM interop works via `esModuleInterop: true` already set in `tsconfig.json`; named `import { App } from '@slack/bolt'` confirmed in official Bolt TypeScript starter template

### Expected Features

All four v2.3 features are P1 (required for milestone) — none are deferred to v2.3.x at launch. Research validates them as "table stakes" for a multi-turn conversational agent REPL.

**Must have (table stakes — v2.3):**
- Post-hoc PR creation via `pr` / `create pr` REPL command — store last `RetryResult` context on `ReplState` / `TaskHistoryEntry` and invoke `GitHubPRCreator` without requiring upfront `--create-pr` flag
- Follow-up task referencing — `TaskHistoryEntry` enriched with `description` / `finalResponse` so "also do this in the auth module" and "create PR for that" resolve correctly via the LLM intent parser
- Conversational scoping dialogue — up to 3 optional pre-confirm questions for `generic` tasks (file scope, test updates, exclusions); answers injected into `buildGenericPrompt` SCOPE block
- Slack bot adapter — `@slack/bolt` App with Socket Mode, `app_mention` listener, Block Kit confirm buttons, async fire-and-forget execution, threaded PR link reply

**Should have (v2.3.x after validation):**
- Scoping answers shown in the confirm display so users can see the merged scope before proceeding
- `pr` command shows task summary before creating PR to prevent confusion in long sessions

**Defer (v2.4+):**
- Multiple concurrent pending Slack confirmations keyed by user ID (current in-memory map sufficient for initial deployment)
- Persistent Slack conversation history across bot restarts (requires database; adds operational complexity)
- Dynamic per-task scoping questions generated by LLM (adds API call on critical path; fixed questions cover the useful space)

**Anti-features (reject explicitly):**
- Auto-execute Slack intents without a confirm step — violates the human-in-the-loop contract in PROJECT.md
- Scoping dialogue for dependency update tasks — already fully parameterized; adding questions introduces friction for no benefit
- Persistent cross-session history — explicitly rejected in project memory; stale context causes misparses
- Mid-run agent redirection via Slack — no input channel into the Docker container; breaks isolation invariant

### Architecture Approach

v2.3 is purely additive. The session core (`processInput()` in `src/repl/session.ts`) acquires four changes: a `pr` meta-command intercept before `parseIntent()`, a `runScopingDialogue()` call after confirm for generic tasks, `state.lastResult` population after successful runs, and enriched `appendHistory()` with `RetryResult` context. All four are changes of roughly 10-40 lines each. The `SessionCallbacks` interface gains three optional methods (`askQuestion`, `onMessage`, `onPrCreated`). The `buildGenericPrompt()` function gains one optional parameter (`scopeHints`). A new `src/slack/` directory implements `SessionCallbacks` for Slack — the entire orchestration, agent execution, verifier, judge, and PR creator layers are completely unchanged.

**Major components and responsibilities:**
1. **`src/repl/scoping.ts` (new)** — Owns the scope question-answer loop; pure function taking `ResolvedIntent` + `SessionCallbacks`, returning `ScopingResult`; testable with mock callbacks
2. **`src/slack/` (new directory)** — `adapter.ts` implements `SessionCallbacks` for Slack (Block Kit, thread replies, `ack()` + async fire-and-forget); `bot.ts` owns event listeners and per-user `ReplState` map; `state.ts` manages per-channel/user state lifecycle
3. **`src/repl/types.ts` (modified)** — Three additive changes: `ReplState.lastResult: LastTaskContext | null`, optional fields on `TaskHistoryEntry` (`finalResponse?`, `branch?`), optional methods on `SessionCallbacks` (`askQuestion?`, `onMessage?`, `onPrCreated?`)
4. **`src/repl/session.ts` (modified)** — `pr` command intercept, `runScopingDialogue()` call, `lastResult` storage, enriched `appendHistory()` — ~50 lines total
5. **`src/prompts/generic.ts` (modified)** — `buildGenericPrompt(description, repoPath?, scopeHints?)` gains optional third parameter; backward compatible

**Key patterns to follow:**
- All new I/O goes through `SessionCallbacks` — never import `readline` or call Slack APIs inside the session core
- New `SessionCallbacks` methods are always optional (`?`) with graceful degradation (scoping skipped if `askQuestion` absent)
- New `ReplState` / `TaskHistoryEntry` fields are always nullable or optional — no required new fields that break existing state initialization
- Meta-commands (`pr`, `create pr`) are intercepted before `parseIntent()` — same pattern as `history`, `exit`

### Critical Pitfalls

1. **Scoping dialogue hardcoded to `readline` inside `processInput()`** — If scoping questions call `readline` directly in `repl/session.ts`, the Slack adapter cannot reuse `processInput()`. Prevention: all scoping I/O goes through `callbacks.askQuestion?`; verify no `createInterface` import in `repl/session.ts`.

2. **"create PR" input dispatched as a Docker agent session** — "create a PR for that" typed in the REPL will be classified by the intent parser as a generic coding task and dispatched into Docker, where the agent finds nothing to change and returns `zero_diff`. Prevention: pattern-match on PR meta-command variants before `parseIntent()` is called; never route these phrases through the intent parser.

3. **Shared `ReplState` across concurrent Slack users** — A single `ReplState` instance for the bot process means user A's `currentProject` is overwritten by user B's task. Prevention: `Map<userId, ReplState>` created per incoming Slack message; `createSessionState()` called per user, not at module load.

4. **Post-hoc PR pushed with stale git state** — Storing `RetryResult` on `state.lastResult` after task A, then running task B in a different repo, leaves `lastResult` pointing to task A's result but the workspace reflecting task B's commits. Prevention: verify git HEAD against the session result's baseline before calling `GitHubPRCreator`; refuse with a clear message if workspace has diverged.

5. **`TaskHistoryEntry` schema split between post-hoc PR and follow-up referencing** — If Phase 1 stores `RetryResult` only on `state.lastResult` (separate from history) and Phase 3 extends `TaskHistoryEntry` separately, there are two sources of truth that can diverge. Prevention: extend `TaskHistoryEntry` with `retryResult?` and `intent?` in Phase 1; make `state.lastResult` a reference to `history[last]` rather than a parallel field.

---

## Implications for Roadmap

Based on combined research, the phase structure is dictated primarily by data model dependencies and the need to establish correct architectural patterns before building the Slack adapter.

### Phase 1: Post-Hoc PR Creation and State Foundation

**Rationale:** Most self-contained feature with no new callbacks. Establishes the `state.lastResult` / `TaskHistoryEntry` enrichment that every other feature depends on. Also establishes the meta-command intercept pattern that prevents "create PR" from being routed to the intent parser — a critical safety fix that must exist before the Slack adapter is built. Lowest implementation risk.

**Delivers:** `pr` / `create pr` REPL command; `ReplState.lastResult` storage; `TaskHistoryEntry` extended with `retryResult?` and `intent?`; `onPrCreated` callback in CLI adapter; meta-command recognizer before `parseIntent()`; git state verification guard before `GitHubPRCreator` call

**Addresses:** Post-hoc PR creation (P1 feature), follow-up task referencing foundation (P1 feature)

**Avoids:** "create PR" parsed as agent task (Pitfall 6); `TaskHistoryEntry` schema divergence between features (Pitfall 8); stale git state on post-hoc PR push (Pitfall 2)

### Phase 2: Conversational Scoping Dialogue

**Rationale:** Adds `SessionCallbacks.askQuestion?` — the new optional callback that the Slack adapter must implement. Building scoping before the Slack adapter ensures the callback interface is stable when the adapter is written. `buildGenericPrompt` extension is backward-compatible. `runScopingDialogue()` is a pure function testable with mock callbacks.

**Delivers:** `src/repl/scoping.ts` with `runScopingDialogue()`; `SessionCallbacks.askQuestion?`; `buildGenericPrompt(description, repoPath?, scopeHints?)` extension; CLI adapter `askQuestion` implementation via readline; completeness gate to skip scoping for already-scoped descriptions (file path + symbol present)

**Addresses:** Conversational scoping dialogue (P1 feature)

**Avoids:** Scoping readline in session core breaking Slack (Pitfall 1); scoping LLM call on every generic task regardless of completeness (Pitfall 5)

### Phase 3: Follow-Up Task Referencing Enrichment

**Rationale:** Low-risk enrichment of existing `TaskHistoryEntry`. The `finalResponse` field is populated from `RetryResult` already stored in history by Phase 1. The LLM history block change in `llm-parser.ts` is purely additive. Placing this before the Slack adapter ensures enriched history context is available in all channels from day one.

**Delivers:** `TaskHistoryEntry.finalResponse?` populated via enriched `appendHistory()`; `buildHistoryBlock()` includes agent change summary in LLM context; `id` field on history entries for positional follow-up reference resolution ("task 2", "the auth task")

**Addresses:** Follow-up task referencing (P1 feature)

**Avoids:** Cross-task referencing using wrong history entry (Pitfall 3); follow-up references always defaulting to `history[last]` regardless of user's actual intent

### Phase 4: Slack Bot Adapter

**Rationale:** Depends on all `SessionCallbacks` additions being complete and stable (Phases 1-3). The adapter is a new directory with zero modifications to existing code — purely additive. Building last means the CLI REPL is fully functional and testable throughout the milestone; Slack is an additional channel that shares the same core pipeline.

**Delivers:** `src/slack/` directory (`adapter.ts`, `bot.ts`, `state.ts`); `@slack/bolt` integration with Socket Mode; per-user `ReplState` isolation keyed by Slack user ID; Block Kit confirm buttons with Approve/Cancel; async fire-and-forget execution with `ack()` + background agent run; threaded PR link reply; `MAX_INPUT_LENGTH` check at adapter entry point; explicit project required (no `cwd` fallback)

**Addresses:** Slack bot interface (P1 feature)

**Avoids:** Shared session state across concurrent Slack users (Pitfall 4); Slack bypassing the confirm-before-execute gate (Pitfall 7); `cwd` fallback in Slack context (Pitfall 4 variant); Slack message body without length check (security)

### Phase Ordering Rationale

- Phase 1 must come first: the meta-command intercept pattern and `TaskHistoryEntry` schema extension are foundations that all subsequent phases build on. Getting the schema right in Phase 1 prevents the two-source-of-truth pitfall that would require rework in Phases 3 and 4.
- Phase 2 must come before Phase 4: the `SessionCallbacks.askQuestion?` interface must be finalized before the Slack adapter implements it.
- Phase 3 is logically dependent on Phase 1 (`finalResponse` flows from `RetryResult` stored in Phase 1) but independent of Phase 2; sequential ordering is safer than parallel.
- Phase 4 last: no architectural choice here — the Slack adapter requires all callbacks to be stable, and requires the correct per-user `ReplState` management patterns established in Phases 1-3.

### Research Flags

Phases with well-documented patterns (skip research-phase):
- **Phase 1 (Post-Hoc PR):** All integration points verified in source. Architecture document provides exact type signatures and data flows. Meta-command intercept follows established `history` / `exit` pattern.
- **Phase 2 (Scoping Dialogue):** `runScopingDialogue()` is a pure function. Completeness gate uses a cheap lexical heuristic (presence of file path + symbol name) — no LLM call needed.
- **Phase 3 (Follow-Up Referencing):** `buildHistoryBlock()` change is additive. `finalResponse` truncated to 300 chars to avoid bloating the LLM context. Standard enrichment pattern.

Phases likely needing deeper research during planning:
- **Phase 4 (Slack Adapter):** The Block Kit interactive confirmation flow — pending intent storage, `ack()` + async execution pattern, button action correlation with `message_ts` — has more surface area than the other phases. The 3-second ack constraint means the agent run cannot be awaited inside the action handler; the fire-and-forget pattern needs a careful test harness. Recommend targeted research on Bolt action handler patterns and timeout/expiry handling before implementation begins.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | npm registry live checks confirm `@slack/bolt@4.6.0`; official Slack docs and bolt-ts-starter-template confirm Socket Mode + ESM interop; no speculation |
| Features | HIGH | Four features directly from project memory and PROJECT.md milestone spec; interaction patterns validated against official Slack docs and arXiv scoping research (MAC Framework) |
| Architecture | HIGH | All integration points verified by direct first-party codebase inspection; exact type signatures and data flows documented in ARCHITECTURE.md; build order validated by dependency analysis |
| Pitfalls | HIGH | Derived from direct code analysis of v2.2 source; each pitfall identifies the specific file and line-level mistake; prevention strategies verified against established architectural decisions in project memory |

**Overall confidence:** HIGH

### Gaps to Address

- **Scoping completeness gate threshold:** Research recommends a lexical heuristic (file path present? symbol named?) but the exact threshold is not specified. Implementation should start conservative (skip scoping only if both file path AND symbol name are present) and adjust based on real usage.
- **`filesChanged` field on `TaskHistoryEntry`:** Architecture research explicitly defers this — it requires a `git diff --name-only` call after the agent run, adding async work to `appendHistory()`. The `finalResponse` field covers most follow-up reference cases without it. Mark as deferred to a follow-up iteration.
- **Slack session garbage collection:** Per-user `ReplState` instances accumulate in the in-memory `Map`. An eviction strategy (TTL after N minutes of inactivity) is noted in pitfalls research but not fully specified. Decide on eviction TTL before the Slack adapter ships.
- **Scoping dialogue intentionally skipped in Slack v2.3:** Features research explicitly defers scoping questions for the Slack adapter in v2.3 — generic tasks use auto-detected scope only. The optional `callbacks.askQuestion?` design ensures the Slack adapter works correctly without implementing this callback. Document this as a known v2.3 limitation.

---

## Sources

### Primary (HIGH confidence)
- `src/repl/session.ts`, `src/repl/types.ts`, `src/cli/commands/repl.ts`, `src/orchestrator/pr-creator.ts`, `src/prompts/generic.ts`, `src/intent/llm-parser.ts` — live codebase, all v2.3 integration surfaces
- npm registry live: `npm show @slack/bolt version` → 4.6.0; `npm show @slack/bolt engines` → Node.js >=18; bundled deps confirmed
- [Slack Bolt Socket Mode docs](https://docs.slack.dev/tools/bolt-js/concepts/socket-mode/) — Socket Mode init pattern, no public URL needed
- [Slack: Acknowledging requests](https://docs.slack.dev/tools/bolt-js/concepts/acknowledge/) — 3-second ack constraint, ack-then-process pattern
- [Slack: Comparing HTTP and Socket Mode](https://docs.slack.dev/apis/events-api/comparing-http-socket-mode/) — Socket Mode recommended for private tools
- [bolt-ts-starter-template package.json](https://raw.githubusercontent.com/slack-samples/bolt-ts-starter-template/main/package.json) — `"type": "module"` + `@slack/bolt@^4.6.0` + TypeScript confirmed working
- `.planning/PROJECT.md` — v2.3 milestone spec, confirmed constraints (no auto-execute, human-in-the-loop non-negotiable)
- Project memory files: `project_repl_post_hoc_pr.md`, `project_generic_task_prompts.md`, `project_conversational_interface.md`

### Secondary (MEDIUM confidence)
- [MAC Framework: Multi-Agent Clarification (arXiv 2512.13154)](https://arxiv.org/pdf/2512.13154) — 2-3 targeted questions is optimal for clarification dialogues; diminishing returns beyond that
- [Anthropic: 2026 Agentic Coding Trends Report](https://resources.anthropic.com/hubfs/2026%20Agentic%20Coding%20Trends%20Report.pdf) — context continuity and follow-up capability as top developer expectations
- [EclipseSource: Structured AI Coding with Task Context](https://eclipsesource.com/blogs/2025/07/01/structure-ai-coding-with-task-context/) — task context persistence patterns
- [Knock: Creating interactive Slack apps with Bolt and Node.js](https://knock.app/blog/creating-interactive-slack-apps-with-bolt-and-nodejs) — practical Bolt Block Kit patterns

---

*Research completed: 2026-03-25*
*Ready for roadmap: yes*
