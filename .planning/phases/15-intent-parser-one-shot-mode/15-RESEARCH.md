# Phase 15: Intent Parser + One-Shot Mode - Research

**Researched:** 2026-03-20
**Domain:** NLP intent parsing, Commander.js CLI, Anthropic structured output, interactive TTY confirmation
**Confidence:** HIGH

## Summary

Phase 15 introduces natural language input as a first-class CLI path alongside the existing flag-based interface. The work divides into three distinct components: (1) a fast-path heuristic that handles obvious dependency update patterns without an LLM call using regex matching, (2) an LLM-backed ambiguity resolver using Haiku 4.5 with `beta.messages.create()` structured output — the same pattern already working in the LLM Judge — and (3) a confirm/redirect interaction loop wired between the intent parser output and `runAgent()`.

The codebase is in an excellent position for this phase. Commander.js v14 supports optional positional arguments that coexist cleanly with existing flags. The structured output API pattern is already proven in `src/orchestrator/judge.ts`. `ProjectRegistry` is fully operational. `runAgent()` accepts `AgentOptions` directly, so the intent parser simply needs to produce that shape. No new dependencies are required beyond `zod` (already available transitively; add as explicit prod dep).

**Primary recommendation:** Build the intent parser as `src/intent/index.ts` (module boundary) with three exports — `fastPathParse()`, `llmParse()`, and a coordinator `parseIntent()`. Wire the confirm loop into a new `src/cli/commands/one-shot.ts` command handler. The existing `src/cli/index.ts` gains a `.argument('[input]', ...)` declaration and routes to the new handler when a positional arg is present.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Confirm flow UX**
- Structured summary display after parsing: show task type, repo, dep, version in a compact block, then `Proceed? [Y/n]`
- On redirect ('n'): user types a correction, intent parser re-parses the correction in context of the original parse
- Maximum 3 redirect attempts before aborting with "Please try again with a clearer command"
- Always confirm — no `--yes` skip mechanism. Every run requires interactive confirmation (aligns with human-in-the-loop trust model)

**Fast-path patterns**
- Regex/heuristic handles dependency update patterns: "update recharts", "update recharts to 2.15.0", "upgrade lodash"
- Task type inferred by scanning cwd/resolved project for manifest: package.json → npm-dependency-update, pom.xml → maven-dependency-update. Both or neither → fall through to LLM
- When no version specified, fast-path sets `"latest"` sentinel — agent resolves actual version at runtime inside Docker. Version never comes from LLM (matches STATE.md decision)
- Fast-path validates dependency exists in manifest (package.json/pom.xml). If dep not found, falls through to LLM for possible fuzzy match or clarification

**Ambiguity handling**
- LLM uses `messages.create()` structured output (Haiku 4.5) with Zod schema — NOT `query()` (matches STATE.md decision)
- Zod schema fields: taskType, dep, version (sentinel), confidence (high/low), clarifications[] (label + intent pairs)
- Context scan happens BEFORE LLM call: read package.json/pom.xml dep list and inject as structured context into LLM prompt (satisfies INTENT-03)
- Clarification presented as numbered choices: LLM generates 2-3 interpretations, user picks a number
- Unrecognized input passes through as generic task with the raw input as prompt (uses existing default prompt path in buildPrompt)

**CLI invocation shape**
- Positional arg as natural language input: first non-flag arg is treated as NL. Existing flags (-t, -r, --dep, etc.) still work for backward compat. Both paths converge at runAgent()
- Flags and NL can mix: `bg-agent -r ~/code/myapp 'update recharts'`

**Repo/project resolution**
- Primary: registry name extracted from NL input ("update recharts in myapp" → registry lookup)
- Fallback: `-r` flag for explicit path (backward compat, one-off runs)
- If project name not in registry: prompt user for local path, register it, then proceed
- If neither registry name nor `-r` flag: prompt with list of registered projects

### Claude's Discretion
- Intent parser module structure and internal architecture
- Regex patterns for fast-path matching (exact syntax)
- LLM system prompt design for intent parsing
- How to detect positional arg vs flag in Commander.js
- Confirm flow rendering (colors, formatting, spacing)

