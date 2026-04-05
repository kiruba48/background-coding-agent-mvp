import { runAgent, type AgentOptions } from '../../agent/index.js';
import { createLogger } from '../utils/logger.js';
import type { RetryResult } from '../../types.js';

/**
 * CLI-level options for the run command.
 * Note: timeout is in seconds (from CLI flags), converted to timeoutMs for AgentOptions.
 */
export interface CLIRunOptions {
  taskType: string;
  repo: string;
  turnLimit: number;
  timeout: number;       // seconds (from CLI)
  maxRetries: number;
  noJudge?: boolean;
  createPr?: boolean;
  branchOverride?: string;
  dep?: string;
  targetVersion?: string;
}

/**
 * Map RetryResult.finalStatus to a Unix exit code.
 *
 * - success          -> 0
 * - zero_diff        -> 0
 * - vetoed           -> 2   (task rejected by LLM Judge)
 * - turn_limit       -> 3   (agent exceeded max turns)
 * - timeout          -> 124  (standard timeout exit code)
 * - cancelled        -> 130  (SIGINT convention)
 * - failed           -> 1    (generic failure)
 * - max_retries_exhausted -> 1 (generic failure)
 */
export function mapStatusToExitCode(status: RetryResult['finalStatus']): number {
  switch (status) {
    case 'success':               return 0;
    case 'zero_diff':             return 0;
    case 'vetoed':                return 2;
    case 'turn_limit':            return 3;
    case 'timeout':               return 124;
    case 'cancelled':             return 130;
    case 'failed':                return 1;
    case 'max_retries_exhausted': return 1;
    default:                      return 1;
  }
}

/**
 * Thin CLI adapter over runAgent().
 *
 * Responsibilities:
 * - Map CLIRunOptions -> AgentOptions (convert timeout seconds -> ms)
 * - Create a child logger for structured logging
 * - Thread AbortSignal through to runAgent()
 * - Map RetryResult.finalStatus to exit code
 *
 * Does NOT:
 * - Register process signal handlers (done at CLI entry point)
 * - Terminate the process (caller's responsibility)
 * - Contain orchestration logic (all in runAgent())
 */
export async function runCommand(options: CLIRunOptions, signal?: AbortSignal): Promise<number> {
  const logger = createLogger();
  const childLogger = logger.child({ taskType: options.taskType, repo: options.repo });

  if (options.taskType === 'generic') {
    throw new Error(
      "Generic tasks require a description. Use the one-shot command or REPL instead of 'run --task-type generic'."
    );
  }

  const agentOptions: AgentOptions = {
    taskType: options.taskType,
    repo: options.repo,
    turnLimit: options.turnLimit,
    timeoutMs: options.timeout * 1000,  // convert seconds to milliseconds
    maxRetries: options.maxRetries,
    noJudge: options.noJudge,
    createPr: options.createPr,
    branchOverride: options.branchOverride,
    dep: options.dep,
    targetVersion: options.targetVersion,
  };

  try {
    const result = await runAgent(agentOptions, { logger: childLogger, signal });
    return mapStatusToExitCode(result.finalStatus);
  } catch (error) {
    childLogger.error({ err: error }, 'Agent run failed');
    return 1;
  }
}
