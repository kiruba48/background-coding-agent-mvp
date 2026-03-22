# Phase 16: Interactive REPL - Research

**Researched:** 2026-03-20
**Domain:** Node.js readline REPL loop, AbortController signal handling, history persistence, spinner libraries
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Architecture — channel-agnostic split**
- Session core in `src/repl/session.ts` — channel-agnostic loop (takes input string, returns structured result via parseIntent → confirmLoop → runAgent)
- CLI adapter in `src/cli/commands/repl.ts` — owns readline, prompt rendering, colors, history, Ctrl+C handling
- This split enables future Slack/MCP adapter to plug into the same session core without refactoring

**Prompt & session UX**
- Project-aware prompt: starts as `bg> `, changes to `myapp> ` once a project is resolved from the first task
- Status banner at startup: tool name, version, Docker status, registered project count, then hint line
- Structured result block between tasks: boxed card showing status, attempts, verify result, judge verdict, PR link
- `exit` command or Ctrl+D to quit the REPL session

**Signal handling**
- Ctrl+C at idle prompt: Clear current line, show fresh prompt (shell-like behavior)
- Ctrl+C during confirm prompt (Proceed? [Y/n]): Cancel the current task, return to REPL prompt (treat as "no")
- Ctrl+C during running task: Print "Cancelling..." immediately, abort via AbortSignal, show cancelled result block when cleanup finishes, return to REPL prompt
- Double Ctrl+C during task: Force-kill the Docker container immediately (skip 5s grace period), show "cancelled (forced)" result block, return to REPL prompt — does NOT exit the REPL
- Ctrl+D at idle prompt: Clean exit of REPL session
- Per-task AbortController: REPL creates a fresh AbortController for each task, signal handlers in the REPL adapter manage the lifecycle (not in the session core)

**History persistence**
- Location: `~/.config/background-agent/history` (alongside existing conf config.json)
- Max entries: 500
- readline's built-in history file support for read/write

**Startup checks**
- Docker check (assertDockerRunning + ensureNetworkExists + buildImageIfNeeded) runs once at REPL startup
- If Docker is not running: show error and exit immediately (no REPL entry)
- If image build needed: show spinner with "Building agent image..." status message
- Banner shows Docker ready status + registered project count after checks pass
- `runAgent()` API extended with `skipDockerChecks` option in AgentContext — REPL adapter sets true, one-shot path keeps default (false)

### Claude's Discretion
- Internal session core API shape (how input/result are passed)
- readline configuration details (completer, terminal options)
- Spinner implementation for Docker build (ora, nanospinner, or manual)
- Result block rendering implementation (box-drawing characters, colors)
- How to detect conf config dir path for history file colocation

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| CLI-02 | User can start interactive REPL session with `bg-agent` (no args) | readline persistent loop, signal handling, history persistence, startup checks |
</phase_requirements>

---

## Summary

Phase 16 builds an interactive REPL on top of the already-complete intent parser and one-shot flow from Phase 15. The core challenge is not parsing — that already works — it is making readline behave correctly across all signal states: idle prompt, confirm prompt, and running-task. The Node.js `readline/promises` module already in use has all the primitives needed (persistent `createInterface`, SIGINT event, AbortSignal on `question()`, history array + history event for persistence). No new major dependencies are required beyond a spinner library for the Docker build wait.

The channel-agnostic split (session core vs CLI adapter) is the architectural keystone: `src/repl/session.ts` takes a plain string input and returns a structured result without touching readline, while `src/cli/commands/repl.ts` owns everything process-bound. This makes the REPL logic testable in unit tests without mocking readline and positions Phase 17's session history feature cleanly.

The single most dangerous pitfall is readline's `question()` call swallowing SIGINT when it is mid-call. The pattern used in one-shot — creating a fresh readline, registering SIGINT on it, then closing it — cannot work in REPL mode because the readline must be long-lived. Signal routing must instead be handled by aborting the `question()` call via AbortController, not by closing the readline.