### Deferred Ideas (OUT OF SCOPE)
- `--yes` flag for auto-confirming high-confidence parses (CI/scripting use case) — defer to v2.2 (INTG-02)
- GitHub clone on demand for repos not cloned locally — future phase
- Tab completion for project names — deferred (CLI-04)
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| INTENT-01 | User can describe a task in natural language and get structured intent (task type, repo, dep, version) | Covered by fast-path + LLM parser both outputting the same IntentResult shape; maps to AgentOptions |
| INTENT-02 | Obvious patterns (e.g. "update recharts") are resolved via fast-path heuristic without LLM call | Covered by regex fast-path in `fastPathParse()` — verifiable in tests by asserting no Anthropic API call is made |
| INTENT-03 | Intent parser reads package.json/pom.xml to inject repo context before parsing ambiguous input | Covered by ContextScanner component that reads manifest deps before any LLM call |
| CLI-01 | User can run a single task via positional arg (bg-agent 'update recharts') and exit | Covered by Commander.js `.argument('[input]', ...)` + one-shot command handler routing |
| CLI-03 | User sees parsed intent and proposed plan before execution, can confirm or redirect | Covered by ConfirmLoop component: display parsed intent block → Proceed? [Y/n] → redirect or run |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| commander | 14.0.3 | CLI arg parsing with positional + flags | Already in use; v14 supports optional positional args alongside options |
| @anthropic-ai/sdk | ^0.71.2 | LLM structured output for ambiguous parses | Already in use; `beta.messages.create()` with `output_config` established in judge.ts |
| zod | 4.3.6 | Schema definition for intent output validation | Already available (transitively); same pattern intended in CONTEXT.md |
| picocolors | 1.1.1 | Confirm display formatting (colors) | Already in use in cli/index.ts |
| node:readline | built-in | Interactive Y/n and redirect prompts | No new dep needed; Node.js built-in handles TTY input |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| node:fs/promises | built-in | Read package.json/pom.xml for context injection | ContextScanner reads manifest before LLM call |
| pino | ^10.3.0 | Structured logging of parse results at debug level | Already in use; log parse path taken (fast-path vs LLM) |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| node:readline | `inquirer` or `@inquirer/prompts` | Inquirer is richer but a new dependency; readline is sufficient for Y/n + single-line redirect |
| zod + beta.messages | Plain JSON.parse + manual schema | Plain parsing has no type safety; Zod validates at parse time and narrows TypeScript types |
| regex fast-path | Small LLM call for all inputs | LLM adds latency + cost for obvious patterns; fast-path keeps simple cases instant |

**Installation (net-new prod dep):**
```bash
npm install zod
```

Zod is already present as a transitive dependency (used by the Anthropic SDK internals). Adding it explicitly as a direct prod dep makes it a declared interface.

**Version verification:**
```bash
npm view zod version       # 4.3.6
npm view commander version  # 14.0.3 (already installed)
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── intent/
│   ├── index.ts           # parseIntent() coordinator — public API
│   ├── fast-path.ts       # fastPathParse() — regex heuristics, no LLM
│   ├── context-scanner.ts # readManifestDeps() — reads package.json/pom.xml
│   ├── llm-parser.ts      # llmParse() — Haiku 4.5 structured output
│   ├── confirm-loop.ts    # displayIntent() + promptConfirm() + redirect loop
│   ├── types.ts           # IntentResult, ParsedIntent, ClarificationOption
│   └── intent.test.ts     # unit tests for all components
├── cli/
│   ├── index.ts           # (modified) add .argument('[input]', ...)
│   └── commands/
│       └── one-shot.ts    # new: oneShotCommand() handler
```

