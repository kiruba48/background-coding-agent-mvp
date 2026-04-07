import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ResolvedIntent } from '../intent/types.js';
import type { ThreadSession } from '../slack/types.js';
import type { ReplState } from '../repl/types.js';

// Mock @slack/web-api WebClient
const mockPostMessage = vi.fn().mockResolvedValue({ ok: true, ts: 'mock-ts-123' });
const mockChatUpdate = vi.fn().mockResolvedValue({ ok: true });

vi.mock('@slack/web-api', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const WebClientMock = vi.fn().mockImplementation(function (this: any) {
    this.chat = {
      postMessage: mockPostMessage,
      update: mockChatUpdate,
    };
  });
  return { WebClient: WebClientMock };
});

// Mock parseIntent
vi.mock('../intent/index.js', () => ({
  parseIntent: vi.fn(),
}));

// Mock LlmParseError
vi.mock('../intent/llm-parser.js', () => ({
  LlmParseError: class LlmParseError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'LlmParseError';
    }
  },
}));

// Mock runAgent
vi.mock('../agent/index.js', () => ({
  runAgent: vi.fn(),
}));

// Mock createLogger
vi.mock('../cli/utils/logger.js', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));

// Mock GitHubPRCreator
vi.mock('../orchestrator/pr-creator.js', () => ({
  GitHubPRCreator: vi.fn().mockImplementation(() => ({
    create: vi.fn().mockResolvedValue({ url: 'https://github.com/owner/repo/pull/1', created: true, branch: 'agent/test' }),
  })),
}));

import { buildSlackCallbacks, processSlackMention } from '../slack/adapter.js';
import { parseIntent } from '../intent/index.js';
import { LlmParseError } from '../intent/llm-parser.js';
import { runAgent } from '../agent/index.js';
import { WebClient } from '@slack/web-api';
import { ProjectRegistry } from '../agent/registry.js';

function createMockClient() {
  return new WebClient('mock-token') as unknown as InstanceType<typeof WebClient> & {
    chat: {
      postMessage: typeof mockPostMessage;
      update: typeof mockChatUpdate;
    };
  };
}

function createMockSession(): ThreadSession {
  const state: ReplState = {
    currentProject: null,
    currentProjectName: null,
    history: [],
  };
  return {
    userId: 'U_TEST_USER',
    status: 'confirming',
    createdAt: Date.now(),
    state,
    abortController: new AbortController(),
  };
}

const mockIntent: ResolvedIntent = {
  taskType: 'generic',
  repo: '/projects/my-app',
  dep: null,
  version: null,
  confidence: 'high',
  description: 'Add error handling to auth',
  scopingQuestions: [],
};

