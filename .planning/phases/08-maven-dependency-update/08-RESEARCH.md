# Phase 8: Maven Dependency Update - Research

**Researched:** 2026-03-05
**Domain:** CLI extension, prompt engineering, build-system-aware verification
**Confidence:** HIGH

## Summary

Phase 8 adds Maven dependency update capability to the existing background coding agent. The implementation touches three areas: (1) CLI input with `--dep` and `--target-version` flags, (2) a prompt module that generates end-state prompts per task type, and (3) build-system detection in the composite verifier so Maven projects get `mvn compile` / `mvn test` instead of `tsc` / `vitest`.

The existing RetryOrchestrator already handles the breaking-change retry loop -- when Maven build fails after a version bump, the verifier catches it, and the retry loop feeds error context back to the agent. No new retry mechanism is needed. The PR creator is already wired in from Phase 7.

**Primary recommendation:** Structure work as three focused plans: (1) CLI flags + prompt module, (2) Maven build-system detection in composite verifier, (3) integration wiring in run.ts to connect prompt module and pass dep/version through the pipeline.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- New flags: `--dep <groupId:artifactId>` and `--target-version <version>`
- `--dep` uses colon-separated format for groupId:artifactId (familiar Maven convention)
- `--target-version` is a separate flag for the desired version
- Both flags are conditionally required: CLI validates they are present when `-t maven-dependency-update` (and later npm-dependency-update)
- Keep existing `-t` / `--task-type` flag approach -- no subcommands for now
- End-state prompting (established project decision from Spotify research, TASK-04)
- Agent discovers current version itself by reading pom.xml (no host-side pre-reading)
- Agent handles multi-module projects naturally without explicit prompt instructions
- Separate prompt-builder module (`prompts/` or similar) with a function per task type
- Build-system detection in the existing composite verifier (not task-specific verifiers)
- Verifier detects `pom.xml` in workspace and runs Maven commands (`mvn compile`, `mvn test`)
- Use the existing RetryOrchestrator retry loop -- no separate breaking-change mechanism
- 10 turns per attempt x 3 retries = 30 total turns max (user can override with --turn-limit)
- If all retries exhausted: fail with exit code 1, log what was tried, show remaining compilation errors, no PR created

### Claude's Discretion
- Exact end-state prompt wording (within end-state format constraint)
- Prompt module file structure and naming
- Build-system detection implementation details in composite verifier
- How to report remaining errors on final failure
- Maven command flags and options used in verification

### Deferred Ideas (OUT OF SCOPE)
- Conversational agent loop (future milestone)
- Changelog/release notes link in PR body (MVN-05) -- requires network access
- Subcommand-based CLI redesign
- "Update all outdated deps" mode (BAT-01)
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| MVN-01 | User specifies Maven dependency (groupId:artifactId) and target version via CLI | CLI flag design with `--dep` and `--target-version`, conditional validation when task-type is maven-dependency-update |
| MVN-02 | Agent locates and updates version in pom.xml | End-state prompt tells agent the desired outcome; agent uses existing tools (read_file, edit_file, grep) to find and update pom.xml |
| MVN-03 | Agent runs Maven build and tests to verify update | Maven build-system detection in composite verifier: detect pom.xml, run `mvn compile` and `mvn test` |
| MVN-04 | Agent attempts code changes if new version has breaking API changes | Existing RetryOrchestrator retry loop: build fails -> verifier catches -> retry with error context -> agent fixes code |
| MVN-05 | Agent includes dependency changelog/release notes link in PR body | DEFERRED per CONTEXT.md -- Docker has no network access. Revisit when network capability added |
</phase_requirements>

## Standard Stack

### Core (Already in Project)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| commander | ^14.0.3 | CLI framework | Already used, add new options to existing program |
| pino | ^10.3.0 | Structured logging | Already used throughout orchestrator |
| vitest | ^4.0.18 | Test framework | Already used for all unit tests |