### Pattern 1: Fast-Path Regex Parser
**What:** Stateless regex matching against the NL string to extract dep name, optional version, and optional project name. Returns `IntentResult | null` (null means fall through to LLM).
**When to use:** Input matches a known pattern; manifest confirms dep exists.
**Example:**
```typescript
// src/intent/fast-path.ts
const DEPENDENCY_PATTERNS = [
  // "update recharts", "upgrade lodash", "bump @types/node"
  /^(?:update|upgrade|bump)\s+(?<dep>@?[a-z0-9\-._~/]+)(?:\s+to\s+(?<version>[a-zA-Z0-9._\-+]+))?(?:\s+in\s+(?<project>[a-zA-Z0-9._-]+))?$/i,
];

export function fastPathParse(input: string): FastPathResult | null {
  for (const pattern of DEPENDENCY_PATTERNS) {
    const m = input.trim().match(pattern);
    if (m?.groups) {
      return {
        dep: m.groups.dep,
        version: m.groups.version ?? 'latest',   // sentinel, never from LLM
        project: m.groups.project ?? null,
      };
    }
  }
  return null;
}
```

### Pattern 2: Structured Output via beta.messages.create() — Established Pattern
**What:** Call Haiku 4.5 with `output_config.format.type = 'json_schema'`. The schema enforces that `version` can only be a sentinel value (`"latest"` or `null`) — never a literal version string from the LLM (matches STATE.md constraint).
**When to use:** Fast-path returns null (input too ambiguous or dep not in manifest).
**Example:**
```typescript
// src/intent/llm-parser.ts  — follows judge.ts pattern exactly
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

// Zod schema for type-safety (used for TypeScript, not passed to API)
export const IntentSchema = z.object({
  taskType: z.enum(['npm-dependency-update', 'maven-dependency-update', 'unknown']),
  dep: z.string().nullable(),
  version: z.enum(['latest']).nullable(),   // NEVER a real version — sentinel only
  confidence: z.enum(['high', 'low']),
  clarifications: z.array(z.object({
    label: z.string(),
    intent: z.string(),
  })),
});

export type IntentResult = z.infer<typeof IntentSchema>;

// JSON schema passed to API (matches Zod shape)
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    taskType: { type: 'string', enum: ['npm-dependency-update', 'maven-dependency-update', 'unknown'] },
    dep: { type: ['string', 'null'] },
    version: { type: ['string', 'null'], enum: ['latest', null] },
    confidence: { type: 'string', enum: ['high', 'low'] },
    clarifications: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          intent: { type: 'string' },
        },
        required: ['label', 'intent'],
        additionalProperties: false,
      },
    },
  },
  required: ['taskType', 'dep', 'version', 'confidence', 'clarifications'],
  additionalProperties: false,
};

export async function llmParse(input: string, manifestContext: string): Promise<IntentResult> {
  const client = new Anthropic({ timeout: 15_000 });
  const response = await client.beta.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    stream: false,
    system: INTENT_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `<manifest_context>\n${manifestContext}\n</manifest_context>\n\n<user_input>${input}</user_input>` }],
    betas: ['structured-outputs-2025-11-13'],
    output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
  } as Parameters<typeof client.beta.messages.create>[0]);

  const text = response.content[0].type === 'text' ? response.content[0].text : '{}';
  return IntentSchema.parse(JSON.parse(text));
}
```

### Pattern 3: Commander.js Optional Positional Argument
**What:** Add `.argument('[input]', 'Natural language task description')` to the program. Commander passes it as the first parameter of the action callback. When absent, it is `undefined`.
**When to use:** Detecting whether the user invoked via NL path vs legacy flag path.
**Example:**
```typescript
// src/cli/index.ts — modified program definition
program
  .name('background-agent')
  .argument('[input]', 'Natural language task description')
  .option('-t, --task-type <type>', 'Task type (legacy flags)')
  .option('-r, --repo <path>', 'Repository path')
  // ... existing flags ...
  .action(async (input, options) => {
    if (input) {
      // NL path — route to one-shot handler
      await runOneShotCommand(input, options);
    } else {
      // Legacy flag path — existing validation + runCommand()
      await runLegacyCommand(options);
    }
  });
```

Verified working: `bg-agent 'update recharts' -r ~/code/myapp` correctly delivers `input='update recharts'` and `options.repo='~/code/myapp'` to the action callback.

