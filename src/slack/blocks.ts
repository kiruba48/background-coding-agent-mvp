import path from 'node:path';
import type { KnownBlock, Block } from '@slack/web-api';
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
 * Build Block Kit blocks for an "End Thread" button posted after task completion.
 */
export function buildEndThreadBlocks(): (KnownBlock | Block)[] {
  const actionsBlock: KnownBlock = {
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: {
          type: 'plain_text',
          text: 'End Thread',
          emoji: false,
        },
        action_id: 'end_thread',
      },
    ],
  };

  return [actionsBlock];
}

/**
 * Build a human-readable thread summary for when a thread is ended.
 */
export function buildThreadSummary(session: { taskCount: number; state: { currentProjectName: string | null; history: Array<{ status: string }> } }): string {
  const taskCount = session.taskCount;
  const project = session.state.currentProjectName ?? 'unknown project';
  const successes = session.state.history.filter(h => h.status === 'success').length;
  const failures = session.state.history.filter(h => h.status === 'failed').length;

  const parts = [`Thread ended — ${taskCount} task${taskCount === 1 ? '' : 's'} run against *${project}*`];
  if (taskCount > 0) {
    const statParts: string[] = [];
    if (successes > 0) statParts.push(`${successes} succeeded`);
    if (failures > 0) statParts.push(`${failures} failed`);
    const other = taskCount - successes - failures;
    if (other > 0) statParts.push(`${other} other`);
    if (statParts.length > 0) parts.push(`(${statParts.join(', ')})`);
  }
  return parts.join(' ');
}

/**
 * Strip Slack bot mention(s) from the start of a message.
 *
 * Removes patterns like `<@U012AB3CD>` (including trailing whitespace)
 * then trims the result.
 */
export function stripMention(text: string): string {
  return text.replace(/<@[A-Za-z0-9]+>\s*/g, '').trim();
}
