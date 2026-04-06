import pino from 'pino';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { type SessionConfig, SessionResult, RetryConfig, RetryResult, VerificationResult, JudgeResult } from '../types.js';
import { ClaudeCodeSession } from './claude-code-session.js';
import { captureBaselineSha, getWorkspaceDiff, MIN_DIFF_CHARS } from './judge.js';
import { ErrorSummarizer } from './summarizer.js';

const execFileAsync = promisify(execFile);

/**
 * Typed error for preVerify hook failures.
 * `retryable` = true means the agent can fix this (e.g. ERESOLVE peer dep conflict).
 * `retryable` = false means it's terminal (e.g. network/registry down).
 */
export class PreVerifyError extends Error {
  constructor(message: string, public readonly retryable: boolean) {
    super(message);
    this.name = 'PreVerifyError';
  }
}

/**
 * Basename-only patterns that identify configuration files (as opposed to source files).
 * These are tested against path.basename(filepath) only — never the full path —
 * to prevent false positives like `src/database.config.ts` matching `*.config.ts`.
 */
export const CONFIG_BASENAME_PATTERNS = [
  /^\.eslintrc(\.[a-z]+)?$/,
  /^\.prettierrc(\.[a-z]+)?$/,
  /^tsconfig(\.[a-z.-]+)?\.json$/,
  /^\.env(\.[a-z]+)?$/,
  /^(vite|vitest|webpack|rollup|esbuild|postcss|tailwind|next|nuxt|svelte|astro|jest|babel|prettier|eslint|stylelint|commitlint|lint-staged|turbo|nx|renovate)\.config\.(js|ts|mjs|cjs|mts|cts)$/,
  /^jest\.config\.[a-z]+$/,
  /^babel\.config\.[a-z]+$/,
  /^\.babelrc(\.[a-z]+)?$/,
  /^\.stylelintrc(\.[a-z]+)?$/,
  /^\.editorconfig$/,
  /^\.nvmrc$/,
  /^\.node-version$/,
  /^Dockerfile(\.[a-z]+)?$/,
  /^docker-compose(\.[a-z.-]+)?\.ya?ml$/,
  /^\.gitignore$/,
  /^\.npmrc$/,
  /^\.yarnrc(\.[a-z]+)?$/,
  /^renovate\.json$/,
  /^\.renovaterc(\.[a-z]+)?$/,
  /^turbo\.json$/,
  /^nx\.json$/,
];

/**
 * Path patterns that require the full normalized filepath to match.
 * Tested against the forward-slash-normalized full path.
 */
export const CONFIG_PATH_PATTERNS = [
  /^\.github\/.*\.ya?ml$/,
  /^\.husky\//,
];

/**
 * Returns true if the given filepath is a configuration file (not source code).
 * Basename patterns match against path.basename() only (prevents false positives
 * like src/database.config.ts). Path patterns match against the full normalized path
 * (for .github/workflows/*.yml etc.).
 */
export function isConfigFile(filepath: string): boolean {
  const basename = path.basename(filepath);
  if (CONFIG_BASENAME_PATTERNS.some(p => p.test(basename))) return true;
  const normalizedPath = filepath.replace(/\\/g, '/');
  return CONFIG_PATH_PATTERNS.some(p => p.test(normalizedPath));
}

/**
 * Get the list of files changed since baseline (committed changes only).
 * Returns empty array if git is unavailable or no commits exist.
 */
export async function getChangedFilesFromBaseline(workspaceDir: string, baselineSha?: string, logger?: pino.Logger): Promise<string[]> {
  try {
    const args = baselineSha
      ? ['diff', baselineSha, '--name-only']
      : ['diff', 'HEAD~1', 'HEAD', '--name-only'];
    const { stdout } = await execFileAsync('git', args, { cwd: workspaceDir });
    return stdout.trim().split('\n').filter(Boolean);
  } catch (err) {
    logger?.warn({ err, workspaceDir, baselineSha }, 'Failed to list changed files from baseline — falling back to full verification');
    return [];
  }
}

