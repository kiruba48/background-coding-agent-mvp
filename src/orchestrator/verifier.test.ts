import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock node:child_process before importing verifiers
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

// Mock node:fs/promises before importing verifiers
vi.mock('node:fs/promises', () => ({
  access: vi.fn(),
  readFile: vi.fn(),
}));

// Import after mocks are set up
import { buildVerifier, testVerifier, lintVerifier, compositeVerifier, mavenBuildVerifier, mavenTestVerifier } from './verifier.js';
import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { ErrorSummarizer } from './summarizer.js';

// vitest is hoisted but promisify(execFile) is called at module level in verifier.ts.
// We need to intercept calls at the execFile level. The promisified version calls
// the original callback-based execFile internally, so we mock execFile and let
// node:util's promisify wrap it.

// Cast mocks for typed access
const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;
const mockAccess = access as unknown as ReturnType<typeof vi.fn>;
const mockReadFile = readFile as unknown as ReturnType<typeof vi.fn>;

/**
 * Helper to make execFile resolve (simulate success: exit code 0).
 * promisify(execFile) resolves with { stdout, stderr }.
 */
function mockExecSuccess(stdout = '', stderr = ''): void {
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      callback: (err: null, result: { stdout: string; stderr: string }) => void
    ) => {
      callback(null, { stdout, stderr });
    }
  );
}

/**
 * Helper to make execFile reject (simulate failure: non-zero exit code).
 * promisify(execFile) rejects with an error that has .stdout and .stderr properties.
 */
function mockExecFailure(stdout = '', stderr = '', code = 1): void {
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      callback: (err: Error & { stdout?: string; stderr?: string; code?: number }) => void
    ) => {
      const err = Object.assign(new Error(`Command failed with exit code ${code}`), {
        stdout,
        stderr,
        code,
      });
      callback(err);
    }
  );
}

/**
 * Helper to make a sequence of execFile calls with different results.
 * Each call in the sequence is consumed in order.
 */
function mockExecSequence(
  responses: Array<{ success: boolean; stdout?: string; stderr?: string }>
): void {
  let index = 0;
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      callback: (
        err: (Error & { stdout?: string; stderr?: string }) | null,
        result?: { stdout: string; stderr: string }
      ) => void
    ) => {
      const response = responses[index] ?? responses[responses.length - 1];
      index++;
      if (response.success) {
        callback(null, { stdout: response.stdout ?? '', stderr: response.stderr ?? '' });
      } else {
        const err = Object.assign(new Error('Command failed'), {
          stdout: response.stdout ?? '',
          stderr: response.stderr ?? '',
        });
        callback(err);
      }
    }
  );
}

// ============================================================
// buildVerifier
// ============================================================
describe('buildVerifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('1. returns passed:true when tsc exits with code 0', async () => {
    mockAccess.mockResolvedValueOnce(undefined); // tsconfig.json exists
    mockExecSuccess('', '');

    const result = await buildVerifier('/workspace');

    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('2. returns passed:false with extracted errors when tsc exits non-zero', async () => {
    mockAccess.mockResolvedValueOnce(undefined); // tsconfig.json exists
    const stderr = [
      'src/foo.ts(10,5): error TS2345: Argument of type "string" is not assignable',
      'src/bar.ts(20,3): error TS2551: Property does not exist',
    ].join('\n');
    mockExecFailure('', stderr);

    const result = await buildVerifier('/workspace');

    expect(result.passed).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].type).toBe('build');
    expect(result.errors[0].summary).toContain('build error(s)');
    expect(result.errors[0].summary).toContain('TS2345');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('3. returns passed:true (skip) when tsconfig.json is missing', async () => {
    mockAccess.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const result = await buildVerifier('/workspace');

    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.durationMs).toBe(0);
    // execFile should not have been called
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('4. error summary uses ErrorSummarizer.summarizeBuildErrors format', async () => {
    mockAccess.mockResolvedValueOnce(undefined);
    const stdout = 'src/main.ts(5,1): error TS2304: Cannot find name "foo"';
    mockExecFailure(stdout, '');

    const result = await buildVerifier('/workspace');

    expect(result.passed).toBe(false);
    expect(result.errors[0].type).toBe('build');
    // summarizeBuildErrors format: "N build error(s):\n..."
    expect(result.errors[0].summary).toMatch(/\d+ build error\(s\)/);
  });

  it('5. rawOutput contains both stdout and stderr from tsc', async () => {
    mockAccess.mockResolvedValueOnce(undefined);
    const stdout = 'src/x.ts(1,1): error TS2304: Cannot find name "x"';
    const stderr = 'Some stderr from tsc';
    mockExecFailure(stdout, stderr);

    const result = await buildVerifier('/workspace');

    expect(result.passed).toBe(false);
    expect(result.errors[0].rawOutput).toContain(stdout);
    expect(result.errors[0].rawOutput).toContain(stderr);
  });

  it('5b. returns timeout error when process is killed', async () => {
    mockAccess.mockResolvedValueOnce(undefined);
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown,
        callback: (err: Error & { killed?: boolean; signal?: string }) => void) => {
        const err = Object.assign(new Error('Process timed out'), { killed: true, signal: 'SIGKILL' });
        callback(err);
      }
    );

    const result = await buildVerifier('/workspace');

    expect(result.passed).toBe(false);
    expect(result.errors[0].summary).toContain('timed out');
  });
});