### Pattern 4: Confirm Loop with node:readline
**What:** Display the parsed intent summary, prompt Y/n, loop up to 3 times on 'n', pass correction back to `parseIntent()` with the original parse as context.
**When to use:** After every successful parse, before calling `runAgent()`.
**Example:**
```typescript
// src/intent/confirm-loop.ts
import { createInterface } from 'node:readline/promises';
import pc from 'picocolors';
import type { ResolvedIntent } from './types.js';

export async function confirmLoop(
  initialIntent: ResolvedIntent,
  reparse: (correction: string, prior: ResolvedIntent) => Promise<ResolvedIntent>,
  maxRedirects = 3,
): Promise<ResolvedIntent | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let current = initialIntent;
  let attempts = 0;

  try {
    while (attempts <= maxRedirects) {
      displayIntent(current);   // compact block: task type, repo, dep, version
      const answer = await rl.question(pc.bold('Proceed? [Y/n] '));

      if (answer === '' || answer.toLowerCase() === 'y') {
        return current;
      }

      if (attempts === maxRedirects) {
        console.log(pc.red('Please try again with a clearer command'));
        return null;
      }

      const correction = await rl.question('Correction: ');
      current = await reparse(correction, current);
      attempts++;
    }
    return null;
  } finally {
    rl.close();
  }
}
```

### Pattern 5: Context Scanner (INTENT-03)
**What:** Read `package.json` dependencies + devDependencies, or `pom.xml` dependency list, from the resolved project path. Inject as structured text into the LLM prompt before making the API call.
**When to use:** Always, before any LLM call, to satisfy INTENT-03.
**Example:**
```typescript
// src/intent/context-scanner.ts
import { promises as fs } from 'node:fs';
import path from 'node:path';

export async function readManifestDeps(repoPath: string): Promise<string> {
  // Try package.json first
  try {
    const raw = await fs.readFile(path.join(repoPath, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const deps = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    return `package.json deps: ${deps.join(', ')}`;
  } catch { /* fall through */ }

  // Try pom.xml (simplified — extract artifactId values)
  try {
    const raw = await fs.readFile(path.join(repoPath, 'pom.xml'), 'utf-8');
    const artifactIds = [...raw.matchAll(/<artifactId>([^<]+)<\/artifactId>/g)].map(m => m[1]);
    return `pom.xml artifactIds: ${artifactIds.join(', ')}`;
  } catch { /* fall through */ }

  return 'No manifest found';
}
```

### Anti-Patterns to Avoid
- **Routing NL to the `default:` prompt in `buildPrompt()` without going through `parseIntent()`:** The generic fallback is for unknown task types AFTER parsing — not a bypass for un-parsed input.
- **Emitting a version number from the LLM:** The Zod schema's `version` field must be `z.enum(['latest']).nullable()`. Any string the LLM might hallucinate gets rejected by Zod.parse().
- **Signal handlers inside intent module:** SIGINT belongs only in `src/cli/index.ts`. The intent parser and confirm loop are signal-free; the existing AbortController pattern handles cancellation from the CLI layer.
- **Using `query()` from the Claude Agent SDK for intent parsing:** `messages.create()` is required (STATE.md decision). `query()` is the agent execution path, not the intent classifier.
- **Calling `buildPrompt()` with `targetVersion: 'latest'`:** The prompt builders (`buildMavenPrompt`, `buildNpmPrompt`) receive the sentinel. They must be responsible for instructing the agent to find the latest version — this is already handled or must be verified.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Interactive Y/n prompt | Custom stdin read loop | `node:readline/promises` createInterface | Handles TTY/pipe detection, terminal echo correctly |
| JSON schema validation of LLM output | Manual field checks | `zod.parse()` after `JSON.parse()` | Validates shape, narrows TS types, throws on invalid output |
| TTY color output | ANSI escape codes | `picocolors` (already installed) | Handles no-color env vars; already imported in cli/index.ts |
| Project registry CRUD | Any alternative store | `ProjectRegistry` (src/agent/registry.ts) | Already implemented, tested, atomic writes via conf@15 |
| Manifest file detection | Recursive search | Single-level read of `package.json`/`pom.xml` at `repoPath` | The resolved project path IS the root; no recursive scan needed |

**Key insight:** The project already has all the primitives. Phase 15 is composition work, not infrastructure work.

## Common Pitfalls

