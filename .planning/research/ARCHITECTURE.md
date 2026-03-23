# Architecture Research

**Domain:** Generic task execution — background coding agent v2.2
**Researched:** 2026-03-23
**Confidence:** HIGH (first-party codebase analysis, no external dependencies required)

## Context: What This Research Is

This is an integration analysis for v2.2. The system is fully operational (v2.1). The question is: how does generic task support — config edits, simple refactors, method replacements — slot into the existing `IntentParser → prompt builder → verifier` pipeline without breaking the dependency-update path or requiring a new execution model?

This document maps every touch point: what changes, what is new, what is untouched, and in what order to build it.

---

## Existing Architecture (v2.1 — What Already Works)

```
User input (REPL or one-shot)
  └─> parseIntent(input, options)
       ├─> fastPathParse()       regex: "update|upgrade|bump <dep>"
       ├─> validateDepInManifest()
       ├─> detectTaskType()      pom.xml / package.json presence
       └─> llmParse()            Haiku 4.5, structured output
            schema: { taskType: enum('npm-dep-update','maven-dep-update','unknown'), dep, version, confidence, createPr, clarifications }
            unknown → mapped to 'generic' with description = raw input
  └─> ResolvedIntent { taskType, repo, dep, version, confidence, createPr, description?, clarifications? }
  └─> confirmLoop()              user sees plan, confirms or corrects
  └─> runAgent(AgentOptions)
       └─> buildPrompt(options)
            ├─> buildMavenPrompt(dep, version)  task-specific template
            ├─> buildNpmPrompt(dep, version)     task-specific template
            └─> default: `Your task: ${description ?? taskType}`   CURRENT GENERIC STUB
       └─> RetryOrchestrator
            └─> ClaudeCodeSession.run(prompt)    Docker + iptables
            └─> compositeVerifier(workspaceDir)  build+test+lint, all build systems
            └─> llmJudge(workspaceDir, originalTask, baselineSha)
       └─> GitHubPRCreator (optional)
```

### Current State of Generic Tasks

`taskType: 'generic'` already exists in the flow. The `IntentParser` maps `unknown` LLM output to `'generic'` and stores the raw input in `description`. `buildPrompt()` has a default case that passes `description` through as a bare instruction. The stub is:

```typescript
default:
  return `You are a coding agent. Your task: ${options.description ?? options.taskType}. Work in the current directory.`;
```

This is functional but inadequate: it gives the agent no scope constraints, no end-state success criteria, no context about the repo structure, and no guidance on commit hygiene.

**v2.2 turns this stub into a proper generic prompt builder** and adds verification that adapts to what kind of change was made (code vs config-only).

---

## What Changes in v2.2

### Layer-by-layer summary

| Layer | Status | What Changes |
|-------|--------|--------------|
| Intent parser (`src/intent/`) | Minor modification | LLM schema adds `taskCategory` field (code-change vs config-only); fast-path stays dep-only |
| Prompt builder (`src/prompts/`) | New module | `generic.ts` replaces the stub default case |
| Agent execution (`src/agent/index.ts`) | Minor modification | No `preVerify` hook for generic tasks; version resolution skipped for non-dep tasks |
| Verifier (`src/orchestrator/verifier.ts`) | No change | compositeVerifier already adapts to build system by presence detection |
| LLM Judge (`src/orchestrator/judge.ts`) | No change | Already evaluates any diff against any original task — generic tasks are already handled |
| REPL session (`src/repl/session.ts`) | No change | Already passes `description` through to `AgentOptions` |
| Types (`src/types.ts`, `src/intent/types.ts`) | Additive | Add `taskCategory` to `IntentResult`/`ResolvedIntent` |

---

## Target Architecture (v2.2)

The execution layer (`RetryOrchestrator` and below) is **entirely unchanged**. All changes are in the input-to-prompt path.

