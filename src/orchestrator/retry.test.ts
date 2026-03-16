import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionResult, VerificationResult } from '../types.js';

// Mock AgentSession before importing RetryOrchestrator.
// Must use vi.mock with a factory. The factory runs in hoisted context.
vi.mock('./session.js', () => {
  const MockAgentSession = vi.fn();
  return { AgentSession: MockAgentSession };
});

// Import AFTER mock is set up
import { RetryOrchestrator } from './retry.js';
import { AgentSession } from './session.js';

const MockAgentSession = AgentSession as ReturnType<typeof vi.fn>;

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
    MockAgentSession.mockImplementationOnce(function() { return session; });

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
    MockAgentSession.mockImplementationOnce(function() { return session; });

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
    MockAgentSession
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
      MockAgentSession.mockImplementationOnce(function() { return session; });
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
    MockAgentSession.mockImplementationOnce(function() { return session; });

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
    MockAgentSession.mockImplementationOnce(function() { return session; });

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
    const session = createMockSession(makeSessionResult({ status: 'failed', error: 'Docker crashed' }));
    MockAgentSession.mockImplementationOnce(function() { return session; });

    const orchestrator = new RetryOrchestrator(
      { workspaceDir: '/tmp/workspace' },
      { maxRetries: 3, verifier }
    );

    const result = await orchestrator.run('Fix the bug');

    expect(result.finalStatus).toBe('failed');
    expect(result.attempts).toBe(1);
    expect(result.error).toBe('Docker crashed');
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
    MockAgentSession
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

  it('9. creates a fresh AgentSession per attempt', async () => {
    const verifier = vi.fn()
      .mockResolvedValueOnce(makeFailedVerification())
      .mockResolvedValueOnce(makeFailedVerification())
      .mockResolvedValueOnce(makePassedVerification());

    [0, 1, 2].forEach(() => {
      const session = createMockSession(makeSessionResult());
      MockAgentSession.mockImplementationOnce(function() { return session; });
    });

    const orchestrator = new RetryOrchestrator(
      { workspaceDir: '/tmp/workspace' },
      { maxRetries: 3, verifier }
    );

    await orchestrator.run('Fix the bug');

    // AgentSession constructor should have been called once per attempt
    expect(MockAgentSession.mock.calls).toHaveLength(3);
  });

  it('10. custom maxRetries of 2 limits to 2 attempts', async () => {
    const verifier = vi.fn().mockResolvedValue(makeFailedVerification('Always fails'));

    [0, 1].forEach(() => {
      const session = createMockSession(makeSessionResult());
      MockAgentSession.mockImplementationOnce(function() { return session; });
    });

    const orchestrator = new RetryOrchestrator(
      { workspaceDir: '/tmp/workspace' },
      { maxRetries: 2, verifier }
    );

    const result = await orchestrator.run('Fix the bug');

    expect(result.finalStatus).toBe('max_retries_exhausted');
    expect(result.attempts).toBe(2);
    expect(MockAgentSession.mock.calls).toHaveLength(2);
    expect(result.error).toContain('2 attempts');
  });

  it('11. verifier crash returns structured RetryResult instead of throwing', async () => {
    const verifier = vi.fn().mockRejectedValue(new Error('tsc binary not found'));
    const session = createMockSession(makeSessionResult());
    MockAgentSession.mockImplementationOnce(function() { return session; });

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
    session.start.mockRejectedValue(new Error('Docker daemon not running'));
    MockAgentSession.mockImplementationOnce(function() { return session; });

    const orchestrator = new RetryOrchestrator(
      { workspaceDir: '/tmp/workspace' },
      { maxRetries: 3 }
    );

    await expect(orchestrator.run('Fix the bug')).rejects.toThrow('Docker daemon not running');
    // stop() must have been called even though start() threw
    expect(session.stop).toHaveBeenCalled();
  });

  it('13. stop() cleans up active session', async () => {
    const verifier = vi.fn().mockImplementation(() =>
      new Promise(() => {}) // never resolves — simulates long-running verifier
    );
    const session = createMockSession(makeSessionResult());
    MockAgentSession.mockImplementationOnce(function() { return session; });

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
    MockAgentSession.mockImplementationOnce(function() { return session; });

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
    const session = createMockSession(makeSessionResult({ status: 'failed', error: 'Docker crashed' }));
    MockAgentSession.mockImplementationOnce(function() { return session; });

    const orchestrator = new RetryOrchestrator(
      { workspaceDir: '/tmp/workspace' },
      { maxRetries: 3, verifier, preVerify }
    );

    const result = await orchestrator.run('Fix the bug');

    expect(result.finalStatus).toBe('failed');
    expect(preVerify).not.toHaveBeenCalled();
  });

  it('17. preVerify failure returns finalStatus failed immediately (no retry)', async () => {
    const preVerify = vi.fn().mockRejectedValue(new Error('npm install failed: invalid version'));
    const verifier = vi.fn().mockResolvedValue(makePassedVerification());
    const session = createMockSession(makeSessionResult());
    MockAgentSession.mockImplementationOnce(function() { return session; });

    const orchestrator = new RetryOrchestrator(
      { workspaceDir: '/tmp/workspace' },
      { maxRetries: 3, verifier, preVerify }
    );

    const result = await orchestrator.run('Fix the bug');

    expect(result.finalStatus).toBe('failed');
    expect(result.attempts).toBe(1);
    expect(result.error).toContain('Pre-verify failed');
    expect(result.error).toContain('npm install failed: invalid version');
    // Verifier must NOT have been called — preVerify failure is terminal
    expect(verifier).not.toHaveBeenCalled();
    // Only 1 session created (no retry)
    expect(MockAgentSession.mock.calls).toHaveLength(1);
  });

  it('18. retry loop without preVerify works exactly as before (backwards compatible)', async () => {
    const verifier = vi.fn()
      .mockResolvedValueOnce(makeFailedVerification('Build failed'))
      .mockResolvedValueOnce(makePassedVerification());

    const session1 = createMockSession(makeSessionResult());
    const session2 = createMockSession(makeSessionResult());
    MockAgentSession
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
    MockAgentSession
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

  it('14. retry message only includes last failed verification (not stale errors)', async () => {
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
      MockAgentSession.mockImplementationOnce(function() { return session; });
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
