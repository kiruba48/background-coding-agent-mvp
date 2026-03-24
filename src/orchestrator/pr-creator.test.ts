import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Use vi.hoisted to declare mocks before the hoisted vi.mock factories run.
const {
  mockPush,
  mockCheckoutLocalBranch,
  mockCheckout,
  mockStatus,
  mockAdd,
  mockCommit,
  mockRemote,
  mockDiff,
  mockRevparse,
  mockRaw,
  mockPullsCreate,
  mockPullsList,
  mockReposGet,
} = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockCheckoutLocalBranch: vi.fn(),
  mockCheckout: vi.fn(),
  mockStatus: vi.fn(),
  mockAdd: vi.fn(),
  mockCommit: vi.fn(),
  mockRemote: vi.fn(),
  mockDiff: vi.fn(),
  mockRevparse: vi.fn(),
  mockRaw: vi.fn(),
  mockPullsCreate: vi.fn(),
  mockPullsList: vi.fn(),
  mockReposGet: vi.fn(),
}));

vi.mock('simple-git', () => ({
  simpleGit: vi.fn().mockReturnValue({
    push: mockPush,
    checkoutLocalBranch: mockCheckoutLocalBranch,
    checkout: mockCheckout,
    status: mockStatus,
    add: mockAdd,
    commit: mockCommit,
    remote: mockRemote,
    diff: mockDiff,
    revparse: mockRevparse,
    raw: mockRaw,
  }),
}));

vi.mock('octokit', () => {
  const MockOctokit = function(this: Record<string, unknown>) {
    this.rest = {
      pulls: { create: mockPullsCreate, list: mockPullsList },
      repos: { get: mockReposGet },
    };
  };
  return { Octokit: MockOctokit };
});

import {
  generateBranchName,
  buildPRBody,
  detectBreakingChanges,
  GitHubPRCreator,
} from './pr-creator.js';
import type { RetryResult, VerificationResult, JudgeResult } from '../types.js';

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

/**
 * Set up standard mocks for GitHubPRCreator tests.
 * Configures git operations (remote, revparse, merge-base, diff, status, checkout, push)
 * and Octokit operations (repos.get, pulls.list, pulls.create).
 */
function setupStandardMocks(overrides: {
  remoteUrl?: string;
  originalBranch?: string;
  finalBranch?: string;
  diffStat?: string;
  fullDiff?: string;
  isClean?: boolean;
} = {}): void {
  const {
    remoteUrl = 'https://github.com/owner/repo.git',
    originalBranch = 'main',
    finalBranch,
    diffStat = '1 file changed',
    fullDiff = '',
    isClean = true,
  } = overrides;

  mockRemote.mockResolvedValue(remoteUrl);

  // revparse: called for original branch, then in finally for current branch
  mockRevparse
    .mockResolvedValueOnce(originalBranch)
    .mockResolvedValueOnce(finalBranch ?? originalBranch);

  // merge-base: reject so it falls back to HEAD~1
  mockRaw.mockRejectedValue(new Error('not a valid ref'));

  // diff: called twice — once for stat, once for full diff
  mockDiff
    .mockResolvedValueOnce(diffStat)
    .mockResolvedValueOnce(fullDiff);

  mockStatus.mockResolvedValue({ isClean: () => isClean });
  mockCheckoutLocalBranch.mockResolvedValue(undefined);
  mockPush.mockResolvedValue(undefined);

  mockReposGet.mockResolvedValue({ data: { default_branch: 'main' } });
  mockPullsList.mockResolvedValue({ data: [] });
  mockPullsCreate.mockResolvedValue({
    data: { html_url: 'https://github.com/owner/repo/pull/1' },
  });
}

// ============================================================
// generateBranchName
// ============================================================