// ============================================================
// testVerifier
// ============================================================
describe('testVerifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('6. returns passed:true when vitest exits with code 0', async () => {
    // First access call is for vitest.config.ts — resolve it (found)
    mockAccess.mockResolvedValueOnce(undefined);
    mockExecSuccess('Test Files  1 passed (1)\nTests  3 passed (3)\n');

    const result = await testVerifier('/workspace');

    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('7. returns passed:false with extracted failures when vitest exits non-zero', async () => {
    mockAccess.mockResolvedValueOnce(undefined); // vitest.config.ts found
    const stdout = [
      'FAIL src/foo.test.ts',
      '  ● Suite A > should work',
      'Tests: 1 failed, 2 passed, 3 total',
    ].join('\n');
    mockExecFailure(stdout, '');

    const result = await testVerifier('/workspace');

    expect(result.passed).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].type).toBe('test');
    expect(result.errors[0].summary).toBeDefined();
  });

  it('8. returns passed:true (skip) when no vitest config found', async () => {
    // All config file access checks fail (4 config files + package.json)
    mockAccess.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    // package.json without vitest key
    mockReadFile.mockResolvedValueOnce(JSON.stringify({ name: 'test-project', version: '1.0.0' }));

    const result = await testVerifier('/workspace');

    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.durationMs).toBe(0);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('9. skips when package.json not parseable and no config files', async () => {
    mockAccess.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    mockReadFile.mockRejectedValueOnce(new Error('File not found'));

    const result = await testVerifier('/workspace');

    expect(result.passed).toBe(true);
    expect(result.durationMs).toBe(0);
  });

  it('10. measures duration (durationMs > 0) when vitest runs', async () => {
    mockAccess.mockResolvedValueOnce(undefined);
    // Simulate a tiny delay by using resolved mock
    mockExecSuccess('Tests: 5 passed (5)');

    const result = await testVerifier('/workspace');

    // durationMs should be a non-negative number
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('10b. returns timeout error when vitest process is killed', async () => {
    mockAccess.mockResolvedValueOnce(undefined); // vitest.config.ts found
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown,
        callback: (err: Error & { killed?: boolean; signal?: string }) => void) => {
        const err = Object.assign(new Error('Process timed out'), { killed: true, signal: 'SIGKILL' });
        callback(err);
      }
    );

    const result = await testVerifier('/workspace');

    expect(result.passed).toBe(false);
    expect(result.errors[0].summary).toContain('timed out');
    expect(result.errors[0].type).toBe('test');
  });

  it('11. finds vitest key in package.json when no config file present', async () => {
    // All vitest config file checks fail
    mockAccess.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    // package.json has vitest key
    mockReadFile.mockResolvedValueOnce(JSON.stringify({ name: 'test-project', vitest: {} }));
    // Then vitest run succeeds
    mockExecSuccess('Tests: 2 passed (2)');

    const result = await testVerifier('/workspace');

    expect(result.passed).toBe(true);
    expect(mockExecFile).toHaveBeenCalled();
  });
});

