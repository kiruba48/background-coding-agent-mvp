/**
 * Public library API for running the background coding agent.
 *
 * This module exposes runAgent() as a clean importable function that:
 * - Internalizes Docker lifecycle management
 * - Accepts AbortSignal for cancellation
 * - Returns RetryResult (never terminates the process)
 * - Has no process signal handlers (SIGINT/SIGTERM belong to the CLI entry point)
 *
 * Usage:
 *   const result = await runAgent(options, { signal: abortController.signal });
 */

import pino from 'pino';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { RetryOrchestrator } from '../orchestrator/retry.js';
import { MetricsCollector } from '../orchestrator/metrics.js';
import { compositeVerifier } from '../orchestrator/verifier.js';
import { llmJudge } from '../orchestrator/judge.js';
import { GitHubPRCreator, generateBranchName } from '../orchestrator/pr-creator.js';
import { buildPrompt } from '../prompts/index.js';
import { assertDockerRunning, ensureNetworkExists, buildImageIfNeeded } from '../cli/docker/index.js';
import { WorktreeManager } from './worktree-manager.js';
import type { RetryResult } from '../types.js';
import type { TaskCategory, ExplorationSubtype } from '../intent/types.js';

const execFileAsync = promisify(execFile);

/**
 * Options for running an agent session.
 * Similar to CLI RunOptions but with timeoutMs (not seconds) for library callers.
 */
export interface AgentOptions {
  taskType: string;
  repo: string;
  turnLimit: number;
  timeoutMs: number;       // milliseconds (NOT seconds like CLI)
  maxRetries: number;
  noJudge?: boolean;
  createPr?: boolean;
  branchOverride?: string;
  dep?: string;
  targetVersion?: string;
  description?: string;     // raw NL task description for generic tasks
  taskCategory?: TaskCategory;    // category label for generic tasks (e.g. 'code-change')
  scopeHints?: string[];          // scoping dialogue answers for generic tasks
  explorationSubtype?: ExplorationSubtype;    // subtype for investigation tasks (e.g. 'git-strategy')
}

/**
 * Execution context for the agent run.
 * Separates infrastructure concerns (logger, signal) from task options.
 */
export interface AgentContext {
  logger?: pino.Logger;    // falls back to pino({ level: 'silent' }) if omitted
  signal?: AbortSignal;    // graceful cancellation via AbortSignal
  skipDockerChecks?: boolean;   // REPL sets true after startup check
  skipWorktree?: boolean;       // tests can bypass worktree creation
}

/**
 * Run an agent session with the given options.
 *
 * Handles Docker lifecycle internally. Accepts AbortSignal for cancellation.
 * Returns RetryResult directly — no terminating calls, no process signal handlers.
 *
 * @param options - Task configuration (repo, taskType, limits, etc.)
 * @param context - Execution context (optional logger, optional AbortSignal)
 * @returns RetryResult with finalStatus, attempts, session/verification results
 */