describe('generateBranchName', () => {
  it('converts task type to slugified branch name with date and hex suffix', () => {
    const result = generateBranchName('maven dependency update');
    expect(result).toMatch(/^agent\/maven-dependency-update-\d{4}-\d{2}-\d{2}-[a-f0-9]{6}$/);
  });

  it('lowercases and collapses spaces/special chars into hyphens', () => {
    const result = generateBranchName('  Weird  Case!!  ');
    expect(result).toMatch(/^agent\/weird-case-\d{4}-\d{2}-\d{2}-[a-f0-9]{6}$/);
  });

  it('collapses multiple hyphens into one', () => {
    const result = generateBranchName('fix---multiple---hyphens');
    expect(result).toMatch(/^agent\/fix-multiple-hyphens-\d{4}-\d{2}-\d{2}-[a-f0-9]{6}$/);
  });

  it('strips leading and trailing hyphens from slug', () => {
    const result = generateBranchName('!leading and trailing!');
    expect(result).toMatch(/^agent\/leading-and-trailing-\d{4}-\d{2}-\d{2}-[a-f0-9]{6}$/);
  });

  it('uses agent/ prefix', () => {
    const result = generateBranchName('my task');
    expect(result.startsWith('agent/')).toBe(true);
  });

  it('includes today date in YYYY-MM-DD format', () => {
    const result = generateBranchName('my task');
    const today = new Date().toISOString().slice(0, 10);
    expect(result).toContain(today);
  });

  it('generates unique names on successive calls (random hex suffix)', () => {
    const a = generateBranchName('same task');
    const b = generateBranchName('same task');
    expect(a).not.toBe(b);
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
      breakingChangeWarnings: ['Exported symbol removed: myFn'],
    });
    expect(body).toContain('Exported symbol removed: myFn');
    expect(body).not.toContain('None detected');
  });

  it('caps judge reasoning at 2000 chars with truncation marker', () => {
    const longReasoning = 'a'.repeat(2500);
    const body = buildPRBody({
      ...baseOpts,
      judgeResults: [{ ...makeApproveResult(), reasoning: longReasoning }],
    });
    expect(body).toContain('...(truncated)');
    expect(body).not.toContain('a'.repeat(2500));
  });

  it('caps diffStat at 3000 chars with truncation marker', () => {
    const longDiffStat = 'a'.repeat(3500);
    const body = buildPRBody({ ...baseOpts, diffStat: longDiffStat });
    expect(body).toContain('...(truncated)');
    expect(body).not.toContain('a'.repeat(3500));
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
      breakingChangeWarnings: ['Exported symbol removed: myFn'],
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

  it('does not flag renamed exports (removed then re-added with same name)', () => {
    const diff = `-export function myFn() { return 1; }
+export function myFn() { return 2; }`;
    expect(detectBreakingChanges(diff)).toEqual([]);
  });

  it('flags export removal when symbol is not re-added', () => {
    const diff = `-export function oldFn() {}
+function internalFn() {}`;
    const result = detectBreakingChanges(diff);
    expect(result.some(w => w.includes('oldFn'))).toBe(true);
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
      mockRemote.mockResolvedValue('not-a-github-url');
      mockRevparse.mockResolvedValue('main');

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
      setupStandardMocks();

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
    });

    it('returns error result (not throws) on PR creation API failure', async () => {
      setupStandardMocks();
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
      setupStandardMocks();
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
      setupStandardMocks({ remoteUrl: 'git@github.com:myorg/myrepo.git' });
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

    it('returns error with branch name when push is rejected (branch exists on remote)', async () => {
      setupStandardMocks();
      mockPush.mockRejectedValue(new Error('rejected: already exists'));

      const creator = new GitHubPRCreator('/workspace');
      const result = await creator.create({
        taskType: 'maven dependency update',
        originalTask: 'Update deps',
        retryResult: makeRetryResult(),
        branchOverride: 'existing-branch',
      });

      expect(result.error).toBeDefined();
      expect(result.error).toContain('existing-branch');
    });

    it('sanitizes GITHUB_TOKEN from error messages (#1)', async () => {
      setupStandardMocks();
      mockPush.mockRejectedValue(new Error(
        'fatal: unable to access https://x-access-token:test-token@github.com/owner/repo.git'
      ));

      const creator = new GitHubPRCreator('/workspace');
      const result = await creator.create({
        taskType: 'test',
        originalTask: 'Test',
        retryResult: makeRetryResult(),
      });

      expect(result.error).toBeDefined();
      expect(result.error).not.toContain('test-token');
      expect(result.error).toContain('***');
    });

    it('restores original branch after successful push (#2)', async () => {
      // originalBranch = 'main', after checkout we're on agent branch
      setupStandardMocks({ finalBranch: 'agent/some-branch' });

      const creator = new GitHubPRCreator('/workspace');
      await creator.create({
        taskType: 'test',
        originalTask: 'Test',
        retryResult: makeRetryResult(),
      });

      // The last checkout call should be restoring 'main'
      const checkoutCalls = mockCheckout.mock.calls;
      expect(checkoutCalls[checkoutCalls.length - 1][0]).toBe('main');
    });

    it('restores original branch even on failure (#2)', async () => {
      setupStandardMocks({ finalBranch: 'agent/some-branch' });
      mockPush.mockRejectedValue(new Error('push failed'));

      const creator = new GitHubPRCreator('/workspace');
      await creator.create({
        taskType: 'test',
        originalTask: 'Test',
        retryResult: makeRetryResult(),
      });

      const checkoutCalls = mockCheckout.mock.calls;
      expect(checkoutCalls[checkoutCalls.length - 1][0]).toBe('main');
    });

    it('stages only tracked files with git add -u (#2)', async () => {
      setupStandardMocks({ isClean: false });

      const creator = new GitHubPRCreator('/workspace');
      await creator.create({
        taskType: 'test',
        originalTask: 'Test',
        retryResult: makeRetryResult(),
      });

      expect(mockAdd).toHaveBeenCalledWith('-u');
    });

    it('returns error when sessionResults is empty (#10)', async () => {
      setupStandardMocks();

      const creator = new GitHubPRCreator('/workspace');
      const result = await creator.create({
        taskType: 'test',
        originalTask: 'Test',
        retryResult: makeRetryResult({ sessionResults: [] }),
      });

      expect(result.error).toContain('No session results');
    });

    it('handles checkoutLocalBranch "already exists" error gracefully (#5)', async () => {
      setupStandardMocks();
      mockCheckoutLocalBranch.mockRejectedValue(new Error('A branch named \'x\' already exists'));

      const creator = new GitHubPRCreator('/workspace');
      const result = await creator.create({
        taskType: 'test',
        originalTask: 'Test',
        retryResult: makeRetryResult(),
        branchOverride: 'existing-local-branch',
      });

      // Should fall through to checkout and succeed
      expect(result.created).toBe(true);
      expect(mockCheckout).toHaveBeenCalled();
    });

    it('throws on checkoutLocalBranch non-exists error (#5)', async () => {
      setupStandardMocks();
      mockCheckoutLocalBranch.mockRejectedValue(new Error('permission denied'));

      const creator = new GitHubPRCreator('/workspace');
      const result = await creator.create({
        taskType: 'test',
        originalTask: 'Test',
        retryResult: makeRetryResult(),
        branchOverride: 'my-branch',
      });

      expect(result.error).toContain('Failed to create branch');
    });

    // --- Generic task PR tests ---

    it('branch name for generic task includes description-derived slug (not just "generic")', async () => {
      setupStandardMocks();

      const creator = new GitHubPRCreator('/workspace');
      await creator.create({
        taskType: 'generic',
        originalTask: 'replace axios with fetch',
        retryResult: makeRetryResult(),
        description: 'replace axios with fetch',
        taskCategory: 'code-change',
      });

      const pushCalls = mockPush.mock.calls;
      const branchArg: string = pushCalls[0][1]; // HEAD:refs/heads/<branch>
      expect(branchArg).toContain('code-change');
      expect(branchArg).not.toMatch(/^HEAD:refs\/heads\/agent\/generic-\d/);
    });

    it('PR title for generic task uses description text (not "Agent: generic YYYY-MM-DD")', async () => {
      setupStandardMocks();

      const creator = new GitHubPRCreator('/workspace');
      await creator.create({
        taskType: 'generic',
        originalTask: 'replace axios with fetch',
        retryResult: makeRetryResult(),
        description: 'replace axios with fetch',
        taskCategory: 'code-change',
      });

      const createCall = mockPullsCreate.mock.calls[0][0];
      expect(createCall.title).toBe('replace axios with fetch');
      expect(createCall.title).not.toMatch(/^Agent:/);
    });

    it('PR title for generic task truncates at 72 chars with ellipsis', async () => {
      setupStandardMocks();
      const longDescription = 'a'.repeat(80);

      const creator = new GitHubPRCreator('/workspace');
      await creator.create({
        taskType: 'generic',
        originalTask: longDescription,
        retryResult: makeRetryResult(),
        description: longDescription,
        taskCategory: 'code-change',
      });

      const createCall = mockPullsCreate.mock.calls[0][0];
      expect(createCall.title).toBe('a'.repeat(72) + '...');
    });

    it('non-generic tasks still use existing title format "Agent: {taskType} YYYY-MM-DD"', async () => {
      setupStandardMocks();

      const creator = new GitHubPRCreator('/workspace');
      await creator.create({
        taskType: 'npm-dependency-update',
        originalTask: 'Update recharts to latest',
        retryResult: makeRetryResult(),
      });

      const createCall = mockPullsCreate.mock.calls[0][0];
      expect(createCall.title).toMatch(/^Agent: npm-dependency-update \d{4}-\d{2}-\d{2}$/);
    });

    it('PR body for generic task includes instruction text (description)', async () => {
      setupStandardMocks();

      const creator = new GitHubPRCreator('/workspace');
      await creator.create({
        taskType: 'generic',
        originalTask: 'replace axios with fetch',
        retryResult: makeRetryResult(),
        description: 'replace axios with fetch',
        taskCategory: 'code-change',
      });

      const createCall = mockPullsCreate.mock.calls[0][0];
      expect(createCall.body).toContain('replace axios with fetch');
    });

    it('PR body for generic task includes taskCategory label', async () => {
      setupStandardMocks();

      const creator = new GitHubPRCreator('/workspace');
      await creator.create({
        taskType: 'generic',
        originalTask: 'replace axios with fetch',
        retryResult: makeRetryResult(),
        description: 'replace axios with fetch',
        taskCategory: 'code-change',
      });

      const createCall = mockPullsCreate.mock.calls[0][0];
      expect(createCall.body).toContain('code-change');
    });

    it('PR body for non-generic tasks does not contain Task category/Instruction sections', async () => {
      setupStandardMocks();

      const creator = new GitHubPRCreator('/workspace');
      await creator.create({
        taskType: 'npm-dependency-update',
        originalTask: 'Update recharts',
        retryResult: makeRetryResult(),
      });

      const createCall = mockPullsCreate.mock.calls[0][0];
      expect(createCall.body).not.toContain('**Task category:**');
      expect(createCall.body).not.toContain('**Instruction:**');
    });
  });
});
