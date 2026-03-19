# Architecture Research

**Domain:** Conversational mode — background coding agent v2.1
**Researched:** 2026-03-19
**Confidence:** HIGH (based on first-party codebase analysis + verified Agent SDK docs)

## Context: What This Research Is

This is an integration analysis for v2.1. The system already exists and works (v2.0). The question is:
how do four new features — REPL interface, intent parser, project registry, and multi-turn sessions —
slot into the existing `CLI → RetryOrchestrator → ClaudeCodeSession` architecture without disrupting
the verification pipeline?

This document focuses on integration points, new vs modified components, and build order. It does not
re-document the v2.0 architecture.

---

## Existing Architecture (v2.0 — What Already Works)

```
CLI (Commander.js, src/cli/index.ts)
  └─> commands/run.ts          parses flags, validates options, calls runAgent()
       └─> RetryOrchestrator   outer verify/retry loop (max 3 attempts)
            └─> ClaudeCodeSession.run(message)
                 └─> Agent SDK query()    Docker container, iptables isolation
                      └─> Built-in tools: Read Write Edit Bash Glob Grep
                 └─> compositeVerifier(workspaceDir)
                 └─> llmJudge(workspaceDir, originalTask)
  └─> GitHubPRCreator (optional, --create-pr flag)
```

The entry point is rigid: Commander.js parses `--task-type`, `--repo`, `--dep`, `--target-version`.
These flags feed `buildPrompt()` which constructs a hard-coded task prompt.
`RetryOrchestrator` then drives the session loop.

Everything from `RetryOrchestrator` down is **untouched by v2.1**. The verification pipeline, Docker
isolation, hooks, MCP verifier, and Judge are all stable. v2.1 changes only what happens before
`RetryOrchestrator.run()` is called.

---

## Target Architecture (v2.1)

v2.1 adds a new input pathway — the REPL/one-shot conversational interface — that coexists alongside
the existing batch CLI. The fundamental change is: instead of requiring the user to provide structured
flags (`--task-type`, `--dep`, `--target-version`), v2.1 accepts natural language and resolves it into
the same `RunOptions` that the existing `runAgent()` function already accepts.

```
┌──────────────────────────────────────────────────────────────────────┐
│                        INPUT LAYER (new)                              │
│                                                                        │
│  One-shot mode                  REPL mode                             │
│  bg-agent 'update recharts'     bg-agent  (interactive)               │
│         │                              │                              │
│         └────────────┬─────────────────┘                             │
│                      │                                                │
│                 InputRouter                                            │
│                      │                                                │
│          ┌───────────┼───────────────┐                               │
│          │           │               │                               │
│    ProjectRegistry  IntentParser   SessionContext                     │
│    (resolve name)   (NL → params)  (multi-turn state)                │
│          │           │               │                               │
│          └───────────┴───────────────┘                               │
│                      │                                                │
│               RunOptions (resolved)                                   │
│                      │                                                │
└──────────────────────┼───────────────────────────────────────────────┘
                       │
                       ▼ (same interface as today)
┌──────────────────────────────────────────────────────────────────────┐
│                    EXECUTION LAYER (unchanged)                        │
│                                                                        │
│            runAgent(options: RunOptions): Promise<number>             │
│                      │                                                │
│              RetryOrchestrator                                        │
│              ClaudeCodeSession (Docker + iptables)                    │
│              compositeVerifier + llmJudge                             │
│              GitHubPRCreator (optional)                               │
│                                                                        │
└──────────────────────────────────────────────────────────────────────┘
```

The key insight: `runAgent()` in `src/cli/commands/run.ts` already accepts a well-defined `RunOptions`
interface. v2.1's new components produce `RunOptions`. The execution layer doesn't change.

---

