---
phase: 27-repo-exploration-tasks
verified: 2026-04-06T19:25:00Z
status: passed
score: 13/13 must-haves verified
re_verification: false
---

# Phase 27: Repo Exploration Tasks Verification Report

**Phase Goal:** Users can ask the agent to investigate a repo (git strategy, CI setup, project structure) and receive a structured report — no code changes, no PR, no verifier run
**Verified:** 2026-04-06T19:25:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `parseIntent("explore the branching strategy")` returns `taskType:'investigation'`, `explorationSubtype:'git-strategy'` | VERIFIED | `src/intent/index.ts` calls `explorationFastPath()` before `fastPathParse()`; test `INV-01` in `index.test.ts` confirms routing; 3 fast-path tests in suite pass |
| 2 | `parseIntent("check the CI setup")` returns `taskType:'investigation'`, `explorationSubtype:'ci-checks'` | VERIFIED | `explorationFastPath` pattern `/\b(?:check\|look\s+at\|show\s+me)\s+(?:the\s+)?(?:ci\|cd\|pipeline\|workflows?)\b/i` matches; `index.test.ts` confirms subtype |
| 3 | `parseIntent("update lodash")` still returns a dependency-update taskType (ACTION_VERB_GUARD blocks) | VERIFIED | `ACTION_VERB_GUARD` regex in `fast-path.ts` fires before exploration patterns; 11 `explorationFastPath` tests pass including action-verb guard cases |
| 4 | `buildPrompt({taskType:'investigation', ...})` dispatches to `buildExplorationPrompt()` with subtype-specific FOCUS section | VERIFIED | `case 'investigation':` in `src/prompts/index.ts` line 44; `exploration.test.ts` verifies all 4 FOCUS sections; 13 prompt tests pass |
| 5 | Investigation tasks bypass RetryOrchestrator, compositeVerifier, llmJudge, and PR creation | VERIFIED | `if (options.taskType === 'investigation')` guard in `src/agent/index.ts` line 136 returns before worktree/orchestrator code; agent tests confirm no RetryOrchestrator instantiated |
| 6 | Investigation tasks do NOT create a worktree — repo mounted directly as :ro | VERIFIED | Docker mount switches to `:ro` via `opts.readOnly ? 'ro' : 'rw'` in `docker/index.ts`; `readOnly: true` passed in investigation bypass block |
| 7 | PreToolUse hook blocks Write/Edit tools with 'blocked: read-only session' message when readOnly is true | VERIFIED | `buildPreToolUseHook` in `claude-code-session.ts` line 50-53 denies Write/Edit; session hook tests confirm deny + allow Bash |
| 8 | REPL prints the full exploration report inline to stdout for investigation tasks | VERIFIED | `if (confirmed.taskType === 'investigation')` block in `session.ts` prints `finalResponse`; INV-01 test verifies `console.log` called with report |
| 9 | REPL does NOT store `lastRetryResult` for investigation tasks | VERIFIED | Investigation branch skips `state.lastRetryResult = result`; INV-02 test confirms `state.lastRetryResult` undefined after investigation |
| 10 | Slack does NOT force `createPr=true` for investigation tasks | VERIFIED | Guard `if (intent.taskType !== 'investigation')` in `adapter.ts` line 141; `createPr: false` in agentOptions for investigation |
| 11 | Slack posts the full exploration report as a thread message for investigation tasks | VERIFIED | `if (confirmed.taskType === 'investigation')` branch in `adapter.ts` line 216 posts `finalResponse` via `chat.postMessage`; adapter tests verify |
| 12 | When input contains 'save', report written to `.reports/<timestamp>-<subtype>.md` host-side | VERIFIED | `/\bsave\b/i.test(trimmed)` check in `session.ts` with `fs.mkdirSync` + `fs.writeFileSync`; INV-06 test uses real tmpDir to confirm file written |
| 13 | Investigation history entries record description from user input | VERIFIED | History ternary in `session.ts` and `adapter.ts` includes `'investigation'` alongside `'generic'`; INV-04 / adapter test confirm description populated |

