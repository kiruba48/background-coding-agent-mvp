# Phase 14: Infrastructure Foundation - Research

**Researched:** 2026-03-19
**Domain:** Node.js module extraction, AbortSignal threading, CLI subcommands, persistent key-value config
**Confidence:** HIGH

## Summary

Phase 14 has two cleanly separable workstreams: (1) extracting `runAgent()` from the CLI layer into a public library module, and (2) building a project registry backed by `conf@^15`. The codebase is already well-structured — `runAgent()` in `src/cli/commands/run.ts` is nearly ready for extraction; the main surgery is replacing `process.exit()` calls and process signal handlers with AbortSignal threading. The registry is new functionality with no legacy to migrate.

The most complex piece is the AbortSignal threading chain: an external `AbortSignal` passed to `runAgent()` must propagate into `RetryOrchestrator` and then into `ClaudeCodeSession`. `ClaudeCodeSession` already owns an internal `AbortController` for timeout; the threading strategy is to compose the external signal with that controller using `AbortSignal.any()` (Node 20+). The current process signal handlers (`SIGINT`/`SIGTERM`) in `run.ts` must be replaced — after extraction they would double-fire and cause crashes when called from REPL or one-shot contexts.

The `conf@^15.1.0` library handles the entire registry storage concern: atomic writes, OS-appropriate paths, ESM-native. The schema is simple (`Record<string, string>` mapping name to path). Commander.js subcommand nesting is already a solved pattern; `bg-agent projects list|add|remove` follows the same `program.command()` model already used for the `run` command.

**Primary recommendation:** Three focused plans — (A) runAgent() extraction + API shape, (B) AbortSignal threading through RetryOrchestrator → ClaudeCodeSession, (C) project registry with auto-registration hook.

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Registry behavior**
- Exact match only for short name resolution — no fuzzy/prefix matching
- Name conflicts on manual registration: prompt user to confirm overwrite (interactive mode), error in non-interactive
- Full CRUD: `bg-agent projects list`, `bg-agent projects remove <name>` (re-register replaces, no separate update command)
- Storage via `conf@^15` in OS-appropriate config dir (~/.config/background-agent/config.json)

