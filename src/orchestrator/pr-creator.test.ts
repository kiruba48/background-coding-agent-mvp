import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock simple-git before importing pr-creator
const mockPush = vi.fn();
const mockCheckoutLocalBranch = vi.fn();
const mockCheckout = vi.fn();
const mockStatus = vi.fn();
const mockAdd = vi.fn();
const mockCommit = vi.fn();
const mockRaw = vi.fn();

vi.mock('simple-git', () => {
  return {
    simpleGit: vi.fn().mockReturnValue({
      push: mockPush,
      checkoutLocalBranch: mockCheckoutLocalBranch,
      checkout: mockCheckout,
      status: mockStatus,
      add: mockAdd,
      commit: mockCommit,
      raw: mockRaw,
    }),
  };
});

// Mock octokit before importing pr-creator
const mockPullsCreate = vi.fn();
const mockPullsList = vi.fn();
const mockReposGet = vi.fn();

vi.mock('octokit', () => {
  return {
    Octokit: vi.fn().mockImplementation(() => ({
      rest: {
        pulls: {
          create: mockPullsCreate,
          list: mockPullsList,
        },
        repos: {
          get: mockReposGet,
        },
      },
    })),
  };
});

// Mock node:child_process
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';
import {
  generateBranchName,
  buildPRBody,
  detectBreakingChanges,
  GitHubPRCreator,
} from './pr-creator.js';
import type { RetryResult, VerificationResult, JudgeResult } from '../types.js';

const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;

/**
 * Helper to make execFile resolve with a specific stdout value.
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

/** Helper to make a passing VerificationResult */
function makePassedVerification(): VerificationResult {
  return { passed: true, errors: [], durationMs: 50 };
}

/** Helper to make a failed VerificationResult */
function makeFailedVerification(rawOutput = 'Build failed'): VerificationResult {
  return {
    passed: false,
    errors: [{ type: 'build', summary: 'Build failed', rawOutput }],
    durationMs: 100,
  };
}

/** Helper to make an APPROVE JudgeResult */
function makeApproveResult(reasoning = 'Scope aligned'): JudgeResult {
  return { verdict: 'APPROVE', reasoning, veto_reason: '', durationMs: 10 };
}

/** Helper to make a VETO JudgeResult */
function makeVetoResult(reason = 'Scope creep detected'): JudgeResult {
  return { verdict: 'VETO', reasoning: 'Agent exceeded scope', veto_reason: reason, durationMs: 10 };
}

/** Helper to make a RetryResult */
function makeRetryResult(overrides: Partial<RetryResult> = {}): RetryResult {
  return {
    finalStatus: 'success',
    attempts: 1,
    sessionResults: [
      {
        sessionId: 'session-1',
        status: 'success',
        toolCallCount: 5,
        duration: 2000,
        finalResponse: 'Updated the dependency versions in pom.xml.',
      },
    ],
    verificationResults: [makePassedVerification()],
    judgeResults: [makeApproveResult()],
    ...overrides,
  };
}

// ============================================================
// generateBranchName
// ============================================================

describe('generateBranchName', () => {
  it('converts task type to slugified branch name with date suffix', () => {
    const result = generateBranchName('maven dependency update');
    expect(result).toMatch(/^agent\/maven-dependency-update-\d{4}-\d{2}-\d{2}$/);
  });

  it('lowercases and collapses spaces/special chars into hyphens', () => {
    const result = generateBranchName('  Weird  Case!!  ');
    // Should be lowercase, no leading/trailing hyphens from slug, with date suffix
    expect(result).toMatch(/^agent\/weird-case-\d{4}-\d{2}-\d{2}$/);
  });

  it('collapses multiple hyphens into one', () => {
    const result = generateBranchName('fix---multiple---hyphens');
    expect(result).toMatch(/^agent\/fix-multiple-hyphens-\d{4}-\d{2}-\d{2}$/);
  });

  it('strips leading and trailing hyphens from slug', () => {
    const result = generateBranchName('!leading and trailing!');
    expect(result).toMatch(/^agent\/leading-and-trailing-\d{4}-\d{2}-\d{2}$/);
  });

  it('uses agent/ prefix', () => {
    const result = generateBranchName('my task');
    expect(result).toStartWith('agent/');
  });

  it('appends today date in YYYY-MM-DD format', () => {
    const result = generateBranchName('my task');
    const today = new Date().toISOString().slice(0, 10);
    expect(result).toEndWith(today);
  });
});

// ============================================================
// buildPRBody
// ============================================================

