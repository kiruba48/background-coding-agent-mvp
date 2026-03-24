import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionResult, VerificationResult, JudgeResult } from '../types.js';

// Shared mock for Anthropic client's messages.create method (GA API)
const mockCreate = vi.fn();

// Mock @anthropic-ai/sdk before importing judge
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: function MockAnthropic() {
      return {
        messages: {
          create: mockCreate,
        },
      };
    },
  };
});

// Mock node:child_process before importing judge
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

// Mock ClaudeCodeSession — the only session type after legacy deletion
vi.mock('./claude-code-session.js', () => {
  const MockClaudeCodeSession = vi.fn();
  return { ClaudeCodeSession: MockClaudeCodeSession };
});

import { execFile } from 'node:child_process';
import {
  llmJudge,
  getWorkspaceDiff,
  truncateDiff,
  truncateLockfileDiffs,
  MAX_DIFF_CHARS,
  MIN_DIFF_CHARS,
} from './judge.js';
import { RetryOrchestrator } from './retry.js';
import { ClaudeCodeSession } from './claude-code-session.js';

const MockClaudeCodeSession = ClaudeCodeSession as ReturnType<typeof vi.fn>;

// Cast mocks for typed access
const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;

/**
 * Helper to make execFile resolve (simulate success).
 */
function mockExecSuccess(stdout = ''): void {
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      callback: (err: null, result: { stdout: string; stderr: string }) => void
    ) => {
      callback(null, { stdout, stderr: '' });
    }
  );
}

/**
 * Helper to make execFile reject (simulate failure).
 */
function mockExecFailure(message = 'error'): void {
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      callback: (err: Error) => void
    ) => {
      callback(new Error(message));
    }
  );
}

/**
 * Build a mock Anthropic API response with structured output JSON text.
 */
function buildApiResponse(verdict: 'APPROVE' | 'VETO', reasoning = 'analysis', veto_reason = ''): object {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ reasoning, verdict, veto_reason }),
      },
    ],
  };
}

describe('truncateDiff', () => {
  it('returns diff unchanged when under MAX_DIFF_CHARS', () => {
    const shortDiff = 'a'.repeat(100);
    expect(truncateDiff(shortDiff)).toBe(shortDiff);
  });

  it('truncates diffs over MAX_DIFF_CHARS with notice', () => {
    const longDiff = 'a'.repeat(MAX_DIFF_CHARS + 1000);
    const result = truncateDiff(longDiff);
    expect(result.length).toBeGreaterThan(MAX_DIFF_CHARS);
    expect(result.slice(0, MAX_DIFF_CHARS)).toBe(longDiff.slice(0, MAX_DIFF_CHARS));
    expect(result).toContain('truncated');
    expect(result).toContain(String(MAX_DIFF_CHARS));
  });

  it('returns diff unchanged when exactly MAX_DIFF_CHARS', () => {
    const exactDiff = 'a'.repeat(MAX_DIFF_CHARS);
    expect(truncateDiff(exactDiff)).toBe(exactDiff);
  });
});

describe('truncateLockfileDiffs', () => {
  it('strips package-lock.json hunk entirely', () => {
    const diff = [
      'diff --git a/src/index.ts b/src/index.ts',
      'index abc..def 100644',
      '--- a/src/index.ts',
      '+++ b/src/index.ts',
      '@@ -1,3 +1,3 @@',
      ' line1',
      '-old line',
      '+new line',
      'diff --git a/package-lock.json b/package-lock.json',
      'index 000..fff 100644',
      '--- a/package-lock.json',
      '+++ b/package-lock.json',
      '@@ -1,100 +1,200 @@',
      ' {',
      '-  "old": "data"',
      '+  "new": "data"',
      ' }',
    ].join('\n');

    const result = truncateLockfileDiffs(diff);
    // Non-lockfile hunk preserved
    expect(result).toContain('diff --git a/src/index.ts b/src/index.ts');
    expect(result).toContain('+new line');
    // Lockfile hunk stripped entirely
    expect(result).not.toContain('package-lock.json');
    expect(result).not.toContain('"old": "data"');
    expect(result).not.toContain('"new": "data"');
  });

  it('strips yarn.lock hunk entirely', () => {
    const diff = [
      'diff --git a/yarn.lock b/yarn.lock',
      'index abc..def 100644',
      '--- a/yarn.lock',
      '+++ b/yarn.lock',
      '@@ -1,5 +1,5 @@',
      '-lodash@^4.0.0:',
      '+lodash@^4.17.0:',
    ].join('\n');

    const result = truncateLockfileDiffs(diff);
    expect(result).not.toContain('yarn.lock');
    expect(result).not.toContain('lodash@^4.0.0');
  });

  it('leaves non-lockfile diffs unchanged', () => {
    const diff = [
      'diff --git a/src/app.ts b/src/app.ts',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '+new line',
    ].join('\n');

    const result = truncateLockfileDiffs(diff);
    expect(result).toBe(diff);
  });

  it('handles empty diff', () => {
    expect(truncateLockfileDiffs('')).toBe('');
  });
});