**Primary recommendation:** Use a single long-lived `readline/promises` `createInterface` with the `'line'` event + explicit `rl.question()` only for sub-prompts (confirm, clarification), and route all SIGINT through an AbortController per question/task.

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `node:readline/promises` | built-in | Long-lived REPL input loop, history management | Already used in one-shot; `history` array + `history` event = persistence without new deps |
| `picocolors` | `^1.1.1` | Prompt coloring, result block rendering | Already in project; zero-dep, fast |
| `nanospinner` | `^1.2.2` | Docker build spinner | Smallest (single dep: picocolors), pure ESM, TypeScript types included |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `node:os` | built-in | Resolve `~/.config` path | `os.homedir()` for history file path |
| `node:fs/promises` | built-in | Read history file at startup, write on exit | History persistence |
| `conf@^15` | already installed | Get existing config dir path for history file colocation | Read `store.path` to derive history file sibling |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| nanospinner | ora | ora is 15x larger (280 kB vs 20 kB); nanospinner has picocolors (already a dep) as its only dep |
| nanospinner | manual `process.stdout.write` | Manual works but requires animation loop boilerplate |
| readline `'history'` event | manual write on `rl.close()` | Event fires on every change; on-close only covers clean exit — process.exit bypasses it |

**Installation:**
```bash
npm install nanospinner
```

**Version verification (confirmed):**
```bash
npm view nanospinner version   # 1.2.2
npm view ora version           # 9.3.0 (not needed — nanospinner preferred)
```

---

## Architecture Patterns

### Recommended Project Structure
```
src/
├── repl/
│   ├── session.ts          # Channel-agnostic loop — parseIntent → confirmLoop → runAgent
│   ├── session.test.ts     # Unit tests — no readline mocking required
│   └── types.ts            # SessionInput, SessionResult, ReplState
├── cli/
│   └── commands/
│       ├── repl.ts         # CLI adapter — readline, prompt, colors, signal handling
│       └── repl.test.ts    # Unit tests — mock session core, mock readline
```

### Pattern 1: Long-lived readline with per-question AbortController

**What:** Create one `readline/promises` interface at REPL startup and keep it for the session lifetime. For each `rl.question()` call (confirm prompt, clarification), create a fresh `AbortController` and pass its signal. The SIGINT handler on the readline interface aborts the current question's controller, not the readline itself.

**When to use:** Any persistent prompt loop where Ctrl+C must cancel the current operation but not exit the shell.

**Example:**
```typescript
// Source: Node.js readline docs (https://nodejs.org/api/readline.html)
import { createInterface } from 'node:readline/promises';

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: 'bg> ',
  historySize: 500,
  history: loadHistoryFromFile(),  // string[] — restored at startup
  removeHistoryDuplicates: true,
  terminal: true,
});

// SIGINT on idle prompt: clear line, re-prompt (shell behavior)
// SIGINT during question: abort the active controller (handled per-question, see Pattern 2)
rl.on('SIGINT', () => {
  if (activeTaskController) {
    activeTaskController.abort();  // cancel running task
  } else if (activeQuestionController) {
    activeQuestionController.abort();  // cancel confirm/clarification prompt
  } else {
    process.stdout.write('\n');
    rl.prompt();  // idle — just re-show prompt
  }
});

// Ctrl+D (close event) = clean exit
rl.on('close', () => cleanExit());

// Persist history on each change (covers all exit paths including SIGKILL)
rl.on('history', (history: string[]) => {
  saveHistoryToFile(history);  // sync-safe: write-file-atomic is already a dep
});
```

### Pattern 2: Per-question AbortController for confirm/clarification

**What:** Each `rl.question()` call that can be cancelled by Ctrl+C gets its own `AbortController`. The REPL adapter tracks `activeQuestionController` and aborts it in the SIGINT handler. Aborted `question()` rejects with `AbortError` — catch it and return `null` to session core.

**Example:**
```typescript
// Source: Node.js readline docs — AbortSignal on question
async function promptConfirm(rl: Interface, question: string): Promise<string | null> {
  const ctrl = new AbortController();
  // expose to SIGINT handler
  activeQuestionController = ctrl;
  try {
    const answer = await rl.question(question, { signal: ctrl.signal });
    return answer;
  } catch (err) {
    if ((err as Error).name === 'AbortError') return null;  // Ctrl+C — treat as cancel
    throw err;
  } finally {
    activeQuestionController = null;
  }
}
```

### Pattern 3: Per-task AbortController for running agent

