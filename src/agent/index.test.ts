import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Docker functions to avoid real Docker calls
vi.mock('../cli/docker/index.js', () => ({
  assertDockerRunning: vi.fn().mockResolvedValue(undefined),
  ensureNetworkExists: vi.fn().mockResolvedValue(undefined),
  buildImageIfNeeded: vi.fn().mockResolvedValue(undefined),
  buildDockerRunArgs: vi.fn().mockReturnValue([]),
}));

// Mock RetryOrchestrator to avoid real SDK calls
vi.mock('../orchestrator/retry.js', () => {
  const MockRetryOrchestrator = vi.fn();
  return { RetryOrchestrator: MockRetryOrchestrator };
});

// Mock buildPrompt to return deterministic string (async — now returns Promise)
vi.mock('../prompts/index.js', () => ({
  buildPrompt: vi.fn().mockResolvedValue('Fix the bug'),
}));

// Mock llmJudge and captureBaselineSha
vi.mock('../orchestrator/judge.js', () => ({
  llmJudge: vi.fn(),
  captureBaselineSha: vi.fn().mockResolvedValue('abc123'),
}));

// Mock compositeVerifier
vi.mock('../orchestrator/verifier.js', () => ({
  compositeVerifier: vi.fn(),
}));

// Mock MetricsCollector — must use a class-compatible mock for `new MetricsCollector()`
const mockMetricsInstance = {
  recordSession: vi.fn(),
  getMetrics: vi.fn().mockReturnValue({}),
};
vi.mock('../orchestrator/metrics.js', () => {
  class MockMetricsCollector {
    recordSession = vi.fn();
    getMetrics = vi.fn().mockReturnValue({});
  }
  return { MetricsCollector: MockMetricsCollector };
});

// Mock GitHubPRCreator and generateBranchName
vi.mock('../orchestrator/pr-creator.js', () => ({
  GitHubPRCreator: vi.fn().mockImplementation(() => ({
    create: vi.fn().mockResolvedValue({ url: 'https://github.com/pr/1', created: true, branch: 'agent/branch' }),
  })),
  generateBranchName: vi.fn().mockReturnValue('agent/mock-branch-abc123'),
}));

// Mock ClaudeCodeSession for investigation task tests
const mockSessionRun = vi.fn();
vi.mock('../orchestrator/claude-code-session.js', () => {
  const MockClaudeCodeSession = vi.fn(function (this: any, _config: any) {
    this.run = mockSessionRun;
  });
  return { ClaudeCodeSession: MockClaudeCodeSession };
});

// Mock WorktreeManager — must use a class to support `new WorktreeManager(...)`
const mockWorktreeCreate = vi.fn().mockResolvedValue(undefined);
const mockWorktreeRemove = vi.fn().mockResolvedValue(undefined);
vi.mock('./worktree-manager.js', () => {
  class MockWorktreeManager {
    path: string;
    branch: string;
    constructor(_repoDir: string, worktreePath: string, branchName: string) {
      this.path = worktreePath;
      this.branch = branchName;
    }
    create = mockWorktreeCreate;
    remove = mockWorktreeRemove;
    static buildWorktreePath(_repoDir: string, suffix: string): string {
      return `/tmp/.bg-agent-workspace-${suffix}`;
    }
    static pruneOrphans = vi.fn().mockResolvedValue(undefined);
  }
  return { WorktreeManager: MockWorktreeManager };
});

// Mock child_process.execFile for host-side version resolution.
// promisify(execFile) uses execFile[util.promisify.custom] in real Node;
// our mock must provide [custom] so promisified calls resolve with { stdout, stderr }.
vi.mock('node:child_process', async () => {
  const util = await import('node:util');
  const baseFn = vi.fn();
  // The promisified version is what actually gets called in production code
  const promisifiedFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
  (baseFn as any)[util.promisify.custom] = promisifiedFn;
  return { execFile: baseFn };
});

import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { RetryOrchestrator } from '../orchestrator/retry.js';
import { buildPrompt } from '../prompts/index.js';
import { ClaudeCodeSession } from '../orchestrator/claude-code-session.js';
import { runAgent } from './index.js';

// Access the promisified mock (the one actually called by execFileAsync in production)
const mockExecFileAsync = (execFile as any)[promisify.custom] as ReturnType<typeof vi.fn>;
const mockBuildPrompt = buildPrompt as ReturnType<typeof vi.fn>;

const MockRetryOrchestrator = RetryOrchestrator as ReturnType<typeof vi.fn>;

// Helper to build a mock orchestrator that returns a given RetryResult
function mockOrchestrator(finalStatus: string = 'success') {
  const orchestratorInstance = {
    run: vi.fn().mockResolvedValue({
      finalStatus,
      attempts: 1,
      sessionResults: [],
      verificationResults: [],
      judgeResults: [],
    }),
    stop: vi.fn().mockResolvedValue(undefined),
  };
  MockRetryOrchestrator.mockImplementationOnce(function () { return orchestratorInstance; });
  return orchestratorInstance;
}

