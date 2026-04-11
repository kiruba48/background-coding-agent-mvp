import { parseIntent } from '../intent/index.js';
import { LlmParseError } from '../intent/llm-parser.js';
import { runAgent, type AgentOptions, type AgentContext } from '../agent/index.js';
import { ProjectRegistry } from '../agent/registry.js';
import { createLogger } from '../cli/utils/logger.js';
import { buildConfirmationBlocks } from '../slack/blocks.js';
import { appendHistory } from '../repl/session.js';
import type { ThreadSession, SlackContext } from '../slack/types.js';
import type { SessionCallbacks, ScopeHint, TaskHistoryEntry } from '../repl/types.js';
import { toHistoryStatus, MAX_HISTORY_DESCRIPTION_LENGTH } from '../repl/types.js';
import type { ResolvedIntent } from '../intent/types.js';
import type { RetryResult } from '../types.js';

/** Maximum input length for investigation description (characters) */
const MAX_INPUT_LENGTH = 500;

/** Default agent options for Slack sessions */
const SLACK_TURN_LIMIT = 30;
const SLACK_TIMEOUT_MS = 300_000;
const SLACK_MAX_RETRIES = 3;

/** Sanitize error messages before posting to Slack — deny-by-default approach. */
function sanitizeError(err: unknown): string {
  if (err instanceof Error) {
    // Only expose the error class name and a generic truncated message
    // with all paths, tokens, and env values stripped
    const name = err.name || 'Error';
    const msg = err.message
      .replace(/[A-Za-z]:\\[\w\\./-]+/g, '[path]')        // Windows paths
      .replace(/\/[\w.@~/-]+/g, '[path]')                  // Unix paths (including @ and ~)
      .replace(/\b(xoxb|xapp|ghp|gho|sk|npm_|AKIA)[A-Za-z0-9_-]+/g, '[redacted]') // tokens/keys
      .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')      // bearer tokens
      .slice(0, 150);
    return `${name}: ${msg}`;
  }
  return 'Unknown error';
}

/**
 * Build a SessionCallbacks implementation backed by the Slack API.
 *
 * - confirm: Posts Block Kit confirmation buttons and blocks on the deferred promise.
 * - clarify: Auto-selects the first clarification option (no interactive menu in v2.3).
 * - getSignal: Returns the AbortSignal for the thread's AbortController.
 * - onAgentStart: Posts a "Running..." thread message.
 * - onAgentEnd: No-op (result posting handled in processSlackMention).
 * - askQuestion: NOT implemented — scoping dialogue bypassed for Slack v2.3.
 */
export function buildSlackCallbacks(ctx: SlackContext, session: ThreadSession): SessionCallbacks {
  return {
    confirm: async (
      intent: ResolvedIntent,
      _reparse: (correction: string) => Promise<ResolvedIntent>,
      _scopeHints?: ScopeHint[],
    ): Promise<ResolvedIntent | null> => {
      // Post Block Kit confirmation message with proceed/cancel buttons
      const result = await ctx.client.chat.postMessage({
        channel: ctx.channel,
        thread_ts: ctx.threadTs,
        text: 'Confirm task',
        blocks: buildConfirmationBlocks(intent),
      });

      // Store message ts for potential chat.update (replace buttons on click)
      if (result.ts) {
        session.confirmationMessageTs = result.ts as string;
      }

      // Return a deferred promise — resolved by the action handler when user clicks
      return new Promise<ResolvedIntent | null>((resolve) => {
        session.pendingConfirm = { resolve };
      });
    },

    clarify: async (clarifications: Array<{ label: string; intent: string }>): Promise<string | null> => {
      const first = clarifications[0];
      if (!first) return null;

      // Auto-select first option and notify user in thread
      await ctx.client.chat.postMessage({
        channel: ctx.channel,
        thread_ts: ctx.threadTs,
        text: `Multiple interpretations found. Proceeding with: ${first.label}`,
      });

      return first.intent;
    },

    getSignal: (): AbortSignal => {
      return session.abortController.signal;
    },

    onAgentStart: async (): Promise<void> => {
      await ctx.client.chat.postMessage({
        channel: ctx.channel,
        thread_ts: ctx.threadTs,
        text: 'Running...',
      });
    },

    onAgentEnd: (): void => {
      // No-op — result posting handled explicitly in processSlackMention
    },

    // askQuestion is intentionally omitted — scoping dialogue bypassed for Slack v2.3
  };
}

/**
 * Process a Slack app_mention event.
 *
 * Full pipeline: parse intent → (clarify if low-confidence) → confirm via Block Kit
 * → run agent → post result/PR link to thread.
 *
 * The confirm step blocks on a deferred promise that is resolved by the Bolt
 * action handler (proceed_task / cancel_task button clicks).
 */
