import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock node:child_process using the same pattern as index.test.ts
vi.mock('node:child_process', async () => {
  const util = await import('node:util');
  const baseFn = vi.fn();
  const promisifiedFn = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });
  (baseFn as any)[util.promisify.custom] = promisifiedFn;
  return { execFile: baseFn };
});

// Mock node:fs/promises
vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(''),
  readdir: vi.fn().mockResolvedValue([]),
  stat: vi.fn().mockResolvedValue({ isDirectory: () => true }),
}));

import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { WorktreeManager } from './worktree-manager.js';

// Access the promisified mock
const mockExecFileAsync = (execFile as any)[promisify.custom] as ReturnType<typeof vi.fn>;
const mockWriteFile = writeFile as ReturnType<typeof vi.fn>;
const mockReadFile = readFile as ReturnType<typeof vi.fn>;
const mockReaddir = readdir as ReturnType<typeof vi.fn>;
const mockStat = stat as ReturnType<typeof vi.fn>;

describe('WorktreeManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
    mockWriteFile.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue('');
    mockReaddir.mockResolvedValue([]);
    mockStat.mockResolvedValue({ isDirectory: () => true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Test 1: buildWorktreePath produces correct sibling path (example 1)
  it('1. buildWorktreePath produces .bg-agent-<basename>-<suffix> in parent dir (example 1)', () => {
    const result = WorktreeManager.buildWorktreePath('/code/my-app', 'a1b2c3');
    expect(result).toBe('/code/.bg-agent-my-app-a1b2c3');
  });

  // Test 2: buildWorktreePath produces correct sibling path (example 2)
  it('2. buildWorktreePath produces correct path for nested repo path (example 2)', () => {
    const result = WorktreeManager.buildWorktreePath('/home/user/projects/repo', 'ff00aa');
    expect(result).toBe('/home/user/projects/.bg-agent-repo-ff00aa');
  });

  // Test 3: create() calls git worktree add with correct args and cwd
  it('3. create() calls git worktree add with correct args and cwd', async () => {
    const wm = new WorktreeManager('/code/my-app', '/code/.bg-agent-my-app-a1b2c3', 'agent/task-2026-04-05-a1b2c3');
    await wm.create();

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['worktree', 'add', '/code/.bg-agent-my-app-a1b2c3', '-b', 'agent/task-2026-04-05-a1b2c3'],
      { cwd: '/code/my-app' }
    );
  });

  // Test 4: create() writes JSON PID sentinel with process.pid, branch name, and createdAt
  it('4. create() writes JSON PID sentinel with process.pid, branch, and createdAt', async () => {
    const before = Date.now();
    const wm = new WorktreeManager('/code/my-app', '/code/.bg-agent-my-app-a1b2c3', 'agent/task-2026-04-05-a1b2c3');
    await wm.create();

    expect(mockWriteFile).toHaveBeenCalledWith(
      '/code/.bg-agent-my-app-a1b2c3/.bg-agent-pid',
      expect.any(String),
    );
    const written = JSON.parse(mockWriteFile.mock.calls[0][1] as string);
    expect(written.pid).toBe(process.pid);
    expect(written.branch).toBe('agent/task-2026-04-05-a1b2c3');
    expect(written.createdAt).toBeGreaterThanOrEqual(before);
    expect(written.createdAt).toBeLessThanOrEqual(Date.now());
  });

  // Test 5: remove() calls git worktree remove --force then git branch -d (safe delete)
  it('5. remove() calls git worktree remove --force then git branch -d', async () => {
    const wm = new WorktreeManager('/code/my-app', '/code/.bg-agent-my-app-a1b2c3', 'agent/task-2026-04-05-a1b2c3');
    await wm.remove();

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', '--force', '/code/.bg-agent-my-app-a1b2c3'],
      { cwd: '/code/my-app' }
    );
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['branch', '-d', 'agent/task-2026-04-05-a1b2c3'],
      { cwd: '/code/my-app' }
    );
  });

  // Test 5b: remove({ keepBranch: true }) skips branch deletion
  it('5b. remove({ keepBranch: true }) skips branch deletion', async () => {
    const wm = new WorktreeManager('/code/my-app', '/code/.bg-agent-my-app-a1b2c3', 'agent/task-2026-04-05-a1b2c3');
    await wm.remove({ keepBranch: true });

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', '--force', '/code/.bg-agent-my-app-a1b2c3'],
      { cwd: '/code/my-app' }
    );
    // Should NOT have called git branch -d
    const branchCalls = mockExecFileAsync.mock.calls.filter(
      (call: unknown[]) => Array.isArray(call[1]) && (call[1] as string[])[0] === 'branch'
    );
    expect(branchCalls).toHaveLength(0);
  });

  // Test 6: remove() does not throw when git worktree remove fails
  it('6. remove() does not throw when git worktree remove fails', async () => {
    mockExecFileAsync.mockRejectedValueOnce(new Error('git worktree remove failed'));

    const wm = new WorktreeManager('/code/my-app', '/code/.bg-agent-my-app-a1b2c3', 'agent/task-2026-04-05-a1b2c3');
    await expect(wm.remove()).resolves.toBeUndefined();
  });

  // Test 7: remove() does not throw when git branch -d fails
  it('7. remove() does not throw when git branch -d fails', async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // worktree remove succeeds
      .mockRejectedValueOnce(new Error('branch not found'));  // branch -D fails

    const wm = new WorktreeManager('/code/my-app', '/code/.bg-agent-my-app-a1b2c3', 'agent/task-2026-04-05-a1b2c3');
    await expect(wm.remove()).resolves.toBeUndefined();
  });

  // Test 8: pruneOrphans() skips entries with alive PIDs
  it('8. pruneOrphans() skips entries with alive PIDs', async () => {
    const alivePid = process.pid; // current process is alive
    mockReaddir.mockResolvedValue(['.bg-agent-my-app-aabbcc']);
    mockStat.mockResolvedValue({ isDirectory: () => true });
    mockReadFile.mockResolvedValue(JSON.stringify({ pid: alivePid, branch: 'agent/branch-aabbcc', createdAt: Date.now() }));

    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true); // alive — no throw

    await WorktreeManager.pruneOrphans('/code/my-app');

    // Should NOT have called git worktree remove on alive worktree
    const execCalls = mockExecFileAsync.mock.calls;
    const worktreeRemoveCalls = execCalls.filter(
      (call: unknown[]) => Array.isArray(call[1]) && (call[1] as string[]).includes('remove')
    );
    expect(worktreeRemoveCalls).toHaveLength(0);

    killSpy.mockRestore();
  });

  // Test 9: pruneOrphans() prunes entries with dead PIDs (ESRCH)
  it('9. pruneOrphans() prunes entries with dead PIDs (ESRCH)', async () => {
    const deadPid = 99999;
    mockReaddir.mockResolvedValue(['.bg-agent-my-app-deadpid']);
    mockStat.mockResolvedValue({ isDirectory: () => true });
    mockReadFile.mockResolvedValue(JSON.stringify({ pid: deadPid, branch: 'agent/branch-deadpid', createdAt: Date.now() }));

    const esrchError = Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw esrchError;
    });

    await WorktreeManager.pruneOrphans('/code/my-app');

    // Should have called git worktree remove --force
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', '--force', '/code/.bg-agent-my-app-deadpid'],
      { cwd: '/code/my-app' }
    );
    // Should have called git branch -D with the branch from sentinel
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['branch', '-D', 'agent/branch-deadpid'],
      { cwd: '/code/my-app' }
    );

    killSpy.mockRestore();
  });

  // Test 10: pruneOrphans() prunes entries with missing sentinel files
  it('10. pruneOrphans() prunes entries with missing sentinel files', async () => {
    mockReaddir.mockResolvedValue(['.bg-agent-my-app-nosent']);
    mockStat.mockResolvedValue({ isDirectory: () => true });
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    await WorktreeManager.pruneOrphans('/code/my-app');

    // Should have called git worktree remove --force (no branch -D since sentinel missing)
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', '--force', '/code/.bg-agent-my-app-nosent'],
      { cwd: '/code/my-app' }
    );
  });

  // Test 11: pruneOrphans() does not throw when individual prune fails
  it('11. pruneOrphans() does not throw when individual prune fails', async () => {
    const deadPid = 99998;
    mockReaddir.mockResolvedValue(['.bg-agent-my-app-fail1', '.bg-agent-my-app-fail2']);
    mockStat.mockResolvedValue({ isDirectory: () => true });
    mockReadFile.mockResolvedValue(JSON.stringify({ pid: deadPid, branch: 'agent/branch', createdAt: Date.now() }));

    const esrchError = Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw esrchError;
    });
    mockExecFileAsync.mockRejectedValue(new Error('git command failed'));

    await expect(WorktreeManager.pruneOrphans('/code/my-app')).resolves.toBeUndefined();

    killSpy.mockRestore();
  });

  // Test 12: pruneOrphans() only scans dirs matching the repo prefix
  it('12. pruneOrphans() only scans dirs matching the repo prefix', async () => {
    mockReaddir.mockResolvedValue([
      '.bg-agent-my-app-aabbcc',    // matches prefix
      '.bg-agent-other-app-aabbcc', // different repo — should be skipped
      'some-other-directory',        // no prefix — skip
      '.bg-agent-my-app-ddeeff',    // matches prefix
    ]);
    mockStat.mockResolvedValue({ isDirectory: () => true });
    // Make all sentinel reads return missing so orphan logic runs for matched dirs
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    await WorktreeManager.pruneOrphans('/code/my-app');

    // Should only have tried to remove the 2 matching dirs, not the other 2
    const worktreeRemoveCalls = mockExecFileAsync.mock.calls.filter(
      (call: unknown[]) => Array.isArray(call[1]) && (call[1] as string[])[1] === 'remove'
    );
    expect(worktreeRemoveCalls).toHaveLength(2);
    const removedPaths = worktreeRemoveCalls.map((call: unknown[]) => (call[1] as string[])[3]);
    expect(removedPaths).toContain('/code/.bg-agent-my-app-aabbcc');
    expect(removedPaths).toContain('/code/.bg-agent-my-app-ddeeff');
    expect(removedPaths).not.toContain('/code/.bg-agent-other-app-aabbcc');
  });

  // Test 13: pruneOrphans() treats stale sentinels (>24h) as orphans despite live PID
  it('13. pruneOrphans() treats stale sentinels (>24h) as orphans despite live PID', async () => {
    const alivePid = process.pid;
    const staleTime = Date.now() - (25 * 60 * 60 * 1000); // 25 hours ago
    mockReaddir.mockResolvedValue(['.bg-agent-my-app-stale']);
    mockStat.mockResolvedValue({ isDirectory: () => true });
    mockReadFile.mockResolvedValue(JSON.stringify({ pid: alivePid, branch: 'agent/stale-branch', createdAt: staleTime }));

    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);

    await WorktreeManager.pruneOrphans('/code/my-app');

    // Should prune despite PID being alive — sentinel is stale
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['worktree', 'remove', '--force', '/code/.bg-agent-my-app-stale'],
      { cwd: '/code/my-app' }
    );

    killSpy.mockRestore();
  });

  // Test 14: path and branch getters return constructor values
  it('14. path and branch getters return constructor values', () => {
    const wm = new WorktreeManager(
      '/code/my-app',
      '/code/.bg-agent-my-app-a1b2c3',
      'agent/task-2026-04-05-a1b2c3'
    );
    expect(wm.path).toBe('/code/.bg-agent-my-app-a1b2c3');
    expect(wm.branch).toBe('agent/task-2026-04-05-a1b2c3');
  });
});