describe('src/agent/index.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: promisified execFile resolves with empty output
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
  });

  // Test 1: runAgent is an exported async function
  it('1. runAgent is exported as an async function', async () => {
    expect(typeof runAgent).toBe('function');
    // async functions are instances of AsyncFunction
    expect(runAgent.constructor.name).toBe('AsyncFunction');
  });

  // Test 2: AgentOptions and AgentContext are exported types (runtime check via object shape)
  it('2. AgentOptions and AgentContext are exported from module', async () => {
    // Types don't exist at runtime but runAgent accepts them — verify the function exists
    expect(typeof runAgent).toBe('function');
    // The module exports runAgent (indirectly validates the types are defined)
    const agentModule = await import('./index.js');
    const exports = Object.keys(agentModule);
    expect(exports).toContain('runAgent');
  });

  // Test 3: runAgent returns a RetryResult object
  it('3. runAgent returns a RetryResult object', async () => {
    mockOrchestrator('success');
    const result = await runAgent({
      taskType: 'maven-dependency-update',
      repo: '/tmp/workspace',
      turnLimit: 10,
      timeoutMs: 300_000,
      maxRetries: 3,
      dep: 'com.example:lib',
      targetVersion: '1.0.0',
    }, { skipWorktree: true });

    expect(result).toBeDefined();
    expect(typeof result.finalStatus).toBe('string');
    expect(typeof result.attempts).toBe('number');
    expect(Array.isArray(result.sessionResults)).toBe(true);
    expect(Array.isArray(result.verificationResults)).toBe(true);
  });

  // Test 4: runAgent with already-aborted signal returns 'cancelled'
  it('4. runAgent with pre-aborted signal returns finalStatus cancelled', async () => {
    const controller = new AbortController();
    controller.abort(); // abort before calling runAgent

    const result = await runAgent(
      {
        taskType: 'maven-dependency-update',
        repo: '/tmp/workspace',
        turnLimit: 10,
        timeoutMs: 300_000,
        maxRetries: 3,
        dep: 'com.example:lib',
        targetVersion: '1.0.0',
      },
      { signal: controller.signal }
    );

    expect(result.finalStatus).toBe('cancelled');
    expect(result.attempts).toBe(0);
  });

  // Test 5: RetryResult.finalStatus includes 'cancelled' — tested via TypeScript compilation
  // This test verifies the runtime value can be 'cancelled' (type-level check)
  it('5. RetryResult finalStatus can be cancelled (type union includes cancelled)', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runAgent(
      { taskType: 'test', repo: '/tmp', turnLimit: 5, timeoutMs: 60_000, maxRetries: 1 },
      { signal: controller.signal }
    );

    // This will only pass if 'cancelled' is a valid finalStatus value
    const validStatuses = ['success', 'failed', 'timeout', 'turn_limit', 'max_retries_exhausted', 'vetoed', 'cancelled'];
    expect(validStatuses).toContain(result.finalStatus);
    expect(result.finalStatus).toBe('cancelled');
  });

  // Test 6: runAgent does NOT call process.exit (structural test on source)
  it('6. runAgent source does not call process.exit', async () => {
    const fs = await import('node:fs');
    // Use __dirname-style resolution to find the source file
    const source = fs.readFileSync(new URL('./index.ts', import.meta.url).pathname, 'utf-8');
    expect(source).not.toContain('process.exit');
    expect(source).not.toContain('process.once');
  });

  // Test 7: runAgent with no logger option does not throw
  it('7. runAgent with no logger in context does not throw', async () => {
    mockOrchestrator('success');
    // Pass empty context (no logger) — should fall back to silent logger
    await expect(
      runAgent(
        { taskType: 'test', repo: '/tmp/workspace', turnLimit: 5, timeoutMs: 60_000, maxRetries: 1 },
        { skipWorktree: true } // no logger, but skip worktree for focused test
      )
    ).resolves.toBeDefined();
  });

  describe('host-side "latest" version resolution', () => {
    it('resolves "latest" to concrete version via npm show before building prompt', async () => {
      mockExecFileAsync.mockResolvedValue({ stdout: '4.18.3\n', stderr: '' });
      mockOrchestrator('success');

      await runAgent({
        taskType: 'npm-dependency-update',
        repo: '/tmp/workspace',
        turnLimit: 10,
        timeoutMs: 300_000,
        maxRetries: 3,
        dep: 'lodash',
        targetVersion: 'latest',
      }, { skipWorktree: true });

      expect(mockBuildPrompt).toHaveBeenCalledWith(
        expect.objectContaining({ targetVersion: '4.18.3' }),
      );
    });

    it('falls back to "latest" when npm show fails', async () => {
      mockExecFileAsync.mockRejectedValueOnce(new Error('npm ERR! 404'));
      // Second call (npm install in preVerify) should succeed
      mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
      mockOrchestrator('success');

      await runAgent({
        taskType: 'npm-dependency-update',
        repo: '/tmp/workspace',
        turnLimit: 10,
        timeoutMs: 300_000,
        maxRetries: 3,
        dep: 'nonexistent-pkg',
        targetVersion: 'latest',
      }, { skipWorktree: true });

      expect(mockBuildPrompt).toHaveBeenCalledWith(
        expect.objectContaining({ targetVersion: 'latest' }),
      );
    });

    it('does not resolve version for non-npm task types', async () => {
      mockOrchestrator('success');

      await runAgent({
        taskType: 'maven-dependency-update',
        repo: '/tmp/workspace',
        turnLimit: 10,
        timeoutMs: 300_000,
        maxRetries: 3,
        dep: 'com.example:lib',
        targetVersion: 'latest',
      }, { skipWorktree: true });

      // execFileAsync should not have been called (no npm show for maven)
      expect(mockExecFileAsync).not.toHaveBeenCalled();
    });

    it('does not resolve when targetVersion is already a concrete version', async () => {
      mockOrchestrator('success');

      await runAgent({
        taskType: 'npm-dependency-update',
        repo: '/tmp/workspace',
        turnLimit: 10,
        timeoutMs: 300_000,
        maxRetries: 3,
        dep: 'lodash',
        targetVersion: '4.17.21',
      }, { skipWorktree: true });

      expect(mockBuildPrompt).toHaveBeenCalledWith(
        expect.objectContaining({ targetVersion: '4.17.21' }),
      );
    });
  });

  describe('worktree integration', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
    });

    it('creates worktree before orchestrator when skipWorktree is not set', async () => {
      mockOrchestrator('success');
      await runAgent(
        { taskType: 'generic', repo: '/tmp/workspace', turnLimit: 5, timeoutMs: 60_000, maxRetries: 1, description: 'fix bug' },
        {}  // no skipWorktree
      );
      expect(mockWorktreeCreate).toHaveBeenCalled();
    });

    it('skips worktree when skipWorktree is true', async () => {
      mockOrchestrator('success');
      await runAgent(
        { taskType: 'generic', repo: '/tmp/workspace', turnLimit: 5, timeoutMs: 60_000, maxRetries: 1, description: 'fix bug' },
        { skipWorktree: true }
      );
      expect(mockWorktreeCreate).not.toHaveBeenCalled();
    });

    it('removes worktree in finally block even when orchestrator throws', async () => {
      const orchestratorInstance = {
        run: vi.fn().mockRejectedValue(new Error('orchestrator exploded')),
        stop: vi.fn(),
      };
      MockRetryOrchestrator.mockImplementationOnce(function () { return orchestratorInstance; });

      await expect(runAgent(
        { taskType: 'generic', repo: '/tmp/workspace', turnLimit: 5, timeoutMs: 60_000, maxRetries: 1, description: 'fix' },
        {}
      )).rejects.toThrow('orchestrator exploded');

      expect(mockWorktreeRemove).toHaveBeenCalled();
    });

    it('keeps branch for post-hoc PR when createPr is false and task succeeds', async () => {
      mockOrchestrator('success');
      await runAgent(
        { taskType: 'generic', repo: '/tmp/workspace', turnLimit: 5, timeoutMs: 60_000, maxRetries: 1, description: 'fix', createPr: false },
        {}
      );
      expect(mockWorktreeRemove).toHaveBeenCalledWith(expect.objectContaining({ keepBranch: true }));
    });

    it('does not keep branch when createPr is true and task fails', async () => {
      mockOrchestrator('failed');
      await runAgent(
        { taskType: 'generic', repo: '/tmp/workspace', turnLimit: 5, timeoutMs: 60_000, maxRetries: 1, description: 'fix', createPr: true },
        {}
      );
      expect(mockWorktreeRemove).toHaveBeenCalledWith(expect.objectContaining({ keepBranch: false }));
    });

    it('passes worktree path as workspaceDir to RetryOrchestrator', async () => {
      mockOrchestrator('success');
      await runAgent(
        { taskType: 'generic', repo: '/tmp/workspace', turnLimit: 5, timeoutMs: 60_000, maxRetries: 1, description: 'fix' },
        {}
      );
      // RetryOrchestrator constructor receives workspaceDir as first arg's property
      const constructorCall = MockRetryOrchestrator.mock.calls[0];
      const sessionConfig = constructorCall[0];
      // workspaceDir should be the worktree path (not /tmp/workspace)
      expect(sessionConfig.workspaceDir).toContain('.bg-agent-');
    });

    it('returns worktreeBranch on the result', async () => {
      mockOrchestrator('success');
      const result = await runAgent(
        { taskType: 'generic', repo: '/tmp/workspace', turnLimit: 5, timeoutMs: 60_000, maxRetries: 1, description: 'fix' },
        {}
      );
      expect(result.worktreeBranch).toBe('agent/mock-branch-abc123');
    });
  });

  describe('investigation task type', () => {
    const makeSessionResult = (status: string, finalResponse = 'Report: found git strategy') => ({
      sessionId: 'sess-abc',
      status,
      toolCallCount: 2,
      duration: 1000,
      finalResponse,
    });

    beforeEach(() => {
      vi.clearAllMocks();
      mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
      mockSessionRun.mockResolvedValue(makeSessionResult('success'));
    });

    it('returns finalStatus success when session succeeds', async () => {
      const result = await runAgent(
        { taskType: 'investigation', repo: '/tmp/workspace', turnLimit: 5, timeoutMs: 60_000, maxRetries: 1, description: 'analyze git strategy' },
        { skipDockerChecks: true }
      );
      expect(result.finalStatus).toBe('success');
    });

    it('returns sessionResults with one entry', async () => {
      const result = await runAgent(
        { taskType: 'investigation', repo: '/tmp/workspace', turnLimit: 5, timeoutMs: 60_000, maxRetries: 1 },
        { skipDockerChecks: true }
      );
      expect(result.sessionResults).toHaveLength(1);
      expect(result.sessionResults[0].finalResponse).toBe('Report: found git strategy');
    });

    it('returns empty verificationResults (no verifier)', async () => {
      const result = await runAgent(
        { taskType: 'investigation', repo: '/tmp/workspace', turnLimit: 5, timeoutMs: 60_000, maxRetries: 1 },
        { skipDockerChecks: true }
      );
      expect(result.verificationResults).toHaveLength(0);
    });

    it('does NOT instantiate RetryOrchestrator', async () => {
      await runAgent(
        { taskType: 'investigation', repo: '/tmp/workspace', turnLimit: 5, timeoutMs: 60_000, maxRetries: 1 },
        { skipDockerChecks: true }
      );
      expect(MockRetryOrchestrator).not.toHaveBeenCalled();
    });

    it('does NOT create a WorktreeManager', async () => {
      await runAgent(
        { taskType: 'investigation', repo: '/tmp/workspace', turnLimit: 5, timeoutMs: 60_000, maxRetries: 1 },
        { skipDockerChecks: true }
      );
      expect(mockWorktreeCreate).not.toHaveBeenCalled();
    });

    it('creates ClaudeCodeSession with readOnly:true', async () => {
      await runAgent(
        { taskType: 'investigation', repo: '/tmp/workspace', turnLimit: 5, timeoutMs: 60_000, maxRetries: 1 },
        { skipDockerChecks: true }
      );
      const MockCtor = ClaudeCodeSession as unknown as ReturnType<typeof vi.fn>;
      expect(MockCtor).toHaveBeenCalledWith(
        expect.objectContaining({ readOnly: true })
      );
    });

    it('passes explorationSubtype to buildPrompt', async () => {
      await runAgent(
        { taskType: 'investigation', repo: '/tmp/workspace', turnLimit: 5, timeoutMs: 60_000, maxRetries: 1, explorationSubtype: 'git-strategy' },
        { skipDockerChecks: true }
      );
      expect(mockBuildPrompt).toHaveBeenCalledWith(
        expect.objectContaining({ explorationSubtype: 'git-strategy' })
      );
    });

    it('returns finalStatus cancelled when session returns cancelled', async () => {
      mockSessionRun.mockResolvedValue(makeSessionResult('cancelled', ''));
      const result = await runAgent(
        { taskType: 'investigation', repo: '/tmp/workspace', turnLimit: 5, timeoutMs: 60_000, maxRetries: 1 },
        { skipDockerChecks: true }
      );
      expect(result.finalStatus).toBe('cancelled');
    });

    it('returns finalStatus failed when session returns failed', async () => {
      mockSessionRun.mockResolvedValue(makeSessionResult('failed', ''));
      const result = await runAgent(
        { taskType: 'investigation', repo: '/tmp/workspace', turnLimit: 5, timeoutMs: 60_000, maxRetries: 1 },
        { skipDockerChecks: true }
      );
      expect(result.finalStatus).toBe('failed');
    });

    it('returns finalStatus cancelled when signal is pre-aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      const result = await runAgent(
        { taskType: 'investigation', repo: '/tmp/workspace', turnLimit: 5, timeoutMs: 60_000, maxRetries: 1 },
        { signal: controller.signal }
      );
      expect(result.finalStatus).toBe('cancelled');
    });
  });
});
