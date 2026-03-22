---
phase: 15-intent-parser-one-shot-mode
verified: 2026-03-20T15:25:00Z
status: passed
score: 16/16 must-haves verified
re_verification: false
gaps: []
---

# Phase 15: Intent Parser + One-Shot Mode Verification Report

**Phase Goal:** Build intent parser that converts natural language to structured TaskConfig, with fast-path regex for obvious patterns and LLM fallback for ambiguous inputs; add one-shot CLI mode
**Verified:** 2026-03-20T15:25:00Z
**Status:** passed
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Fast-path resolves "update recharts" into structured intent without LLM call | VERIFIED | `fastPathParse()` regex in `src/intent/fast-path.ts:11-25`; coordinator calls LLM only on fallthrough; 22 fast-path tests pass |
| 2 | Fast-path resolves "update recharts to 2.15.0" with explicit version | VERIFIED | regex captures named group `version`; returns `{ dep: "recharts", version: "2.15.0", project: null }` |
| 3 | Fast-path extracts project name from "update recharts in myapp" | VERIFIED | regex captures named group `project`; test coverage in `fast-path.test.ts` |
| 4 | Fast-path falls through to null when dep not found in manifest | VERIFIED | `validateDepInManifest()` checks both `package.json` and `pom.xml`; returns `false` when not found, coordinator falls through to LLM |
| 5 | Context scanner reads package.json dependencies and devDependencies | VERIFIED | `readManifestDeps()` in `src/intent/context-scanner.ts:9-40`; reads both keys |
| 6 | Context scanner reads pom.xml dependency artifactIds (not project artifactId) | VERIFIED | Uses `/<dependency>[\s\S]*?<\/dependency>/g` scoped matching; 8 context-scanner tests pass |
| 7 | Context scanner returns "No manifest found" when neither file exists | VERIFIED | `src/intent/context-scanner.ts:39`: returns "No manifest found" when sections array is empty |
| 8 | LLM parser calls Haiku 4.5 with beta.messages.create() structured output and returns IntentResult | VERIFIED | `src/intent/llm-parser.ts:44-56`; model `claude-haiku-4-5-20251001`, betas `structured-outputs-2025-11-13`; 8 llm-parser tests pass |
| 9 | LLM parser version field constrained to "latest" or null — never a real version string | VERIFIED | IntentSchema uses `z.enum(['latest']).nullable()`; ZodError test confirmed in `llm-parser.test.ts` |
| 10 | LLM parser receives manifest context from context scanner before making API call | VERIFIED | `src/intent/index.ts:75-76`: `readManifestDeps(repoPath)` called before `llmParse(input, manifestContext)`; test asserts ordering |
| 11 | Confirm loop displays parsed intent as compact summary block | VERIFIED | `displayIntent()` in `src/intent/confirm-loop.ts:6-14`; prints task, project, dep, version via picocolors |
| 12 | Confirm loop accepts Y/Enter to proceed, handles "n" + correction, aborts after 3 redirects | VERIFIED | `confirmLoop()` in `src/intent/confirm-loop.ts:16-60`; `maxRedirects = 3`; 10 confirm-loop tests pass |
| 13 | Prompt builders handle "latest" sentinel correctly | VERIFIED | `buildNpmPrompt` and `buildMavenPrompt` both branch on `targetVersion === 'latest'`; `buildPrompt` defaults `targetVersion ?? 'latest'` |
| 14 | User can run `bg-agent 'update recharts'` and receive parsed intent before agent run | VERIFIED | `src/cli/index.ts:15,57-72`; `.argument('[input]', ...)` added; positional input routes to `oneShotCommand()` |
| 15 | Existing flag-based invocation still works | VERIFIED | `src/cli/index.ts:74-176`; `-t` and `-r` changed from `.requiredOption` to `.option`; legacy path preserved when `!input && taskType && repo` |
| 16 | `bg-agent projects list` still routes to projects subcommand | VERIFIED | `src/cli/index.ts:178`; `program.addCommand(createProjectsCommand())` before `program.parse()` |