## System Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                              HOST PROCESS                                 │
│                                                                            │
│  Entry points                                                              │
│  ┌──────────────────┐   ┌──────────────────────────────────────┐          │
│  │  Existing batch  │   │  NEW: Conversational entry point      │          │
│  │  CLI (index.ts)  │   │  bin/bg-agent (new binary/command)    │          │
│  │  --task-type...  │   │  bg-agent 'update recharts to 2.7.0'  │          │
│  │  --repo...       │   │  OR: bg-agent (REPL loop)             │          │
│  └─────────┬────────┘   └──────────────┬───────────────────────┘          │
│            │                           │                                   │
│            │                  ┌────────┴────────────────────┐             │
│            │                  │     InputRouter (new)        │             │
│            │                  │     detects one-shot vs REPL │             │
│            │                  └──┬──────────┬───────────────┘             │
│            │                     │          │                              │
│            │            ┌────────┴──┐  ┌────┴──────────┐                  │
│            │            │ Project   │  │  IntentParser  │                  │
│            │            │ Registry  │  │  (Claude API)  │                  │
│            │            │ (new)     │  │  (new)         │                  │
│            │            └────┬──────┘  └────┬───────────┘                 │
│            │                 │              │                              │
│            │            ┌────┴──────────────┴────────┐                   │
│            │            │   SessionContext (new)       │                   │
│            │            │   multi-turn state + history │                   │
│            │            └────────────┬───────────────┘                    │
│            │                         │                                     │
│            └──────────────┬──────────┘                                    │
│                           │                                                │
│                     RunOptions                                             │
│                    (taskType, repo, dep, etc.)                             │
│                           │                                                │
│               runAgent(options: RunOptions)                                │
│                           │                                                │
│             RetryOrchestrator  (unchanged)                                 │
│                    │                                                        │
│             ClaudeCodeSession  (unchanged)                                 │
│                    │                                                        │
│          ┌─────────────────────────────────┐                              │
│          │  Docker container               │                              │
│          │  Agent SDK query()              │                              │
│          │  iptables (api.anthropic.com)   │                              │
│          └─────────────────────────────────┘                              │
│                    │                                                        │
│          compositeVerifier + llmJudge  (unchanged)                         │
│          GitHubPRCreator (unchanged)                                       │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Component Responsibilities

### New Components

| Component | Responsibility | Location |
|-----------|----------------|----------|
| `InputRouter` | Entry point for conversational mode. Parses CLI args: if process.argv has a positional string → one-shot; if no args → REPL loop. Drives the REPL read/run/print cycle. | `src/cli/repl/input-router.ts` |
| `IntentParser` | LLM-powered NL → structured task params. Calls Claude API (not Agent SDK `query()`) with a JSON schema prompt. Returns `ParsedIntent`: taskType, repo, dep, targetVersion, confidence. | `src/cli/repl/intent-parser.ts` |
| `ProjectRegistry` | Stores name → repo path mappings in `~/.bg-agent/projects.json`. Registers cwd automatically. Resolves short names ("my-app") to absolute paths. | `src/cli/registry/project-registry.ts` |
| `SessionContext` | Holds multi-turn state for a REPL session: resolved project, prior task results, conversation history for the intent parser. Lives in memory (process lifetime). | `src/cli/repl/session-context.ts` |
| `ContextScanner` | Reads repo structure to build brief context summary (package.json/pom.xml → dep list, existing versions). Fed to IntentParser to improve disambiguation. | `src/cli/repl/context-scanner.ts` |
| `ClarificationLoop` | After intent parsing, surfaces the plan to the user and waits for confirmation or correction. Returns confirmed `RunOptions` or prompts for clarification. | `src/cli/repl/clarification-loop.ts` |
| `bin/bg-agent` | New entry point binary (or `bg-agent` commander subcommand). Bootstraps `InputRouter`. Does NOT replace `background-agent` — they coexist. | `src/cli/bg-agent.ts` |

### Modified Components

| Component | Change | Location |
|-----------|--------|----------|
| `cli/index.ts` | Minor: add `--conversational` flag or keep as separate binary. Likely no change — v2.1 adds a second binary. | `src/cli/index.ts` |
| `cli/commands/run.ts` | Extract `runAgent()` into a shared module so both the batch CLI and REPL can call it. Currently it's the action handler — needs to be importable. | `src/cli/commands/run.ts` |
| `prompts/index.ts` | Add `freeform` task type: passes the LLM-parsed task description directly as the prompt, bypassing template builders. Needed for natural language tasks that don't fit existing types. | `src/prompts/index.ts` |
| `types.ts` | Add `ParsedIntent`, `RegistryEntry`, `SessionContextState` types. Extend `RunOptions` to support `promptOverride?: string` for freeform tasks. | `src/types.ts` |

### Unchanged Components

Everything in the execution layer: `RetryOrchestrator`, `ClaudeCodeSession`, `compositeVerifier`,
`llmJudge`, `ErrorSummarizer`, `GitHubPRCreator`, `metrics.ts`, `mcp/verifier-server.ts`,
`cli/docker/index.ts`, `cli/utils/logger.ts`.

---

## Recommended Project Structure