### Supporting (No New Dependencies)
This phase requires NO new npm dependencies. All work extends existing modules:
- `src/cli/index.ts` -- add flag definitions
- `src/cli/commands/run.ts` -- add fields to RunOptions, wire prompt module
- `src/orchestrator/verifier.ts` -- add Maven detection to composite verifier
- New `src/prompts/` module -- pure TypeScript, no external deps

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| execFileAsync for mvn | simple-git + custom exec | execFileAsync matches existing verifier pattern (tsc, vitest, eslint all use it) |
| Separate maven verifier function | Inline detection in compositeVerifier | Separate function follows existing buildVerifier/testVerifier pattern -- better testability |

## Architecture Patterns

### Recommended Project Structure
```
src/
  cli/
    index.ts           # Add --dep and --target-version option definitions
    commands/
      run.ts           # Add dep/targetVersion to RunOptions, use prompt module
  orchestrator/
    verifier.ts        # Add mavenBuildVerifier + mavenTestVerifier, update compositeVerifier
    verifier.test.ts   # Add Maven verifier tests
  prompts/
    index.ts           # Barrel export
    maven.ts           # buildMavenPrompt(dep, targetVersion) -> string
    maven.test.ts      # Prompt builder tests
  types.ts             # No changes needed
```

### Pattern 1: Conditional CLI Validation
**What:** Flags that are required only for certain task types
**When to use:** `--dep` and `--target-version` are only required when `-t maven-dependency-update`
**Example:**
```typescript
// In src/cli/index.ts, inside .action() handler:
const depRequiringTaskTypes = ['maven-dependency-update'];
if (depRequiringTaskTypes.includes(options.taskType)) {
  if (!options.dep) {
    console.error(pc.red('Error: --dep is required for task type: ' + options.taskType));
    process.exit(2);
  }
  if (!options.targetVersion) {
    console.error(pc.red('Error: --target-version is required for task type: ' + options.taskType));
    process.exit(2);
  }
}
```

### Pattern 2: End-State Prompt Builder
**What:** Function that returns a complete prompt string describing desired outcome
**When to use:** Every task type gets its own prompt builder
**Example:**
```typescript
// src/prompts/maven.ts
export function buildMavenPrompt(dep: string, targetVersion: string): string {
  return [
    `Update the Maven dependency ${dep} to version ${targetVersion}.`,
    '',
    'The codebase should build successfully and all tests should pass after the update.',
    'If the new version introduces breaking API changes, update the code to be compatible.',
    '',
    'Work in the current directory.',
  ].join('\n');
}
```

### Pattern 3: Build-System Detection in Verifier
**What:** Verifier checks for pom.xml to decide whether to run Maven commands
**When to use:** Composite verifier needs to handle Maven projects alongside TypeScript projects
**Example:**
```typescript
// In verifier.ts -- follows exact same pattern as buildVerifier/testVerifier
export async function mavenBuildVerifier(workspaceDir: string): Promise<VerificationResult> {
  const start = Date.now();

  // Pre-check: pom.xml must exist
  try {
    await access(join(workspaceDir, 'pom.xml'));
  } catch {
    return { passed: true, errors: [], durationMs: 0 }; // Skip gracefully
  }

  try {
    await execFileAsync('mvn', ['compile', '-B', '-q'], {
      cwd: workspaceDir,
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      killSignal: 'SIGKILL',
    });
    return { passed: true, errors: [], durationMs: Date.now() - start };
  } catch (err: unknown) {
    // Same error handling pattern as buildVerifier
  }
}
```

### Pattern 4: Prompt Module Dispatch in run.ts
**What:** Replace hardcoded prompt string with task-type-aware prompt builder
**When to use:** In run.ts where the prompt is currently constructed
**Example:**
```typescript
// Replace line 84 of run.ts:
//   const prompt = `You are a coding agent. Your task: ${options.taskType}. Work in the current directory.`;
// With:
import { buildPrompt } from '../prompts/index.js';

const prompt = buildPrompt(options);
```

