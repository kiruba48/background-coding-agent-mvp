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

import { parseIntent } from '../intent/index.js';
import { runAgent } from '../agent/index.js';
import { processInput, createSessionState } from './session.js';
import { ProjectRegistry } from '../agent/registry.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const mockParseIntent = parseIntent as ReturnType<typeof vi.fn>;
const mockRunAgent = runAgent as ReturnType<typeof vi.fn>;

function makeIntent(overrides: Partial<ResolvedIntent> = {}): ResolvedIntent {
  return {
    taskType: 'npm-dependency-update',
    repo: '/tmp/test-repo',
    dep: 'lodash',
    version: 'latest',
    confidence: 'high',
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

  // Test 7: processInput updates state.currentProject when task resolves a repo path
  it('7. processInput updates state.currentProject with resolved repo path', async () => {
    const intent = makeIntent({ repo: '/home/user/my-project' });
    const retryResult = makeRetryResult();
    mockParseIntent.mockResolvedValue(intent);
    mockRunAgent.mockResolvedValue(retryResult);

    const state = createSessionState();
    expect(state.currentProject).toBeNull();

    const callbacks = makeCallbacks({
      confirm: vi.fn().mockResolvedValue(intent),
    });

    await processInput('update lodash', state, callbacks, registry);

    expect(state.currentProject).toBe('/home/user/my-project');
    expect(state.currentProjectName).toBe('my-project');
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
});