```
┌──────────────────────────────────────────────────────────────────────┐
│                        INPUT LAYER                                     │
│                                                                        │
│  parseIntent(input)                                                    │
│    fastPathParse()      dep-update patterns only (unchanged)          │
│    llmParse()           MODIFIED: schema gains taskCategory field      │
│                                                                        │
│  ResolvedIntent         ADDITIVE: taskCategory propagated through      │
│  confirmLoop()          shows "generic change" label (minor update)   │
│                                                                        │
└──────────────────────────┬───────────────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────────────┐
│                        PROMPT LAYER                                    │
│                                                                        │
│  buildPrompt(options)                                                  │
│    'maven-dependency-update' → buildMavenPrompt()    (unchanged)      │
│    'npm-dependency-update'   → buildNpmPrompt()      (unchanged)      │
│    'generic'                 → buildGenericPrompt()  NEW              │
│                              (replaces one-liner stub)                │
│                                                                        │
└──────────────────────────┬───────────────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────────────┐
│                     EXECUTION LAYER (unchanged)                        │
│                                                                        │
│  runAgent(AgentOptions)                                                │
│    preVerify: undefined for generic tasks                              │
│    version resolution: skipped for generic tasks                       │
│    RetryOrchestrator                                                   │
│    ClaudeCodeSession (Docker + iptables)                               │
│    compositeVerifier (already build-system agnostic)                  │
│    llmJudge (already handles any diff + any task description)         │
│    GitHubPRCreator (optional)                                          │
│                                                                        │
└──────────────────────────────────────────────────────────────────────┘
```

---

## New Component: `buildGenericPrompt()`

### Location

`src/prompts/generic.ts`

### What it replaces

The default case stub in `src/prompts/index.ts`:
```typescript
default:
  return `You are a coding agent. Your task: ${options.description ?? options.taskType}. Work in the current directory.`;
```

### What it must produce

An end-state prompt following the established pattern from `maven.ts` and `npm.ts`:
1. One-line task statement (what the desired end state is)
2. SCOPE block: explicit constraints on what NOT to change
3. After-your-changes block: verifiable success criteria in present-tense assertions
4. Context hint: "Work in the current directory"

The key challenge: generic tasks have no structured parameters (no `dep`, no `version`). The entire task lives in `description`. The prompt must translate that free text into end-state language while adding scope guardrails.

```typescript
export function buildGenericPrompt(description: string): string {
  return [
    `You are a coding agent. ${description}`,
    '',
    `SCOPE: Make only the changes necessary to complete the task above. Do NOT:`,
    `- Modify files unrelated to the task`,
    `- Refactor, reformat, or reorganize code beyond what the task requires`,
    `- Add new dependencies, features, or abstractions not requested`,
    `- Change tests unless the task explicitly requires it`,
    '',
    `After your changes, the following should be true:`,
    `- The task described above is complete`,
    `- The codebase compiles and all existing tests pass`,
    `- Only the files necessary for the task have been modified`,
    '',
    `Work in the current directory.`,
  ].join('\n');
}
```

The scope block is intentionally generic. It reuses the "minimal-footprint" constraint pattern from the dependency prompts, which prevents the agent from gold-plating, refactoring unrelated code, or expanding scope.

### Wire-up in `buildPrompt()`

```typescript
// src/prompts/index.ts
case 'generic': {
  if (!options.description) {
    throw new Error('description is required for generic tasks');
  }
  return buildGenericPrompt(options.description);
}
```

---

## Modified Component: `llmParse()` — taskCategory

### Why

The verifier already adapts to build systems by presence detection (pom.xml → Maven, package.json → npm, tsconfig.json → tsc). For generic tasks, this is sufficient — no new verification logic is needed.

However, the intent parser currently has no way to distinguish "rename this method" (code change, needs build+test) from "update the log level in config.yaml" (config-only, build verification irrelevant). While the verifier's graceful skip-on-missing-config handles this already, surfacing the category in the intent improves the confirmation display and sets up future verification hints.

