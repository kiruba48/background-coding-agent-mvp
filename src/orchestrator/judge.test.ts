import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock node:child_process before importing judge
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

// Mock @anthropic-ai/sdk before importing judge
vi.mock('@anthropic-ai/sdk', () => {
  const mockCreate = vi.fn();
  return {
    default: vi.fn().mockImplementation(() => ({
      beta: {
        messages: {
          create: mockCreate,
        },
      },
    })),
    __mockCreate: mockCreate,
  };
});

import { execFile } from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';
import {
  llmJudge,
  getWorkspaceDiff,
  truncateDiff,
  truncateLockfileDiffs,
  MAX_DIFF_CHARS,
  MIN_DIFF_CHARS,
} from './judge.js';

// Cast mocks for typed access
const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;

/**
 * Helper to make execFile resolve (simulate success).
 */
function mockExecSuccess(stdout = '', _stderr = ''): void {
  mockExecFile.mockImplementation(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      callback: (err: null, result: { stdout: string; stderr: string }) => void
    ) => {
      callback(null, { stdout, stderr: _stderr });
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
 * Get the mock create function from the mocked Anthropic module.
 */
function getMockCreate(): ReturnType<typeof vi.fn> {
  const instance = new (Anthropic as unknown as new () => { beta: { messages: { create: ReturnType<typeof vi.fn> } } })();
  return instance.beta.messages.create;
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
  it('replaces package-lock.json hunk with lockfile updated note', () => {
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
    // Lockfile hunk replaced
    expect(result).toContain('diff --git a/package-lock.json b/package-lock.json');
    expect(result).toContain('+ lockfile updated');
    expect(result).not.toContain('"old": "data"');
    expect(result).not.toContain('"new": "data"');
  });

  it('replaces yarn.lock hunk with lockfile updated note', () => {
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
    expect(result).toContain('diff --git a/yarn.lock b/yarn.lock');
    expect(result).toContain('+ lockfile updated');
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
  let mockCreate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockExecFile.mockReset();
    // Get the mock create function from new Anthropic() instance
    mockCreate = getMockCreate();
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

  it('uses beta structured output with correct schema', async () => {
    const workspaceDiff = 'diff --git a/src/feature.ts b/src/feature.ts\n+const x = 1;';
    mockExecSuccess(workspaceDiff);
    mockCreate.mockResolvedValue(buildApiResponse('APPROVE'));

    await llmJudge('/workspace', 'Add a constant');

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.betas).toContain('structured-outputs-2025-11-13');
    expect(callArgs.output_config).toBeDefined();
    expect(callArgs.output_config.format.type).toBe('json_schema');
    expect(callArgs.output_config.format.schema.properties).toHaveProperty('verdict');
    expect(callArgs.output_config.format.schema.properties).toHaveProperty('reasoning');
    expect(callArgs.output_config.format.schema.properties).toHaveProperty('veto_reason');
  });

  it('truncates lockfile diffs before calling API', async () => {
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
    const diffInPrompt = callArgs.messages[0].content;
    expect(diffInPrompt).toContain('+ lockfile updated');
    expect(diffInPrompt).not.toContain('"dependency": "1.0.0"');
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
