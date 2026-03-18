import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createVerifierMcpServer, formatVerifyDigest } from './verifier-server.js';
import type { VerificationResult } from '../types.js';

vi.mock('../orchestrator/verifier.js', () => ({
  compositeVerifier: vi.fn(),
}));

import { compositeVerifier } from '../orchestrator/verifier.js';
const mockCompositeVerifier = compositeVerifier as ReturnType<typeof vi.fn>;

describe('createVerifierMcpServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns object with type: sdk', () => {
    const server = createVerifierMcpServer('/tmp/workspace');
    expect(server.type).toBe('sdk');
  });

  it('returns object with name: verifier', () => {
    const server = createVerifierMcpServer('/tmp/workspace');
    expect(server.name).toBe('verifier');
  });

  it('returns object with a truthy instance property', () => {
    const server = createVerifierMcpServer('/tmp/workspace');
    expect(server.instance).toBeTruthy();
  });
});

describe('formatVerifyDigest', () => {
  it('formats PASSED result with all PASS indicators', () => {
    const result: VerificationResult = {
      passed: true,
      errors: [],
      durationMs: 100,
    };
    const text = formatVerifyDigest(result);
    expect(text).toBe('Verification PASSED: Build: PASS, Test: PASS, Lint: PASS');
  });

  it('formats FAILED result with build error — contains Build: FAIL, Test: PASS, Lint: PASS', () => {
    const result: VerificationResult = {
      passed: false,
      errors: [
        {
          type: 'build',
          summary: '3 build error(s):\nsrc/foo.ts(10,5): error TS2345',
          rawOutput: 'long raw output...',
        },
      ],
      durationMs: 500,
    };
    const text = formatVerifyDigest(result);
    expect(text).toContain('Verification FAILED:');
    expect(text).toContain('Build: FAIL');
    expect(text).toContain('Test: PASS');
    expect(text).toContain('Lint: PASS');
    expect(text).toContain('[BUILD] 3 build error(s)');
    expect(text).not.toContain('long raw output');
  });

  it('formats FAILED result with test and lint errors — contains correct PASS/FAIL breakdown', () => {
    const result: VerificationResult = {
      passed: false,
      errors: [
        { type: 'test', summary: 'Tests: 2 failed', rawOutput: '...' },
        { type: 'lint', summary: '1 lint error', rawOutput: '...' },
      ],
      durationMs: 300,
    };
    const text = formatVerifyDigest(result);
    expect(text).toContain('Test: FAIL');
    expect(text).toContain('Lint: FAIL');
    expect(text).toContain('Build: PASS');
    expect(text).toContain('[TEST] Tests: 2 failed');
    expect(text).toContain('[LINT] 1 lint error');
  });

  it('does not include rawOutput in digest', () => {
    const result: VerificationResult = {
      passed: false,
      errors: [
        { type: 'build', summary: 'Build failed', rawOutput: 'VERY LONG RAW OUTPUT SHOULD NOT APPEAR' },
      ],
      durationMs: 200,
    };
    const text = formatVerifyDigest(result);
    expect(text).not.toContain('VERY LONG RAW OUTPUT SHOULD NOT APPEAR');
  });

  it('does not include durationMs in digest', () => {
    const result: VerificationResult = {
      passed: true,
      errors: [],
      durationMs: 99999,
    };
    const text = formatVerifyDigest(result);
    expect(text).not.toContain('99999');
    expect(text).not.toContain('durationMs');
    expect(text).not.toContain('ms');
  });
});

describe('verify tool handler', () => {
  it('calls compositeVerifier with workspaceDir and skipLint: true', async () => {
    const passedResult: VerificationResult = {
      passed: true,
      errors: [],
      durationMs: 100,
    };
    mockCompositeVerifier.mockResolvedValue(passedResult);

    const { _createVerifyHandler } = await import('./verifier-server.js');
    const handler = _createVerifyHandler('/tmp/workspace');
    await handler({}, undefined);

    expect(mockCompositeVerifier).toHaveBeenCalledWith('/tmp/workspace', { skipLint: true });
    expect(mockCompositeVerifier).toHaveBeenCalledTimes(1);
  });

  it('returns tool result with formatted text when verification passes', async () => {
    const passedResult: VerificationResult = {
      passed: true,
      errors: [],
      durationMs: 100,
    };
    mockCompositeVerifier.mockResolvedValue(passedResult);

    const { _createVerifyHandler } = await import('./verifier-server.js');
    const handler = _createVerifyHandler('/tmp/workspace');
    const result = await handler({}, undefined);

    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({
      type: 'text',
      text: 'Verification PASSED: Build: PASS, Test: PASS, Lint: PASS',
    });
  });

  it('returns tool result with FAILED text and isError: true when verification fails', async () => {
    const failedResult: VerificationResult = {
      passed: false,
      errors: [{ type: 'build', summary: 'Build error', rawOutput: 'raw' }],
      durationMs: 500,
    };
    mockCompositeVerifier.mockResolvedValue(failedResult);

    const { _createVerifyHandler } = await import('./verifier-server.js');
    const handler = _createVerifyHandler('/tmp/workspace');
    const result = await handler({}, undefined);

    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect((result.content[0] as { type: 'text'; text: string }).text).toContain('Verification FAILED:');
    expect(result.isError).toBe(true);
  });

  it('returns isError: false when verification passes', async () => {
    const passedResult: VerificationResult = {
      passed: true,
      errors: [],
      durationMs: 100,
    };
    mockCompositeVerifier.mockResolvedValue(passedResult);

    const { _createVerifyHandler } = await import('./verifier-server.js');
    const handler = _createVerifyHandler('/tmp/workspace');
    const result = await handler({}, undefined);

    expect(result.isError).toBe(false);
  });

  it('returns isError: true with error message when compositeVerifier throws', async () => {
    mockCompositeVerifier.mockRejectedValue(new Error('workspace not found'));

    const { _createVerifyHandler } = await import('./verifier-server.js');
    const handler = _createVerifyHandler('/tmp/workspace');
    const result = await handler({}, undefined);

    expect(result.isError).toBe(true);
    expect((result.content[0] as { type: 'text'; text: string }).text).toBe('Verification error: workspace not found');
  });

  it('handles non-Error thrown values gracefully', async () => {
    mockCompositeVerifier.mockRejectedValue('string error');

    const { _createVerifyHandler } = await import('./verifier-server.js');
    const handler = _createVerifyHandler('/tmp/workspace');
    const result = await handler({}, undefined);

    expect(result.isError).toBe(true);
    expect((result.content[0] as { type: 'text'; text: string }).text).toBe('Verification error: string error');
  });
});
