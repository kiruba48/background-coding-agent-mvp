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
    // Jest/Vitest failure lines: "  ● TestSuite > testName", "  ✕ testName", or "  × testName"
    const bulletFailures = rawOutput.match(/[●✕✗×]\s+[^\n]+/g) ?? [];

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
    // Match ESLint file header lines (paths without leading whitespace), not filenames inside errors
    const fileHeaders = rawOutput.match(/^\/?\S+\.(?:ts|js|tsx|jsx|mts|mjs|cts|cjs)$/gm) ?? [];
    const fileCount = new Set(fileHeaders).size;

    if (errorLines.length === 0) {
      return 'Lint failed (unable to extract specific errors)';
    }

    const sample = errorLines.slice(0, 5).join('\n');
    const more = errorLines.length > 5 ? `\n...and ${errorLines.length - 5} more` : '';
    return `${errorLines.length} lint error(s) in ${fileCount} file(s):\n${sample}${more}`;
  }

  /**
   * Summarize lint errors from ESLint JSON output (--format json).
   * Parses the JSON array to extract file paths, line numbers, and rule IDs.
   * Falls back to text-based summarizeLintErrors if JSON parsing fails.
   */
  static summarizeLintErrorsFromJson(rawJsonOutput: string): string {
    try {
      const parsed = JSON.parse(rawJsonOutput) as Array<{
        filePath: string;
        errorCount: number;
        messages: Array<{ severity: number; ruleId: string | null; message: string; line: number; column: number }>;
      }>;
      const filesWithErrors = parsed.filter(f => f.errorCount > 0);
      const fileCount = filesWithErrors.length;
      const totalErrors = filesWithErrors.reduce((sum, f) => sum + f.errorCount, 0);

      const errorLines: string[] = [];
      for (const file of filesWithErrors) {
        for (const msg of file.messages) {
          if (msg.severity === 2) { // errors only (severity 2)
            errorLines.push(`  ${msg.line}:${msg.column}  error  ${msg.ruleId ?? 'unknown'}  ${msg.message}`);
          }
        }
      }

      if (errorLines.length === 0) {
        return 'Lint failed (unable to extract specific errors from JSON)';
      }

      const sample = errorLines.slice(0, 5).join('\n');
      const more = errorLines.length > 5 ? `\n...and ${errorLines.length - 5} more` : '';
      return `${totalErrors} lint error(s) in ${fileCount} file(s):\n${sample}${more}`;
    } catch {
      // JSON parse failed — fall back to text-based parsing
      return ErrorSummarizer.summarizeLintErrors(rawJsonOutput);
    }
  }

  /**
   * Summarize build errors from Maven compilation output.
   * Input: raw Maven output with [ERROR] prefixed lines
   * Output: structured summary of up to 5 errors with count of remaining.
   */
  static summarizeMavenErrors(rawOutput: string): string {
    const errorLines = rawOutput
      .split('\n')
      .filter(line => line.startsWith('[ERROR]'))
      .filter(line => !line.includes('[Help'))
      .filter(line => !line.includes('For more information'))
      .filter(line => line.trim().length > '[ERROR]'.length + 1);

    if (errorLines.length === 0) {
      return 'Maven build failed (no specific error lines found)';
    }

    const shown = errorLines.slice(0, 5);
    const remaining = errorLines.length - shown.length;
    const more = remaining > 0 ? `\n(+ ${remaining} more errors)` : '';

    return `${errorLines.length} Maven build error(s):\n${shown.join('\n')}${more}`;
  }

  /**
   * Summarize test failures from Maven surefire output.
   * Input: raw Maven test output
   * Output: structured summary with surefire summary line and up to 5 failure names.
   */
  static summarizeMavenTestFailures(rawOutput: string): string {
    // Surefire summary: "Tests run: N, Failures: N, Errors: N, Skipped: N"
    const summaryLine = rawOutput.match(/Tests run: \d+, Failures: \d+[^\n]*/)?.[0] ?? '';

    // Test failure lines: "[ERROR] com.example.Test.method -- Time elapsed..."
    const failureLines = rawOutput
      .split('\n')
      .filter(line => line.startsWith('[ERROR]') && /<<<\s*(FAILURE|ERROR)/.test(line));

    if (!summaryLine && failureLines.length === 0) {
      return 'Maven tests failed (unable to extract specific test names)';
    }

    const parts: string[] = [];
    if (summaryLine) parts.push(summaryLine);

    const shownFailures = failureLines.slice(0, 5);
    if (shownFailures.length > 0) parts.push(shownFailures.join('\n'));

    const remaining = failureLines.length - shownFailures.length;
    if (remaining > 0) parts.push(`(+ ${remaining} more test failures)`);

    return parts.join('\n');
  }

  /**
   * Summarize build errors from npm run build output.
   * Input: raw npm build output (potentially thousands of lines)
   * Output: structured summary of up to 5 errors with count of remaining.
   */
  static summarizeNpmBuildErrors(rawOutput: string): string {
    const lines = rawOutput.split('\n');

    // Priority 1: webpack/bundler "ERROR in" lines
    const webpackErrors = lines.filter(line => /^ERROR in\b/.test(line));
    if (webpackErrors.length > 0) {
      const shown = webpackErrors.slice(0, 5);
      const remaining = webpackErrors.length - shown.length;
      const more = remaining > 0 ? `\n(+ ${remaining} more errors)` : '';
      return `${webpackErrors.length} build error(s):\n${shown.join('\n')}${more}`;
    }

    // Priority 2: TypeScript errors (tsc output within npm build)
    const tsErrors = rawOutput.match(/\S+\.\w+\(\d+,\d+\): error TS\d+: [^\n]+/g) ?? [];
    if (tsErrors.length > 0) {
      const shown = tsErrors.slice(0, 5);
      const remaining = tsErrors.length - shown.length;
      const more = remaining > 0 ? `\n(+ ${remaining} more errors)` : '';
      return `${tsErrors.length} build error(s):\n${shown.join('\n')}${more}`;
    }

    // Priority 3: Vite/Rollup/esbuild errors (e.g. "[vite]: Rollup failed", "error during build:")
    const viteErrors = lines.filter(line =>
      /\[vite\]/i.test(line) || /error during build/i.test(line) || /^✘ \[ERROR\]/.test(line)
    );
    if (viteErrors.length > 0) {
      const shown = viteErrors.slice(0, 5);
      const remaining = viteErrors.length - shown.length;
      const more = remaining > 0 ? `\n(+ ${remaining} more errors)` : '';
      return `${viteErrors.length} build error(s):\n${shown.join('\n')}${more}`;
    }

    // Priority 4: npm ERR! lines (npm's own error prefix)
    const npmErrLines = lines.filter(line => line.includes('ERR!'));
    if (npmErrLines.length > 0) {
      const shown = npmErrLines.slice(0, 5);
      const remaining = npmErrLines.length - shown.length;
      const more = remaining > 0 ? `\n(+ ${remaining} more errors)` : '';
      return `${shown.join('\n')}${more}`;
    }

    // Priority 5: Generic error lines (SyntaxError, ReferenceError, etc.)
    const genericErrors = lines.filter(line =>
      /\b(?:SyntaxError|ReferenceError|TypeError|Error):/i.test(line)
    );
    if (genericErrors.length > 0) {
      const shown = genericErrors.slice(0, 5);
      const remaining = genericErrors.length - shown.length;
      const more = remaining > 0 ? `\n(+ ${remaining} more errors)` : '';
      return `${genericErrors.length} build error(s):\n${shown.join('\n')}${more}`;
    }

    // Fallback: return last 10 non-empty lines for context
    const nonEmpty = lines.filter(l => l.trim().length > 0);
    if (nonEmpty.length > 0) {
      const tail = nonEmpty.slice(-10);
      return `npm build failed — tail of output:\n${tail.join('\n')}`;
    }

    return 'npm build failed (no specific error lines found)';
  }

  /**
   * Summarize test failures from npm test output.
   * Input: raw npm test runner output (Jest, Mocha, etc.)
   * Output: structured summary of up to 5 failures with count of remaining.
   */
  static summarizeNpmTestFailures(rawOutput: string): string {
    // Priority 1: Jest/Vitest bullet failures (● ✕ ✗ ×)
    const bulletFailures = rawOutput.match(/[●✕✗×]\s+[^\n]+/g) ?? [];

    // Priority 2: Jest/Vitest summary line
    const summaryLine = rawOutput.match(/Tests:\s+\d+ failed[^\n]*/)?.[0] ?? '';

    // Priority 3: Mocha "N failing"
    const mochaCount = rawOutput.match(/(\d+) failing/)?.[0] ?? '';

    if (bulletFailures.length > 0 || summaryLine || mochaCount) {
      const parts: string[] = [];
      if (summaryLine) parts.push(summaryLine);
      if (mochaCount) parts.push(mochaCount);

      const shownFailures = bulletFailures.slice(0, 5);
      if (shownFailures.length > 0) parts.push(shownFailures.join('\n'));

      const remaining = bulletFailures.length - shownFailures.length;
      if (remaining > 0) parts.push(`(+ ${remaining} more test failures)`);

      return parts.join('\n');
    }

    // Priority 4: FAIL file paths (Jest "FAIL src/foo.test.ts")
    const failPaths = rawOutput.split('\n').filter(line => /^\s*FAIL\s+\S+/.test(line)).slice(0, 5);
    if (failPaths.length > 0) {
      return `Test failures:\n${failPaths.join('\n')}`;
    }

    return 'npm tests failed (unable to extract specific test names)';
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