**What:** Each `runAgent()` call gets a fresh `AbortController`. The REPL adapter tracks `activeTaskController`. First Ctrl+C aborts the signal (graceful); second Ctrl+C within a short window force-kills (the Phase 14 double-signal pattern, applied per-task rather than process-wide).

**Example:**
```typescript
// Mirrors the Phase 14 pattern in src/cli/index.ts, scoped to per-task
async function runTask(intent: ResolvedIntent): Promise<RetryResult> {
  const ctrl = new AbortController();
  activeTaskController = ctrl;
  let firstSigint = false;

  const handleSigint = () => {
    if (firstSigint) {
      // Double Ctrl+C: force-kill (the sessionSettled flag in Phase 14 prevents double kill)
      ctrl.abort(new Error('force'));
    } else {
      firstSigint = true;
      process.stdout.write('\nCancelling...\n');
      ctrl.abort();
    }
  };
  // SIGINT handler in rl.on('SIGINT') calls handleSigint when activeTaskController is set

  try {
    return await runAgent(agentOptions, { signal: ctrl.signal, skipDockerChecks: true });
  } finally {
    activeTaskController = null;
  }
}
```

### Pattern 4: History file read/write

**What:** Load history from file into `createInterface({ history: [...] })` at startup. Persist on each change via the `'history'` event. File location derives from `conf`'s `projectName: 'background-agent'` convention.

**Example:**
```typescript
// Source: Node.js readline docs + conf docs
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

const HISTORY_FILE = join(homedir(), '.config', 'background-agent', 'history');
const MAX_HISTORY = 500;

function loadHistory(): string[] {
  try {
    return readFileSync(HISTORY_FILE, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .slice(0, MAX_HISTORY);
  } catch {
    return [];  // first run — file doesn't exist yet
  }
}

function saveHistory(history: string[]): void {
  try {
    writeFileSync(HISTORY_FILE, history.join('\n'));
  } catch {
    // non-fatal — history just doesn't persist this session
  }
}
```

**Note:** The history file directory (`~/.config/background-agent/`) is created by `conf` on first use. On first REPL run before `conf` has written anything, the directory may not exist yet. Create it with `fs.mkdirSync(dir, { recursive: true })` before writing.

### Pattern 5: AgentContext.skipDockerChecks extension

**What:** Add an optional flag to `AgentContext` that causes `runAgent()` to skip the three Docker lifecycle calls. REPL adapter passes `skipDockerChecks: true`; one-shot path passes nothing (defaults to false).

**Example:**
```typescript
// src/agent/index.ts — minimal change
export interface AgentContext {
  logger?: pino.Logger;
  signal?: AbortSignal;
  skipDockerChecks?: boolean;   // ADD: REPL sets true after startup check
}

// Inside runAgent():
if (!context.skipDockerChecks) {
  await assertDockerRunning();
  await ensureNetworkExists();
  await buildImageIfNeeded();
}
```

### Pattern 6: CLI entry-point routing

**What:** `src/cli/index.ts` already has the condition: if `input` arg is present → one-shot; if `--task-type` and `--repo` present → legacy. The REPL path is the remaining case (no input, no required flags). The SIGINT/SIGTERM process handlers at the top of `index.ts` must be removed or made no-ops before launching the REPL — the REPL manages signals internally.

**Example:**
```typescript
// src/cli/index.ts: add third branch before the legacy flag check
if (!input && !options.taskType) {
  const { replCommand } = await import('./commands/repl.js');
  // Do NOT set up process SIGINT handlers here — repl.ts owns them
  await replCommand();
  process.exit(0);
  return;
}
```

### Anti-Patterns to Avoid

