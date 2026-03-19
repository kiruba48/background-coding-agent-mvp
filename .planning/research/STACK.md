# Stack Research

**Domain:** Conversational agent interface — background-coding-agent v2.1
**Researched:** 2026-03-19
**Confidence:** HIGH — primary sources are official Anthropic Agent SDK docs, Node.js docs, and live npm registry data

---

## Scope

This file covers ONLY new stack additions required for the v2.1 Conversational Mode milestone.

Validated existing dependencies (Node.js 20, TypeScript ESM/NodeNext, Commander.js, Pino, Vitest, ESLint v10, Octokit, simple-git, write-file-atomic, picocolors, `@anthropic-ai/claude-agent-sdk@^0.2.77`, `@anthropic-ai/sdk@^0.71.2`) are not re-researched here.

---

## New Stack Additions

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| `node:readline` (built-in) | Node.js 20 built-in | Interactive REPL — prompt loop, history, tab completion | Zero dependency. Node.js 20 readline is stable and feature-complete for this use case. Supports `history` array injection on startup, `'history'` event for persistence, `removeHistoryDuplicates`, and `completer` for tab completion. The `readline/promises` subpath provides async/await variants. No library can beat "no install required." |
| `conf` | `^15.1.0` | Project registry — persist project name→path mappings to OS config dir | ESM-native (`type: module`), Node.js 20+ required, ships TypeScript declarations, atomic writes, correct platform-specific config paths (`~/Library/Preferences/` on macOS, `~/.config/` on Linux via XDG). Direct successor to configstore (Sindre Sorhus recommends conf over configstore for new projects). v15 is the latest stable release as of 2026-03-19. |
| `zod` | `^4.3.6` | Intent parser schema — extract structured `{ taskType, dep, targetVersion, repo }` from natural language via Agent SDK `outputFormat` | Already a transitive dep via Agent SDK (which accepts Zod 3 or 4). Zod 4 adds native `z.toJSONSchema()` (no external converter needed), ships ESM + CJS in one package, and has full TypeScript inference. Used to define the intent schema and convert it to JSON Schema for `query({ options: { outputFormat: { type: 'json_schema', schema: z.toJSONSchema(IntentSchema) } } })`. |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@anthropic-ai/sdk` | `^0.71.2` (already installed) | Intent parser LLM calls — `messages.create()` with structured output via `output_config.format` | Intent parsing is a single-turn LLM call (natural language in, structured JSON out). Using `@anthropic-ai/sdk` directly (rather than the Agent SDK's multi-turn `query()`) is correct here — it's cheaper, faster, and does not start a Claude Code subprocess. The SDK is already installed as a prod dep. |

---

## How Each Feature Uses This Stack

### REPL Interface

Built entirely on `node:readline` (zero new dependencies).

```typescript
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';

// Load saved history on startup
let history: string[] = [];
try {
  history = readFileSync(historyFilePath, 'utf-8').split('\n').filter(Boolean);
} catch { /* file doesn't exist yet */ }

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: 'agent> ',
  historySize: 200,
  removeHistoryDuplicates: true,
  history,
});

// Persist history on every change
rl.on('history', (h: string[]) => {
  writeFileSync(historyFilePath, h.join('\n'));
});

rl.prompt();
rl.on('line', async (input) => {
  await handleInput(input.trim());
  rl.prompt();
});
```

History file path: use `conf` to resolve the config directory, then store `repl_history` alongside the project registry JSON.

### LLM Intent Parser

Uses `@anthropic-ai/sdk` structured output (single-turn, not Agent SDK multi-turn):

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

const IntentSchema = z.object({
  taskType: z.enum(['maven-dependency-update', 'npm-dependency-update', 'unknown']),
  dep: z.string().optional(),
  targetVersion: z.string().optional(),
  repo: z.string().optional(),   // project short name or absolute path
  confidence: z.enum(['high', 'low']),
});

type Intent = z.infer<typeof IntentSchema>;

const client = new Anthropic();
const response = await client.messages.create({
  model: 'claude-haiku-4-5',   // same model as LLM Judge — cheap, fast
  max_tokens: 256,
  messages: [{ role: 'user', content: userInput }],
  system: INTENT_SYSTEM_PROMPT,
  output_config: {
    format: {
      type: 'json_schema',
      schema: z.toJSONSchema(IntentSchema),
    },
  },
});

const intent = IntentSchema.parse(JSON.parse(response.content[0].text));
```