```
src/
├── cli/
│   ├── commands/
│   │   └── run.ts              # MODIFY: extract runAgent() to be directly importable
│   ├── docker/
│   │   └── index.ts            # unchanged
│   ├── registry/               # NEW
│   │   ├── project-registry.ts # ProjectRegistry class (~80 lines)
│   │   └── project-registry.test.ts
│   ├── repl/                   # NEW
│   │   ├── input-router.ts     # Entry point: one-shot vs REPL detection (~60 lines)
│   │   ├── intent-parser.ts    # LLM intent parsing (~120 lines)
│   │   ├── intent-parser.test.ts
│   │   ├── clarification-loop.ts  # User confirmation + plan display (~80 lines)
│   │   ├── context-scanner.ts  # Repo structure scan for parser context (~60 lines)
│   │   └── session-context.ts  # Multi-turn state (~50 lines)
│   ├── utils/
│   │   └── logger.ts           # unchanged
│   ├── bg-agent.ts             # NEW: conversational entry point binary
│   └── index.ts                # unchanged (batch mode)
├── mcp/
│   └── verifier-server.ts      # unchanged
├── orchestrator/
│   ├── claude-code-session.ts  # unchanged
│   ├── judge.ts                # unchanged
│   ├── metrics.ts              # unchanged
│   ├── pr-creator.ts           # unchanged
│   ├── retry.ts                # unchanged
│   ├── summarizer.ts           # unchanged
│   └── verifier.ts             # unchanged
├── prompts/
│   ├── index.ts                # MODIFY: add freeform task type passthrough
│   ├── maven.ts                # unchanged
│   └── npm.ts                  # unchanged
├── errors.ts                   # unchanged
└── types.ts                    # MODIFY: add ParsedIntent, RegistryEntry, SessionContextState
```

### Structure Rationale

- `cli/registry/` — separate from `cli/repl/` because registry is a persistent service (survives sessions) while repl/ holds session-scoped components
- `cli/repl/` — groups all conversational input components; none touch execution layer
- `bg-agent.ts` — new binary keeps conversational mode isolated from batch `index.ts`; no risk of breaking existing CLI consumers

---

## Architectural Patterns

### Pattern 1: Input Normalization Gateway

**What:** All input paths (batch CLI, REPL, one-shot) converge on `RunOptions` before reaching
`runAgent()`. The `RunOptions` interface is the contract between input and execution.

**When to use:** Always. `runAgent()` is the stable boundary. Input layer components above it
are free to evolve; execution layer components below it are free to evolve.

**Trade-offs:** Forces intent parser output to fit the existing `RunOptions` shape. For tasks that
don't fit existing task types (e.g., "refactor the auth module"), `promptOverride` in `RunOptions`
enables a freeform pass-through without requiring new prompt builders.

**Example:**
```typescript
// intent-parser.ts returns:
interface ParsedIntent {
  taskType: string;           // 'npm-dependency-update' or 'freeform'
  repo: string;               // resolved absolute path
  dep?: string;
  targetVersion?: string;
  promptOverride?: string;    // for freeform tasks
  confidence: 'high' | 'low';
  rawInput: string;
}

// input-router.ts converts ParsedIntent -> RunOptions:
function toRunOptions(intent: ParsedIntent, registry: ProjectRegistry): RunOptions {
  return {
    taskType: intent.taskType,
    repo: intent.repo,
    dep: intent.dep,
    targetVersion: intent.targetVersion,
    promptOverride: intent.promptOverride,
    turnLimit: 10,
    timeout: 300,
    maxRetries: 3,
  };
}
```

### Pattern 2: Intent Parser as Thin API Wrapper

**What:** `IntentParser` calls the Anthropic SDK (or Claude API directly) with a single structured
output prompt. It is not an agent — it makes one LLM call with a well-constrained JSON schema.
No tools, no agentic loop, no `query()`.

**When to use:** Intent parsing only. Keep the LLM call count low and predictable.

**Trade-offs:** One API call per user input. Latency is acceptable (~1-2s). Using `query()` for
intent parsing would be overkill — the Agent SDK is designed for multi-turn tool-using agents, not
single structured-output calls.

**Example:**
```typescript
// intent-parser.ts — uses @anthropic-ai/sdk directly (or keep as Haiku call)
const response = await anthropic.messages.create({
  model: 'claude-haiku-4-5',   // same model as LLM Judge
  max_tokens: 500,
  system: INTENT_PARSER_SYSTEM_PROMPT,   // JSON schema + examples
  messages: [{ role: 'user', content: userInput }],
});
// parse response.content[0].text as JSON -> ParsedIntent
```

