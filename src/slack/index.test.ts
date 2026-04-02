import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BlockAction } from '@slack/bolt';

// --- Module mocks (must be at top, before any imports) ---

// Mock @slack/bolt App
const mockAppEvent = vi.fn();
const mockAppAction = vi.fn();
const mockAppStart = vi.fn().mockResolvedValue(undefined);

vi.mock('@slack/bolt', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const AppMock = vi.fn().mockImplementation(function (this: any) {
    this.event = mockAppEvent;
    this.action = mockAppAction;
    this.start = mockAppStart;
  });
  return { App: AppMock, LogLevel: { WARN: 'WARN' } };
});

// Mock processSlackMention from adapter
const mockProcessSlackMention = vi.fn().mockResolvedValue(undefined);
vi.mock('./adapter.js', () => ({
  processSlackMention: (...args: unknown[]) => mockProcessSlackMention(...args),
  buildSlackCallbacks: vi.fn(),
}));

// Mock createSessionState
vi.mock('../repl/session.js', () => ({
  createSessionState: vi.fn().mockReturnValue({
    currentProject: null,
    currentProjectName: null,
    history: [],
  }),
}));

// Mock ProjectRegistry
vi.mock('../agent/registry.js', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ProjectRegistry: vi.fn().mockImplementation(function (this: any) {
    this.register = vi.fn();
    this.getAll = vi.fn().mockReturnValue({});
  }),
}));

// --- Import after mocks ---
import {
  startSlack,
  handleAppMention,
  handleProceedAction,
  handleCancelAction,
  getThreadSessions,
} from './index.js';

// Mock client factory
function createMockClient() {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: 'mock-ts' }),
      update: vi.fn().mockResolvedValue({ ok: true }),
    },
  };
}

describe('startSlack — config validation', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('throws when SLACK_BOT_TOKEN is missing', async () => {
    vi.stubEnv('SLACK_BOT_TOKEN', '');
    vi.stubEnv('SLACK_APP_TOKEN', 'xapp-test');

    await expect(startSlack()).rejects.toThrow('Missing SLACK_BOT_TOKEN environment variable');
  });

  it('throws when SLACK_APP_TOKEN is missing', async () => {
    vi.stubEnv('SLACK_BOT_TOKEN', 'xoxb-test');
    vi.stubEnv('SLACK_APP_TOKEN', '');

    await expect(startSlack()).rejects.toThrow('Missing SLACK_APP_TOKEN environment variable');
  });
});

describe('handleAppMention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clean up sessions between tests
    getThreadSessions().clear();
  });

  it('creates a new ThreadSession in the sessions map keyed by threadTs', async () => {
    const client = createMockClient();
    const event = {
      text: '<@U123ABC> update lodash',
      channel: 'C456',
      ts: '111.000',
      thread_ts: undefined,
    };

    await handleAppMention(event as Parameters<typeof handleAppMention>[0], client as Parameters<typeof handleAppMention>[1]);

    // Session should be keyed by ts (since no thread_ts)
    expect(getThreadSessions().has('111.000')).toBe(true);
  });

  it('calls processSlackMention with stripped text, context, session, and registry', async () => {
    const client = createMockClient();
    const event = {
      text: '<@U123ABC> update lodash to latest',
      channel: 'C456',
      ts: '222.000',
      thread_ts: undefined,
    };

    await handleAppMention(event as Parameters<typeof handleAppMention>[0], client as Parameters<typeof handleAppMention>[1]);

    // Wait for the fire-and-forget to start
    await new Promise<void>(resolve => setTimeout(resolve, 0));

    expect(mockProcessSlackMention).toHaveBeenCalledWith(
      'update lodash to latest',
      expect.objectContaining({ channel: 'C456', threadTs: '222.000' }),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it('posts error message to thread when text is empty after stripping mention', async () => {
    const client = createMockClient();
    const event = {
      text: '<@U123ABC>',
      channel: 'C456',
      ts: '333.000',
      thread_ts: undefined,
    };

    await handleAppMention(event as Parameters<typeof handleAppMention>[0], client as Parameters<typeof handleAppMention>[1]);

    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C456',
        thread_ts: '333.000',
        text: 'Please include a task description after the mention.',
      }),
    );
  });

  it('two app_mention events with different threadTs create independent sessions', async () => {
    // Use a promise that never resolves so the finally() cleanup doesn't delete sessions
    // before we can assert on them
    let resolveBlock1: () => void;
    let resolveBlock2: () => void;
    const block1 = new Promise<void>(resolve => { resolveBlock1 = resolve; });
    const block2 = new Promise<void>(resolve => { resolveBlock2 = resolve; });

    mockProcessSlackMention
      .mockReturnValueOnce(block1)
      .mockReturnValueOnce(block2);

    const client = createMockClient();
    const event1 = { text: '<@U123ABC> task one', channel: 'C456', ts: '100.000', thread_ts: undefined };
    const event2 = { text: '<@U123ABC> task two', channel: 'C456', ts: '200.000', thread_ts: undefined };

    await handleAppMention(event1 as Parameters<typeof handleAppMention>[0], client as Parameters<typeof handleAppMention>[1]);
    await handleAppMention(event2 as Parameters<typeof handleAppMention>[0], client as Parameters<typeof handleAppMention>[1]);

    // Sessions should both be present (fire-and-forget not yet completed)
    expect(getThreadSessions().has('100.000')).toBe(true);
    expect(getThreadSessions().has('200.000')).toBe(true);
    // Sessions are independent objects
    expect(getThreadSessions().get('100.000')).not.toBe(getThreadSessions().get('200.000'));

    // Clean up by resolving the blocking promises
    resolveBlock1!();
    resolveBlock2!();
  });

  it('uses thread_ts from event when present (replies in existing thread)', async () => {
    const client = createMockClient();
    const event = {
      text: '<@U123ABC> add tests',
      channel: 'C456',
      ts: '999.001',
      thread_ts: '888.000',
    };

    await handleAppMention(event as Parameters<typeof handleAppMention>[0], client as Parameters<typeof handleAppMention>[1]);

    expect(getThreadSessions().has('888.000')).toBe(true);
  });
});