export async function processSlackMention(
  text: string,
  ctx: SlackContext,
  session: ThreadSession,
  registry: ProjectRegistry,
): Promise<void> {
  // Step 1: Parse intent
  let intent: ResolvedIntent;
  try {
    intent = await parseIntent(text, {
      registry,
      history: session.state.history,
    });
  } catch (err) {
    if (err instanceof LlmParseError) {
      await ctx.client.chat.postMessage({
        channel: ctx.channel,
        thread_ts: ctx.threadTs,
        text: 'Could not understand that request. Try rephrasing as a specific action.',
      });
      return;
    }
    throw err;
  }

  // Step 1b: Reject if project was mentioned but not found in registry
  if (intent.unresolvedProject) {
    const registeredNames = Object.keys(registry.list());
    const suggestions = registeredNames.length > 0
      ? `\nRegistered projects: ${registeredNames.join(', ')}`
      : '\nNo projects registered yet. Run the CLI from a project directory to auto-register it.';
    await ctx.client.chat.postMessage({
      channel: ctx.channel,
      thread_ts: ctx.threadTs,
      text: `Project "${intent.unresolvedProject}" is not registered.${suggestions}`,
    });
    return;
  }

  // Step 2: Force auto-PR — Slack tasks always create PRs (except investigation)
  if (intent.taskType !== 'investigation') {
    intent.createPr = true;
  }

  // Set description for investigation tasks (fast-path doesn't set it)
  if (intent.taskType === 'investigation' && !intent.description) {
    intent.description = text.slice(0, MAX_INPUT_LENGTH);
  }

  session.intent = intent;
  session.status = 'confirming';

  // Step 3: Build callbacks
  const callbacks = buildSlackCallbacks(ctx, session);

  // Step 4: Handle low-confidence with clarifications (auto-select)
  if (intent.confidence === 'low' && intent.clarifications && intent.clarifications.length > 0) {
    const selectedIntent = await callbacks.clarify(intent.clarifications);
    if (selectedIntent) {
      // Re-parse with the selected clarification for a refined intent
      const enriched = `${text} — specifically: ${selectedIntent}`;
      const reparsed = await parseIntent(enriched, {
        registry,
        history: session.state.history,
      });
      reparsed.confidence = 'high';
      reparsed.createPr = true;
      intent = reparsed;
    }
  }

  // Step 5: Post Block Kit confirmation and wait for button click
  const confirmed = await callbacks.confirm(intent, async () => intent);

  if (!confirmed) {
    // User cancelled — action handler already updated the message (P4: no double update)
    session.status = 'done';
    return;
  }

  // Step 6: Run agent (awaited — P2: session stays alive until agent completes)
  session.status = 'running';

  const agentOptions: AgentOptions = {
    taskType: confirmed.taskType,
    repo: confirmed.repo,
    dep: confirmed.dep ?? undefined,
    targetVersion: confirmed.version ?? undefined,
    description: confirmed.description,
    taskCategory: confirmed.taskCategory ?? undefined,
    createPr: confirmed.taskType === 'investigation' ? false : true,
    turnLimit: SLACK_TURN_LIMIT,
    timeoutMs: SLACK_TIMEOUT_MS,
    maxRetries: SLACK_MAX_RETRIES,
    explorationSubtype: confirmed.explorationSubtype,
  };

  const agentContext: AgentContext = {
    logger: createLogger(),
    signal: callbacks.getSignal(),
    skipDockerChecks: true,
  };

  // Non-critical notification — don't let it block agent execution (P3)
  try { await callbacks.onAgentStart?.(); } catch { /* Slack API failure is non-fatal */ }

  let historyStatus: TaskHistoryEntry['status'] = 'failed';
  let taskResult: RetryResult | undefined;
  try {
    const result = await runAgent(agentOptions, agentContext);
    taskResult = result;

    historyStatus = toHistoryStatus(result.finalStatus);

    // Investigation tasks: post report as thread message (truncate to Slack's 40K limit)
    if (confirmed.taskType === 'investigation') {
      const report = result.sessionResults.at(-1)?.finalResponse;
      const SLACK_TEXT_LIMIT = 39_000; // Leave margin below Slack's 40K char limit
      let text = report || 'Exploration produced no report.';
      if (text.length > SLACK_TEXT_LIMIT) {
        text = text.slice(0, SLACK_TEXT_LIMIT) + '\n\n_(report truncated — full report exceeded Slack message limit)_';
      }
      await ctx.client.chat.postMessage({
        channel: ctx.channel,
        thread_ts: ctx.threadTs,
        text,
      });
    } else {
      const statusMessages: Record<TaskHistoryEntry['status'], string> = {
        success: result.prResult?.url && !result.prResult.error
          ? `Task completed. PR: ${result.prResult.url}`
          : 'Task completed successfully.',
        cancelled: 'Task was cancelled.',
        zero_diff: 'Task completed with no changes.',
        failed: 'Task failed. Check agent logs for details.',
      };
      await ctx.client.chat.postMessage({
        channel: ctx.channel,
        thread_ts: ctx.threadTs,
        text: statusMessages[historyStatus],
      });
    }
  } catch (err) {
    historyStatus = 'failed';
    try {
      await ctx.client.chat.postMessage({
        channel: ctx.channel,
        thread_ts: ctx.threadTs,
        text: `Agent run failed: ${sanitizeError(err)}`,
      });
    } catch { /* Don't mask the original error if Slack is also down */ }
  } finally {
    // Append to session history for multi-turn follow-up context
    appendHistory(session.state, {
      taskType: confirmed.taskType,
      dep: confirmed.dep ?? null,
      version: confirmed.version ?? null,
      repo: confirmed.repo,
      status: historyStatus,
      description: confirmed.taskType === 'generic' || confirmed.taskType === 'investigation'
        ? (confirmed.description ?? text.slice(0, MAX_HISTORY_DESCRIPTION_LENGTH))
        : confirmed.dep
          ? `update ${confirmed.dep} to ${confirmed.version ?? 'latest'}`
          : undefined,
      finalResponse: taskResult?.sessionResults?.at(-1)?.finalResponse,
    });
    session.status = 'done';
    callbacks.onAgentEnd?.();
  }
}