/**
 * RetryOrchestrator wraps ClaudeCodeSession in an outer retry loop.
 *
 * Handles session-level retries: when a session succeeds but verification
 * fails, start a FRESH session with error context injected into the initial message.
 *
 * Key design decisions:
 * - New ClaudeCodeSession per attempt (CRITICAL: never reuse — prevents context accumulation)
 * - Session-level failures (timeout, turn_limit, failed) are terminal — do NOT retry
 * - Only retry when session succeeds but verification fails
 * - Original task ALWAYS first in the retry message (primary directive)
 * - Error digest is secondary information after separator
 * - No backoff delay between retries (verification failures are not transient)
 */
export class RetryOrchestrator {
  private config: SessionConfig;
  private retryConfig: RetryConfig;
  private activeSession: ClaudeCodeSession | null = null;

  constructor(sessionConfig: SessionConfig, retryConfig: RetryConfig = { maxRetries: 3 }) {
    this.config = sessionConfig;
    this.retryConfig = retryConfig;
  }

  /**
   * Stop the currently active session, if any.
   * Called from signal handlers to ensure the active session is cleaned up.
   */
  async stop(): Promise<void> {
    if (this.activeSession) {
      await this.activeSession.stop();
      this.activeSession = null;
    }
  }

  /**
   * Run the agent task with outer retry loop.
   *
   * @param originalTask - The user's task description (always included first in retry messages)
   * @param logger - Optional Pino logger for structured logging
   * @returns RetryResult with final status, attempt count, and all session/verification results
   */
  async run(originalTask: string, logger?: pino.Logger): Promise<RetryResult> {
    const maxRetries = this.retryConfig.maxRetries;
    const sessionResults: SessionResult[] = [];
    const verificationResults: VerificationResult[] = [];
    const judgeResults: JudgeResult[] = [];

    // Fast-path: if signal is already aborted before any work starts
    if (this.config.signal?.aborted) {
      return { finalStatus: 'cancelled', attempts: 0, sessionResults, verificationResults, judgeResults };
    }

    // Capture HEAD SHA before agent runs so the Judge diffs against the exact
    // pre-agent state — prevents false vetoes from prior commits in the repo.
    const baselineSha = await captureBaselineSha(this.config.workspaceDir);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      // Check signal at start of each loop iteration
      if (this.config.signal?.aborted) {
        await this.resetWorkspace(this.config.workspaceDir, baselineSha, logger);
        return { finalStatus: 'cancelled', attempts: attempt - 1, sessionResults, verificationResults, judgeResults };
      }

      logger?.info({ attempt, maxRetries }, 'Starting retry attempt');

      // Build message: attempt 1 uses originalTask as-is, subsequent attempts
      // include error context from prior failed verifications
      const message = attempt === 1
        ? originalTask
        : this.buildRetryMessage(originalTask, attempt, verificationResults);

      // CRITICAL: Create a fresh session for each attempt.
      // Never reuse sessions — prior conversation history accumulates and
      // fills the context window, causing the model to forget the original task.
      const session = new ClaudeCodeSession(this.config);
      this.activeSession = session;

      let sessionResult: SessionResult;
      try {
        await session.start();
        sessionResult = await session.run(message, logger, this.config.signal);
      } finally {
        // Always clean up session, even on error (including start() failures)
        await session.stop();
        this.activeSession = null;
      }

      sessionResults.push(sessionResult);

      // Cancellation: reset workspace and return immediately
      if (sessionResult.status === 'cancelled') {
        await this.resetWorkspace(this.config.workspaceDir, baselineSha, logger);
        return {
          finalStatus: 'cancelled',
          attempts: attempt,
          sessionResults,
          verificationResults,
          judgeResults,
        };
      }

      // Session-level failures are terminal — do NOT retry.
      // timeout: task is too slow for current settings
      // turn_limit: task is too complex for current turn budget
      // failed: unrecoverable error in session
      if (sessionResult.status !== 'success') {
        logger?.error(
          { attempt, status: sessionResult.status },
          'Session failed, not retrying'
        );
        return {
          finalStatus: sessionResult.status,
          attempts: attempt,
          sessionResults,
          verificationResults,
          judgeResults,
          error: sessionResult.error
        };
      }

      // Zero-diff check: if agent made no meaningful changes, surface immediately.
      // Retrying with the same prompt will not produce different results.
      const workspaceDiff = await getWorkspaceDiff(this.config.workspaceDir, baselineSha);
      if (!workspaceDiff || workspaceDiff.length < MIN_DIFF_CHARS) {
        logger?.info({ attempt }, 'Zero diff detected — agent produced no meaningful changes');
        return {
          finalStatus: 'zero_diff',
          attempts: attempt,
          sessionResults,
          verificationResults,
          judgeResults,
        };
      }

      // No verifier configured — treat session success as overall success.
      // Phase 5 verifiers will plug in here via retryConfig.verifier.
      if (!this.retryConfig.verifier) {
        return {
          finalStatus: 'success',
          attempts: attempt,
          sessionResults,
          verificationResults,
          judgeResults,
        };
      }

      // Config-only classification: if all changed files are config files,
      // skip build+test in the verifier (run lint only)
      const changedFiles = await getChangedFilesFromBaseline(this.config.workspaceDir, baselineSha, logger);
      const configOnly = changedFiles.length > 0 && changedFiles.every(isConfigFile);
      if (configOnly) {
        logger?.info({ changedFiles }, 'Config-only change detected — will skip build and test verification');
      }

      // Run pre-verification hook (e.g., host-side npm install for lockfile regen).
      // Retryable errors (ERESOLVE) feed into the retry loop; terminal errors (network) bail out.
      if (this.retryConfig.preVerify) {
        try {
          await this.retryConfig.preVerify(this.config.workspaceDir);
        } catch (err) {
          const isRetryable = err instanceof PreVerifyError && err.retryable;
          if (isRetryable) {
            // Extract a concise error snippet for the agent's retry context
            const errMsg = err instanceof Error ? err.message : String(err);
            const snippet = errMsg.slice(0, 300);
            logger?.warn({ attempt, error: snippet }, 'Pre-verify failed with retryable error, feeding to retry loop');
            const preVerifyVerification: VerificationResult = {
              passed: false,
              errors: [{
                type: 'build',
                summary: `npm install failed — agent must fix package.json:\n${snippet}`,
                rawOutput: errMsg,
              }],
              durationMs: 0,
            };
            verificationResults.push(preVerifyVerification);
            continue; // next attempt with error context
          }
          logger?.error({ attempt, err }, 'Pre-verify hook failed (terminal)');
          return {
            finalStatus: 'failed',
            attempts: attempt,
            sessionResults,
            verificationResults,
            judgeResults,
            error: `Pre-verify failed: ${err instanceof Error ? err.message : String(err)}`
          };
        }
      }

      // Run verification on the workspace — catch verifier crashes to return
      // structured result instead of letting exceptions propagate unhandled
      let verification: VerificationResult;
      try {
        verification = configOnly
          ? await this.retryConfig.verifier(this.config.workspaceDir, { configOnly: true })
          : await this.retryConfig.verifier(this.config.workspaceDir);
      } catch (err) {
        logger?.error({ attempt, err }, 'Verifier crashed');
        return {
          finalStatus: 'failed',
          attempts: attempt,
          sessionResults,
          verificationResults,
          judgeResults,
          error: `Verifier error: ${err instanceof Error ? err.message : String(err)}`
        };
      }
      verificationResults.push(verification);

      if (verification.passed) {
        logger?.info({ attempt }, 'Verification passed');

        // Judge runs AFTER verification passes — separate semantic check
        if (this.retryConfig.judge) {
          const maxJudgeVetoes = this.retryConfig.maxJudgeVetoes ?? 1;

          // Check if we've already exhausted judge retries
          const judgeVetoCount = judgeResults.filter(r => r.verdict === 'VETO' && !r.skipped).length;
          if (judgeVetoCount >= maxJudgeVetoes) {
            logger?.warn({ judgeVetoCount, maxJudgeVetoes }, 'Judge retry budget exhausted');
            return {
              finalStatus: 'vetoed',
              attempts: attempt,
              sessionResults,
              verificationResults,
              judgeResults,
              error: `Judge vetoed ${judgeVetoCount} time(s) — retry budget exhausted`,
            };
          }

          let judgeResult: JudgeResult;
          try {
            judgeResult = await this.retryConfig.judge(this.config.workspaceDir, originalTask, baselineSha);
          } catch (err) {
            // Judge crash = fail open (approve) — not a reason to block
            logger?.warn({ attempt, err }, 'Judge crashed, failing open');
            judgeResult = {
              verdict: 'APPROVE',
              reasoning: 'Judge crashed, failing open',
              veto_reason: '',
              durationMs: 0,
              skipped: true,
            };
          }
          judgeResults.push(judgeResult);

          logger?.info({
            attempt,
            verdict: judgeResult.verdict,
            reasoning: judgeResult.reasoning,
            veto_reason: judgeResult.veto_reason,
            durationMs: judgeResult.durationMs,
            skipped: judgeResult.skipped,
          }, 'LLM Judge result');

          if (judgeResult.verdict === 'VETO' && !judgeResult.skipped) {
            // Veto: add as verification error for retry message, continue loop
            const judgeVerification: VerificationResult = {
              passed: false,
              errors: [{
                type: 'judge',
                summary: `[JUDGE VETO] ${judgeResult.veto_reason}`,
                rawOutput: judgeResult.reasoning,
              }],
              durationMs: judgeResult.durationMs,
            };
            verificationResults.push(judgeVerification);

            logger?.warn(
              { attempt, veto_reason: judgeResult.veto_reason },
              'Judge vetoed, retrying with veto feedback'
            );
            continue; // next attempt in the retry loop
          }
        }

        // Verification passed AND judge approved (or skipped, or no judge configured)
        return {
          finalStatus: 'success',
          attempts: attempt,
          sessionResults,
          verificationResults,
          judgeResults,
        };
      }

      // Verification failed — log and loop for next attempt (which will include error context)
      logger?.warn(
        {
          attempt,
          maxRetries,
          errorCount: verification.errors.length,
          errorSummaries: verification.errors.map(e => e.summary),
        },
        'Verification failed, retrying with error context'
      );
    }

