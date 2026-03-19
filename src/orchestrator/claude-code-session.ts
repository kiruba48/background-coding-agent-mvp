import * as crypto from 'crypto';
import * as fs from 'fs';
import * as nodePath from 'path';
import {
  query,
  type HookCallback,
  type PreToolUseHookInput,
  type PostToolUseHookInput,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import pino from 'pino';
import { type SessionConfig, type SessionResult } from '../types.js';
import { createVerifierMcpServer } from '../mcp/verifier-server.js';

// Patterns for sensitive files that must never be written by the agent.
// Patterns use (?:^|\/) to match at any directory depth (V-2).
const SENSITIVE_PATTERNS = [
  /(?:^|\/)\.env$/,
  /(?:^|\/)\.env\./,
  /(?:^|\/)\.git\//,
  /private_key/i,
  /\.pem$/,
  /\.key$/,
];

/**
 * Build a PreToolUse hook that blocks writes outside the workspace
 * and to sensitive file patterns (SDK-08).
 */
function buildPreToolUseHook(workspaceDir: string, logger: pino.Logger): HookCallback {
  // Resolve symlinks on the repo root so symlink-based escapes are caught (V-1).
  // Fall back to path.resolve if the directory doesn't exist yet (e.g. in tests).
  const rawRepo = nodePath.resolve(workspaceDir);
  let resolvedRepo: string;
  try {
    resolvedRepo = fs.realpathSync(rawRepo);
  } catch {
    resolvedRepo = rawRepo;
  }

  return async (input, toolUseId) => {
    const preInput = input as PreToolUseHookInput;
    const toolInput = preInput.tool_input as Record<string, unknown>;
    const rawPath = (toolInput?.file_path ?? toolInput?.path) as string | undefined;

    // No path to check (e.g. Bash tool) — allow
    if (!rawPath) return {};

    // Resolve the candidate path, then follow symlinks to get the real target.
    // If the file doesn't exist yet (new file write), realpathSync throws —
    // fall back to resolving the parent directory which must exist.
    const candidatePath = nodePath.resolve(resolvedRepo, rawPath);
    let resolvedPath: string;
    try {
      resolvedPath = fs.realpathSync(candidatePath);
    } catch {
      // File doesn't exist yet — resolve parent dir + filename
      const parentDir = nodePath.dirname(candidatePath);
      try {
        resolvedPath = nodePath.join(fs.realpathSync(parentDir), nodePath.basename(candidatePath));
      } catch {
        // Parent also doesn't exist — use candidate as-is (will fail the prefix check
        // if it's outside the repo, which is the safe default)
        resolvedPath = candidatePath;
      }
    }

    // Check 1: path traversal / outside repo (using real paths to defeat symlink bypass)
    if (!resolvedPath.startsWith(resolvedRepo + nodePath.sep) && resolvedPath !== resolvedRepo) {
      const reason = `Security: write outside repo path blocked (${rawPath})`;
      logger.warn({ type: 'audit', tool: preInput.tool_name, path: rawPath, reason, toolUseId }, 'tool_blocked');
      return {
        systemMessage: `File write blocked: "${rawPath}" is outside the repository. Only files within ${resolvedRepo} may be modified.`,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny' as const,
          permissionDecisionReason: reason,
        },
      };
    }

    // Check 2: sensitive file patterns
    const relativePath = nodePath.relative(resolvedRepo, resolvedPath);
    for (const pattern of SENSITIVE_PATTERNS) {
      if (pattern.test(relativePath)) {
        const reason = `Security: write to sensitive file blocked (${relativePath})`;
        logger.warn({ type: 'audit', tool: preInput.tool_name, path: relativePath, reason, toolUseId }, 'tool_blocked');
        return {
          systemMessage: `File write blocked: "${relativePath}" matches a sensitive file pattern and cannot be modified.`,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny' as const,
            permissionDecisionReason: reason,
          },
        };
      }
    }

    return {}; // Allow
  };
}

/**
 * Build a PostToolUse hook that logs audit events and increments
 * the tool call counter (SDK-07).
 */
function buildPostToolUseHook(logger: pino.Logger, counterRef: { count: number }): HookCallback {
  return async (input, toolUseId) => {
    const postInput = input as PostToolUseHookInput;
    const toolInput = postInput.tool_input as Record<string, unknown>;
    const filePath = (toolInput?.file_path ?? toolInput?.path) as string | undefined;

    counterRef.count++;

    logger.info({
      type: 'audit',
      tool: postInput.tool_name,
      path: filePath,
      timestamp: new Date().toISOString(),
      toolUseId,
    }, 'file_changed');

    return {};
  };
}

/**
 * Extended SDK result fields not yet in the published type definitions.
 * Remove once @anthropic-ai/claude-agent-sdk exports these (P-2).
 */
type SDKResultFields = SDKResultMessage & {
  result?: string;
  errors?: string[];
};

/**
 * Map an SDKResultMessage to the SessionResult interface (SDK-10).
 */
