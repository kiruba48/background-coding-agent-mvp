import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock node:child_process before importing the module under test
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

// Import after mocks are set up
import { assertDockerRunning, ensureNetworkExists, buildImageIfNeeded, buildDockerRunArgs } from './index.js';
import { execFile } from 'node:child_process';

const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;

type ExecCallback = (err: Error | null, result?: { stdout: string; stderr: string }) => void;

/**
 * Extract the callback from execFile args — handles both 3-arg (no opts) and 4-arg (with opts) forms.
 * promisify(execFile) calls either execFile(cmd, args, cb) or execFile(cmd, args, opts, cb).
 */
function extractCallback(args: unknown[]): ExecCallback {
  const last = args[args.length - 1];
  return last as ExecCallback;
}

/**
 * Helper to make execFile resolve (simulate success: exit code 0).
 * promisify(execFile) resolves with { stdout, stderr }.
 */
function mockExecSuccess(stdout = '', stderr = ''): void {
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const callback = extractCallback(args);
    callback(null, { stdout, stderr });
  });
}

/**
 * Helper to make execFile reject (simulate failure: non-zero exit code).
 */
function mockExecFailure(message = 'Command failed'): void {
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const callback = extractCallback(args);
    callback(new Error(message));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('assertDockerRunning', () => {
  it('resolves when docker info succeeds', async () => {
    mockExecSuccess();
    await expect(assertDockerRunning()).resolves.toBeUndefined();
    expect(mockExecFile).toHaveBeenCalledWith(
      'docker',
      ['info'],
      expect.any(Object),
      expect.any(Function)
    );
  });

  it('rejects with clear error message when docker is not running', async () => {
    mockExecFailure('Docker daemon not running');
    await expect(assertDockerRunning()).rejects.toThrow(
      'Docker is not running. Start Docker Desktop or the Docker daemon before running background-agent.'
    );
  });
});

describe('ensureNetworkExists', () => {
  it('does not create network if inspect succeeds', async () => {
    mockExecSuccess();
    await ensureNetworkExists('agent-net');
    // Only one call (inspect), no create call
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockExecFile).toHaveBeenCalledWith(
      'docker',
      ['network', 'inspect', 'agent-net'],
      expect.any(Object),
      expect.any(Function)
    );
  });

  it('creates network if inspect fails', async () => {
    mockExecFile
      .mockImplementationOnce((...args: unknown[]) => {
        // First call (inspect) fails
        extractCallback(args)(new Error('network not found'));
      })
      .mockImplementationOnce((...args: unknown[]) => {
        // Second call (create) succeeds
        extractCallback(args)(null, { stdout: '', stderr: '' });
      });

    await ensureNetworkExists('agent-net');
    expect(mockExecFile).toHaveBeenCalledTimes(2);
    const secondCallArgs = mockExecFile.mock.calls[1];
    expect(secondCallArgs[0]).toBe('docker');
    expect(secondCallArgs[1]).toEqual(['network', 'create', 'agent-net']);
  });
});

describe('buildImageIfNeeded', () => {
  it('skips build if image already exists', async () => {
    mockExecSuccess();
    await buildImageIfNeeded('background-agent:latest');
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const firstCall = mockExecFile.mock.calls[0];
    expect(firstCall[0]).toBe('docker');
    expect(firstCall[1]).toEqual(['image', 'inspect', 'background-agent:latest']);
  });

  it('builds image if not found', async () => {
    mockExecFile
      .mockImplementationOnce((...args: unknown[]) => {
        // First call (image inspect) fails
        extractCallback(args)(new Error('image not found'));
      })
      .mockImplementationOnce((...args: unknown[]) => {
        // Second call (docker build) succeeds
        extractCallback(args)(null, { stdout: '', stderr: '' });
      });

    await buildImageIfNeeded('background-agent:latest');
    expect(mockExecFile).toHaveBeenCalledTimes(2);
    const secondCall = mockExecFile.mock.calls[1];
    expect(secondCall[0]).toBe('docker');
    expect(secondCall[1]).toContain('build');
    expect(secondCall[1]).toContain('-t');
    expect(secondCall[1]).toContain('background-agent:latest');
  });
});

describe('buildDockerRunArgs', () => {
  const opts = {
    workspaceDir: '/home/user/myrepo',
    apiKey: 'sk-ant-test123',
    sessionId: 'abc123',
  };

  it('returns correct docker run args with all security flags', () => {
    const args = buildDockerRunArgs(opts, '/usr/local/bin/claude', ['--model', 'claude-opus-4-5']);

    expect(args).toContain('run');
    expect(args).toContain('--rm');
    expect(args).toContain('--interactive');
    expect(args).toContain('--cap-drop');
    expect(args).toContain('ALL');
    expect(args).toContain('--cap-add');
    expect(args).toContain('NET_ADMIN');
    expect(args).toContain('--security-opt');
    expect(args).toContain('no-new-privileges');
    expect(args).toContain('--pids-limit');
    expect(args).toContain('200');
    expect(args).toContain('--memory');
    expect(args).toContain('2g');
    expect(args).toContain('--read-only');
    expect(args).toContain('--tmpfs');
    expect(args).toContain('/tmp');
    expect(args).toContain('--sysctl');
    expect(args).toContain('net.ipv6.conf.all.disable_ipv6=1');
  });

  it('passes API key name only for env inheritance (not in ps args)', () => {
    const args = buildDockerRunArgs(opts, '/usr/local/bin/claude', []);
    const apiKeyArgIndex = args.indexOf('-e');
    expect(apiKeyArgIndex).toBeGreaterThan(-1);
    // V-1: key value must NOT appear in args (would be visible via ps aux)
    expect(args[apiKeyArgIndex + 1]).toBe('ANTHROPIC_API_KEY');
    expect(args.join(' ')).not.toContain('sk-ant-test123');
  });

  it('mounts workspace directory', () => {
    const args = buildDockerRunArgs(opts, '/usr/local/bin/claude', []);
    expect(args).toContain('-v');
    expect(args).toContain('/home/user/myrepo:/workspace:rw');
    expect(args).toContain('--workdir');
    expect(args).toContain('/workspace');
  });

  it('container name includes session ID with agent- prefix', () => {
    const args = buildDockerRunArgs(opts, '/usr/local/bin/claude', []);
    const nameIndex = args.indexOf('--name');
    expect(nameIndex).toBeGreaterThan(-1);
    expect(args[nameIndex + 1]).toBe('agent-abc123');
  });

  it('passes through SDK command and args after image tag', () => {
    const sdkArgs = ['--model', 'claude-opus-4-5', '--output-format', 'stream-json'];
    const args = buildDockerRunArgs(opts, '/usr/local/bin/claude', sdkArgs);
    // SDK command and args should appear at the end
    const claudeIndex = args.indexOf('/usr/local/bin/claude');
    expect(claudeIndex).toBeGreaterThan(-1);
    expect(args[claudeIndex + 1]).toBe('--model');
    expect(args[claudeIndex + 2]).toBe('claude-opus-4-5');
    expect(args[claudeIndex + 3]).toBe('--output-format');
    expect(args[claudeIndex + 4]).toBe('stream-json');
  });

  it('uses custom network and image tag when provided', () => {
    const customOpts = {
      ...opts,
      networkName: 'custom-net',
      imageTag: 'custom-agent:v1',
    };
    const args = buildDockerRunArgs(customOpts, '/usr/local/bin/claude', []);
    expect(args).toContain('custom-net');
    expect(args).toContain('custom-agent:v1');
  });
});