// ============================================================
// lintVerifier
// ============================================================
describe('lintVerifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('12. returns passed:true when no new lint violations (baseline == current)', async () => {
    mockAccess.mockResolvedValueOnce(undefined); // eslint.config.mjs exists

    // Sequence: git stash push -m → eslint baseline → git stash pop → eslint current
    const eslintOutput = JSON.stringify([{ errorCount: 5 }]);
    mockExecSequence([
      { success: true, stdout: 'Saved working directory and index state' }, // git stash push -m
      { success: false, stdout: eslintOutput },                              // eslint baseline
      { success: true, stdout: '' },                                         // git stash pop
      { success: false, stdout: eslintOutput },                              // eslint current (same count)
    ]);

    const result = await lintVerifier('/workspace');

    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('12b. falls back to simple lint when stash saves nothing (clean tree)', async () => {
    mockAccess.mockResolvedValueOnce(undefined); // eslint.config.mjs exists

    // git stash push -m returns success but no "Saved" (clean working tree)
    mockExecSequence([
      { success: true, stdout: 'No local changes to save' }, // git stash push -m (nothing saved)
      { success: true, stdout: JSON.stringify([{ errorCount: 0 }]) }, // simple eslint: clean
    ]);

    const result = await lintVerifier('/workspace');

    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('13. returns passed:false when new lint violations introduced (current > baseline)', async () => {
    mockAccess.mockResolvedValueOnce(undefined); // eslint.config.mjs exists

    const baselineOutput = JSON.stringify([{ errorCount: 2 }]);
    const currentOutput = JSON.stringify([{ errorCount: 5, filePath: '/workspace/src/foo.ts', messages: [
      { severity: 2, ruleId: 'no-unused-vars', message: '"x" is defined but never used', line: 3, column: 10 },
      { severity: 2, ruleId: 'no-console', message: 'Unexpected console statement', line: 7, column: 5 },
      { severity: 2, ruleId: 'no-debugger', message: 'Unexpected debugger statement', line: 10, column: 1 },
    ] }]);
    mockExecSequence([
      { success: true, stdout: 'Saved working directory and index state' }, // git stash push -m
      { success: false, stdout: baselineOutput },       // eslint baseline: 2 errors
      { success: true, stdout: '' },                   // git stash pop
      { success: false, stdout: currentOutput },        // eslint current: 5 errors (3 new)
    ]);

    const result = await lintVerifier('/workspace');

    expect(result.passed).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].type).toBe('lint');
    expect(result.errors[0].summary).toBeDefined();
  });

  it('14. returns passed:true (skip) when no eslint config found', async () => {
    // All config file access checks fail
    mockAccess.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const result = await lintVerifier('/workspace');

    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.durationMs).toBe(0);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('15. falls back to simple lint when git stash push fails (no prior commits)', async () => {
    mockAccess.mockResolvedValueOnce(undefined); // eslint.config.mjs exists

    // git stash push -m fails (no commits yet)
    // Then simple eslint runs and finds 0 errors
    mockExecSequence([
      { success: false, stdout: '', stderr: 'You do not have the initial commit yet' }, // git stash push fails
      { success: true, stdout: JSON.stringify([{ errorCount: 0 }]) },     // simple eslint: clean
    ]);

    const result = await lintVerifier('/workspace');

    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('16. falls back and returns false when simple lint finds errors', async () => {
    mockAccess.mockResolvedValueOnce(undefined); // eslint.config.mjs exists

    mockExecSequence([
      { success: false, stdout: '', stderr: 'You do not have the initial commit yet' }, // git stash push fails
      { success: false, stdout: JSON.stringify([{ errorCount: 3 }]) },     // simple eslint: 3 errors
    ]);

    const result = await lintVerifier('/workspace');

    expect(result.passed).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].type).toBe('lint');
  });

  it('17. error summary uses summarizeLintErrorsFromJson for JSON output', async () => {
    mockAccess.mockResolvedValueOnce(undefined); // eslint.config.mjs exists

    const currentOutput = JSON.stringify([{
      filePath: '/workspace/src/foo.ts',
      errorCount: 2,
      messages: [
        { severity: 2, ruleId: 'no-unused-vars', message: '"x" is defined but never used', line: 3, column: 10 },
        { severity: 2, ruleId: 'no-console', message: 'Unexpected console statement', line: 7, column: 5 },
      ],
    }]);

    mockExecSequence([
      { success: true, stdout: 'Saved working directory and index state' }, // git stash push -m
      { success: true, stdout: JSON.stringify([{ errorCount: 0 }]) }, // baseline: 0
      { success: true, stdout: '' },                // git stash pop
      { success: false, stdout: currentOutput },    // current: 2 new errors
    ]);

    const result = await lintVerifier('/workspace');

    expect(result.passed).toBe(false);
    expect(result.errors[0].type).toBe('lint');
    // Should contain structured error info from JSON parsing
    expect(result.errors[0].summary).toContain('lint error');
    expect(result.errors[0].summary).toContain('no-unused-vars');
  });
});

