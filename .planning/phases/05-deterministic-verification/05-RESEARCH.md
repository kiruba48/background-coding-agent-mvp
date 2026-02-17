# Phase 5: Deterministic Verification - Research

**Researched:** 2026-02-17
**Domain:** Build/Test/Lint Verification, Subprocess Orchestration, TypeScript Toolchain
**Confidence:** HIGH

## Summary

Phase 5 implements the three deterministic verifiers (build, test, lint) that plug into the `RetryOrchestrator.retryConfig.verifier` callback defined in Phase 4. The interface contract is already locked by `types.ts`: `(workspaceDir: string) => Promise<VerificationResult>`. The central architectural question for this phase is HOW to run `tsc`, `vitest`, and `eslint` against the target workspace — and the answer is **host-side subprocess execution via `execFileAsync`**, not in-process programmatic APIs.

The established pattern from production coding agent systems (Spotify, Anthropic) is that verifiers invoke the workspace's own build system commands — they do not embed a TypeScript compiler or test runner inside the orchestrator process. This is the correct approach for three reasons: (1) the target workspace is a different project with its own `tsconfig.json`, `package.json`, and `eslint.config.mjs`; running tools in-process against a different project's config is fragile and complex, (2) subprocess isolation prevents verifier state from leaking into the orchestrator process, and (3) the workspace may use different tool versions than the orchestrator. The existing `execFileAsync` pattern from `session.ts` (used for git operations) is the correct template to follow.

A critical discovery: **ESLint is not yet installed in this project** (the lint script in `package.json` is `echo "Error: no lint specified" && exit 1`). Phase 5 must install ESLint v10 with typescript-eslint and create an `eslint.config.mjs` before the lint verifier can be implemented. ESLint v10.0.0 (released February 6, 2026) removes the eslintrc system entirely — flat config (`eslint.config.*`) is now the only supported format. The new SOTA minimal TypeScript setup uses `typescript-eslint` with the `recommended` config.

**Primary recommendation:** Implement three verifier functions (`buildVerifier`, `testVerifier`, `lintVerifier`) each wrapping `execFileAsync` with a timeout and piping `stdout+stderr` to `ErrorSummarizer`. Wire them into a `compositeVerifier` that runs all three sequentially and aggregates results into a single `VerificationResult`. All three verifiers run on the HOST (not in Docker). Install ESLint v10 + typescript-eslint as devDependencies and create `eslint.config.mjs`.

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| VERIFY-01 | Build verification confirms code compiles after changes | `execFileAsync('npx', ['tsc', '--noEmit'], { cwd: workspaceDir, timeout: 60000 })` — exit code 0 = pass, non-zero = fail; extract TypeScript error lines via `ErrorSummarizer.summarizeBuildErrors()` |
| VERIFY-02 | Test verification confirms existing tests pass | `execFileAsync('npx', ['vitest', 'run'], { cwd: workspaceDir, timeout: 120000 })` — exit code 0 = pass; extract test failures via `ErrorSummarizer.summarizeTestFailures()` |
| VERIFY-03 | Lint verification confirms no style issues introduced | `execFileAsync('npx', ['eslint', '.'], { cwd: workspaceDir, timeout: 60000 })` — exit code 0 = pass; requires installing ESLint v10 + typescript-eslint and creating `eslint.config.mjs` first |
| VERIFY-05 | Failed verification triggers retry with summarized error context | Already implemented in `RetryOrchestrator`: verifier callback returns `VerificationResult`; if `passed === false`, error digest goes to next session's initial message |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| (none new for build/test) | - | tsc and vitest already in project | `tsc` via `typescript@^5.7.2` (already installed); `vitest@^4.0.18` (already installed) |
| eslint | ^10.0.0 | Lint verification | ESLint v10 released Feb 6, 2026; removes eslintrc entirely; flat config is now the only format |
| @eslint/js | ^9.x | Base ESLint rules for flat config | Required peer dependency for flat config setup |
| typescript-eslint | ^8.x | TypeScript ESLint integration | Single package replaces `@typescript-eslint/parser` + `@typescript-eslint/eslint-plugin` in v8+ |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| node:child_process | built-in | Subprocess execution | `execFile` (promisified) for running tsc, vitest, eslint |
| node:util | built-in | Promisify | `promisify(execFile)` — already used in `session.ts` |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `execFileAsync` subprocess | ESLint programmatic API (`new ESLint().lintFiles()`) | Programmatic API works for linting the ORCHESTRATOR's own files; running it against a different project's `eslint.config.mjs` requires setting `cwd` and `overrideConfigFile` — more complex, ESLint v10 changed config lookup behavior |
| `execFileAsync` subprocess | Vitest programmatic API (`startVitest()` from `vitest/node`) | Designed for library authors; requires Vite server; the target workspace has its own Vitest config; subprocess is simpler and matches real CI behavior |
| `execFileAsync` subprocess | TypeScript Compiler API (`ts.createProgram()`) | TypeScript Compiler API is complex (200+ lines for basic diagnostic extraction); cross-project config requires manual `tsconfig.json` resolution; `tsc --noEmit` as subprocess is idiomatic and used universally |
| `npm run build` / `npm test` / `npm run lint` | Direct `tsc`, `vitest`, `eslint` invocation via `npx` | `npm run` honors the project's exact package scripts; however `npx tsc`/`npx vitest run`/`npx eslint` is more predictable when the workspace may not have scripts defined correctly |