export async function runAgent(
  options: AgentOptions,
  context: AgentContext = {}
): Promise<RetryResult> {
  // Use caller's logger or fall back to a silent no-op logger
  const logger = context.logger ?? pino({ level: 'silent' });
  const childLogger = logger.child({
    taskType: options.taskType,
    repo: options.repo,
  });

  // Fast-path: if the signal is already aborted, return immediately
  if (context.signal?.aborted) {
    return {
      finalStatus: 'cancelled',
      attempts: 0,
      sessionResults: [],
      verificationResults: [],
    };
  }

  // Determine if judge is disabled
  const judgeDisabled = options.noJudge === true || process.env.JUDGE_ENABLED === 'false';
  if (judgeDisabled) {
    childLogger.info('LLM Judge disabled via noJudge option or JUDGE_ENABLED=false');
  }

  // Host-side npm install: regenerate lockfile after agent edits package.json.
  // Runs on the host so the worktree lockfile stays consistent with the host environment.
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
          const isResolvable = output.includes('ERESOLVE') || output.includes('peer dep') || output.includes('Could not resolve');
          const { PreVerifyError } = await import('../orchestrator/retry.js');
          throw new PreVerifyError(
            `npm install failed:\n${output.slice(0, 500)}`,
            isResolvable,
          );
        }
      }
    : undefined;

  // Docker lifecycle — skip if caller already handled (REPL startup)
  if (!context.skipDockerChecks) {
    await assertDockerRunning();
    await ensureNetworkExists();
    await buildImageIfNeeded();
  }

  // Investigation tasks: bypass worktree, mount :ro, run bare session, skip verifier/judge/PR
  if (options.taskType === 'investigation') {
    try {
      const prompt = await buildPrompt({
        taskType: options.taskType,
        description: options.description,
        explorationSubtype: options.explorationSubtype,
      });

      const { ClaudeCodeSession } = await import('../orchestrator/claude-code-session.js');
      const session = new ClaudeCodeSession({
        workspaceDir: options.repo,
        turnLimit: options.turnLimit,
        timeoutMs: options.timeoutMs,
        logger: childLogger,
        signal: context.signal,
        readOnly: true,
      });

      const sessionResult = await session.run(prompt, childLogger, context.signal);

      // Map SessionResult.status to RetryResult.finalStatus explicitly (V2: no unsound cast)
      const statusMap: Record<string, RetryResult['finalStatus']> = {
        success: 'success',
        failed: 'failed',
        timeout: 'timeout',
        turn_limit: 'turn_limit',
        cancelled: 'cancelled',
      };

      return {
        finalStatus: statusMap[sessionResult.status] ?? 'failed',
        attempts: 1,
        sessionResults: [sessionResult],
        verificationResults: [],
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      childLogger.error({ err }, 'Investigation task failed');
      return {
        finalStatus: 'failed',
        attempts: 1,
        sessionResults: [],
        verificationResults: [],
        error: errMsg,
      };
    }
  }

  // Worktree lifecycle — create isolated worktree unless skipped (tests)
  let effectiveWorkspaceDir = options.repo;
  let effectiveBranchOverride = options.branchOverride;
  let worktreeManager: WorktreeManager | null = null;
  let shouldKeepBranch = false;

  try {
    if (!context.skipWorktree) {
      const suffix = randomBytes(3).toString('hex');
      const worktreePath = WorktreeManager.buildWorktreePath(options.repo, suffix);
      const branchInput = options.taskType === 'generic' && options.description
        ? `${options.taskCategory ?? 'generic'} ${options.description.slice(0, 40)}`
        : options.taskType;
      const branchName = generateBranchName(branchInput);
      worktreeManager = new WorktreeManager(options.repo, worktreePath, branchName);
      await worktreeManager.create();

      // Install npm dependencies in worktree so verification (npm run build/test) works.
      // git worktree add creates a clean checkout without node_modules.
      // Strategy: try plain install first; fall back to --legacy-peer-deps if ERESOLVE.
      // --legacy-peer-deps can skip transitive deps, so we only use it as a last resort.
      try {
        await access(path.join(worktreePath, 'package.json'));
        childLogger.info('Installing npm dependencies in worktree...');
        const npmInstallOpts = {
          cwd: worktreePath,
          timeout: 120_000,
          maxBuffer: 10 * 1024 * 1024,
          killSignal: 'SIGKILL' as const,
        };
        try {
          await execFileAsync('npm', ['install', '--ignore-scripts'], npmInstallOpts);
        } catch (firstErr: unknown) {
          const output = [
            (firstErr as { stderr?: string }).stderr ?? '',
            (firstErr as { stdout?: string }).stdout ?? '',
          ].join('\n');
          if (output.includes('ERESOLVE') || output.includes('peer dep') || output.includes('Could not resolve')) {
            childLogger.info('Peer dependency conflict — retrying with --legacy-peer-deps');
            await execFileAsync('npm', ['install', '--ignore-scripts', '--legacy-peer-deps'], npmInstallOpts);
          } else {
            throw firstErr;
          }
        }
        childLogger.info('Worktree npm install completed');
      } catch (err: unknown) {
        // ENOENT from access() means no package.json — skip silently.
        // npm install failures are non-fatal: verification will catch build issues.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          childLogger.warn({ error: (err as Error).message }, 'Worktree npm install failed (non-fatal)');
        }
      }

      effectiveWorkspaceDir = worktreePath;
      effectiveBranchOverride = branchName;
    }
    // Create RetryOrchestrator — signal is threaded through SessionConfig
    const orchestrator = new RetryOrchestrator(
      {
        workspaceDir: effectiveWorkspaceDir,
        turnLimit: options.turnLimit,
        timeoutMs: options.timeoutMs,
        logger: childLogger,
        signal: context.signal,  // Thread AbortSignal through the full chain
      },
      {
        maxRetries: options.maxRetries,
        verifier: compositeVerifier,
        judge: judgeDisabled ? undefined : llmJudge,
        maxJudgeVetoes: 1,
        preVerify,
      }
    );

    // Create metrics collector
    const metrics = new MetricsCollector();

    // Resolve "latest" to a concrete version on the host before building the prompt.
    // Avoids the agent wasting turns trying npm show/curl inside Docker.
    let resolvedVersion = options.targetVersion;
    if (options.taskType === 'npm-dependency-update' && options.dep && resolvedVersion === 'latest') {
      childLogger.info({ dep: options.dep }, 'Resolving "latest" version on host...');
      try {
        const { stdout } = await execFileAsync('npm', ['show', options.dep, 'version'], {
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        });
        const version = stdout.trim();
        if (version && /^\d+\.\d+\.\d+/.test(version)) {
          childLogger.info({ dep: options.dep, version }, 'Resolved latest version');
          resolvedVersion = version;
        }
      } catch (err: unknown) {
        childLogger.warn({ dep: options.dep, error: (err as Error).message },
          'Failed to resolve latest version on host — agent will attempt resolution inside Docker');
      }
    }

    // Construct prompt from task type
    const prompt = await buildPrompt({
      taskType: options.taskType,
      dep: options.dep,
      targetVersion: resolvedVersion,
      description: options.description,
      repoPath: effectiveWorkspaceDir,
      scopeHints: options.scopeHints,
    });

    // Run the retry orchestration loop
    const retryResult = await orchestrator.run(prompt, childLogger);

    // If cancelled, return immediately without PR creation or metrics
    if (retryResult.finalStatus === 'cancelled' || context.signal?.aborted) {
      return {
        ...retryResult,
        finalStatus: 'cancelled',
        worktreeBranch: effectiveBranchOverride,
      };
    }

    // Create GitHub PR if requested and run was successful
    if (options.createPr && retryResult.finalStatus === 'success') {
      childLogger.info('Creating GitHub PR...');
      const creator = new GitHubPRCreator(effectiveWorkspaceDir);
      try {
        const prResult = await creator.create({
          taskType: options.taskType,
          originalTask: prompt,
          retryResult,
          branchOverride: effectiveBranchOverride,
          description: options.description,
          taskCategory: options.taskCategory,
        });

        retryResult.prResult = prResult;

        if (prResult.error) {
          childLogger.warn({ error: prResult.error, branch: prResult.branch }, 'PR creation failed');
        } else if (prResult.created) {
          childLogger.info({ prUrl: prResult.url, branch: prResult.branch }, 'GitHub PR created');
        } else {
          childLogger.info({ prUrl: prResult.url, branch: prResult.branch }, 'PR already exists');
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        childLogger.warn({ error: errMsg }, 'PR creation threw unexpectedly');
      }
    }

    // Record metrics
    if (retryResult.sessionResults.length > 0) {
      const lastSession = retryResult.sessionResults[retryResult.sessionResults.length - 1];
      const statusMap: Record<string, import('../orchestrator/metrics.js').SessionStatus> = {
        success: 'success',
        failed: 'failed',
        timeout: 'timeout',
        turn_limit: 'turn_limit',
        vetoed: 'vetoed',
        cancelled: 'cancelled',
        max_retries_exhausted: 'failed',
        zero_diff: 'success',  // agent completed without error
      };
      const status = statusMap[retryResult.finalStatus] ?? 'failed';
      metrics.recordSession(status, lastSession.toolCallCount, lastSession.duration);
    }

    // Log retry result
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

    // Expose worktree branch on result for REPL post-hoc PR support
    retryResult.worktreeBranch = effectiveBranchOverride;

    // Keep branch alive for post-hoc PR when createPr was false and task succeeded.
    // Branch lives in the main repo's refs — only the worktree directory is removed.
    if (!options.createPr && retryResult.finalStatus === 'success') {
      shouldKeepBranch = true;
    }

    // Return result directly — no exit codes, no process termination
    return retryResult;
  } finally {
    // Clean up worktree AFTER PR creation completes.
    // keepBranch preserves the branch for post-hoc PR in REPL mode.
    if (worktreeManager) {
      await worktreeManager.remove({ keepBranch: shouldKeepBranch, logger: childLogger });
    }
  }
}
