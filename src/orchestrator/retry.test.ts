import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionResult, VerificationResult } from '../types.js';

// Mock ClaudeCodeSession — the only session type after legacy deletion.
// Without this mock, tests would attempt real SDK calls.
vi.mock('./claude-code-session.js', () => {
  const MockClaudeCodeSession = vi.fn();
  return { ClaudeCodeSession: MockClaudeCodeSession };
});

// Mock judge.js to control captureBaselineSha and getWorkspaceDiff output
vi.mock('./judge.js', () => ({
  captureBaselineSha: vi.fn().mockResolvedValue(undefined),
  llmJudge: vi.fn(),
  getWorkspaceDiff: vi.fn().mockResolvedValue('meaningful diff content here'),
  MIN_DIFF_CHARS: 10,
}));

// Mock verifier.js for compositeVerifier call tracking
vi.mock('./verifier.js', () => ({
  compositeVerifier: vi.fn().mockResolvedValue({ passed: true, errors: [], durationMs: 50 }),
}));

// Mock child_process for git reset verification
vi.mock('node:child_process', () => ({
  execFile: vi.fn((...args: any[]) => {
    const callback = args[args.length - 1];
    if (typeof callback === 'function') callback(null, '', '');
  }),
  spawn: vi.fn(),
}));

// Import AFTER mocks are set up
import { RetryOrchestrator, PreVerifyError, isConfigFile, getChangedFilesFromBaseline } from './retry.js';
import { ClaudeCodeSession } from './claude-code-session.js';
import { compositeVerifier } from './verifier.js';

const MockClaudeCodeSession = ClaudeCodeSession as ReturnType<typeof vi.fn>;

// Helper to create a mock session object with configurable run result
function createMockSession(runResult: SessionResult | ((...args: any[]) => Promise<SessionResult>)) {
  const session = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    run: typeof runResult === 'function'
      ? vi.fn().mockImplementation(runResult)
      : vi.fn().mockResolvedValue(runResult),
  };
  return session;
}

// Helper to create a successful SessionResult
function makeSessionResult(overrides: Partial<SessionResult> = {}): SessionResult {
  return {
    sessionId: 'test-session',
    status: 'success',
    toolCallCount: 2,
    duration: 1000,
    finalResponse: 'Done.',
    ...overrides,
  };
}

// Helper to create a passing VerificationResult
function makePassedVerification(): VerificationResult {
  return { passed: true, errors: [], durationMs: 50 };
}

// Helper to create a failing VerificationResult
function makeFailedVerification(errorSummary = 'Build failed'): VerificationResult {
  return {
    passed: false,
    errors: [{ type: 'build', summary: errorSummary }],
    durationMs: 50,
  };
}