describe('buildPRBody', () => {
  const baseOpts = {
    task: 'Update spring-boot to 3.2',
    finalResponse: 'Updated pom.xml to use spring-boot 3.2.',
    diffStat: '1 file changed, 2 insertions(+), 2 deletions(-)',
    verificationResults: [makePassedVerification()],
    judgeResults: [makeApproveResult()],
    breakingChangeWarnings: [] as string[],
  };

  it('contains all six required section headers', () => {
    const body = buildPRBody(baseOpts);
    expect(body).toContain('## Task');
    expect(body).toContain('## Changes');
    expect(body).toContain('## Verification');
    expect(body).toContain('## LLM Judge');
    expect(body).toContain('## Breaking Changes');
    expect(body).toContain('---');
  });

  it('contains the footer line', () => {
    const body = buildPRBody(baseOpts);
    expect(body).toContain('---');
    expect(body).toContain('Generated by background-coding-agent');
  });

  it('shows None detected when no breaking change warnings', () => {
    const body = buildPRBody({ ...baseOpts, breakingChangeWarnings: [] });
    expect(body).toContain('None detected');
  });

  it('shows warning text when breakingChangeWarnings is non-empty', () => {
    const body = buildPRBody({
      ...baseOpts,
      breakingChangeWarnings: ['Exported symbol removed'],
    });
    expect(body).toContain('Exported symbol removed');
    expect(body).not.toContain('None detected');
  });

  it('caps judge reasoning at 2000 chars with truncation marker', () => {
    const longReasoning = 'a'.repeat(2500);
    const body = buildPRBody({
      ...baseOpts,
      judgeResults: [{ ...makeApproveResult(), reasoning: longReasoning }],
    });
    expect(body).toContain('...(truncated)');
    // The long reasoning should be cut — check the body doesn't contain 2500 'a's
    const fullLongText = 'a'.repeat(2500);
    expect(body).not.toContain(fullLongText);
  });

  it('caps diffStat at 3000 chars with truncation marker', () => {
    const longDiffStat = 'a'.repeat(3500);
    const body = buildPRBody({ ...baseOpts, diffStat: longDiffStat });
    expect(body).toContain('...(truncated)');
    const fullLongText = 'a'.repeat(3500);
    expect(body).not.toContain(fullLongText);
  });

  it('shows verification pass badge for passing results', () => {
    const body = buildPRBody({ ...baseOpts, verificationResults: [makePassedVerification()] });
    expect(body).toContain('✅');
  });

  it('shows verification fail badge and details for failing results', () => {
    const body = buildPRBody({
      ...baseOpts,
      verificationResults: [makeFailedVerification('Build failed: missing class')],
    });
    expect(body).toContain('❌');
    expect(body).toContain('Build failed: missing class');
  });

  it('shows judge approve badge when verdict is APPROVE', () => {
    const body = buildPRBody({ ...baseOpts, judgeResults: [makeApproveResult()] });
    expect(body).toContain('✅ APPROVE');
  });

  it('shows judge veto badge when verdict is VETO', () => {
    const body = buildPRBody({
      ...baseOpts,
      judgeResults: [makeVetoResult()],
    });
    expect(body).toContain('❌ VETO');
  });

  it('shows Judge not run when judgeResults is undefined', () => {
    const body = buildPRBody({ ...baseOpts, judgeResults: undefined });
    expect(body).toContain('Judge not run');
  });

  it('shows Judge not run when judgeResults is empty array', () => {
    const body = buildPRBody({ ...baseOpts, judgeResults: [] });
    expect(body).toContain('Judge not run');
  });

  it('shows No verification results recorded when verificationResults is empty', () => {
    const body = buildPRBody({ ...baseOpts, verificationResults: [] });
    expect(body).toContain('No verification results recorded');
  });

  it('uses warning header when breaking changes exist', () => {
    const body = buildPRBody({
      ...baseOpts,
      breakingChangeWarnings: ['Exported symbol removed'],
    });
    expect(body).toContain('Potential Breaking Changes');
  });

  it('includes the task text verbatim', () => {
    const body = buildPRBody({ ...baseOpts, task: 'Update spring-boot to 3.2' });
    expect(body).toContain('Update spring-boot to 3.2');
  });

  it('includes the finalResponse text', () => {
    const body = buildPRBody({ ...baseOpts, finalResponse: 'Updated pom.xml to use spring-boot 3.2.' });
    expect(body).toContain('Updated pom.xml to use spring-boot 3.2.');
  });
});

// ============================================================
// detectBreakingChanges
// ============================================================

