---
phase: 19-generic-prompt-builder
verified: 2026-03-24T15:30:00Z
status: passed
score: 12/12 must-haves verified
re_verification: false
---

# Phase 19: Generic Prompt Builder Verification Report

**Phase Goal:** Ship a generic prompt builder so that any task not matched to a known category (npm, maven) gets a well-structured end-state prompt with scope fencing, and the confirm loop + PR creator handle generic tasks cleanly.
**Verified:** 2026-03-24T15:30:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| #  | Truth | Status | Evidence |
|----|-------|--------|----------|
| 1  | `buildGenericPrompt(description, repoPath)` returns a prompt string with the user instruction verbatim, a SCOPE block with Do NOT constraints, and an After your changes block | VERIFIED | `src/prompts/generic.ts` lines 22-50; 8/8 unit tests pass in `generic.test.ts` |
| 2  | `buildGenericPrompt` omits the CONTEXT block entirely when `readManifestDeps` returns 'No manifest found' | VERIFIED | `generic.ts` line 39: `if (manifestDeps !== 'No manifest found')`; test "does NOT contain CONTEXT block" passes |
| 3  | `buildGenericPrompt` includes manifest deps in a CONTEXT block when `readManifestDeps` returns dependency info | VERIFIED | `generic.ts` lines 41-45 splice CONTEXT block; test "includes CONTEXT block with deps" passes |
| 4  | `buildPrompt({taskType:'generic', description, repoPath})` dispatches to `buildGenericPrompt` and returns the result | VERIFIED | `src/prompts/index.ts` line 35-37: `case 'generic': return buildGenericPrompt(...)` |
| 5  | Existing npm and maven prompt tests still pass after `buildPrompt` becomes async | VERIFIED | `npm test` shows all 553 tests pass including npm.test.ts (15) and maven.test.ts (14) |
| 6  | Agent index passes `repoPath` to `buildPrompt` and awaits the result | VERIFIED | `src/agent/index.ts` line 170: `const prompt = await buildPrompt({..., repoPath: options.repo})` |
| 7  | User sees `taskCategory` label instead of raw 'generic' on the Task line for generic tasks | VERIFIED | `src/intent/confirm-loop.ts` lines 11-14: `taskLabel = taskCategory ?? 'generic'`; test "shows taskCategory label" passes |
| 8  | User sees an Action line with their instruction text when the task is generic | VERIFIED | `confirm-loop.ts` lines 15-20; test "shows Action line with description text" passes |
| 9  | Action line truncates at 80 characters with ellipsis for long instructions | VERIFIED | `confirm-loop.ts` lines 16-18: `.slice(0, 80) + '...'`; test "truncates description at 80 characters" passes |
| 10 | PR title for generic tasks uses the instruction text instead of 'Agent: generic YYYY-MM-DD' | VERIFIED | `src/orchestrator/pr-creator.ts` lines 471-474; test "PR title for generic task uses description text" passes |
| 11 | PR branch name for generic tasks derives from `taskCategory` + description slug | VERIFIED | `pr-creator.ts` lines 336-338: `\`${taskCategory ?? 'generic'} ${description.slice(0, 40)}\``; test "branch name includes description-derived slug" passes |
| 12 | PR body for generic tasks includes the instruction text and `taskCategory` label | VERIFIED | `pr-creator.ts` lines 389-399: `genericBodyPrefix` prepended to task in `buildPRBody`; tests "PR body includes instruction text" and "includes taskCategory label" pass |

