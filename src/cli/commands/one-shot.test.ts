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

// Mock readline/promises
const mockQuestion = vi.fn();
const mockClose = vi.fn();
const mockRlInstance = {
  question: mockQuestion,
  close: mockClose,
  on: vi.fn(),
};
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn().mockReturnValue(mockRlInstance),
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
const mockAutoRegisterCwd = autoRegisterCwd as MockedFunction<typeof autoRegisterCwd>;
const MockProjectRegistryCtor = ProjectRegistry as unknown as MockedFunction<new () => {
  resolve: MockedFunction<(name: string) => string | undefined>;
  list: MockedFunction<() => Record<string, string>>;
  register: MockedFunction<(name: string, path: string) => void>;
  has: MockedFunction<(name: string) => boolean>;
}>;
const mockCreateInterface = createInterface as MockedFunction<typeof createInterface>;

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

describe('oneShotCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Setup readline mock
    mockCreateInterface.mockReturnValue(mockRlInstance as any);
    mockRlInstance.on.mockImplementation(() => mockRlInstance);
    mockRlInstance.close.mockReset();

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

    // Default: registry with no registered projects
    const registryInstance = makeRegistryInstance();
    MockProjectRegistryCtor.mockImplementation(() => registryInstance as any);
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
      mockQuestion.mockResolvedValueOnce('1'); // user picks option 1

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
      mockQuestion.mockResolvedValueOnce('1'); // user picks option 1

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
      mockQuestion.mockResolvedValueOnce('99'); // invalid choice

      const exitCode = await oneShotCommand('update the chart lib', { repo: '/path' });

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
      MockProjectRegistryCtor.mockImplementation(() => registryInstance as any);
      mockFastPathParse.mockReturnValue(null); // no project in NL

      mockQuestion.mockResolvedValueOnce('1'); // user picks first project

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
      MockProjectRegistryCtor.mockImplementation(() => registryInstance as any);
      mockFastPathParse.mockReturnValue(null);

      mockQuestion.mockResolvedValueOnce('1'); // user picks myapp

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
      MockProjectRegistryCtor.mockImplementation(() => registryInstance as any);
      mockFastPathParse.mockReturnValue(null);

      mockQuestion.mockResolvedValueOnce('/my/local/project'); // user enters path

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
      MockProjectRegistryCtor.mockImplementation(() => registryInstance as any);
      mockFastPathParse.mockReturnValue(null);

      mockQuestion.mockResolvedValueOnce('/my/local/project');

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
      MockProjectRegistryCtor.mockImplementation(() => registryInstance as any);

      // fast-path extracts project name from NL
      mockFastPathParse.mockReturnValue({ dep: 'recharts', version: 'latest', project: 'unknownapp' });

      mockQuestion.mockResolvedValueOnce('/path/to/unknownapp');

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