describe('buildSlackCallbacks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns object with confirm, clarify, getSignal, onAgentStart, onAgentEnd methods', () => {
    const client = createMockClient();
    const session = createMockSession();
    const ctx = { client, channel: 'C123', threadTs: '1234567890.123' };

    const callbacks = buildSlackCallbacks(ctx, session);

    expect(typeof callbacks.confirm).toBe('function');
    expect(typeof callbacks.clarify).toBe('function');
    expect(typeof callbacks.getSignal).toBe('function');
    expect(typeof callbacks.onAgentStart).toBe('function');
    expect(typeof callbacks.onAgentEnd).toBe('function');
  });

  it('does NOT include askQuestion (scoping bypassed for Slack v2.3)', () => {
    const client = createMockClient();
    const session = createMockSession();
    const ctx = { client, channel: 'C123', threadTs: '1234567890.123' };

    const callbacks = buildSlackCallbacks(ctx, session);

    expect(callbacks.askQuestion).toBeUndefined();
  });

  it('confirm callback calls client.chat.postMessage with thread_ts and blocks containing buttons', async () => {
    const client = createMockClient();
    const session = createMockSession();
    const ctx = { client, channel: 'C123', threadTs: '1234567890.123' };

    const callbacks = buildSlackCallbacks(ctx, session);

    // Start confirm (it will block waiting for pendingConfirm resolution)
    const confirmPromise = callbacks.confirm(mockIntent, async () => mockIntent);

    // Wait for postMessage to resolve and pendingConfirm to be set
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    session.pendingConfirm?.resolve(mockIntent);

    await confirmPromise;

    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        thread_ts: '1234567890.123',
        blocks: expect.any(Array),
      }),
    );

    // Verify blocks contain buttons
    const callArgs = mockPostMessage.mock.calls[0][0];
    const actionsBlock = callArgs.blocks.find((b: { type: string }) => b.type === 'actions');
    expect(actionsBlock).toBeDefined();
  });

  it('confirm callback stores pendingConfirm resolver on ThreadSession', async () => {
    const client = createMockClient();
    const session = createMockSession();
    const ctx = { client, channel: 'C123', threadTs: '1234567890.123' };

    const callbacks = buildSlackCallbacks(ctx, session);

    // Start confirm but don't await yet
    const confirmPromise = callbacks.confirm(mockIntent, async () => mockIntent);

    // After calling confirm, pendingConfirm should be set on the session
    // We need to check after postMessage resolves, so give it a tick
    await Promise.resolve();

    expect(session.pendingConfirm).toBeDefined();
    expect(typeof session.pendingConfirm?.resolve).toBe('function');

    // Clean up
    session.pendingConfirm?.resolve(null);
    await confirmPromise;
  });

  it('confirm callback stores confirmationMessageTs on ThreadSession', async () => {
    const client = createMockClient();
    const session = createMockSession();
    const ctx = { client, channel: 'C123', threadTs: '1234567890.123' };

    const callbacks = buildSlackCallbacks(ctx, session);

    const confirmPromise = callbacks.confirm(mockIntent, async () => mockIntent);

    // Wait for postMessage to resolve and ts to be stored
    await Promise.resolve();
    await Promise.resolve();

    expect(session.confirmationMessageTs).toBe('mock-ts-123');

    session.pendingConfirm?.resolve(null);
    await confirmPromise;
  });

  it('clarify callback returns first clarification option intent string', async () => {
    const client = createMockClient();
    const session = createMockSession();
    const ctx = { client, channel: 'C123', threadTs: '1234567890.123' };

    const callbacks = buildSlackCallbacks(ctx, session);

    const result = await callbacks.clarify([
      { label: 'Update lodash', intent: 'update lodash to latest' },
      { label: 'Update react', intent: 'update react to 18' },
    ]);

    expect(result).toBe('update lodash to latest');
  });

  it('clarify callback posts auto-selection notification to thread', async () => {
    const client = createMockClient();
    const session = createMockSession();
    const ctx = { client, channel: 'C123', threadTs: '1234567890.123' };

    const callbacks = buildSlackCallbacks(ctx, session);

    await callbacks.clarify([
      { label: 'Update lodash', intent: 'update lodash to latest' },
    ]);

    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        thread_ts: '1234567890.123',
        text: expect.stringContaining('Update lodash'),
      }),
    );
  });

  it('getSignal returns abortController.signal from the ThreadSession', () => {
    const client = createMockClient();
    const session = createMockSession();
    const ctx = { client, channel: 'C123', threadTs: '1234567890.123' };

    const callbacks = buildSlackCallbacks(ctx, session);

    expect(callbacks.getSignal()).toBe(session.abortController.signal);
  });

  it('onAgentStart calls client.chat.postMessage with Running... text and thread_ts', async () => {
    const client = createMockClient();
    const session = createMockSession();
    const ctx = { client, channel: 'C123', threadTs: '1234567890.123' };

    const callbacks = buildSlackCallbacks(ctx, session);

    await callbacks.onAgentStart?.();

    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        thread_ts: '1234567890.123',
        text: 'Running...',
      }),
    );
  });
});