describe('handleProceedAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getThreadSessions().clear();
  });

  it('calls ack() first, then updates message to remove buttons, then resolves pendingConfirm', async () => {
    const client = createMockClient();
    const ack = vi.fn().mockResolvedValue(undefined);
    const callOrder: string[] = [];

    ack.mockImplementation(async () => { callOrder.push('ack'); });
    client.chat.update = vi.fn().mockImplementation(async () => { callOrder.push('update'); return { ok: true }; });

    const threadTs = 'thr.proceed.001';
    const mockResolve = vi.fn().mockImplementation(() => { callOrder.push('resolve'); });
    const mockIntent = { taskType: 'generic', repo: '/projects/app', description: 'test', dep: null, version: null, confidence: 'high', scopingQuestions: [], createPr: true };

    getThreadSessions().set(threadTs, {
      state: { currentProject: null, currentProjectName: null, history: [] },
      abortController: new AbortController(),
      pendingConfirm: { resolve: mockResolve },
      confirmationMessageTs: 'conf-msg-ts',
      intent: mockIntent as Parameters<typeof handleProceedAction>[0] extends never ? never : ReturnType<typeof getThreadSessions>['values'] extends IterableIterator<infer T> ? T : never,
    } as ReturnType<typeof getThreadSessions>['get'] extends (key: string) => infer T ? NonNullable<T> : never);

    const body = {
      channel: { id: 'C456' },
      message: { ts: 'conf-msg-ts', thread_ts: threadTs },
    } as unknown as BlockAction;

    await handleProceedAction(ack, body, client as Parameters<typeof handleProceedAction>[2]);

    expect(callOrder[0]).toBe('ack');
    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C456',
        ts: 'conf-msg-ts',
        text: 'Confirmed — running...',
        blocks: [],
      }),
    );
    expect(mockResolve).toHaveBeenCalled();
  });

  it('posts "Session expired" to thread when no matching session found', async () => {
    const client = createMockClient();
    const ack = vi.fn().mockResolvedValue(undefined);

    const body = {
      channel: { id: 'C456' },
      message: { ts: 'some-ts', thread_ts: 'nonexistent-thread' },
    } as unknown as BlockAction;

    await handleProceedAction(ack, body, client as Parameters<typeof handleProceedAction>[2]);

    expect(ack).toHaveBeenCalled();
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Session expired'),
      }),
    );
  });

  it('posts "Already processing" when pendingConfirm is absent (double-click guard)', async () => {
    const client = createMockClient();
    const ack = vi.fn().mockResolvedValue(undefined);

    const threadTs = 'thr.double.click';
    getThreadSessions().set(threadTs, {
      state: { currentProject: null, currentProjectName: null, history: [] },
      abortController: new AbortController(),
      // pendingConfirm deliberately absent
    });

    const body = {
      channel: { id: 'C456' },
      message: { ts: 'some-ts', thread_ts: threadTs },
    } as unknown as BlockAction;

    await handleProceedAction(ack, body, client as Parameters<typeof handleProceedAction>[2]);

    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Already processing'),
      }),
    );
  });
});

describe('handleCancelAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getThreadSessions().clear();
  });

  it('calls ack() first, then updates message to "Cancelled.", then resolves pendingConfirm with null and deletes session', async () => {
    const client = createMockClient();
    const ack = vi.fn().mockResolvedValue(undefined);
    const callOrder: string[] = [];

    ack.mockImplementation(async () => { callOrder.push('ack'); });
    client.chat.update = vi.fn().mockImplementation(async () => { callOrder.push('update'); return { ok: true }; });

    const threadTs = 'thr.cancel.001';
    const mockResolve = vi.fn().mockImplementation(() => { callOrder.push('resolve'); });

    getThreadSessions().set(threadTs, {
      state: { currentProject: null, currentProjectName: null, history: [] },
      abortController: new AbortController(),
      pendingConfirm: { resolve: mockResolve },
      confirmationMessageTs: 'conf-cancel-ts',
    });

    const body = {
      channel: { id: 'C456' },
      message: { ts: 'conf-cancel-ts', thread_ts: threadTs },
    } as unknown as BlockAction;

    await handleCancelAction(ack, body, client as Parameters<typeof handleCancelAction>[2]);

    expect(callOrder[0]).toBe('ack');
    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C456',
        ts: 'conf-cancel-ts',
        text: 'Cancelled.',
        blocks: [],
      }),
    );
    expect(mockResolve).toHaveBeenCalledWith(null);
    // Session should be deleted
    expect(getThreadSessions().has(threadTs)).toBe(false);
  });

  it('returns silently when no matching session found', async () => {
    const client = createMockClient();
    const ack = vi.fn().mockResolvedValue(undefined);

    const body = {
      channel: { id: 'C456' },
      message: { ts: 'some-ts', thread_ts: 'nonexistent' },
    } as unknown as BlockAction;

    // Should not throw
    await expect(
      handleCancelAction(ack, body, client as Parameters<typeof handleCancelAction>[2])
    ).resolves.toBeUndefined();
    expect(ack).toHaveBeenCalled();
  });
});