**Decision: `taskCategory` is optional and additive.** The verifier does NOT change. The category is metadata for the UI layer (confirmLoop) and future use.

### Schema change

```typescript
// src/intent/types.ts — IntentSchema
taskCategory: z.enum(['dependency-update', 'code-change', 'config-change']).optional(),
```

The LLM parser system prompt gains one sentence:
> Set taskCategory to 'dependency-update' for dep updates, 'code-change' for source code modifications (refactors, method changes, feature additions), 'config-change' for non-code file edits (yaml, json, properties, env files). Set to undefined if unclear.

`taskCategory` is OPTIONAL and nullable in the schema. The verifier never reads it. If the parser omits it, nothing breaks.

### confirmLoop display

The confirm loop currently shows `taskType` as a label. For generic tasks, it shows `"generic"` which is unhelpful. With `taskCategory`:

```
Plan: generic change (code-change) in my-app
Task: rename getUserById to fetchUserById in src/users/service.ts
```

vs the current:

```
Plan: generic task in my-app
Task: rename getUserById to fetchUserById in src/users/service.ts
```

The change to `confirmLoop` is cosmetic — display only, no logic change.

---

## Integration Points

### What is New

| Component | File | Purpose |
|-----------|------|---------|
| `buildGenericPrompt()` | `src/prompts/generic.ts` | End-state prompt for generic tasks. Replaces one-liner stub. |

### What is Modified

| Component | File | Change | Scope |
|-----------|------|--------|-------|
| `buildPrompt()` dispatch | `src/prompts/index.ts` | Add `case 'generic'` calling `buildGenericPrompt()` | 5 lines |
| `IntentSchema` | `src/intent/types.ts` | Add optional `taskCategory` field | Additive, nullable |
| `IntentResult` / `ResolvedIntent` | `src/intent/types.ts` | Propagate `taskCategory` | Additive |
| `llmParse()` system prompt | `src/intent/llm-parser.ts` | One sentence added to describe `taskCategory` field | Additive |
| `OUTPUT_SCHEMA` | `src/intent/llm-parser.ts` | Add `taskCategory` as optional string enum | Additive |
| `confirmLoop` display | `src/intent/confirm-loop.ts` | Show `taskCategory` when present for generic tasks | Display only |
| `runAgent()` | `src/agent/index.ts` | Skip `preVerify` and version resolution for `taskType !== 'npm-dependency-update'` (already done by if-check, verify coverage) | Confirm existing guard covers generic |

### What is Unchanged

Everything in the execution layer:
- `RetryOrchestrator` (`src/orchestrator/retry.ts`)
- `ClaudeCodeSession` (`src/orchestrator/claude-code-session.ts`)
- `compositeVerifier` (`src/orchestrator/verifier.ts`) — already build-system agnostic
- `llmJudge` (`src/orchestrator/judge.ts`) — already handles any task + any diff
- `GitHubPRCreator` (`src/orchestrator/pr-creator.ts`)
- `MCP verifier server` (`src/mcp/`)
- `REPL session` (`src/repl/session.ts`) — already passes `description` through
- `parseIntent` coordinator (`src/intent/index.ts`) — `'generic'` mapping already exists
- `fastPathParse()` — dep-update patterns only, no change needed
- `contextScanner` — reads manifest deps, unchanged

---

## Data Flow: Generic Task End-to-End

