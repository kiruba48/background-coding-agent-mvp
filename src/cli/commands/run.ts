import { RetryOrchestrator } from '../../orchestrator/retry.js';
import { MetricsCollector } from '../../orchestrator/metrics.js';
import { createLogger } from '../utils/logger.js';
import { compositeVerifier } from '../../orchestrator/verifier.js';
import { llmJudge } from '../../orchestrator/judge.js';
import { GitHubPRCreator } from '../../orchestrator/pr-creator.js';
import { buildPrompt } from '../../prompts/index.js';
import { assertDockerRunning, ensureNetworkExists, buildImageIfNeeded } from '../docker/index.js';
import pc from 'picocolors';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const execFileAsync = promisify(execFile);

export interface RunOptions {
  taskType: string;
  repo: string;
  turnLimit: number;    // already parsed and validated by CLI
  timeout: number;      // seconds, already parsed and validated
  maxRetries: number;   // default: 3, validated 1-10
  noJudge?: boolean;    // if true, skip LLM judge (--no-judge flag or JUDGE_ENABLED=false)
  createPr?: boolean;       // if true, create GitHub PR after success
  branchOverride?: string;  // --branch value, if provided
  dep?: string;              // groupId:artifactId for dependency update tasks
  targetVersion?: string;    // target version for dependency update tasks
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

  // Determine if judge is disabled
  const judgeDisabled = options.noJudge === true || process.env.JUDGE_ENABLED === 'false';
  if (judgeDisabled) {
    childLogger.info('LLM Judge disabled via --no-judge or JUDGE_ENABLED=false');
  }

  // Host-side npm install: regenerate lockfile after agent edits package.json.
  // Agent SDK session has no network access; npm install must run on host.
  const preVerify = options.taskType === 'npm-dependency-update'
    ? async (workspaceDir: string): Promise<void> => {
        childLogger.info('Running host-side npm install to regenerate lockfile...');
        try {
          await execFileAsync('npm', ['install', '--ignore-scripts'], {
            cwd: workspaceDir,
            timeout: 120_000,
            maxBuffer: 10 * 1024 * 1024,
            killSignal: 'SIGKILL',
          });
          childLogger.info('npm install completed successfully');
        } catch (err: unknown) {
          const error = err as { stdout?: string; stderr?: string };
          const output = [error.stderr ?? '', error.stdout ?? ''].join('\n').trim();
          throw new Error(`npm install failed (agent cannot fix registry/network issues):\n${output.slice(0, 500)}`);
        }
      }
    : undefined;

  // Docker is always-on — every agent run goes through Docker
  await assertDockerRunning();
  await ensureNetworkExists();
  await buildImageIfNeeded();

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
      verifier: compositeVerifier,  // Phase 5: wire verifiers into retry loop
      judge: judgeDisabled ? undefined : llmJudge,  // Phase 6: LLM Judge after verification
      maxJudgeVetoes: 1,
      preVerify,
    }
  );

  // Create metrics collector
  const metrics = new MetricsCollector();

  // Register signal handlers for graceful cleanup.
  // Must await orchestrator.stop() to abort the active SDK session
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
    // Construct prompt from task type via prompt module
    const prompt = buildPrompt({
      taskType: options.taskType,
      dep: options.dep,
      targetVersion: options.targetVersion,
    });

    // Run the retry orchestration loop
    const retryResult = await orchestrator.run(prompt, childLogger);

    // Create GitHub PR if requested and run was successful
    if (options.createPr && retryResult.finalStatus === 'success') {
      childLogger.info('Creating GitHub PR...');
      const creator = new GitHubPRCreator(options.repo);
      try {
        const prResult = await creator.create({
          taskType: options.taskType,
          originalTask: prompt,
          retryResult,
          branchOverride: options.branchOverride,
        });

        if (prResult.error) {
          // PR creation failed (non-fatal per CONTEXT.md decisions)
          childLogger.warn({ error: prResult.error, branch: prResult.branch }, 'PR creation failed');
          console.error(pc.yellow(`Warning: PR creation failed: ${prResult.error}`));
          console.error(pc.yellow(`Branch pushed: ${prResult.branch} — create PR manually at https://github.com`));
        } else if (prResult.created) {
          childLogger.info({ prUrl: prResult.url, branch: prResult.branch }, 'GitHub PR created');
          console.log(pc.green(`PR created: ${prResult.url}`));
        } else {
          childLogger.info({ prUrl: prResult.url, branch: prResult.branch }, 'PR already exists');
          console.log(pc.green(`Existing PR: ${prResult.url}`));
        }
      } catch (err) {
        // Hard errors (missing token, no remote) — log but keep exit code 0
        // Token was validated before runAgent(), so this handles edge cases
        const errMsg = err instanceof Error ? err.message : String(err);
        childLogger.warn({ error: errMsg }, 'PR creation threw unexpectedly');
        console.error(pc.yellow(`Warning: PR creation error: ${errMsg}`));
      }
    }

    // Record metrics using retryResult.finalStatus (not lastSession.status,
    // which would incorrectly record 'vetoed' runs as 'success')
    if (retryResult.sessionResults.length > 0) {
      const lastSession = retryResult.sessionResults[retryResult.sessionResults.length - 1];
      const status = retryResult.finalStatus === 'max_retries_exhausted' ? 'failed' : retryResult.finalStatus;
      metrics.recordSession(status, lastSession.toolCallCount, lastSession.duration);
    }

    // Log retry result as structured JSON
    childLogger.info(
      {
        retryResult: {
          finalStatus: retryResult.finalStatus,
          attempts: retryResult.attempts,
          sessionCount: retryResult.sessionResults.length,
          verificationCount: retryResult.verificationResults.length,
          judgeCount: retryResult.judgeResults?.length ?? 0,
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
      default:
        exitCode = 1;
    }

    return exitCode;
  } catch (error) {
    childLogger.error({ err: error }, 'Agent run failed');
    return 1;
  }
}