describe('detectBreakingChanges', () => {
  it('returns empty array for empty diff', () => {
    expect(detectBreakingChanges('')).toEqual([]);
  });

  it('returns empty array for diff with no breaking change signals', () => {
    const diff = `diff --git a/src/utils.ts b/src/utils.ts
index abc..def 100644
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -1,3 +1,3 @@
-const oldHelper = () => {};
+const newHelper = () => {};`;
    expect(detectBreakingChanges(diff)).toEqual([]);
  });

  it('detects BREAKING CHANGE keyword in diff', () => {
    const diff = 'BREAKING CHANGE: removed auth';
    const result = detectBreakingChanges(diff);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.some(w => w.toLowerCase().includes('breaking change'))).toBe(true);
  });

  it('detects removed exported function', () => {
    const diff = `-export function myFn() {}`;
    const result = detectBreakingChanges(diff);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.some(w => w.toLowerCase().includes('export'))).toBe(true);
  });

  it('detects removed exported class', () => {
    const diff = `-export class MyClass {}`;
    const result = detectBreakingChanges(diff);
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it('detects removed exported const', () => {
    const diff = `-export const MY_CONSTANT = 42;`;
    const result = detectBreakingChanges(diff);
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it('detects major version bump', () => {
    const diff = 'major version bump from 1.0.0 to 2.0.0';
    const result = detectBreakingChanges(diff);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.some(w => w.toLowerCase().includes('major version'))).toBe(true);
  });

  it('does not flag added exports as breaking', () => {
    const diff = `+export function newFn() {}`;
    expect(detectBreakingChanges(diff)).toEqual([]);
  });
});

// ============================================================
// GitHubPRCreator
// ============================================================

describe('GitHubPRCreator', () => {
  const originalToken = process.env.GITHUB_TOKEN;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GITHUB_TOKEN;
  });

  afterEach(() => {
    if (originalToken !== undefined) {
      process.env.GITHUB_TOKEN = originalToken;
    } else {
      delete process.env.GITHUB_TOKEN;
    }
  });

  it('throws descriptive error when GITHUB_TOKEN is not set', async () => {
    const creator = new GitHubPRCreator('/tmp/fake');
    await expect(
      creator.create({
        taskType: 'maven dependency update',
        originalTask: 'Update dependencies',
        retryResult: makeRetryResult(),
      })
    ).rejects.toThrow('GITHUB_TOKEN environment variable is required');
  });

  describe('with GITHUB_TOKEN set', () => {
    beforeEach(() => {
      process.env.GITHUB_TOKEN = 'test-token';
    });

    it('throws descriptive error when git remote cannot be parsed', async () => {
      // execFile returns a non-parseable remote URL
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, callback: (err: null, result: { stdout: string; stderr: string }) => void) => {
          callback(null, { stdout: 'not-a-github-url\n', stderr: '' });
        }
      );

      const creator = new GitHubPRCreator('/tmp/fake');
      await expect(
        creator.create({
          taskType: 'maven dependency update',
          originalTask: 'Update dependencies',
          retryResult: makeRetryResult(),
        })
      ).rejects.toThrow(/remote/i);
    });

    it('uses branchOverride when provided', async () => {
      // First call: git remote get-url origin -> returns HTTPS URL
      // Subsequent calls: git diff --stat, git diff full diff, git status
      let callCount = 0;
      mockExecFile.mockImplementation(
        (_cmd: string, args: string[], _opts: unknown, callback: (err: null, result: { stdout: string; stderr: string }) => void) => {
          callCount++;
          if (args.includes('get-url')) {
            callback(null, { stdout: 'https://github.com/owner/repo.git\n', stderr: '' });
          } else if (args.includes('--stat')) {
            callback(null, { stdout: '1 file changed', stderr: '' });
          } else {
            callback(null, { stdout: '', stderr: '' });
          }
        }
      );

      // simpleGit mocks
      mockStatus.mockResolvedValue({ isClean: () => true });
      mockCheckoutLocalBranch.mockResolvedValue(undefined);
      mockPush.mockResolvedValue(undefined);

      // octokit mocks
      mockReposGet.mockResolvedValue({ data: { default_branch: 'main' } });
      mockPullsList.mockResolvedValue({ data: [] });
      mockPullsCreate.mockResolvedValue({
        data: { html_url: 'https://github.com/owner/repo/pull/1' },
      });

      const creator = new GitHubPRCreator('/workspace');
      const result = await creator.create({
        taskType: 'maven dependency update',
        originalTask: 'Update deps',
        retryResult: makeRetryResult(),
        branchOverride: 'my-custom-branch',
      });

      expect(result.branch).toBe('my-custom-branch');
      expect(result.created).toBe(true);
      expect(result.url).toBe('https://github.com/owner/repo/pull/1');
      expect(callCount).toBeGreaterThan(0);
    });

    it('returns error result (not throws) on PR creation API failure', async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, args: string[], _opts: unknown, callback: (err: null, result: { stdout: string; stderr: string }) => void) => {
          if (args.includes('get-url')) {
            callback(null, { stdout: 'https://github.com/owner/repo.git\n', stderr: '' });
          } else {
            callback(null, { stdout: '', stderr: '' });
          }
        }
      );

      mockStatus.mockResolvedValue({ isClean: () => true });
      mockCheckoutLocalBranch.mockResolvedValue(undefined);
      mockPush.mockResolvedValue(undefined);
      mockReposGet.mockResolvedValue({ data: { default_branch: 'main' } });
      mockPullsList.mockResolvedValue({ data: [] });
      mockPullsCreate.mockRejectedValue(new Error('API rate limit exceeded'));

      const creator = new GitHubPRCreator('/workspace');
      const result = await creator.create({
        taskType: 'maven dependency update',
        originalTask: 'Update deps',
        retryResult: makeRetryResult(),
      });

      expect(result.error).toBeDefined();
      expect(result.error).toContain('API rate limit exceeded');
      expect(result.created).toBe(false);
    });

    it('returns existing PR when open PR already exists for branch', async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, args: string[], _opts: unknown, callback: (err: null, result: { stdout: string; stderr: string }) => void) => {
          if (args.includes('get-url')) {
            callback(null, { stdout: 'https://github.com/owner/repo.git\n', stderr: '' });
          } else {
            callback(null, { stdout: '', stderr: '' });
          }
        }
      );

      mockStatus.mockResolvedValue({ isClean: () => true });
      mockCheckoutLocalBranch.mockResolvedValue(undefined);
      mockPush.mockResolvedValue(undefined);
      mockReposGet.mockResolvedValue({ data: { default_branch: 'main' } });
      mockPullsList.mockResolvedValue({
        data: [{ html_url: 'https://github.com/owner/repo/pull/42' }],
      });

      const creator = new GitHubPRCreator('/workspace');
      const result = await creator.create({
        taskType: 'maven dependency update',
        originalTask: 'Update deps',
        retryResult: makeRetryResult(),
        branchOverride: 'my-custom-branch',
      });

      expect(result.created).toBe(false);
      expect(result.url).toBe('https://github.com/owner/repo/pull/42');
      expect(mockPullsCreate).not.toHaveBeenCalled();
    });

    it('parses SSH remote URL format correctly', async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, args: string[], _opts: unknown, callback: (err: null, result: { stdout: string; stderr: string }) => void) => {
          if (args.includes('get-url')) {
            callback(null, { stdout: 'git@github.com:myorg/myrepo.git\n', stderr: '' });
          } else {
            callback(null, { stdout: '', stderr: '' });
          }
        }
      );

      mockStatus.mockResolvedValue({ isClean: () => true });
      mockCheckoutLocalBranch.mockResolvedValue(undefined);
      mockPush.mockResolvedValue(undefined);
      mockReposGet.mockResolvedValue({ data: { default_branch: 'main' } });
      mockPullsList.mockResolvedValue({ data: [] });
      mockPullsCreate.mockResolvedValue({
        data: { html_url: 'https://github.com/myorg/myrepo/pull/1' },
      });

      const creator = new GitHubPRCreator('/workspace');
      const result = await creator.create({
        taskType: 'fix something',
        originalTask: 'Fix something',
        retryResult: makeRetryResult(),
        branchOverride: 'my-branch',
      });

      expect(result.url).toContain('myorg/myrepo');
      expect(result.created).toBe(true);
    });

    it('throws with branch name included when push is rejected (branch exists on remote)', async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, args: string[], _opts: unknown, callback: (err: null, result: { stdout: string; stderr: string }) => void) => {
          if (args.includes('get-url')) {
            callback(null, { stdout: 'https://github.com/owner/repo.git\n', stderr: '' });
          } else {
            callback(null, { stdout: '', stderr: '' });
          }
        }
      );

      mockStatus.mockResolvedValue({ isClean: () => true });
      mockCheckoutLocalBranch.mockResolvedValue(undefined);
      // Simulate push rejection
      mockPush.mockRejectedValue(new Error('rejected: already exists'));

      const creator = new GitHubPRCreator('/workspace');
      const result = await creator.create({
        taskType: 'maven dependency update',
        originalTask: 'Update deps',
        retryResult: makeRetryResult(),
        branchOverride: 'existing-branch',
      });

      // Should return error result with branch name information
      expect(result.error).toBeDefined();
      expect(result.error).toContain('existing-branch');
    });
  });
});