**Installation:**
```bash
npm install --save-dev eslint @eslint/js typescript-eslint
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── orchestrator/
│   ├── verifier.ts          # NEW: buildVerifier, testVerifier, lintVerifier, compositeVerifier
│   ├── verifier.test.ts     # NEW: unit tests for verifier functions
│   ├── retry.ts             # EXISTING: RetryOrchestrator (Phase 4)
│   ├── summarizer.ts        # EXISTING: ErrorSummarizer (Phase 4)
│   ├── session.ts           # EXISTING: AgentSession
│   ├── container.ts         # EXISTING: ContainerManager
│   └── index.ts             # UPDATE: export verifiers
├── cli/
│   └── commands/
│       └── run.ts           # UPDATE: wire compositeVerifier into RetryOrchestrator
└── types.ts                 # EXISTING: VerificationResult, VerificationError (no changes needed)
eslint.config.mjs            # NEW: flat config for ESLint
```

### Pattern 1: Subprocess Verifier Function
**What:** Each verifier runs a tool subprocess in the workspace directory and maps exit code + output to `VerificationResult`.
**When to use:** Always — this is the standard approach for all three verifiers.
**Example:**
```typescript
// Source: Node.js child_process docs + established pattern from session.ts
// src/orchestrator/verifier.ts

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { VerificationResult, VerificationError } from '../types.js';
import { ErrorSummarizer } from './summarizer.js';

const execFileAsync = promisify(execFile);

// Timeouts: build=60s, test=120s, lint=60s
// maxBuffer: 10MB — test output can be large; default 1MB is too small
const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB

export async function buildVerifier(workspaceDir: string): Promise<VerificationResult> {
  const start = Date.now();
  try {
    await execFileAsync('npx', ['tsc', '--noEmit'], {
      cwd: workspaceDir,
      timeout: 60_000,
      maxBuffer: MAX_BUFFER,
    });
    return { passed: true, errors: [], durationMs: Date.now() - start };
  } catch (err: unknown) {
    const rawOutput = getExecOutput(err);
    const summary = ErrorSummarizer.summarizeBuildErrors(rawOutput);
    const error: VerificationError = {
      type: 'build',
      summary,
      rawOutput,
    };
    return { passed: false, errors: [error], durationMs: Date.now() - start };
  }
}

export async function testVerifier(workspaceDir: string): Promise<VerificationResult> {
  const start = Date.now();
  try {
    await execFileAsync('npx', ['vitest', 'run'], {
      cwd: workspaceDir,
      timeout: 120_000,
      maxBuffer: MAX_BUFFER,
    });
    return { passed: true, errors: [], durationMs: Date.now() - start };
  } catch (err: unknown) {
    const rawOutput = getExecOutput(err);
    const summary = ErrorSummarizer.summarizeTestFailures(rawOutput);
    const error: VerificationError = {
      type: 'test',
      summary,
      rawOutput,
    };
    return { passed: false, errors: [error], durationMs: Date.now() - start };
  }
}

export async function lintVerifier(workspaceDir: string): Promise<VerificationResult> {
  const start = Date.now();
  try {
    await execFileAsync('npx', ['eslint', '.', '--max-warnings', '0'], {
      cwd: workspaceDir,
      timeout: 60_000,
      maxBuffer: MAX_BUFFER,
    });
    return { passed: true, errors: [], durationMs: Date.now() - start };
  } catch (err: unknown) {
    const rawOutput = getExecOutput(err);
    const summary = ErrorSummarizer.summarizeLintErrors(rawOutput);
    const error: VerificationError = {
      type: 'lint',
      summary,
      rawOutput,
    };
    return { passed: false, errors: [error], durationMs: Date.now() - start };
  }
}

/**
 * Extract combined stdout+stderr from execFile error or timeout.
 * execFileAsync throws with { stdout, stderr } on non-zero exit.
 * execFileAsync throws with { killed: true } on timeout.
 */
function getExecOutput(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    if (e['killed'] === true || e['signal'] === 'SIGTERM') {
      return `Process timed out and was killed`;
    }
    const stdout = typeof e['stdout'] === 'string' ? e['stdout'] : '';
    const stderr = typeof e['stderr'] === 'string' ? e['stderr'] : '';
    return (stdout + '\n' + stderr).trim();
  }
  return err instanceof Error ? err.message : String(err);
}
```