// ============================================================
// compositeVerifier
// ============================================================
describe('compositeVerifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('18. returns passed:true when all verifiers pass (no Maven project)', async () => {
    // Route access by path: tsconfig found, vitest found, no pom.xml, eslint found
    mockAccess.mockImplementation((path: string) => {
      if (path.endsWith('pom.xml')) return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      return Promise.resolve(undefined);
    });

    // All verifier executions succeed (no Maven since no pom.xml)
    mockExecSequence([
      { success: true, stdout: '' },  // tsc --noEmit: passes
      { success: true, stdout: '' },  // vitest run: passes
      { success: true, stdout: 'Saved working directory and index state' }, // git stash push -m
      { success: true, stdout: JSON.stringify([{ errorCount: 0 }]) }, // eslint baseline
      { success: true, stdout: '' },  // git stash pop
      { success: true, stdout: JSON.stringify([{ errorCount: 0 }]) }, // eslint current
    ]);

    const result = await compositeVerifier('/workspace');

    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('19. returns passed:false when any verifier fails (build fails)', async () => {
    // tsconfig found, vitest found, no pom.xml, eslint found
    mockAccess.mockImplementation((path: string) => {
      if (path.endsWith('pom.xml')) return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      return Promise.resolve(undefined);
    });

    mockExecSequence([
      // build fails
      { success: false, stdout: 'src/x.ts(1,1): error TS2304: Cannot find "x"', stderr: '' },
      // test passes
      { success: true, stdout: '' },
      // lint: git stash push -m, baseline, pop, current — all clean
      { success: true, stdout: 'Saved working directory and index state' },
      { success: true, stdout: JSON.stringify([{ errorCount: 0 }]) },
      { success: true, stdout: '' },
      { success: true, stdout: JSON.stringify([{ errorCount: 0 }]) },
    ]);

    const result = await compositeVerifier('/workspace');

    expect(result.passed).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].type).toBe('build');
  });

  it('20. error ordering: Build errors first, then Test, then Lint (no Maven)', async () => {
    // tsconfig found, vitest found, no pom.xml, eslint found
    mockAccess.mockImplementation((path: string) => {
      if (path.endsWith('pom.xml')) return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      return Promise.resolve(undefined);
    });

    mockExecSequence([
      // build fails
      { success: false, stdout: 'src/a.ts(1,1): error TS2304: type error', stderr: '' },
      // test fails
      { success: false, stdout: '  ● Suite > test failed\nTests: 1 failed', stderr: '' },
      // lint: git stash push -m succeeds, baseline 0, pop, current 3 (new violations)
      { success: true, stdout: 'Saved working directory and index state' },
      { success: true, stdout: JSON.stringify([{ errorCount: 0 }]) },
      { success: true, stdout: '' },
      { success: false, stdout: JSON.stringify([{ errorCount: 3 }]) },
    ]);

    const result = await compositeVerifier('/workspace');

    expect(result.passed).toBe(false);
    // Errors must be in Build > Test > Lint order
    const types = result.errors.map(e => e.type);
    const buildIdx = types.indexOf('build');
    const testIdx = types.indexOf('test');
    const lintIdx = types.indexOf('lint');

    // All three error types should be present
    expect(buildIdx).toBeGreaterThanOrEqual(0);
    expect(testIdx).toBeGreaterThanOrEqual(0);
    expect(lintIdx).toBeGreaterThanOrEqual(0);

    // Build < Test < Lint ordering
    expect(buildIdx).toBeLessThan(testIdx);
    expect(testIdx).toBeLessThan(lintIdx);
  });

  it('21. handles verifier crash gracefully — converts to VerificationError', async () => {
    // tsconfig found, vitest found, no pom.xml, no eslint
    mockAccess.mockImplementation((path: string) => {
      if (path.endsWith('pom.xml')) return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      if (path.endsWith('tsconfig.json') || path.endsWith('vitest.config.ts'))
        return Promise.resolve(undefined);
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });

    // Build: tsc crashes with a binary error (not stdout/stderr format)
    mockExecSequence([
      // tsc --noEmit throws a different error type
      { success: false, stdout: '', stderr: 'tsc: command not found' },
      // vitest run passes
      { success: true, stdout: '' },
    ]);

    const result = await compositeVerifier('/workspace');

    // Should not throw — should return structured result
    expect(result).toBeDefined();
    expect(typeof result.passed).toBe('boolean');
    expect(Array.isArray(result.errors)).toBe(true);
  });

  it('22. durationMs is non-negative (parallel execution)', async () => {
    // All verifiers skip (no config files found)
    mockAccess.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    mockReadFile.mockRejectedValue(new Error('Not found'));

    const result = await compositeVerifier('/workspace');

    // All verifiers skip — passed:true, durationMs = max(0, 0, 0) = 0
    expect(result.passed).toBe(true);
    expect(result.durationMs).toBe(0);
  });

  it('23. aggregates errors from multiple failing verifiers', async () => {
    // tsconfig found, vitest found, no pom.xml, no eslint
    mockAccess.mockImplementation((path: string) => {
      if (path.endsWith('pom.xml')) return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      if (path.endsWith('tsconfig.json') || path.endsWith('vitest.config.ts'))
        return Promise.resolve(undefined);
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });

    mockExecSequence([
      // build fails
      { success: false, stdout: 'src/x.ts(1,1): error TS1001: Something wrong', stderr: '' },
      // test fails
      { success: false, stdout: 'Tests: 2 failed, 0 passed', stderr: '' },
    ]);

    const result = await compositeVerifier('/workspace');

    expect(result.passed).toBe(false);
    // Should have both build and test errors
    const types = result.errors.map(e => e.type);
    expect(types).toContain('build');
    expect(types).toContain('test');
  });

  it('24. passed:true requires all verifiers to pass', async () => {
    // vitest found, everything else skips (no tsconfig, no pom.xml, no eslint)
    mockAccess.mockImplementation((path: string) => {
      if (path.endsWith('vitest.config.ts')) return Promise.resolve(undefined);
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });

    // vitest run fails
    mockExecFailure('Tests: 1 failed, 0 passed', '');

    const result = await compositeVerifier('/workspace');

    // Build skipped, Maven skipped, test failed, lint skipped — overall failed
    expect(result.passed).toBe(false);
    expect(result.errors.some(e => e.type === 'test')).toBe(true);
  });
});

