import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { access, readFile, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { VerificationResult, VerificationError } from '../types.js';
import { ErrorSummarizer } from './summarizer.js';

const execFileAsync = promisify(execFile);

/**
 * Check if an execFileAsync error was caused by a timeout kill signal.
 */
function isTimeoutError(err: unknown): boolean {
  const e = err as Record<string, unknown>;
  return e.killed === true || e.signal === 'SIGTERM' || e.signal === 'SIGKILL';
}

// Note: Verifier functions use console.info/console.error instead of Pino because
// they have a fixed signature (workspaceDir: string) => Promise<VerificationResult>
// matching RetryConfig.verifier. Adding a logger parameter would break this contract.

/**
 * Build verifier: runs tsc --noEmit against the workspace.
 * Skips gracefully if tsconfig.json is not present.
 */
export async function buildVerifier(workspaceDir: string): Promise<VerificationResult> {
  const start = Date.now();

  // Pre-check: tsconfig.json must exist
  try {
    await access(join(workspaceDir, 'tsconfig.json'));
  } catch {
    console.info('[Build] No tsconfig.json found — skipping build verification');
    return { passed: true, errors: [], durationMs: 0 };
  }

  try {
    await execFileAsync('npx', ['tsc', '--noEmit'], {
      cwd: workspaceDir,
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
      killSignal: 'SIGKILL',
    });
    const durationMs = Date.now() - start;
    return { passed: true, errors: [], durationMs };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    if (isTimeoutError(err)) {
      return {
        passed: false,
        errors: [{ type: 'build', summary: 'Build timed out (60s limit exceeded)', rawOutput: 'Process killed after timeout' }],
        durationMs,
      };
    }
    const error = err as { stdout?: string; stderr?: string };
    const rawOutput = [error.stdout ?? '', error.stderr ?? ''].join('\n').trim();
    const summary = ErrorSummarizer.summarizeBuildErrors(rawOutput);
    const verificationError: VerificationError = {
      type: 'build',
      summary,
      rawOutput,
    };
    return { passed: false, errors: [verificationError], durationMs };
  }
}

/**
 * Test verifier: runs vitest run against the workspace.
 * Skips gracefully if no vitest config is found.
 */
export async function testVerifier(workspaceDir: string): Promise<VerificationResult> {
  const start = Date.now();

  // Pre-check: look for vitest config or vitest key in package.json
  const vitestConfigs = [
    'vitest.config.ts',
    'vitest.config.js',
    'vitest.config.mts',
    'vitest.config.mjs',
  ];

  let hasVitestConfig = false;
  for (const configFile of vitestConfigs) {
    try {
      await access(join(workspaceDir, configFile));
      hasVitestConfig = true;
      break;
    } catch {
      // Not found, continue checking
    }
  }

  if (!hasVitestConfig) {
    // Check package.json for vitest key
    try {
      const pkgContent = await readFile(join(workspaceDir, 'package.json'), 'utf-8');
      const pkg = JSON.parse(pkgContent) as Record<string, unknown>;
      if ('vitest' in pkg) {
        hasVitestConfig = true;
      }
    } catch {
      // package.json not found or not parseable
    }
  }

  if (!hasVitestConfig) {
    console.info('[Test] No vitest config found — skipping test verification');
    return { passed: true, errors: [], durationMs: 0 };
  }

  try {
    await execFileAsync('npx', ['vitest', 'run'], {
      cwd: workspaceDir,
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      killSignal: 'SIGKILL',
    });
    const durationMs = Date.now() - start;
    return { passed: true, errors: [], durationMs };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    if (isTimeoutError(err)) {
      return {
        passed: false,
        errors: [{ type: 'test', summary: 'Tests timed out (120s limit exceeded)', rawOutput: 'Process killed after timeout' }],
        durationMs,
      };
    }
    const error = err as { stdout?: string; stderr?: string };
    const rawOutput = [error.stdout ?? '', error.stderr ?? ''].join('\n').trim();
    const summary = ErrorSummarizer.summarizeTestFailures(rawOutput);
    const verificationError: VerificationError = {
      type: 'test',
      summary,
      rawOutput,
    };
    return { passed: false, errors: [verificationError], durationMs };
  }
}

/**
 * Lint verifier: runs ESLint against the workspace.
 * Uses diff-based approach to detect only NEW violations introduced by agent.
 * Skips gracefully if no ESLint config is found.
 */
export async function lintVerifier(workspaceDir: string): Promise<VerificationResult> {
  const start = Date.now();

  // Pre-check: look for ESLint flat config
  const eslintConfigs = [
    'eslint.config.mjs',
    'eslint.config.js',
    'eslint.config.cjs',
    'eslint.config.mts',
    'eslint.config.cts',
  ];

  let hasEslintConfig = false;
  for (const configFile of eslintConfigs) {
    try {
      await access(join(workspaceDir, configFile));
      hasEslintConfig = true;
      break;
    } catch {
      // Not found, continue checking
    }
  }

  if (!hasEslintConfig) {
    console.info('[Lint] No ESLint config found — skipping lint verification');
    return { passed: true, errors: [], durationMs: 0 };
  }

  /**
   * Run ESLint and return the count of error-level violations.
   * ESLint --format json returns an array of file results with messages.
   */
  async function runEslintErrorCount(): Promise<{ count: number; rawOutput: string }> {
    try {
      const result = await execFileAsync(
        'npx',
        ['eslint', '.', '--format', 'json'],
        {
          cwd: workspaceDir,
          timeout: 60_000,
          maxBuffer: 10 * 1024 * 1024,
          killSignal: 'SIGKILL',
        }
      );
      // Exit code 0 means no errors (only warnings or clean)
      const rawOutput = result.stdout ?? '';
      try {
        const parsed = JSON.parse(rawOutput) as Array<{ errorCount: number }>;
        const count = parsed.reduce((sum, f) => sum + f.errorCount, 0);
        return { count, rawOutput };
      } catch {
        return { count: 0, rawOutput };
      }
    } catch (err: unknown) {
      // Non-zero exit: ESLint found errors
      const error = err as { stdout?: string; stderr?: string };
      const rawOutput = error.stdout ?? '';
      try {
        const parsed = JSON.parse(rawOutput) as Array<{ errorCount: number }>;
        const count = parsed.reduce((sum, f) => sum + f.errorCount, 0);
        return { count, rawOutput };
      } catch {
        // JSON parse failed — treat as non-zero error count
        return { count: 1, rawOutput: error.stdout ?? error.stderr ?? '' };
      }
    }
  }

  // Diff-based approach: stash → baseline → pop → current
  try {
    // Use labeled stash so we can identify it for recovery
    const stashResult = await execFileAsync('git', ['stash', 'push', '-m', 'lint-verifier-baseline'], { cwd: workspaceDir });
    const stashSaved = (stashResult.stdout ?? '').includes('Saved');

    if (!stashSaved) {
      // git stash did nothing (clean working tree) — run simple lint
      // No recovery needed since nothing was stashed
      console.info('[Lint] Clean working tree — running simple lint check');
      return await runSimpleLint(start);
    }

    let baselineCount = 0;
    let stashRecoveryError: unknown = undefined;
    try {
      const baseline = await runEslintErrorCount();
      baselineCount = baseline.count;
    } finally {
      // Always restore changes — with defensive recovery
      try {
        await execFileAsync('git', ['stash', 'pop'], { cwd: workspaceDir });
      } catch (popErr: unknown) {
        // CRITICAL: agent changes may be stuck in stash — attempt recovery
        console.error('[Lint] CRITICAL: git stash pop failed, attempting recovery');
        try {
          // Abort any merge state, then force-apply the stash
          await execFileAsync('git', ['checkout', '--', '.'], { cwd: workspaceDir }).catch(() => {});
          await execFileAsync('git', ['stash', 'pop'], { cwd: workspaceDir });
        } catch {
          // Last resort: drop stash to avoid corruption, but changes are lost
          console.error('[Lint] CRITICAL: stash recovery failed — agent changes may be lost in git stash');
          await execFileAsync('git', ['stash', 'drop'], { cwd: workspaceDir }).catch(() => {});
          stashRecoveryError = popErr;
        }
      }
    }
    if (stashRecoveryError) {
      throw stashRecoveryError;
    }

    // Now run eslint on restored (modified) workspace
    const current = await runEslintErrorCount();
    const durationMs = Date.now() - start;

    if (current.count <= baselineCount) {
      // Agent didn't introduce new lint errors
      return { passed: true, errors: [], durationMs };
    }

    // New errors detected
    const summary = ErrorSummarizer.summarizeLintErrorsFromJson(current.rawOutput);
    const verificationError: VerificationError = {
      type: 'lint',
      summary,
      rawOutput: current.rawOutput,
    };
    return { passed: false, errors: [verificationError], durationMs };

  } catch {
    // Git stash failed (e.g., no commits yet)
    // Fall back to simple lint check
    console.info('[Lint] Git stash failed — falling back to simple lint check');
    return await runSimpleLint(start);
  }

  async function runSimpleLint(startTime: number): Promise<VerificationResult> {
    const current = await runEslintErrorCount();
    const durationMs = Date.now() - startTime;

    if (current.count === 0) {
      return { passed: true, errors: [], durationMs };
    }

    const summary = ErrorSummarizer.summarizeLintErrorsFromJson(current.rawOutput);
    const verificationError: VerificationError = {
      type: 'lint',
      summary,
      rawOutput: current.rawOutput,
    };
    return { passed: false, errors: [verificationError], durationMs };
  }
}

/**
 * Detect the Maven command to use: ./mvnw if present and executable, else mvn.
 */
async function detectMvnCmd(workspaceDir: string): Promise<string> {
  try {
    await access(join(workspaceDir, 'mvnw'), constants.X_OK);
    return './mvnw';
  } catch {
    return 'mvn';
  }
}

/**
 * Check if an error is ENOENT (command not found on PATH).
 */
function isEnoentError(err: unknown): boolean {
  return (err as Record<string, unknown>)?.code === 'ENOENT';
}

interface MavenGoalOptions {
  goal: string;
  errorType: 'build' | 'test';
  timeout: number;
  label: string;
  summarizer: (raw: string) => string;
}

/**
 * Shared helper for running a Maven goal. Handles pom.xml detection, mvnw preference,
 * ENOENT errors, timeouts, and error summarization.
 */
async function runMavenGoal(workspaceDir: string, opts: MavenGoalOptions): Promise<VerificationResult> {
  const start = Date.now();

  // Pre-check: pom.xml must exist
  try {
    await access(join(workspaceDir, 'pom.xml'));
  } catch {
    console.info(`[${opts.label}] No pom.xml found — skipping Maven ${opts.goal} verification`);
    return { passed: true, errors: [], durationMs: 0 };
  }

  const mvnCmd = await detectMvnCmd(workspaceDir);

  try {
    await execFileAsync(mvnCmd, [opts.goal, '-B', '-q'], {
      cwd: workspaceDir,
      timeout: opts.timeout,
      maxBuffer: 10 * 1024 * 1024,
      killSignal: 'SIGKILL',
    });
    const durationMs = Date.now() - start;
    return { passed: true, errors: [], durationMs };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    if (isEnoentError(err)) {
      const msg = mvnCmd === './mvnw'
        ? 'mvnw found but not executable — run chmod +x mvnw or install Maven (mvn) on PATH'
        : 'Maven (mvn) not found — ensure Maven is installed or the project includes an executable mvnw';
      return {
        passed: false,
        errors: [{ type: opts.errorType, summary: msg, rawOutput: msg }],
        durationMs,
      };
    }
    if (isTimeoutError(err)) {
      const timeoutSecs = opts.timeout / 1000;
      return {
        passed: false,
        errors: [{ type: opts.errorType, summary: `Maven ${opts.goal} timed out (${timeoutSecs}s limit exceeded)`, rawOutput: 'Process killed after timeout' }],
        durationMs,
      };
    }
    const error = err as { stdout?: string; stderr?: string };
    const rawOutput = [error.stdout ?? '', error.stderr ?? ''].join('\n').trim();
    const summary = opts.summarizer(rawOutput);
    return { passed: false, errors: [{ type: opts.errorType, summary, rawOutput }], durationMs };
  }
}

/**
 * Maven build verifier: runs mvn compile against the workspace.
 * Skips gracefully if pom.xml is not present. Prefers executable mvnw over mvn.
 */
export async function mavenBuildVerifier(workspaceDir: string): Promise<VerificationResult> {
  return runMavenGoal(workspaceDir, {
    goal: 'compile',
    errorType: 'build',
    timeout: 120_000,
    label: 'Maven Build',
    summarizer: ErrorSummarizer.summarizeMavenErrors,
  });
}

/**
 * Maven test verifier: runs mvn test against the workspace.
 * Skips gracefully if pom.xml is not present. Prefers executable mvnw over mvn.
 */
export async function mavenTestVerifier(workspaceDir: string): Promise<VerificationResult> {
  return runMavenGoal(workspaceDir, {
    goal: 'test',
    errorType: 'test',
    timeout: 300_000,
    label: 'Maven Test',
    summarizer: ErrorSummarizer.summarizeMavenTestFailures,
  });
}

/**
 * Read scripts from package.json in the workspace directory.
 * Returns the scripts object or null if package.json is absent/unparseable.
 */
async function readPackageJsonScripts(workspaceDir: string): Promise<Record<string, string> | null> {
  try {
    const content = await readFile(join(workspaceDir, 'package.json'), 'utf-8');
    const pkg = JSON.parse(content) as Record<string, unknown>;
    const scripts = pkg.scripts;
    if (scripts && typeof scripts === 'object') {
      return scripts as Record<string, string>;
    }
    return {};
  } catch {
    return null;
  }
}

/**
 * npm build verifier: runs `npm run build` against the workspace.
 * Skips gracefully if package.json is absent or has no "build" script.
 */
export async function npmBuildVerifier(workspaceDir: string): Promise<VerificationResult> {
  const start = Date.now();

  const scripts = await readPackageJsonScripts(workspaceDir);
  if (scripts === null) {
    console.info('[npm Build] No package.json found — skipping npm build verification');
    return { passed: true, errors: [], durationMs: 0 };
  }
  if (!scripts['build']) {
    console.info('[npm Build] No "build" script in package.json — skipping npm build verification');
    return { passed: true, errors: [], durationMs: 0 };
  }

  try {
    await execFileAsync('npm', ['run', 'build'], {
      cwd: workspaceDir,
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      killSignal: 'SIGKILL',
    });
    const durationMs = Date.now() - start;
    return { passed: true, errors: [], durationMs };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    if (isEnoentError(err)) {
      const msg = 'npm not found — ensure npm is installed and available on PATH';
      return {
        passed: false,
        errors: [{ type: 'build', summary: msg, rawOutput: msg }],
        durationMs,
      };
    }
    if (isTimeoutError(err)) {
      return {
        passed: false,
        errors: [{ type: 'build', summary: 'npm build timed out (120s limit exceeded)', rawOutput: 'Process killed after timeout' }],
        durationMs,
      };
    }
    const error = err as { stdout?: string; stderr?: string };
    const rawOutput = [error.stdout ?? '', error.stderr ?? ''].join('\n').trim();
    const summary = ErrorSummarizer.summarizeNpmBuildErrors(rawOutput);
    return { passed: false, errors: [{ type: 'build', summary, rawOutput }], durationMs };
  }
}

/**
 * npm test verifier: runs `npm test` against the workspace.
 * Skips gracefully if package.json is absent or has no "test" script.
 */
export async function npmTestVerifier(workspaceDir: string): Promise<VerificationResult> {
  const start = Date.now();

  const scripts = await readPackageJsonScripts(workspaceDir);
  if (scripts === null) {
    console.info('[npm Test] No package.json found — skipping npm test verification');
    return { passed: true, errors: [], durationMs: 0 };
  }
  if (!scripts['test']) {
    console.info('[npm Test] No "test" script in package.json — skipping npm test verification');
    return { passed: true, errors: [], durationMs: 0 };
  }

  try {
    await execFileAsync('npm', ['test'], {
      cwd: workspaceDir,
      timeout: 300_000,
      maxBuffer: 10 * 1024 * 1024,
      killSignal: 'SIGKILL',
    });
    const durationMs = Date.now() - start;
    return { passed: true, errors: [], durationMs };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    if (isEnoentError(err)) {
      const msg = 'npm not found — ensure npm is installed and available on PATH';
      return {
        passed: false,
        errors: [{ type: 'test', summary: msg, rawOutput: msg }],
        durationMs,
      };
    }
    if (isTimeoutError(err)) {
      return {
        passed: false,
        errors: [{ type: 'test', summary: 'npm tests timed out (300s limit exceeded)', rawOutput: 'Process killed after timeout' }],
        durationMs,
      };
    }
    const error = err as { stdout?: string; stderr?: string };
    const rawOutput = [error.stdout ?? '', error.stderr ?? ''].join('\n').trim();
    const summary = ErrorSummarizer.summarizeNpmTestFailures(rawOutput);
    return { passed: false, errors: [{ type: 'test', summary, rawOutput }], durationMs };
  }
}

/**
 * Composite verifier: runs build and test in parallel, then lint sequentially.
 * Lint runs after build+test because it uses git stash which would corrupt the
 * workspace for concurrent build/test verifiers reading source files.
 * Aggregates results with Build > Test > Maven Build > Maven Test > npm Build > npm Test > Lint ordering.
 * Uses Promise.allSettled so a verifier crash doesn't block others.
 */
export async function compositeVerifier(workspaceDir: string): Promise<VerificationResult> {
  const wallStart = Date.now();

  // TypeScript build and test run in parallel (read-only on workspace)
  const [buildResult, testResult] = await Promise.allSettled([
    buildVerifier(workspaceDir),
    testVerifier(workspaceDir),
  ]);

  // Maven verifiers run sequentially — both write to target/, and mvn test
  // implicitly compiles. Run build first so we get a clear build vs test signal.
  const mavenBuildResult = await mavenBuildVerifier(workspaceDir)
    .then((v): PromiseSettledResult<VerificationResult> => ({ status: 'fulfilled', value: v }))
    .catch((r): PromiseSettledResult<VerificationResult> => ({ status: 'rejected', reason: r }));

  const resolvedMavenBuild = resolveResult(mavenBuildResult, 'Maven Build');
  // Skip Maven tests if build failed — test output would be noise
  let mavenTestSettled: PromiseSettledResult<VerificationResult>;
  if (!resolvedMavenBuild.passed && resolvedMavenBuild.errors.length > 0) {
    console.info('[Maven Test] Skipped — Maven build failed');
    mavenTestSettled = { status: 'fulfilled', value: { passed: true, errors: [], durationMs: 0 } };
  } else {
    mavenTestSettled = await mavenTestVerifier(workspaceDir)
      .then((v): PromiseSettledResult<VerificationResult> => ({ status: 'fulfilled', value: v }))
      .catch((r): PromiseSettledResult<VerificationResult> => ({ status: 'rejected', reason: r }));
  }

  // npm verifiers run sequentially after Maven — npm test may invoke npm build internally.
  // Run npm build first so we get a clear signal.
  const npmBuildResult = await npmBuildVerifier(workspaceDir)
    .then((v): PromiseSettledResult<VerificationResult> => ({ status: 'fulfilled', value: v }))
    .catch((r): PromiseSettledResult<VerificationResult> => ({ status: 'rejected', reason: r }));

  const resolvedNpmBuild = resolveResult(npmBuildResult, 'npm Build');
  // Skip npm tests if npm build failed — test output would be noise
  let npmTestSettled: PromiseSettledResult<VerificationResult>;
  if (!resolvedNpmBuild.passed && resolvedNpmBuild.errors.length > 0) {
    console.info('[npm Test] Skipped — npm build failed');
    npmTestSettled = { status: 'fulfilled', value: { passed: true, errors: [], durationMs: 0 } };
  } else {
    npmTestSettled = await npmTestVerifier(workspaceDir)
      .then((v): PromiseSettledResult<VerificationResult> => ({ status: 'fulfilled', value: v }))
      .catch((r): PromiseSettledResult<VerificationResult> => ({ status: 'rejected', reason: r }));
  }

  // Lint runs sequentially after build+test to avoid git stash race condition (P2)
  const lintResult = await lintVerifier(workspaceDir)
    .then((v): PromiseSettledResult<VerificationResult> => ({ status: 'fulfilled', value: v }))
    .catch((r): PromiseSettledResult<VerificationResult> => ({ status: 'rejected', reason: r }));

  const build = resolveResult(buildResult, 'Build');
  const test = resolveResult(testResult, 'Test');
  const mavenBuild = resolvedMavenBuild;
  const mavenTest = resolveResult(mavenTestSettled, 'Maven Test');
  const npmBuild = resolvedNpmBuild;
  const npmTest = resolveResult(npmTestSettled, 'npm Test');
  const lint = resolveResult(lintResult, 'Lint');

  // Log timing info per locked decision
  const buildSecs = (build.durationMs / 1000).toFixed(1);
  const testSecs = (test.durationMs / 1000).toFixed(1);
  const mvnBuildSecs = (mavenBuild.durationMs / 1000).toFixed(1);
  const mvnTestSecs = (mavenTest.durationMs / 1000).toFixed(1);
  const npmBuildSecs = (npmBuild.durationMs / 1000).toFixed(1);
  const npmTestSecs = (npmTest.durationMs / 1000).toFixed(1);
  const lintSecs = (lint.durationMs / 1000).toFixed(1);
  console.info(
    `[Verifier] Build: ${build.passed ? 'PASS' : 'FAIL'} (${buildSecs}s), ` +
    `Test: ${test.passed ? 'PASS' : 'FAIL'} (${testSecs}s), ` +
    `Maven Build: ${mavenBuild.passed ? 'PASS' : 'FAIL'} (${mvnBuildSecs}s), ` +
    `Maven Test: ${mavenTest.passed ? 'PASS' : 'FAIL'} (${mvnTestSecs}s), ` +
    `npm Build: ${npmBuild.passed ? 'PASS' : 'FAIL'} (${npmBuildSecs}s), ` +
    `npm Test: ${npmTest.passed ? 'PASS' : 'FAIL'} (${npmTestSecs}s), ` +
    `Lint: ${lint.passed ? 'PASS' : 'FAIL'} (${lintSecs}s)`
  );

  // Aggregate: Build > Test > Maven Build > Maven Test > npm Build > npm Test > Lint
  const allErrors: VerificationError[] = [
    ...build.errors,
    ...test.errors,
    ...mavenBuild.errors,
    ...mavenTest.errors,
    ...npmBuild.errors,
    ...npmTest.errors,
    ...lint.errors,
  ];

  const passed = build.passed && test.passed && mavenBuild.passed && mavenTest.passed && npmBuild.passed && npmTest.passed && lint.passed;
  const durationMs = Date.now() - wallStart;

  return { passed, errors: allErrors, durationMs };
}

/**
 * Resolve a PromiseSettledResult into a VerificationResult, converting rejections
 * to structured error objects.
 */
function resolveResult(
  settled: PromiseSettledResult<VerificationResult>,
  label: string
): VerificationResult {
  if (settled.status === 'fulfilled') {
    return settled.value;
  }
  const message = settled.reason instanceof Error
    ? settled.reason.message
    : String(settled.reason);
  return {
    passed: false,
    errors: [{
      type: 'custom',
      summary: `${label} verifier crashed: ${message}`,
      rawOutput: message,
    }],
    durationMs: 0,
  };
}