### Pattern 2: Composite Verifier (Run All Three)
**What:** A single function that runs build, test, and lint in sequence and aggregates all results. Stops collecting errors when maxBuffer or context limits would be exceeded but still runs all verifiers (fail-fast is NOT appropriate — we want all errors reported so agent can fix everything in one retry).
**When to use:** This is the function passed to `RetryOrchestrator.retryConfig.verifier`.
**Example:**
```typescript
// Source: Architecture derived from VerificationResult interface in types.ts
// All-three-run pattern (not fail-fast) so agent gets full picture of failures

export async function compositeVerifier(workspaceDir: string): Promise<VerificationResult> {
  const start = Date.now();
  const results = await Promise.allSettled([
    buildVerifier(workspaceDir),
    testVerifier(workspaceDir),
    lintVerifier(workspaceDir),
  ]);

  const allErrors: VerificationError[] = [];
  let allPassed = true;

  for (const result of results) {
    if (result.status === 'rejected') {
      // Verifier itself crashed (not a test failure — an orchestration error)
      allErrors.push({
        type: 'custom',
        summary: `Verifier crashed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
      });
      allPassed = false;
    } else if (!result.value.passed) {
      allErrors.push(...result.value.errors);
      allPassed = false;
    }
  }

  return { passed: allPassed, errors: allErrors, durationMs: Date.now() - start };
}
```

**Note:** Running all three in parallel (`Promise.allSettled`) is correct — each verifier is independent. If build fails, test output is still useful to the agent. The `RetryOrchestrator` already handles the `durationMs` tracking in `VerificationResult`.

**Alternative — Sequential execution:** If build fails so catastrophically that test output is meaningless noise, sequential + fail-fast is appropriate. However, the existing `ErrorSummarizer` already caps output at 2000 chars, so parallel run + full reporting is preferred.

### Pattern 3: Wiring into CLI (run.ts)
**What:** Pass `compositeVerifier` to `RetryOrchestrator` in `run.ts` where the comment says "Phase 5 verifiers plug in here".
**When to use:** Phase 5 replaces the empty verifier slot in `run.ts`.
**Example:**
```typescript
// Source: Existing run.ts pattern (Phase 4)
// Replace the existing "No verifier in Phase 4" comment with:
import { compositeVerifier } from '../../orchestrator/verifier.js';

const orchestrator = new RetryOrchestrator(
  { workspaceDir: options.repo, turnLimit: options.turnLimit, timeoutMs: options.timeout * 1000, logger: childLogger },
  {
    maxRetries: options.maxRetries,
    verifier: compositeVerifier,   // <-- Phase 5 plugs in here
  }
);
```

### Pattern 4: ESLint Flat Config (New File)
**What:** Create `eslint.config.mjs` at the project root. ESLint v10 requires flat config — `.eslintrc.*` is completely removed.
**When to use:** Required for the lint verifier to work. Must be created as part of Phase 5.
**Example:**
```javascript
// Source: typescript-eslint.io/getting-started + ESLint v10 flat config docs
// eslint.config.mjs

// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
);
```

**Note:** `tseslint.config()` (not `defineConfig()`) is the typescript-eslint helper function — it wraps ESLint's flat config and provides type safety. The `recommended` config covers: `no-unused-vars`, `no-explicit-any`, TypeScript-specific rules.

### Pattern 5: execFileAsync Error Shape (Critical)
**What:** `util.promisify(execFile)` rejects with an error object on non-zero exit. The error object has `stdout`, `stderr`, `code`, `killed`, `signal` properties.
**When to use:** In the `catch` block of every verifier — do NOT just use `error.message`.
**Example:**
```typescript
// Source: Node.js child_process official docs (v25.6.1)
// On non-zero exit:
// err.stdout: string (captured stdout before failure)
// err.stderr: string (captured stderr)
// err.code: number (exit code)
// err.killed: boolean (true if killed by timeout)
// err.signal: string | null ('SIGTERM' if timeout kill)

