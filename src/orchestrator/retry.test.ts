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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
});