describe('RetryOrchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('1. succeeds on first attempt with no verifier', async () => {
    // Setup: session succeeds, no verifier configured
    const session = createMockSession(makeSessionResult());
    MockClaudeCodeSession.mockImplementationOnce(function() { return session; });

    const orchestrator = new RetryOrchestrator(
      { workspaceDir: '/tmp/workspace' },
      { maxRetries: 3 }
    );

    const result = await orchestrator.run('Fix the bug');

    expect(result.finalStatus).toBe('success');
    expect(result.attempts).toBe(1);
    expect(result.sessionResults).toHaveLength(1);
    expect(result.verificationResults).toHaveLength(0);
  });

  it('2. succeeds on first attempt when verifier passes', async () => {
    const verifier = vi.fn().mockResolvedValue(makePassedVerification());
    const session = createMockSession(makeSessionResult());
    MockClaudeCodeSession.mockImplementationOnce(function() { return session; });

    const orchestrator = new RetryOrchestrator(
      { workspaceDir: '/tmp/workspace' },
      { maxRetries: 3, verifier }
    );

    const result = await orchestrator.run('Fix the bug');

    expect(result.finalStatus).toBe('success');
    expect(result.attempts).toBe(1);
    expect(result.sessionResults).toHaveLength(1);
    expect(result.verificationResults).toHaveLength(1);
    expect(result.verificationResults[0].passed).toBe(true);
  });

  it('3. retries on verification failure, then succeeds', async () => {
    const verifier = vi.fn()
      .mockResolvedValueOnce(makeFailedVerification('Tests failed on attempt 1'))
      .mockResolvedValueOnce(makePassedVerification());

    const session1 = createMockSession(makeSessionResult());
    const session2 = createMockSession(makeSessionResult());
    MockClaudeCodeSession
      .mockImplementationOnce(function() { return session1; })
      .mockImplementationOnce(function() { return session2; });

    const orchestrator = new RetryOrchestrator(
      { workspaceDir: '/tmp/workspace' },
      { maxRetries: 3, verifier }
    );

    const result = await orchestrator.run('Fix the bug');

    expect(result.finalStatus).toBe('success');
    expect(result.attempts).toBe(2);
    expect(result.sessionResults).toHaveLength(2);
    expect(result.verificationResults).toHaveLength(2);
    expect(result.verificationResults[0].passed).toBe(false);
    expect(result.verificationResults[1].passed).toBe(true);
  });

  it('4. exhausts max retries when verification always fails', async () => {
    const verifier = vi.fn().mockResolvedValue(makeFailedVerification('Persistent failure'));

    [0, 1, 2].forEach(() => {
      const session = createMockSession(makeSessionResult());
      MockClaudeCodeSession.mockImplementationOnce(function() { return session; });
    });

    const orchestrator = new RetryOrchestrator(
      { workspaceDir: '/tmp/workspace' },
      { maxRetries: 3, verifier }
    );

    const result = await orchestrator.run('Fix the bug');

    expect(result.finalStatus).toBe('max_retries_exhausted');
    expect(result.attempts).toBe(3);
    expect(result.sessionResults).toHaveLength(3);
    expect(result.verificationResults).toHaveLength(3);
    expect(result.error).toContain('3 attempts');
  });

  it('5. session timeout stops retrying immediately', async () => {
    const verifier = vi.fn();
    const session = createMockSession(makeSessionResult({ status: 'timeout' }));
    MockClaudeCodeSession.mockImplementationOnce(function() { return session; });

    const orchestrator = new RetryOrchestrator(
      { workspaceDir: '/tmp/workspace' },
      { maxRetries: 3, verifier }
    );

    const result = await orchestrator.run('Fix the bug');

    expect(result.finalStatus).toBe('timeout');
    expect(result.attempts).toBe(1);
    expect(result.sessionResults).toHaveLength(1);
    // Verifier must NOT have been called — timeout is terminal
    expect(verifier).not.toHaveBeenCalled();
  });

  it('6. session turn_limit stops retrying immediately', async () => {
    const verifier = vi.fn();
    const session = createMockSession(makeSessionResult({ status: 'turn_limit' }));
    MockClaudeCodeSession.mockImplementationOnce(function() { return session; });

    const orchestrator = new RetryOrchestrator(
      { workspaceDir: '/tmp/workspace' },
      { maxRetries: 3, verifier }
    );

    const result = await orchestrator.run('Fix the bug');

    expect(result.finalStatus).toBe('turn_limit');
    expect(result.attempts).toBe(1);
    expect(verifier).not.toHaveBeenCalled();
  });

  it('7. session failed stops retrying immediately', async () => {
    const verifier = vi.fn();
    const session = createMockSession(makeSessionResult({ status: 'failed', error: 'Session crashed' }));
    MockClaudeCodeSession.mockImplementationOnce(function() { return session; });

    const orchestrator = new RetryOrchestrator(
      { workspaceDir: '/tmp/workspace' },
      { maxRetries: 3, verifier }
    );

    const result = await orchestrator.run('Fix the bug');

    expect(result.finalStatus).toBe('failed');
    expect(result.attempts).toBe(1);
    expect(result.error).toBe('Session crashed');
    expect(verifier).not.toHaveBeenCalled();
  });

  it('8. retry message includes original task first, then error digest', async () => {
    const verifier = vi.fn()
      .mockResolvedValueOnce(makeFailedVerification('Build error: TS2345'))
      .mockResolvedValueOnce(makePassedVerification());

    const capturedMessages: string[] = [];

    const session1 = createMockSession(async (msg: string) => {
      capturedMessages.push(msg);
      return makeSessionResult();
    });
    const session2 = createMockSession(async (msg: string) => {
      capturedMessages.push(msg);
      return makeSessionResult();
    });
    MockClaudeCodeSession
      .mockImplementationOnce(function() { return session1; })
      .mockImplementationOnce(function() { return session2; });

    const originalTask = 'Fix the TypeScript compilation error';
    const orchestrator = new RetryOrchestrator(
      { workspaceDir: '/tmp/workspace' },
      { maxRetries: 3, verifier }
    );

    await orchestrator.run(originalTask);

    // First message should be the original task as-is
    expect(capturedMessages[0]).toBe(originalTask);

    // Second message (retry) should start with original task
    expect(capturedMessages[1]).toContain(originalTask);

    // Second message should contain error context after the original task
    expect(capturedMessages[1]).toContain('PREVIOUS ATTEMPT');
    expect(capturedMessages[1]).toContain('Build error: TS2345');
    expect(capturedMessages[1]).toContain('Fix the issues above');

    // Original task must appear BEFORE the separator
    const retryMsg = capturedMessages[1];
    const separatorIndex = retryMsg.indexOf('---');
    const taskIndex = retryMsg.indexOf(originalTask);
    expect(taskIndex).toBeLessThan(separatorIndex);
  });

  it('9. creates a fresh session per attempt (ClaudeCodeSession by default)', async () => {
    const verifier = vi.fn()
      .mockResolvedValueOnce(makeFailedVerification())
      .mockResolvedValueOnce(makeFailedVerification())
      .mockResolvedValueOnce(makePassedVerification());

    [0, 1, 2].forEach(() => {
      const session = createMockSession(makeSessionResult());
      MockClaudeCodeSession.mockImplementationOnce(function() { return session; });
    });

    const orchestrator = new RetryOrchestrator(
      { workspaceDir: '/tmp/workspace' },
      { maxRetries: 3, verifier }
    );

    await orchestrator.run('Fix the bug');

    // ClaudeCodeSession constructor should have been called once per attempt
    expect(MockClaudeCodeSession.mock.calls).toHaveLength(3);
  });

  it('10. custom maxRetries of 2 limits to 2 attempts', async () => {
    const verifier = vi.fn().mockResolvedValue(makeFailedVerification('Always fails'));

    [0, 1].forEach(() => {
      const session = createMockSession(makeSessionResult());
      MockClaudeCodeSession.mockImplementationOnce(function() { return session; });
    });

    const orchestrator = new RetryOrchestrator(
      { workspaceDir: '/tmp/workspace' },
      { maxRetries: 2, verifier }
    );

    const result = await orchestrator.run('Fix the bug');

    expect(result.finalStatus).toBe('max_retries_exhausted');
    expect(result.attempts).toBe(2);
    expect(MockClaudeCodeSession.mock.calls).toHaveLength(2);
    expect(result.error).toContain('2 attempts');
  });

  it('11. verifier crash returns structured RetryResult instead of throwing', async () => {
    const verifier = vi.fn().mockRejectedValue(new Error('tsc binary not found'));
    const session = createMockSession(makeSessionResult());
    MockClaudeCodeSession.mockImplementationOnce(function() { return session; });

    const orchestrator = new RetryOrchestrator(
      { workspaceDir: '/tmp/workspace' },
      { maxRetries: 3, verifier }
    );

    const result = await orchestrator.run('Fix the bug');

    expect(result.finalStatus).toBe('failed');
    expect(result.attempts).toBe(1);
    expect(result.error).toContain('Verifier error');
    expect(result.error).toContain('tsc binary not found');
    // Session should still be cleaned up (stop called)
    expect(session.stop).toHaveBeenCalled();
  });

  it('12. session.start() failure cleans up via finally block', async () => {
    const session = createMockSession(makeSessionResult());
    session.start.mockRejectedValue(new Error('Session init failed'));
    MockClaudeCodeSession.mockImplementationOnce(function() { return session; });

    const orchestrator = new RetryOrchestrator(
      { workspaceDir: '/tmp/workspace' },
      { maxRetries: 3 }
    );

    await expect(orchestrator.run('Fix the bug')).rejects.toThrow('Session init failed');
    // stop() must have been called even though start() threw
    expect(session.stop).toHaveBeenCalled();
  });

  it('13. stop() cleans up active session', async () => {
    const verifier = vi.fn().mockImplementation(() =>
      new Promise(() => {}) // never resolves — simulates long-running verifier
    );
    const session = createMockSession(makeSessionResult());
    MockClaudeCodeSession.mockImplementationOnce(function() { return session; });

    const orchestrator = new RetryOrchestrator(
      { workspaceDir: '/tmp/workspace' },
      { maxRetries: 3, verifier }
    );

    // Start run but don't await — it will block on verifier
    const runPromise = orchestrator.run('Fix the bug');

    // Give it a tick to reach the verifier
    await new Promise(r => setTimeout(r, 10));

    // stop() should clean up the active session
    await orchestrator.stop();

    // Session stop should have been called by our explicit stop()
    expect(session.stop).toHaveBeenCalled();

    // Clean up the dangling promise
    runPromise.catch(() => {});
  });

  it('15. preVerify is called before verifier when session succeeds', async () => {
    const preVerify = vi.fn().mockResolvedValue(undefined);
    const verifier = vi.fn().mockResolvedValue(makePassedVerification());
    const session = createMockSession(makeSessionResult());
    MockClaudeCodeSession.mockImplementationOnce(function() { return session; });

    const callOrder: string[] = [];
    preVerify.mockImplementation(async () => { callOrder.push('preVerify'); });
    verifier.mockImplementation(async () => { callOrder.push('verifier'); return makePassedVerification(); });

    const orchestrator = new RetryOrchestrator(
      { workspaceDir: '/tmp/workspace' },
      { maxRetries: 3, verifier, preVerify }
    );

    const result = await orchestrator.run('Fix the bug');

    expect(result.finalStatus).toBe('success');
    expect(preVerify).toHaveBeenCalledOnce();
    expect(preVerify).toHaveBeenCalledWith('/tmp/workspace');
    expect(verifier).toHaveBeenCalledOnce();
    expect(callOrder).toEqual(['preVerify', 'verifier']);
  });

  it('16. preVerify is not called when session fails', async () => {
    const preVerify = vi.fn().mockResolvedValue(undefined);
    const verifier = vi.fn().mockResolvedValue(makePassedVerification());
    const session = createMockSession(makeSessionResult({ status: 'failed', error: 'Session crashed' }));
    MockClaudeCodeSession.mockImplementationOnce(function() { return session; });

    const orchestrator = new RetryOrchestrator(
      { workspaceDir: '/tmp/workspace' },
      { maxRetries: 3, verifier, preVerify }
    );

    const result = await orchestrator.run('Fix the bug');

    expect(result.finalStatus).toBe('failed');
    expect(preVerify).not.toHaveBeenCalled();
  });

  it('17. preVerify terminal failure returns finalStatus failed immediately (no retry)', async () => {
    const preVerify = vi.fn().mockRejectedValue(new PreVerifyError('npm install failed: network timeout', false));
    const verifier = vi.fn().mockResolvedValue(makePassedVerification());
    const session = createMockSession(makeSessionResult());
    MockClaudeCodeSession.mockImplementationOnce(function() { return session; });

    const orchestrator = new RetryOrchestrator(
      { workspaceDir: '/tmp/workspace' },
      { maxRetries: 3, verifier, preVerify }
    );

    const result = await orchestrator.run('Fix the bug');

    expect(result.finalStatus).toBe('failed');
    expect(result.attempts).toBe(1);
    expect(result.error).toContain('Pre-verify failed');
    expect(result.error).toContain('npm install failed: network timeout');
    // Verifier must NOT have been called — terminal preVerify failure
    expect(verifier).not.toHaveBeenCalled();
    // Only 1 session created (no retry)
    expect(MockClaudeCodeSession.mock.calls).toHaveLength(1);
  });

  it('17b. preVerify retryable ERESOLVE failure feeds into retry loop', async () => {
    const preVerify = vi.fn()
      .mockRejectedValueOnce(new PreVerifyError('npm install failed:\nnpm ERR! ERESOLVE could not resolve', true))
      .mockResolvedValueOnce(undefined); // succeeds on second attempt
    const verifier = vi.fn().mockResolvedValue(makePassedVerification());

    const session1 = createMockSession(makeSessionResult());
    const session2 = createMockSession(makeSessionResult());
    MockClaudeCodeSession
      .mockImplementationOnce(function() { return session1; })
      .mockImplementationOnce(function() { return session2; });

    const orchestrator = new RetryOrchestrator(
      { workspaceDir: '/tmp/workspace' },
      { maxRetries: 3, verifier, preVerify }
    );

    const result = await orchestrator.run('update eslint');

    expect(result.finalStatus).toBe('success');
    expect(result.attempts).toBe(2);
    expect(preVerify).toHaveBeenCalledTimes(2);
    expect(verifier).toHaveBeenCalledOnce();
    expect(MockClaudeCodeSession.mock.calls).toHaveLength(2);
    expect(result.verificationResults).toHaveLength(2);
    expect(result.verificationResults[0].passed).toBe(false);
    expect(result.verificationResults[0].errors[0].summary).toContain('dependency conflict');
  });

  it('17c. non-PreVerifyError in preVerify is always terminal', async () => {
    const preVerify = vi.fn().mockRejectedValue(new Error('unexpected crash'));
    const verifier = vi.fn().mockResolvedValue(makePassedVerification());
    const session = createMockSession(makeSessionResult());
    MockClaudeCodeSession.mockImplementationOnce(function() { return session; });

    const orchestrator = new RetryOrchestrator(
      { workspaceDir: '/tmp/workspace' },
      { maxRetries: 3, verifier, preVerify }
    );

    const result = await orchestrator.run('Fix the bug');

    expect(result.finalStatus).toBe('failed');
    expect(result.attempts).toBe(1);
    expect(result.error).toContain('unexpected crash');
    expect(verifier).not.toHaveBeenCalled();
  });

  it('18. retry loop without preVerify works exactly as before (backwards compatible)', async () => {
    const verifier = vi.fn()
      .mockResolvedValueOnce(makeFailedVerification('Build failed'))
      .mockResolvedValueOnce(makePassedVerification());

    const session1 = createMockSession(makeSessionResult());
    const session2 = createMockSession(makeSessionResult());
    MockClaudeCodeSession
      .mockImplementationOnce(function() { return session1; })
      .mockImplementationOnce(function() { return session2; });

    const orchestrator = new RetryOrchestrator(
      { workspaceDir: '/tmp/workspace' },
      { maxRetries: 3, verifier }
      // NOTE: no preVerify — backwards compatibility test
    );

    const result = await orchestrator.run('Fix the bug');

    expect(result.finalStatus).toBe('success');
    expect(result.attempts).toBe(2);
    expect(verifier).toHaveBeenCalledTimes(2);
  });

  it('19. preVerify is called on each retry attempt (not just first)', async () => {
    const preVerify = vi.fn().mockResolvedValue(undefined);
    const verifier = vi.fn()
      .mockResolvedValueOnce(makeFailedVerification('Build failed attempt 1'))
      .mockResolvedValueOnce(makePassedVerification());

    const session1 = createMockSession(makeSessionResult());
    const session2 = createMockSession(makeSessionResult());
    MockClaudeCodeSession
      .mockImplementationOnce(function() { return session1; })
      .mockImplementationOnce(function() { return session2; });

    const orchestrator = new RetryOrchestrator(
      { workspaceDir: '/tmp/workspace' },
      { maxRetries: 3, verifier, preVerify }
    );

    const result = await orchestrator.run('Fix the bug');

    expect(result.finalStatus).toBe('success');
    expect(result.attempts).toBe(2);
    // preVerify must be called on every attempt where session succeeds
    expect(preVerify).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Cancellation tests (Task 2: AbortSignal threading)
  // -------------------------------------------------------------------------

  it('cancel-1. run() with already-aborted signal returns cancelled without starting a session', async () => {
    const verifier = vi.fn();
    const controller = new AbortController();
    controller.abort();

    const orchestrator = new RetryOrchestrator(
      { workspaceDir: '/tmp/workspace', signal: controller.signal },
      { maxRetries: 3, verifier }
    );

    const result = await orchestrator.run('Fix the bug');

    expect(result.finalStatus).toBe('cancelled');
    expect(result.attempts).toBe(0);
    expect(result.sessionResults).toHaveLength(0);
    // Session constructor should NOT have been called
    expect(MockClaudeCodeSession.mock.calls).toHaveLength(0);
    // Verifier must NOT have been called
    expect(verifier).not.toHaveBeenCalled();
  });

  it('cancel-2. run() with signal that fires mid-session returns cancelled', async () => {
    const controller = new AbortController();

    // Session that fires the abort mid-run and returns cancelled
    const session = createMockSession(async () => {
      // Simulate signal firing during session
      controller.abort();
      return makeSessionResult({ status: 'cancelled' });
    });
    MockClaudeCodeSession.mockImplementationOnce(function() { return session; });

    const orchestrator = new RetryOrchestrator(
      { workspaceDir: '/tmp/workspace', signal: controller.signal },
      { maxRetries: 3 }
    );

    const result = await orchestrator.run('Fix the bug');

    expect(result.finalStatus).toBe('cancelled');
  });

  it('cancel-3. on cancellation, git reset --hard is called with baseline SHA', async () => {
    // Mock captureBaselineSha
    const { captureBaselineSha } = await import('./judge.js');
    const mockCaptureBaseline = captureBaselineSha as ReturnType<typeof vi.fn>;
    mockCaptureBaseline.mockResolvedValue('baseline-sha-abc123');

    // Mock execFile for git reset
    const { execFile } = await import('node:child_process');
    const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;
    const gitResetCalls: string[][] = [];
    mockExecFile.mockImplementation((...args: any[]) => {
      const cmdArgs = args[1] as string[];
      if (args[0] === 'git' && cmdArgs[0] === 'reset') {
        gitResetCalls.push(cmdArgs);
        const callback = args[args.length - 1];
        if (typeof callback === 'function') callback(null, '', '');
      } else {
        const callback = args[args.length - 1];
        if (typeof callback === 'function') callback(null, '', '');
      }
    });

    const controller = new AbortController();
    const session = createMockSession(async () => {
      controller.abort();
      return makeSessionResult({ status: 'cancelled' });
    });
    MockClaudeCodeSession.mockImplementationOnce(function() { return session; });

    const orchestrator = new RetryOrchestrator(
      { workspaceDir: '/tmp/workspace', signal: controller.signal },
      { maxRetries: 3 }
    );

    await orchestrator.run('Fix the bug');

    // git reset --hard should have been called with baseline SHA
    const resetCall = gitResetCalls.find(args => args[0] === 'reset' && args[1] === '--hard');
    expect(resetCall).toBeDefined();
    expect(resetCall![2]).toBe('baseline-sha-abc123');
  });

  it('cancel-4. on success (no cancellation), git reset --hard is NOT called', async () => {
    const { execFile } = await import('node:child_process');
    const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;
    const gitResetCalls: string[][] = [];
    mockExecFile.mockImplementation((...args: any[]) => {
      const cmdArgs = args[1] as string[];
      if (args[0] === 'git' && cmdArgs[0] === 'reset') {
        gitResetCalls.push(cmdArgs);
      }
      const callback = args[args.length - 1];
      if (typeof callback === 'function') callback(null, '', '');
    });

    const session = createMockSession(makeSessionResult({ status: 'success' }));
    MockClaudeCodeSession.mockImplementationOnce(function() { return session; });

    const orchestrator = new RetryOrchestrator(
      { workspaceDir: '/tmp/workspace' },
      { maxRetries: 3 }
    );

    const result = await orchestrator.run('Fix the bug');

    expect(result.finalStatus).toBe('success');
    expect(gitResetCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Zero-diff detection tests
  // -------------------------------------------------------------------------

  it('zero-1. returns zero_diff when getWorkspaceDiff returns empty string', async () => {
    const { getWorkspaceDiff } = await import('./judge.js');
    const mockGetDiff = getWorkspaceDiff as ReturnType<typeof vi.fn>;
    mockGetDiff.mockResolvedValueOnce('');

    const verifier = vi.fn().mockResolvedValue({ passed: true, errors: [], durationMs: 50 });
    const judge = vi.fn().mockResolvedValue({ verdict: 'APPROVE', reasoning: '', veto_reason: '', durationMs: 0 });
    const session = createMockSession(makeSessionResult());
    MockClaudeCodeSession.mockImplementationOnce(function() { return session; });

    const orchestrator = new RetryOrchestrator(
      { workspaceDir: '/tmp/workspace' },
      { maxRetries: 3, verifier, judge }
    );

    const result = await orchestrator.run('Fix the bug');

    expect(result.finalStatus).toBe('zero_diff');
    expect(verifier).not.toHaveBeenCalled();
    expect(judge).not.toHaveBeenCalled();
  });

  it('zero-2. returns zero_diff when diff is shorter than MIN_DIFF_CHARS', async () => {
    const { getWorkspaceDiff } = await import('./judge.js');
    const mockGetDiff = getWorkspaceDiff as ReturnType<typeof vi.fn>;
    mockGetDiff.mockResolvedValueOnce('tiny'); // 4 chars < MIN_DIFF_CHARS (10)

    const verifier = vi.fn().mockResolvedValue({ passed: true, errors: [], durationMs: 50 });
    const judge = vi.fn().mockResolvedValue({ verdict: 'APPROVE', reasoning: '', veto_reason: '', durationMs: 0 });
    const session = createMockSession(makeSessionResult());
    MockClaudeCodeSession.mockImplementationOnce(function() { return session; });

    const orchestrator = new RetryOrchestrator(
      { workspaceDir: '/tmp/workspace' },
      { maxRetries: 3, verifier, judge }
    );

    const result = await orchestrator.run('Fix the bug');

    expect(result.finalStatus).toBe('zero_diff');
    expect(verifier).not.toHaveBeenCalled();
    expect(judge).not.toHaveBeenCalled();
  });

  it('zero-3. zero_diff returns immediately on first attempt (no retry)', async () => {
    const { getWorkspaceDiff } = await import('./judge.js');
    const mockGetDiff = getWorkspaceDiff as ReturnType<typeof vi.fn>;
    mockGetDiff.mockResolvedValueOnce(''); // one-time empty diff — does not affect subsequent tests

    const verifier = vi.fn().mockResolvedValue({ passed: true, errors: [], durationMs: 50 });
    const session = createMockSession(makeSessionResult());
    MockClaudeCodeSession.mockImplementationOnce(function() { return session; });

    const orchestrator = new RetryOrchestrator(
      { workspaceDir: '/tmp/workspace' },
      { maxRetries: 3, verifier }
    );

    const result = await orchestrator.run('Fix the bug');

    expect(result.finalStatus).toBe('zero_diff');
    expect(result.attempts).toBe(1);
    expect(MockClaudeCodeSession.mock.calls).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Config-only classification tests
  // -------------------------------------------------------------------------

  it('config-1. isConfigFile returns true for config files', () => {
    expect(isConfigFile('.eslintrc.json')).toBe(true);
    expect(isConfigFile('tsconfig.json')).toBe(true);
    expect(isConfigFile('vite.config.ts')).toBe(true);
    expect(isConfigFile('.prettierrc')).toBe(true);
    expect(isConfigFile('jest.config.js')).toBe(true);
    expect(isConfigFile('.gitignore')).toBe(true);
    expect(isConfigFile('.nvmrc')).toBe(true);
  });

  it('config-2. isConfigFile returns false for source files', () => {
    expect(isConfigFile('src/app.ts')).toBe(false);
    expect(isConfigFile('lib/utils.js')).toBe(false);
  });

  it('config-3. isConfigFile handles nested config files correctly', () => {
    expect(isConfigFile('packages/foo/tsconfig.json')).toBe(true);
    expect(isConfigFile('.github/workflows/ci.yml')).toBe(true);
  });

  it('config-4. isConfigFile rejects source files with "config" in directory path', () => {
    expect(isConfigFile('src/config/app.ts')).toBe(false);
  });

  it('config-5. config-only changes invoke compositeVerifier with configOnly: true', async () => {
    const { getWorkspaceDiff } = await import('./judge.js');
    const mockGetDiff = getWorkspaceDiff as ReturnType<typeof vi.fn>;
    mockGetDiff.mockResolvedValue('substantial config diff content here');

    // Mock getChangedFilesFromBaseline via execFile — return only config file
    // Note: promisify(execFile) resolves with the first non-error arg; for exec-style
    // commands we must return { stdout, stderr } to match Node's execFile promise shape.
    const { execFile } = await import('node:child_process');
    const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;
    mockExecFile.mockImplementation((...args: any[]) => {
      const cmdArgs = args[1] as string[];
      const callback = args[args.length - 1];
      if (args[0] === 'git' && cmdArgs[0] === 'diff' && cmdArgs.includes('--name-only')) {
        if (typeof callback === 'function') callback(null, { stdout: '.eslintrc.json\n', stderr: '' });
      } else {
        if (typeof callback === 'function') callback(null, { stdout: '', stderr: '' });
      }
    });

    const mockCompositeVerifier = compositeVerifier as ReturnType<typeof vi.fn>;
    mockCompositeVerifier.mockResolvedValue({ passed: true, errors: [], durationMs: 50 });

    const session = createMockSession(makeSessionResult());
    MockClaudeCodeSession.mockImplementationOnce(function() { return session; });

    const orchestrator = new RetryOrchestrator(
      { workspaceDir: '/tmp/workspace' },
      { maxRetries: 3, verifier: compositeVerifier }
    );

    await orchestrator.run('update eslint config');

    expect(mockCompositeVerifier).toHaveBeenCalledWith('/tmp/workspace', { configOnly: true });
  });

  it('config-6. config-only changes still invoke the judge', async () => {
    const { getWorkspaceDiff } = await import('./judge.js');
    const mockGetDiff = getWorkspaceDiff as ReturnType<typeof vi.fn>;
    mockGetDiff.mockResolvedValue('substantial config diff content here');

    // Mock getChangedFilesFromBaseline via execFile — return only config file
    const { execFile } = await import('node:child_process');
    const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;
    mockExecFile.mockImplementation((...args: any[]) => {
      const cmdArgs = args[1] as string[];
      const callback = args[args.length - 1];
      if (args[0] === 'git' && cmdArgs[0] === 'diff' && cmdArgs.includes('--name-only')) {
        if (typeof callback === 'function') callback(null, { stdout: '.eslintrc.json\n', stderr: '' });
      } else {
        if (typeof callback === 'function') callback(null, { stdout: '', stderr: '' });
      }
    });

    const mockCompositeVerifier = compositeVerifier as ReturnType<typeof vi.fn>;
    mockCompositeVerifier.mockResolvedValue({ passed: true, errors: [], durationMs: 50 });

    const judge = vi.fn().mockResolvedValue({ verdict: 'APPROVE', reasoning: '', veto_reason: '', durationMs: 0 });
    const session = createMockSession(makeSessionResult());
    MockClaudeCodeSession.mockImplementationOnce(function() { return session; });

    const orchestrator = new RetryOrchestrator(
      { workspaceDir: '/tmp/workspace' },
      { maxRetries: 3, verifier: compositeVerifier, judge }
    );

    await orchestrator.run('update eslint config');

    // Judge MUST still be called for config-only changes
    expect(judge).toHaveBeenCalledTimes(1);
  });

  it('14. retry message only includes last failed verification (not stale errors)', async () => {
    // Ensure getWorkspaceDiff returns non-empty so zero-diff check doesn't short-circuit
    const { getWorkspaceDiff } = await import('./judge.js');
    const mockGetDiff = getWorkspaceDiff as ReturnType<typeof vi.fn>;
    mockGetDiff.mockResolvedValue('substantial diff content here');

    // Reset execFile to safe default so getChangedFilesFromBaseline returns [] (non-configOnly)
    const { execFile } = await import('node:child_process');
    const mockExecFileTmp = execFile as unknown as ReturnType<typeof vi.fn>;
    mockExecFileTmp.mockImplementation((...args: any[]) => {
      const callback = args[args.length - 1];
      if (typeof callback === 'function') callback(null, { stdout: '', stderr: '' });
    });

    const verifier = vi.fn()
      .mockResolvedValueOnce(makeFailedVerification('TS error from attempt 1'))
      .mockResolvedValueOnce(makeFailedVerification('Test failure from attempt 2'))
      .mockResolvedValueOnce(makePassedVerification());

    const capturedMessages: string[] = [];
    [0, 1, 2].forEach(() => {
      const session = createMockSession(async (msg: string) => {
        capturedMessages.push(msg);
        return makeSessionResult();
      });
      MockClaudeCodeSession.mockImplementationOnce(function() { return session; });
    });

    const orchestrator = new RetryOrchestrator(
      { workspaceDir: '/tmp/workspace' },
      { maxRetries: 3, verifier }
    );

    await orchestrator.run('Fix the bug');

    // Attempt 3's message should contain only attempt 2's error, NOT attempt 1's
    const attempt3Msg = capturedMessages[2];
    expect(attempt3Msg).toContain('Test failure from attempt 2');
    expect(attempt3Msg).not.toContain('TS error from attempt 1');
  });
});