### Anti-Patterns to Avoid
- **Task-specific verifiers:** Do NOT create a "MavenDependencyUpdateVerifier" -- build-system detection in the composite verifier is the locked decision. A Maven project doing a refactor task should also get Maven verification.
- **Host-side pom.xml parsing:** Do NOT read pom.xml on the host to find the current version. The agent discovers this itself (locked decision).
- **Step-by-step prompting:** Do NOT tell the agent "Step 1: find pom.xml, Step 2: update version..." -- end-state prompting is the established pattern.
- **Separate breaking-change mechanism:** Do NOT build special logic for breaking changes. The existing retry loop handles this naturally.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Maven build execution | Custom Maven wrapper | `execFileAsync('mvn', [...])` | Same pattern as tsc/vitest/eslint in existing verifiers |
| Retry on build failure | New retry mechanism | Existing `RetryOrchestrator` | Already handles verification failure -> retry with error context |
| PR creation after success | New PR flow | Existing `GitHubPRCreator` | Already wired in run.ts, works for any task type |
| Error summarization | Maven-specific summarizer | Extend `ErrorSummarizer` | Add `summarizeMavenErrors` following existing pattern |
| CLI flag parsing | Manual argv parsing | Commander.js `.option()` | Already used, just add new options |

**Key insight:** This phase is primarily about extending existing patterns, not building new infrastructure. The hard work (retry loop, verification, PR creation, agent session) is already done.

## Common Pitfalls

### Pitfall 1: Maven Not Available in Docker Container
**What goes wrong:** The agent-sandbox Docker image (Alpine 3.18) likely does not have Maven or Java installed.
**Why it happens:** The verifier runs `mvn` on the HOST (via `execFileAsync`), not inside the container. But the agent itself runs inside Docker and may need to reference Maven output.
**How to avoid:** The verifier runs on the host, same as `tsc`, `vitest`, and `eslint`. The host must have `mvn` installed. Document this as a prerequisite. The verifier should handle `mvn: command not found` gracefully (same as how buildVerifier handles missing tsc).
**Warning signs:** Verifier crashes with ENOENT instead of returning a structured error.

### Pitfall 2: Maven Wrapper (mvnw) vs Global Maven
**What goes wrong:** Many Maven projects use `./mvnw` (Maven Wrapper) instead of globally installed `mvn`.
**Why it happens:** Maven Wrapper is the standard in modern Maven projects -- it ensures consistent Maven versions.
**How to avoid:** Check for `mvnw` first, fall back to `mvn`. Pattern: `const mvnCmd = existsSync(join(workspaceDir, 'mvnw')) ? './mvnw' : 'mvn';`
**Warning signs:** Build works locally but fails in the agent because the project uses mvnw.

### Pitfall 3: Conditional Flag Validation Order
**What goes wrong:** Commander.js validates required options before the action handler runs, so you can't make `--dep` conditionally required via Commander itself.
**Why it happens:** Commander's `.requiredOption()` always requires the flag. Conditional requirement must be validated manually in the action handler.
**How to avoid:** Use `.option()` (not `.requiredOption()`) for `--dep` and `--target-version`, then validate manually inside the action handler based on task type.
**Warning signs:** CLI crashes when running non-Maven tasks because `--dep` is "required".

### Pitfall 4: Maven Output Parsing for Error Summarization
**What goes wrong:** Maven error output format differs significantly from TypeScript/ESLint output.
**Why it happens:** Maven uses `[ERROR]` prefix lines, compilation errors show Java file paths, test failures show surefire-style output.
**How to avoid:** Add `summarizeMavenErrors` to ErrorSummarizer that handles `[ERROR]` prefixed lines and Maven-specific patterns like `[ERROR] /path/to/File.java:[line,col] error: ...`
**Warning signs:** Agent receives unhelpful "Build failed (no specific error lines found)" because the summarizer doesn't recognize Maven output format.

