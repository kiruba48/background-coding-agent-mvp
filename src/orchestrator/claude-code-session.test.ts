import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionResult } from '../types.js';

// Mock the SDK module before importing ClaudeCodeSession
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

// Mock the MCP verifier server to prevent importing compositeVerifier etc.
vi.mock('../mcp/verifier-server.js', () => ({
  createVerifierMcpServer: vi.fn().mockReturnValue({ type: 'sdk', name: 'verifier', instance: {} }),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeCodeSession } from './claude-code-session.js';

const mockQuery = query as ReturnType<typeof vi.fn>;

// Helper: create an async generator that yields specified messages
async function* makeQueryGen(messages: any[]) {
  for (const msg of messages) yield msg;
}

// A generator that tracks if .return() was called
function makeTrackableGen(messages: any[]) {
  let returnCalled = false;
  const gen = (async function* () {
    for (const msg of messages) yield msg;
  })();
  const tracked = {
    [Symbol.asyncIterator]() { return this; },
    next: gen.next.bind(gen),
    return: async (value?: any) => {
      returnCalled = true;
      return gen.return(value);
    },
    throw: gen.throw.bind(gen),
    wasReturnCalled: () => returnCalled,
  };
  return tracked;
}

function makeSuccessResult() {
  return {
    type: 'result',
    subtype: 'success',
    session_id: 'sdk-session-id',
    result: 'Task completed',
    duration_ms: 1500,
    duration_api_ms: 1200,
    num_turns: 3,
    total_cost_usd: 0.05,
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
    stop_reason: 'end_turn',
    is_error: false,
    uuid: 'test-uuid',
  };
}

describe('ClaudeCodeSession', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // Test 1: success path
  it('returns success SessionResult on successful query', async () => {
    mockQuery.mockReturnValue(makeQueryGen([makeSuccessResult()]));
    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace' });
    await session.start();
    const result = await session.run('Fix the bug');
    expect(result.status).toBe('success');
    expect(result.finalResponse).toBe('Task completed');
    expect(result.sessionId).toBeTruthy();
    expect(typeof result.duration).toBe('number');
    expect(typeof result.toolCallCount).toBe('number');
  });

  // Test 2: error_max_turns -> turn_limit
  it('maps error_max_turns to turn_limit status', async () => {
    mockQuery.mockReturnValue(makeQueryGen([{
      type: 'result', subtype: 'error_max_turns',
      session_id: 's', duration_ms: 1000, duration_api_ms: 900, num_turns: 10,
      total_cost_usd: 0.5, usage: {}, modelUsage: {}, permission_denials: [],
      errors: ['Max turns exceeded'], stop_reason: null, is_error: true, uuid: 'u',
    }]));
    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace', turnLimit: 10 });
    await session.start();
    const result = await session.run('task');
    expect(result.status).toBe('turn_limit');
    expect(result.error).toBe('Turn limit exceeded');
  });

  // Test 3: error_max_budget_usd -> turn_limit
  it('maps error_max_budget_usd to turn_limit status', async () => {
    mockQuery.mockReturnValue(makeQueryGen([{
      type: 'result', subtype: 'error_max_budget_usd',
      session_id: 's', duration_ms: 1000, duration_api_ms: 900, num_turns: 5,
      total_cost_usd: 2.01, usage: {}, modelUsage: {}, permission_denials: [],
      errors: ['Budget exceeded'], stop_reason: null, is_error: true, uuid: 'u',
    }]));
    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace' });
    const result = await session.run('task');
    expect(result.status).toBe('turn_limit');
    expect(result.error).toBe('Session budget exceeded');
  });

  // Test 4: error_during_execution -> failed
  it('maps error_during_execution to failed status', async () => {
    mockQuery.mockReturnValue(makeQueryGen([{
      type: 'result', subtype: 'error_during_execution',
      session_id: 's', duration_ms: 500, duration_api_ms: 400, num_turns: 2,
      total_cost_usd: 0.01, usage: {}, modelUsage: {}, permission_denials: [],
      errors: ['Something went wrong'], stop_reason: null, is_error: true, uuid: 'u',
    }]));
    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace' });
    const result = await session.run('task');
    expect(result.status).toBe('failed');
    expect(result.error).toBeTruthy();
  });

  // Test 5: correct options passed to query()
  it('passes correct options to query()', async () => {
    mockQuery.mockReturnValue(makeQueryGen([makeSuccessResult()]));
    const session = new ClaudeCodeSession({
      workspaceDir: '/tmp/workspace',
      turnLimit: 5,
      model: 'claude-sonnet-4-5',
    });
    await session.run('task');
    expect(mockQuery).toHaveBeenCalledOnce();
    const callArg = mockQuery.mock.calls[0][0];
    expect(callArg.options.permissionMode).toBe('acceptEdits');
    expect(callArg.options.disallowedTools).toEqual(['WebSearch', 'WebFetch']);
    expect(callArg.options.maxTurns).toBe(5);
    expect(callArg.options.maxBudgetUsd).toBe(2.00);
    expect(callArg.options.settingSources).toEqual([]);
    expect(callArg.options.cwd).toContain('workspace');
  });

  // Test 6: PreToolUse hook blocks writes outside repo
  it('PreToolUse hook blocks writes outside repo', async () => {
    mockQuery.mockReturnValue(makeQueryGen([makeSuccessResult()]));
    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace' });
    await session.run('task');
    const callArg = mockQuery.mock.calls[0][0];
    const preHooks = callArg.options.hooks.PreToolUse;
    expect(preHooks).toHaveLength(1);
    const hookFn = preHooks[0].hooks[0];
    const input = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '/etc/passwd' },
      tool_use_id: 'id-1',
      session_id: 's', transcript_path: 't', cwd: '/tmp/workspace',
    };
    const result = await hookFn(input, 'id-1', { signal: new AbortController().signal });
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  // Test 7: PreToolUse hook blocks .env files
  it('PreToolUse hook blocks .env files', async () => {
    mockQuery.mockReturnValue(makeQueryGen([makeSuccessResult()]));
    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace' });
    await session.run('task');
    const callArg = mockQuery.mock.calls[0][0];
    const hookFn = callArg.options.hooks.PreToolUse[0].hooks[0];
    const input = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/workspace/.env' },
      tool_use_id: 'id-2',
      session_id: 's', transcript_path: 't', cwd: '/tmp/workspace',
    };
    const result = await hookFn(input, 'id-2', { signal: new AbortController().signal });
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  // Test 8: PreToolUse hook blocks .git/ paths
  it('PreToolUse hook blocks .git/ paths', async () => {
    mockQuery.mockReturnValue(makeQueryGen([makeSuccessResult()]));
    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace' });
    await session.run('task');
    const callArg = mockQuery.mock.calls[0][0];
    const hookFn = callArg.options.hooks.PreToolUse[0].hooks[0];
    const input = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/workspace/.git/config' },
      tool_use_id: 'id-3',
      session_id: 's', transcript_path: 't', cwd: '/tmp/workspace',
    };
    const result = await hookFn(input, 'id-3', { signal: new AbortController().signal });
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  // Test 9: PreToolUse hook allows writes inside repo
  it('PreToolUse hook allows writes inside repo', async () => {
    mockQuery.mockReturnValue(makeQueryGen([makeSuccessResult()]));
    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace' });
    await session.run('task');
    const callArg = mockQuery.mock.calls[0][0];
    const hookFn = callArg.options.hooks.PreToolUse[0].hooks[0];
    const input = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/workspace/src/index.ts' },
      tool_use_id: 'id-4',
      session_id: 's', transcript_path: 't', cwd: '/tmp/workspace',
    };
    const result = await hookFn(input, 'id-4', { signal: new AbortController().signal });
    // Allow: no hookSpecificOutput deny
    expect(result.hookSpecificOutput?.permissionDecision).not.toBe('deny');
  });

  // Test 10: PostToolUse hook increments tool call counter
  it('PostToolUse hook increments tool call counter', async () => {
    // We need a generator that calls the post hook during iteration
    // We'll test this by running a session where query() yields a result
    // and manually extracting/testing the PostToolUse hook
    mockQuery.mockReturnValue(makeQueryGen([makeSuccessResult()]));
    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace' });
    await session.run('task');
    const callArg = mockQuery.mock.calls[0][0];
    const postHooks = callArg.options.hooks.PostToolUse;
    expect(postHooks).toHaveLength(1);
    const hookFn = postHooks[0].hooks[0];

    // Call the hook twice
    const postInput = {
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/workspace/src/index.ts' },
      tool_response: { outcome: 'success' },
      tool_use_id: 'id-5',
      session_id: 's', transcript_path: 't', cwd: '/tmp/workspace',
    };
    await hookFn(postInput, 'id-5', { signal: new AbortController().signal });
    await hookFn(postInput, 'id-6', { signal: new AbortController().signal });

    // Now run a fresh session to verify the counter within the run
    // The counter is internal to each run(), so we test via a modified approach:
    // create a gen that has the post hook fire, then check toolCallCount
    // For simplicity: verify the hook fn can be called without error (counter is internal)
    // A fresh run with a sequence that captures post hook count is done below:
    mockQuery.mockImplementationOnce((args: any) => {
      const postHook = args.options.hooks.PostToolUse[0].hooks[0];
      // Fire the hook twice before yielding result
      const gen = (async function* () {
        await postHook({ hook_event_name: 'PostToolUse', tool_name: 'Write',
          tool_input: { file_path: '/tmp/workspace/a.ts' }, tool_response: {},
          tool_use_id: 'p1', session_id: 's', transcript_path: 't', cwd: '/tmp' }, 'p1', { signal: new AbortController().signal });
        await postHook({ hook_event_name: 'PostToolUse', tool_name: 'Edit',
          tool_input: { file_path: '/tmp/workspace/b.ts' }, tool_response: {},
          tool_use_id: 'p2', session_id: 's', transcript_path: 't', cwd: '/tmp' }, 'p2', { signal: new AbortController().signal });
        yield makeSuccessResult();
      })();
      return gen;
    });
    const session2 = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace' });
    const result2 = await session2.run('task');
    expect(result2.toolCallCount).toBe(2);
  });

  // Test 11: PostToolUse hook logs audit event
  it('PostToolUse hook logs audit event', async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as any;
    mockQuery.mockReturnValue(makeQueryGen([makeSuccessResult()]));
    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace' });
    await session.run('task', logger);
    const callArg = mockQuery.mock.calls[0][0];
    const hookFn = callArg.options.hooks.PostToolUse[0].hooks[0];
    const postInput = {
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/workspace/src/index.ts' },
      tool_response: { outcome: 'success' },
      tool_use_id: 'id-log',
      session_id: 's', transcript_path: 't', cwd: '/tmp/workspace',
    };
    await hookFn(postInput, 'id-log', { signal: new AbortController().signal });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'audit', tool: 'Write', path: expect.any(String) }),
      'file_changed'
    );
  });

  // Test 12: start() is a no-op
  it('start() is a no-op', async () => {
    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace' });
    await expect(session.start()).resolves.toBeUndefined();
  });

  // Test 13: stop() aborts via AbortController
  it('stop() aborts via AbortController', async () => {
    let capturedAbortController: AbortController | undefined;
    mockQuery.mockImplementation((args: any) => {
      capturedAbortController = args.options.abortController;
      return makeQueryGen([makeSuccessResult()]);
    });
    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace' });
    const runPromise = session.run('task');
    // Call stop before run completes - it may already be done given sync gen
    await session.stop();
    await runPromise;
    // Verify AbortController was passed to query
    expect(capturedAbortController).toBeInstanceOf(AbortController);
  });

  // Test 14: returns failed status when query() throws
  it('returns failed status when query() throws', async () => {
    mockQuery.mockImplementation(() => {
      throw new Error('network error');
    });
    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace' });
    const result = await session.run('task');
    expect(result.status).toBe('failed');
    expect(result.error).toBe('network error');
  });

  // Test 15: generator is closed in finally block
  it('generator is closed in finally block', async () => {
    const trackedGen = makeTrackableGen([makeSuccessResult()]);
    mockQuery.mockReturnValue(trackedGen);
    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace' });
    await session.run('task');
    expect(trackedGen.wasReturnCalled()).toBe(true);
  });

  // Test 16: timeout aborts session and returns timeout status
  it('returns timeout status when session exceeds timeoutMs', async () => {
    // Create a generator that hangs until aborted
    mockQuery.mockImplementation((args: any) => {
      const abortController: AbortController = args.options.abortController;
      return (async function* () {
        await new Promise<void>((_, reject) => {
          abortController.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      })();
    });
    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace', timeoutMs: 50 });
    const result = await session.run('task');
    expect(result.status).toBe('timeout');
    expect(result.error).toBe('Session timeout reached');
  });

  // Test 17: mcpServers wired in query() options
  it('passes mcpServers with verifier server to query()', async () => {
    mockQuery.mockReturnValue(makeQueryGen([makeSuccessResult()]));
    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace' });
    await session.run('task');
    const callArg = mockQuery.mock.calls[0][0];
    expect(callArg.options.mcpServers).toBeDefined();
    expect(callArg.options.mcpServers).toHaveProperty('verifier');
  });

  // Test 18: systemPrompt includes verify instruction
  it('systemPrompt includes verify instruction', async () => {
    mockQuery.mockReturnValue(makeQueryGen([makeSuccessResult()]));
    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace' });
    await session.run('task');
    const callArg = mockQuery.mock.calls[0][0];
    const sp = callArg.options.systemPrompt;
    expect(sp).toEqual(expect.objectContaining({
      type: 'preset',
      preset: 'claude_code',
    }));
    expect(sp.append).toContain('mcp__verifier__verify');
    expect(sp.append).toContain('before declaring done');
  });

  // Test 19: MCP server registration logged
  it('logs MCP server registration', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
    mockQuery.mockReturnValue(makeQueryGen([makeSuccessResult()]));
    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace' });
    await session.run('task', logger);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mcp', server: 'verifier', tools: ['verify'] }),
      'mcp_server_registered'
    );
  });

  // Test 20: PostToolUse matcher includes mcp__verifier__verify
  it('PostToolUse matcher includes mcp__verifier__verify', async () => {
    mockQuery.mockReturnValue(makeQueryGen([makeSuccessResult()]));
    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace' });
    await session.run('task');
    const callArg = mockQuery.mock.calls[0][0];
    const postMatcher = callArg.options.hooks.PostToolUse[0].matcher;
    expect(postMatcher).toContain('mcp__verifier__verify');
  });
});
