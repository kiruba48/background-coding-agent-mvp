import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockedFunction } from 'vitest';
import type { ResolvedIntent } from '../../intent/types.js';

// Mock dependencies before import
vi.mock('../../intent/index.js', () => ({
  parseIntent: vi.fn(),
  confirmLoop: vi.fn(),
  fastPathParse: vi.fn(),
  displayIntent: vi.fn(),
}));

vi.mock('../../agent/index.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../auto-register.js', () => ({
  autoRegisterCwd: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../agent/registry.js', () => ({
  ProjectRegistry: vi.fn(),
}));

// Mock readline/promises — factory cannot reference top-level variables (hoisting constraint)
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(),
}));

import { oneShotCommand } from './one-shot.js';
import { parseIntent, confirmLoop, fastPathParse } from '../../intent/index.js';
import { runAgent } from '../../agent/index.js';
import { autoRegisterCwd } from '../auto-register.js';
import { ProjectRegistry } from '../../agent/registry.js';
import { createInterface } from 'node:readline/promises';

const mockParseIntent = parseIntent as MockedFunction<typeof parseIntent>;
const mockConfirmLoop = confirmLoop as MockedFunction<typeof confirmLoop>;
const mockFastPathParse = fastPathParse as MockedFunction<typeof fastPathParse>;
const mockRunAgent = runAgent as MockedFunction<typeof runAgent>;
// autoRegisterCwd is imported for side-effects; unused directly in assertions for now
void (autoRegisterCwd as MockedFunction<typeof autoRegisterCwd>);
const MockProjectRegistryCtor = ProjectRegistry as unknown as MockedFunction<new () => {
  resolve: MockedFunction<(name: string) => string | undefined>;
  list: MockedFunction<() => Record<string, string>>;
  register: MockedFunction<(name: string, path: string) => void>;
  has: MockedFunction<(name: string) => boolean>;
}>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCreateInterface = createInterface as unknown as MockedFunction<(...args: any[]) => any>;

const baseIntent: ResolvedIntent = {
  taskType: 'npm-dependency-update',
  repo: '/path/to/repo',
  dep: 'recharts',
  version: 'latest',
  confidence: 'high',
};

function makeRegistryInstance(overrides: Record<string, unknown> = {}) {
  return {
    resolve: vi.fn().mockReturnValue(undefined),
    list: vi.fn().mockReturnValue({}),
    register: vi.fn(),
    has: vi.fn().mockReturnValue(false),
    ...overrides,
  };
}

/** Wrap registry instance as a constructor function (arrow fns can't be `new`-called) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeRegistryCtor(instance: ReturnType<typeof makeRegistryInstance>): new () => any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function (this: any) {
    return instance;
  } as unknown as new () => any;
}

/** Create a readline mock instance that resolves question() with given answers in sequence */
function makeRlMock(answers: string[]) {
  let callIndex = 0;
  const mockQuestion = vi.fn().mockImplementation(() => {
    const answer = answers[callIndex] ?? '';
    callIndex++;
    return Promise.resolve(answer);
  });
  const rl = {
    question: mockQuestion,
    close: vi.fn(),
    on: vi.fn().mockReturnThis(),
  };
  return rl;
}