**Score:** 16/16 truths verified

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/intent/types.ts` | IntentResult, FastPathResult, ResolvedIntent, ClarificationOption, IntentSchema | VERIFIED | All 5 exports present; IntentSchema uses `z.enum(['latest']).nullable()` for version |
| `src/intent/fast-path.ts` | fastPathParse(), validateDepInManifest(), detectTaskType() | VERIFIED | All 3 functions exported; substantive regex, manifest file reads, and fs.access checks |
| `src/intent/context-scanner.ts` | readManifestDeps() | VERIFIED | Exported; reads both package.json and pom.xml with dependency-block scoping |
| `src/intent/llm-parser.ts` | llmParse() via Haiku 4.5 structured output | VERIFIED | Exported; calls `beta.messages.create`, IntentSchema.parse, 15s timeout |
| `src/intent/confirm-loop.ts` | confirmLoop(), displayIntent() | VERIFIED | Both exported; readline interface with SIGINT handler and finally { rl.close() } |
| `src/intent/index.ts` | parseIntent() coordinator + re-exports | VERIFIED | parseIntent exported; re-exports ResolvedIntent, IntentResult, fastPathParse, readManifestDeps, llmParse, confirmLoop, displayIntent |
| `src/cli/commands/one-shot.ts` | oneShotCommand() handler | VERIFIED | Exported; wires parseIntent → promptClarification → confirmLoop → runAgent; resolveRepoInteractively present |
| `src/cli/index.ts` | Modified with .argument('[input]') and routing fork | VERIFIED | `.argument('[input]', ...)` at line 15; positional NL path at lines 57-72; legacy path at lines 74-176 |
| `src/prompts/npm.ts` | "latest" sentinel handling | VERIFIED | `isLatest` branch; "latest available version" text present |
| `src/prompts/maven.ts` | "latest" sentinel handling | VERIFIED | Same pattern as npm.ts |
| `src/prompts/index.ts` | `options.targetVersion ?? 'latest'` for both dep types | VERIFIED | Both npm-dependency-update and maven-dependency-update cases use `?? 'latest'` |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/intent/fast-path.ts` | `src/intent/types.ts` | `import FastPathResult` | VERIFIED | Line 3: `import type { FastPathResult } from './types.js'` |
| `src/intent/context-scanner.ts` | `package.json` / `pom.xml` | `fs.readFile at repoPath` | VERIFIED | Lines 14, 27: reads both; pom.xml uses `/<dependency>[\s\S]*?<\/dependency>/g` |
| `src/intent/llm-parser.ts` | `@anthropic-ai/sdk` | `beta.messages.create()` | VERIFIED | Line 44: `client.beta.messages.create({...})` with structured output |
| `src/intent/llm-parser.ts` | `src/intent/types.ts` | `IntentSchema.parse()` | VERIFIED | Line 59: `return IntentSchema.parse(JSON.parse(text))` |
| `src/intent/confirm-loop.ts` | `node:readline/promises` | `createInterface for Y/n` | VERIFIED | Line 1: `import { createInterface } from 'node:readline/promises'`; line 21: `createInterface({ input: process.stdin, ... })` |
| `src/cli/index.ts` | `src/cli/commands/one-shot.ts` | dynamic import oneShotCommand | VERIFIED | Line 58: `const { oneShotCommand } = await import('./commands/one-shot.js')` |
| `src/cli/commands/one-shot.ts` | `src/intent/index.ts` | `parseIntent()` call | VERIFIED | Line 1: `import { parseIntent, confirmLoop, fastPathParse } from '../../intent/index.js'`; lines 131, 143, 156 |
| `src/cli/commands/one-shot.ts` | `src/intent/confirm-loop.ts` | `confirmLoop()` call | VERIFIED | Line 153: `const confirmed = await confirmLoop(intent, ...)` |
| `src/cli/commands/one-shot.ts` | `src/agent/index.ts` | `runAgent()` call after confirmation | VERIFIED | Line 186: `const result = await runAgent(agentOptions, agentContext)` |
| `src/intent/index.ts` | `src/intent/fast-path.ts` | `fastPathParse()` call | VERIFIED | Line 40: `const fastResult = fastPathParse(input)` |
| `src/intent/index.ts` | `src/intent/llm-parser.ts` | `llmParse()` LLM fallback | VERIFIED | Line 76: `const llmResult = await llmParse(input, manifestContext)` |

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| INTENT-01 | 15-01, 15-02, 15-03 | User can describe a task in natural language and get structured intent (task type, repo, dep, version) | SATISFIED | `parseIntent()` coordinator returns `ResolvedIntent` with all 4 fields; 423/423 tests pass |
| INTENT-02 | 15-01, 15-03 | Obvious patterns resolved via fast-path heuristic without LLM call | SATISFIED | `fastPathParse()` regex handles "update|upgrade|bump X [to Y] [in Z]"; coordinator skips LLM when dep in manifest and task type detected |
| INTENT-03 | 15-01, 15-02, 15-03 | Intent parser reads package.json/pom.xml to inject repo context before parsing | SATISFIED | `readManifestDeps()` called at `index.ts:75` before `llmParse()` at line 76; test "reads manifest context BEFORE calling llmParse (INTENT-03 ordering)" passes |
| CLI-01 | 15-03 | User can run a single task via positional arg and exit | SATISFIED | `src/cli/index.ts:15` adds `.argument('[input]', ...)`; routing fork at line 57 calls `oneShotCommand()` when input present |
| CLI-03 | 15-02, 15-03 | User sees parsed intent and proposed plan before execution, can confirm or redirect | SATISFIED | `confirmLoop()` displays compact intent block via `displayIntent()`, prompts Y/n, supports 3 redirect attempts with correction |