- **Creating a new readline per `question()` call in REPL mode:** The one-shot code pattern (`createInterface` → `question` → `close`) cannot be reused inside the REPL. Creating a new interface while a long-lived one exists causes input contention and missed lines.
- **Putting SIGINT handlers in session.ts (session core):** Signal handling belongs in the CLI adapter only. Session core must remain process-signal-free (established Phase 14 pattern).
- **Using `for await...of rl` loop:** Known Node.js issue — awaiting between interface creation and iteration causes missed lines. Use `rl.question()` in a `while(true)` loop instead.
- **Writing history synchronously on every change with `fs.writeFileSync`:** For 500 entries this is fast, but consider using `write-file-atomic` (already a project dep) to prevent corruption if the process is killed mid-write.
- **Double-registering process signal handlers when launching REPL:** The `process.on('SIGINT', handleSignal)` in `src/cli/index.ts` that exits the process on first Ctrl+C must not fire in REPL mode. Route all SIGINT through readline's `rl.on('SIGINT')` event instead.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Terminal spinner | Custom animation loop | `nanospinner` | Frame timing, stream detection (CI no-TTY), cleanup on signal |
| Atomic file write for history | Custom temp-file + rename | `write-file-atomic` (already dep) | Already installed, handles SIGKILL partial writes |
| Config directory location | Parse `conf` internals | `os.homedir() + '/.config/background-agent/'` | conf@15 uses XDG base dir convention on Linux/macOS — `~/.config/{projectName}/` |
| Readline question cancellation | Custom event queue | `AbortController` + `signal` option on `rl.question()` | Native since Node 15; already used in project for task cancellation |

**Key insight:** The existing codebase already has every required building block. The REPL is primarily integration work, not new library work.

---

## Common Pitfalls

### Pitfall 1: confirm-loop creates its own readline

**What goes wrong:** `confirmLoop()` in `src/intent/confirm-loop.ts` calls `createInterface()` internally, creates its own readline, and closes it. In REPL mode the long-lived readline is already open. Two readline instances fighting over `process.stdin` causes buffering issues and missed input.

**Why it happens:** `confirmLoop` was designed for the one-shot path where readline is ephemeral.

**How to avoid:** Do not call `confirmLoop()` directly from the REPL adapter. Either: (a) extract the prompt logic into the session core using the REPL's readline instance, or (b) refactor `confirmLoop` to accept an optional external readline. The CONTEXT.md decision is to keep `confirmLoop` reusable in the one-shot path — option (a) (duplicate the confirm logic inline in session.ts using the shared readline) is the safer path for Phase 16 without breaking Phase 15.

**Warning signs:** Confirm prompt appears but user input is silently consumed without displaying.

### Pitfall 2: process.on('SIGINT') in index.ts fires during REPL

**What goes wrong:** `src/cli/index.ts` installs `process.on('SIGINT', () => handleSignal(130))` which calls `process.exit(130)` on first Ctrl+C. This fires before the readline SIGINT event when the REPL is running, immediately killing the process instead of cancelling the task.

**Why it happens:** The handler was designed for the one-shot path. It is installed before the mode-check.

**How to avoid:** In the REPL branch of `index.ts`, do NOT install the process SIGINT handler. The `rl.on('SIGINT')` event in the readline adapter handles all Ctrl+C signals when a readline interface with `terminal: true` is active. Readline's native SIGINT interception prevents the event from reaching `process.on('SIGINT')` handlers while a question is active.

**Warning signs:** First Ctrl+C during a task exits the entire process with code 130 instead of cancelling the task.

### Pitfall 3: readline history event fires before config directory exists

**What goes wrong:** On first run, `~/.config/background-agent/` may not exist yet (conf creates it lazily on first write). The `history` event handler calls `writeFileSync` on a path in a non-existent directory, throwing `ENOENT`.

**Why it happens:** conf only creates its directory when it first writes config.json. If user runs REPL before any project registry operation, directory is missing.

**How to avoid:** Call `fs.mkdirSync(historyDir, { recursive: true })` before the first history write, or in the REPL startup before creating the readline interface.

**Warning signs:** Unhandled `ENOENT` error on first REPL run after a fresh install.

### Pitfall 4: Double Ctrl+C exits REPL instead of force-killing

**What goes wrong:** Phase 14's double-signal pattern (in `src/cli/index.ts`) calls `process.exit()` on the second signal. In REPL mode, double Ctrl+C should force-kill the Docker container and stay in the REPL.

**Why it happens:** The pattern was designed for process-exit semantics, not per-task semantics.

**How to avoid:** In the REPL adapter's SIGINT handler, track `firstSigint` per-task (reset to false when the task ends). Second Ctrl+C within the same task calls `ctrl.abort(new Error('force'))`, which `runAgent()` treats as a force signal. The REPL continues after cleanup.

**Warning signs:** Two rapid Ctrl+C presses during a task exit the shell entirely.