describe('oneShotCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default readline: no questions will be asked (tests that don't need prompting)
    const defaultRl = makeRlMock([]);
    mockCreateInterface.mockReturnValue(defaultRl as any);

    // Default: fast-path returns null (no project extraction)
    mockFastPathParse.mockReturnValue(null);

    // Default: parseIntent returns a high confidence intent
    mockParseIntent.mockResolvedValue(baseIntent);

    // Default: confirmLoop confirms
    mockConfirmLoop.mockResolvedValue(baseIntent);

    // Default: runAgent returns success
    mockRunAgent.mockResolvedValue({
      finalStatus: 'success',
      attempts: 1,
      sessionResults: [],
      verificationResults: [],
    });

    // Default: registry with no registered projects — but tests with repo provided won't need prompting
    const registryInstance = makeRegistryInstance();
    MockProjectRegistryCtor.mockImplementation(makeRegistryCtor(registryInstance));
  });

  describe('core happy path', () => {
    it('calls parseIntent with input and repo from options', async () => {
      await oneShotCommand('update recharts', { repo: '/path/to/repo' });

      expect(mockParseIntent).toHaveBeenCalledWith('update recharts', expect.objectContaining({
        repoPath: '/path/to/repo',
      }));
    });

    it('calls confirmLoop with the parsed intent', async () => {
      await oneShotCommand('update recharts', { repo: '/path/to/repo' });

      expect(mockConfirmLoop).toHaveBeenCalledWith(
        baseIntent,
        expect.any(Function),
      );
    });

    it('calls runAgent with correct AgentOptions when confirmed', async () => {
      mockConfirmLoop.mockResolvedValue({
        ...baseIntent,
        taskType: 'npm-dependency-update',
        repo: '/path/to/repo',
        dep: 'recharts',
        version: 'latest',
      });

      await oneShotCommand('update recharts', { repo: '/path/to/repo' });

      expect(mockRunAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          taskType: 'npm-dependency-update',
          repo: '/path/to/repo',
          dep: 'recharts',
          targetVersion: 'latest',
          turnLimit: 10,
          timeoutMs: 300000,
          maxRetries: 3,
        }),
        expect.any(Object),
      );
    });

    it('returns exit code 0 on successful agent run', async () => {
      const exitCode = await oneShotCommand('update recharts', { repo: '/path/to/repo' });
      expect(exitCode).toBe(0);
    });

    it('returns exit code 1 when agent run fails', async () => {
      mockRunAgent.mockResolvedValue({
        finalStatus: 'failed',
        attempts: 3,
        sessionResults: [],
        verificationResults: [],
      });

      const exitCode = await oneShotCommand('update recharts', { repo: '/path/to/repo' });
      expect(exitCode).toBe(1);
    });

    it('returns exit code 0 when confirmLoop returns null (user aborted)', async () => {
      mockConfirmLoop.mockResolvedValue(null);

      const exitCode = await oneShotCommand('update recharts', { repo: '/path/to/repo' });

      expect(exitCode).toBe(0);
      expect(mockRunAgent).not.toHaveBeenCalled();
    });
  });

  describe('options passthrough', () => {
    it('passes repo option to parseIntent as repoPath', async () => {
      await oneShotCommand('update recharts', { repo: '/explicit/path' });

      expect(mockParseIntent).toHaveBeenCalledWith(
        'update recharts',
        expect.objectContaining({ repoPath: '/explicit/path' }),
      );
    });

    it('passes createPr option through to AgentOptions', async () => {
      await oneShotCommand('update recharts', { repo: '/path', createPr: true });

      expect(mockRunAgent).toHaveBeenCalledWith(
        expect.objectContaining({ createPr: true }),
        expect.any(Object),
      );
    });

    it('maps custom turnLimit string to number in AgentOptions', async () => {
      await oneShotCommand('update recharts', { repo: '/path', turnLimit: '20' });

      expect(mockRunAgent).toHaveBeenCalledWith(
        expect.objectContaining({ turnLimit: 20 }),
        expect.any(Object),
      );
    });
  });

  describe('clarification numbered choices', () => {
    it('displays numbered choices when intent has low confidence with clarifications', async () => {
      const lowConfidenceIntent: ResolvedIntent = {
        ...baseIntent,
        confidence: 'low',
        clarifications: [
          { label: 'Update recharts to latest', intent: 'update recharts' },
          { label: 'Update react-charts', intent: 'update react-charts' },
        ],
      };
      mockParseIntent.mockResolvedValueOnce(lowConfidenceIntent).mockResolvedValue(baseIntent);

      // Setup readline to answer "1" for clarification choice
      const rl = makeRlMock(['1']);
      mockCreateInterface.mockReturnValue(rl as any);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await oneShotCommand('update the chart lib', { repo: '/path' });

      // Should display numbered choices with "Ambiguous input" header
      const logCalls = consoleSpy.mock.calls.map(c => c[0]).join('\n');
      expect(logCalls).toContain('Ambiguous input');
      consoleSpy.mockRestore();
    });

    it('re-parses with selected clarification intent string when user picks a number', async () => {
      const lowConfidenceIntent: ResolvedIntent = {
        ...baseIntent,
        confidence: 'low',
        clarifications: [
          { label: 'Update recharts to latest', intent: 'update recharts' },
          { label: 'Update react-charts', intent: 'update react-charts' },
        ],
      };
      mockParseIntent.mockResolvedValueOnce(lowConfidenceIntent).mockResolvedValue(baseIntent);

      // Setup readline to answer "1" for clarification choice
      const rl = makeRlMock(['1']);
      mockCreateInterface.mockReturnValue(rl as any);

      await oneShotCommand('update the chart lib', { repo: '/path' });

      // Second call to parseIntent should use the selected intent's string
      expect(mockParseIntent).toHaveBeenNthCalledWith(2,
        'update recharts', // the intent string from clarifications[0]
        expect.any(Object),
      );
    });

    it('returns exit code 0 when user picks invalid number in clarification', async () => {
      const lowConfidenceIntent: ResolvedIntent = {
        ...baseIntent,
        confidence: 'low',
        clarifications: [
          { label: 'Update recharts to latest', intent: 'update recharts' },
        ],
      };
      mockParseIntent.mockResolvedValueOnce(lowConfidenceIntent);

      // Setup readline to answer invalid choice
      const rl = makeRlMock(['99']);
      mockCreateInterface.mockReturnValue(rl as any);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const exitCode = await oneShotCommand('update the chart lib', { repo: '/path' });
      consoleSpy.mockRestore();

      expect(exitCode).toBe(0);
      expect(mockRunAgent).not.toHaveBeenCalled();
    });
  });

  describe('repo prompting', () => {
    it('prompts with numbered list of registered projects when no -r flag and no project in NL', async () => {
      const registryInstance = makeRegistryInstance({
        list: vi.fn().mockReturnValue({
          myapp: '/path/to/myapp',
          otherapp: '/path/to/otherapp',
        }),
      });
      MockProjectRegistryCtor.mockImplementation(makeRegistryCtor(registryInstance));
      mockFastPathParse.mockReturnValue(null); // no project in NL

      // Setup readline to answer "1" for project selection
      const rl = makeRlMock(['1']);
      mockCreateInterface.mockReturnValue(rl as any);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await oneShotCommand('update recharts', {}); // no repo option

      const logCalls = consoleSpy.mock.calls.map(c => c[0]).join('\n');
      expect(logCalls).toContain('No project specified');
      consoleSpy.mockRestore();
    });

    it('uses selected registered project path when user picks from list', async () => {
      const registryInstance = makeRegistryInstance({
        list: vi.fn().mockReturnValue({
          myapp: '/path/to/myapp',
        }),
      });
      MockProjectRegistryCtor.mockImplementation(makeRegistryCtor(registryInstance));
      mockFastPathParse.mockReturnValue(null);

      // Setup readline to answer "1" (picks myapp)
      const rl = makeRlMock(['1']);
      mockCreateInterface.mockReturnValue(rl as any);

      await oneShotCommand('update recharts', {});

      expect(mockParseIntent).toHaveBeenCalledWith(
        'update recharts',
        expect.objectContaining({ repoPath: '/path/to/myapp' }),
      );
    });

    it('prompts for manual path when no registered projects exist', async () => {
      const registryInstance = makeRegistryInstance({
        list: vi.fn().mockReturnValue({}), // no registered projects
      });
      MockProjectRegistryCtor.mockImplementation(makeRegistryCtor(registryInstance));
      mockFastPathParse.mockReturnValue(null);

      // Setup readline to answer path
      const rl = makeRlMock(['/my/local/project']);
      mockCreateInterface.mockReturnValue(rl as any);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await oneShotCommand('update recharts', {});

      expect(mockParseIntent).toHaveBeenCalledWith(
        'update recharts',
        expect.objectContaining({ repoPath: '/my/local/project' }),
      );
      consoleSpy.mockRestore();
    });

    it('registers user-provided manual path in registry', async () => {
      const registryInstance = makeRegistryInstance({
        list: vi.fn().mockReturnValue({}), // no registered projects
        register: vi.fn(),
      });
      MockProjectRegistryCtor.mockImplementation(makeRegistryCtor(registryInstance));
      mockFastPathParse.mockReturnValue(null);

      const rl = makeRlMock(['/my/local/project']);
      mockCreateInterface.mockReturnValue(rl as any);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await oneShotCommand('update recharts', {});

      expect(registryInstance.register).toHaveBeenCalledWith(
        'project', // basename of /my/local/project
        '/my/local/project',
      );
      consoleSpy.mockRestore();
    });

    it('prompts for local path when project name in NL not in registry', async () => {
      const registryInstance = makeRegistryInstance({
        resolve: vi.fn().mockReturnValue(undefined), // project not in registry
        list: vi.fn().mockReturnValue({}),
      });
      MockProjectRegistryCtor.mockImplementation(makeRegistryCtor(registryInstance));

      // fast-path extracts project name from NL
      mockFastPathParse.mockReturnValue({ dep: 'recharts', version: 'latest', project: 'unknownapp' });

      const rl = makeRlMock(['/path/to/unknownapp']);
      mockCreateInterface.mockReturnValue(rl as any);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await oneShotCommand('update recharts in unknownapp', {});

      expect(mockParseIntent).toHaveBeenCalledWith(
        'update recharts in unknownapp',
        expect.objectContaining({ repoPath: '/path/to/unknownapp' }),
      );
      consoleSpy.mockRestore();
    });
  });
});