This is the same pattern as the existing LLM Judge (`orchestrator/judge.ts`). Reuse the pattern,
potentially share the Anthropic client instance.

### Pattern 3: Registry as Simple JSON Store

**What:** `ProjectRegistry` reads/writes `~/.bg-agent/projects.json`. No database, no daemon.
Auto-registers cwd on first invocation. Short names ("my-app") map to absolute paths.

**When to use:** Every invocation that needs to resolve a project name.

**Trade-offs:** Simple and portable. Concurrency is not a concern (single user, sequential CLI
invocations). File corruption on crash is the risk — mitigated by atomic write (existing
`write-file-atomic` dependency already in package.json).

**Example:**
```typescript
interface RegistryEntry {
  name: string;         // short name ("my-app") or repo basename
  path: string;         // absolute path to repo root
  lastUsed: string;     // ISO timestamp
}
// ~/.bg-agent/projects.json = RegistryEntry[]
```

### Pattern 4: REPL as Thin Read/Run/Print Loop

**What:** The REPL is a while loop: read user input → parse intent → show plan → confirm → run
`runAgent()` → print result → repeat. All state lives in `SessionContext` in memory.

**When to use:** Interactive mode only.

**Trade-offs:** No persistence between process restarts (by design). SessionContext holds the
resolved project and prior run results so follow-up inputs like "try again with verbose logging"
can reference the prior run. If persistence is needed later, it can be added to the registry.

**Example:**
```typescript
// input-router.ts REPL loop (simplified)
while (true) {
  const userInput = await readline.question('> ');
  if (userInput === 'exit') break;

  const scanResult = await contextScanner.scan(ctx.project!.path);
  const intent = await intentParser.parse(userInput, scanResult, ctx.history);
  const confirmed = await clarificationLoop.confirm(intent);
  if (!confirmed) continue;

  const options = toRunOptions(intent, registry);
  const exitCode = await runAgent(options);
  ctx.addToHistory({ input: userInput, intent, exitCode });
}
```

---

## Data Flow

### One-Shot Flow

```
User: bg-agent 'update recharts to 2.7.0' --repo ./my-app
         |
         v
InputRouter.route(argv)
  detectes positional arg -> one-shot mode
  resolves --repo to absolute path (or uses registry if name given)
         |
         v
ContextScanner.scan(repoPath)
  reads package.json -> current recharts version, peer deps
  returns { repoType: 'npm', currentVersions: { recharts: '2.6.0' } }
         |
         v
IntentParser.parse(userInput, scanResult)
  LLM call (Haiku 4.5, structured output):
    { taskType: 'npm-dependency-update', dep: 'recharts', targetVersion: '2.7.0' }
  confidence: 'high' (explicit version in input)
         |
         v
ClarificationLoop.confirm(intent)
  prints: "Plan: update recharts from 2.6.0 to 2.7.0 in /path/to/my-app"
  prints: "Proceed? [Y/n]"
  user presses Enter -> confirmed
         |
         v
toRunOptions(intent) -> RunOptions { taskType, repo, dep, targetVersion, ... }
         |
         v
runAgent(options)        <- EXISTING, UNCHANGED
  RetryOrchestrator
  ClaudeCodeSession (Docker + iptables)
  compositeVerifier + llmJudge
  GitHubPRCreator (if --create-pr)
         |
         v
exit code 0 / 1
```

### REPL Multi-Turn Flow

```
User: bg-agent          (no args -> REPL mode)
         |
InputRouter detects no args -> REPL mode
         |
ProjectRegistry.autoRegister(cwd)   <- cwd registered if new
         |
REPL prints: "Background Agent | project: my-app (/path/to/my-app)"
         |
Turn 1: user types "update recharts"
   -> IntentParser: { taskType: 'npm-dep', dep: 'recharts', targetVersion: ?? }
      confidence: 'low' (no version)
   -> ClarificationLoop asks: "Which version? (current: 2.6.0)"
   -> user: "2.7.0"
   -> IntentParser re-parses with version -> RunOptions
   -> runAgent() runs
   -> SessionContext stores: { lastTask: recharts-update, exitCode: 0 }
         |
Turn 2: user types "now update react-router too"
   -> SessionContext provides: repo is already resolved, use same project
   -> IntentParser: { taskType: 'npm-dep', dep: 'react-router', targetVersion: ?? }
   -> ClarificationLoop asks: "To which version? (current: 6.10.0)"
   -> user: "6.20.0"
   -> runAgent() runs (fresh RetryOrchestrator — multi-turn does NOT share agent context)
```