### Pitfall 5: pom.xml with Version in Parent or Properties
**What goes wrong:** Agent can't find the version to update because it's defined in a `<properties>` block or inherited from a parent POM.
**Why it happens:** Maven projects commonly define dependency versions as properties (e.g., `<spring.version>3.2.0</spring.version>`) rather than inline in the `<dependency>` block.
**How to avoid:** This is handled by end-state prompting -- the agent is told the desired outcome and figures out where the version is defined. No host-side logic needed. The prompt should NOT prescribe how to find the version.
**Warning signs:** Overly specific prompt that tells the agent to "find the `<version>` tag inside the `<dependency>` block" -- this would fail for properties-based versioning.

### Pitfall 6: Maven `-B` Flag for Non-Interactive Mode
**What goes wrong:** Maven prompts for input during build (e.g., for snapshots, interactive mode).
**Why it happens:** Maven defaults to interactive mode in some scenarios.
**How to avoid:** Always pass `-B` (batch mode) flag to Maven commands. Also consider `--no-transfer-progress` to reduce output noise (Maven 3.6+).
**Warning signs:** Build hangs waiting for user input that never comes.

## Code Examples

### CLI Flag Addition (src/cli/index.ts)
```typescript
// Add after existing .option() calls:
.option('--dep <groupId:artifactId>', 'Maven/npm dependency to update (e.g., org.springframework:spring-core)')
.option('--target-version <version>', 'Target version for dependency update')
```

### RunOptions Extension (src/cli/commands/run.ts)
```typescript
export interface RunOptions {
  taskType: string;
  repo: string;
  turnLimit: number;
  timeout: number;
  maxRetries: number;
  noJudge?: boolean;
  createPr?: boolean;
  branchOverride?: string;
  dep?: string;            // NEW: groupId:artifactId
  targetVersion?: string;  // NEW: target version
}
```

### Maven Build Verifier (src/orchestrator/verifier.ts)
```typescript
export async function mavenBuildVerifier(workspaceDir: string): Promise<VerificationResult> {
  const start = Date.now();

  try {
    await access(join(workspaceDir, 'pom.xml'));
  } catch {
    return { passed: true, errors: [], durationMs: 0 };
  }

  // Prefer mvnw if available
  const mvnCmd = await access(join(workspaceDir, 'mvnw')).then(() => './mvnw', () => 'mvn');

  try {
    await execFileAsync(mvnCmd, ['compile', '-B', '-q'], {
      cwd: workspaceDir,
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      killSignal: 'SIGKILL',
    });
    return { passed: true, errors: [], durationMs: Date.now() - start };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    if (isTimeoutError(err)) {
      return {
        passed: false,
        errors: [{ type: 'build', summary: 'Maven build timed out (120s limit exceeded)' }],
        durationMs,
      };
    }
    const error = err as { stdout?: string; stderr?: string };
    const rawOutput = [error.stdout ?? '', error.stderr ?? ''].join('\n').trim();
    const summary = ErrorSummarizer.summarizeMavenErrors(rawOutput);
    return { passed: false, errors: [{ type: 'build', summary, rawOutput }], durationMs };
  }
}
```

### Maven Test Verifier (src/orchestrator/verifier.ts)
```typescript
export async function mavenTestVerifier(workspaceDir: string): Promise<VerificationResult> {
  const start = Date.now();

  try {
    await access(join(workspaceDir, 'pom.xml'));
  } catch {
    return { passed: true, errors: [], durationMs: 0 };
  }

  const mvnCmd = await access(join(workspaceDir, 'mvnw')).then(() => './mvnw', () => 'mvn');

  try {
    await execFileAsync(mvnCmd, ['test', '-B', '-q'], {
      cwd: workspaceDir,
      timeout: 300_000,  // Tests can take longer
      maxBuffer: 10 * 1024 * 1024,
      killSignal: 'SIGKILL',
    });
    return { passed: true, errors: [], durationMs: Date.now() - start };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    if (isTimeoutError(err)) {
      return {
        passed: false,
        errors: [{ type: 'test', summary: 'Maven tests timed out (300s limit exceeded)' }],
        durationMs,
      };
    }
    const error = err as { stdout?: string; stderr?: string };
    const rawOutput = [error.stdout ?? '', error.stderr ?? ''].join('\n').trim();
    const summary = ErrorSummarizer.summarizeMavenTestFailures(rawOutput);
    return { passed: false, errors: [{ type: 'test', summary, rawOutput }], durationMs };
  }
}
```