// On timeout (timeout option exceeded):
// err.killed = true, err.signal = 'SIGTERM'

// On maxBuffer exceeded:
// err is thrown with truncated output in err.stdout / err.stderr
```

### Anti-Patterns to Avoid
- **Anti-pattern: Running verifiers inside the Docker container.** Verifiers MUST run on the host. The Docker container has `NetworkMode: none` and a read-only rootfs — it cannot `npm install` or access `node_modules` of the workspace. The existing pattern from Phase 4 is clear: git runs on host, read-only tools run in container. Verification runs on host.
- **Anti-pattern: Using default `maxBuffer` (1MB).** Test output from `vitest run` on a project with 30+ tests can easily exceed 1MB. Set `maxBuffer: 10 * 1024 * 1024` (10MB) for all verifiers.
- **Anti-pattern: `npm run build` instead of `npx tsc --noEmit`.** `npm run build` emits compiled output to `dist/` — this modifies the workspace. Use `npx tsc --noEmit` which type-checks without emitting files.
- **Anti-pattern: Fail-fast composite verifier.** If build fails, still run test and lint. The agent needs the full picture of what's broken to fix everything in one session. The ErrorSummarizer caps output regardless.
- **Anti-pattern: Passing `--fix` to ESLint.** Auto-fixing changes files without the agent knowing. Agent should fix manually based on error context. Run ESLint without `--fix`.
- **Anti-pattern: Running `eslint .` without `--max-warnings 0`.** By default ESLint exits 0 if only warnings exist. Treat warnings as errors for verification purposes.
- **Anti-pattern: Throwing errors from verifiers.** The `RetryOrchestrator` already has a `try/catch` around the verifier call (see `retry.ts` lines 115-127) that handles verifier crashes and returns `finalStatus: 'failed'`. However, the `compositeVerifier` should still catch internal errors and convert them to `VerificationError` entries rather than letting them bubble.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| TypeScript type checking | Custom `ts.createProgram()` wrapper | `npx tsc --noEmit` subprocess | TypeScript Compiler API requires 150+ lines for proper diagnostic extraction, tsconfig discovery, and incremental mode; `tsc --noEmit` is 3 lines and handles all edge cases |
| Test result parsing | Custom test result parser | Existing `ErrorSummarizer.summarizeTestFailures()` | Already implemented in Phase 4 with Vitest-compatible regex patterns |
| Build error parsing | Custom compiler output parser | Existing `ErrorSummarizer.summarizeBuildErrors()` | Already implemented in Phase 4 with TypeScript error format regex |
| Lint error parsing | Custom ESLint output parser | Existing `ErrorSummarizer.summarizeLintErrors()` | Already implemented in Phase 4 with ESLint format regex |
| ESLint flat config | Custom lint rules from scratch | `typescript-eslint.configs.recommended` | Covers all standard TypeScript checks; no custom rules needed for this project |
| Subprocess timeout + kill | Custom AbortController + SIGKILL fallback | `timeout` option in `execFile` | Node.js `execFile` `timeout` option sends `killSignal` (default SIGTERM) automatically; if process ignores SIGTERM, use `killSignal: 'SIGKILL'` |
| Parallel verifier orchestration | Custom Promise chain | `Promise.allSettled()` | allSettled runs all three and never throws even if one rejects — exactly what we need for composite verification |
| Output truncation | Custom string truncation | `ErrorSummarizer.buildDigest()` caps at 2000 chars | Already implemented and capped |

**Key insight:** The ErrorSummarizer (Phase 4) already handles all three output formats. Phase 5's only new work is the subprocess execution layer and ESLint setup — NOT error parsing.

## Common Pitfalls

### Pitfall 1: maxBuffer Too Small for Test Output
**What goes wrong:** `vitest run` produces a lot of output for a project with many tests. When `maxBuffer` is exceeded, Node.js kills the subprocess and throws with truncated output. The error from `execFileAsync` then has partial output in `stdout`/`stderr`.
**Why it happens:** Default `maxBuffer` in `execFile` is 1MB. Test output for 50+ tests with verbose output can be 5-20MB.
**How to avoid:** Always set `maxBuffer: 10 * 1024 * 1024` (10MB). The raw output is captured in `VerificationError.rawOutput` (never sent to LLM), so size doesn't matter for context window. The summarizer caps what reaches the agent.
**Warning signs:** Error message contains "stdout maxBuffer exceeded" or "stderr maxBuffer exceeded".

### Pitfall 2: npx Resolution in Different Node Environments
**What goes wrong:** `npx tsc` resolves `tsc` from the host's global npm or the current working directory's node_modules. When `cwd` is set to `workspaceDir`, npx looks for tsc in `workspaceDir/node_modules/.bin/tsc`. If the workspace doesn't have TypeScript installed, this fails with ENOENT.
**Why it happens:** `npx` resolves bins from `cwd`'s node_modules, not the orchestrator's node_modules. The workspace is a different project.
**How to avoid:** The workspace (`options.repo`) is the background-coding-agent project itself in Phase 5. TypeScript IS installed there. Document that the `workspaceDir` must have the relevant tools installed (TypeScript for build, Vitest for test, ESLint for lint). For Phase 5, the workspace IS this project, so all tools will be present after this phase installs ESLint.
**Warning signs:** `ENOENT` error when spawning `npx tsc` — means tsc is not found in workspace's node_modules.

### Pitfall 3: tsc --noEmit vs tsc (Build Mode)
**What goes wrong:** Using `npx tsc` (without `--noEmit`) emits JavaScript files to `dist/`. This (a) modifies the workspace without the agent's intent, (b) can create confusing diffs, (c) may mask type errors if output is cached.
**Why it happens:** `tsc` default behavior is to emit output.
**How to avoid:** Always use `npx tsc --noEmit` for the build verifier. This performs full type checking without emitting any files.
**Warning signs:** `dist/` directory contents change after running the build verifier.

### Pitfall 4: ESLint v10 Breaking Changes
**What goes wrong:** Code written against ESLint v8/v9's `.eslintrc.*` configuration is incompatible with ESLint v10. The `.eslintrc.*` file is silently ignored in v9 and rejected in v10.
**Why it happens:** ESLint v10 removed the entire eslintrc config system (released Feb 6, 2026).
**How to avoid:** Use ONLY flat config (`eslint.config.mjs`) for this project. The minimal config with `typescript-eslint` recommended rules is sufficient.
**Warning signs:** ESLint reports "No eslint.config file found" or similar. Old `.eslintrc.*` files being created by the agent must be flagged.

### Pitfall 5: ESLint Exit Code Semantics
**What goes wrong:** ESLint exits with code 1 for lint errors (expected) but also exits with code 2 for fatal errors (unexpected — e.g., config not found, file not found). Code that treats any non-zero exit as "lint errors" will misclassify config errors.
**Why it happens:** ESLint distinguishes between lint failures (exit 1) and tool failures (exit 2).
**How to avoid:** Check `err.code` in the catch block: code 1 = lint errors (parse and report), code 2 = fatal ESLint failure (should surface as orchestration error, not lint error). For simplicity, treat both as verification failures but capture the exit code in the error message.
**Warning signs:** Error summary shows unusual messages like "Parsing error" or "Cannot find config file" instead of actual lint violations.

### Pitfall 6: Vitest Run vs Watch Mode
**What goes wrong:** `npx vitest` (without `run`) starts in watch mode and never exits. The subprocess hangs until the `timeout` fires and kills it. The test results are the timeout error, not actual test results.
**Why it happens:** `vitest` in interactive terminals defaults to watch mode.
**How to avoid:** Always use `npx vitest run` (not `npx vitest`). The `run` subcommand runs tests once and exits.
**Warning signs:** Test verifier always times out with no useful output.

### Pitfall 7: Timeout Semantics on SIGTERM
**What goes wrong:** `execFile`'s `timeout` option sends `SIGTERM` when the limit is exceeded. Some Node.js processes (like `vitest`) may handle `SIGTERM` gracefully and delay exit, meaning the process doesn't die immediately. If the child process ignores SIGTERM, `execFileAsync` may appear to hang.
**Why it happens:** SIGTERM is catchable; SIGKILL is not.
**How to avoid:** Set `killSignal: 'SIGKILL'` in the execFileAsync options, OR use a wrapper that escalates from SIGTERM to SIGKILL after a grace period. For simplicity, use `killSignal: 'SIGKILL'` directly.
**Warning signs:** Subprocess appears to exceed the configured timeout significantly.

## Code Examples

Verified patterns from official sources and codebase analysis:

### Complete Verifier Module
```typescript
// Source: Node.js child_process docs + Phase 4 ErrorSummarizer interface
// src/orchestrator/verifier.ts

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { VerificationResult, VerificationError } from '../types.js';
import { ErrorSummarizer } from './summarizer.js';