**Why `@anthropic-ai/sdk` and not `query()`:** Intent parsing is a single-turn LLM call with no tool use. `query()` spawns a Claude Code subprocess and starts a full agent loop — it costs more and takes longer. The existing `@anthropic-ai/sdk` dep is exactly right for this; the LLM Judge already uses the same pattern.

### Project Registry

Uses `conf` to persist a JSON map of `{ [name: string]: string }` (short name → absolute repo path):

```typescript
import Conf from 'conf';

const registry = new Conf<{ projects: Record<string, string> }>({
  projectName: 'background-coding-agent',
  defaults: { projects: {} },
});

// Register cwd on REPL startup
registry.set(`projects.${basename(cwd())}`, cwd());

// Resolve "my-app" → "/Users/alice/code/my-app"
function resolveRepo(nameOrPath: string): string | undefined {
  if (isAbsolute(nameOrPath)) return nameOrPath;
  return registry.get('projects')[nameOrPath];
}
```

Config stored at:
- macOS: `~/Library/Preferences/background-coding-agent-nodejs/config.json`
- Linux: `~/.config/background-coding-agent-nodejs/config.json`

### Multi-Turn Session Management

**No new dependencies.** The Agent SDK (`@anthropic-ai/claude-agent-sdk`) already handles all session state natively.

Pattern for REPL follow-up tasks within the same project:

```typescript
import { query, listSessions } from '@anthropic-ai/claude-agent-sdk';

// First task: creates a session, capture session_id
let sessionId: string | undefined;
for await (const msg of query({ prompt, options: { cwd: repoPath, maxTurns: 10 } })) {
  if (msg.type === 'result') {
    sessionId = msg.session_id;   // persist to registry for this project
  }
}

// Follow-up task: resume with full prior context
for await (const msg of query({
  prompt: followUpPrompt,
  options: { resume: sessionId, cwd: repoPath, maxTurns: 10 },
})) { ... }
```

For "continue most recent session" (simpler REPL flow):
```typescript
options: { continue: true, cwd: repoPath }
```

Session files are written automatically by the SDK to `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. The REPL stores the `session_id` per project in the `conf` registry so users can resume after process restarts.

---

## Installation

```bash
# New dependency: project registry
npm install conf

# New dependency: structured schemas for intent parser
# Check if zod is already present as a direct dep first:
# cat package.json | grep '"zod"'
# If not listed, add it:
npm install zod

