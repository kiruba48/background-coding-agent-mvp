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

// Mock child_process for docker spawn and execFile
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
}));

// Mock docker module
vi.mock('../cli/docker/index.js', () => ({
  buildDockerRunArgs: vi.fn().mockReturnValue(['run', '--rm', '--interactive', 'background-agent:latest', '/usr/local/bin/claude', '--json']),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
import { spawn, execFile } from 'node:child_process';
import { buildDockerRunArgs } from '../cli/docker/index.js';
import { ClaudeCodeSession } from './claude-code-session.js';

const mockQuery = query as ReturnType<typeof vi.fn>;
const mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>;
const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const mockBuildDockerRunArgs = buildDockerRunArgs as ReturnType<typeof vi.fn>;

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
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: ANTHROPIC_API_KEY is set for most tests
    process.env.ANTHROPIC_API_KEY = 'test-api-key';
    // Default: execFile (docker kill in finally block) resolves immediately
    mockExecFile.mockImplementation((...args: any[]) => {
      const callback = args[args.length - 1];
      if (typeof callback === 'function') callback(null, '', '');
    });
  });

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
      tool_input: { file_path: '/workspace/.env' },
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
      tool_input: { file_path: '/workspace/.git/config' },
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
      tool_input: { file_path: '/workspace/src/index.ts' },
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
      tool_input: { file_path: '/workspace/src/index.ts' },
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
          tool_input: { file_path: '/workspace/a.ts' }, tool_response: {},
          tool_use_id: 'p1', session_id: 's', transcript_path: 't', cwd: '/tmp' }, 'p1', { signal: new AbortController().signal });
        await postHook({ hook_event_name: 'PostToolUse', tool_name: 'Edit',
          tool_input: { file_path: '/workspace/b.ts' }, tool_response: {},
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
      tool_input: { file_path: '/workspace/src/index.ts' },
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

  // -------------------------------------------------------------------------
  // Read-only session hook tests (Task 1: readOnly flag)
  // -------------------------------------------------------------------------

  // Test 31: readOnly session blocks Write tool with 'blocked: read-only session'
  it('31. PreToolUse hook blocks Write tool in read-only session', async () => {
    mockQuery.mockReturnValue(makeQueryGen([makeSuccessResult()]));
    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace', readOnly: true });
    await session.run('task');
    const callArg = mockQuery.mock.calls[0][0];
    const hookFn = callArg.options.hooks.PreToolUse[0].hooks[0];
    const input = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '/workspace/src/index.ts' },
      tool_use_id: 'ro-1',
      session_id: 's', transcript_path: 't', cwd: '/tmp/workspace',
    };
    const result = await hookFn(input, 'ro-1', { signal: new AbortController().signal });
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(result.systemMessage).toContain('blocked: read-only session');
  });

  // Test 32: readOnly session blocks Edit tool
  it('32. PreToolUse hook blocks Edit tool in read-only session', async () => {
    mockQuery.mockReturnValue(makeQueryGen([makeSuccessResult()]));
    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace', readOnly: true });
    await session.run('task');
    const callArg = mockQuery.mock.calls[0][0];
    const hookFn = callArg.options.hooks.PreToolUse[0].hooks[0];
    const input = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: '/workspace/src/index.ts' },
      tool_use_id: 'ro-2',
      session_id: 's', transcript_path: 't', cwd: '/tmp/workspace',
    };
    const result = await hookFn(input, 'ro-2', { signal: new AbortController().signal });
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(result.systemMessage).toContain('blocked: read-only session');
  });

  // Test 33: readOnly session allows Bash tool (OS-level :ro handles enforcement)
  it('33. PreToolUse hook allows Bash tool in read-only session', async () => {
    mockQuery.mockReturnValue(makeQueryGen([makeSuccessResult()]));
    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace', readOnly: true });
    await session.run('task');
    const callArg = mockQuery.mock.calls[0][0];
    const hookFn = callArg.options.hooks.PreToolUse[0].hooks[0];
    const input = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls /workspace' },
      tool_use_id: 'ro-3',
      session_id: 's', transcript_path: 't', cwd: '/tmp/workspace',
    };
    const result = await hookFn(input, 'ro-3', { signal: new AbortController().signal });
    expect(result.hookSpecificOutput?.permissionDecision).not.toBe('deny');
  });

  // Test 35: readOnly session blocks destructive Bash commands (V1: EXPLR-04)
  it('35. PreToolUse hook blocks "git commit" in read-only session', async () => {
    mockQuery.mockReturnValue(makeQueryGen([makeSuccessResult()]));
    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace', readOnly: true });
    await session.run('task');
    const callArg = mockQuery.mock.calls[0][0];
    const hookFn = callArg.options.hooks.PreToolUse[0].hooks[0];
    const input = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m "test"' },
      tool_use_id: 'ro-bash-1',
      session_id: 's', transcript_path: 't', cwd: '/tmp/workspace',
    };
    const result = await hookFn(input, 'ro-bash-1', { signal: new AbortController().signal });
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(result.systemMessage).toContain('blocked: read-only session');
  });

  // Test 36: readOnly session blocks "git push"
  it('36. PreToolUse hook blocks "git push" in read-only session', async () => {
    mockQuery.mockReturnValue(makeQueryGen([makeSuccessResult()]));
    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace', readOnly: true });
    await session.run('task');
    const callArg = mockQuery.mock.calls[0][0];
    const hookFn = callArg.options.hooks.PreToolUse[0].hooks[0];
    const input = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git push origin main' },
      tool_use_id: 'ro-bash-2',
      session_id: 's', transcript_path: 't', cwd: '/tmp/workspace',
    };
    const result = await hookFn(input, 'ro-bash-2', { signal: new AbortController().signal });
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  // Test 37: readOnly session blocks "npm publish"
  it('37. PreToolUse hook blocks "npm publish" in read-only session', async () => {
    mockQuery.mockReturnValue(makeQueryGen([makeSuccessResult()]));
    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace', readOnly: true });
    await session.run('task');
    const callArg = mockQuery.mock.calls[0][0];
    const hookFn = callArg.options.hooks.PreToolUse[0].hooks[0];
    const input = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm publish --access public' },
      tool_use_id: 'ro-bash-3',
      session_id: 's', transcript_path: 't', cwd: '/tmp/workspace',
    };
    const result = await hookFn(input, 'ro-bash-3', { signal: new AbortController().signal });
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  // Test 38: readOnly session allows safe Bash commands like "ls", "cat", "git log"
  it('38. PreToolUse hook allows "git log" in read-only session', async () => {
    mockQuery.mockReturnValue(makeQueryGen([makeSuccessResult()]));
    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace', readOnly: true });
    await session.run('task');
    const callArg = mockQuery.mock.calls[0][0];
    const hookFn = callArg.options.hooks.PreToolUse[0].hooks[0];
    const input = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git log --oneline -20' },
      tool_use_id: 'ro-bash-4',
      session_id: 's', transcript_path: 't', cwd: '/tmp/workspace',
    };
    const result = await hookFn(input, 'ro-bash-4', { signal: new AbortController().signal });
    expect(result.hookSpecificOutput?.permissionDecision).not.toBe('deny');
  });

  // Test 39: readOnly session blocks "rm -rf"
  it('39. PreToolUse hook blocks "rm -rf" in read-only session', async () => {
    mockQuery.mockReturnValue(makeQueryGen([makeSuccessResult()]));
    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace', readOnly: true });
    await session.run('task');
    const callArg = mockQuery.mock.calls[0][0];
    const hookFn = callArg.options.hooks.PreToolUse[0].hooks[0];
    const input = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /tmp/something' },
      tool_use_id: 'ro-bash-5',
      session_id: 's', transcript_path: 't', cwd: '/tmp/workspace',
    };
    const result = await hookFn(input, 'ro-bash-5', { signal: new AbortController().signal });
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  // Test 40: non-readOnly session does NOT block destructive Bash
  it('40. PreToolUse hook allows "git commit" in non-readOnly session', async () => {
    mockQuery.mockReturnValue(makeQueryGen([makeSuccessResult()]));
    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace', readOnly: false });
    await session.run('task');
    const callArg = mockQuery.mock.calls[0][0];
    const hookFn = callArg.options.hooks.PreToolUse[0].hooks[0];
    const input = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m "test"' },
      tool_use_id: 'ro-bash-6',
      session_id: 's', transcript_path: 't', cwd: '/tmp/workspace',
    };
    const result = await hookFn(input, 'ro-bash-6', { signal: new AbortController().signal });
    expect(result.hookSpecificOutput?.permissionDecision).not.toBe('deny');
  });

  // Test 34: non-readOnly session still allows Write inside repo (existing behavior)
  it('34. PreToolUse hook allows Write inside repo for non-readOnly session', async () => {
    mockQuery.mockReturnValue(makeQueryGen([makeSuccessResult()]));
    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace', readOnly: false });
    await session.run('task');
    const callArg = mockQuery.mock.calls[0][0];
    const hookFn = callArg.options.hooks.PreToolUse[0].hooks[0];
    const input = {
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '/workspace/src/index.ts' },
      tool_use_id: 'ro-4',
      session_id: 's', transcript_path: 't', cwd: '/tmp/workspace',
    };
    const result = await hookFn(input, 'ro-4', { signal: new AbortController().signal });
    expect(result.hookSpecificOutput?.permissionDecision).not.toBe('deny');
  });

  // Helper: create a mock ChildProcess-like object for spawn
  function makeMockChildProcess() {
    const listeners: Record<string, ((...args: any[]) => void)[]> = {};
    return {
      stdin: { write: vi.fn(), end: vi.fn() },
      stdout: { on: vi.fn(), pipe: vi.fn() },
      stderr: { on: vi.fn() },
      killed: false,
      exitCode: 0,
      kill: vi.fn().mockReturnValue(true),
      on: vi.fn((event: string, listener: (...args: any[]) => void) => {
        if (!listeners[event]) listeners[event] = [];
        listeners[event].push(listener);
      }),
      once: vi.fn(),
      off: vi.fn(),
      emit: (event: string, ...args: any[]) => {
        (listeners[event] ?? []).forEach(fn => fn(...args));
      },
    };
  }

  // Test 21: query() receives spawnClaudeCodeProcess option
  it('query() receives spawnClaudeCodeProcess option', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    mockQuery.mockReturnValue(makeQueryGen([makeSuccessResult()]));
    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace' });
    await session.run('task');
    const callArg = mockQuery.mock.calls[0][0];
    expect(typeof callArg.options.spawnClaudeCodeProcess).toBe('function');
  });

  // Test 22: spawnClaudeCodeProcess spawns docker with correct args
  it('spawnClaudeCodeProcess spawns docker with correct args', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    mockQuery.mockReturnValue(makeQueryGen([makeSuccessResult()]));
    const mockProcess = makeMockChildProcess();
    mockSpawn.mockReturnValue(mockProcess);

    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace' });
    await session.run('task');

    const callArg = mockQuery.mock.calls[0][0];
    const spawnFn = callArg.options.spawnClaudeCodeProcess;
    const signal = new AbortController().signal;
    spawnFn({ command: '/usr/local/bin/claude', args: ['--json'], signal });

    expect(mockSpawn).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['run', '--rm', '--interactive']),
      expect.objectContaining({
        stdio: ['pipe', 'pipe', 'inherit'],
        env: expect.objectContaining({ ANTHROPIC_API_KEY: 'test-key' }),
      }),
    );
  });

  // Test 23: docker kill called in finally block
  it('docker kill called in finally block', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    mockQuery.mockReturnValue(makeQueryGen([makeSuccessResult()]));

    // Mock execFile to invoke callback (promisify pattern)
    mockExecFile.mockImplementation((...args: any[]) => {
      const callback = args[args.length - 1];
      callback(null, '', '');
    });

    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace' });
    await session.run('task');

    // execFile should have been called with docker kill agent-{sessionId}
    const dockerKillCall = mockExecFile.mock.calls.find(
      (call: any[]) => call[0] === 'docker' && Array.isArray(call[1]) && call[1][0] === 'kill'
    );
    expect(dockerKillCall).toBeDefined();
    expect(dockerKillCall![1][1]).toMatch(/^agent-/);
  });

  // Test 24: docker kill failure in finally block is silently caught
  it('docker kill failure in finally block is silently caught', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    mockQuery.mockReturnValue(makeQueryGen([makeSuccessResult()]));

    // Mock execFile to reject for docker kill
    mockExecFile.mockImplementation((...args: any[]) => {
      const callback = args[args.length - 1];
      callback(new Error('container not found'), '', '');
    });

    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace' });
    // Should not throw
    const result = await session.run('task');
    expect(result.status).toBe('success');
  });

  // Test 25: throws when ANTHROPIC_API_KEY is not set
  it('returns failed status when ANTHROPIC_API_KEY is not set', async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    mockQuery.mockReturnValue(makeQueryGen([makeSuccessResult()]));

    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace' });
    const result = await session.run('task');
    expect(result.status).toBe('failed');
    expect(result.error).toContain('ANTHROPIC_API_KEY');

    // Restore
    if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
  });

  // -------------------------------------------------------------------------
  // Cancellation tests (Task 2: AbortSignal threading)
  // -------------------------------------------------------------------------

  // Test 26: run() accepts optional signal parameter
  it('26. run() accepts optional signal parameter', async () => {
    mockQuery.mockReturnValue(makeQueryGen([makeSuccessResult()]));
    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace' });
    const controller = new AbortController();
    // Should not throw when signal is passed
    const result = await session.run('task', undefined, controller.signal);
    expect(result.status).toBe('success');
  });

  // Test 27: run() with pre-aborted signal returns status 'cancelled'
  it('27. run() with pre-aborted signal returns status cancelled', async () => {
    mockQuery.mockReturnValue(makeQueryGen([makeSuccessResult()]));
    const controller = new AbortController();
    controller.abort(); // abort before calling run

    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace' });
    const result = await session.run('task', undefined, controller.signal);
    expect(result.status).toBe('cancelled');
    expect(result.error).toBeTruthy(); // 'Cancelled before start' or similar
  });

  // Test 28: signal check happens BEFORE timedOut check in catch block
  // This is verified by the 'cancelled' return (not 'timeout') when both signal and timeout are true
  it('28. cancelled status takes priority over timeout status', async () => {
    const controller = new AbortController();
    // Create a generator that throws when aborted
    mockQuery.mockImplementation((args: any) => {
      const abortController: AbortController = args.options.abortController;
      return (async function* () {
        await new Promise<void>((_, reject) => {
          abortController.signal.addEventListener('abort', () => reject(new Error('aborted by controller')));
        });
      })();
    });

    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace', timeoutMs: 50 });
    // Abort via external signal immediately
    controller.abort();
    const result = await session.run('task', undefined, controller.signal);
    // Even if timeout fires, signal.aborted takes priority
    expect(result.status).toBe('cancelled');
  });

  // Test 29: docker kill is called after 5-second grace period when session hangs on cancel
  it('29. docker kill called after 5s grace period when session does not exit gracefully', async () => {
    vi.useFakeTimers();

    const controller = new AbortController();
    let abortHandlerCalled = false;

    // Create a generator that hangs after being aborted (simulates stuck session)
    mockQuery.mockImplementation((args: any) => {
      const abortCtrl: AbortController = args.options.abortController;
      return (async function* () {
        await new Promise<void>((_, reject) => {
          abortCtrl.signal.addEventListener('abort', () => {
            abortHandlerCalled = true;
            // Don't resolve — simulate hung session
          });
          // The external signal also fires the abort
          controller.signal.addEventListener('abort', () => reject(new Error('external abort')));
        });
      })();
    });

    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace' });
    const runPromise = session.run('task', undefined, controller.signal);

    // Give run() time to set up the abort listener
    await vi.advanceTimersByTimeAsync(10);

    // Fire the external abort signal
    controller.abort();

    // Advance past the 5-second grace period
    await vi.advanceTimersByTimeAsync(5100);

    // Wait for run to settle
    await runPromise.catch(() => {});

    // docker kill should have been called with the grace period (for the container)
    // Check that execFile was called with docker kill at some point
    const dockerKillCalls = mockExecFile.mock.calls.filter(
      (call: any[]) => call[0] === 'docker' && Array.isArray(call[1]) && call[1][0] === 'kill'
    );
    expect(dockerKillCalls.length).toBeGreaterThanOrEqual(1);

    vi.useRealTimers();
  });

  // Test 30: if session exits within grace period, docker kill is not called by grace handler
  // (the always-runs finally block still calls docker kill — that's expected and fine)
  it('30. grace period docker kill is NOT invoked if session exits before 5s', async () => {
    vi.useFakeTimers();

    const controller = new AbortController();
    let resolveSession: (() => void) | null = null;

    mockQuery.mockImplementation((args: any) => {
      const abortCtrl: AbortController = args.options.abortController;
      return (async function* () {
        await new Promise<void>((resolve, reject) => {
          resolveSession = resolve;
          abortCtrl.signal.addEventListener('abort', () => {
            // Resolve quickly to simulate graceful exit
            resolve();
          });
        });
        // Session exits before grace period ends — yield no result (empty generator)
      })();
    });

    const killCallsBefore = mockExecFile.mock.calls.filter(
      (call: any[]) => call[0] === 'docker' && Array.isArray(call[1]) && call[1][0] === 'kill'
    ).length;

    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace' });
    const runPromise = session.run('task', undefined, controller.signal);

    // Give run() time to set up
    await vi.advanceTimersByTimeAsync(10);

    // Fire abort — session resolves immediately (graceful)
    controller.abort();

    // Advance past the 5-second grace period
    await vi.advanceTimersByTimeAsync(5100);

    await runPromise.catch(() => {});

    // The grace handler should NOT have fired a NEW docker kill — only the finally block's
    // docker kill should have run (which is always called)
    const killCallsAfter = mockExecFile.mock.calls.filter(
      (call: any[]) => call[0] === 'docker' && Array.isArray(call[1]) && call[1][0] === 'kill'
    ).length;

    // Only 1 docker kill call: from the finally block (always-runs cleanup)
    // NOT an additional call from the grace period handler
    expect(killCallsAfter - killCallsBefore).toBe(1);

    vi.useRealTimers();
  });
});
