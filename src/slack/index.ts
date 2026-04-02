import { App, LogLevel } from '@slack/bolt';
import type { BlockAction } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { createSessionState } from '../repl/session.js';
import { ProjectRegistry } from '../agent/registry.js';
import { processSlackMention } from './adapter.js';
import { stripMention } from './blocks.js';
import type { ThreadSession, SlackContext } from './types.js';

/** Module-level per-thread session state map */
const threadSessions = new Map<string, ThreadSession>();

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

/**
 * Handle app_mention events — create session and fire-and-forget agent run.
 *
 * Exported for testability (so tests can call directly without a full Bolt app).
 */
export async function handleAppMention(
  event: { text: string; channel: string; ts: string; thread_ts?: string },
  client: Pick<WebClient, 'chat'>,
): Promise<void> {
  const threadTs = event.thread_ts ?? event.ts;
  const text = stripMention(event.text);

  if (!text) {
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: threadTs,
      text: 'Please include a task description after the mention.',
    });
    return;
  }

  const session: ThreadSession = {
    state: createSessionState(),
    abortController: new AbortController(),
  };
  threadSessions.set(threadTs, session);

  const ctx: SlackContext = {
    client: client as WebClient,
    channel: event.channel,
    threadTs,
  };

  const registry = new ProjectRegistry();

  // Fire-and-forget: agent run is decoupled from Bolt event handler
  void processSlackMention(text, ctx, session, registry)
    .catch((err: Error) => {
      void client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: 'Internal error: ' + err.message,
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

  const channelId = body.channel?.id;
  const confirmMsgTs = body.message?.ts;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const threadTs = (body.message as any)?.thread_ts ?? confirmMsgTs;

  const session = threadSessions.get(threadTs as string);

  if (!session) {
    await client.chat.postMessage({
      channel: channelId as string,
      text: 'Session expired or already completed.',
    });
    return;
  }

  // Double-click guard: if pendingConfirm already resolved, don't process again
  if (!session.pendingConfirm) {
    await client.chat.postMessage({
      channel: channelId as string,
      text: 'Already processing.',
    });
    return;
  }

  // Update confirmation message to remove buttons and show running state
  await client.chat.update({
    channel: channelId as string,
    ts: confirmMsgTs as string,
    text: 'Confirmed — running...',
    blocks: [],
  });

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

  const channelId = body.channel?.id;
  const confirmMsgTs = body.message?.ts;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const threadTs = (body.message as any)?.thread_ts ?? confirmMsgTs;

  const session = threadSessions.get(threadTs as string);

  if (!session) {
    // Return silently — session may have already been cleaned up
    return;
  }

  // Update confirmation message to show cancelled state
  await client.chat.update({
    channel: channelId as string,
    ts: confirmMsgTs as string,
    text: 'Cancelled.',
    blocks: [],
  });

  // Resolve deferred confirm with null (user cancelled)
  session.pendingConfirm?.resolve(null);

  // Clean up session immediately
  threadSessions.delete(threadTs as string);
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

  await app.start();
  console.log('Slack bot connected via Socket Mode');
}