### Pitfall 5: readline question() consuming buffered input

**What goes wrong:** If user types input while the agent is running, readline buffers it. When `rl.question()` is called next (for the confirm prompt of the next task), the buffered input is immediately consumed as the answer, skipping the prompt display.

**Why it happens:** readline buffers keystrokes in terminal mode even when no `question()` is active.

**How to avoid:** After a task completes and before calling `rl.question()` for the next task, drain the readline buffer by calling `rl.pause(); rl.resume()` (pause flushes the pending buffer in some Node versions) or, more reliably, `process.stdin.read()` to consume any pending data before re-prompting.

**Warning signs:** Confirm prompt appears to auto-accept without user interaction.

---

## Code Examples

Verified patterns from official sources:

### History persistence (read/write)
```typescript
// Source: https://nodejs.org/api/readline.html — 'history' event + createInterface history option
import { createInterface } from 'node:readline/promises';
import { readFileSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const HISTORY_FILE = join(homedir(), '.config', 'background-agent', 'history');
const MAX_HISTORY = 500;

function loadHistory(): string[] {
  try {
    return readFileSync(HISTORY_FILE, 'utf-8').split('\n').filter(Boolean);
  } catch { return []; }
}

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  historySize: MAX_HISTORY,
  history: loadHistory(),
  removeHistoryDuplicates: true,
  terminal: true,
});

rl.on('history', (history: string[]) => {
  mkdirSync(dirname(HISTORY_FILE), { recursive: true });
  writeFile(HISTORY_FILE, history.join('\n')).catch(() => {});
});
```

### AbortSignal on readline question
```typescript
// Source: https://nodejs.org/api/readline.html — question() with signal option
let activeController: AbortController | null = null;

rl.on('SIGINT', () => {
  if (activeController) {
    activeController.abort();
  } else {
    process.stdout.write('\n');
    rl.prompt();
  }
});

async function askQuestion(prompt: string): Promise<string | null> {
  const ctrl = new AbortController();
  activeController = ctrl;
  try {
    return await rl.question(prompt, { signal: ctrl.signal });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).name === 'AbortError') return null;
    throw err;
  } finally {
    activeController = null;
  }
}
```

### nanospinner usage
```typescript
// Source: https://github.com/usmanyunusov/nanospinner
import { createSpinner } from 'nanospinner';

const spinner = createSpinner('Building agent image...').start();
try {
  await buildImageIfNeeded();
  spinner.success({ text: 'Agent image ready' });
} catch (err) {
  spinner.error({ text: 'Image build failed' });
  throw err;
}
```