describe('getWorkspaceDiff', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it('returns diff from HEAD~1..HEAD when non-empty', async () => {
    const expectedDiff = 'diff --git a/file.ts b/file.ts\n+added line';
    // First call (HEAD~1..HEAD) returns the diff
    mockExecFile.mockImplementationOnce(
      (_cmd: string, _args: string[], _opts: unknown, callback: (err: null, result: { stdout: string; stderr: string }) => void) => {
        callback(null, { stdout: expectedDiff, stderr: '' });
      }
    );

    const result = await getWorkspaceDiff('/workspace');
    expect(result).toBe(expectedDiff);
  });

  it('falls back to git diff HEAD when HEAD~1..HEAD is empty', async () => {
    const fallbackDiff = 'diff --git a/staged.ts b/staged.ts\n+staged line';

    // First call (HEAD~1..HEAD) returns empty
    mockExecFile.mockImplementationOnce(
      (_cmd: string, _args: string[], _opts: unknown, callback: (err: null, result: { stdout: string; stderr: string }) => void) => {
        callback(null, { stdout: '', stderr: '' });
      }
    );
    // Second call (HEAD) returns the fallback diff
    mockExecFile.mockImplementationOnce(
      (_cmd: string, _args: string[], _opts: unknown, callback: (err: null, result: { stdout: string; stderr: string }) => void) => {
        callback(null, { stdout: fallbackDiff, stderr: '' });
      }
    );

    const result = await getWorkspaceDiff('/workspace');
    expect(result).toBe(fallbackDiff);
  });

  it('falls back to unstaged diff when HEAD is also empty', async () => {
    const unstagedDiff = 'diff --git a/unstaged.ts b/unstaged.ts\n+unstaged line';

    // First call (HEAD~1..HEAD) returns empty
    mockExecFile.mockImplementationOnce(
      (_cmd: string, _args: string[], _opts: unknown, callback: (err: null, result: { stdout: string; stderr: string }) => void) => {
        callback(null, { stdout: '', stderr: '' });
      }
    );
    // Second call (HEAD) returns empty
    mockExecFile.mockImplementationOnce(
      (_cmd: string, _args: string[], _opts: unknown, callback: (err: null, result: { stdout: string; stderr: string }) => void) => {
        callback(null, { stdout: '', stderr: '' });
      }
    );
    // Third call (unstaged) returns the diff
    mockExecFile.mockImplementationOnce(
      (_cmd: string, _args: string[], _opts: unknown, callback: (err: null, result: { stdout: string; stderr: string }) => void) => {
        callback(null, { stdout: unstagedDiff, stderr: '' });
      }
    );

    const result = await getWorkspaceDiff('/workspace');
    expect(result).toBe(unstagedDiff);
  });

  it('returns empty string on git error (no commits)', async () => {
    mockExecFailure('fatal: ambiguous argument HEAD~1');
    const result = await getWorkspaceDiff('/workspace');
    expect(result).toBe('');
  });
});

