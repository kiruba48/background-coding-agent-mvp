import { describe, it, expect } from 'vitest';
import { buildConfirmationBlocks, buildIntentBlocks, buildStatusMessage, stripMention } from '../slack/blocks.js';
import type { ResolvedIntent } from '../intent/types.js';

const genericIntent: ResolvedIntent = {
  taskType: 'generic',
  repo: '/home/user/projects/my-app',
  dep: null,
  version: null,
  confidence: 'high',
  description: 'Add error handling to auth module',
  scopingQuestions: [],
};

const depUpdateIntent: ResolvedIntent = {
  taskType: 'npm-dependency-update',
  repo: '/home/user/projects/my-app',
  dep: 'lodash',
  version: '4.17.21',
  confidence: 'high',
  scopingQuestions: [],
};

const depUpdateNoVersionIntent: ResolvedIntent = {
  taskType: 'npm-dependency-update',
  repo: '/home/user/projects/my-app',
  dep: 'react',
  version: null,
  confidence: 'high',
  scopingQuestions: [],
};

describe('buildConfirmationBlocks', () => {
  it('returns array with section block and actions block for generic intent', () => {
    const blocks = buildConfirmationBlocks(genericIntent);
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks.length).toBeGreaterThanOrEqual(2);

    const sectionBlock = blocks.find((b) => b.type === 'section');
    expect(sectionBlock).toBeDefined();

    const actionsBlock = blocks.find((b) => b.type === 'actions');
    expect(actionsBlock).toBeDefined();
  });

  it('section block for generic intent contains task description and repo', () => {
    const blocks = buildConfirmationBlocks(genericIntent);
    const sectionBlock = blocks.find((b) => b.type === 'section') as { type: string; text?: { text: string } };
    expect(sectionBlock?.text?.text).toContain('Add error handling to auth module');
    expect(sectionBlock?.text?.text).toContain('my-app');
  });

  it('section block for dep-update intent contains dep name and version', () => {
    const blocks = buildConfirmationBlocks(depUpdateIntent);
    const sectionBlock = blocks.find((b) => b.type === 'section') as { type: string; text?: { text: string } };
    expect(sectionBlock?.text?.text).toContain('lodash');
    expect(sectionBlock?.text?.text).toContain('4.17.21');
    expect(sectionBlock?.text?.text).toContain('my-app');
  });

  it('dep-update intent without version shows "latest"', () => {
    const blocks = buildConfirmationBlocks(depUpdateNoVersionIntent);
    const sectionBlock = blocks.find((b) => b.type === 'section') as { type: string; text?: { text: string } };
    expect(sectionBlock?.text?.text).toContain('react');
    expect(sectionBlock?.text?.text).toContain('latest');
  });

  it('actions block contains Proceed button with action_id proceed_task and style primary', () => {
    const blocks = buildConfirmationBlocks(genericIntent);
    const actionsBlock = blocks.find((b) => b.type === 'actions') as { type: string; elements?: Array<{ type: string; action_id: string; style?: string }> };
    const proceedBtn = actionsBlock?.elements?.find((e) => e.action_id === 'proceed_task');
    expect(proceedBtn).toBeDefined();
    expect(proceedBtn?.style).toBe('primary');
  });

  it('actions block contains Cancel button with action_id cancel_task and style danger', () => {
    const blocks = buildConfirmationBlocks(genericIntent);
    const actionsBlock = blocks.find((b) => b.type === 'actions') as { type: string; elements?: Array<{ type: string; action_id: string; style?: string }> };
    const cancelBtn = actionsBlock?.elements?.find((e) => e.action_id === 'cancel_task');
    expect(cancelBtn).toBeDefined();
    expect(cancelBtn?.style).toBe('danger');
  });
});

describe('buildIntentBlocks', () => {
  it('returns section block with mrkdwn text containing taskType and repo', () => {
    const blocks = buildIntentBlocks(genericIntent);
    expect(Array.isArray(blocks)).toBe(true);

    const sectionBlock = blocks.find((b) => b.type === 'section') as { type: string; text?: { type: string; text: string } };
    expect(sectionBlock).toBeDefined();
    expect(sectionBlock?.text?.type).toBe('mrkdwn');
    expect(sectionBlock?.text?.text).toContain('generic');
    expect(sectionBlock?.text?.text).toContain('my-app');
  });

  it('does not contain an actions block (no buttons)', () => {
    const blocks = buildIntentBlocks(genericIntent);
    const actionsBlock = blocks.find((b) => b.type === 'actions');
    expect(actionsBlock).toBeUndefined();
  });
});

describe('buildStatusMessage', () => {
  it('returns single section block with mrkdwn text', () => {
    const blocks = buildStatusMessage('Running...');
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks.length).toBe(1);

    const sectionBlock = blocks[0] as { type: string; text?: { type: string; text: string } };
    expect(sectionBlock.type).toBe('section');
    expect(sectionBlock?.text?.type).toBe('mrkdwn');
    expect(sectionBlock?.text?.text).toBe('Running...');
  });

  it('passes through any text content', () => {
    const blocks = buildStatusMessage('Task cancelled.');
    const sectionBlock = blocks[0] as { type: string; text?: { type: string; text: string } };
    expect(sectionBlock?.text?.text).toBe('Task cancelled.');
  });
});

describe('stripMention', () => {
  it('removes single bot mention from start of text', () => {
    expect(stripMention('<@U012AB3CD> update lodash')).toBe('update lodash');
  });

  it('removes multiple bot mentions', () => {
    expect(stripMention('<@U012AB3CD> <@UBOT1234> do something')).toBe('do something');
  });

  it('returns empty string when only mention present after trim', () => {
    expect(stripMention('<@U012AB3CD>')).toBe('');
  });

  it('handles mention with trailing whitespace', () => {
    expect(stripMention('<@U012AB3CD>   fix the bug')).toBe('fix the bug');
  });

  it('returns text unchanged if no mention present', () => {
    expect(stripMention('update lodash to latest')).toBe('update lodash to latest');
  });

  it('handles mention IDs with lowercase characters (S7)', () => {
    expect(stripMention('<@Uabc123XY> fix tests')).toBe('fix tests');
  });
});