No orphaned requirements detected. All 5 requirement IDs from plan frontmatter map to satisfied implementations.

---

### Anti-Patterns Found

No blockers or warnings detected.

`return null` occurrences in `fast-path.ts` and `confirm-loop.ts` are all intentional specified behavior (no-match sentinel, confirm abort), not stubs.

No TODO/FIXME/PLACEHOLDER comments in any phase 15 files. No empty handler implementations. No stub API routes.

---

### Human Verification Required

The following behaviors are correct in code but can only be fully validated with a live TTY:

#### 1. End-to-End One-Shot Flow

**Test:** Run `npx tsx src/cli/index.ts 'update recharts'` against a repository with recharts in package.json
**Expected:** Fast-path resolves without LLM call; compact intent block displayed with task type, project, dep, version; Y/n prompt appears
**Why human:** Requires a TTY and a real repository; readline interactive behavior not testable programmatically

#### 2. Numbered Clarification Choices for Ambiguous Input

**Test:** Run `npx tsx src/cli/index.ts 'update charts stuff'` with ambiguous input that triggers LLM low confidence
**Expected:** Numbered list of 2-3 clarification options displayed; user can pick a number; selection re-parses and shows confirm prompt
**Why human:** Requires live Anthropic API call returning low-confidence response

#### 3. Interactive Repo Prompting

**Test:** Run `npx tsx src/cli/index.ts 'update recharts'` with no `-r` flag and no registered projects
**Expected:** "No project specified" prompt appears; numbered list of registered projects shown (or path entry prompt if none)
**Why human:** Requires interactive TTY stdin

---

### Test Suite Results

| Test File | Tests | Status |
|-----------|-------|--------|
| `src/intent/types.test.ts` | 7 | PASS |
| `src/intent/fast-path.test.ts` | 22 | PASS |
| `src/intent/context-scanner.test.ts` | 8 | PASS |
| `src/intent/llm-parser.test.ts` | 8 | PASS |
| `src/intent/confirm-loop.test.ts` | 10 | PASS |
| `src/intent/index.test.ts` | 14 | PASS |
| `src/cli/commands/one-shot.test.ts` | 17 | PASS |
| `src/prompts/npm.test.ts` | included in total | PASS |
| `src/prompts/maven.test.ts` | included in total | PASS |
| **Full suite** | **423/423** | **PASS** |

`npx tsc --noEmit` exits 0.

---

### Zod Dependency

`package.json` lists `"zod": "^4.3.6"` in `dependencies` (not just devDependencies). Confirmed explicit prod dependency as required by INTENT-01 (Zod schema validates all LLM output).

---

_Verified: 2026-03-20T15:25:00Z_
_Verifier: Claude (gsd-verifier)_