### Result block rendering with box-drawing characters
```typescript
// Source: project pattern (picocolors already used for intent display)
import pc from 'picocolors';

function renderResultBlock(result: RetryResult, prUrl?: string): void {
  const statusColor = result.finalStatus === 'success' ? pc.green : pc.red;
  console.log('');
  console.log(pc.dim('  ┌─────────────────────────────────────┐'));
  console.log(`  │  Status:   ${statusColor(result.finalStatus.padEnd(24))}  │`);
  console.log(`  │  Attempts: ${String(result.attempts).padEnd(24)}   │`);
  if (prUrl) {
    console.log(`  │  PR:       ${pc.cyan(prUrl.slice(0, 24))}  │`);
  }
  console.log(pc.dim('  └─────────────────────────────────────┘'));
  console.log('');
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Separate readline per question | Single long-lived readline with history | — | History works; no input contention |
| `for await (const line of rl)` | `while(true) { await rl.question() }` | Node.js bug known | Avoids missed-line bug with async iterator |
| Process SIGINT → exit | Per-task AbortController, readline SIGINT event | Phase 14 | Tasks cancel without killing REPL |

**Deprecated/outdated:**
- `readline.createInterface` (callback-based `question(cb)` style): Works but use `readline/promises` for async/await — already in use in this project.

---

## Open Questions

1. **confirm-loop readline contention**
   - What we know: `confirmLoop()` creates its own readline. Two readlines on stdin conflict.
   - What's unclear: Whether refactoring confirmLoop to accept an external readline is worth it vs duplicating the confirm logic in the REPL session core.
   - Recommendation: Inline a simplified confirm loop in `session.ts` that uses the REPL's readline instance passed as a parameter. Keep the existing `confirmLoop` for one-shot. Document this as a Phase 17 refactor opportunity if the session grows more complex.

2. **History file directory creation race**
   - What we know: conf creates `~/.config/background-agent/` lazily. History write will fail if conf hasn't run yet.
   - What's unclear: Whether calling `registry.list()` (which reads conf) at REPL startup is sufficient to trigger directory creation.
   - Recommendation: Explicitly `mkdirSync(historyDir, { recursive: true })` in the history write handler. Low cost, eliminates the race entirely.

3. **Stdin terminal detection for spinner**
   - What we know: nanospinner auto-detects TTY and suppresses animation in non-TTY (CI) environments.
   - What's unclear: Whether Docker build during REPL startup in a non-TTY (piped) session should fail silently or abort.
   - Recommendation: Non-TTY REPL is an unusual use case; treat the REPL as requiring a TTY and check `process.stdout.isTTY` at startup — show a warning if false and proceed without the spinner.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest ^4.0.18 |
| Config file | `vitest.config.ts` (excludes dist/, node_modules/) |
| Quick run command | `npx vitest run src/repl/ src/cli/commands/repl.test.ts` |
| Full suite command | `npm test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CLI-02 | REPL starts when no args given — index.ts routes to replCommand | unit | `npx vitest run src/cli/commands/repl.test.ts` | Wave 0 |
| CLI-02 | Session core processes input string, calls parseIntent + confirmLoop + runAgent | unit | `npx vitest run src/repl/session.test.ts` | Wave 0 |
| CLI-02 | Ctrl+C during idle prompt re-shows prompt (no exit) | unit (mock rl SIGINT) | `npx vitest run src/cli/commands/repl.test.ts` | Wave 0 |
| CLI-02 | Ctrl+C during task aborts AbortController, stays in REPL | unit (mock runAgent) | `npx vitest run src/cli/commands/repl.test.ts` | Wave 0 |
| CLI-02 | `exit` input triggers clean shutdown | unit | `npx vitest run src/repl/session.test.ts` | Wave 0 |
| CLI-02 | Docker checks run once at startup, skipDockerChecks=true for tasks | unit (mock runAgent + docker) | `npx vitest run src/repl/session.test.ts` | Wave 0 |
| CLI-02 | History loaded from file at startup, saved on change | unit (mock fs) | `npx vitest run src/cli/commands/repl.test.ts` | Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run src/repl/ src/cli/commands/repl.test.ts`
- **Per wave merge:** `npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/repl/session.ts` — session core module (new file)
- [ ] `src/repl/session.test.ts` — unit tests for session core
- [ ] `src/repl/types.ts` — SessionInput, SessionResult types
- [ ] `src/cli/commands/repl.ts` — CLI adapter (new file)
- [ ] `src/cli/commands/repl.test.ts` — unit tests for CLI adapter

*(Existing infrastructure: vitest.config.ts, vi.mock patterns for readline and runAgent — all established)*

---

## Sources

### Primary (HIGH confidence)
- Node.js readline docs (https://nodejs.org/api/readline.html) — history event, historySize, history array option, SIGINT event, question() AbortSignal
- Project source code: `src/cli/index.ts`, `src/cli/commands/one-shot.ts`, `src/agent/index.ts`, `src/intent/confirm-loop.ts`, `src/agent/registry.ts`

### Secondary (MEDIUM confidence)
- nanospinner README (https://github.com/usmanyunusov/nanospinner) — size comparison vs ora, ESM support, TypeScript types
- npm registry: `npm view nanospinner version` (1.2.2), `npm view conf version` (15.1.0)

### Tertiary (LOW confidence)
- Node.js GitHub issues #42454, #33463 — for-await-of missed lines pitfall (known, documented behavior)

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — verified against existing package.json; nanospinner version confirmed with npm view
- Architecture: HIGH — based on existing codebase patterns, Node.js official docs
- Signal handling pitfalls: HIGH — based on Phase 14 established decisions + Node.js readline docs
- readline confirm-loop contention: MEDIUM — identified from code inspection, specific interaction not directly documented

**Research date:** 2026-03-20
**Valid until:** 2026-04-20 (readline API stable; Node.js built-in)