const execFileAsync = promisify(execFile);

// 10MB - test runners can produce verbose output
const MAX_BUFFER = 10 * 1024 * 1024;

function getExecOutput(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    if (e['killed'] === true) {
      return `Process killed (timeout exceeded)`;
    }
    const stdout = typeof e['stdout'] === 'string' ? e['stdout'] : '';
    const stderr = typeof e['stderr'] === 'string' ? e['stderr'] : '';
    return (stdout + '\n' + stderr).trim();
  }
  return err instanceof Error ? err.message : String(err);
}

export async function buildVerifier(workspaceDir: string): Promise<VerificationResult> {
  const start = Date.now();
  try {
    await execFileAsync('npx', ['tsc', '--noEmit'], {
      cwd: workspaceDir,
      timeout: 60_000,
      killSignal: 'SIGKILL',
      maxBuffer: MAX_BUFFER,
    });
    return { passed: true, errors: [], durationMs: Date.now() - start };
  } catch (err) {
    const rawOutput = getExecOutput(err);
    return {
      passed: false,
      errors: [{ type: 'build', summary: ErrorSummarizer.summarizeBuildErrors(rawOutput), rawOutput }],
      durationMs: Date.now() - start,
    };
  }
}

export async function testVerifier(workspaceDir: string): Promise<VerificationResult> {
  const start = Date.now();
  try {
    await execFileAsync('npx', ['vitest', 'run'], {
      cwd: workspaceDir,
      timeout: 120_000,
      killSignal: 'SIGKILL',
      maxBuffer: MAX_BUFFER,
    });
    return { passed: true, errors: [], durationMs: Date.now() - start };
  } catch (err) {
    const rawOutput = getExecOutput(err);
    return {
      passed: false,
      errors: [{ type: 'test', summary: ErrorSummarizer.summarizeTestFailures(rawOutput), rawOutput }],
      durationMs: Date.now() - start,
    };
  }
}

