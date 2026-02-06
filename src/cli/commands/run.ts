import { AgentSession } from '../../orchestrator/session.js';
import { MetricsCollector } from '../../orchestrator/metrics.js';
import { createLogger, Logger } from '../utils/logger.js';

export interface RunOptions {
  taskType: string;
  repo: string;
  turnLimit: number;    // already parsed and validated by CLI
  timeout: number;      // seconds, already parsed and validated
}

/**
 * Run an agent session with the given options
 *
 * This is the core orchestration logic that:
 * 1. Creates a Pino logger with task context
 * 2. Creates an AgentSession with validated options
 * 3. Registers signal handlers for graceful cleanup
 * 4. Runs the session lifecycle (start -> run -> stop)
 * 5. Records metrics
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

  // Create AgentSession
  const session = new AgentSession({
    workspaceDir: options.repo,
    turnLimit: options.turnLimit,
    timeoutMs: options.timeout * 1000,  // convert seconds to ms
    logger: childLogger,
  });

  // Create metrics collector
  const metrics = new MetricsCollector();

  // Track if we're cleaning up to prevent double cleanup
  let cleanedUp = false;

  // Cleanup helper
  const cleanup = async () => {
    if (!cleanedUp) {
      childLogger.info('Cleaning up session');
      await session.stop();
      cleanedUp = true;
    }
  };

  // Register signal handlers for graceful cleanup
  process.once('SIGINT', async () => {
    childLogger.info('Received SIGINT, cleaning up...');
    await cleanup();
    process.exit(130);
  });

  process.once('SIGTERM', async () => {
    childLogger.info('Received SIGTERM, cleaning up...');
    await cleanup();
    process.exit(143);
  });

  try {
    // Start the session
    await session.start();

    // Construct prompt from task type
    const prompt = `You are a coding agent. Your task: ${options.taskType}. Work in the current directory.`;

    // Run the session
    const result = await session.run(prompt, childLogger);

    // Record metrics
    metrics.recordSession(result.status, result.toolCallCount, result.duration);

    // Log session result as structured JSON
    childLogger.info(
      {
        sessionResult: result,
        metrics: metrics.getMetrics(),
      },
      'Agent session completed'
    );

    // Determine exit code based on result status
    let exitCode: number;
    switch (result.status) {
      case 'success':
        exitCode = 0;
        break;
      case 'timeout':
        exitCode = 124;
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
  } finally {
    // Always clean up container
    await cleanup();
  }
}