**Score:** 13/13 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/intent/types.ts` | `'investigation'` in TASK_TYPES, `ExplorationSubtype` type, `explorationSubtype` on `ResolvedIntent` | VERIFIED | Line 4: `'investigation'` as 4th element; line 9: `ExplorationSubtype` type; line 53: `explorationSubtype?: ExplorationSubtype` |
| `src/intent/fast-path.ts` | `EXPLORATION_PATTERNS`, `ACTION_VERB_GUARD`, `explorationFastPath()` | VERIFIED | Lines 35-61: all three exported and substantive |
| `src/prompts/exploration.ts` | `buildExplorationPrompt()` with 4-subtype SUBTYPES registry | VERIFIED | SUBTYPES record with git-strategy, ci-checks, project-structure, general; CONSTRAINTS + OUTPUT sections present |
| `src/prompts/index.ts` | `case 'investigation':` in buildPrompt switch | VERIFIED | Line 44: `case 'investigation':` dispatches to `buildExplorationPrompt`; `explorationSubtype?: string` in PromptOptions |
| `src/intent/index.ts` | `explorationFastPath()` called before `fastPathParse()` | VERIFIED | Line 45: `const explorationResult = explorationFastPath(input)` — precedes `fastPathParse` on line 61 |
| `src/intent/llm-parser.ts` | `'investigation'` in `INTENT_SYSTEM_PROMPT` and auto-propagated to `OUTPUT_SCHEMA` | VERIFIED | Line 21: 'investigation' guidance in system prompt; `OUTPUT_SCHEMA` spreads `[...TASK_TYPES]` so auto-propagates |
| `src/types.ts` | `readOnly?: boolean` on `SessionConfig` | VERIFIED | Line 10: `readOnly?: boolean;` present |
| `src/cli/docker/index.ts` | `readOnly?: boolean` on `DockerRunOptions`, `:ro` mount when true | VERIFIED | Line 52: field present; line 80: `opts.readOnly ? 'ro' : 'rw'` |
| `src/orchestrator/claude-code-session.ts` | `buildPreToolUseHook` accepts `readOnly`, blocks Write/Edit | VERIFIED | Line 35: signature includes `readOnly?: boolean`; line 53: `'blocked: read-only session'` message |
| `src/agent/index.ts` | `explorationSubtype?: string` on `AgentOptions`, investigation bypass block | VERIFIED | Line 51: field present; lines 136-161: bypass block with `readOnly: true` |
| `src/repl/session.ts` | Investigation report display, `.reports/` save | VERIFIED | Lines 276-293: investigation block with report print, save guard, and fallback warning |
| `src/slack/adapter.ts` | createPr guard, report posting for investigation | VERIFIED | Lines 141-143: guard; lines 216-220: report posting |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/intent/index.ts` | `src/intent/fast-path.ts` | `explorationFastPath(trimmed)` called before `fastPathParse` | WIRED | `explorationFastPath(input)` at line 45, `fastPathParse` at line 61 |
| `src/prompts/index.ts` | `src/prompts/exploration.ts` | `case 'investigation'` dispatches to `buildExplorationPrompt()` | WIRED | Import on line 4; export on line 5; dispatch in switch at line 48 |
| `src/intent/types.ts` | `src/intent/llm-parser.ts` | `TASK_TYPES` spread auto-propagates `'investigation'` to `OUTPUT_SCHEMA` | WIRED | `[...TASK_TYPES]` in OUTPUT_SCHEMA; confirmed by llm-parser test |
| `src/agent/index.ts` | `src/orchestrator/claude-code-session.ts` | Creates `ClaudeCodeSession` with `readOnly: true` for investigation | WIRED | Line 144-151: `new ClaudeCodeSession({..., readOnly: true})` |
| `src/orchestrator/claude-code-session.ts` | `src/cli/docker/index.ts` | Passes `readOnly` to `buildDockerRunArgs` | WIRED | Line 338: `readOnly: this.config.readOnly` in buildDockerRunArgs call |
| `src/cli/docker/index.ts` | Docker mount | `:ro` suffix on workspace volume when `readOnly: true` | WIRED | Line 80: `:${opts.readOnly ? 'ro' : 'rw'}` |
| `src/repl/session.ts` | `finalResponse` on `SessionResult` | `result.sessionResults.at(-1)?.finalResponse` for report content | WIRED | Line 277: `result.sessionResults.at(-1)?.finalResponse` |
| `src/repl/session.ts` | `.reports/` directory | `fs.mkdirSync` + `fs.writeFileSync` when `/\bsave\b/i` matches input | WIRED | Lines 283-288: mkdirSync with recursive; writeFileSync with timestamp-subtype filename |
| `src/slack/adapter.ts` | `finalResponse` on `SessionResult` | Posts `finalResponse` as thread message | WIRED | Line 217: `result.sessionResults.at(-1)?.finalResponse` |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| EXPLR-01 | 27-01 | Intent parser recognizes exploration intents and routes to `investigation` task type | SATISFIED | `explorationFastPath()` in fast-path.ts + index.ts coordinator; 41 intent tests pass including 3 exploration fast-path tests |
| EXPLR-02 | 27-01 | Structured exploration prompts with subtypes: git-strategy, ci-checks, project-structure (+ general) | SATISFIED | `buildExplorationPrompt` with 4-subtype SUBTYPES registry; 13 exploration prompt tests pass; REQUIREMENTS.md says 3 subtypes, code ships 4 (general is a valid superset) |
| EXPLR-03 | 27-02 | Exploration tasks skip composite verifier, LLM Judge, and PR creation — return report via finalResponse | SATISFIED | Investigation bypass block in `runAgent` returns before verifier/judge/PR; `verificationResults: []` in return; agent tests confirm no orchestrator instantiation |
| EXPLR-04 | 27-02 | PreToolUse hook blocks Write/Edit/destructive tools when session is read-only | SATISFIED | `buildPreToolUseHook` denies Write and Edit with 'blocked: read-only session'; Bash allowed; :ro mount enforces OS-level; session hook tests verify |
| EXPLR-05 | 27-03 | Exploration report displayed inline in REPL and posted as thread message in Slack | SATISFIED | REPL: `console.log('\n' + report + '\n')` in investigation block; Slack: `chat.postMessage({text: report})` in investigation branch; 7 REPL + 6 Slack tests pass |

