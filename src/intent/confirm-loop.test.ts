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
  scopingQuestions: [],
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

    displayIntent({ ...SAMPLE_INTENT, inheritedFields: ['taskType'] });

    vi.restoreAllMocks();
    const allOutput = logs.join('\n');
    expect(allOutput).toContain('from session');
  });

  it('shows (from session) annotation for inherited repo', () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });

    displayIntent({ ...SAMPLE_INTENT, inheritedFields: ['repo'] });

    vi.restoreAllMocks();
    const allOutput = logs.join('\n');
    expect(allOutput).toContain('from session');
  });

  it('shows (from session) on both task and project when both inherited', () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });

    displayIntent({ ...SAMPLE_INTENT, inheritedFields: ['taskType', 'repo'] });

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

  // --- Generic task display tests ---

  const GENERIC_INTENT: ResolvedIntent = {
    taskType: 'generic',
    repo: '/home/user/projects/myapp',
    dep: null,
    version: null,
    confidence: 'high',
    description: 'replace axios with fetch',
    taskCategory: 'code-change',
    scopingQuestions: [],
  };

  it('shows taskCategory label instead of raw "generic" on Task line when taskCategory is set', () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });

    displayIntent(GENERIC_INTENT);

    vi.restoreAllMocks();
    const allOutput = logs.join('\n');
    expect(allOutput).toContain('code-change');
    expect(allOutput).not.toContain('generic');
  });

  it('shows taskCategory "refactor" on Task line when taskCategory is refactor', () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });

    displayIntent({ ...GENERIC_INTENT, taskCategory: 'refactor' });

    vi.restoreAllMocks();
    const allOutput = logs.join('\n');
    expect(allOutput).toContain('refactor');
    expect(allOutput).not.toContain('generic');
  });

  it('falls back to "generic" on Task line when taskCategory is null', () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });

    displayIntent({ ...GENERIC_INTENT, taskCategory: null });

    vi.restoreAllMocks();
    const allOutput = logs.join('\n');
    expect(allOutput).toContain('generic');
  });

  it('shows Action line with description text for generic task', () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });

    displayIntent(GENERIC_INTENT);

    vi.restoreAllMocks();
    const allOutput = logs.join('\n');
    expect(allOutput).toContain('Action:');
    expect(allOutput).toContain('replace axios with fetch');
  });

  it('truncates description at 80 characters with ellipsis when description is longer than 80 chars', () => {
    const longDescription = 'a'.repeat(85);
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });

    displayIntent({ ...GENERIC_INTENT, description: longDescription });

    vi.restoreAllMocks();
    const allOutput = logs.join('\n');
    expect(allOutput).toContain('...');
    expect(allOutput).toContain('a'.repeat(80));
    expect(allOutput).not.toContain('a'.repeat(85));
  });

  it('shows full description without ellipsis when description is exactly 80 chars', () => {
    const exactDescription = 'b'.repeat(80);
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });

    displayIntent({ ...GENERIC_INTENT, description: exactDescription });

    vi.restoreAllMocks();
    const allOutput = logs.join('\n');
    expect(allOutput).toContain('b'.repeat(80));
    expect(allOutput).not.toContain('...');
  });

  it('non-generic task still shows raw taskType on Task line', () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });

    displayIntent(SAMPLE_INTENT);

    vi.restoreAllMocks();
    const allOutput = logs.join('\n');
    expect(allOutput).toContain('npm-dependency-update');
  });

  it('non-generic task does NOT show Action line', () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });

    displayIntent(SAMPLE_INTENT);

    vi.restoreAllMocks();
    const allOutput = logs.join('\n');
    expect(allOutput).not.toContain('Action:');
  });

  // --- Scope hints display tests ---

  it('renders Scope section with Q/A pairs when scopeHints is non-empty', () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });

    displayIntent(SAMPLE_INTENT, [{ question: 'Which files?', answer: 'src/auth/' }, { question: 'Include tests?', answer: 'yes' }]);

    vi.restoreAllMocks();
    const allOutput = logs.join('\n');
    expect(allOutput).toContain('Scope:');
    expect(allOutput).toContain('Which files?');
    expect(allOutput).toContain('src/auth/');
    expect(allOutput).toContain('Include tests?');
    expect(allOutput).toContain('yes');
  });

  it('does NOT render Scope section when scopeHints is empty array', () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });

    displayIntent(SAMPLE_INTENT, []);

    vi.restoreAllMocks();
    const allOutput = logs.join('\n');
    expect(allOutput).not.toContain('Scope:');
  });

  it('does NOT render Scope section when scopeHints is undefined', () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });

    displayIntent(SAMPLE_INTENT, undefined);

    vi.restoreAllMocks();
    const allOutput = logs.join('\n');
    expect(allOutput).not.toContain('Scope:');
  });

  it('still renders all existing fields when scopeHints is provided', () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });

    displayIntent(SAMPLE_INTENT, [{ question: 'Scope question', answer: 'hint one' }]);

    vi.restoreAllMocks();
    const allOutput = logs.join('\n');
    expect(allOutput).toContain('npm-dependency-update');
    expect(allOutput).toContain('myapp');
    expect(allOutput).toContain('recharts');
    expect(allOutput).toContain('latest');
    expect(allOutput).toContain('Scope:');
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