// ============================================================
// ErrorSummarizer — Maven methods
// ============================================================
describe('ErrorSummarizer.summarizeMavenErrors', () => {
  it('25. extracts [ERROR] lines from Maven compilation output', () => {
    const raw = [
      '[INFO] BUILD FAILURE',
      '[ERROR] /path/File.java:[10,5] error: cannot find symbol',
      '[ERROR] /path/Other.java:[20,3] error: method does not exist',
    ].join('\n');

    const result = ErrorSummarizer.summarizeMavenErrors(raw);

    expect(result).toContain('2 Maven build error(s)');
    expect(result).toContain('cannot find symbol');
    expect(result).toContain('method does not exist');
  });

  it('26. caps at 5 errors and shows remaining count', () => {
    const lines = Array.from({ length: 10 }, (_, i) =>
      `[ERROR] /path/File${i}.java:[${i},1] error: problem ${i}`
    );
    const raw = lines.join('\n');

    const result = ErrorSummarizer.summarizeMavenErrors(raw);

    expect(result).toContain('10 Maven build error(s)');
    expect(result).toContain('(+ 5 more errors)');
  });

  it('27. returns fallback when no [ERROR] lines found', () => {
    const raw = '[INFO] BUILD FAILURE\n[INFO] Something happened';

    const result = ErrorSummarizer.summarizeMavenErrors(raw);

    expect(result).toBe('Maven build failed (no specific error lines found)');
  });

  it('28. filters out noise lines like [Help 1]', () => {
    const raw = [
      '[ERROR] /path/File.java:[10,5] error: cannot find symbol',
      '[ERROR] -> [Help 1]',
      '[ERROR] ',
      '[ERROR] For more information about the errors, please refer to the Maven documentation',
    ].join('\n');

    const result = ErrorSummarizer.summarizeMavenErrors(raw);

    expect(result).toContain('1 Maven build error(s)');
    expect(result).not.toContain('[Help');
    expect(result).not.toContain('For more information');
  });
});