describe('llmJudge', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    mockCreate.mockReset();
  });

  it('returns APPROVE verdict when API responds with APPROVE', async () => {
    const workspaceDiff = 'diff --git a/src/feature.ts b/src/feature.ts\n+const x = 1;';
    mockExecSuccess(workspaceDiff);
    mockCreate.mockResolvedValue(buildApiResponse('APPROVE', 'Changes are within scope', ''));

    const result = await llmJudge('/workspace', 'Add a constant x to feature.ts');

    expect(result.verdict).toBe('APPROVE');
    expect(result.reasoning).toBe('Changes are within scope');
    expect(result.veto_reason).toBe('');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.skipped).toBeUndefined();
  });

  it('returns VETO verdict with reasoning when API responds with VETO', async () => {
    const workspaceDiff = 'diff --git a/src/unrelated.ts b/src/unrelated.ts\n+refactored entire file';
    mockExecSuccess(workspaceDiff);
    mockCreate.mockResolvedValue(buildApiResponse('VETO', 'Agent refactored unrelated file', 'Refactoring of unrelated.ts was not requested'));

    const result = await llmJudge('/workspace', 'Fix a bug in feature.ts');

    expect(result.verdict).toBe('VETO');
    expect(result.reasoning).toBe('Agent refactored unrelated file');
    expect(result.veto_reason).toBe('Refactoring of unrelated.ts was not requested');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('fails open (returns APPROVE with skipped=true) on API error', async () => {
    const workspaceDiff = 'diff --git a/src/feature.ts b/src/feature.ts\n+const x = 1;';
    mockExecSuccess(workspaceDiff);
    mockCreate.mockRejectedValue(new Error('Network error: connection refused'));

    const result = await llmJudge('/workspace', 'Add a constant');

    expect(result.verdict).toBe('APPROVE');
    expect(result.skipped).toBe(true);
    expect(result.reasoning).toContain('unavailable');
  });

  it('fails open on 429 rate limit error', async () => {
    const workspaceDiff = 'diff --git a/src/feature.ts b/src/feature.ts\n+const x = 1;';
    mockExecSuccess(workspaceDiff);
    const rateLimitError = Object.assign(new Error('Rate limit exceeded'), { status: 429 });
    mockCreate.mockRejectedValue(rateLimitError);

    const result = await llmJudge('/workspace', 'Add a constant');

    expect(result.verdict).toBe('APPROVE');
    expect(result.skipped).toBe(true);
  });

  it('skips (returns APPROVE with skipped=true) when diff is empty', async () => {
    mockExecSuccess('');

    const result = await llmJudge('/workspace', 'Add a constant');

    expect(result.verdict).toBe('APPROVE');
    expect(result.skipped).toBe(true);
    expect(result.durationMs).toBe(0);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('skips when diff is under MIN_DIFF_CHARS', async () => {
    const tinyDiff = 'ab';  // under MIN_DIFF_CHARS (10)
    expect(tinyDiff.length).toBeLessThan(MIN_DIFF_CHARS);
    mockExecSuccess(tinyDiff);

    const result = await llmJudge('/workspace', 'Add a constant');

    expect(result.verdict).toBe('APPROVE');
    expect(result.skipped).toBe(true);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('calls API with diff and original task in XML tags', async () => {
    const workspaceDiff = 'diff --git a/src/feature.ts b/src/feature.ts\n+const x = 1;';
    const originalTask = 'Add constant x to feature.ts';
    mockExecSuccess(workspaceDiff);
    mockCreate.mockResolvedValue(buildApiResponse('APPROVE'));

    await llmJudge('/workspace', originalTask);

    expect(mockCreate).toHaveBeenCalledOnce();
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.messages[0].content).toContain('<original_task>');
    expect(callArgs.messages[0].content).toContain(originalTask);
    expect(callArgs.messages[0].content).toContain('</original_task>');
    expect(callArgs.messages[0].content).toContain('<diff>');
    expect(callArgs.messages[0].content).toContain('</diff>');
  });

  it('uses GA structured output with correct schema (no betas array)', async () => {
    const workspaceDiff = 'diff --git a/src/feature.ts b/src/feature.ts\n+const x = 1;';
    mockExecSuccess(workspaceDiff);
    mockCreate.mockResolvedValue(buildApiResponse('APPROVE'));

    await llmJudge('/workspace', 'Add a constant');

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.betas).toBeUndefined();
    expect(callArgs.output_config).toBeDefined();
    expect(callArgs.output_config.format.type).toBe('json_schema');
    expect(callArgs.output_config.format.schema.properties).toHaveProperty('verdict');
    expect(callArgs.output_config.format.schema.properties).toHaveProperty('reasoning');
    expect(callArgs.output_config.format.schema.properties).toHaveProperty('veto_reason');
  });

  it('judge prompt contains NOT-scope-creep entries for test file updates', async () => {
    const workspaceDiff = 'diff --git a/src/feature.ts b/src/feature.ts\n+const x = 1;';
    mockExecSuccess(workspaceDiff);
    mockCreate.mockResolvedValue(buildApiResponse('APPROVE'));

    await llmJudge('/workspace', 'Add a constant');

    const callArgs = mockCreate.mock.calls[0][0];
    const prompt: string = callArgs.messages[0].content;
    expect(prompt).toContain('NOT scope creep: updating test files that exercise the renamed');
    expect(prompt).toContain('NOT scope creep: updating import paths and import statements');
    expect(prompt).toContain('NOT scope creep: updating TypeScript type annotations');
    expect(prompt).toContain('NOT scope creep: updating string literals or documentation comments');
  });

  it('judge approves refactoring scenario: rename function + update test imports', async () => {
    const renameDiff = [
      'diff --git a/src/api.ts b/src/api.ts',
      '--- a/src/api.ts',
      '+++ b/src/api.ts',
      '@@ -1,5 +1,5 @@',
      '-export function getUserData() {',
      '+export function fetchUserProfile() {',
      '   return {};',
      ' }',
      'diff --git a/src/api.test.ts b/src/api.test.ts',
      '--- a/src/api.test.ts',
      '+++ b/src/api.test.ts',
      '@@ -1,5 +1,5 @@',
      "-import { getUserData } from './api.js';",
      "+import { fetchUserProfile } from './api.js';",
      '-getUserData()',
      '+fetchUserProfile()',
    ].join('\n');

    mockExecSuccess(renameDiff);
    mockCreate.mockResolvedValue(buildApiResponse('APPROVE', 'Rename is in scope, test updates are consistent', ''));

    const result = await llmJudge('/workspace', 'Rename getUserData to fetchUserProfile');

    expect(result.verdict).toBe('APPROVE');
    // Prompt should contain the refactoring NOT-scope-creep guidance
    const callArgs = mockCreate.mock.calls[0][0];
    const prompt: string = callArgs.messages[0].content;
    expect(prompt).toContain('NOT scope creep: updating test files that exercise the renamed');
    expect(prompt).toContain('NOT scope creep: updating import paths and import statements');
  });

  it('strips lockfile diffs before calling API', async () => {
    const diffWithLockfile = [
      'diff --git a/src/index.ts b/src/index.ts',
      '+new line',
      'diff --git a/package-lock.json b/package-lock.json',
      'index abc..def',
      '--- a/package-lock.json',
      '+++ b/package-lock.json',
      '+  "dependency": "1.0.0"',
      '+  "lots": "of"',
      '+  "lockfile": "content"',
    ].join('\n');

    mockExecSuccess(diffWithLockfile);
    mockCreate.mockResolvedValue(buildApiResponse('APPROVE'));

    await llmJudge('/workspace', 'Update dependency');

    const callArgs = mockCreate.mock.calls[0][0];
    const fullPrompt = callArgs.messages[0].content;
    // Extract just the <diff> section to check lockfile stripping
    const diffSection = fullPrompt.match(/<diff>([\s\S]*?)<\/diff>/)?.[1] ?? '';
    expect(diffSection).not.toContain('package-lock.json');
    expect(diffSection).not.toContain('"dependency": "1.0.0"');
    // Non-lockfile diff preserved
    expect(diffSection).toContain('+new line');
  });

  it('uses DEFAULT_JUDGE_MODEL when JUDGE_MODEL env var not set', async () => {
    const workspaceDiff = 'diff --git a/src/feature.ts b/src/feature.ts\n+const x = 1;';
    mockExecSuccess(workspaceDiff);
    mockCreate.mockResolvedValue(buildApiResponse('APPROVE'));

    const originalEnv = process.env.JUDGE_MODEL;
    delete process.env.JUDGE_MODEL;

    await llmJudge('/workspace', 'Add a constant');

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.model).toBe('claude-haiku-4-5-20251001');

    // Restore env
    if (originalEnv !== undefined) {
      process.env.JUDGE_MODEL = originalEnv;
    }
  });

  it('uses JUDGE_MODEL env var when set', async () => {
    const workspaceDiff = 'diff --git a/src/feature.ts b/src/feature.ts\n+const x = 1;';
    mockExecSuccess(workspaceDiff);
    mockCreate.mockResolvedValue(buildApiResponse('APPROVE'));

    process.env.JUDGE_MODEL = 'claude-sonnet-4-5-20250929';
    await llmJudge('/workspace', 'Add a constant');
    delete process.env.JUDGE_MODEL;

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.model).toBe('claude-sonnet-4-5-20250929');
  });
});