No orphaned requirements: all EXPLR-01 through EXPLR-05 are claimed by plans and verified as implemented. EXPLR-06 and EXPLR-07 are listed as future in REQUIREMENTS.md and are not in scope for this phase.

### Anti-Patterns Found

No anti-patterns detected in any modified production files.

One TypeScript warning exists in `src/repl/session.test.ts` (line 1304): implicit `any` type on parameter `c` in `.map(c => c.join(' '))`. This is in a test file only, not production source. All 786 tests pass and `tsc --noEmit` produces zero errors in production source.

### Human Verification Required

#### 1. Real exploration report quality in Docker

**Test:** Run `bg> explore the branching strategy` against an actual repo with Docker running.
**Expected:** Claude agent reads git log, lists branches, produces a structured markdown report with sections: Branch Overview, Merge Strategy, Workflow Summary. No files modified in the repo.
**Why human:** Cannot verify LLM-produced report quality or actual Docker :ro enforcement without running the container.

#### 2. .reports/ save roundtrip

**Test:** Run `bg> explore the CI setup and save it` in REPL with Docker running.
**Expected:** Report printed to stdout AND `.reports/<timestamp>-ci-checks.md` file created in the target repo directory.
**Why human:** INV-06 test uses a tmpDir fixture but cannot replicate the full REPL+Docker integration.

#### 3. Slack thread message formatting

**Test:** Mention the bot with "explore the project structure" in a Slack channel.
**Expected:** Bot posts the full markdown report as a thread reply. Bot does NOT post a PR link. `createPr` remains false.
**Why human:** Slack integration requires live webhook; cannot verify real thread posting programmatically.

### Gaps Summary

No gaps. All 13 truths verified, all 5 requirements satisfied, all key links wired, no production anti-patterns, 786/786 tests passing, TypeScript clean on production sources.

---

_Verified: 2026-04-06T19:25:00Z_
_Verifier: Claude (gsd-verifier)_