### Maven Error Summarizer Patterns
```typescript
// Maven compilation errors: [ERROR] /path/File.java:[10,5] error: cannot find symbol
static summarizeMavenErrors(rawOutput: string): string {
  const errorLines = rawOutput.match(/\[ERROR\]\s+[^\n]+/g) ?? [];
  // Filter out noise like [ERROR] -> [Help 1]
  const meaningful = errorLines.filter(l => !l.includes('[Help'));
  if (meaningful.length === 0) {
    return 'Maven build failed (no specific error lines found)';
  }
  const shown = meaningful.slice(0, 5);
  const remaining = meaningful.length - shown.length;
  const more = remaining > 0 ? `\n(+ ${remaining} more errors)` : '';
  return `${meaningful.length} Maven error(s):\n${shown.join('\n')}${more}`;
}

// Maven test failures: surefire output
static summarizeMavenTestFailures(rawOutput: string): string {
  // Surefire: "Tests run: 5, Failures: 2, Errors: 0, Skipped: 0"
  const summaryLine = rawOutput.match(/Tests run: \d+, Failures: \d+[^\n]*/)?.[0] ?? '';
  const failedTests = rawOutput.match(/\[ERROR\]\s+\w+[^\n]+/g) ?? [];
  // ... follow same pattern as summarizeTestFailures
}
```

### Updated compositeVerifier
```typescript
export async function compositeVerifier(workspaceDir: string): Promise<VerificationResult> {
  // TypeScript build and test run in parallel
  const [buildResult, testResult] = await Promise.allSettled([
    buildVerifier(workspaceDir),
    testVerifier(workspaceDir),
  ]);

  // Maven build and test run in parallel (skips if no pom.xml)
  const [mavenBuildResult, mavenTestResult] = await Promise.allSettled([
    mavenBuildVerifier(workspaceDir),
    mavenTestVerifier(workspaceDir),
  ]);

  // Lint runs sequentially (git stash race condition)
  const lintResult = await lintVerifier(workspaceDir)
    .then((v) => ({ status: 'fulfilled' as const, value: v }))
    .catch((r) => ({ status: 'rejected' as const, reason: r }));

  // Resolve + aggregate all results
  // ...
}
```