function mapSDKResult(
  finalResult: SDKResultMessage | undefined,
  sessionId: string,
  toolCallCount: number,
  duration: number,
  logger: pino.Logger,
): SessionResult {
  if (!finalResult) {
    return {
      sessionId,
      status: 'failed',
      toolCallCount,
      duration,
      finalResponse: '',
      error: 'No result message received',
    };
  }

  // Log SDK-specific cost data (NOT added to SessionResult per architecture decision)
  logger.info({
    totalCostUsd: finalResult.total_cost_usd,
    numTurns: finalResult.num_turns,
    usage: finalResult.usage,
  }, 'sdk_session_cost');

  switch (finalResult.subtype) {
    case 'success':
      return {
        sessionId,
        status: 'success',
        toolCallCount,
        duration,
        finalResponse: (finalResult as SDKResultFields).result ?? '',
      };

    case 'error_max_turns':
      return {
        sessionId,
        status: 'turn_limit',
        toolCallCount,
        duration,
        finalResponse: '',
        error: 'Turn limit exceeded',
      };

    case 'error_max_budget_usd':
      // Budget exhaustion is terminal (no retry) — same as turn_limit
      return {
        sessionId,
        status: 'turn_limit',
        toolCallCount,
        duration,
        finalResponse: '',
        error: 'Session budget exceeded',
      };

    case 'error_during_execution':
    default:
      return {
        sessionId,
        status: 'failed',
        toolCallCount,
        duration,
        finalResponse: '',
        error: (finalResult as SDKResultFields).errors?.join('; ') ?? 'Session failed',
      };
  }
}

/**
 * ClaudeCodeSession wraps the Claude Agent SDK `query()` function with:
 * - Security hooks (PreToolUse: path blocking, PostToolUse: audit logging)
 * - Correct SDK options (permissionMode, disallowedTools, maxTurns, maxBudgetUsd)
 * - SessionResult interface compatible with RetryOrchestrator
 */
export class ClaudeCodeSession {
  private config: SessionConfig;
  private abortController: AbortController | null = null;

  constructor(config: SessionConfig) {
    this.config = config;
  }

  /**
   * No-op: SDK needs no container startup.
   */
  async start(): Promise<void> {}

  /**
   * Execute an agent session using the Claude Agent SDK query().
   *
   * @param userMessage - The end-state prompt describing the desired outcome
   * @param logger - Optional Pino logger for structured logging and audit events
   */
  async run(userMessage: string, logger?: pino.Logger): Promise<SessionResult> {
    const log = logger ?? pino({ level: 'silent' });
    const sessionId = crypto.randomUUID();
    const workspaceDir = nodePath.resolve(this.config.workspaceDir);
    const startTime = Date.now();
    const toolCallCounter = { count: 0 };

    this.abortController = new AbortController();

    // Timeout guard — aborts SDK query when timeoutMs elapses
    const timeoutMs = this.config.timeoutMs ?? 300_000;
    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      log.warn({ sessionId, toolCallCount: toolCallCounter.count }, 'Session timeout reached');
      this.abortController?.abort();
    }, timeoutMs);

    const preHook = buildPreToolUseHook(workspaceDir, log);
    const postHook = buildPostToolUseHook(log, toolCallCounter);

    const verifierServer = createVerifierMcpServer(workspaceDir);
    log.info({ type: 'mcp', server: 'verifier', tools: ['verify'] }, 'mcp_server_registered');

    let queryGen: ReturnType<typeof query> | null = null;

    try {
      queryGen = query({
        prompt: userMessage,
        options: {
          cwd: workspaceDir,
          maxTurns: this.config.turnLimit ?? 10,         // SDK-05
          maxBudgetUsd: 2.00,                             // SDK-09
          permissionMode: 'acceptEdits',                  // SDK-03
          disallowedTools: ['WebSearch', 'WebFetch'],     // SDK-04
          model: this.config.model,
          abortController: this.abortController,
          systemPrompt: {
            type: 'preset' as const,
            preset: 'claude_code' as const,
            append: '\n\nBefore stopping, call mcp__verifier__verify to check your changes. Fix any failures before declaring done.',
          },
          mcpServers: {
            verifier: verifierServer,
          },
          hooks: {
            PreToolUse: [{ matcher: 'Write|Edit', hooks: [preHook] }],                         // SDK-08
            PostToolUse: [{ matcher: 'Write|Edit|mcp__verifier__verify', hooks: [postHook] }], // SDK-07
          },
          settingSources: [],  // No filesystem settings — isolation guaranteed
        },
      });

      let finalResult: SDKResultMessage | undefined;

      for await (const message of queryGen) {
        if (message.type === 'result') {
          finalResult = message as SDKResultMessage;
        }
      }

      return mapSDKResult(finalResult, sessionId, toolCallCounter.count, Date.now() - startTime, log);

    } catch (err) {
      if (timedOut) {
        return {
          sessionId,
          status: 'timeout',
          toolCallCount: toolCallCounter.count,
          duration: Date.now() - startTime,
          finalResponse: '',
          error: 'Session timeout reached',
        };
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error({ sessionId, err }, 'ClaudeCodeSession failed');
      return {
        sessionId,
        status: 'failed',
        toolCallCount: toolCallCounter.count,
        duration: Date.now() - startTime,
        finalResponse: '',
        error: errMsg,
      };
    } finally {
      clearTimeout(timeoutHandle);
      // Close generator to prevent subprocess leaks (Pitfall 3)
      if (queryGen) {
        try { await queryGen.return(undefined); } catch {}
      }
      this.abortController = null;
    }
  }

  /**
   * Abort the running query via AbortController.
   * Called by RetryOrchestrator in signal handlers.
   */
  async stop(): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }
}