**Auto-registration UX**
- Triggers on any bg-agent invocation in a cwd that has `.git`, `package.json`, or `pom.xml`
- Assigned name: directory basename (e.g., `/Users/kiruba/code/myapp` → `myapp`)
- Notification: one-line notice on first registration ("Registered project: myapp → /path/to/myapp")
- Conflict handling: skip silently if name already registered to a different path (don't overwrite auto)

**runAgent() public API**
- New top-level module: `src/agent/index.ts` exports `runAgent()`
- Returns full `RetryResult` (status, attempts, session results, verification results, judge results)
- Caller provides logger via options (falls back to no-op logger if omitted)
- `runAgent()` handles Docker lifecycle internally (assertDockerRunning, ensureNetwork, buildImage) — callers don't need Docker knowledge
- Signature shape: `runAgent(options: AgentOptions, context: { logger?, signal? }): Promise<RetryResult>`

**Cancellation UX**
- Clean abort: kill container, discard workspace changes, return 'cancelled' status. No partial results.
- 5-second grace period: signal abort to SDK, wait 5s for graceful shutdown, then docker kill
- New `'cancelled'` status added to `RetryResult.finalStatus` union type
- On cancellation, reset workspace to baseline SHA (git reset --hard to pre-agent state)

### Claude's Discretion
- Internal module structure within src/agent/
- How to wire AbortSignal through RetryOrchestrator → ClaudeCodeSession (threading strategy)
- Commander.js subcommand structure for `projects` commands
- Config schema design within conf

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| INFRA-01 | runAgent() extracted as importable function callable from REPL and one-shot paths | src/agent/index.ts module extraction pattern; AgentOptions type design; no process.exit() inside |
| INFRA-02 | runAgent() accepts AbortSignal for graceful mid-task cancellation | AbortSignal.any() composition; RetryOrchestrator threading; 5s grace + docker kill; git reset on cancel |
| REG-01 | User can register and resolve project short names to repo paths | conf@^15 API; ProjectRegistry class; CRUD subcommands via Commander.js |
| REG-02 | Terminal sessions auto-register cwd into project registry on first use | Git/manifest detection at CLI entry; basename derivation; silent-skip conflict rule |
</phase_requirements>

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| conf | ^15.1.0 | Persistent OS-appropriate key-value config (project registry) | ESM-native, atomic writes, no config directory management required, TypeScript types included. Current latest: 15.1.0 (verified npm registry). |
| commander | ^14.0.3 (already installed) | CLI subcommand routing for `projects` group | Already used in project; `.command('projects')` pattern is idiomatic |
| vitest | ^4.0.18 (already installed) | Unit tests for registry and runAgent() | Already the project test framework |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| node:fs/promises | built-in | stat check for .git / package.json / pom.xml detection | Use fs.access() — same pattern as current CLI repo path validation |
| node:path | built-in | basename() for auto-registration name derivation | path.basename(process.cwd()) |
| node:os | built-in | Not needed — conf handles OS config dir automatically | Only if overriding conf cwd |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| conf | lowdb | conf is simpler (no schema boilerplate), atomic writes built-in |
| conf | plain JSON + write-file-atomic | write-file-atomic already in project deps, but conf adds path management and typing |
| AbortSignal.any() | Custom event emitter | AbortSignal.any() is built-in Node 20+; project already targets Node 22 |

**Installation:**
```bash
npm install conf@^15
```

**Version verification:** conf@15.1.0 confirmed current as of 2026-03-19 via `npm view conf version`.

---

## Architecture Patterns

### Recommended Project Structure

```
src/
├── agent/
│   ├── index.ts          # Public API: exports runAgent(), AgentOptions, AgentContext
│   └── registry.ts       # ProjectRegistry class (conf wrapper)
├── cli/
│   ├── index.ts          # Imports from src/agent/ instead of commands/run.ts
│   ├── commands/
│   │   ├── run.ts        # Becomes thin CLI adapter: validate → call runAgent()
│   │   └── projects.ts   # New: projects subcommand group
│   └── ...
├── orchestrator/
│   ├── retry.ts          # Receives AbortSignal, threads to ClaudeCodeSession
│   └── claude-code-session.ts  # Composes external signal with internal timeout controller
└── types.ts              # Add 'cancelled' to RetryResult.finalStatus union
```

### Pattern 1: runAgent() as Library Function

**What:** `src/agent/index.ts` owns the full execution pipeline — Docker lifecycle, orchestrator instantiation, and result mapping. Returns `RetryResult` directly instead of an exit code. Never calls `process.exit()`.

**When to use:** Any entry point that needs to trigger an agent run: CLI, REPL (Phase 16), one-shot (Phase 15).

**Example:**
```typescript
// src/agent/index.ts
export interface AgentOptions {
  taskType: string;
  repo: string;
  turnLimit: number;
  timeoutMs: number;
  maxRetries: number;
  noJudge?: boolean;
  createPr?: boolean;
  branchOverride?: string;
  dep?: string;
  targetVersion?: string;
}

export interface AgentContext {
  logger?: pino.Logger;  // falls back to no-op pino logger if omitted
  signal?: AbortSignal;  // graceful cancellation
}

export async function runAgent(
  options: AgentOptions,
  context: AgentContext = {}
): Promise<RetryResult> {
  const logger = context.logger ?? pino({ level: 'silent' });
  // Docker lifecycle (internalized from src/cli/docker)
  await assertDockerRunning();
  await ensureNetworkExists();
  await buildImageIfNeeded();
  // Orchestrator — signal passed through
  const orchestrator = new RetryOrchestrator({ ... }, { ..., signal: context.signal });
  return orchestrator.run(prompt, logger);
}
```

**CLI adapter becomes:**
```typescript
// src/cli/commands/run.ts (after refactor)
import { runAgent } from '../../agent/index.js';
// ... validate options ...
const result = await runAgent(agentOptions, { logger, signal: /* AbortSignal from handlers */ });
const exitCode = mapStatusToExitCode(result.finalStatus);
process.exit(exitCode);
```

### Pattern 2: AbortSignal Threading via AbortSignal.any()

**What:** `ClaudeCodeSession` already creates an internal `AbortController` for timeout. Thread an external signal by composing them with `AbortSignal.any([externalSignal, this.abortController.signal])` before passing to the SDK's `query()`.

**When to use:** Whenever `ClaudeCodeSession` runs — replace the current internal `abortController` assignment.

**Example:**
```typescript
// src/orchestrator/claude-code-session.ts — modified run()
async run(userMessage: string, logger?: pino.Logger, signal?: AbortSignal): Promise<SessionResult> {
  this.abortController = new AbortController();

  const timeoutMs = this.config.timeoutMs ?? 300_000;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    this.abortController?.abort();
  }, timeoutMs);

  // Compose external signal with internal timeout signal
  const composedSignal = signal
    ? AbortSignal.any([signal, this.abortController.signal])
    : this.abortController.signal;

  // Pass composedSignal to query()
  queryGen = query({
    prompt: userMessage,
    options: {
      abortController: { signal: composedSignal }, // SDK accepts signal
      ...
    },
  });
  // ...
}
```

**Detecting cancellation vs timeout:**
```typescript
// In the catch block, distinguish cancelled from timed out:
} catch (err) {
  if (signal?.aborted) {
    return { sessionId, status: 'cancelled', ... };
  }
  if (timedOut) {
    return { sessionId, status: 'timeout', ... };
  }
  // ... failed
}
```

**Note:** `AbortSignal.any()` is available in Node.js 20+ (project runs Node 22 per `package.json` type=module with ES2022 target). Confidence: HIGH.

### Pattern 3: Cancellation Cleanup (5s grace + git reset)

**What:** On AbortSignal fire, the orchestrator must: (1) abort SDK session, (2) wait up to 5s for clean shutdown, (3) docker kill container if still running, (4) git reset --hard to baselineSha, (5) return `'cancelled'` status.

**When to use:** Whenever `RetryOrchestrator.run()` receives an external signal that fires mid-run.

**Example structure:**
```typescript
// In RetryOrchestrator.run() — wrap the session loop
if (signal?.aborted) {
  await session.stop();
  await resetWorkspace(this.config.workspaceDir, baselineSha);
  return { finalStatus: 'cancelled', attempts: attempt, ... };
}

// After session completes with abort
if (sessionResult.status === 'cancelled') {
  await resetWorkspace(this.config.workspaceDir, baselineSha);
  return { finalStatus: 'cancelled', ... };
}
```

The `captureBaselineSha()` is already called at the start of `RetryOrchestrator.run()` — reuse that captured SHA for the reset.

### Pattern 4: ProjectRegistry with conf

**What:** A thin class wrapping `Conf` instance. All registry operations are synchronous reads and atomic writes.

**Example:**
```typescript
// src/agent/registry.ts
import Conf from 'conf';

interface RegistrySchema {
  projects: Record<string, string>; // name -> absolute path
}

export class ProjectRegistry {
  private store: Conf<RegistrySchema>;

  constructor() {
    this.store = new Conf<RegistrySchema>({
      projectName: 'background-agent',
      defaults: { projects: {} },
    });
  }

  register(name: string, path: string): void {
    const projects = this.store.get('projects');
    projects[name] = path;
    this.store.set('projects', projects);
  }

  resolve(name: string): string | undefined {
    return this.store.get('projects')[name];
  }

  has(name: string): boolean {
    return name in this.store.get('projects');
  }

  remove(name: string): boolean {
    const projects = this.store.get('projects');
    if (!(name in projects)) return false;
    delete projects[name];
    this.store.set('projects', projects);
    return true;
  }

  list(): Record<string, string> {
    return { ...this.store.get('projects') };
  }
}
```

Config stored at: `~/.config/background-agent/config.json` on Linux/Mac (conf handles this).

### Pattern 5: Auto-Registration Hook

**What:** Detect project indicators at CLI startup and silently register if not already known.

**When to use:** Every `bg-agent` invocation before running the main action.

**Example:**
```typescript
// src/cli/auto-register.ts
import { promises as fs } from 'node:fs';
import path from 'node:path';

const INDICATORS = ['.git', 'package.json', 'pom.xml'];

export async function autoRegisterCwd(registry: ProjectRegistry): Promise<void> {
  const cwd = process.cwd();
  const name = path.basename(cwd);

  // Check if any indicator exists
  const found = await Promise.any(
    INDICATORS.map(f => fs.access(path.join(cwd, f)))
  ).catch(() => null);
  if (found === null) return; // no indicators

  // Conflict: name already points to different path — skip silently
  const existing = registry.resolve(name);
  if (existing !== undefined && existing !== cwd) return;

  // Already registered to same path — no-op
  if (existing === cwd) return;

  // New registration
  registry.register(name, cwd);
  console.log(`Registered project: ${name} → ${cwd}`);
}
```

### Pattern 6: Commander.js Subcommand Group

**What:** `projects` becomes a nested Command, with `list`, `add`, `remove` as sub-sub-commands.

**Example:**
```typescript
// src/cli/commands/projects.ts
import { Command } from 'commander';
import { ProjectRegistry } from '../../agent/registry.js';

export function createProjectsCommand(): Command {
  const projects = new Command('projects').description('Manage registered projects');

  projects
    .command('list')
    .description('List all registered projects')
    .action(() => { ... });

  projects
    .command('add <name> <path>')
    .description('Register a project short name')
    .action(async (name, repoPath) => { ... });

  projects
    .command('remove <name>')
    .description('Remove a registered project')
    .action((name) => { ... });

  return projects;
}
```

In `src/cli/index.ts`: `program.addCommand(createProjectsCommand())`.

### Anti-Patterns to Avoid

- **Signal handlers inside runAgent():** `process.once('SIGINT', ...)` inside `runAgent()` causes double-handlers when called from REPL. Signal → AbortController → AbortSignal threading is the correct approach. Handlers belong only in CLI entry points.
- **process.exit() inside runAgent():** Library functions must never exit the process. Return results, let the caller decide exit code.
- **Storing registry in `src/` relative paths:** Always use `conf` with `projectName` — never hardcode a path. Allows tests to override with `cwd`.
- **Merging external signal into existing AbortController by listening to 'abort' event:** Causes race conditions. Use `AbortSignal.any()` which is atomic.
- **Auto-registration on name conflict overwriting existing entry:** Silently skip per locked decision. Do not overwrite auto-registrations.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Persistent config with atomic writes | Custom JSON file + write-file-atomic | conf@^15 | conf handles file locking, OS config paths, JSON serialization, TypeScript types |
| AbortSignal composition | Manual 'abort' event forwarding | AbortSignal.any() | Built-in, no race conditions, handles cleanup automatically |
| OS config directory detection | Platform-specific path construction | conf projectName option | conf uses env-paths internally, handles XDG_CONFIG_HOME on Linux |

**Key insight:** The two hardest parts (persistent storage and signal composition) are both solved by standard Node.js/npm primitives. Custom implementations would miss edge cases (filesystem errors, signal order, XDG compliance).

---

## Common Pitfalls

### Pitfall 1: Process Signal Handlers Fire Twice in REPL Context

**What goes wrong:** The current `run.ts` registers `process.once('SIGINT')` handlers inside `runAgent()`. When Phase 15 calls `runAgent()` from REPL, Ctrl+C fires the REPL's own SIGINT handler AND the one registered inside `runAgent()`, causing double-cleanup and potential crashes.

**Why it happens:** `process.once` is per-process, not per-invocation. Multiple `runAgent()` calls stack multiple handlers.

**How to avoid:** Remove ALL `process.once('SIGINT/SIGTERM')` from `runAgent()`. The CLI entry point (`src/cli/index.ts`) keeps its own handlers that create an AbortController and pass its signal into `runAgent()`.

**Warning signs:** "Already handled" errors, `process.exit()` called twice, zombie Docker containers after Ctrl+C.

### Pitfall 2: Timeout Controller and External Signal Fight Each Other

**What goes wrong:** If the external signal fires AFTER the timeout controller fires, both try to abort the session. The second abort is a no-op on the signal, but the status detection logic may misclassify the result.

**Why it happens:** `timedOut` boolean and `signal?.aborted` are checked separately in the catch block.

**How to avoid:** Check `signal?.aborted` BEFORE `timedOut` in the catch block. If external abort happened, return 'cancelled' regardless of whether timeout also fired. `AbortSignal.any()` ensures the SDK only sees one unified signal.

### Pitfall 3: git reset --hard Runs on Success Path

**What goes wrong:** If reset logic is placed in a `finally` block, it fires on success too, discarding the agent's work.

**Why it happens:** Cancellation cleanup being over-eager with `finally`.

**How to avoid:** Reset only on `'cancelled'` status. Place reset in the cancellation branch, not in `finally`. The baseline SHA is already captured; only use it when `signal?.aborted` is true.

### Pitfall 4: conf ESM Import with NodeNext Module Resolution

**What goes wrong:** `import Conf from 'conf'` may fail TypeScript compilation with `moduleResolution: NodeNext` if the package's `exports` field isn't recognized.

**Why it happens:** `conf@15` exports `{ default: './dist/source/index.js', types: './dist/source/index.d.ts' }` — a default-only export without `import` condition.

**How to avoid:** Use `import Conf from 'conf'` (default import). Verified: conf@15 exports a default entry that NodeNext resolves correctly. If issues arise, `import { default as Conf } from 'conf'` is the fallback. Confidence: MEDIUM (based on npm exports field inspection; test at install time).

### Pitfall 5: Auto-Registration Fires on Every CLI Invocation Including `projects` Subcommands

**What goes wrong:** `bg-agent projects list` triggers auto-registration, adding the current directory even when the user is just inspecting their project list.

**Why it happens:** Auto-registration hooked at the top of every CLI action.

**How to avoid:** Hook auto-registration only in the `run` command action, not in `projects` subcommands. Or guard it behind checking whether `taskType` is actually being invoked.

---

## Code Examples

Verified patterns from official sources and the project's own codebase:

### AbortSignal.any() — Signal Composition

```typescript
// Node.js 20+ built-in — no import needed
// Resolves when EITHER signal fires
const composedSignal = AbortSignal.any([externalSignal, internalController.signal]);

// Use composedSignal wherever a signal is accepted
```

### conf — Basic Usage

```typescript
// Source: https://github.com/sindresorhus/conf (v15 readme)
import Conf from 'conf';

const store = new Conf<{ projects: Record<string, string> }>({
  projectName: 'background-agent',
  defaults: { projects: {} },
});

// Get config file path (for debugging)
console.log(store.path); // ~/.config/background-agent/config.json on macOS/Linux

// Atomic set
const projects = store.get('projects');
projects['myapp'] = '/Users/kiruba/code/myapp';
store.set('projects', projects);

// Read
const path = store.get('projects')['myapp']; // '/Users/kiruba/code/myapp'
```

### conf — Test Isolation with Temp Directory

```typescript
// For unit tests: override storage location to avoid polluting real config
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

const tmpDir = mkdtempSync(path.join(tmpdir(), 'bg-agent-test-'));
const store = new Conf({ projectName: 'bg-agent-test', cwd: tmpDir });
// cleanup: rm -rf tmpDir after test
```

### RetryResult — Adding 'cancelled' Status

```typescript
// src/types.ts — extend existing union
export interface RetryResult {
  finalStatus: 'success' | 'failed' | 'timeout' | 'turn_limit' | 'max_retries_exhausted' | 'vetoed' | 'cancelled';
  // ... rest unchanged
}
```

### Exit Code Mapping — Adding Cancelled Case

```typescript
// src/cli/commands/run.ts adapter
switch (result.finalStatus) {
  case 'success':      return 0;
  case 'timeout':      return 124;
  case 'cancelled':    return 130; // same as SIGINT convention
  default:             return 1;
}
```

### Commander.js — Adding Subcommand Group

```typescript
// src/cli/index.ts
import { createProjectsCommand } from './commands/projects.js';

program.addCommand(createProjectsCommand());
// No change to existing 'run' command registration
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `process.once('SIGINT')` inside runAgent() | AbortSignal passed into runAgent() as context | Phase 14 | Enables multiple callers (CLI, REPL, one-shot) without handler conflicts |
| runAgent() returns exit code (number) | runAgent() returns RetryResult | Phase 14 | Callers can inspect result; CLI maps to exit code itself |
| No project registry | conf-backed ProjectRegistry | Phase 14 | Enables short-name resolution for conversational interface |

**Deprecated/outdated:**
- Current `RunOptions` type in `src/cli/commands/run.ts`: superseded by `AgentOptions` in `src/agent/index.ts` (same fields, different home)
- Current `runAgent()` in `src/cli/commands/run.ts`: becomes a thin CLI adapter after extraction

---

## Open Questions

1. **AbortController vs signal in SDK query() options**
   - What we know: Current code passes `abortController: this.abortController` to `query()` options. The SDK type for that option is `AbortController`, not `AbortSignal`.
   - What's unclear: Does the SDK accept only `AbortController` (full controller), or can it accept a signal? If it requires the full controller, `AbortSignal.any()` won't work directly — we'd need to listen to the composed signal and call `controller.abort()`.
   - Recommendation: Inspect SDK types at `node_modules/@anthropic-ai/claude-agent-sdk/`. The simplest safe approach: keep the internal `AbortController`, and listen to the external signal: `externalSignal.addEventListener('abort', () => this.abortController.abort(), { once: true })`.

2. **Interactive vs non-interactive detection for registry conflict prompt**
   - What we know: On manual `bg-agent projects add` name conflict, locked decision says "prompt user to confirm overwrite (interactive mode), error in non-interactive".
   - What's unclear: Whether to use `process.stdout.isTTY` or a `--yes` flag for the detection.
   - Recommendation: Use `process.stdout.isTTY` — same pattern used implicitly by the existing logger's pretty-print detection.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest ^4.0.18 |
| Config file | none — vitest runs with defaults (package.json scripts: `"test": "vitest run"`) |
| Quick run command | `npx vitest run src/agent/` |
| Full suite command | `npm test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| INFRA-01 | runAgent() is importable from src/agent/index.ts and returns RetryResult | unit | `npx vitest run src/agent/index.test.ts` | Wave 0 |
| INFRA-01 | CLI adapter correctly maps RetryResult to exit code | unit | `npx vitest run src/cli/commands/run.test.ts` | Wave 0 |
| INFRA-02 | AbortSignal causes session to return 'cancelled' status | unit | `npx vitest run src/agent/index.test.ts` | Wave 0 |
| INFRA-02 | git reset --hard fires on cancellation, not on success | unit | `npx vitest run src/agent/index.test.ts` | Wave 0 |
| INFRA-02 | 5-second grace period before docker kill | unit | `npx vitest run src/orchestrator/claude-code-session.test.ts` | ❌ new test case needed |
| REG-01 | register/resolve/has/remove/list operations correct | unit | `npx vitest run src/agent/registry.test.ts` | Wave 0 |
| REG-01 | Manual add conflict: error in non-interactive mode | unit | `npx vitest run src/cli/commands/projects.test.ts` | Wave 0 |
| REG-02 | Auto-register fires when .git present, not when absent | unit | `npx vitest run src/cli/auto-register.test.ts` | Wave 0 |
| REG-02 | Auto-register skips silently if name registered to different path | unit | `npx vitest run src/cli/auto-register.test.ts` | Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run src/agent/ src/cli/auto-register.test.ts src/cli/commands/projects.test.ts`
- **Per wave merge:** `npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `src/agent/index.test.ts` — covers INFRA-01 (importability, RetryResult return) and INFRA-02 (cancellation, git reset)
- [ ] `src/agent/registry.test.ts` — covers REG-01 (CRUD operations, conf temp dir override)
- [ ] `src/cli/commands/projects.test.ts` — covers REG-01 (CLI subcommand routing, conflict handling)
- [ ] `src/cli/auto-register.test.ts` — covers REG-02 (indicator detection, conflict skip, basename derivation)
- [ ] `src/cli/commands/run.test.ts` — covers INFRA-01 (thin adapter, exit code mapping for 'cancelled')

---

## Sources

### Primary (HIGH confidence)
- Project source files read directly: `src/cli/commands/run.ts`, `src/orchestrator/retry.ts`, `src/orchestrator/claude-code-session.ts`, `src/types.ts`, `src/cli/docker/index.ts`, `src/cli/index.ts`, `src/cli/utils/logger.ts`
- `npm view conf version` — confirmed conf@15.1.0 current latest
- `npm view conf@15 exports` — confirmed ESM-native default export structure
- `.planning/phases/14-infrastructure-foundation/14-CONTEXT.md` — all locked decisions

### Secondary (MEDIUM confidence)
- https://github.com/sindresorhus/conf readme via WebFetch — conf API summary (constructor, get/set/delete/has, cwd override for testing)
- Node.js 20 changelog — `AbortSignal.any()` available Node 20+; project targets Node 22

### Tertiary (LOW confidence)
- conf@15 compatibility with `moduleResolution: NodeNext` — inferred from exports field; validate at install time

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — conf version verified against npm registry; all other libs already in project
- Architecture: HIGH — extraction pattern derived from reading actual source code; no guesswork
- Pitfalls: HIGH — signal handler pitfall and process.exit pitfall directly observed in current run.ts; git reset pitfall from cancellation spec analysis
- AbortSignal.any() availability: HIGH — Node 22 confirmed from package.json (Node 20+ feature)
- conf NodeNext compatibility: MEDIUM — inferred from exports field inspection, not tested

**Research date:** 2026-03-19
**Valid until:** 2026-04-19 (conf is stable; SDK may update, but AbortController API is stable)
