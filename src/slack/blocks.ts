import path from 'node:path';
import type { KnownBlock, Block } from '@slack/bolt';
import type { ResolvedIntent } from '../intent/types.js';

/**
 * Build Block Kit confirmation blocks for a task intent.
 *
 * Returns a section block summarising the task details followed by an
 * actions block with "Proceed" (primary) and "Cancel" (danger) buttons.
 */
export function buildConfirmationBlocks(intent: ResolvedIntent): (KnownBlock | Block)[] {
  const repoName = path.basename(intent.repo);

  let summaryText: string;
  if (intent.taskType === 'npm-dependency-update' || intent.taskType === 'maven-dependency-update') {
    const versionStr = intent.version ?? 'latest';
    summaryText = `*Dep update:* ${intent.dep} -> ${versionStr}\n*Repo:* ${repoName}`;
  } else {
    summaryText = `*Task:* ${intent.description ?? 'No description'}\n*Repo:* ${repoName}`;
  }

  const sectionBlock: KnownBlock = {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: summaryText,
    },
  };

  const actionsBlock: KnownBlock = {
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: {
          type: 'plain_text',
          text: 'Proceed',
          emoji: false,
        },
        style: 'primary',
        action_id: 'proceed_task',
      },
      {
        type: 'button',
        text: {
          type: 'plain_text',
          text: 'Cancel',
          emoji: false,
        },
        style: 'danger',
        action_id: 'cancel_task',
      },
    ],
  };

  return [sectionBlock, actionsBlock];
}

/**
 * Build Block Kit intent display blocks (no buttons).
 *
 * Same content as confirmation but without the actions block.
 * Used for showing parsed intent details in the thread.
 */
export function buildIntentBlocks(intent: ResolvedIntent): (KnownBlock | Block)[] {
  const repoName = path.basename(intent.repo);

  let summaryText: string;
  if (intent.taskType === 'npm-dependency-update' || intent.taskType === 'maven-dependency-update') {
    const versionStr = intent.version ?? 'latest';
    summaryText = `*Task type:* ${intent.taskType}\n*Dep update:* ${intent.dep} -> ${versionStr}\n*Repo:* ${repoName}`;
  } else {
    summaryText = `*Task type:* ${intent.taskType}\n*Task:* ${intent.description ?? 'No description'}\n*Repo:* ${repoName}`;
  }

  const sectionBlock: KnownBlock = {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: summaryText,
    },
  };

  return [sectionBlock];
}

/**
 * Build a simple status message block.
 *
 * Returns a single mrkdwn section block with the given text.
 * Used for "Running...", "Cancelled.", error summaries, etc.
 */
export function buildStatusMessage(text: string): (KnownBlock | Block)[] {
  const sectionBlock: KnownBlock = {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text,
    },
  };

  return [sectionBlock];
}

/**
 * Strip Slack bot mention(s) from the start of a message.
 *
 * Removes patterns like `<@U012AB3CD>` (including trailing whitespace)
 * then trims the result.
 */
export function stripMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>\s*/g, '').trim();
}