    // All retries exhausted with no passing verification
    return {
      finalStatus: 'max_retries_exhausted',
      attempts: maxRetries,
      sessionResults,
      verificationResults,
      judgeResults,
      error: `Verification still failing after ${maxRetries} attempts`,
    };
  }

  /**
   * Reset the workspace to the baseline SHA on cancellation.
   * Best-effort: errors are caught and ignored to not block cancellation flow.
   */
  private async resetWorkspace(workspaceDir: string, baselineSha: string | undefined, logger?: pino.Logger): Promise<void> {
    if (!baselineSha) return;
    try {
      await execFileAsync('git', ['reset', '--hard', baselineSha], { cwd: workspaceDir, timeout: 10_000 });
    } catch (err) {
      // Best-effort reset — warn but don't throw (workspace may retain agent changes)
      logger?.warn({ err, workspaceDir, baselineSha }, 'Failed to reset workspace after cancellation — agent changes may remain');
    }
  }

  /**
   * Build a retry message with error context from prior failed verifications.
   *
   * Structure:
   * 1. Original task (ALWAYS first — primary directive)
   * 2. Separator
   * 3. Prior attempt failure summary (secondary information)
   * 4. Clear instruction to fix and complete
   */
  private buildRetryMessage(
    originalTask: string,
    attempt: number,
    priorVerificationResults: VerificationResult[]
  ): string {
    // Only pass the LAST failed result — prior failures may contain stale errors
    // that the agent already fixed in subsequent attempts
    const failedResults = priorVerificationResults.filter(r => !r.passed);
    const lastFailed = failedResults.length > 0 ? [failedResults[failedResults.length - 1]] : [];
    const errorDigest = ErrorSummarizer.buildDigest(lastFailed);

    // Check if the last failure was a judge veto (has an error with type 'judge')
    const lastFailedResult = failedResults[failedResults.length - 1];
    const isJudgeVeto = lastFailedResult?.errors?.some(e => e.type === 'judge') ?? false;
    const failureLabel = isJudgeVeto
      ? `PREVIOUS ATTEMPT ${attempt - 1} WAS VETOED BY LLM JUDGE:`
      : `PREVIOUS ATTEMPT ${attempt - 1} FAILED VERIFICATION:`;

    return [
      // 1. Original task ALWAYS comes first — primary directive
      originalTask,
      '',
      // 2. Structured error context — secondary information
      '---',
      failureLabel,
      errorDigest,
      '---',
      // 3. Clear instruction for retry
      'Fix the issues above and complete the original task.'
    ].join('\n');
  }
}