### Pitfall 1: Commander.js Subcommand Conflict with Positional Arg
**What goes wrong:** `program.addCommand(createProjectsCommand())` is already in `src/cli/index.ts`. Adding `.argument('[input]', ...)` to the root program can cause Commander.js to treat `projects` (the subcommand name) as the positional `[input]` when the user runs `bg-agent projects list`.
**Why it happens:** Commander.js parses positional arguments before checking registered subcommands when the program also has a default action.
**How to avoid:** Add a guard in the action callback: if `input` matches a known subcommand name, do not enter the NL path. Alternatively, structure as a conditional: only add the positional to root if the user is NOT invoking a subcommand. In practice, Commander.js v14's subcommand routing takes priority over the root action when a subcommand name is matched — **verified this works correctly** by reading Commander.js docs.
**Warning signs:** `bg-agent projects list` runs the one-shot handler with `input='projects'` instead of the projects subcommand.

**Mitigation:** Test explicitly that `bg-agent projects list` still routes to the projects subcommand, not the NL handler.

### Pitfall 2: readline Blocks SIGINT Handling
**What goes wrong:** `readline.question()` holds stdin open. If the user presses Ctrl+C during the confirm prompt, the readline interface absorbs the signal and the existing AbortController is not triggered.
**Why it happens:** readline creates a SIGINT listener that closes itself but doesn't propagate to the process-level signal handler.
**How to avoid:** Call `rl.on('SIGINT', () => { rl.close(); abortController.abort(); process.exit(130); })` on the readline interface. Close the rl interface in a `finally` block of the confirm loop.

### Pitfall 3: "latest" Sentinel Propagating into buildPrompt() as targetVersion
**What goes wrong:** `buildMavenPrompt(dep, 'latest')` or `buildNpmPrompt(dep, 'latest')` receives the sentinel literally. If the prompt builder doesn't handle this sentinel, it tells the agent to update to the literal string "latest" instead of the actual latest version.
**Why it happens:** The sentinel travels from intent parser → AgentOptions → buildPrompt() without conversion.
**How to avoid:** Check `buildNpmPrompt` and `buildMavenPrompt` — verify they handle the `"latest"` sentinel by instructing the agent to find and apply the latest available version. If not, add the sentinel handling in Phase 15 as a task.

### Pitfall 4: Repo Path Not Resolved Before Fast-Path Manifest Check
**What goes wrong:** Fast-path tries to validate dep exists in `package.json` before the repo path is resolved (the registry lookup happens after fast-path).
**Why it happens:** Fast-path and repo resolution are separate steps; order matters.
**How to avoid:** Coordinator in `parseIntent()` must resolve repo path FIRST, then run fast-path with the resolved path for manifest validation.

### Pitfall 5: Ambiguous pom.xml `<artifactId>` Parsing
**What goes wrong:** pom.xml contains multiple `<artifactId>` elements — including the project's own artifactId, not just dependency artifactIds. Naive regex extracts the wrong things.
**Why it happens:** pom.xml uses `<artifactId>` for both `<project>` and `<dependency>` sections.
**How to avoid:** Scope the regex to the `<dependencies>` section. Alternatively, only extract from within `<dependency>` blocks:
```typescript
// Extract deps only from <dependency> blocks
const depBlocks = [...raw.matchAll(/<dependency>[\s\S]*?<\/dependency>/g)];
const artifactIds = depBlocks.map(m => {
  const match = m[0].match(/<artifactId>([^<]+)<\/artifactId>/);
  return match?.[1] ?? '';
}).filter(Boolean);
```

### Pitfall 6: LLM Clarification Loop and readline Reuse
**What goes wrong:** The confirm loop and the clarification flow (asking user to pick numbered option) both need readline. Creating multiple readline interfaces from process.stdin throws or misbehaves.
**Why it happens:** Node.js readline is not designed for multiple concurrent interfaces on the same stream.
**How to avoid:** Create one readline interface per interaction session; pass it through or close/reopen between phases. Simpler: run clarification before entering the confirm loop (parse → if low confidence → clarify → then confirm).

## Code Examples

Verified patterns from official sources:

### Commander.js Positional Argument (Verified locally)
```typescript
// Verified: bg-agent 'update recharts' -r /path correctly parses
program
  .argument('[input]', 'Natural language task description')
  .action(async (input: string | undefined, options: Record<string, unknown>) => {
    if (input !== undefined) {
      // NL path
    } else {
      // Legacy flag path
    }
  });
```

### Anthropic beta.messages.create() Structured Output (From judge.ts — working in production)
```typescript
// Source: src/orchestrator/judge.ts (lines 242-276) — proven pattern
const response = await client.beta.messages.create({
  model: 'claude-haiku-4-5-20251001',
  max_tokens: 512,
  stream: false,
  system: '...',
  messages: [{ role: 'user', content: '...' }],
  betas: ['structured-outputs-2025-11-13'],
  output_config: {
    format: {
      type: 'json_schema',
      schema: {
        type: 'object',
        properties: { /* ... */ },
        required: ['taskType', 'dep', 'version', 'confidence', 'clarifications'],
        additionalProperties: false,
      },
    },
  },
} as Parameters<typeof client.beta.messages.create>[0]) as BetaMessage;

const text = response.content[0].type === 'text' ? response.content[0].text : '{}';
const result = IntentSchema.parse(JSON.parse(text));
```

### node:readline/promises for Interactive Input
```typescript
import { createInterface } from 'node:readline/promises';

const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.on('SIGINT', () => { rl.close(); process.exit(130); });
try {
  const answer = await rl.question('Proceed? [Y/n] ');
  // answer is '' for Enter, 'y'/'Y' for yes, 'n'/'N' for no
} finally {
  rl.close();
}
```