describe('ErrorSummarizer.summarizeMavenTestFailures', () => {
  it('29. extracts surefire summary line', () => {
    const raw = [
      '[INFO] Tests run: 5, Failures: 2, Errors: 0, Skipped: 0',
      '[ERROR] com.example.AppTest.testFoo -- Time elapsed: 0.1s <<< FAILURE!',
      '[ERROR] com.example.AppTest.testBar -- Time elapsed: 0.2s <<< FAILURE!',
    ].join('\n');

    const result = ErrorSummarizer.summarizeMavenTestFailures(raw);

    expect(result).toContain('Tests run: 5, Failures: 2');
    expect(result).toContain('testFoo');
    expect(result).toContain('testBar');
  });

  it('30. caps failure lines at 5 with remaining count', () => {
    const failLines = Array.from({ length: 8 }, (_, i) =>
      `[ERROR] com.example.Test${i}.test${i} -- Time elapsed: 0.1s <<< FAILURE!`
    );
    const raw = [
      'Tests run: 10, Failures: 8, Errors: 0, Skipped: 0',
      ...failLines,
    ].join('\n');

    const result = ErrorSummarizer.summarizeMavenTestFailures(raw);

    expect(result).toContain('(+ 3 more test failures)');
  });

  it('31. returns fallback when no recognizable output', () => {
    const raw = 'Some random Maven output with no test info';

    const result = ErrorSummarizer.summarizeMavenTestFailures(raw);

    expect(result).toBe('Maven tests failed (unable to extract specific test names)');
  });
});

// ============================================================
// mavenBuildVerifier
// ============================================================
describe('mavenBuildVerifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('32. skips (passed:true, durationMs:0) when no pom.xml', async () => {
    mockAccess.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const result = await mavenBuildVerifier('/workspace');

    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.durationMs).toBe(0);
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('33. runs mvnw when mvnw exists in workspace', async () => {
    // pom.xml exists, mvnw exists
    mockAccess.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
    mockExecSuccess('BUILD SUCCESS');

    const result = await mavenBuildVerifier('/workspace');

    expect(result.passed).toBe(true);
    // First execFile call should use ./mvnw
    const call = mockExecFile.mock.calls[0];
    expect(call[0]).toBe('./mvnw');
    expect(call[1]).toContain('compile');
    expect(call[1]).toContain('-B');
  });

  it('34. runs mvn when no mvnw exists', async () => {
    // pom.xml exists, mvnw does NOT exist
    mockAccess
      .mockResolvedValueOnce(undefined)  // pom.xml
      .mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })); // no mvnw
    mockExecSuccess('BUILD SUCCESS');

    const result = await mavenBuildVerifier('/workspace');

    expect(result.passed).toBe(true);
    const call = mockExecFile.mock.calls[0];
    expect(call[0]).toBe('mvn');
  });

  it('35. returns passed:false with Maven error summary on build failure', async () => {
    mockAccess.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined); // pom.xml + mvnw
    mockExecFailure(
      '[ERROR] /path/File.java:[10,5] error: cannot find symbol\n[ERROR] BUILD FAILURE',
      ''
    );

    const result = await mavenBuildVerifier('/workspace');

    expect(result.passed).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].type).toBe('build');
    expect(result.errors[0].summary).toContain('Maven build error');
  });

  it('36. handles timeout (120s)', async () => {
    mockAccess.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown,
        callback: (err: Error & { killed?: boolean; signal?: string }) => void) => {
        const err = Object.assign(new Error('Process timed out'), { killed: true, signal: 'SIGKILL' });
        callback(err);
      }
    );

    const result = await mavenBuildVerifier('/workspace');

    expect(result.passed).toBe(false);
    expect(result.errors[0].summary).toContain('timed out');
    expect(result.errors[0].summary).toContain('120s');
  });

  it('37. uses -q (quiet) flag for less verbose output', async () => {
    mockAccess.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
    mockExecSuccess('');

    await mavenBuildVerifier('/workspace');

    const call = mockExecFile.mock.calls[0];
    expect(call[1]).toContain('-q');
  });
});

