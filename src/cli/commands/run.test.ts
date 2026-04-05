import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mapStatusToExitCode, runCommand } from './run.js';
import type { RetryResult } from '../../types.js';

// Mock runAgent so tests don't invoke real Docker/Claude
vi.mock('../../agent/index.js', () => ({
  runAgent: vi.fn(),
}));

// Mock createLogger so we don't emit real log output
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  }),
}));

import { runAgent } from '../../agent/index.js';

const mockRunAgent = runAgent as ReturnType<typeof vi.fn>;

/**
 * Build a minimal RetryResult for testing exit code mapping.
 */
function makeResult(finalStatus: RetryResult['finalStatus']): RetryResult {
  return {
    finalStatus,
    attempts: 1,
    sessionResults: [],
    verificationResults: [],
  };
}

describe('mapStatusToExitCode', () => {
  it('maps success to 0', () => {
    expect(mapStatusToExitCode('success')).toBe(0);
  });

  it('maps timeout to 124', () => {
    expect(mapStatusToExitCode('timeout')).toBe(124);
  });

  it('maps cancelled to 130', () => {
    expect(mapStatusToExitCode('cancelled')).toBe(130);
  });

  it('maps failed to 1', () => {
    expect(mapStatusToExitCode('failed')).toBe(1);
  });

  it('maps max_retries_exhausted to 1', () => {
    expect(mapStatusToExitCode('max_retries_exhausted')).toBe(1);
  });

  it('maps vetoed to 2 (task rejected by LLM Judge)', () => {
    expect(mapStatusToExitCode('vetoed')).toBe(2);
  });

  it('maps turn_limit to 3 (agent exceeded max turns)', () => {
    expect(mapStatusToExitCode('turn_limit')).toBe(3);
  });

  it('maps zero_diff to 0 (agent completed cleanly with no changes)', () => {
    expect(mapStatusToExitCode('zero_diff')).toBe(0);
  });
});

describe('runCommand', () => {
  const baseOptions = {
    taskType: 'maven-dependency-update',
    repo: '/tmp/test-repo',
    turnLimit: 10,
    timeout: 300,   // seconds
    maxRetries: 3,
  };

  beforeEach(() => {
    mockRunAgent.mockReset();
  });

  it('returns 0 on success', async () => {
    mockRunAgent.mockResolvedValue(makeResult('success'));
    const exitCode = await runCommand(baseOptions);
    expect(exitCode).toBe(0);
  });

  it('returns 124 on timeout', async () => {
    mockRunAgent.mockResolvedValue(makeResult('timeout'));
    const exitCode = await runCommand(baseOptions);
    expect(exitCode).toBe(124);
  });

  it('returns 130 on cancelled', async () => {
    mockRunAgent.mockResolvedValue(makeResult('cancelled'));
    const exitCode = await runCommand(baseOptions);
    expect(exitCode).toBe(130);
  });

  it('returns 1 on failed', async () => {
    mockRunAgent.mockResolvedValue(makeResult('failed'));
    const exitCode = await runCommand(baseOptions);
    expect(exitCode).toBe(1);
  });

  it('returns 1 on max_retries_exhausted', async () => {
    mockRunAgent.mockResolvedValue(makeResult('max_retries_exhausted'));
    const exitCode = await runCommand(baseOptions);
    expect(exitCode).toBe(1);
  });

  it('returns 1 on unexpected error from runAgent', async () => {
    mockRunAgent.mockRejectedValue(new Error('Docker not running'));
    const exitCode = await runCommand(baseOptions);
    expect(exitCode).toBe(1);
  });

  it('passes AbortSignal through to runAgent', async () => {
    mockRunAgent.mockResolvedValue(makeResult('success'));
    const abortController = new AbortController();
    await runCommand(baseOptions, abortController.signal);

    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({ taskType: 'maven-dependency-update' }),
      expect.objectContaining({ signal: abortController.signal })
    );
  });

  it('converts timeout seconds to milliseconds in agentOptions', async () => {
    mockRunAgent.mockResolvedValue(makeResult('success'));
    await runCommand({ ...baseOptions, timeout: 120 });

    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 120_000 }),
      expect.anything()
    );
  });

  it('returns 2 when runAgent returns vetoed', async () => {
    mockRunAgent.mockResolvedValue(makeResult('vetoed'));
    const exitCode = await runCommand(baseOptions);
    expect(exitCode).toBe(2);
  });

  it('returns 3 when runAgent returns turn_limit', async () => {
    mockRunAgent.mockResolvedValue(makeResult('turn_limit'));
    const exitCode = await runCommand(baseOptions);
    expect(exitCode).toBe(3);
  });
});