**Critical:** Multi-turn in v2.1 means the REPL maintains state (resolved project, history) between
user inputs. It does NOT mean a single Agent SDK session spans multiple tasks. Each task still creates
a fresh `ClaudeCodeSession` via `RetryOrchestrator`. The Agent SDK session is always single-task.

### Key Data Flows

1. **Project resolution:** User input → `ProjectRegistry.resolve(name)` → absolute path → `RunOptions.repo`
2. **Intent parsing:** Natural language + repo scan context → single Haiku LLM call → `ParsedIntent` → validated `RunOptions`
3. **Context persistence:** `SessionContext` accumulates turn history in memory; intent parser receives last N turns as context for disambiguation ("do it again", "try verbose")
4. **Execution (unchanged):** `RunOptions` → `runAgent()` → `RetryOrchestrator` → Docker → verify → PR

---

## Integration Points

### New vs Modified vs Unchanged

| Component | Status | Touches Execution Layer? |
|-----------|--------|--------------------------|
| `InputRouter` | New | No — calls `runAgent()` only |
| `IntentParser` | New | No — produces `RunOptions` |
| `ProjectRegistry` | New | No — resolves paths only |
| `SessionContext` | New | No — holds state only |
| `ContextScanner` | New | No — reads repo files |
| `ClarificationLoop` | New | No — user I/O only |
| `bg-agent.ts` | New binary | No — delegates to `runAgent()` |
| `cli/commands/run.ts` | Modify | Already is execution layer |
| `prompts/index.ts` | Modify | Minimal: add freeform case |
| `types.ts` | Modify | Additive only |
| Everything else | Unchanged | — |

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| Anthropic API (intent parsing) | Direct `@anthropic-ai/sdk` call, structured output, Haiku 4.5 | Same pattern as LLM Judge. Single call per input, no tools, no agentic loop. |
| Anthropic API (agent session) | `ClaudeCodeSession` via Agent SDK `query()` | Unchanged from v2.0 |
| GitHub | `GitHubPRCreator` | Unchanged |
| File system (~/.bg-agent/) | `write-file-atomic` for registry writes | Already in package.json |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| `InputRouter` to `runAgent()` | Direct function call, `RunOptions` parameter | `runAgent()` must be importable — extract from Commander action handler |
| `IntentParser` to Anthropic SDK | Single structured-output messages.create() call | Not `query()` — keep it simple |
| `IntentParser` to `ContextScanner` | Direct call, `ScanResult` parameter | Scanner feeds context to parser |
| `SessionContext` to `IntentParser` | Prior turn history passed as parameter | Enables follow-up understanding |
| `ProjectRegistry` to filesystem | Read/write `~/.bg-agent/projects.json` | Atomic write, JSON format |
| `InputRouter` to `ClarificationLoop` | Direct call, `ParsedIntent` parameter | Loop returns confirmed `RunOptions` or null |

---

## Build Order

Dependencies flow as:

```
Phase 14: ProjectRegistry + runAgent() extraction
  (no LLM calls, pure infrastructure, enables all later phases)
       |
       v
Phase 15: IntentParser + ContextScanner
  (the core NL parsing; one-shot mode works after this)
       |
       v
Phase 16: REPL loop + ClarificationLoop + SessionContext
  (interactive mode; requires phases 14+15)
       |
       v
Phase 17: Multi-turn context propagation
  (SessionContext history feeds IntentParser; follow-ups work)
```

**Phase 14 must come first:** Extracting `runAgent()` from Commander's action handler is the
prerequisite for all other phases — every new input path calls it.

**Phase 15 enables one-shot mode:** After the intent parser exists, `bg-agent 'update X'`
works end-to-end.

**Phase 16 enables interactive mode:** After phases 14+15, the REPL loop is straightforward.

**Phase 17 enables follow-up tasks:** Multi-turn context only needs the SessionContext history
wired into the intent parser; requires 14+15+16 to be stable first.

**Phases 14-17 never touch the execution layer** (`RetryOrchestrator` and below). This is the
critical constraint — if a phase requires changing `retry.ts`, `claude-code-session.ts`, or
`verifier.ts`, the design has gone wrong.

---

## Anti-Patterns

### Anti-Pattern 1: Sharing Agent SDK Session Across REPL Turns