// ============================================================
// RetryOrchestrator with judge integration
// ============================================================

/** Helper to create a mock session with configurable run result */
function createMockSession(result: SessionResult): object {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    run: vi.fn().mockResolvedValue(result),
  };
}

/** Helper to make a successful SessionResult */
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

/** Helper to make a passing VerificationResult */
function makePassedVerification(): VerificationResult {
  return { passed: true, errors: [], durationMs: 50 };
}

/** Helper to make a mock judge function that returns a specific verdict */
function makeJudgeFn(result: JudgeResult): (workspaceDir: string, originalTask: string) => Promise<JudgeResult> {
  return vi.fn().mockResolvedValue(result);
}

/** Helper to make an APPROVE JudgeResult */
function makeApproveResult(): JudgeResult {
  return { verdict: 'APPROVE', reasoning: 'Scope aligned', veto_reason: '', durationMs: 10 };
}

/** Helper to make a VETO JudgeResult */
function makeVetoResult(reason = 'Scope creep detected'): JudgeResult {
  return { verdict: 'VETO', reasoning: 'Agent exceeded scope', veto_reason: reason, durationMs: 10 };
}

describe('RetryOrchestrator with judge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns success when verifier passes and judge approves', async () => {
    const verifier = vi.fn().mockResolvedValue(makePassedVerification());
    const judge = makeJudgeFn(makeApproveResult());
    const session = createMockSession(makeSessionResult());
    MockClaudeCodeSession.mockImplementationOnce(function() { return session; });

    const orchestrator = new RetryOrchestrator(
      { workspaceDir: '/tmp/workspace' },
      { maxRetries: 3, verifier, judge, maxJudgeVetoes: 1 }
    );

    const result = await orchestrator.run('Fix the bug');

    expect(result.finalStatus).toBe('success');
    expect(result.attempts).toBe(1);
    expect(result.judgeResults).toHaveLength(1);
    expect(result.judgeResults![0].verdict).toBe('APPROVE');
    expect(judge).toHaveBeenCalledWith('/tmp/workspace', 'Fix the bug', expect.anything());
  });

  it('returns vetoed when judge vetoes maxJudgeVetoes times', async () => {
    // Verifier always passes, judge always vetoes
    const verifier = vi.fn().mockResolvedValue(makePassedVerification());
    const judge = vi.fn().mockResolvedValue(makeVetoResult('Changed unrelated files'));

    // We need 2 sessions: attempt 1 (veto → retry) + attempt 2 (veto budget exhausted → vetoed)
    const session1 = createMockSession(makeSessionResult());
    const session2 = createMockSession(makeSessionResult());
    MockClaudeCodeSession
      .mockImplementationOnce(function() { return session1; })
      .mockImplementationOnce(function() { return session2; });

    const orchestrator = new RetryOrchestrator(
      { workspaceDir: '/tmp/workspace' },
      { maxRetries: 3, verifier, judge, maxJudgeVetoes: 1 }
    );

    const result = await orchestrator.run('Fix the bug');

    expect(result.finalStatus).toBe('vetoed');
    expect(result.attempts).toBe(2);
    expect(result.judgeResults).toHaveLength(1); // only 1 veto recorded before budget check
    expect(result.error).toContain('vetoed');
  });

  it('returns success on second attempt after first veto then approve', async () => {
    const verifier = vi.fn().mockResolvedValue(makePassedVerification());
    // Judge vetoes on first call, approves on second
    const judge = vi.fn()
      .mockResolvedValueOnce(makeVetoResult('Unrelated change'))
      .mockResolvedValueOnce(makeApproveResult());

    const session1 = createMockSession(makeSessionResult());
    const session2 = createMockSession(makeSessionResult());
    MockClaudeCodeSession
      .mockImplementationOnce(function() { return session1; })
      .mockImplementationOnce(function() { return session2; });

    // maxJudgeVetoes: 2 — allows 1 veto retry before declaring vetoed
    const orchestrator = new RetryOrchestrator(
      { workspaceDir: '/tmp/workspace' },
      { maxRetries: 3, verifier, judge, maxJudgeVetoes: 2 }
    );

    const result = await orchestrator.run('Fix the bug');

    expect(result.finalStatus).toBe('success');
    expect(result.attempts).toBe(2);
    expect(result.judgeResults).toHaveLength(2);
    expect(result.judgeResults![0].verdict).toBe('VETO');
    expect(result.judgeResults![1].verdict).toBe('APPROVE');
    expect(judge).toHaveBeenCalledTimes(2);
  });

  it('skips judge when not configured (backward compatibility)', async () => {
    const verifier = vi.fn().mockResolvedValue(makePassedVerification());
    const session = createMockSession(makeSessionResult());
    MockClaudeCodeSession.mockImplementationOnce(function() { return session; });

    // No judge in config
    const orchestrator = new RetryOrchestrator(
      { workspaceDir: '/tmp/workspace' },
      { maxRetries: 3, verifier }
    );

    const result = await orchestrator.run('Fix the bug');

    expect(result.finalStatus).toBe('success');
    expect(result.attempts).toBe(1);
    expect(result.judgeResults).toHaveLength(0);
  });

  it('includes veto reason in retry message when judge vetoes', async () => {
    const verifier = vi.fn().mockResolvedValue(makePassedVerification());
    const judge = vi.fn()
      .mockResolvedValueOnce(makeVetoResult('Modified unrelated config file'))
      .mockResolvedValueOnce(makeApproveResult());

    const capturedMessages: string[] = [];
    const session1 = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      run: vi.fn().mockImplementation(async (msg: string) => {
        capturedMessages.push(msg);
        return makeSessionResult();
      }),
    };
    const session2 = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      run: vi.fn().mockImplementation(async (msg: string) => {
        capturedMessages.push(msg);
        return makeSessionResult();
      }),
    };
    MockClaudeCodeSession
      .mockImplementationOnce(function() { return session1; })
      .mockImplementationOnce(function() { return session2; });

    // maxJudgeVetoes: 2 — allows judge to run on attempt 2 (first veto used only 1 of 2 retries)
    const orchestrator = new RetryOrchestrator(
      { workspaceDir: '/tmp/workspace' },
      { maxRetries: 3, verifier, judge, maxJudgeVetoes: 2 }
    );

    await orchestrator.run('Fix the bug');

    // Second message should contain the judge veto info
    expect(capturedMessages).toHaveLength(2);
    expect(capturedMessages[1]).toContain('VETOED BY LLM JUDGE');
    expect(capturedMessages[1]).toContain('Modified unrelated config file');
  });

  it('continues normally when judge crashes (fail open)', async () => {
    const verifier = vi.fn().mockResolvedValue(makePassedVerification());
    // Judge throws an error (crash)
    const judge = vi.fn().mockRejectedValue(new Error('Judge API unavailable'));

    const session = createMockSession(makeSessionResult());
    MockClaudeCodeSession.mockImplementationOnce(function() { return session; });

    const orchestrator = new RetryOrchestrator(
      { workspaceDir: '/tmp/workspace' },
      { maxRetries: 3, verifier, judge, maxJudgeVetoes: 1 }
    );

    const result = await orchestrator.run('Fix the bug');

    // Should succeed despite judge crash (fail open)
    expect(result.finalStatus).toBe('success');
    expect(result.judgeResults).toHaveLength(1);
    expect(result.judgeResults![0].verdict).toBe('APPROVE');
    expect(result.judgeResults![0].skipped).toBe(true);
  });
});
