import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ResolvedIntent } from '../intent/types.js';
import type { RetryResult } from '../types.js';

// Mock parseIntent
vi.mock('../intent/index.js', () => ({
  parseIntent: vi.fn(),
}));

// Mock runAgent
vi.mock('../agent/index.js', () => ({
  runAgent: vi.fn(),
}));

// Mock autoRegisterCwd as no-op
vi.mock('../cli/auto-register.js', () => ({
  autoRegisterCwd: vi.fn().mockResolvedValue(undefined),
}));

// Mock createLogger to return a silent logger
vi.mock('../cli/utils/logger.js', () => ({
  createLogger: vi.fn().mockReturnValue({
    child: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock GitHubPRCreator — must use class/function syntax so `new GitHubPRCreator()` works
vi.mock('../orchestrator/pr-creator.js', () => ({
  GitHubPRCreator: vi.fn().mockImplementation(function (this: unknown) {
    (this as { create: ReturnType<typeof vi.fn> }).create = vi.fn().mockResolvedValue({
      url: 'https://github.com/org/repo/pull/42',
      created: true,
      branch: 'bg-agent/task-branch',
    });
  }),
}));

import { parseIntent } from '../intent/index.js';
import { runAgent } from '../agent/index.js';
import { GitHubPRCreator } from '../orchestrator/pr-creator.js';
import { processInput, createSessionState, runScopingDialogue } from './session.js';
import { ProjectRegistry } from '../agent/registry.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const mockParseIntent = parseIntent as ReturnType<typeof vi.fn>;
const mockRunAgent = runAgent as ReturnType<typeof vi.fn>;
const MockGitHubPRCreator = GitHubPRCreator as unknown as ReturnType<typeof vi.fn>;

function makeIntent(overrides: Partial<ResolvedIntent> = {}): ResolvedIntent {
  return {
    taskType: 'npm-dependency-update',
    repo: '/tmp/test-repo',
    dep: 'lodash',
    version: 'latest',
    confidence: 'high',
    scopingQuestions: [],
    ...overrides,
  };
}

function makeRetryResult(overrides: Partial<RetryResult> = {}): RetryResult {
  return {
    finalStatus: 'success',
    attempts: 1,
    sessionResults: [],
    verificationResults: [],
    ...overrides,
  };
}

import type { SessionCallbacks } from './types.js';

function makeCallbacks(overrides: Partial<SessionCallbacks> = {}): SessionCallbacks {
  const controller = new AbortController();
  return {
    confirm: vi.fn<SessionCallbacks['confirm']>().mockResolvedValue(makeIntent()),
    clarify: vi.fn<SessionCallbacks['clarify']>().mockResolvedValue(null),
    getSignal: vi.fn<SessionCallbacks['getSignal']>().mockReturnValue(controller.signal),
    ...overrides,
  };
}

describe('runScopingDialogue', () => {
  it('calls askQuestion for each question and returns formatted hints', async () => {
    const askQuestion = vi.fn()
      .mockResolvedValueOnce('auth module')
      .mockResolvedValueOnce('yes');
    const questions = ['Which area should be refactored?', 'Should tests be updated?'];
    const hints = await runScopingDialogue(questions, askQuestion);
    expect(askQuestion).toHaveBeenCalledTimes(2);
    expect(hints).toEqual([
      'Which area should be refactored?: auth module',
      'Should tests be updated?: yes',
    ]);
  });

  it('aborts entire dialogue when askQuestion returns null (Ctrl+C)', async () => {
    const askQuestion = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('tests too');
    const questions = ['Which area?', 'Should tests be updated?'];
    const hints = await runScopingDialogue(questions, askQuestion);
    // Ctrl+C breaks out — second question never asked
    expect(askQuestion).toHaveBeenCalledTimes(1);
    expect(hints).toEqual([]);
  });

  it('skips questions where askQuestion returns empty string (Enter)', async () => {
    const askQuestion = vi.fn()
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('  ')
      .mockResolvedValueOnce('auth');
    const questions = ['Q1', 'Q2', 'Q3'];
    const hints = await runScopingDialogue(questions, askQuestion);
    expect(hints).toEqual(['Q3: auth']);
  });

  it('caps at 3 questions even if more provided', async () => {
    const askQuestion = vi.fn().mockResolvedValue('answer');
    const questions = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'];
    const hints = await runScopingDialogue(questions, askQuestion);
    expect(askQuestion).toHaveBeenCalledTimes(3);
    expect(hints).toHaveLength(3);
  });

  it('returns empty array when no questions provided', async () => {
    const askQuestion = vi.fn();
    const hints = await runScopingDialogue([], askQuestion);
    expect(askQuestion).not.toHaveBeenCalled();
    expect(hints).toEqual([]);
  });
});

describe('src/repl/session.ts', () => {
  let tmpDir: string;
  let registry: ProjectRegistry;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await mkdtemp(path.join(tmpdir(), 'repl-test-'));
    registry = new ProjectRegistry({ cwd: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // Test 1: 'exit' returns { action: 'quit' }
  it('1. processInput("exit") returns { action: "quit" }', async () => {
    const state = createSessionState();
    const callbacks = makeCallbacks();

    const result = await processInput('exit', state, callbacks, registry);

    expect(result.action).toBe('quit');
    expect(mockParseIntent).not.toHaveBeenCalled();
  });

  // Test 2: 'quit' returns { action: 'quit' }
  it('2. processInput("quit") returns { action: "quit" }', async () => {
    const state = createSessionState();
    const callbacks = makeCallbacks();

    const result = await processInput('quit', state, callbacks, registry);

    expect(result.action).toBe('quit');
    expect(mockParseIntent).not.toHaveBeenCalled();
  });

  // Test 3: valid input calls parseIntent, confirm, runAgent; returns { action: 'continue', result: RetryResult }
  it('3. valid input calls parseIntent, confirm, runAgent; returns continue with result', async () => {
    const intent = makeIntent();
    const retryResult = makeRetryResult();
    mockParseIntent.mockResolvedValue(intent);
    mockRunAgent.mockResolvedValue(retryResult);

    const state = createSessionState();
    const callbacks = makeCallbacks({
      confirm: vi.fn().mockResolvedValue(intent),
    });

    const output = await processInput('update lodash', state, callbacks, registry);

    expect(mockParseIntent).toHaveBeenCalledOnce();
    expect(callbacks.confirm).toHaveBeenCalledOnce();
    expect(mockRunAgent).toHaveBeenCalledOnce();
    expect(output.action).toBe('continue');
    expect(output.result).toEqual(retryResult);
  });

  // Test 4: confirm returns null (user cancelled) — returns { action: 'continue', result: null }
  it('4. confirm returning null returns { action: "continue", result: null }', async () => {
    const intent = makeIntent();
    mockParseIntent.mockResolvedValue(intent);

    const state = createSessionState();
    const callbacks = makeCallbacks({
      confirm: vi.fn().mockResolvedValue(null),
    });

    const output = await processInput('update lodash', state, callbacks, registry);

    expect(output.action).toBe('continue');
    expect(output.result).toBeNull();
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  // Test 5: low confidence with clarifications calls callbacks.clarify, then re-parses
  it('5. low-confidence intent with clarifications calls clarify and re-parses', async () => {
    const lowIntent = makeIntent({
      confidence: 'low',
      clarifications: [
        { label: 'Update lodash to latest', intent: 'update lodash to latest' },
        { label: 'Update lodash-es to latest', intent: 'update lodash-es to latest' },
      ],
    });
    const highIntent = makeIntent({ dep: 'lodash', confidence: 'high' });
    const retryResult = makeRetryResult();

    // First call returns low confidence, second call returns high confidence
    mockParseIntent
      .mockResolvedValueOnce(lowIntent)
      .mockResolvedValueOnce(highIntent);
    mockRunAgent.mockResolvedValue(retryResult);

    const state = createSessionState();
    const callbacks = makeCallbacks({
      clarify: vi.fn().mockResolvedValue('update lodash to latest'),
      confirm: vi.fn().mockResolvedValue(highIntent),
    });

    const output = await processInput('update lodash', state, callbacks, registry);

    expect(callbacks.clarify).toHaveBeenCalledOnce();
    expect(mockParseIntent).toHaveBeenCalledTimes(2);
    expect(output.action).toBe('continue');
    expect(output.result).toEqual(retryResult);
  });

  // Test 6: clarify returns null (user cancelled) — returns { action: 'continue', result: null }
  it('6. clarify returning null returns { action: "continue", result: null }', async () => {
    const lowIntent = makeIntent({
      confidence: 'low',
      clarifications: [
        { label: 'Update lodash to latest', intent: 'update lodash to latest' },
      ],
    });
    mockParseIntent.mockResolvedValue(lowIntent);

    const state = createSessionState();
    const callbacks = makeCallbacks({
      clarify: vi.fn().mockResolvedValue(null),
    });

    const output = await processInput('update something', state, callbacks, registry);

    expect(output.action).toBe('continue');
    expect(output.result).toBeNull();
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  // Test 7: processInput updates state.currentProject AFTER confirmation
  it('7. processInput updates state.currentProject after confirmation, not before', async () => {
    const intent = makeIntent({ repo: '/home/user/my-project' });
    const retryResult = makeRetryResult();
    mockParseIntent.mockResolvedValue(intent);
    mockRunAgent.mockResolvedValue(retryResult);

    const state = createSessionState();
    expect(state.currentProject).toBeNull();

    const callbacks = makeCallbacks({
      confirm: vi.fn().mockImplementation(async () => {
        // State should NOT be updated yet during confirmation
        expect(state.currentProject).toBeNull();
        return intent;
      }),
    });

    await processInput('update lodash', state, callbacks, registry);

    // State updated after confirm returns
    expect(state.currentProject).toBe('/home/user/my-project');
    expect(state.currentProjectName).toBe('my-project');
  });

  // Test 7b: state not updated when user cancels at confirm
  it('7b. state not updated when user cancels at confirm', async () => {
    const intent = makeIntent({ repo: '/home/user/my-project' });
    mockParseIntent.mockResolvedValue(intent);

    const state = createSessionState();
    const callbacks = makeCallbacks({
      confirm: vi.fn().mockResolvedValue(null),
    });

    await processInput('update lodash', state, callbacks, registry);

    expect(state.currentProject).toBeNull();
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  // Test 8: processInput passes skipDockerChecks: true to runAgent context
  it('8. processInput passes skipDockerChecks: true to runAgent context', async () => {
    const intent = makeIntent();
    const retryResult = makeRetryResult();
    mockParseIntent.mockResolvedValue(intent);
    mockRunAgent.mockResolvedValue(retryResult);

    const state = createSessionState();
    const callbacks = makeCallbacks({
      confirm: vi.fn().mockResolvedValue(intent),
    });

    await processInput('update lodash', state, callbacks, registry);

    expect(mockRunAgent).toHaveBeenCalledOnce();
    const [, context] = mockRunAgent.mock.calls[0];
    expect(context.skipDockerChecks).toBe(true);
  });

  // Test 9: processInput passes signal from callbacks.getSignal() to runAgent context
  it('9. processInput passes signal from getSignal() to runAgent context', async () => {
    const intent = makeIntent();
    const retryResult = makeRetryResult();
    mockParseIntent.mockResolvedValue(intent);
    mockRunAgent.mockResolvedValue(retryResult);

    const controller = new AbortController();
    const state = createSessionState();
    const callbacks = makeCallbacks({
      confirm: vi.fn().mockResolvedValue(intent),
      getSignal: vi.fn().mockReturnValue(controller.signal),
    });

    await processInput('update lodash', state, callbacks, registry);

    expect(mockRunAgent).toHaveBeenCalledOnce();
    const [, context] = mockRunAgent.mock.calls[0];
    expect(context.signal).toBe(controller.signal);
  });

  // Test 10: createSessionState() returns initial state with currentProject null
  it('10. createSessionState() returns initial state with currentProject null', () => {
    const state = createSessionState();
    expect(state.currentProject).toBeNull();
    expect(state.currentProjectName).toBeNull();
  });

  // Test 11: input exceeding MAX_INPUT_LENGTH is rejected without LLM dispatch
  it('11. rejects input exceeding max length without calling parseIntent', async () => {
    const state = createSessionState();
    const callbacks = makeCallbacks();
    const longInput = 'a'.repeat(2001);

    const output = await processInput(longInput, state, callbacks, registry);

    expect(output.action).toBe('continue');
    expect(output.result).toBeNull();
    expect(mockParseIntent).not.toHaveBeenCalled();
  });

  // Test 12: clarify re-parse that returns low confidence bails out
  it('12. clarify re-parse returning low confidence bails out gracefully', async () => {
    const lowIntent = makeIntent({
      confidence: 'low',
      clarifications: [
        { label: 'Update lodash', intent: 'update lodash' },
      ],
    });
    const stillLow = makeIntent({ confidence: 'low' });

    mockParseIntent
      .mockResolvedValueOnce(lowIntent)
      .mockResolvedValueOnce(stillLow);

    const state = createSessionState();
    const callbacks = makeCallbacks({
      clarify: vi.fn().mockResolvedValue('update lodash'),
    });

    const output = await processInput('update something', state, callbacks, registry);

    expect(output.action).toBe('continue');
    expect(output.result).toBeNull();
    expect(callbacks.confirm).not.toHaveBeenCalled();
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it('13. calls onAgentStart before runAgent and onAgentEnd after', async () => {
    const intent = makeIntent();
    mockParseIntent.mockResolvedValue(intent);
    mockRunAgent.mockResolvedValue(makeRetryResult());

    const callOrder: string[] = [];
    const onAgentStart = vi.fn(() => callOrder.push('start'));
    const onAgentEnd = vi.fn(() => callOrder.push('end'));
    mockRunAgent.mockImplementation(async () => {
      callOrder.push('runAgent');
      return makeRetryResult();
    });

    const state = createSessionState();
    const callbacks = makeCallbacks({ onAgentStart, onAgentEnd });

    await processInput('update lodash', state, callbacks, registry);

    expect(onAgentStart).toHaveBeenCalledOnce();
    expect(onAgentEnd).toHaveBeenCalledOnce();
    expect(callOrder).toEqual(['start', 'runAgent', 'end']);
  });

  it('14. calls onAgentEnd even when runAgent throws', async () => {
    const intent = makeIntent();
    mockParseIntent.mockResolvedValue(intent);
    mockRunAgent.mockRejectedValue(new Error('agent crashed'));

    const onAgentStart = vi.fn();
    const onAgentEnd = vi.fn();

    const state = createSessionState();
    const callbacks = makeCallbacks({ onAgentStart, onAgentEnd });

    await expect(processInput('update lodash', state, callbacks, registry)).rejects.toThrow('agent crashed');

    expect(onAgentStart).toHaveBeenCalledOnce();
    expect(onAgentEnd).toHaveBeenCalledOnce();
  });

  // Test 15: createSessionState() returns state with history: []
  it('15. createSessionState() returns state with history: []', () => {
    const state = createSessionState();
    expect(state.history).toEqual([]);
  });

  // Test 16: processInput appends to history after successful runAgent
  it('16. processInput appends to history after successful runAgent', async () => {
    const intent = makeIntent();
    const retryResult = makeRetryResult();
    mockParseIntent.mockResolvedValue(intent);
    mockRunAgent.mockResolvedValue(retryResult);

    const state = createSessionState();
    const callbacks = makeCallbacks({
      confirm: vi.fn().mockResolvedValue(intent),
    });

    await processInput('update lodash', state, callbacks, registry);

    expect(state.history.length).toBe(1);
    expect(state.history[0]).toMatchObject({
      taskType: 'npm-dependency-update',
      dep: 'lodash',
      repo: '/tmp/test-repo',
      status: 'success',
    });
  });

  // Test 17: processInput appends to history with status 'failed' when runAgent throws
  it('17. processInput appends to history with status "failed" when runAgent throws', async () => {
    const intent = makeIntent();
    mockParseIntent.mockResolvedValue(intent);
    mockRunAgent.mockRejectedValue(new Error('agent failed'));

    const state = createSessionState();
    const callbacks = makeCallbacks({
      confirm: vi.fn().mockResolvedValue(intent),
    });

    await expect(processInput('update lodash', state, callbacks, registry)).rejects.toThrow('agent failed');

    expect(state.history.length).toBe(1);
    expect(state.history[0].status).toBe('failed');
  });

  // Test 18: processInput appends to history with status 'cancelled' when runAgent throws AbortError
  it('18. processInput appends to history with status "cancelled" when runAgent throws AbortError', async () => {
    const intent = makeIntent();
    mockParseIntent.mockResolvedValue(intent);
    const err = new Error('aborted');
    err.name = 'AbortError';
    mockRunAgent.mockRejectedValue(err);

    const state = createSessionState();
    const callbacks = makeCallbacks({
      confirm: vi.fn().mockResolvedValue(intent),
    });

    await expect(processInput('update lodash', state, callbacks, registry)).rejects.toThrow('aborted');

    expect(state.history.length).toBe(1);
    expect(state.history[0].status).toBe('cancelled');
  });

  // Test 19: history NOT appended when user cancels at confirm (confirm returns null)
  it('19. history NOT appended when user cancels at confirm', async () => {
    const intent = makeIntent();
    mockParseIntent.mockResolvedValue(intent);

    const state = createSessionState();
    const callbacks = makeCallbacks({
      confirm: vi.fn().mockResolvedValue(null),
    });

    await processInput('update lodash', state, callbacks, registry);

    expect(state.history.length).toBe(0);
  });

  // Test 20: history bounded to MAX_HISTORY_ENTRIES (10)
  it('20. history bounded to MAX_HISTORY_ENTRIES (10)', async () => {
    const { MAX_HISTORY_ENTRIES } = await import('./types.js');
    const intent = makeIntent();
    const retryResult = makeRetryResult();
    mockParseIntent.mockResolvedValue(intent);
    mockRunAgent.mockResolvedValue(retryResult);

    const state = createSessionState();
    // Pre-fill history with 10 entries
    for (let i = 0; i < MAX_HISTORY_ENTRIES; i++) {
      state.history.push({
        taskType: 'npm-dependency-update',
        dep: `dep-${i}`,
        version: 'latest',
        repo: '/tmp/old-repo',
        status: 'success',
      });
    }
    const firstOriginalEntry = state.history[1]; // second entry becomes first after shift

    const callbacks = makeCallbacks({
      confirm: vi.fn().mockResolvedValue(intent),
    });

    await processInput('update lodash', state, callbacks, registry);

    expect(state.history.length).toBe(MAX_HISTORY_ENTRIES);
    expect(state.history[0]).toEqual(firstOriginalEntry); // oldest shifted out
    expect(state.history[MAX_HISTORY_ENTRIES - 1]).toMatchObject({
      taskType: 'npm-dependency-update',
      dep: 'lodash',
      repo: '/tmp/test-repo',
      status: 'success',
    });
  });

  // Test 21: processInput("history") with empty history prints message and returns continue
  it('21. processInput("history") with empty history prints message and returns continue', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });

    const state = createSessionState();
    const callbacks = makeCallbacks();

    const result = await processInput('history', state, callbacks, registry);

    vi.restoreAllMocks();
    const allOutput = logs.join('\n');
    expect(allOutput).toContain('No tasks in session history');
    expect(result.action).toBe('continue');
    expect(mockParseIntent).not.toHaveBeenCalled();
  });

  // Test 22: processInput("history") with entries prints numbered list and returns continue
  it('22. processInput("history") with entries prints numbered list and returns continue', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });

    const state = createSessionState();
    state.history = [{
      taskType: 'npm-dependency-update',
      dep: 'lodash',
      version: 'latest',
      repo: '/tmp/repo',
      status: 'success',
    }];
    const callbacks = makeCallbacks();

    const result = await processInput('history', state, callbacks, registry);

    vi.restoreAllMocks();
    const allOutput = logs.join('\n');
    expect(allOutput).toContain('npm-dependency-update');
    expect(allOutput).toContain('lodash');
    expect(result.action).toBe('continue');
    expect(mockParseIntent).not.toHaveBeenCalled();
  });

  // Test 23: processInput passes state.history to parseIntent
  it('23. processInput passes state.history to parseIntent', async () => {
    const intent = makeIntent();
    const retryResult = makeRetryResult();
    mockParseIntent.mockResolvedValue(intent);
    mockRunAgent.mockResolvedValue(retryResult);

    const state = createSessionState();
    const callbacks = makeCallbacks({
      confirm: vi.fn().mockResolvedValue(intent),
    });

    await processInput('update lodash', state, callbacks, registry);

    expect(mockParseIntent).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ history: [] }),
    );
  });

  // FLLW-02 tests: lastRetryResult and lastIntent stored on state

  // Test FLLW-02a: After successful runAgent, state.lastRetryResult equals the returned RetryResult object
  it('FLLW-02a. state.lastRetryResult equals returned RetryResult after successful runAgent', async () => {
    const intent = makeIntent();
    const retryResult = makeRetryResult();
    mockParseIntent.mockResolvedValue(intent);
    mockRunAgent.mockResolvedValue(retryResult);

    const state = createSessionState();
    const callbacks = makeCallbacks({
      confirm: vi.fn().mockResolvedValue(intent),
    });

    await processInput('update lodash', state, callbacks, registry);

    expect(state.lastRetryResult).toBe(retryResult);
  });

  // Test FLLW-02b: After successful runAgent, state.lastIntent equals the confirmed ResolvedIntent object
  it('FLLW-02b. state.lastIntent equals confirmed intent after successful runAgent', async () => {
    const intent = makeIntent();
    const retryResult = makeRetryResult();
    mockParseIntent.mockResolvedValue(intent);
    mockRunAgent.mockResolvedValue(retryResult);

    const state = createSessionState();
    const callbacks = makeCallbacks({
      confirm: vi.fn().mockResolvedValue(intent),
    });

    await processInput('update lodash', state, callbacks, registry);

    expect(state.lastIntent).toBe(intent);
  });

  // Test FLLW-02c: After runAgent throws (non-abort), state.lastRetryResult remains undefined
  it('FLLW-02c. state.lastRetryResult remains undefined after runAgent throws non-abort error', async () => {
    const intent = makeIntent();
    mockParseIntent.mockResolvedValue(intent);
    mockRunAgent.mockRejectedValue(new Error('agent crashed'));

    const state = createSessionState();
    const callbacks = makeCallbacks({
      confirm: vi.fn().mockResolvedValue(intent),
    });

    await expect(processInput('update lodash', state, callbacks, registry)).rejects.toThrow('agent crashed');

    expect(state.lastRetryResult).toBeUndefined();
  });

  // Test FLLW-02d: After runAgent throws AbortError, state.lastRetryResult remains undefined
  it('FLLW-02d. state.lastRetryResult remains undefined after runAgent throws AbortError', async () => {
    const intent = makeIntent();
    mockParseIntent.mockResolvedValue(intent);
    const err = new Error('aborted');
    err.name = 'AbortError';
    mockRunAgent.mockRejectedValue(err);

    const state = createSessionState();
    const callbacks = makeCallbacks({
      confirm: vi.fn().mockResolvedValue(intent),
    });

    await expect(processInput('update lodash', state, callbacks, registry)).rejects.toThrow('aborted');

    expect(state.lastRetryResult).toBeUndefined();
  });

  // FLLW-01 tests: description populated on TaskHistoryEntry

  // Test FLLW-01a: After successful generic task, state.history[0].description equals intent.description
  it('FLLW-01a. history entry description equals intent.description for generic task', async () => {
    const intent = makeIntent({
      taskType: 'generic',
      description: 'add error handling to auth.ts',
      dep: null,
      version: null,
    });
    const retryResult = makeRetryResult();
    mockParseIntent.mockResolvedValue(intent);
    mockRunAgent.mockResolvedValue(retryResult);

    const state = createSessionState();
    const callbacks = makeCallbacks({
      confirm: vi.fn().mockResolvedValue(intent),
    });

    await processInput('add error handling to auth.ts', state, callbacks, registry);

    expect(state.history[0].description).toBe('add error handling to auth.ts');
  });

  // Test FLLW-01b: After successful dep update with dep='lodash' version='4.0.0', description is 'update lodash to 4.0.0'
  it('FLLW-01b. history entry description is "update lodash to 4.0.0" for dep update with version', async () => {
    const intent = makeIntent({
      taskType: 'npm-dependency-update',
      dep: 'lodash',
      version: '4.0.0',
    });
    const retryResult = makeRetryResult();
    mockParseIntent.mockResolvedValue(intent);
    mockRunAgent.mockResolvedValue(retryResult);

    const state = createSessionState();
    const callbacks = makeCallbacks({
      confirm: vi.fn().mockResolvedValue(intent),
    });

    await processInput('update lodash to 4.0.0', state, callbacks, registry);

    expect(state.history[0].description).toBe('update lodash to 4.0.0');
  });

  // Test FLLW-01c: After successful dep update with dep='lodash' version=null, description is 'update lodash to latest'
  it('FLLW-01c. history entry description is "update lodash to latest" for dep update with null version', async () => {
    const intent = makeIntent({
      taskType: 'npm-dependency-update',
      dep: 'lodash',
      version: null,
    });
    const retryResult = makeRetryResult();
    mockParseIntent.mockResolvedValue(intent);
    mockRunAgent.mockResolvedValue(retryResult);

    const state = createSessionState();
    const callbacks = makeCallbacks({
      confirm: vi.fn().mockResolvedValue(intent),
    });

    await processInput('update lodash', state, callbacks, registry);

    expect(state.history[0].description).toBe('update lodash to latest');
  });

  // Test FLLW-01d: After dep update with dep=null, state.history[0].description is undefined
  it('FLLW-01d. history entry description is undefined when dep is null', async () => {
    const intent = makeIntent({
      taskType: 'npm-dependency-update',
      dep: null,
      version: null,
    });
    const retryResult = makeRetryResult();
    mockParseIntent.mockResolvedValue(intent);
    mockRunAgent.mockResolvedValue(retryResult);

    const state = createSessionState();
    const callbacks = makeCallbacks({
      confirm: vi.fn().mockResolvedValue(intent),
    });

    await processInput('update something', state, callbacks, registry);

    expect(state.history[0].description).toBeUndefined();
  });

  // PR meta-command tests

  // Test PR-01: processInput('pr') with valid state calls GitHubPRCreator and returns prResult
  it('PR-01. processInput("pr") with valid state calls GitHubPRCreator and returns prResult', async () => {
    const state = createSessionState();
    state.lastRetryResult = makeRetryResult();
    state.lastIntent = makeIntent({ repo: '/tmp/test-repo', description: 'add error handling' });
    state.currentProjectName = 'test-repo';
    const callbacks = makeCallbacks();

    const output = await processInput('pr', state, callbacks, registry);

    expect(output.action).toBe('continue');
    expect(output.prResult?.url).toBe('https://github.com/org/repo/pull/42');
    expect(mockParseIntent).not.toHaveBeenCalled();
  });

  // Test PR-02a: processInput('pr') with no lastRetryResult returns continue with no prResult and 'No completed task'
  it('PR-02a. processInput("pr") with no lastRetryResult returns continue and logs "No completed task"', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });

    const state = createSessionState();
    const callbacks = makeCallbacks();

    const output = await processInput('pr', state, callbacks, registry);

    vi.restoreAllMocks();
    expect(output.action).toBe('continue');
    expect(output.prResult).toBeUndefined();
    expect(logs.join('\n')).toContain('No completed task in this session');
    expect(MockGitHubPRCreator).not.toHaveBeenCalled();
    expect(mockParseIntent).not.toHaveBeenCalled();
  });

  // Test PR-02b: processInput('pr') with lastRetryResult.finalStatus='failed' returns 'No completed task'
  it('PR-02b. processInput("pr") with failed lastRetryResult logs "No completed task"', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });

    const state = createSessionState();
    state.lastRetryResult = makeRetryResult({ finalStatus: 'failed' });
    state.lastIntent = makeIntent();
    const callbacks = makeCallbacks();

    const output = await processInput('pr', state, callbacks, registry);

    vi.restoreAllMocks();
    expect(output.action).toBe('continue');
    expect(output.prResult).toBeUndefined();
    expect(logs.join('\n')).toContain('No completed task in this session');
    expect(MockGitHubPRCreator).not.toHaveBeenCalled();
  });

  // Test PR-03: processInput('pr') with valid state prints 'Creating PR for: ...' before create()
  it('PR-03. processInput("pr") with valid state prints "Creating PR for:" summary line', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });

    const state = createSessionState();
    state.lastRetryResult = makeRetryResult();
    state.lastIntent = makeIntent({ repo: '/tmp/test-repo', description: 'add error handling' });
    state.currentProjectName = 'test-repo';
    const callbacks = makeCallbacks();

    await processInput('pr', state, callbacks, registry);

    vi.restoreAllMocks();
    const allOutput = logs.join('\n');
    expect(allOutput).toContain('Creating PR for:');
    expect(allOutput).toContain('add error handling');
    expect(allOutput).toContain('test-repo');
  });

  // Test PR-04a: processInput('create pr') is intercepted; parseIntent NOT called
  it('PR-04a. processInput("create pr") is intercepted and calls GitHubPRCreator; parseIntent NOT called', async () => {
    const state = createSessionState();
    state.lastRetryResult = makeRetryResult();
    state.lastIntent = makeIntent({ repo: '/tmp/test-repo' });
    state.currentProjectName = 'test-repo';
    const callbacks = makeCallbacks();

    const output = await processInput('create pr', state, callbacks, registry);

    expect(mockParseIntent).not.toHaveBeenCalled();
    expect(MockGitHubPRCreator).toHaveBeenCalled();
    expect(output.prResult?.url).toBe('https://github.com/org/repo/pull/42');
  });

  // Test PR-04b: processInput('create a pr') is intercepted; parseIntent NOT called
  it('PR-04b. processInput("create a pr") is intercepted and calls GitHubPRCreator; parseIntent NOT called', async () => {
    const state = createSessionState();
    state.lastRetryResult = makeRetryResult();
    state.lastIntent = makeIntent({ repo: '/tmp/test-repo' });
    state.currentProjectName = 'test-repo';
    const callbacks = makeCallbacks();

    const output = await processInput('create a pr', state, callbacks, registry);

    expect(mockParseIntent).not.toHaveBeenCalled();
    expect(MockGitHubPRCreator).toHaveBeenCalled();
    expect(output.prResult?.url).toBe('https://github.com/org/repo/pull/42');
  });

  // Test PR-ERR: processInput('pr') where create() throws returns prResult with error (S1 unified error path)
  it('PR-ERR. processInput("pr") where create() throws returns prResult with error field', async () => {
    // Override create() to throw
    MockGitHubPRCreator.mockImplementationOnce(() => ({
      create: vi.fn().mockRejectedValue(new Error('GITHUB_TOKEN environment variable is required')),
    }));

    const state = createSessionState();
    state.lastRetryResult = makeRetryResult();
    state.lastIntent = makeIntent({ repo: '/tmp/test-repo' });
    state.currentProjectName = 'test-repo';
    const callbacks = makeCallbacks();

    const output = await processInput('pr', state, callbacks, registry);

    expect(output.action).toBe('continue');
    expect(output.prResult).toBeDefined();
    expect(output.prResult?.error).toContain('GITHUB_TOKEN');
    expect(output.prResult?.created).toBe(false);
  });

  // Test PR-04c: processInput('create a pr for that') is intercepted (P1 fix — SC-04)
  it('PR-04c. processInput("create a pr for that") is intercepted; parseIntent NOT called', async () => {
    const state = createSessionState();
    state.lastRetryResult = makeRetryResult();
    state.lastIntent = makeIntent({ repo: '/tmp/test-repo' });
    state.currentProjectName = 'test-repo';
    const callbacks = makeCallbacks();

    const output = await processInput('create a pr for that', state, callbacks, registry);

    expect(mockParseIntent).not.toHaveBeenCalled();
    expect(MockGitHubPRCreator).toHaveBeenCalled();
    expect(output.prResult?.url).toBe('https://github.com/org/repo/pull/42');
  });

  // Test PR-04d: processInput('create pr for this') is intercepted
  it('PR-04d. processInput("create pr for this") is intercepted; parseIntent NOT called', async () => {
    const state = createSessionState();
    state.lastRetryResult = makeRetryResult();
    state.lastIntent = makeIntent({ repo: '/tmp/test-repo' });
    state.currentProjectName = 'test-repo';
    const callbacks = makeCallbacks();

    const output = await processInput('create pr for this', state, callbacks, registry);

    expect(mockParseIntent).not.toHaveBeenCalled();
    expect(MockGitHubPRCreator).toHaveBeenCalled();
    expect(output.prResult?.url).toBe('https://github.com/org/repo/pull/42');
  });

  // Test PR-DUP: second 'pr' after successful PR returns "No completed task" (P2 fix — duplicate prevention)
  it('PR-DUP. second "pr" after successful PR returns "No completed task"', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });

    const state = createSessionState();
    state.lastRetryResult = makeRetryResult();
    state.lastIntent = makeIntent({ repo: '/tmp/test-repo' });
    state.currentProjectName = 'test-repo';
    const callbacks = makeCallbacks();

    // First PR — succeeds and clears state
    const first = await processInput('pr', state, callbacks, registry);
    expect(first.prResult?.url).toBe('https://github.com/org/repo/pull/42');

    // Second PR — state cleared, should get "No completed task"
    const second = await processInput('pr', state, callbacks, registry);
    expect(second.prResult).toBeUndefined();

    vi.restoreAllMocks();
    expect(logs.join('\n')).toContain('No completed task');
  });

  // Test V1: failed runAgent does NOT overwrite previous successful lastRetryResult
  it('V1. failed runAgent does NOT overwrite previous successful lastRetryResult', async () => {
    const successResult = makeRetryResult({ finalStatus: 'success' });
    const successIntent = makeIntent({ repo: '/tmp/repo-a', description: 'first task' });
    const failedResult = makeRetryResult({ finalStatus: 'failed' });
    const failedIntent = makeIntent({ repo: '/tmp/repo-b', description: 'second task' });

    const state = createSessionState();
    const callbacks = makeCallbacks();

    // First task succeeds
    mockParseIntent.mockResolvedValueOnce(successIntent);
    mockRunAgent.mockResolvedValueOnce(successResult);
    (callbacks.confirm as ReturnType<typeof vi.fn>).mockResolvedValueOnce(successIntent);
    await processInput('first task', state, callbacks, registry);

    expect(state.lastRetryResult).toBe(successResult);
    expect(state.lastIntent).toBe(successIntent);

    // Second task fails — should NOT overwrite
    mockParseIntent.mockResolvedValueOnce(failedIntent);
    mockRunAgent.mockResolvedValueOnce(failedResult);
    (callbacks.confirm as ReturnType<typeof vi.fn>).mockResolvedValueOnce(failedIntent);
    await processInput('second task', state, callbacks, registry);

    // State still holds the successful result
    expect(state.lastRetryResult).toBe(successResult);
    expect(state.lastIntent).toBe(successIntent);
  });

  // Test PR-PASSTHROUGH: processInput('fix the PR template') calls parseIntent (NOT intercepted)
  it('PR-PASSTHROUGH. processInput("fix the PR template") is NOT intercepted; parseIntent IS called', async () => {
    const intent = makeIntent({ description: 'fix the PR template' });
    const retryResult = makeRetryResult();
    mockParseIntent.mockResolvedValue(intent);
    mockRunAgent.mockResolvedValue(retryResult);

    const state = createSessionState();
    const callbacks = makeCallbacks({
      confirm: vi.fn().mockResolvedValue(intent),
    });

    await processInput('fix the PR template', state, callbacks, registry);

    expect(mockParseIntent).toHaveBeenCalled();
    expect(MockGitHubPRCreator).not.toHaveBeenCalled();
  });

  // Scoping dialogue tests

  it('SCOPE-01. processInput for generic task with scopingQuestions calls askQuestion', async () => {
    const intent = makeIntent({
      taskType: 'generic',
      dep: null,
      version: null,
      description: 'add error handling',
      scopingQuestions: ['Which area should error handling focus on?'],
    });
    const retryResult = makeRetryResult();
    const confirmedIntent = makeIntent({ taskType: 'generic', dep: null, version: null });
    mockParseIntent.mockResolvedValue(intent);
    mockRunAgent.mockResolvedValue(retryResult);

    const askQuestion = vi.fn().mockResolvedValue('auth module');
    const state = createSessionState();
    const callbacks = makeCallbacks({
      confirm: vi.fn().mockResolvedValue(confirmedIntent),
      askQuestion,
    });

    await processInput('add error handling', state, callbacks, registry);

    expect(askQuestion).toHaveBeenCalledOnce();
  });

  it('SCOPE-02. processInput for npm-dependency-update does NOT call askQuestion even if scopingQuestions present', async () => {
    const intent = makeIntent({
      taskType: 'npm-dependency-update',
      dep: 'lodash',
      version: 'latest',
      scopingQuestions: ['Which files should be updated?'],
    });
    const retryResult = makeRetryResult();
    mockParseIntent.mockResolvedValue(intent);
    mockRunAgent.mockResolvedValue(retryResult);

    const askQuestion = vi.fn().mockResolvedValue('some answer');
    const state = createSessionState();
    const callbacks = makeCallbacks({
      confirm: vi.fn().mockResolvedValue(intent),
      askQuestion,
    });

    await processInput('update lodash', state, callbacks, registry);

    expect(askQuestion).not.toHaveBeenCalled();
  });

  it('SCOPE-03. processInput with no callbacks.askQuestion skips scoping silently', async () => {
    const intent = makeIntent({
      taskType: 'generic',
      dep: null,
      version: null,
      description: 'add error handling',
      scopingQuestions: ['Which area?'],
    });
    const retryResult = makeRetryResult();
    const confirmedIntent = makeIntent({ taskType: 'generic', dep: null, version: null });
    mockParseIntent.mockResolvedValue(intent);
    mockRunAgent.mockResolvedValue(retryResult);

    // No askQuestion in callbacks
    const state = createSessionState();
    const callbacks = makeCallbacks({
      confirm: vi.fn().mockResolvedValue(confirmedIntent),
    });

    // Should not throw
    const output = await processInput('add error handling', state, callbacks, registry);
    expect(output.action).toBe('continue');
    expect(mockRunAgent).toHaveBeenCalledOnce();
  });

  it('SCOPE-04. processInput passes scopeHints to runAgent agentOptions', async () => {
    const intent = makeIntent({
      taskType: 'generic',
      dep: null,
      version: null,
      description: 'add error handling',
      scopingQuestions: ['Which area?'],
    });
    const retryResult = makeRetryResult();
    const confirmedIntent = makeIntent({ taskType: 'generic', dep: null, version: null });
    mockParseIntent.mockResolvedValue(intent);
    mockRunAgent.mockResolvedValue(retryResult);

    const askQuestion = vi.fn().mockResolvedValue('auth module');
    const state = createSessionState();
    const callbacks = makeCallbacks({
      confirm: vi.fn().mockResolvedValue(confirmedIntent),
      askQuestion,
    });

    await processInput('add error handling', state, callbacks, registry);

    expect(mockRunAgent).toHaveBeenCalledOnce();
    const [agentOptions] = mockRunAgent.mock.calls[0];
    expect(agentOptions.scopeHints).toEqual(['Which area?: auth module']);
  });

  it('SCOPE-05. processInput passes scopeHints to callbacks.confirm', async () => {
    const intent = makeIntent({
      taskType: 'generic',
      dep: null,
      version: null,
      description: 'add error handling',
      scopingQuestions: ['Which area?'],
    });
    const retryResult = makeRetryResult();
    const confirmedIntent = makeIntent({ taskType: 'generic', dep: null, version: null });
    mockParseIntent.mockResolvedValue(intent);
    mockRunAgent.mockResolvedValue(retryResult);

    const askQuestion = vi.fn().mockResolvedValue('auth module');
    const confirmMock = vi.fn().mockResolvedValue(confirmedIntent);
    const state = createSessionState();
    const callbacks = makeCallbacks({
      confirm: confirmMock,
      askQuestion,
    });

    await processInput('add error handling', state, callbacks, registry);

    expect(confirmMock).toHaveBeenCalledOnce();
    const [, , scopeHints] = confirmMock.mock.calls[0];
    expect(scopeHints).toEqual(['Which area?: auth module']);
  });
});
