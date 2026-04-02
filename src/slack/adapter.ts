import { parseIntent } from '../intent/index.js';
import { LlmParseError } from '../intent/llm-parser.js';
import { runAgent, type AgentOptions, type AgentContext } from '../agent/index.js';
import { ProjectRegistry } from '../agent/registry.js';
import { createLogger } from '../cli/utils/logger.js';
import { buildConfirmationBlocks, buildStatusMessage } from '../slack/blocks.js';
import type { ThreadSession, SlackContext } from '../slack/types.js';
import type { SessionCallbacks, ScopeHint } from '../repl/types.js';
import type { ResolvedIntent } from '../intent/types.js';

/** Default agent options for Slack sessions */
const SLACK_TURN_LIMIT = 30;
const SLACK_TIMEOUT_MS = 300_000;
const SLACK_MAX_RETRIES = 3;

/** Sanitize error messages before posting to Slack (V2) */
function sanitizeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Strip filesystem paths, env var values, and stack traces
  return raw
    .replace(/\/[\w./-]+/g, '[path]')
    .replace(/\b(xoxb|xapp|ghp|gho|sk)-[A-Za-z0-9-]+/g, '[redacted]')
    .slice(0, 200);
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

  // Step 2: Force auto-PR — Slack tasks always create PRs
  intent.createPr = true;
  session.intent = intent;
  session.status = 'confirming';

  // Step 3: Build callbacks
  const callbacks = buildSlackCallbacks(ctx, session);

  // Step 4: Handle low-confidence with clarifications (auto-select)
  if (intent.confidence === 'low' && intent.clarifications && intent.clarifications.length > 0) {
    await callbacks.clarify(intent.clarifications);
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
    createPr: true,
    turnLimit: SLACK_TURN_LIMIT,
    timeoutMs: SLACK_TIMEOUT_MS,
    maxRetries: SLACK_MAX_RETRIES,
  };

  const agentContext: AgentContext = {
    logger: createLogger(),
    signal: callbacks.getSignal(),
    skipDockerChecks: true,
  };

  try {
    await callbacks.onAgentStart?.();
    const result = await runAgent(agentOptions, agentContext);

    if (result.finalStatus === 'success') {
      // P1: Post PR URL if available
      if (result.prResult?.url && !result.prResult.error) {
        await ctx.client.chat.postMessage({
          channel: ctx.channel,
          thread_ts: ctx.threadTs,
          text: `Task completed. PR: ${result.prResult.url}`,
        });
      } else {
        await ctx.client.chat.postMessage({
          channel: ctx.channel,
          thread_ts: ctx.threadTs,
          text: 'Task completed successfully.',
        });
      }
    } else if (result.finalStatus !== 'cancelled') {
      await ctx.client.chat.postMessage({
        channel: ctx.channel,
        thread_ts: ctx.threadTs,
        text: 'Task failed. Check agent logs for details.',
      });
    }
  } catch (err) {
    await ctx.client.chat.postMessage({
      channel: ctx.channel,
      thread_ts: ctx.threadTs,
      text: `Agent run failed: ${sanitizeError(err)}`,
    });
  } finally {
    session.status = 'done';
    callbacks.onAgentEnd?.();
  }
}
