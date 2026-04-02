import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BlockAction } from '@slack/bolt';
import type { ThreadSession } from './types.js';

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

// Mock ProjectRegistry — must use function (not arrow) for vitest constructor compatibility
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

// Mock client — cast through unknown to satisfy Pick<WebClient, 'chat'> parameter types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any;

function createMockClient() {
  return {
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: 'mock-ts' }),
      update: vi.fn().mockResolvedValue({ ok: true }),
    },
  };
}

function createTestSession(overrides: Partial<ThreadSession> = {}): ThreadSession {
  return {
    userId: 'U_OWNER',
    status: 'confirming',
    createdAt: Date.now(),
    state: { currentProject: null, currentProjectName: null, history: [] },
    abortController: new AbortController(),
    ...overrides,
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
      user: 'U_ALICE',
    };

    await handleAppMention(event, client as AnyClient);

    // Session should be keyed by ts (since no thread_ts)
    expect(getThreadSessions().has('111.000')).toBe(true);
  });

  it('stores userId on the created session (V1)', async () => {
    const client = createMockClient();
    const event = {
      text: '<@U123ABC> update lodash',
      channel: 'C456',
      ts: '111.000',
      thread_ts: undefined,
      user: 'U_ALICE',
    };

    await handleAppMention(event, client as AnyClient);

    const session = getThreadSessions().get('111.000');
    expect(session?.userId).toBe('U_ALICE');
  });

  it('calls processSlackMention with stripped text, context, session, and registry', async () => {
    const client = createMockClient();
    const event = {
      text: '<@U123ABC> update lodash to latest',
      channel: 'C456',
      ts: '222.000',
      thread_ts: undefined,
      user: 'U_BOB',
    };

    await handleAppMention(event, client as AnyClient);

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
      user: 'U_ALICE',
    };

    await handleAppMention(event, client as AnyClient);

    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C456',
        thread_ts: '333.000',
        text: 'Please include a task description after the mention.',
      }),
    );
  });

  it('two app_mention events with different threadTs create independent sessions', async () => {
    // Use blocking promises so the finally() cleanup doesn't delete sessions
    // before we can assert on them
    let resolveBlock1!: () => void;
    let resolveBlock2!: () => void;
    const block1 = new Promise<void>(resolve => { resolveBlock1 = resolve; });
    const block2 = new Promise<void>(resolve => { resolveBlock2 = resolve; });

    mockProcessSlackMention
      .mockReturnValueOnce(block1)
      .mockReturnValueOnce(block2);

    const client = createMockClient();
    const event1 = { text: '<@U123ABC> task one', channel: 'C456', ts: '100.000', thread_ts: undefined, user: 'U_ALICE' };
    const event2 = { text: '<@U123ABC> task two', channel: 'C456', ts: '200.000', thread_ts: undefined, user: 'U_BOB' };

    await handleAppMention(event1, client as AnyClient);
    await handleAppMention(event2, client as AnyClient);

    // Sessions should both be present (fire-and-forget not yet completed)
    expect(getThreadSessions().has('100.000')).toBe(true);
    expect(getThreadSessions().has('200.000')).toBe(true);
    // Sessions are independent objects
    expect(getThreadSessions().get('100.000')).not.toBe(getThreadSessions().get('200.000'));

    // Clean up
    resolveBlock1();
    resolveBlock2();
  });

  it('uses thread_ts from event when present (replies in existing thread)', async () => {
    const client = createMockClient();
    const event = {
      text: '<@U123ABC> add tests',
      channel: 'C456',
      ts: '999.001',
      thread_ts: '888.000',
      user: 'U_ALICE',
    };

    await handleAppMention(event, client as AnyClient);

    expect(getThreadSessions().has('888.000')).toBe(true);
  });

  it('rate-limits excessive mentions from the same user (V3)', async () => {
    const client = createMockClient();

    // Fire 6 mentions from the same user (limit is 5)
    for (let i = 0; i < 6; i++) {
      await handleAppMention(
        { text: `<@U123ABC> task ${i}`, channel: 'C456', ts: `${400 + i}.000`, user: 'U_SPAMMER' },
        client as AnyClient,
      );
    }

    // The 6th call should have been rate-limited
    const rateLimitCall = client.chat.postMessage.mock.calls.find(
      (call: Array<{ text?: string }>) => call[0].text?.includes('Rate limit'),
    );
    expect(rateLimitCall).toBeDefined();
  });

  it('sanitizes error messages before posting to Slack (V2)', async () => {
    mockProcessSlackMention.mockRejectedValueOnce(new Error('ENOENT: /secret/path'));

    const client = createMockClient();
    const event = {
      text: '<@U123ABC> do something',
      channel: 'C456',
      ts: '500.000',
      user: 'U_ALICE',
    };

    await handleAppMention(event, client as AnyClient);

    // Wait for catch to fire
    await new Promise<void>(resolve => setTimeout(resolve, 10));

    const errorCall = client.chat.postMessage.mock.calls.find(
      (call: Array<{ text?: string }>) => call[0].text?.includes('Something went wrong'),
    );
    expect(errorCall).toBeDefined();
    // Should NOT contain the raw path
    expect(errorCall![0].text).not.toContain('/secret/path');
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
    const mockIntent = {
      taskType: 'generic',
      repo: '/projects/app',
      description: 'test',
      dep: null,
      version: null,
      confidence: 'high',
      scopingQuestions: [],
      createPr: true,
    };

    const session = createTestSession({
      pendingConfirm: { resolve: mockResolve },
      confirmationMessageTs: 'conf-msg-ts',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      intent: mockIntent as any,
    });
    getThreadSessions().set(threadTs, session);

    const body = {
      user: { id: 'U_OWNER' },
      channel: { id: 'C456' },
      message: { ts: 'conf-msg-ts', thread_ts: threadTs },
    } as unknown as BlockAction;

    await handleProceedAction(ack, body, client as AnyClient);

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
      user: { id: 'U_SOMEONE' },
      channel: { id: 'C456' },
      message: { ts: 'some-ts', thread_ts: 'nonexistent-thread' },
    } as unknown as BlockAction;

    await handleProceedAction(ack, body, client as AnyClient);

    expect(ack).toHaveBeenCalled();
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Session expired'),
      }),
    );
  });

  it('rejects unauthorized user from clicking proceed (V1)', async () => {
    const client = createMockClient();
    const ack = vi.fn().mockResolvedValue(undefined);

    const threadTs = 'thr.auth.001';
    const session = createTestSession({
      userId: 'U_OWNER',
      pendingConfirm: { resolve: vi.fn() },
    });
    getThreadSessions().set(threadTs, session);

    const body = {
      user: { id: 'U_INTRUDER' },
      channel: { id: 'C456' },
      message: { ts: 'some-ts', thread_ts: threadTs },
    } as unknown as BlockAction;

    await handleProceedAction(ack, body, client as AnyClient);

    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Only the user who initiated'),
      }),
    );
    // pendingConfirm should NOT have been resolved
    expect(session.pendingConfirm?.resolve).not.toHaveBeenCalled();
  });

  it('posts "Already processing" when status is not confirming (P5)', async () => {
    const client = createMockClient();
    const ack = vi.fn().mockResolvedValue(undefined);

    const threadTs = 'thr.double.click';
    const session = createTestSession({ status: 'running' });
    getThreadSessions().set(threadTs, session);

    const body = {
      user: { id: 'U_OWNER' },
      channel: { id: 'C456' },
      message: { ts: 'some-ts', thread_ts: threadTs },
    } as unknown as BlockAction;

    await handleProceedAction(ack, body, client as AnyClient);

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

  it('calls ack() first, then updates message to "Cancelled.", then resolves pendingConfirm with null', async () => {
    const client = createMockClient();
    const ack = vi.fn().mockResolvedValue(undefined);
    const callOrder: string[] = [];

    ack.mockImplementation(async () => { callOrder.push('ack'); });
    client.chat.update = vi.fn().mockImplementation(async () => { callOrder.push('update'); return { ok: true }; });

    const threadTs = 'thr.cancel.001';
    const mockResolve = vi.fn().mockImplementation(() => { callOrder.push('resolve'); });

    const session = createTestSession({
      pendingConfirm: { resolve: mockResolve },
      confirmationMessageTs: 'conf-cancel-ts',
    });
    getThreadSessions().set(threadTs, session);

    const body = {
      user: { id: 'U_OWNER' },
      channel: { id: 'C456' },
      message: { ts: 'conf-cancel-ts', thread_ts: threadTs },
    } as unknown as BlockAction;

    await handleCancelAction(ack, body, client as AnyClient);

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
  });

  it('returns silently when no matching session found', async () => {
    const client = createMockClient();
    const ack = vi.fn().mockResolvedValue(undefined);

    const body = {
      user: { id: 'U_SOMEONE' },
      channel: { id: 'C456' },
      message: { ts: 'some-ts', thread_ts: 'nonexistent' },
    } as unknown as BlockAction;

    // Should not throw
    await expect(
      handleCancelAction(ack, body, client as AnyClient)
    ).resolves.toBeUndefined();
    expect(ack).toHaveBeenCalled();
  });

  it('rejects unauthorized user from clicking cancel (V1)', async () => {
    const client = createMockClient();
    const ack = vi.fn().mockResolvedValue(undefined);

    const threadTs = 'thr.auth.cancel';
    const session = createTestSession({
      userId: 'U_OWNER',
      pendingConfirm: { resolve: vi.fn() },
    });
    getThreadSessions().set(threadTs, session);

    const body = {
      user: { id: 'U_INTRUDER' },
      channel: { id: 'C456' },
      message: { ts: 'some-ts', thread_ts: threadTs },
    } as unknown as BlockAction;

    await handleCancelAction(ack, body, client as AnyClient);

    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Only the user who initiated'),
      }),
    );
    // pendingConfirm should NOT have been resolved
    expect(session.pendingConfirm?.resolve).not.toHaveBeenCalled();
  });

  it('ignores cancel when session is already running (P5)', async () => {
    const client = createMockClient();
    const ack = vi.fn().mockResolvedValue(undefined);

    const threadTs = 'thr.race.001';
    const session = createTestSession({ status: 'running' });
    getThreadSessions().set(threadTs, session);

    const body = {
      user: { id: 'U_OWNER' },
      channel: { id: 'C456' },
      message: { ts: 'some-ts', thread_ts: threadTs },
    } as unknown as BlockAction;

    await handleCancelAction(ack, body, client as AnyClient);

    // Should not update message or resolve anything
    expect(client.chat.update).not.toHaveBeenCalled();
  });

  it('does not delete session from map — cleanup handled by handleAppMention .finally() (P2)', async () => {
    const client = createMockClient();
    const ack = vi.fn().mockResolvedValue(undefined);

    const threadTs = 'thr.cleanup.001';
    const session = createTestSession({
      pendingConfirm: { resolve: vi.fn() },
    });
    getThreadSessions().set(threadTs, session);

    const body = {
      user: { id: 'U_OWNER' },
      channel: { id: 'C456' },
      message: { ts: 'some-ts', thread_ts: threadTs },
    } as unknown as BlockAction;

    await handleCancelAction(ack, body, client as AnyClient);

    // Session should still be in the map — .finally() in handleAppMention handles deletion
    expect(getThreadSessions().has(threadTs)).toBe(true);
  });
});