```
User: "rename getUserById to fetchUserById in src/users/service.ts"
         |
         v
parseIntent(input)
  fastPathParse()  → null (no "update|upgrade|bump" keyword)
  llmParse()
    taskType: 'unknown'
    dep: null
    version: null
    confidence: 'high'
    taskCategory: 'code-change'   <- new field
    clarifications: []
  → ResolvedIntent {
      taskType: 'generic',
      repo: '/path/to/project',
      dep: null,
      version: null,
      confidence: 'high',
      description: 'rename getUserById to fetchUserById in src/users/service.ts',
      taskCategory: 'code-change'
    }
         |
         v
confirmLoop()
  Displays: "Plan: generic change (code-change) in project"
  Task: rename getUserById to fetchUserById in src/users/service.ts
  [Y/n]
         |
         v
runAgent({ taskType: 'generic', description: '...', repo: '/path/to/project' })
  preVerify: undefined  (not npm-dep-update — existing guard)
  version resolution: skipped (not npm-dep-update — existing guard)
         |
         v
buildPrompt({ taskType: 'generic', description: 'rename getUserById to fetchUserById in src/users/service.ts' })
  → buildGenericPrompt(description)
  → "You are a coding agent. rename getUserById to fetchUserById...
     SCOPE: Make only the changes necessary...
     After your changes, the following should be true:..."
         |
         v
RetryOrchestrator.run(prompt)
  ClaudeCodeSession (Docker, iptables)
    Agent reads service.ts, renames function, updates call sites
  compositeVerifier(workspaceDir)
    tsc --noEmit → PASS
    vitest run → PASS (or FAIL → retry with error context)
    eslint → PASS
  llmJudge(workspaceDir, originalTask, baselineSha)
    diff: only service.ts and call sites changed → APPROVE
         |
         v
GitHubPRCreator (if createPr: true)
```

### Config-Only Flow (Verification Adapts Automatically)

```
User: "set LOG_LEVEL to debug in config/app.yaml"
         |
parseIntent → taskType: 'generic', taskCategory: 'config-change', description: '...'
         |
buildGenericPrompt(description)
         |
RetryOrchestrator.run(prompt)
  ClaudeCodeSession: edits config/app.yaml
  compositeVerifier(workspaceDir)
    tsc --noEmit: No tsconfig.json → skipped (logged: "skipping build verification")
    vitest run:   No vitest config → skipped
    mvn compile:  No pom.xml → skipped
    eslint:       No eslint config → skipped
    Result: passed: true (all verifiers skipped gracefully)
  llmJudge: diff shows only config/app.yaml changed → APPROVE
```

No new verification logic required. The existing graceful-skip-on-missing-config behavior handles pure config repos correctly.

---

## Build Order

```
Phase 1: buildGenericPrompt() + prompt dispatch
  (pure function, no deps, testable in isolation)
       |
       v
Phase 2: Intent schema + llmParse() taskCategory field
  (additive schema change, backward compatible)
       |
       v
Phase 3: confirmLoop display update + end-to-end integration test
  (wires up the display; validates full flow generic → PR)
```

**Phase 1 must come first.** The prompt builder is the core output of generic task support. It can be built and tested without touching the intent parser. The one-liner stub already routes to `buildPrompt()` — swapping the default case is a one-phase change.

**Phase 2 is additive.** The `taskCategory` field is optional and nullable everywhere. The LLM returning it or omitting it does not break existing behavior. This can be added independently of Phase 1 but logically belongs after the prompt builder is proven.

**Phase 3 closes the loop.** The integration test runs the full pipeline: NL input → intent parse → confirm → agent session (Docker) → verifier → judge → result. This is the quality gate for the milestone.

**No phase touches the execution layer.** If a phase requires changes to `retry.ts`, `claude-code-session.ts`, or `verifier.ts`, the design has gone wrong.

---

## Architectural Patterns

### Pattern 1: End-State Prompting for Generic Tasks

**What:** `buildGenericPrompt()` follows the same end-state template as the dep-update builders: task statement + scope constraints + success criteria. The description becomes the task statement verbatim — no paraphrasing.

**When to use:** Always for generic tasks. Do not try to parse or restructure the user's description.

**Trade-offs:** The user's description quality directly determines prompt quality. A vague description ("fix the bug") produces a vague prompt. This is intentional — the confirmation loop surfaces the exact task text to the user before execution. If it looks wrong, the user corrects it at confirmation time.