**What people do:** Keep a single `ClaudeCodeSession` alive across multiple REPL inputs, resuming
the same session for each follow-up task.

**Why it's wrong:** Each task needs a fresh context window. Prior task history contaminates the
model's approach to the current task. The existing `RetryOrchestrator` comment is explicit: "Never
reuse sessions — prevents context accumulation." This applies equally to cross-task reuse.

**Do this instead:** Each REPL turn that results in a task creates a new `RetryOrchestrator` and
new `ClaudeCodeSession`. Multi-turn state lives in `SessionContext` (for the user-facing REPL
context), not in the Agent SDK session.

### Anti-Pattern 2: Intent Parser Using query()

**What people do:** Run the intent parser as a full Agent SDK session to "give it tools to look
up versions in npm, read the repo, etc."

**Why it's wrong:** The `ContextScanner` already reads the repo. Version lookups from npm registry
require network access. Keeping the intent parser as a single structured-output call keeps it fast,
cheap, and deterministic. Agent SDK `query()` is for multi-step code editing, not JSON extraction.

**Do this instead:** Use `anthropic.messages.create()` with a JSON schema system prompt. Feed it
the `ContextScanner` output so it doesn't need to read files itself. Keep the parser under 200ms.

### Anti-Pattern 3: Bypassing ClarificationLoop for Low-Confidence Intents

**What people do:** Run `runAgent()` immediately even when `IntentParser` returns
`confidence: 'low'`, treating the intent as a best-guess.

**Why it's wrong:** Low confidence typically means a missing required parameter (e.g., no version
specified). Running with a guessed version will either fail verification or, worse, update to the
wrong version silently. The ClarificationLoop exists to close the ambiguity gap before work starts.

**Do this instead:** Always surface low-confidence intents to the user. The clarification roundtrip
is cheap (one readline prompt) compared to a wasted 5-minute agent session.

### Anti-Pattern 4: Validating RunOptions Twice

**What people do:** Add validation to `InputRouter` for task-type-specific rules (e.g., "Maven
dep must be groupId:artifactId format") and leave the same validation in Commander.js.

**Why it's wrong:** Duplicate validation creates drift. One validator gets updated; the other
doesn't.

**Do this instead:** Extract the validation logic from `cli/index.ts` into a shared
`validateRunOptions()` function that both paths call. The Commander action handler calls it. The
REPL input router calls it. Single source of truth.

### Anti-Pattern 5: Storing SessionContext in the Registry

**What people do:** Persist REPL history to `~/.bg-agent/projects.json` so sessions survive
process restarts.

**Why it's wrong:** For v2.1, the REPL is single-process. History only helps within a session
for follow-up disambiguation. Persisting history adds complexity (staleness, size limits, sensitive
data) for negligible benefit.

**Do this instead:** Keep `SessionContext` in memory. Persistence can be added in a later version
when there is a clear user need (e.g., "what did I run last Tuesday?").

---

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| Single developer, local use | Current design — in-process, single-user, JSON registry |
| Team shared install | Add team registry (shared network path) alongside personal registry |
| CI/CD integration | One-shot mode already works as-is (`bg-agent 'update X'`); no REPL needed |
| Slack/webhook triggers | Intent parser is the only component that needs to be extracted into an HTTP handler; execution layer already works as a library |

### Scaling Priorities

1. **First bottleneck:** Intent parser latency. If Haiku calls exceed 2s, consider caching parsed intents for recently-seen inputs. Not needed for v2.1.
2. **Second bottleneck:** Registry contention. Only becomes an issue with concurrent invocations (e.g., CI running multiple agents). Atomic write prevents corruption; sequential reads are safe. Not a v2.1 concern.

---

## Sources

- Existing codebase `src/` — HIGH confidence, first-party analysis (v2.0, 2026-03-19)
- `src/types.ts`, `RunOptions` interface — first-party, defines the integration contract
- `src/cli/commands/run.ts`, `runAgent()` function — first-party, the stable execution entry point
- `src/orchestrator/retry.ts` — first-party, confirms fresh-session-per-attempt constraint
- `src/orchestrator/judge.ts` — first-party, pattern for single structured-output LLM call (reused by IntentParser)
- `.planning/PROJECT.md` v2.1 requirements — first-party product spec
- Spotify Engineering Part 1 (2025-11) — "surrounding infrastructure outside agent" pattern validates REPL/registry living outside ClaudeCodeSession

---
*Architecture research for: Conversational mode (v2.1) — background coding agent*
*Researched: 2026-03-19*