export async function lintVerifier(workspaceDir: string): Promise<VerificationResult> {
  const start = Date.now();
  try {
    await execFileAsync('npx', ['eslint', '.', '--max-warnings', '0'], {
      cwd: workspaceDir,
      timeout: 60_000,
      killSignal: 'SIGKILL',
      maxBuffer: MAX_BUFFER,
    });
    return { passed: true, errors: [], durationMs: Date.now() - start };
  } catch (err) {
    const rawOutput = getExecOutput(err);
    return {
      passed: false,
      errors: [{ type: 'lint', summary: ErrorSummarizer.summarizeLintErrors(rawOutput), rawOutput }],
      durationMs: Date.now() - start,
    };
  }
}

export async function compositeVerifier(workspaceDir: string): Promise<VerificationResult> {
  const start = Date.now();

  const [buildResult, testResult, lintResult] = await Promise.allSettled([
    buildVerifier(workspaceDir),
    testVerifier(workspaceDir),
    lintVerifier(workspaceDir),
  ]);

  const allErrors: VerificationError[] = [];
  let allPassed = true;

  for (const result of [buildResult, testResult, lintResult]) {
    if (result.status === 'rejected') {
      allErrors.push({
        type: 'custom',
        summary: `Verifier crashed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
      });
      allPassed = false;
    } else if (!result.value.passed) {
      allErrors.push(...result.value.errors);
      allPassed = false;
    }
  }

  return { passed: allPassed, errors: allErrors, durationMs: Date.now() - start };
}
```

### ESLint Flat Config
```javascript
// Source: typescript-eslint.io/getting-started + ESLint v10 docs
// eslint.config.mjs (project root)

// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    ignores: ['dist/**', 'node_modules/**', '*.config.mjs'],
  },
);
```

### Updated package.json lint script
```json
{
  "scripts": {
    "lint": "eslint ."
  }
}
```

### Wiring into CLI run.ts
```typescript
// Source: Phase 4 run.ts pattern + Phase 5 verifier module
// Replace "No verifier in Phase 4" with:
import { compositeVerifier } from '../../orchestrator/verifier.js';

const orchestrator = new RetryOrchestrator(
  {
    workspaceDir: options.repo,
    turnLimit: options.turnLimit,
    timeoutMs: options.timeout * 1000,
    logger: childLogger,
  },
  {
    maxRetries: options.maxRetries,
    verifier: compositeVerifier,
  }
);
```

### Unit Test Pattern for Verifiers
```typescript
// Source: Phase 4 retry.test.ts pattern + Vitest mocking
// src/orchestrator/verifier.test.ts

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock execFile at module level - must precede imports
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));
vi.mock('node:util', () => ({
  promisify: vi.fn((fn) => fn),  // return fn as-is (already mocked)
}));

import { buildVerifier, testVerifier, lintVerifier, compositeVerifier } from './verifier.js';
import { execFile } from 'node:child_process';

// Each test configures execFile mock to simulate subprocess outcomes
```

## State of the Art

| Old Approach | Current Approach (2026) | When Changed | Impact |
|--------------|-------------------------|--------------|--------|
| `.eslintrc.json` + `@typescript-eslint/parser` separately | Single `typescript-eslint` package + `eslint.config.mjs` | ESLint v10 (Feb 2026) | Simpler setup; eslintrc removed from ESLint v10 |
| ESLint v8 legacy config | ESLint v10 flat config only | Feb 6, 2026 | Breaking change: eslintrc files silently ignored in v9, rejected in v10 |
| `vitest` (watch mode default) | `vitest run` (single run) | Stable since early Vitest versions | Subprocess execution requires explicit `run` flag |
| `tsc` (emit output) | `tsc --noEmit` (type-check only) | Stable since TypeScript 1.x | Verification should not generate artifact files |
| Separate `@typescript-eslint/parser` + `@typescript-eslint/eslint-plugin` packages | Single `typescript-eslint` package | typescript-eslint v8 (2024) | Reduces package count and configuration complexity |

**Deprecated/outdated:**
- **`.eslintrc.*` files**: Removed in ESLint v10 (Feb 2026). Using these files with ESLint v10 will error.
- **`@typescript-eslint/parser` + `@typescript-eslint/eslint-plugin` separate packages**: Replaced by single `typescript-eslint` package in v8+. Still works but legacy setup.
- **`npx vitest` without `run`**: Watch mode — never exits in CI/subprocess contexts.
- **In-process ESLint (`new ESLint().lintFiles()`)**: Still works, but adds complexity for cross-project verification; subprocess is simpler.

## Open Questions

1. **Should the lint verifier fail for new violations only, or all violations?**
   - What we know: The requirement says "no NEW style issues introduced" (VERIFY-03). Running `eslint .` checks all files.
   - What's unclear: If the workspace already has pre-existing lint violations before the agent runs, the lint verifier will fail even if the agent introduced zero new violations.
   - Recommendation: For Phase 5, run `eslint .` on all files. Pre-existing violations are an artifact of the project's lint state before Phase 5. Document that the project must be lint-clean before the agent runs. A more sophisticated "diff-only linting" is a v2 concern.

2. **Should verifiers run in parallel or sequentially?**
   - What we know: `compositeVerifier` as designed uses `Promise.allSettled()` for parallel execution.
   - What's unclear: If the build is completely broken (all TypeScript errors), do test results add signal or noise?
   - Recommendation: Run in parallel with `Promise.allSettled()`. The `ErrorSummarizer` already caps the combined output at 2000 chars. Even if test output is noisy with a broken build, the 2000-char cap ensures the agent's context window isn't flooded.

3. **Should there be a CLI flag to skip specific verifiers?**
   - What we know: The `RetryOrchestrator` accepts a single `verifier` callback.
   - What's unclear: Whether users will want `--skip-lint` or `--skip-tests` for development iteration.
   - Recommendation: For Phase 5, always run all three. Selective verification is a v2 feature. Keep the API simple.

4. **How does ESLint discover `eslint.config.mjs` when run as a subprocess with `cwd: workspaceDir`?**
   - What we know: ESLint v10 locates `eslint.config.*` starting from the directory of each linted file. When `cwd` is set to `workspaceDir`, ESLint looks for `eslint.config.mjs` in `workspaceDir` and parent directories.
   - What's unclear: If the workspace already has an `eslint.config.mjs`, it will be used instead of the orchestrator's config. This is the CORRECT behavior.
   - Recommendation: The `eslint.config.mjs` should be created in the project root (which IS the `workspaceDir` for this project). No special config file path option needed.

## Sources

### Primary (HIGH confidence)
- Node.js v25.6.1 official docs — `child_process.execFile()` API, timeout/maxBuffer/killSignal options, error shape on non-zero exit and timeout: https://nodejs.org/api/child_process.html
- ESLint v10.0.0 release notes (Feb 6, 2026) — eslintrc removal, flat config as sole format, new config file lookup behavior: https://eslint.org/blog/2026/02/eslint-v10.0.0-released/
- ESLint Node.js API Reference — `ESLint` class, `lintFiles()`, `LintResult`/`LintMessage` interfaces, error detection via `errorCount`: https://eslint.org/docs/latest/integrate/nodejs-api
- Vitest advanced programmatic API docs — `startVitest`, `createVitest`, `getTestModules()`, `configFile: false` option: https://vitest.dev/advanced/api/
- typescript-eslint Getting Started — installation command, minimal `eslint.config.mjs`, `tseslint.config()` helper: https://typescript-eslint.io/getting-started/
- Spotify Engineering Part 3 (Feedback Loops) — verifiers use regex extraction, activated by file detection, abstracted from agent: https://engineering.atspotify.com/2025/12/feedback-loops-background-coding-agents-part-3
- Existing Phase 4 codebase — `VerificationResult`, `VerificationError`, `ErrorSummarizer`, `RetryOrchestrator.retryConfig.verifier` interface: `/src/types.ts`, `/src/orchestrator/summarizer.ts`, `/src/orchestrator/retry.ts`

### Secondary (MEDIUM confidence)
- Vitest issue #2167 — programmatic API use cases, maintainer recommendation of `createVitest()`, confirmation that subprocess is the simpler approach for cross-project execution: https://github.com/vitest-dev/vitest/issues/2167
- TypeScript Compiler API wiki — `ts.createProgram()`, `getPreEmitDiagnostics()` for programmatic type checking: https://github.com/Microsoft/TypeScript/wiki/Using-the-Compiler-API

### Tertiary (LOW confidence — for awareness)
- Medium: "Four Ways to Utilize the TypeScript Compiler for Improved Type-Checking" — confirms subprocess `tsc --noEmit` is the practical choice over Compiler API: https://medium.com/la-mobilery/four-ways-to-utilize-the-typescript-compiler-for-improved-type-checking-ae9c7c37d846

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — ESLint v10 release verified with official blog post; typescript-eslint setup verified with official docs; tsc --noEmit and vitest run are stable CLIs
- Architecture (subprocess pattern): HIGH — Matches Spotify's production pattern; confirmed correct by Node.js docs; consistent with existing `execFileAsync` usage in `session.ts`
- Architecture (compositeVerifier): HIGH — Derived directly from existing `VerificationResult` interface and `RetryOrchestrator` verifier callback signature in `types.ts`
- Pitfalls: HIGH — maxBuffer size confirmed by Node.js docs; ESLint v10 breaking changes confirmed by official release notes; vitest watch mode behavior confirmed by Vitest docs
- Don't hand-roll section: HIGH — All items verified against official library capabilities

**Research date:** 2026-02-17
**Valid until:** March 2026 (30 days) — ESLint v10 was JUST released; typescript-eslint and Vitest are stable; subprocess patterns are unchanged
**Re-validate:** If ESLint releases a patch that changes lintFiles behavior; if Vitest programmatic API is stabilized and documented to run cross-project without config

**Coverage verification:**
- [x] Build verifier pattern (tsc --noEmit subprocess) investigated and verified
- [x] Test verifier pattern (vitest run subprocess) investigated and verified
- [x] Lint verifier pattern (eslint . subprocess) investigated and verified
- [x] ESLint v10 setup (flat config, typescript-eslint) investigated and verified
- [x] ESLint NOT installed in project discovered — must install in Phase 5
- [x] Composite verifier (Promise.allSettled) pattern documented
- [x] CLI wiring (run.ts verifier slot from Phase 4) documented
- [x] Error shape from execFileAsync failures documented
- [x] maxBuffer pitfall documented with fix
- [x] killSignal: 'SIGKILL' pattern for reliable subprocess termination documented
- [x] Don't hand-roll: ErrorSummarizer, TypeScript Compiler API, programmatic ESLint
- [x] Subprocess vs in-process tradeoff analyzed and decided
- [x] Types.ts interface confirmed (no changes needed for Phase 5)
- [x] Existing ExecFileAsync pattern in session.ts identified as template

**Dependencies on prior phases:**
- Phase 4: `VerificationResult`, `VerificationError`, `RetryConfig.verifier` type, `ErrorSummarizer` (all consumed unchanged)
- Phase 4: `RetryOrchestrator` (verifier plugs in at line 104 in `retry.ts`)
- Phase 2: `run.ts` CLI command (verifier wired in here)

**Impact on future phases:**
- Phase 6: LLM Judge becomes another verifier using same `(workspaceDir: string) => Promise<VerificationResult>` interface
- Phase 10: Plugin verifiers use the same interface — `compositeVerifier` can be extended to include plugin verifiers