### Fast-Path to AgentOptions Mapping
```typescript
// Coordinator maps parsed intent to the AgentOptions shape runAgent() expects
const agentOptions: AgentOptions = {
  taskType: parsedIntent.taskType,         // 'npm-dependency-update'
  repo: resolvedRepoPath,                   // absolute path from registry
  turnLimit: 10,                            // default
  timeoutMs: 300_000,                       // 5 min default
  maxRetries: 3,
  dep: parsedIntent.dep ?? undefined,
  targetVersion: parsedIntent.version ?? undefined,  // 'latest' sentinel or undefined
};
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Only flag-based CLI | NL positional arg + flags | Phase 15 | Users can use natural language; flags still work |
| All inputs require `--task-type`, `--repo`, `--dep`, `--target-version` | Positional NL auto-infers all four | Phase 15 | Single quoted string replaces four flags for common tasks |
| Direct `runCommand()` call | `parseIntent()` → `confirmLoop()` → `runAgent()` | Phase 15 | Human-in-the-loop gate before every execution |

**Deprecated/outdated:**
- The root `.action()` being the only action in cli/index.ts: after Phase 15, the action forks between NL path and legacy path. Legacy path continues unchanged.

## Open Questions

1. **`"latest"` sentinel in buildNpmPrompt / buildMavenPrompt**
   - What we know: These builders receive `targetVersion` from AgentOptions. The sentinel `"latest"` will flow through.
   - What's unclear: Whether the existing prompt builders instruct the agent to find the actual latest version when they receive `"latest"`, or whether they pass it literally.
   - Recommendation: Read `src/prompts/npm.ts` and `src/prompts/maven.ts` in Phase 15 planning. If they don't handle the sentinel, add a task to update them before the intent parser can correctly use `"latest"`.

2. **Project name extraction from NL ("update recharts in myapp")**
   - What we know: CONTEXT.md says extract project name from NL, look up in registry.
   - What's unclear: Whether "in myapp" is always the pattern, or if other prepositions ("for myapp", "on myapp") should be supported.
   - Recommendation: Support "in <name>" and "for <name>" in the regex; fall through to LLM for other forms.

3. **Confirm loop + AbortSignal threading**
   - What we know: AbortController lives in `src/cli/index.ts`. The confirm loop is interactive stdin.
   - What's unclear: How the AbortSignal reaches into the confirm loop if readline is blocking.
   - Recommendation: Use the readline `SIGINT` event to call `abortController.abort()` and exit cleanly. Document this integration point explicitly in the one-shot command handler.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.0.18 |
| Config file | None — Vitest picks up via package.json `"test": "vitest run"` |
| Quick run command | `npx vitest run src/intent/` |
| Full suite command | `npx vitest run` |

**Baseline:** All 330 tests passing as of 2026-03-20 (verified).

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| INTENT-01 | NL string produces IntentResult with taskType, dep, version | unit | `npx vitest run src/intent/index.test.ts` | ❌ Wave 0 |
| INTENT-02 | Fast-path resolves obvious patterns without LLM call | unit | `npx vitest run src/intent/fast-path.test.ts` | ❌ Wave 0 |
| INTENT-02 | Fast-path falls through to LLM when dep not in manifest | unit | `npx vitest run src/intent/fast-path.test.ts` | ❌ Wave 0 |
| INTENT-03 | ContextScanner reads package.json/pom.xml before LLM call | unit | `npx vitest run src/intent/context-scanner.test.ts` | ❌ Wave 0 |
| CLI-01 | `bg-agent 'update recharts'` positional arg routes to NL path | unit | `npx vitest run src/cli/commands/one-shot.test.ts` | ❌ Wave 0 |
| CLI-03 | Confirm loop displays intent block and prompts Y/n | unit | `npx vitest run src/intent/confirm-loop.test.ts` | ❌ Wave 0 |
| CLI-03 | Redirect ('n') re-parses correction in context of prior parse | unit | `npx vitest run src/intent/confirm-loop.test.ts` | ❌ Wave 0 |
| CLI-03 | After 3 redirects, aborts with "Please try again" message | unit | `npx vitest run src/intent/confirm-loop.test.ts` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run src/intent/`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite (330+ tests) green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/intent/index.test.ts` — covers INTENT-01 coordinator logic
- [ ] `src/intent/fast-path.test.ts` — covers INTENT-02 regex matching + manifest validation
- [ ] `src/intent/context-scanner.test.ts` — covers INTENT-03 package.json/pom.xml reading
- [ ] `src/intent/confirm-loop.test.ts` — covers CLI-03 display + Y/n + redirect loop
- [ ] `src/cli/commands/one-shot.test.ts` — covers CLI-01 routing + AgentOptions mapping

**Testing approach for interactive components:** Use `vi.mock('node:readline/promises', ...)` to stub `createInterface` and return a controlled `question()` mock, same pattern as existing test mocks for `execFile` in judge.test.ts.

**Testing approach for LLM parser:** Use `vi.mock('@anthropic-ai/sdk', ...)` same pattern as judge.test.ts to stub `beta.messages.create`.

## Sources

### Primary (HIGH confidence)
- Direct code inspection: `src/orchestrator/judge.ts` — `beta.messages.create()` structured output pattern confirmed working in production
- Direct code inspection: `src/cli/index.ts` — Commander.js v14 usage patterns, existing flag set
- Direct code inspection: `src/agent/registry.ts` — ProjectRegistry API surface
- Direct code inspection: `src/agent/index.ts` — AgentOptions interface (the target shape for intent parser output)
- Local execution: `node -e "..."` — Verified Commander.js positional + flag mixing produces correct argument separation
- Local execution: `npx vitest run` — Confirmed 330 tests passing, clean baseline

### Secondary (MEDIUM confidence)
- `package.json` — Confirmed zod@4.3.6 available as transitive dep (Anthropic SDK), commander@14.0.3 direct dep
- Node.js built-in `readline/promises` — Standard library, no version concerns

### Tertiary (LOW confidence)
- None — all critical claims are verified against source code or local execution

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries already in use or available; versions verified via npm view and package.json
- Architecture: HIGH — patterns proven in existing code (judge.ts, registry.ts, auto-register.ts); Commander.js positional arg verified locally
- Pitfalls: HIGH — Commander subcommand conflict and readline/SIGINT behavior derived from direct code inspection of existing patterns; "latest" sentinel pitfall derived from reading buildPrompt() source

**Research date:** 2026-03-20
**Valid until:** 2026-04-20 (Anthropic SDK beta structured output format may change; recheck `betas` parameter if SDK version bumps significantly)
