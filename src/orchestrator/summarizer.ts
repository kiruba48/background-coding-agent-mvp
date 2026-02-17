import { VerificationResult } from '../types.js';

/**
 * ErrorSummarizer transforms raw verification output (build logs, test output,
 * lint reports) into LLM-digestible summaries.
 *
 * Uses regex extraction to pull key lines — never passes raw output to the agent.
 * Target: under 500 tokens per summary section, capped at 2000 chars total.
 *
 * Source patterns: Spotify Engineering Part 3 regex extraction principle +
 * Anthropic context engineering guidance.
 */
export class ErrorSummarizer {
  /**
   * Summarize build errors from TypeScript/tsc/webpack output.
   * Input: raw compiler output (potentially thousands of lines)
   * Output: structured summary of up to 5 errors with count of remaining.
   */
  static summarizeBuildErrors(rawOutput: string): string {
    // TypeScript: "src/foo.ts(10,5): error TS2345: Argument of type..."
    const tsErrors = rawOutput.match(/\S+\.\w+\(\d+,\d+\): error TS\d+: [^\n]+/g) ?? [];

    // Generic fallback: lines containing "error" keyword
    const genericErrors = tsErrors.length === 0
      ? rawOutput.split('\n').filter(l => /\berror\b/i.test(l)).slice(0, 5)
      : [];

    const errors = tsErrors.length > 0 ? tsErrors : genericErrors;

    if (errors.length === 0) {
      return 'Build failed (no specific error lines found in output)';
    }

    const shown = errors.slice(0, 5);
    const remaining = errors.length - shown.length;
    const more = remaining > 0 ? `\n(+ ${remaining} more errors)` : '';

    return `${errors.length} build error(s):\n${shown.join('\n')}${more}`;
  }

  /**
   * Summarize test failures from Jest/Mocha/Vitest output.
   * Input: raw test runner output
   * Output: structured summary of up to 5 failures with counts.
   */
  static summarizeTestFailures(rawOutput: string): string {
    // Jest/Vitest failure lines: "  ● TestSuite > testName" or "  ✕ testName"
    const bulletFailures = rawOutput.match(/[●✕✗]\s+[^\n]+/g) ?? [];

    // Jest summary line: "Tests: 3 failed, 12 passed, 15 total"
    const summaryLine = rawOutput.match(/Tests:\s+\d+ failed[^\n]*/)?.[0] ?? '';

    // Mocha: "N failing"
    const mochaCount = rawOutput.match(/(\d+) failing/)?.[0] ?? '';

    if (bulletFailures.length === 0 && !summaryLine && !mochaCount) {
      // Last resort: lines with FAIL/FAILED keywords
      const failLines = rawOutput.split('\n').filter(l => /FAIL|FAILED|✗/.test(l)).slice(0, 5);
      return failLines.length > 0
        ? `Test failures:\n${failLines.join('\n')}`
        : 'Tests failed (unable to extract specific test names)';
    }

    const parts: string[] = [];
    if (summaryLine) parts.push(summaryLine);
    if (mochaCount) parts.push(mochaCount);

    const shownFailures = bulletFailures.slice(0, 5);
    if (shownFailures.length > 0) parts.push(shownFailures.join('\n'));

    const remaining = bulletFailures.length - shownFailures.length;
    if (remaining > 0) parts.push(`(+ ${remaining} more test failures)`);

    return parts.join('\n');
  }

  /**
   * Summarize lint errors from ESLint output.
   * Input: raw ESLint output
   * Output: structured summary of up to 5 errors with file count.
   */
  static summarizeLintErrors(rawOutput: string): string {
    // ESLint format: "  3:10  error  no-unused-vars  description"
    const errorLines = rawOutput.match(/\d+:\d+\s+error\s+[^\n]+/g) ?? [];
    const fileCount = new Set(rawOutput.match(/\S+\.(?:ts|js|tsx|jsx)/g) ?? []).size;

    if (errorLines.length === 0) {
      return 'Lint failed (unable to extract specific errors)';
    }

    const sample = errorLines.slice(0, 5).join('\n');
    const more = errorLines.length > 5 ? `\n...and ${errorLines.length - 5} more` : '';
    return `${errorLines.length} lint error(s) in ${fileCount} file(s):\n${sample}${more}`;
  }

  /**
   * Build a complete error digest from all verification results.
   * Collects summaries from all failed results into [TYPE] summary sections.
   * Hard-caps output at 2000 chars (well under 500 tokens) with truncation notice.
   */
  static buildDigest(verificationResults: VerificationResult[]): string {
    const sections: string[] = [];

    for (const result of verificationResults) {
      if (result.passed) continue;
      for (const error of result.errors) {
        sections.push(`[${error.type.toUpperCase()}] ${error.summary}`);
      }
    }

    if (sections.length === 0) {
      return '(no specific errors extracted from verification results)';
    }

    // Hard cap: stay well under 500 tokens
    const joined = sections.join('\n\n');
    if (joined.length > 2000) {
      return joined.slice(0, 2000) + '\n...(truncated, showing first 2000 chars)';
    }
    return joined;
  }
}