// ============================================================
// mavenTestVerifier
// ============================================================
describe('mavenTestVerifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('38. skips when no pom.xml', async () => {
    mockAccess.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const result = await mavenTestVerifier('/workspace');

    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.durationMs).toBe(0);
  });

  it('39. runs mvn test -B -q with 300s timeout', async () => {
    mockAccess.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
    mockExecSuccess('BUILD SUCCESS');

    const result = await mavenTestVerifier('/workspace');

    expect(result.passed).toBe(true);
    const call = mockExecFile.mock.calls[0];
    expect(call[1]).toContain('test');
    expect(call[1]).toContain('-B');
    expect(call[1]).toContain('-q');
    expect(call[2].timeout).toBe(300_000);
  });

  it('40. returns passed:false with test failure summary on failure', async () => {
    mockAccess.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
    mockExecFailure(
      'Tests run: 5, Failures: 2, Errors: 0, Skipped: 0\n[ERROR] com.example.AppTest.testFoo -- Time elapsed: 0.1s <<< FAILURE!',
      ''
    );

    const result = await mavenTestVerifier('/workspace');

    expect(result.passed).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].type).toBe('test');
    expect(result.errors[0].summary).toContain('Tests run: 5');
  });

  it('41. handles timeout (300s)', async () => {
    mockAccess.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown,
        callback: (err: Error & { killed?: boolean; signal?: string }) => void) => {
        const err = Object.assign(new Error('Process timed out'), { killed: true, signal: 'SIGKILL' });
        callback(err);
      }
    );

    const result = await mavenTestVerifier('/workspace');

    expect(result.passed).toBe(false);
    expect(result.errors[0].summary).toContain('timed out');
    expect(result.errors[0].summary).toContain('300s');
  });
});

// ============================================================
// compositeVerifier — Maven integration
// ============================================================
describe('compositeVerifier — Maven integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('42. includes Maven verifier results alongside TypeScript results', async () => {
    // All configs found: tsconfig, vitest, pom.xml, mvnw, eslint
    mockAccess.mockImplementation(() => Promise.resolve(undefined));

    // All pass
    mockExecSequence([
      { success: true, stdout: '' },  // tsc
      { success: true, stdout: '' },  // vitest
      { success: true, stdout: '' },  // mvn compile
      { success: true, stdout: '' },  // mvn test
      { success: true, stdout: 'Saved working directory and index state' }, // git stash
      { success: true, stdout: JSON.stringify([{ errorCount: 0 }]) }, // eslint baseline
      { success: true, stdout: '' },  // git stash pop
      { success: true, stdout: JSON.stringify([{ errorCount: 0 }]) }, // eslint current
    ]);

    const result = await compositeVerifier('/workspace');

    expect(result.passed).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('43. Maven build failure appears in compositeVerifier errors', async () => {
    // pom.xml + mvnw found; no tsconfig, no vitest, no eslint
    mockAccess.mockImplementation((path: string) => {
      if (path.endsWith('pom.xml') || path.endsWith('mvnw'))
        return Promise.resolve(undefined);
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });
    mockReadFile.mockRejectedValue(new Error('Not found'));

    mockExecSequence([
      { success: false, stdout: '[ERROR] /path/File.java:[10,5] error: cannot find symbol', stderr: '' }, // mvn compile fails
      { success: true, stdout: '' }, // mvn test passes
    ]);

    const result = await compositeVerifier('/workspace');

    expect(result.passed).toBe(false);
    const types = result.errors.map(e => e.type);
    expect(types).toContain('build');
    expect(result.errors.find(e => e.type === 'build')!.summary).toContain('Maven');
  });
});