describe('processSlackMention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('posts error message to thread on LlmParseError', async () => {
    vi.mocked(parseIntent).mockRejectedValueOnce(new LlmParseError('Cannot parse'));

    const client = createMockClient();
    const session = createMockSession();
    const ctx = { client, channel: 'C123', threadTs: '1234567890.123' };
    const registry = new ProjectRegistry({ cwd: '/tmp/test-registry' });

    await processSlackMention('some garbled input', ctx, session, registry);

    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        thread_ts: '1234567890.123',
        text: expect.stringContaining('Could not understand'),
      }),
    );
  });

  it('posts Block Kit confirmation to thread on successful parse', async () => {
    vi.mocked(parseIntent).mockResolvedValueOnce(mockIntent);
    vi.mocked(runAgent).mockResolvedValueOnce({
      finalStatus: 'success',
      attempts: 1,
      sessionResults: [],
      verificationResults: [],
    });

    const client = createMockClient();
    const session = createMockSession();
    const ctx = { client, channel: 'C123', threadTs: '1234567890.123' };
    const registry = new ProjectRegistry({ cwd: '/tmp/test-registry' });

    // We need to simulate the confirm button being clicked
    const processPromise = processSlackMention('add error handling', ctx, session, registry);

    // Wait for parseIntent and confirm to be called, then simulate button click
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    session.pendingConfirm?.resolve(mockIntent);

    await processPromise;

    // Should have posted with blocks (confirmation message)
    const postCalls = mockPostMessage.mock.calls;
    const confirmationCall = postCalls.find((call: Array<{ blocks?: unknown[] }>) => call[0].blocks && Array.isArray(call[0].blocks));
    expect(confirmationCall).toBeDefined();
  });

  it('sets createPr=true on the intent (auto-PR)', async () => {
    vi.mocked(parseIntent).mockResolvedValueOnce({ ...mockIntent, createPr: false });
    vi.mocked(runAgent).mockResolvedValueOnce({
      finalStatus: 'success',
      attempts: 1,
      sessionResults: [],
      verificationResults: [],
    });

    const client = createMockClient();
    const session = createMockSession();
    const ctx = { client, channel: 'C123', threadTs: '1234567890.123' };
    const registry = new ProjectRegistry({ cwd: '/tmp/test-registry' });

    const processPromise = processSlackMention('add error handling', ctx, session, registry);

    await new Promise<void>(resolve => setTimeout(resolve, 10));
    session.pendingConfirm?.resolve({ ...mockIntent, createPr: true });

    await processPromise;

    // runAgent should have been called with createPr: true
    const runAgentCall = vi.mocked(runAgent).mock.calls[0];
    expect(runAgentCall[0].createPr).toBe(true);
  });

  it('posts PR URL when agent succeeds with prResult (P1)', async () => {
    vi.mocked(parseIntent).mockResolvedValueOnce(mockIntent);
    vi.mocked(runAgent).mockResolvedValueOnce({
      finalStatus: 'success',
      attempts: 1,
      sessionResults: [],
      verificationResults: [],
      prResult: { url: 'https://github.com/owner/repo/pull/42', created: true, branch: 'agent/test' },
    });

    const client = createMockClient();
    const session = createMockSession();
    const ctx = { client, channel: 'C123', threadTs: '1234567890.123' };
    const registry = new ProjectRegistry({ cwd: '/tmp/test-registry' });

    const processPromise = processSlackMention('add error handling', ctx, session, registry);

    await new Promise<void>(resolve => setTimeout(resolve, 10));
    session.pendingConfirm?.resolve(mockIntent);

    await processPromise;

    // Should post PR URL in thread
    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('https://github.com/owner/repo/pull/42'),
      }),
    );
  });

  it('posts generic success when no prResult (P1)', async () => {
    vi.mocked(parseIntent).mockResolvedValueOnce(mockIntent);
    vi.mocked(runAgent).mockResolvedValueOnce({
      finalStatus: 'success',
      attempts: 1,
      sessionResults: [],
      verificationResults: [],
    });

    const client = createMockClient();
    const session = createMockSession();
    const ctx = { client, channel: 'C123', threadTs: '1234567890.123' };
    const registry = new ProjectRegistry({ cwd: '/tmp/test-registry' });

    const processPromise = processSlackMention('add error handling', ctx, session, registry);

    await new Promise<void>(resolve => setTimeout(resolve, 10));
    session.pendingConfirm?.resolve(mockIntent);

    await processPromise;

    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Task completed successfully.',
      }),
    );
  });

  it('posts sanitized error message on agent failure (V2)', async () => {
    vi.mocked(parseIntent).mockResolvedValueOnce(mockIntent);
    vi.mocked(runAgent).mockRejectedValueOnce(
      new Error('ENOENT: /Users/secret/path/to/file with xoxb-1234-token'),
    );

    const client = createMockClient();
    const session = createMockSession();
    const ctx = { client, channel: 'C123', threadTs: '1234567890.123' };
    const registry = new ProjectRegistry({ cwd: '/tmp/test-registry' });

    const processPromise = processSlackMention('add error handling', ctx, session, registry);

    await new Promise<void>(resolve => setTimeout(resolve, 10));
    session.pendingConfirm?.resolve(mockIntent);

    await processPromise;

    const errorCall = mockPostMessage.mock.calls.find(
      (call: Array<{ text?: string }>) => call[0].text?.includes('Agent run failed'),
    );
    expect(errorCall).toBeDefined();
    // Should NOT contain the raw path or token
    expect(errorCall![0].text).not.toContain('/Users/secret');
    expect(errorCall![0].text).not.toContain('xoxb-1234-token');
  });

  it('sets session status to done after completion', async () => {
    vi.mocked(parseIntent).mockResolvedValueOnce(mockIntent);
    vi.mocked(runAgent).mockResolvedValueOnce({
      finalStatus: 'success',
      attempts: 1,
      sessionResults: [],
      verificationResults: [],
    });

    const client = createMockClient();
    const session = createMockSession();
    const ctx = { client, channel: 'C123', threadTs: '1234567890.123' };
    const registry = new ProjectRegistry({ cwd: '/tmp/test-registry' });

    const processPromise = processSlackMention('add error handling', ctx, session, registry);

    await new Promise<void>(resolve => setTimeout(resolve, 10));
    session.pendingConfirm?.resolve(mockIntent);

    await processPromise;

    expect(session.status).toBe('done');
  });

  it('sets session status to done on cancellation', async () => {
    vi.mocked(parseIntent).mockResolvedValueOnce(mockIntent);

    const client = createMockClient();
    const session = createMockSession();
    const ctx = { client, channel: 'C123', threadTs: '1234567890.123' };
    const registry = new ProjectRegistry({ cwd: '/tmp/test-registry' });

    const processPromise = processSlackMention('add error handling', ctx, session, registry);

    await new Promise<void>(resolve => setTimeout(resolve, 10));
    session.pendingConfirm?.resolve(null);

    await processPromise;

    expect(session.status).toBe('done');
  });

  it('posts failure message for non-success non-cancelled agent results', async () => {
    vi.mocked(parseIntent).mockResolvedValueOnce(mockIntent);
    vi.mocked(runAgent).mockResolvedValueOnce({
      finalStatus: 'failed',
      attempts: 1,
      sessionResults: [],
      verificationResults: [],
      error: 'Build failed',
    });

    const client = createMockClient();
    const session = createMockSession();
    const ctx = { client, channel: 'C123', threadTs: '1234567890.123' };
    const registry = new ProjectRegistry({ cwd: '/tmp/test-registry' });

    const processPromise = processSlackMention('add error handling', ctx, session, registry);

    await new Promise<void>(resolve => setTimeout(resolve, 10));
    session.pendingConfirm?.resolve(mockIntent);

    await processPromise;

    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Task failed. Check agent logs for details.',
      }),
    );
  });

  it('appends to session.state.history on successful agent run', async () => {
    vi.mocked(parseIntent).mockResolvedValueOnce(mockIntent);
    vi.mocked(runAgent).mockResolvedValueOnce({
      finalStatus: 'success',
      attempts: 1,
      sessionResults: [{ sessionId: 'test-session', status: 'success', finalResponse: 'Added error handling.', toolCallCount: 5, duration: 1000 }],
      verificationResults: [],
    });

    const client = createMockClient();
    const session = createMockSession();
    const ctx = { client, channel: 'C123', threadTs: '1234567890.123' };
    const registry = new ProjectRegistry({ cwd: '/tmp/test-registry' });

    const processPromise = processSlackMention('add error handling', ctx, session, registry);
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    session.pendingConfirm?.resolve(mockIntent);
    await processPromise;

    expect(session.state.history.length).toBe(1);
    expect(session.state.history[0]).toMatchObject({
      taskType: 'generic',
      repo: '/projects/my-app',
      status: 'success',
      description: 'Add error handling to auth',
      finalResponse: 'Added error handling.',
    });
  });

  it('appends to session.state.history with status failed on agent failure', async () => {
    vi.mocked(parseIntent).mockResolvedValueOnce(mockIntent);
    vi.mocked(runAgent).mockResolvedValueOnce({
      finalStatus: 'failed',
      attempts: 1,
      sessionResults: [],
      verificationResults: [],
    });

    const client = createMockClient();
    const session = createMockSession();
    const ctx = { client, channel: 'C123', threadTs: '1234567890.123' };
    const registry = new ProjectRegistry({ cwd: '/tmp/test-registry' });

    const processPromise = processSlackMention('add error handling', ctx, session, registry);
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    session.pendingConfirm?.resolve(mockIntent);
    await processPromise;

    expect(session.state.history.length).toBe(1);
    expect(session.state.history[0].status).toBe('failed');
  });

  it('does NOT append to history when user cancels at confirm', async () => {
    vi.mocked(parseIntent).mockResolvedValueOnce(mockIntent);

    const client = createMockClient();
    const session = createMockSession();
    const ctx = { client, channel: 'C123', threadTs: '1234567890.123' };
    const registry = new ProjectRegistry({ cwd: '/tmp/test-registry' });

    const processPromise = processSlackMention('add error handling', ctx, session, registry);
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    session.pendingConfirm?.resolve(null);
    await processPromise;

    expect(session.state.history.length).toBe(0);
  });

  it('appends to history with status cancelled when agent returns cancelled', async () => {
    vi.mocked(parseIntent).mockResolvedValueOnce(mockIntent);
    vi.mocked(runAgent).mockResolvedValueOnce({
      finalStatus: 'cancelled',
      attempts: 0,
      sessionResults: [],
      verificationResults: [],
    });

    const client = createMockClient();
    const session = createMockSession();
    const ctx = { client, channel: 'C123', threadTs: '1234567890.123' };
    const registry = new ProjectRegistry({ cwd: '/tmp/test-registry' });

    const processPromise = processSlackMention('add error handling', ctx, session, registry);
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    session.pendingConfirm?.resolve(mockIntent);
    await processPromise;

    expect(session.state.history.length).toBe(1);
    expect(session.state.history[0].status).toBe('cancelled');
  });

  describe('investigation task type', () => {
    const mockInvestigationIntent: ResolvedIntent = {
      taskType: 'investigation',
      repo: '/projects/my-app',
      dep: null,
      version: null,
      confidence: 'high',
      explorationSubtype: 'ci-checks',
      description: 'explore CI pipeline',
      scopingQuestions: [],
    };

    it('INV-S01. investigation intent does NOT get createPr set to true', async () => {
      vi.mocked(parseIntent).mockResolvedValueOnce({ ...mockInvestigationIntent });
      vi.mocked(runAgent).mockResolvedValueOnce({
        finalStatus: 'success',
        attempts: 1,
        sessionResults: [{ sessionId: 's1', status: 'success', finalResponse: '# CI Report', toolCallCount: 3, duration: 1000 }],
        verificationResults: [],
      });

      const client = createMockClient();
      const session = createMockSession();
      const ctx = { client, channel: 'C123', threadTs: '1234567890.123' };
      const registry = new ProjectRegistry({ cwd: '/tmp/test-registry' });

      const processPromise = processSlackMention('explore CI pipeline', ctx, session, registry);
      await new Promise<void>(resolve => setTimeout(resolve, 10));
      session.pendingConfirm?.resolve(mockInvestigationIntent);
      await processPromise;

      // agentOptions must have createPr: false (not true)
      const runAgentCall = vi.mocked(runAgent).mock.calls[0];
      expect(runAgentCall[0].createPr).toBe(false);
    });

    it('INV-S02. investigation result posts finalResponse as thread message', async () => {
      vi.mocked(parseIntent).mockResolvedValueOnce({ ...mockInvestigationIntent });
      vi.mocked(runAgent).mockResolvedValueOnce({
        finalStatus: 'success',
        attempts: 1,
        sessionResults: [{ sessionId: 's1', status: 'success', finalResponse: '# CI Report\nAll checks pass.', toolCallCount: 3, duration: 1000 }],
        verificationResults: [],
      });

      const client = createMockClient();
      const session = createMockSession();
      const ctx = { client, channel: 'C123', threadTs: '1234567890.123' };
      const registry = new ProjectRegistry({ cwd: '/tmp/test-registry' });

      const processPromise = processSlackMention('explore CI pipeline', ctx, session, registry);
      await new Promise<void>(resolve => setTimeout(resolve, 10));
      session.pendingConfirm?.resolve(mockInvestigationIntent);
      await processPromise;

      // Should post the report as thread message
      expect(mockPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C123',
          thread_ts: '1234567890.123',
          text: '# CI Report\nAll checks pass.',
        }),
      );
    });

    it('INV-S03. investigation with empty finalResponse posts "Exploration produced no report."', async () => {
      vi.mocked(parseIntent).mockResolvedValueOnce({ ...mockInvestigationIntent });
      vi.mocked(runAgent).mockResolvedValueOnce({
        finalStatus: 'success',
        attempts: 1,
        sessionResults: [{ sessionId: 's1', status: 'success', finalResponse: '', toolCallCount: 3, duration: 1000 }],
        verificationResults: [],
      });

      const client = createMockClient();
      const session = createMockSession();
      const ctx = { client, channel: 'C123', threadTs: '1234567890.123' };
      const registry = new ProjectRegistry({ cwd: '/tmp/test-registry' });

      const processPromise = processSlackMention('explore CI pipeline', ctx, session, registry);
      await new Promise<void>(resolve => setTimeout(resolve, 10));
      session.pendingConfirm?.resolve(mockInvestigationIntent);
      await processPromise;

      expect(mockPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'Exploration produced no report.',
        }),
      );
    });

    it('INV-S04. non-investigation intent still gets createPr = true (regression check)', async () => {
      vi.mocked(parseIntent).mockResolvedValueOnce({ ...mockIntent, createPr: false });
      vi.mocked(runAgent).mockResolvedValueOnce({
        finalStatus: 'success',
        attempts: 1,
        sessionResults: [],
        verificationResults: [],
      });

      const client = createMockClient();
      const session = createMockSession();
      const ctx = { client, channel: 'C123', threadTs: '1234567890.123' };
      const registry = new ProjectRegistry({ cwd: '/tmp/test-registry' });

      const processPromise = processSlackMention('add error handling', ctx, session, registry);
      await new Promise<void>(resolve => setTimeout(resolve, 10));
      session.pendingConfirm?.resolve({ ...mockIntent, createPr: true });
      await processPromise;

      const runAgentCall = vi.mocked(runAgent).mock.calls[0];
      expect(runAgentCall[0].createPr).toBe(true);
    });

    it('INV-S05. agentOptions for investigation has explorationSubtype set', async () => {
      vi.mocked(parseIntent).mockResolvedValueOnce({ ...mockInvestigationIntent });
      vi.mocked(runAgent).mockResolvedValueOnce({
        finalStatus: 'success',
        attempts: 1,
        sessionResults: [{ sessionId: 's1', status: 'success', finalResponse: '# Report', toolCallCount: 3, duration: 1000 }],
        verificationResults: [],
      });

      const client = createMockClient();
      const session = createMockSession();
      const ctx = { client, channel: 'C123', threadTs: '1234567890.123' };
      const registry = new ProjectRegistry({ cwd: '/tmp/test-registry' });

      const processPromise = processSlackMention('explore CI pipeline', ctx, session, registry);
      await new Promise<void>(resolve => setTimeout(resolve, 10));
      session.pendingConfirm?.resolve(mockInvestigationIntent);
      await processPromise;

      const runAgentCall = vi.mocked(runAgent).mock.calls[0];
      expect(runAgentCall[0].explorationSubtype).toBe('ci-checks');
    });

    it('INV-S06. investigation history entry has description from input text', async () => {
      const intentWithoutDesc = { ...mockInvestigationIntent, description: undefined };
      vi.mocked(parseIntent).mockResolvedValueOnce(intentWithoutDesc);
      vi.mocked(runAgent).mockResolvedValueOnce({
        finalStatus: 'success',
        attempts: 1,
        sessionResults: [{ sessionId: 's1', status: 'success', finalResponse: '# Report', toolCallCount: 3, duration: 1000 }],
        verificationResults: [],
      });

      const client = createMockClient();
      const session = createMockSession();
      const ctx = { client, channel: 'C123', threadTs: '1234567890.123' };
      const registry = new ProjectRegistry({ cwd: '/tmp/test-registry' });

      const processPromise = processSlackMention('explore CI pipeline', ctx, session, registry);
      await new Promise<void>(resolve => setTimeout(resolve, 10));
      session.pendingConfirm?.resolve({ ...intentWithoutDesc });
      await processPromise;

      expect(session.state.history[0].description).toBeTruthy();
      expect(session.state.history[0].description).toContain('explore');
    });
  });
});