**Example:**
```typescript
// buildGenericPrompt takes description verbatim — never rephrases
buildGenericPrompt('rename getUserById to fetchUserById in src/users/service.ts')
// → "You are a coding agent. rename getUserById to fetchUserById..."
//    NOT: "You are a coding agent. Rename the getUserById function..."
```

### Pattern 2: Additive Schema Extensions

**What:** New fields added to `IntentResult` and `ResolvedIntent` must be optional (nullable). Existing callers should never need to handle the new field to continue working.

**When to use:** Any time the intent parser schema gains a new output field.

**Trade-offs:** Optional fields require defensive access everywhere they're used (`intent.taskCategory ?? 'unknown'`). This is the correct tradeoff — it preserves existing behavior while enabling new display logic.

**Example:**
```typescript
// BAD: required field breaks existing callers
taskCategory: z.enum(['dependency-update', 'code-change', 'config-change'])

// GOOD: optional, callers handle absence
taskCategory: z.enum(['dependency-update', 'code-change', 'config-change']).optional()
```

### Pattern 3: Verifier Remains Build-System Agnostic

**What:** The `compositeVerifier` already skips verifiers that don't apply (no pom.xml → skip Maven, no tsconfig.json → skip tsc). Generic tasks with config-only changes pass verification because all verifiers skip gracefully on a config-only repo.

**When to use:** Never add task-type-specific verification logic. The composite verifier detects build system by presence, not by task type.

**Trade-offs:** A repo with TypeScript source AND a task that only edits YAML still runs tsc. This is correct — the agent might have accidentally touched source files, and the build check catches that.

**Example:**
```typescript
// WRONG: skip TypeScript check for config-change tasks
if (options.taskType !== 'generic' || taskCategory !== 'config-change') {
  await buildVerifier(workspaceDir);
}

// RIGHT: always run compositeVerifier; verifier skips on missing config files
await compositeVerifier(workspaceDir);
```

---

## Anti-Patterns

### Anti-Pattern 1: A New Task Type Per Generic Category

**What people do:** Add `'config-change'`, `'refactor'`, `'method-rename'` as first-class task types with their own prompt builders and verifier configurations.

**Why it's wrong:** It reintroduces the hardcoded-handler problem that v2.2 is specifically designed to avoid (PROJECT.md explicitly lists "Hardcoded task-type handlers per category — generic execution path preferred" as out of scope). Each new category requires a new phase of work, new tests, and new maintenance. The generic path handles all of these with one prompt builder.

**Do this instead:** One `'generic'` task type with one `buildGenericPrompt()`. The user's description provides all the specificity needed. The agent adapts.

### Anti-Pattern 2: Enriching the Generic Prompt with Repo Analysis

**What people do:** Have `buildGenericPrompt()` call the filesystem — read the file tree, grep for the function name, inject relevant file paths into the prompt.

**Why it's wrong:** The agent already has `Read`, `Grep`, `Glob` tools. It discovers context itself. Pre-scanning the repo in `buildGenericPrompt()` duplicates work, adds latency to the prompt-building step (which runs synchronously in `runAgent()`), and risks passing stale or incorrect context.

**Do this instead:** The prompt instructs the agent to work in the current directory. The agent uses its tools to discover the relevant files. This is the existing pattern for dep-update tasks — the maven prompt doesn't inject the current pom.xml content.

### Anti-Pattern 3: Requiring taskCategory to Route Verification

**What people do:** Use `taskCategory: 'config-change'` to skip the build verifier entirely for config-only tasks, reducing verification time.

**Why it's wrong:** The agent may have edited source files unexpectedly. Skipping the build check because the task was *intended* to be config-only removes a safety net. The compositeVerifier's skip-on-missing-config is structural (repo has no tsconfig) not intentional (agent was supposed to skip source files).

