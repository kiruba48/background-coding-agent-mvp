import { RetryOrchestrator } from '../../orchestrator/retry.js';
import { MetricsCollector } from '../../orchestrator/metrics.js';
import { createLogger } from '../utils/logger.js';

export interface RunOptions {
  taskType: string;
  repo: string;
  turnLimit: number;    // already parsed and validated by CLI
  timeout: number;      // seconds, already parsed and validated
  maxRetries: number;   // default: 3, validated 1-10
}

/**
 * Run an agent session with the given options using RetryOrchestrator.
 *
 * This is the core orchestration logic that:
 * 1. Creates a Pino logger with task context
 * 2. Creates a RetryOrchestrator with validated options
 * 3. Registers signal handlers for graceful cleanup
 * 4. Runs the retry orchestration loop
 * 5. Records metrics from the final session result
 * 6. Returns appropriate exit code
 *
 * @param options - Validated CLI options
 * @returns Exit code (0=success, 1=failure, 124=timeout, 130=SIGINT, 143=SIGTERM)
 */
export async function runAgent(options: RunOptions): Promise<number> {
  // Create logger with task context
  const logger = createLogger();
  const childLogger = logger.child({
    taskType: options.taskType,
    repo: options.repo
  });

  // Create RetryOrchestrator with session config + retry config
  const orchestrator = new RetryOrchestrator(
    {
      workspaceDir: options.repo,
      turnLimit: options.turnLimit,
      timeoutMs: options.timeout * 1000,  // convert seconds to ms
      logger: childLogger,
    },
    {
      maxRetries: options.maxRetries,
      // No verifier in Phase 4 — Phase 5 verifiers plug in here
    }
  );

  // Create metrics collector
  const metrics = new MetricsCollector();

  // Register signal handlers for graceful cleanup.
  // Must await orchestrator.stop() to tear down the active Docker container
  // before exiting — process.exit() alone skips async cleanup.
  process.once('SIGINT', async () => {
    childLogger.info('Received SIGINT, cleaning up...');
    await orchestrator.stop();
    process.exit(130);
  });

  process.once('SIGTERM', async () => {
    childLogger.info('Received SIGTERM, cleaning up...');
    await orchestrator.stop();
    process.exit(143);
  });

  try {
    // Construct prompt from task type
    const prompt = `You are a coding agent. Your task: ${options.taskType}. Work in the current directory.`;

    // Run the retry orchestration loop
    const retryResult = await orchestrator.run(prompt, childLogger);

    // Record metrics using the final session result
    if (retryResult.sessionResults.length > 0) {
      const lastSession = retryResult.sessionResults[retryResult.sessionResults.length - 1];
      metrics.recordSession(lastSession.status, lastSession.toolCallCount, lastSession.duration);
    }

    // Log retry result as structured JSON
    childLogger.info(
      {
        retryResult: {
          finalStatus: retryResult.finalStatus,
          attempts: retryResult.attempts,
          sessionCount: retryResult.sessionResults.length,
          verificationCount: retryResult.verificationResults.length,
          error: retryResult.error,
        },
        metrics: metrics.getMetrics(),
      },
      'Agent run completed'
    );

    // Map RetryResult.finalStatus to exit codes
    let exitCode: number;
    switch (retryResult.finalStatus) {
      case 'success':
        exitCode = 0;
        break;
      case 'timeout':
        exitCode = 124;
        break;
      case 'max_retries_exhausted':
        exitCode = 1;
        break;
      case 'turn_limit':
        exitCode = 1;
        break;
      case 'failed':
        exitCode = 1;
        break;
      default:
        exitCode = 1;
    }

    return exitCode;
  } catch (error) {
    childLogger.error({ err: error }, 'Agent run failed');
    return 1;
  }
}
