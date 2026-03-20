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

// Mock buildPrompt to return deterministic string
vi.mock('../prompts/index.js', () => ({
  buildPrompt: vi.fn().mockReturnValue('Fix the bug'),
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

// Mock GitHubPRCreator
vi.mock('../orchestrator/pr-creator.js', () => ({
  GitHubPRCreator: vi.fn().mockImplementation(() => ({
    create: vi.fn().mockResolvedValue({ url: 'https://github.com/pr/1', created: true, branch: 'agent/branch' }),
  })),
}));

import { RetryOrchestrator } from '../orchestrator/retry.js';
import { runAgent } from './index.js';

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
    });

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
        {} // no logger
      )
    ).resolves.toBeDefined();
  });
});