**Do this instead:** Always run the full compositeVerifier. Config-only repos naturally skip build/test verifiers. Repos with source code always get build+test checked regardless of task category.

### Anti-Pattern 4: Allowing Version Resolution for Generic Tasks

**What people do:** Keep the `npm show <dep> version` resolution logic running for all tasks, even when `taskType === 'generic'` and `dep` is null.

**Why it's wrong:** The version resolution block in `runAgent()` is already guarded by `taskType === 'npm-dependency-update'`. This is correct. Generic tasks have no `dep` and should never trigger the host-side npm registry call.

**Do this instead:** Verify the existing guard covers the generic case. No new code needed — just confirm the existing `if (options.taskType === 'npm-dependency-update' && options.dep ...)` guard is sufficient.

---

## Component Boundaries

```
src/
├── intent/
│   ├── types.ts              MODIFY: add optional taskCategory to IntentResult, ResolvedIntent
│   ├── llm-parser.ts         MODIFY: add taskCategory to OUTPUT_SCHEMA + system prompt (additive)
│   ├── fast-path.ts          NO CHANGE
│   ├── context-scanner.ts    NO CHANGE
│   ├── confirm-loop.ts       MODIFY: display taskCategory label for generic tasks (cosmetic)
│   └── index.ts              NO CHANGE (generic mapping already exists)
├── prompts/
│   ├── generic.ts            NEW: buildGenericPrompt(description: string): string
│   ├── index.ts              MODIFY: case 'generic' → buildGenericPrompt(); guard on description
│   ├── maven.ts              NO CHANGE
│   └── npm.ts                NO CHANGE
├── agent/
│   └── index.ts              VERIFY: existing preVerify/version guards cover generic tasks
├── orchestrator/             NO CHANGE (all 6 files)
├── repl/                     NO CHANGE (description already propagated)
├── cli/                      NO CHANGE
├── mcp/                      NO CHANGE
└── types.ts                  NO CHANGE (AgentOptions.description already exists)
```

---

## Integration with Existing Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| `parseIntent` → `buildPrompt` | `taskType: 'generic'` + `description: string` | Both already exist. v2.2 only improves what `buildPrompt` does with them. |
| `buildPrompt` → `RetryOrchestrator` | `string` prompt | Unchanged interface. Generic prompt is just a better string. |
| `compositeVerifier` → generic tasks | No change needed | Verifier detects build system from workspace, not from task type. |
| `llmJudge` → generic tasks | No change needed | Judge receives git diff + original task description. Works for any task. |
| `ResolvedIntent.taskCategory` → `confirmLoop` | Optional field, display only | If missing, confirmLoop shows existing behavior. |

---

## Sources

- `src/prompts/index.ts` — existing stub default case confirms the gap, HIGH confidence
- `src/prompts/maven.ts`, `src/prompts/npm.ts` — end-state prompt pattern to follow, HIGH confidence
- `src/intent/types.ts` — `description?: string` in `ResolvedIntent` already wired, HIGH confidence
- `src/intent/index.ts` — `isGeneric ? 'generic' : llmResult.taskType` mapping already ships, HIGH confidence
- `src/intent/llm-parser.ts` — `OUTPUT_SCHEMA` structure, additive pattern clear, HIGH confidence
- `src/orchestrator/verifier.ts` — compositeVerifier skip-on-missing pattern confirmed, HIGH confidence
- `src/orchestrator/judge.ts` — judge uses raw task description, works for any task, HIGH confidence
- `src/agent/index.ts` — `preVerify` and version resolution guarded by `taskType === 'npm-dependency-update'`, HIGH confidence
- `.planning/PROJECT.md` v2.2 milestone spec — "generic execution path preferred", "no hardcoded handlers per category", HIGH confidence

---
*Architecture research for: Generic task execution (v2.2) — background coding agent*
*Researched: 2026-03-23*
