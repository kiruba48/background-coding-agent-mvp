import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ResolvedIntent } from './types.js';

// Mock readline before importing confirm-loop
const mockQuestion = vi.fn();
const mockClose = vi.fn();
const mockOn = vi.fn();

vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({
    question: mockQuestion,
    close: mockClose,
    on: mockOn,
  })),
}));

import { confirmLoop, displayIntent } from './confirm-loop.js';

const SAMPLE_INTENT: ResolvedIntent = {
  taskType: 'npm-dependency-update',
  repo: '/home/user/projects/myapp',
  dep: 'recharts',
  version: 'latest',
  confidence: 'high',
};

describe('displayIntent', () => {
  it('prints task type, project basename, dep, and version', () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });

    displayIntent(SAMPLE_INTENT);

    const allOutput = logs.join('\n');
    expect(allOutput).toContain('npm-dependency-update');
    expect(allOutput).toContain('myapp'); // basename of /home/user/projects/myapp
    expect(allOutput).toContain('recharts');
    expect(allOutput).toContain('latest');

    vi.restoreAllMocks();
  });

  it('does not print dep line when dep is null', () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });

    displayIntent({ ...SAMPLE_INTENT, dep: null });

    const allOutput = logs.join('\n');
    expect(allOutput).not.toContain('Dep:');

    vi.restoreAllMocks();
  });

  it('shows (from session) annotation for inherited taskType', () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });

    displayIntent({ ...SAMPLE_INTENT, inheritedFields: new Set(['taskType'] as const) });

    vi.restoreAllMocks();
    const allOutput = logs.join('\n');
    expect(allOutput).toContain('from session');
  });

  it('shows (from session) annotation for inherited repo', () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });

    displayIntent({ ...SAMPLE_INTENT, inheritedFields: new Set(['repo'] as const) });

    vi.restoreAllMocks();
    const allOutput = logs.join('\n');
    expect(allOutput).toContain('from session');
  });

  it('shows (from session) on both task and project when both inherited', () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });

    displayIntent({ ...SAMPLE_INTENT, inheritedFields: new Set(['taskType', 'repo'] as const) });

    vi.restoreAllMocks();
    const allOutput = logs.join('\n');
    const count = (allOutput.match(/from session/g) ?? []).length;
    expect(count).toBe(2);
  });

  it('no (from session) annotation when inheritedFields is undefined', () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });

    displayIntent({ ...SAMPLE_INTENT });

    vi.restoreAllMocks();
    const allOutput = logs.join('\n');
    expect(allOutput).not.toContain('from session');
  });
});

describe('confirmLoop', () => {
  beforeEach(() => {
    mockQuestion.mockReset();
    mockClose.mockReset();
    mockOn.mockReset();
  });

  it('returns intent immediately when user presses Enter (empty string)', async () => {
    mockQuestion.mockResolvedValueOnce('');

    const reparse = vi.fn();
    const result = await confirmLoop(SAMPLE_INTENT, reparse);

    expect(result).toEqual(SAMPLE_INTENT);
    expect(reparse).not.toHaveBeenCalled();
  });

  it('returns intent when user types "y"', async () => {
    mockQuestion.mockResolvedValueOnce('y');

    const reparse = vi.fn();
    const result = await confirmLoop(SAMPLE_INTENT, reparse);

    expect(result).toEqual(SAMPLE_INTENT);
    expect(reparse).not.toHaveBeenCalled();
  });

  it('returns intent when user types "Y"', async () => {
    mockQuestion.mockResolvedValueOnce('Y');

    const reparse = vi.fn();
    const result = await confirmLoop(SAMPLE_INTENT, reparse);

    expect(result).toEqual(SAMPLE_INTENT);
  });

  it('calls reparse with correction when user types "n" then provides correction', async () => {
    const correctedIntent: ResolvedIntent = { ...SAMPLE_INTENT, dep: 'lodash' };
    mockQuestion
      .mockResolvedValueOnce('n')          // first question: Proceed?
      .mockResolvedValueOnce('update lodash') // second question: Correction
      .mockResolvedValueOnce('y');         // third question: Proceed?

    const reparse = vi.fn().mockResolvedValue(correctedIntent);
    const result = await confirmLoop(SAMPLE_INTENT, reparse);

    expect(reparse).toHaveBeenCalledOnce();
    expect(reparse).toHaveBeenCalledWith('update lodash', SAMPLE_INTENT);
    expect(result).toEqual(correctedIntent);
  });

  it('returns null after 3 redirects and prints abort message', async () => {
    // Simulate user always saying 'n'
    mockQuestion
      .mockResolvedValueOnce('n')      // Proceed?
      .mockResolvedValueOnce('fix 1')  // Correction 1
      .mockResolvedValueOnce('n')      // Proceed?
      .mockResolvedValueOnce('fix 2')  // Correction 2
      .mockResolvedValueOnce('n')      // Proceed?
      .mockResolvedValueOnce('fix 3')  // Correction 3
      .mockResolvedValueOnce('n');     // Would be asked again but should abort

    const correctedIntent: ResolvedIntent = { ...SAMPLE_INTENT };
    const reparse = vi.fn().mockResolvedValue(correctedIntent);

    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });

    const result = await confirmLoop(SAMPLE_INTENT, reparse, 3);

    expect(result).toBeNull();
    const allOutput = logs.join('\n');
    expect(allOutput).toContain('Please try again with a clearer command');

    vi.restoreAllMocks();
  });

  it('always closes readline in confirm path', async () => {
    mockQuestion.mockResolvedValueOnce('y');

    await confirmLoop(SAMPLE_INTENT, vi.fn());

    expect(mockClose).toHaveBeenCalledOnce();
  });

  it('always closes readline even after abort', async () => {
    // Trigger max redirects quickly by always responding 'n'
    mockQuestion
      .mockResolvedValueOnce('n')
      .mockResolvedValueOnce('x')
      .mockResolvedValueOnce('n')
      .mockResolvedValueOnce('x')
      .mockResolvedValueOnce('n')
      .mockResolvedValueOnce('x')
      .mockResolvedValue('n');

    const reparse = vi.fn().mockResolvedValue(SAMPLE_INTENT);

    vi.spyOn(console, 'log').mockImplementation(() => {});
    await confirmLoop(SAMPLE_INTENT, reparse, 3);

    expect(mockClose).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('registers SIGINT handler on readline', async () => {
    mockQuestion.mockResolvedValueOnce('y');

    await confirmLoop(SAMPLE_INTENT, vi.fn());

    expect(mockOn).toHaveBeenCalledWith('SIGINT', expect.any(Function));
  });
});