**Score:** 12/12 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/prompts/generic.ts` | `buildGenericPrompt` async function | VERIFIED | Exists, 51 lines, exports `buildGenericPrompt`, imports `readManifestDeps` |
| `src/prompts/generic.test.ts` | Unit tests for buildGenericPrompt and buildPrompt generic dispatch | VERIFIED | 112 lines, 12 test cases, all pass |
| `src/prompts/index.ts` | Async `buildPrompt` with generic case + `repoPath` on `PromptOptions` | VERIFIED | `async function buildPrompt`, `repoPath?: string`, `case 'generic':` all present |
| `src/intent/confirm-loop.ts` | Updated `displayIntent` with generic task display | VERIFIED | Contains `intent.taskType === 'generic'`, `taskCategory ?? 'generic'`, `Action:`, `.slice(0, 80)` |
| `src/intent/confirm-loop.test.ts` | Tests for generic displayIntent behavior | VERIFIED | 351 lines, 8 new generic test cases, 22 total tests pass |
| `src/orchestrator/pr-creator.ts` | Generic-aware PR title, branch naming, and body | VERIFIED | `opts.taskType === 'generic'` conditionals for branch (line 336), title (line 471), body (line 389) |
| `src/orchestrator/pr-creator.test.ts` | Tests for generic PR behavior | VERIFIED | 753 lines, 7 new generic tests, 54 total tests pass |
| `src/agent/index.ts` | `AgentOptions` with `taskCategory`, `creator.create()` passes description and taskCategory | VERIFIED | `taskCategory?: string` in `AgentOptions`, `await buildPrompt` with `repoPath`, `creator.create()` passes both fields |
| `src/cli/commands/one-shot.ts` | Maps `confirmed.taskCategory` to `agentOptions` | VERIFIED | Line 193: `taskCategory: confirmed.taskCategory ?? undefined` |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/prompts/index.ts` | `src/prompts/generic.ts` | `import buildGenericPrompt` | VERIFIED | Line 3: `import { buildGenericPrompt } from './generic.js'` |
| `src/agent/index.ts` | `src/prompts/index.ts` | `await buildPrompt({...repoPath})` | VERIFIED | Line 170: `const prompt = await buildPrompt({..., repoPath: options.repo})` |
| `src/intent/confirm-loop.ts` | `src/intent/types.ts` | `ResolvedIntent.taskCategory` | VERIFIED | `intent.taskCategory` used at line 12 |
| `src/orchestrator/pr-creator.ts` | self | `generateBranchName` with `taskCategory` slug | VERIFIED | Lines 336-339: `branchInput` built from `taskCategory + description.slice(0,40)` |
| `src/agent/index.ts` | `src/orchestrator/pr-creator.ts` | `creator.create()` with `description` and `taskCategory` | VERIFIED | Lines 194-201: both `description: options.description` and `taskCategory: options.taskCategory` present |
| `src/cli/commands/one-shot.ts` | `src/agent/index.ts` | `taskCategory: confirmed.taskCategory` | VERIFIED | Line 193: maps field from `ResolvedIntent` to `AgentOptions` |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| PROMPT-01 | 19-01 | Generic prompt builder constructs end-state prompt from user instruction + repo context (language, build tool, manifest summary) | SATISFIED | `buildGenericPrompt` produces end-state prompt with verbatim instruction; CONTEXT block conditionally injects manifest deps via `readManifestDeps` |
| PROMPT-02 | 19-01 | Generic task system prompt includes explicit scope constraint preventing agent from touching unrelated files | SATISFIED | `generic.ts` lines 25-29: SCOPE block with 4 explicit Do NOT constraints |
| PROMPT-03 | 19-02 | Confirm loop displays instruction summary and planned approach for generic tasks (not just dep/version fields) | SATISFIED | `displayIntent` shows `taskCategory` + Action line with description text; PR creator generates meaningful title/branch/body from instruction |

### Anti-Patterns Found

None detected. Scanned `src/prompts/generic.ts`, `src/prompts/index.ts`, `src/intent/confirm-loop.ts`, `src/orchestrator/pr-creator.ts`, `src/agent/index.ts`, `src/cli/commands/one-shot.ts` for TODO/FIXME/placeholder patterns — clean.

### Human Verification Required

#### 1. Generic task end-to-end flow

**Test:** Run `npm run dev` (or the agent CLI), issue a generic task (e.g. `--task-type generic --description "replace axios with fetch" --create-pr`), and confirm.
**Expected:** Confirm loop shows `code-change` (or resolved category) on Task line and the instruction text on the Action line. If `--create-pr` is set, the created PR title matches the instruction text and the branch name does not start with `agent/generic-`.
**Why human:** The CLI confirm loop involves stdin interaction and terminal output with picocolors formatting — not verifiable programmatically.

#### 2. CONTEXT block injection in real repo

**Test:** Point the agent at a repo with a `package.json` that has real dependencies and issue a generic task. Inspect the prompt sent to Claude.
**Expected:** Prompt contains a `CONTEXT:` block listing the package.json dependencies.
**Why human:** `readManifestDeps` reads the filesystem at runtime. The mock in tests verifies the logic path, but the actual file-reading behaviour in a real repo requires manual confirmation.

---

_Verified: 2026-03-24T15:30:00Z_
_Verifier: Claude (gsd-verifier)_