# node:readline is built-in — no install needed
# @anthropic-ai/sdk is already installed — no change needed
# @anthropic-ai/claude-agent-sdk is already installed — no change needed
```

---

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| `node:readline` (built-in) | `inquirer` / `enquirer` / `prompts` | Only if you need complex interactive forms (multi-select, confirm dialogs, validation UX). For a freeform text REPL, readline is sufficient and avoids a dependency. |
| `node:readline` (built-in) | `readline-sync` | Never — synchronous I/O blocks the event loop, incompatible with async agent calls. |
| `conf@^15` | `configstore@^8` | Never for new projects — configstore's own README recommends conf as its replacement. conf uses correct OS-native config dirs, not `~/.config` on all platforms. |
| `conf@^15` | Raw `fs` + `write-file-atomic` | If the registry is extremely simple and you want zero new deps. Acceptable — write-file-atomic is already installed. Requires hand-rolling atomic writes, path resolution, and directory creation. conf is ~20 lines saved. |
| `@anthropic-ai/sdk` for intent parsing | `query()` (Agent SDK) | If intent parsing needed multiple turns or tool use (it doesn't). For single-turn structured extraction, the base SDK is cheaper and faster. |
| `zod@^4` | `zod@^3` | If Agent SDK `tool()` usage requires Zod 3 (it doesn't — SDK accepts both since v0.1.71). Zod 4 has `z.toJSONSchema()` built-in, eliminating the need for `zod-to-json-schema` as a separate converter. |

---

## What NOT to Add

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `inquirer` / `enquirer` | Heavy interactive form libraries designed for wizard-style CLIs, not freeform text REPLs. 4–15 dependencies each. | `node:readline` built-in |
| `readline-sync` | Synchronous — blocks Node.js event loop. Agent calls are async; mixing sync I/O with async agents causes deadlocks. | `node:readline` built-in (async) |
| `@modelcontextprotocol/sdk` | Not needed — MCP verifier server already uses `createSdkMcpServer()` built into Agent SDK. No new MCP servers needed for conversational features. | Agent SDK's built-in MCP support |
| LangChain / LangGraph | Unnecessary abstraction over a use case that is two LLM calls (intent parse + agent run). Adds 50+ transitive deps and API churn. | `@anthropic-ai/sdk` (single-turn) + `query()` (agent) |
| Custom session store (SQLite, Redis) | The Agent SDK writes session state to `~/.claude/projects/` automatically as JSONL. Zero code needed for persistence. | `resume: sessionId` option on `query()` |
| `node-persist` / `lowdb` | Over-engineered for a small project registry (tens of entries). conf is purpose-built for exactly this use case. | `conf@^15` |
| `vorpal` / `ink` | Full CLI framework / React terminal UI. No UI complexity needed — plain readline prompt suffices. | `node:readline` + `picocolors` (already installed) |

---

## Version Compatibility

| Package | Compatible With | Notes |
|---------|-----------------|-------|
| `conf@^15.1.0` | Node.js 20+ | `engines: { node: '>=20' }` — matches project baseline exactly |
| `conf@^15.1.0` | TypeScript `NodeNext` | ESM-native (`type: module`). Imports as `import Conf from 'conf'`. Ships its own `.d.ts`. |
| `zod@^4.3.6` | `@anthropic-ai/claude-agent-sdk@^0.2.77` | SDK accepts Zod 3 or 4 as peer dep since v0.1.71. `z.toJSONSchema()` is Zod 4 only. |
| `zod@^4.3.6` | `@anthropic-ai/sdk@^0.71.2` | `messages.create()` with `output_config.format` accepts plain JSON Schema (not Zod object). Use `z.toJSONSchema(schema)` to convert. |
| `node:readline` | Node.js 20 | Built-in. `readline/promises` subpath available since Node.js 17. |
| `@anthropic-ai/sdk@^0.71.2` | `output_config.format` structured output | `output_config.format` API (no beta headers required since 2025-11-13 migration). `messages.create()` returns structured JSON matching schema. |

---

## Sources

- [Agent SDK TypeScript Reference — `Options` type](https://platform.claude.com/docs/en/agent-sdk/typescript) — `continue`, `resume`, `forkSession`, `persistSession`, `outputFormat`, `session_id` on `SDKResultMessage` (HIGH confidence — official Anthropic docs, verified 2026-03-19)
- [Agent SDK — Work with Sessions](https://platform.claude.com/docs/en/agent-sdk/sessions) — `continue: true`, `resume: sessionId`, `forkSession`, `listSessions()`, `getSessionMessages()`, session file location at `~/.claude/projects/<encoded-cwd>/` (HIGH confidence — official Anthropic docs, verified 2026-03-19)
- [Agent SDK — Structured Outputs](https://platform.claude.com/docs/en/agent-sdk/structured-outputs) — `outputFormat: { type: 'json_schema', schema: z.toJSONSchema(Schema) }`, `message.structured_output` on result, `error_max_structured_output_retries` subtype (HIGH confidence — official Anthropic docs, verified 2026-03-19)
- [Claude API — Structured Outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) — `output_config.format` in `@anthropic-ai/sdk`, no beta header required, `messages.parse()` helper, Zod integration via `zodOutputFormat()` (HIGH confidence — official Anthropic docs, verified 2026-03-19)
- [Node.js v20 Readline API](https://nodejs.org/api/readline.html) — `createInterface` options: `history`, `historySize`, `removeHistoryDuplicates`, `completer`; `'history'` event for persistence (HIGH confidence — official Node.js docs, verified 2026-03-19)
- [conf GitHub README](https://github.com/sindresorhus/conf) — API (`new Conf`, `.get()`, `.set()`), TypeScript generics, atomic writes, platform paths (HIGH confidence — official repo, verified 2026-03-19)
- npm registry (live) — `conf@15.1.0`, `zod@4.3.6`, `@anthropic-ai/sdk@0.80.0`, `configstore@8.0.0`, `env-paths@4.0.0` as of 2026-03-19 (HIGH confidence — `npm show` command executed in project, verified 2026-03-19)
- Agent SDK Zod compatibility — "supports both Zod 3 and Zod 4" (HIGH confidence — official Anthropic docs + WebSearch confirming since v0.1.71, verified 2026-03-19)

---
*Stack research for: Conversational REPL + intent parser + project registry + multi-turn sessions (background-coding-agent v2.1)*
*Researched: 2026-03-19*