### Prompt Module Entry Point
```typescript
// src/prompts/index.ts
import { buildMavenPrompt } from './maven.js';
import type { RunOptions } from '../cli/commands/run.js';

export function buildPrompt(options: RunOptions): string {
  switch (options.taskType) {
    case 'maven-dependency-update':
      if (!options.dep || !options.targetVersion) {
        throw new Error('dep and targetVersion required for maven-dependency-update');
      }
      return buildMavenPrompt(options.dep, options.targetVersion);
    default:
      // Fallback for generic tasks (backward compatible)
      return `You are a coding agent. Your task: ${options.taskType}. Work in the current directory.`;
  }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Hardcoded prompt in run.ts | Prompt module with per-task builders | Phase 8 | Enables Phase 9 npm, future task types |
| TypeScript-only verifier | Build-system-aware composite verifier | Phase 8 | Verifier works for Maven, npm, future systems |

**Not deprecated:**
- The existing `buildVerifier` (tsc) and `testVerifier` (vitest) remain -- they handle TypeScript projects. Maven verifiers are additive.

## Open Questions

1. **Maven test timeout budget**
   - What we know: Current vitest timeout is 120s. Maven test suites can be much slower.
   - What's unclear: What's a reasonable timeout for Maven tests in a dependency update scenario?
   - Recommendation: Use 300s (5 min) for Maven tests, matching the default session timeout. User can override via --timeout if needed.

2. **Verifier execution strategy for mixed projects**
   - What we know: A project could have both pom.xml and package.json (e.g., a monorepo with Java backend and JS frontend).
   - What's unclear: Should both build systems run in parallel?
   - Recommendation: Yes -- all verifiers already skip gracefully when their config file is absent. Running both in parallel is safe and matches the existing pattern.

3. **Maven `-q` (quiet) flag trade-off**
   - What we know: `-q` reduces output noise. But when builds fail, you want the full error output.
   - What's unclear: Does `-q` suppress error output too?
   - Recommendation: Use `-q` for success path (reduces maxBuffer usage). Maven still outputs errors even with `-q`. If this causes issues, remove `-q` and rely on ErrorSummarizer to extract relevant lines.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.0.18 |
| Config file | package.json (vitest key or script) |
| Quick run command | `npx vitest run src/orchestrator/verifier.test.ts src/prompts/maven.test.ts` |
| Full suite command | `npx vitest run` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| MVN-01 | CLI validates --dep and --target-version for maven-dependency-update | unit | `npx vitest run src/cli/index.test.ts -x` | No -- Wave 0 |
| MVN-02 | Prompt builder generates correct end-state prompt | unit | `npx vitest run src/prompts/maven.test.ts -x` | No -- Wave 0 |
| MVN-03 | Maven verifier detects pom.xml and runs mvn compile/test | unit | `npx vitest run src/orchestrator/verifier.test.ts -x` | Yes (extend) |
| MVN-04 | Retry loop feeds Maven errors back to agent | unit | `npx vitest run src/orchestrator/retry.test.ts -x` | Yes (existing covers) |
| MVN-05 | DEFERRED | - | - | - |

### Sampling Rate
- **Per task commit:** `npx vitest run --reporter=verbose`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/prompts/maven.test.ts` -- covers MVN-02 (prompt generation)
- [ ] `src/orchestrator/verifier.test.ts` -- extend with Maven verifier tests (MVN-03)
- [ ] CLI validation tests for --dep/--target-version conditional requirement (MVN-01)

## Sources

### Primary (HIGH confidence)
- Project source code analysis -- complete read of all relevant files:
  - `src/cli/index.ts` (CLI framework, option definitions)
  - `src/cli/commands/run.ts` (RunOptions, prompt construction, orchestrator wiring)
  - `src/orchestrator/verifier.ts` (composite verifier pattern, build-system detection approach)
  - `src/orchestrator/retry.ts` (retry loop, error context injection)
  - `src/orchestrator/pr-creator.ts` (PR creation, branch naming)
  - `src/orchestrator/session.ts` (agent tools, Docker execution)
  - `src/orchestrator/summarizer.ts` (error summarization patterns)
  - `src/types.ts` (all interfaces)
  - `src/orchestrator/verifier.test.ts` (test patterns, mock strategies)
  - `package.json` (dependencies, scripts)

### Secondary (MEDIUM confidence)
- CONTEXT.md decisions (locked by user discussion session)
- REQUIREMENTS.md (MVN-01 through MVN-05 definitions)
- STATE.md (project history, prior decisions)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new dependencies, extending existing patterns
- Architecture: HIGH -- all patterns directly mirror existing code (verifier, CLI, tests)
- Pitfalls: HIGH -- derived from reading actual codebase patterns and understanding Maven conventions
- Prompt design: MEDIUM -- end-state wording is Claude's discretion per CONTEXT.md, exact effectiveness depends on the agent model

**Research date:** 2026-03-05
**Valid until:** 2026-04-05 (stable -- all findings are project-internal architecture)
