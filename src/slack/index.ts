import { App, LogLevel } from '@slack/bolt';
import type { BlockAction } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { createSessionState } from '../repl/session.js';
import { ProjectRegistry } from '../agent/registry.js';
import { WorktreeManager } from '../agent/worktree-manager.js';
import { processSlackMention } from './adapter.js';
import { stripMention } from './blocks.js';
import type { ThreadSession, SlackContext } from './types.js';

/** Module-level per-thread session state map */
const threadSessions = new Map<string, ThreadSession>();

/** Shared registry — reads from persisted config, avoids per-mention allocation (P6) */
let sharedRegistry: ProjectRegistry | null = null;

/** Rate limit: max mentions per user within the window (V3) */
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 5;
const userMentionTimestamps = new Map<string, number[]>();

/** Session TTL — stale sessions evicted after this duration (P3) */
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

/** Expose sessions for testing */
export function getThreadSessions(): Map<string, ThreadSession> {
  return threadSessions;
}

/**
 * Validate required environment variables.
 * Throws with a descriptive message if either token is missing.
 */
function validateConfig(): void {
  if (!process.env.SLACK_BOT_TOKEN) {
    throw new Error('Missing SLACK_BOT_TOKEN environment variable');
  }
  if (!process.env.SLACK_APP_TOKEN) {
    throw new Error('Missing SLACK_APP_TOKEN environment variable');
  }
}

/** Check per-user rate limit (V3). Returns true if under limit. */
function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const timestamps = userMentionTimestamps.get(userId) ?? [];
  const recent = timestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) {
    userMentionTimestamps.set(userId, recent);
    return false;
  }
  recent.push(now);
  userMentionTimestamps.set(userId, recent);
  return true;
}

/** Evict stale sessions that exceeded TTL (P3) */
function evictStaleSessions(): void {
  const now = Date.now();
  for (const [key, session] of threadSessions) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      session.abortController.abort();
      session.pendingConfirm?.resolve(null);
      threadSessions.delete(key);
    }
  }
}

/** Extract thread_ts, channel, and message ts from a BlockAction body with null guards (S2, S3) */
function extractActionContext(body: BlockAction): {
  channelId: string | undefined;
  confirmMsgTs: string | undefined;
  threadTs: string | undefined;
} {
  const channelId = body.channel?.id;
  const confirmMsgTs = body.message?.ts;
  // BlockAction.message doesn't expose thread_ts in types — access via indexed type
  const msg = body.message as Record<string, unknown> | undefined;
  const threadTs = (msg?.thread_ts as string | undefined) ?? confirmMsgTs;
  return { channelId, confirmMsgTs, threadTs };
}

/**
 * Handle app_mention events — create session and run agent pipeline.
 *
 * Exported for testability (so tests can call directly without a full Bolt app).
 */
export async function handleAppMention(
  event: { text: string; channel: string; ts: string; thread_ts?: string; user?: string },
  client: Pick<WebClient, 'chat'>,
): Promise<void> {
  const threadTs = event.thread_ts ?? event.ts;
  const userId = event.user ?? 'unknown';
  const text = stripMention(event.text);

  if (!text) {
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: 'Please include a task description after the mention.',
    });
    return;
  }

  // V3: Rate limit check
  if (!checkRateLimit(userId)) {
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: 'Rate limit reached. Please wait a minute before submitting another task.',
    });
    return;
  }

  const session: ThreadSession = {
    userId,
    status: 'confirming',
    createdAt: Date.now(),
    state: createSessionState(),
    abortController: new AbortController(),
  };
  threadSessions.set(threadTs, session);

  const ctx: SlackContext = {
    client: client as WebClient,
    channel: event.channel,
    threadTs,
  };

  if (!sharedRegistry) {
    sharedRegistry = new ProjectRegistry();
  }

  // P2: processSlackMention now awaits the agent run, so .finally() fires after completion
  void processSlackMention(text, ctx, session, sharedRegistry)
    .catch((err: Error) => {
      void client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: 'Something went wrong processing your request.',
      });
    })
    .finally(() => {
      threadSessions.delete(threadTs);
    });
}

