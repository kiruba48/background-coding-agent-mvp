import { describe, it, expect } from 'vitest';
import { ErrorSummarizer } from './summarizer.js';
import type { VerificationResult } from '../types.js';

describe('ErrorSummarizer', () => {

  // ============================================================
  // summarizeBuildErrors
  // ============================================================
  describe('summarizeBuildErrors', () => {
    it('extracts TypeScript error lines', () => {
      const input = [
        'src/foo.ts(10,5): error TS2345: Argument of type',
        'src/bar.ts(20,3): error TS2551: Property does not exist',
        'Build failed with 2 errors.',
      ].join('\n');

      const result = ErrorSummarizer.summarizeBuildErrors(input);

      expect(result).toContain('2 build error(s)');
      expect(result).toContain('src/foo.ts(10,5): error TS2345');
      expect(result).toContain('src/bar.ts(20,3): error TS2551');
    });

    it('falls back to generic error lines when no TS errors', () => {
      const input = [
        'Some info line',
        'ERROR: Could not find module foo',
        'Another error: configuration missing',
        'Build done.',
      ].join('\n');

      const result = ErrorSummarizer.summarizeBuildErrors(input);

      expect(result).toContain('build error(s)');
      expect(result).toContain('ERROR: Could not find module foo');
    });

    it('returns fallback message when no error lines found', () => {
      const input = 'Build succeeded. Nothing went wrong.';

      const result = ErrorSummarizer.summarizeBuildErrors(input);

      expect(result).toBe('Build failed (no specific error lines found in output)');
    });

    it('caps at 5 errors with a more indicator', () => {
      const lines: string[] = [];
      for (let i = 1; i <= 8; i++) {
        lines.push(`src/file${i}.ts(${i},1): error TS${2000 + i}: Some error ${i}`);
      }
      const input = lines.join('\n');

      const result = ErrorSummarizer.summarizeBuildErrors(input);

      expect(result).toContain('8 build error(s)');
      expect(result).toContain('(+ 3 more errors)');
      // Should only include 5 errors in output
      expect(result).toContain('src/file1.ts');
      expect(result).toContain('src/file5.ts');
      expect(result).not.toContain('src/file6.ts');
    });

    it('handles multi-line input with many TypeScript errors', () => {
      const input = [
        'Starting compilation...',
        'src/a.ts(1,1): error TS1001: First error',
        'Some output between errors',
        'src/b.ts(2,2): error TS1002: Second error',
        'src/c.ts(3,3): error TS1003: Third error',
        'Compilation complete.',
      ].join('\n');

      const result = ErrorSummarizer.summarizeBuildErrors(input);

      expect(result).toContain('3 build error(s)');
      expect(result).toContain('src/a.ts(1,1)');
      expect(result).toContain('src/b.ts(2,2)');
      expect(result).toContain('src/c.ts(3,3)');
    });
  });

  // ============================================================
  // summarizeTestFailures
  // ============================================================
  describe('summarizeTestFailures', () => {
    it('extracts Jest bullet failures', () => {
      const input = [
        'FAIL src/foo.test.ts',
        '  ● Suite A > should work correctly',
        '  ● Suite B > another failing test',
        '',
        'Tests: 2 failed, 5 passed, 7 total',
      ].join('\n');

      const result = ErrorSummarizer.summarizeTestFailures(input);

      expect(result).toContain('Suite A > should work correctly');
      expect(result).toContain('Suite B > another failing test');
    });

    it('extracts Jest summary line', () => {
      const input = [
        'Tests: 3 failed, 12 passed, 15 total',
        'Test Suites: 1 failed, 3 passed, 4 total',
      ].join('\n');

      const result = ErrorSummarizer.summarizeTestFailures(input);

      expect(result).toContain('Tests: 3 failed, 12 passed');
    });

    it('extracts Mocha format failure count', () => {
      const input = [
        '  passing: 10',
        '  3 failing',
        '',
        '  1) Suite name test name:',
      ].join('\n');

      const result = ErrorSummarizer.summarizeTestFailures(input);

      expect(result).toContain('3 failing');
    });

    it('falls back to FAIL/FAILED lines when no structured format found', () => {
      const input = [
        'FAIL: test_foo',
        'FAILED: test_bar',
        'Something else happened',
      ].join('\n');

      const result = ErrorSummarizer.summarizeTestFailures(input);

      expect(result).toContain('FAIL: test_foo');
      expect(result).toContain('FAILED: test_bar');
    });

    it('returns fallback message when no recognizable format', () => {
      const input = 'Test suite ran but nobody knows what happened.';

      const result = ErrorSummarizer.summarizeTestFailures(input);

      expect(result).toBe('Tests failed (unable to extract specific test names)');
    });

    it('caps bullet failures at 5', () => {
      const failures: string[] = [];
      for (let i = 1; i <= 7; i++) {
        failures.push(`  ● Suite > test case ${i}`);
      }
      const input = failures.join('\n');

      const result = ErrorSummarizer.summarizeTestFailures(input);

      expect(result).toContain('(+ 2 more test failures)');
      expect(result).toContain('test case 1');
      expect(result).toContain('test case 5');
      expect(result).not.toContain('test case 6');
    });
  });

  // ============================================================
  // summarizeLintErrors
  // ============================================================
  describe('summarizeLintErrors', () => {
    it('extracts ESLint format errors', () => {
      const input = [
        '/path/to/src/foo.ts',
        '  3:10  error  no-unused-vars  "x" is defined but never used',
        '  7:5   error  no-console  Unexpected console statement',
        '',
        '/path/to/src/bar.ts',
        '  1:1   error  eol-last  Newline required at end of file',
      ].join('\n');

      const result = ErrorSummarizer.summarizeLintErrors(input);

      expect(result).toContain('3 lint error(s)');
      expect(result).toContain('no-unused-vars');
      expect(result).toContain('no-console');
      expect(result).toContain('eol-last');
    });

    it('tracks file count from filenames', () => {
      const input = [
        '/path/src/foo.ts',
        '  1:1  error  rule-one  First error',
        '/path/src/bar.ts',
        '  2:2  error  rule-two  Second error',
      ].join('\n');

      const result = ErrorSummarizer.summarizeLintErrors(input);

      expect(result).toContain('2 file(s)');
    });

    it('caps output at 5 errors with more indicator', () => {
      const lines: string[] = ['/path/src/foo.ts'];
      for (let i = 1; i <= 8; i++) {
        lines.push(`  ${i}:1  error  rule-${i}  Error ${i}`);
      }
      const input = lines.join('\n');

      const result = ErrorSummarizer.summarizeLintErrors(input);

      expect(result).toContain('8 lint error(s)');
      expect(result).toContain('...and 3 more');
      expect(result).toContain('rule-1');
      expect(result).toContain('rule-5');
      expect(result).not.toContain('rule-6');
    });

    it('returns fallback message when no errors found', () => {
      const input = 'No lint errors found.';

      const result = ErrorSummarizer.summarizeLintErrors(input);

      expect(result).toBe('Lint failed (unable to extract specific errors)');
    });
  });

  // ============================================================
  // buildDigest
  // ============================================================
  describe('buildDigest', () => {
    it('formats a single failed result as [TYPE] summary', () => {
      const results: VerificationResult[] = [
        {
          passed: false,
          errors: [{ type: 'build', summary: 'TypeScript compile failed: 2 errors' }],
          durationMs: 100,
        },
      ];

      const result = ErrorSummarizer.buildDigest(results);

      expect(result).toContain('[BUILD] TypeScript compile failed: 2 errors');
    });

    it('includes all errors from multiple failed results', () => {
      const results: VerificationResult[] = [
        {
          passed: false,
          errors: [
            { type: 'build', summary: 'Build failed' },
            { type: 'test', summary: 'Tests failed' },
          ],
          durationMs: 100,
        },
        {
          passed: false,
          errors: [{ type: 'lint', summary: 'Lint errors found' }],
          durationMs: 50,
        },
      ];

      const result = ErrorSummarizer.buildDigest(results);

      expect(result).toContain('[BUILD] Build failed');
      expect(result).toContain('[TEST] Tests failed');
      expect(result).toContain('[LINT] Lint errors found');
    });

    it('skips passed results', () => {
      const results: VerificationResult[] = [
        {
          passed: true,
          errors: [],
          durationMs: 100,
        },
        {
          passed: false,
          errors: [{ type: 'test', summary: 'One test failed' }],
          durationMs: 50,
        },
      ];

      const result = ErrorSummarizer.buildDigest(results);

      expect(result).not.toContain('passed');
      expect(result).toContain('[TEST] One test failed');
    });

    it('truncates output at 2000 chars with truncation notice', () => {
      // Create a long summary that exceeds 2000 chars
      const longSummary = 'x'.repeat(600);
      const results: VerificationResult[] = [
        {
          passed: false,
          errors: [
            { type: 'build', summary: longSummary },
            { type: 'test', summary: longSummary },
            { type: 'lint', summary: longSummary },
            { type: 'custom', summary: longSummary },
          ],
          durationMs: 100,
        },
      ];

      const result = ErrorSummarizer.buildDigest(results);

      expect(result.length).toBeLessThanOrEqual(2000 + 50); // allow for truncation notice
      expect(result).toContain('...(truncated, showing first 2000 chars)');
    });

    it('returns empty string indicator for empty input', () => {
      const result = ErrorSummarizer.buildDigest([]);

      expect(result).toBe('(no specific errors extracted from verification results)');
    });

    it('returns empty string indicator when all results passed', () => {
      const results: VerificationResult[] = [
        { passed: true, errors: [], durationMs: 10 },
        { passed: true, errors: [], durationMs: 20 },
      ];

      const result = ErrorSummarizer.buildDigest(results);

      expect(result).toBe('(no specific errors extracted from verification results)');
    });
  });
});
