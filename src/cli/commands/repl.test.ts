import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadHistory, saveHistory, getPrompt, renderResultBlock, createProgressIndicator } from './repl.js';
import type { ReplState } from '../../repl/types.js';
import type { RetryResult } from '../../types.js';

// ─── loadHistory ─────────────────────────────────────────────────────────────

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    lstatSync: vi.fn().mockImplementation(() => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }),
  };
});

describe('loadHistory', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns [] when history file does not exist', async () => {
    const { readFileSync } = await import('node:fs');
    vi.mocked(readFileSync).mockImplementation(() => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });

    const result = loadHistory();
    expect(result).toEqual([]);
  });

  it('returns parsed lines when file exists', async () => {
    const { readFileSync } = await import('node:fs');
    vi.mocked(readFileSync).mockReturnValue('update lodash\nfix tests\nadd feature\n');

    const result = loadHistory();
    expect(result).toEqual(['update lodash', 'fix tests', 'add feature']);
  });

  it('filters out empty lines', async () => {
    const { readFileSync } = await import('node:fs');
    vi.mocked(readFileSync).mockReturnValue('cmd1\n\ncmd2\n\n\ncmd3');

    const result = loadHistory();
    expect(result).toEqual(['cmd1', 'cmd2', 'cmd3']);
  });

  it('returns [] on unexpected errors', async () => {
    const { readFileSync } = await import('node:fs');
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error('EACCES');
    });

    const result = loadHistory();
    expect(result).toEqual([]);
  });
});

// ─── saveHistory ─────────────────────────────────────────────────────────────

describe('saveHistory', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('creates directory with recursive option and 0o700 mode', async () => {
    const { mkdirSync } = await import('node:fs');

    saveHistory(['cmd1', 'cmd2']);

    expect(vi.mocked(mkdirSync)).toHaveBeenCalledWith(
      expect.stringContaining('.config'),
      { recursive: true, mode: 0o700 },
    );
  });

  it('writes history lines joined by newline with 0o600 mode', async () => {
    const { writeFileSync } = await import('node:fs');

    saveHistory(['update lodash', 'fix tests']);

    expect(vi.mocked(writeFileSync)).toHaveBeenCalledWith(
      expect.stringContaining('history'),
      'update lodash\nfix tests',
      { mode: 0o600 },
    );
  });

  it('skips write when history file is a symlink', async () => {
    const { writeFileSync, lstatSync } = await import('node:fs');
    vi.mocked(lstatSync).mockReturnValue({ isSymbolicLink: () => true } as any);

    saveHistory(['cmd1']);

    expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
  });

  it('does not throw when write fails (non-fatal)', async () => {
    const { writeFileSync } = await import('node:fs');
    vi.mocked(writeFileSync).mockImplementation(() => {
      throw new Error('EROFS');
    });

    expect(() => saveHistory(['cmd'])).not.toThrow();
  });
});

// ─── getPrompt ────────────────────────────────────────────────────────────────

describe('getPrompt', () => {
  it('returns "bg> " when no project is set', () => {
    const state: ReplState = { currentProject: null, currentProjectName: null, history: [] };
    const prompt = getPrompt(state);
    // Strip ANSI codes for comparison
    const stripped = prompt.replace(/\x1B\[[0-9;]*m/g, '');
    expect(stripped).toBe('bg> ');
  });

  it('returns "myapp> " when currentProjectName is "myapp"', () => {
    const state: ReplState = { currentProject: '/path/to/myapp', currentProjectName: 'myapp', history: [] };
    const prompt = getPrompt(state);
    const stripped = prompt.replace(/\x1B\[[0-9;]*m/g, '');
    expect(stripped).toBe('myapp> ');
  });
});

// ─── renderResultBlock ────────────────────────────────────────────────────────

describe('renderResultBlock', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  function makeResult(overrides: Partial<RetryResult> = {}): RetryResult {
    return {
      finalStatus: 'success',
      attempts: 1,
      sessionResults: [],
      verificationResults: [],
      judgeResults: undefined,
      ...overrides,
    };
  }

  it('outputs box-drawing characters', () => {
    renderResultBlock(makeResult());
    const allOutput = logSpy.mock.calls.flat().join('\n');
    expect(allOutput).toContain('┌');
    expect(allOutput).toContain('└');
  });

  it('shows the finalStatus in output', () => {
    renderResultBlock(makeResult({ finalStatus: 'failed' }));
    const allOutput = logSpy.mock.calls.flat().join('\n');
    expect(allOutput).toContain('failed');
  });

  it('shows attempts count', () => {
    renderResultBlock(makeResult({ attempts: 3 }));
    const allOutput = logSpy.mock.calls.flat().join('\n');
    expect(allOutput).toContain('3');
  });

  it('shows N/A when no verification results', () => {
    renderResultBlock(makeResult({ verificationResults: [] }));
    const allOutput = logSpy.mock.calls.flat().join('\n');
    expect(allOutput).toContain('N/A');
  });

  it('shows PASS when last verification result passed', () => {
    const result = makeResult({
      verificationResults: [{ passed: true, errors: [], durationMs: 100 }],
    });
    renderResultBlock(result);
    const allOutput = logSpy.mock.calls.flat().join('\n');
    expect(allOutput).toContain('PASS');
  });

  it('shows FAIL when last verification result failed', () => {
    const result = makeResult({
      verificationResults: [{ passed: false, errors: [], durationMs: 100 }],
    });
    renderResultBlock(result);
    const allOutput = logSpy.mock.calls.flat().join('\n');
    expect(allOutput).toContain('FAIL');
  });

  it('shows judge verdict when judgeResults present', () => {
    const result = makeResult({
      judgeResults: [{ verdict: 'APPROVE', reasoning: 'ok', veto_reason: '', durationMs: 50 }],
    });
    renderResultBlock(result);
    const allOutput = logSpy.mock.calls.flat().join('\n');
    expect(allOutput).toContain('APPROVE');
  });
});

// ─── createProgressIndicator ─────────────────────────────────────────────────

describe('createProgressIndicator', () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    writeSpy.mockRestore();
  });

  it('writes status line on start', () => {
    const progress = createProgressIndicator();
    progress.start();

    expect(writeSpy).toHaveBeenCalled();
    const output = writeSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(output).toContain('Resolving version');

    progress.stop();
  });

  it('updates elapsed time on interval tick', () => {
    const progress = createProgressIndicator();
    progress.start();
    writeSpy.mockClear();

    vi.advanceTimersByTime(3000);

    const output = writeSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(output).toContain('3s');

    progress.stop();
  });

  it('advances phase label after 5 seconds', () => {
    const progress = createProgressIndicator();
    progress.start();

    vi.advanceTimersByTime(6000);

    const output = writeSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(output).toContain('Running agent');

    progress.stop();
  });

  it('clears line on stop', () => {
    const progress = createProgressIndicator();
    progress.start();
    writeSpy.mockClear();

    progress.stop();

    const output = writeSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    // Should contain ANSI clear-line escape
    expect(output).toContain('\x1b[K');
  });
});