/**
 * Handle "proceed_task" button action.
 *
 * IMPORTANT: ack() MUST be called first — Slack has a 3-second deadline.
 * Exported for testability.
 */
export async function handleProceedAction(
  ack: () => Promise<void>,
  body: BlockAction,
  client: Pick<WebClient, 'chat'>,
): Promise<void> {
  await ack();

  const { channelId, confirmMsgTs, threadTs } = extractActionContext(body);

  if (!channelId || !threadTs) return;

  const session = threadSessions.get(threadTs);

  if (!session) {
    await client.chat.postMessage({
      channel: channelId,
      text: 'Session expired or already completed.',
    });
    return;
  }

  // V1: Authorization check — only the user who initiated can proceed
  if (body.user?.id && body.user.id !== session.userId) {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: 'Only the user who initiated this task can confirm it.',
    });
    return;
  }

  // P5: State machine guard — only valid from 'confirming'
  if (session.status !== 'confirming' || !session.pendingConfirm) {
    await client.chat.postMessage({
      channel: channelId,
      text: 'Already processing.',
    });
    return;
  }

  // Update confirmation message to remove buttons and show running state
  if (confirmMsgTs) {
    await client.chat.update({
      channel: channelId,
      ts: confirmMsgTs,
      text: 'Confirmed — running...',
      blocks: [],
    });
  }

  // Resolve the deferred confirm with the session's intent
  const resolve = session.pendingConfirm.resolve;
  delete session.pendingConfirm;
  resolve(session.intent ?? null);
}

/**
 * Handle "cancel_task" button action.
 *
 * IMPORTANT: ack() MUST be called first — Slack has a 3-second deadline.
 * Exported for testability.
 */
export async function handleCancelAction(
  ack: () => Promise<void>,
  body: BlockAction,
  client: Pick<WebClient, 'chat'>,
): Promise<void> {
  await ack();

  const { channelId, confirmMsgTs, threadTs } = extractActionContext(body);

  if (!channelId || !threadTs) return;

  const session = threadSessions.get(threadTs);

  if (!session) {
    // Return silently — session may have already been cleaned up
    return;
  }

  // V1: Authorization check
  if (body.user?.id && body.user.id !== session.userId) {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: 'Only the user who initiated this task can cancel it.',
    });
    return;
  }

  // P5: Only cancel from 'confirming' state
  if (session.status !== 'confirming') return;

  // Update confirmation message to show cancelled state
  if (confirmMsgTs) {
    await client.chat.update({
      channel: channelId,
      ts: confirmMsgTs,
      text: 'Cancelled.',
      blocks: [],
    });
  }

  // Resolve deferred confirm with null (user cancelled)
  session.pendingConfirm?.resolve(null);

  // P2: Don't delete session here — .finally() in handleAppMention handles cleanup
}

/**
 * Start the Slack bot in Socket Mode.
 *
 * Validates config, creates Bolt App, registers event/action handlers,
 * and calls app.start() to connect via WebSocket.
 */
export async function startSlack(): Promise<void> {
  validateConfig();

  const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
    logLevel: LogLevel.WARN,
  });

  app.event('app_mention', async ({ event, client }) => {
    await handleAppMention(event, client);
  });

  app.action('proceed_task', async ({ ack, body, client }) => {
    await handleProceedAction(ack, body as BlockAction, client);
  });

  app.action('cancel_task', async ({ ack, body, client }) => {
    await handleCancelAction(ack, body as BlockAction, client);
  });

  // P3: Periodic eviction of stale sessions
  setInterval(evictStaleSessions, SESSION_TTL_MS / 2);

  // Opportunistic orphan scan — prune stale worktrees from crashed sessions.
  // Scan all registered project repos, not just cwd — Slack handles multiple repos.
  try {
    const registry = new ProjectRegistry();
    const repoPaths = Object.values(registry.list());
    for (const repoPath of repoPaths) {
      try {
        await WorktreeManager.pruneOrphans(repoPath);
      } catch {
        // Per-repo failure — continue to next
      }
    }
  } catch {
    // Non-fatal — orphan scan failure should not block Slack startup
  }

  await app.start();
  console.log('Slack bot connected via Socket Mode');
}
