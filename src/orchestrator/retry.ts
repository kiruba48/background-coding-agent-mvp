import pino from 'pino';
import { AgentSession, SessionConfig } from './session.js';
import { SessionResult, RetryConfig, RetryResult, VerificationResult } from '../types.js';
import { ErrorSummarizer } from './summarizer.js';

/**
 * RetryOrchestrator wraps AgentSession in an outer retry loop.
 *
 * Distinct from the API-level retry in agent.ts (which handles transient
 * 429/529 errors). This orchestrator handles session-level retries: when a
 * session succeeds but verification fails, start a FRESH session with error
 * context injected into the initial message.
 *
 * Key design decisions:
 * - New AgentSession per attempt (CRITICAL: never reuse — prevents context accumulation)
 * - Session-level failures (timeout, turn_limit, failed) are terminal — do NOT retry
 * - Only retry when session succeeds but verification fails
 * - Original task ALWAYS first in the retry message (primary directive)
 * - Error digest is secondary information after separator
 * - No backoff delay between retries (verification failures are not transient)
 *
 * Source: Spotify Engineering Part 2/3 + Anthropic harness pattern
 */
export class RetryOrchestrator {
  private config: SessionConfig;
  private retryConfig: RetryConfig;
  private activeSession: AgentSession | null = null;

  constructor(sessionConfig: SessionConfig, retryConfig: RetryConfig = { maxRetries: 3 }) {
    this.config = sessionConfig;
    this.retryConfig = retryConfig;
  }

  /**
   * Stop the currently active session, if any.
   * Called from signal handlers to ensure Docker containers are cleaned up.
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

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      logger?.info({ attempt, maxRetries }, 'Starting retry attempt');

      // Build message: attempt 1 uses originalTask as-is, subsequent attempts
      // include error context from prior failed verifications
      const message = attempt === 1
        ? originalTask
        : this.buildRetryMessage(originalTask, attempt, verificationResults);

      // CRITICAL: Create a fresh AgentSession for each attempt.
      // Never reuse sessions — prior conversation history accumulates and
      // fills the context window, causing the model to forget the original task.
      const session = new AgentSession(this.config);
      this.activeSession = session;

      let sessionResult: SessionResult;
      try {
        await session.start();
        sessionResult = await session.run(message, logger);
      } finally {
        // Always clean up container, even on error (including start() failures)
        await session.stop();
        this.activeSession = null;
      }

      sessionResults.push(sessionResult);

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
          error: sessionResult.error
        };
      }

      // No verifier configured — treat session success as overall success.
      // Phase 5 verifiers will plug in here via retryConfig.verifier.
      if (!this.retryConfig.verifier) {
        return {
          finalStatus: 'success',
          attempts: attempt,
          sessionResults,
          verificationResults
        };
      }

      // Run verification on the workspace — catch verifier crashes to return
      // structured result instead of letting exceptions propagate unhandled
      let verification: VerificationResult;
      try {
        verification = await this.retryConfig.verifier(this.config.workspaceDir);
      } catch (err) {
        logger?.error({ attempt, err }, 'Verifier crashed');
        return {
          finalStatus: 'failed',
          attempts: attempt,
          sessionResults,
          verificationResults,
          error: `Verifier error: ${err instanceof Error ? err.message : String(err)}`
        };
      }
      verificationResults.push(verification);

      if (verification.passed) {
        logger?.info({ attempt }, 'Verification passed');
        return {
          finalStatus: 'success',
          attempts: attempt,
          sessionResults,
          verificationResults
        };
      }

      // Verification failed — log and loop for next attempt (which will include error context)
      logger?.warn(
        { attempt, maxRetries, errorCount: verification.errors.length },
        'Verification failed, retrying with error context'
      );
    }

    // All retries exhausted with no passing verification
    return {
      finalStatus: 'max_retries_exhausted',
      attempts: maxRetries,
      sessionResults,
      verificationResults,
      error: `Verification still failing after ${maxRetries} attempts`
    };
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

    return [
      // 1. Original task ALWAYS comes first — primary directive
      originalTask,
      '',
      // 2. Structured error context — secondary information
      '---',
      `PREVIOUS ATTEMPT ${attempt - 1} FAILED VERIFICATION:`,
      errorDigest,
      '---',
      // 3. Clear instruction for retry
      'Fix the issues above and complete the original task.'
    ].join('\n');
  }
}
