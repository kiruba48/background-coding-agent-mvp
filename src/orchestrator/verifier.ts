import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { VerificationResult, VerificationError } from '../types.js';
import { ErrorSummarizer } from './summarizer.js';

const execFileAsync = promisify(execFile);

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
    console.log('[Build] No tsconfig.json found — skipping build verification');
    return { passed: true, errors: [], durationMs: 0 };
  }

  try {
    await execFileAsync('npx', ['tsc', '--noEmit'], {
      cwd: workspaceDir,
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const durationMs = Date.now() - start;
    return { passed: true, errors: [], durationMs };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
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
    console.log('[Test] No vitest config found — skipping test verification');
    return { passed: true, errors: [], durationMs: 0 };
  }

  try {
    await execFileAsync('npx', ['vitest', 'run'], {
      cwd: workspaceDir,
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const durationMs = Date.now() - start;
    return { passed: true, errors: [], durationMs };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
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
    console.log('[Lint] No ESLint config found — skipping lint verification');
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
    // Save current changes
    await execFileAsync('git', ['stash'], { cwd: workspaceDir });

    let baselineCount = 0;
    try {
      const baseline = await runEslintErrorCount();
      baselineCount = baseline.count;
    } finally {
      // Always restore changes
      await execFileAsync('git', ['stash', 'pop'], { cwd: workspaceDir });
    }

    // Now run eslint on restored (modified) workspace
    const current = await runEslintErrorCount();
    const durationMs = Date.now() - start;

    if (current.count <= baselineCount) {
      // Agent didn't introduce new lint errors
      return { passed: true, errors: [], durationMs };
    }

    // New errors detected
    const summary = ErrorSummarizer.summarizeLintErrors(current.rawOutput);
    const verificationError: VerificationError = {
      type: 'lint',
      summary,
      rawOutput: current.rawOutput,
    };
    return { passed: false, errors: [verificationError], durationMs };

  } catch (gitErr: unknown) {
    // Git stash failed (e.g., no commits yet, clean working tree)
    // Fall back to simple lint check
    console.log('[Lint] Git stash failed — falling back to simple lint check');
    const current = await runEslintErrorCount();
    const durationMs = Date.now() - start;

    if (current.count === 0) {
      return { passed: true, errors: [], durationMs };
    }

    const summary = ErrorSummarizer.summarizeLintErrors(current.rawOutput);
    const verificationError: VerificationError = {
      type: 'lint',
      summary,
      rawOutput: current.rawOutput,
    };
    return { passed: false, errors: [verificationError], durationMs };
  }
}

/**
 * Composite verifier: runs build, test, and lint verifiers in parallel.
 * Aggregates results with Build > Test > Lint ordering.
 * Uses Promise.allSettled so a verifier crash doesn't block others.
 */
export async function compositeVerifier(workspaceDir: string): Promise<VerificationResult> {
  const [buildResult, testResult, lintResult] = await Promise.allSettled([
    buildVerifier(workspaceDir),
    testVerifier(workspaceDir),
    lintVerifier(workspaceDir),
  ]);

  // Resolve each settled result (convert rejections to failed VerificationResult)
  function resolveResult(
    settled: PromiseSettledResult<VerificationResult>,
    type: VerificationError['type']
  ): VerificationResult {
    if (settled.status === 'fulfilled') {
      return settled.value;
    }
    // Verifier crashed
    const message = settled.reason instanceof Error
      ? settled.reason.message
      : String(settled.reason);
    return {
      passed: false,
      errors: [{
        type,
        summary: `Verifier crashed: ${message}`,
        rawOutput: message,
      }],
      durationMs: 0,
    };
  }

  const build = resolveResult(buildResult, 'build');
  const test = resolveResult(testResult, 'test');
  const lint = resolveResult(lintResult, 'lint');

  // Log timing info per locked decision
  const buildSecs = (build.durationMs / 1000).toFixed(1);
  const testSecs = (test.durationMs / 1000).toFixed(1);
  const lintSecs = (lint.durationMs / 1000).toFixed(1);
  console.log(
    `[Verifier] Build: ${build.passed ? 'PASS' : 'FAIL'} (${buildSecs}s), ` +
    `Test: ${test.passed ? 'PASS' : 'FAIL'} (${testSecs}s), ` +
    `Lint: ${lint.passed ? 'PASS' : 'FAIL'} (${lintSecs}s)`
  );

  // Aggregate: Build errors first, then Test, then Lint
  const allErrors: VerificationError[] = [
    ...build.errors,
    ...test.errors,
    ...lint.errors,
  ];

  const passed = build.passed && test.passed && lint.passed;
  const durationMs = Math.max(build.durationMs, test.durationMs, lint.durationMs);

  return { passed, errors: allErrors, durationMs };
}
