import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockedFunction } from 'vitest';
import type { FastPathResult } from './types.js';
import type { ProjectRegistry as ProjectRegistryType } from '../agent/registry.js';
import type { TaskHistoryEntry } from '../repl/types.js';

// Mock all dependencies before importing parseIntent
vi.mock('./fast-path.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./fast-path.js')>();
  return {
    ...actual,
    fastPathParse: vi.fn(),
    validateDepInManifest: vi.fn(),
    detectTaskType: vi.fn(),
  };
});

vi.mock('./context-scanner.js', () => ({
  readManifestDeps: vi.fn(),
}));

vi.mock('./llm-parser.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./llm-parser.js')>();
  return {
    ...actual,
    llmParse: vi.fn(),
  };
});

import { parseIntent } from './index.js';
import { fastPathParse, validateDepInManifest, detectTaskType } from './fast-path.js';
import { readManifestDeps } from './context-scanner.js';
import { llmParse } from './llm-parser.js';

const mockFastPathParse = fastPathParse as MockedFunction<typeof fastPathParse>;
const mockValidateDepInManifest = validateDepInManifest as MockedFunction<typeof validateDepInManifest>;
const mockDetectTaskType = detectTaskType as MockedFunction<typeof detectTaskType>;
const mockReadManifestDeps = readManifestDeps as MockedFunction<typeof readManifestDeps>;
const mockLlmParse = llmParse as MockedFunction<typeof llmParse>;

/** Create a stub registry instance for injection via ParseOptions.registry */
function makeRegistry(overrides: Partial<{
  resolve: (name: string) => string | undefined;
  list: () => Record<string, string>;
  register: (name: string, path: string) => void;
  has: (name: string) => boolean;
}> = {}): ProjectRegistryType {
  return {
    resolve: vi.fn().mockReturnValue(undefined),
    list: vi.fn().mockReturnValue({}),
    register: vi.fn(),
    has: vi.fn().mockReturnValue(false),
    remove: vi.fn().mockReturnValue(false),
    configPath: '/tmp/test-registry',
    ...overrides,
  } as unknown as ProjectRegistryType;
}

describe('parseIntent coordinator', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: fast-path returns null, LLM returns a result
    mockFastPathParse.mockReturnValue(null);
    mockValidateDepInManifest.mockResolvedValue(false);
    mockDetectTaskType.mockResolvedValue(null);
    mockReadManifestDeps.mockResolvedValue('package.json dependencies: react, recharts');
    mockLlmParse.mockResolvedValue({
      taskType: 'npm-dependency-update',
      dep: 'recharts',
      version: 'latest',
      confidence: 'high',
      createPr: false,
      taskCategory: null,
      clarifications: [],
    });
  });

  describe('fast-path success — no LLM call', () => {
    it('returns high confidence result via fast-path without calling LLM', async () => {
      const fastResult: FastPathResult = { dep: 'recharts', version: 'latest', project: null, createPr: false };
      mockFastPathParse.mockReturnValue(fastResult);
      mockValidateDepInManifest.mockResolvedValue(true);
      mockDetectTaskType.mockResolvedValue('npm-dependency-update');

      const registry = makeRegistry();
      const result = await parseIntent('update recharts', { repoPath: '/path/to/repo', registry });

      expect(result.taskType).toBe('npm-dependency-update');
      expect(result.dep).toBe('recharts');
      expect(result.version).toBe('latest');
      expect(result.confidence).toBe('high');
      expect(result.repo).toBe('/path/to/repo');

      // CRITICAL: LLM must NOT be called on fast-path success
      expect(mockLlmParse).not.toHaveBeenCalled();
      expect(mockReadManifestDeps).not.toHaveBeenCalled();
    });

    it('uses the repo path from options for manifest validation', async () => {
      const fastResult: FastPathResult = { dep: 'recharts', version: '2.0.0', project: null, createPr: false };
      mockFastPathParse.mockReturnValue(fastResult);
      mockValidateDepInManifest.mockResolvedValue(true);
      mockDetectTaskType.mockResolvedValue('npm-dependency-update');

      const registry = makeRegistry();
      await parseIntent('update recharts to 2.0.0', { repoPath: '/my/project', registry });

      expect(mockValidateDepInManifest).toHaveBeenCalledWith('/my/project', 'recharts');
    });
  });

  describe('fast-path fallthrough to LLM', () => {
    it('calls LLM when dep not found in manifest', async () => {
      const fastResult: FastPathResult = { dep: 'unknown-dep', version: 'latest', project: null, createPr: false };
      mockFastPathParse.mockReturnValue(fastResult);
      mockValidateDepInManifest.mockResolvedValue(false); // dep not in manifest

      const registry = makeRegistry();
      await parseIntent('update unknown-dep', { repoPath: '/path/to/repo', registry });

      expect(mockLlmParse).toHaveBeenCalledOnce();
    });

    it('reads manifest context BEFORE calling llmParse (INTENT-03 ordering)', async () => {
      const callOrder: string[] = [];
      mockReadManifestDeps.mockImplementation(async () => {
        callOrder.push('readManifestDeps');
        return 'some deps';
      });
      mockLlmParse.mockImplementation(async () => {
        callOrder.push('llmParse');
        return {
          taskType: 'npm-dependency-update' as const,
          dep: 'recharts',
          version: null,
          confidence: 'high' as const,
          createPr: false,
          taskCategory: null,
          clarifications: [],
        };
      });
      mockFastPathParse.mockReturnValue(null);

      const registry = makeRegistry();
      await parseIntent('fix the login bug', { repoPath: '/path', registry });

      expect(callOrder).toEqual(['readManifestDeps', 'llmParse']);
    });

    it('passes manifest context to llmParse', async () => {
      mockFastPathParse.mockReturnValue(null);
      mockReadManifestDeps.mockResolvedValue('package.json dependencies: react, recharts');

      const registry = makeRegistry();
      await parseIntent('update recharts', { repoPath: '/path', registry });

      expect(mockLlmParse).toHaveBeenCalledWith('update recharts', 'package.json dependencies: react, recharts', undefined);
    });

    it('calls LLM when fast-path matched but detectTaskType returns null', async () => {
      const fastResult: FastPathResult = { dep: 'recharts', version: 'latest', project: null, createPr: false };
      mockFastPathParse.mockReturnValue(fastResult);
      mockValidateDepInManifest.mockResolvedValue(true);
      mockDetectTaskType.mockResolvedValue(null); // ambiguous — both or neither manifest

      const registry = makeRegistry();
      await parseIntent('update recharts', { repoPath: '/path', registry });

      expect(mockLlmParse).toHaveBeenCalledOnce();
    });
  });

  describe('full LLM path', () => {
    it('calls LLM when fast-path returns null', async () => {
      mockFastPathParse.mockReturnValue(null);

      const registry = makeRegistry();
      const result = await parseIntent('fix the login bug', { repoPath: '/path', registry });

      expect(mockLlmParse).toHaveBeenCalledOnce();
      expect(result.taskType).toBe('npm-dependency-update'); // from mocked LLM
    });

    it('passes through generic taskType with description and taskCategory', async () => {
      mockFastPathParse.mockReturnValue(null);
      mockLlmParse.mockResolvedValue({
        taskType: 'generic',
        dep: null,
        version: null,
        confidence: 'high',
        createPr: false,
        taskCategory: 'refactor',
        clarifications: [],
      });

      const registry = makeRegistry();
      const result = await parseIntent('fix the login bug', { repoPath: '/path', registry });

      expect(result.taskType).toBe('generic');
      expect(result.description).toBe('fix the login bug');
      expect(result.taskCategory).toBe('refactor');
    });
  });

  describe('project name resolution from NL', () => {
    it('resolves project name via registry when fast-path extracts it', async () => {
      const registry = makeRegistry({
        resolve: vi.fn().mockReturnValue('/registered/myapp/path'),
        list: vi.fn().mockReturnValue({ myapp: '/registered/myapp/path' }),
        has: vi.fn().mockReturnValue(true),
      });

      const fastResult: FastPathResult = { dep: 'recharts', version: 'latest', project: 'myapp', createPr: false };
      mockFastPathParse.mockReturnValue(fastResult);
      mockValidateDepInManifest.mockResolvedValue(true);
      mockDetectTaskType.mockResolvedValue('npm-dependency-update');

      const result = await parseIntent('update recharts in myapp', { registry });

      // Registry is consulted and path resolved
      expect((registry.resolve as MockedFunction<typeof registry.resolve>)).toHaveBeenCalledWith('myapp');
      expect(result.repo).toBe('/registered/myapp/path');
    });

    it('uses options.repoPath over NL project name when both present', async () => {
      const registry = makeRegistry({
        resolve: vi.fn().mockReturnValue('/from/registry'),
      });

      const fastResult: FastPathResult = { dep: 'recharts', version: 'latest', project: 'myapp', createPr: false };
      mockFastPathParse.mockReturnValue(fastResult);
      mockValidateDepInManifest.mockResolvedValue(true);
      mockDetectTaskType.mockResolvedValue('npm-dependency-update');

      const result = await parseIntent('update recharts in myapp', { repoPath: '/explicit/path', registry });

      // Explicit repoPath takes priority
      expect(result.repo).toBe('/explicit/path');
    });
  });

  describe('clarifications passthrough', () => {
    it('passes clarifications from LLM result when confidence is low', async () => {
      mockFastPathParse.mockReturnValue(null);
      mockLlmParse.mockResolvedValue({
        taskType: 'npm-dependency-update',
        dep: 'recharts',
        version: null,
        confidence: 'low',
        createPr: false,
        taskCategory: null,
        clarifications: [
          { label: 'Update recharts to latest', intent: 'update recharts' },
          { label: 'Update react-charts', intent: 'update react-charts' },
        ],
      });

      const registry = makeRegistry();
      const result = await parseIntent('update the chart lib', { repoPath: '/path', registry });

      expect(result.confidence).toBe('low');
      expect(result.clarifications).toEqual([
        { label: 'Update recharts to latest', intent: 'update recharts' },
        { label: 'Update react-charts', intent: 'update react-charts' },
      ]);
    });

    it('sets clarifications to undefined when confidence is high', async () => {
      mockFastPathParse.mockReturnValue(null);
      mockLlmParse.mockResolvedValue({
        taskType: 'npm-dependency-update',
        dep: 'recharts',
        version: 'latest',
        confidence: 'high',
        createPr: false,
        taskCategory: null,
        clarifications: [],
      });

      const registry = makeRegistry();
      const result = await parseIntent('update recharts', { repoPath: '/path', registry });

      expect(result.confidence).toBe('high');
      expect(result.clarifications).toBeUndefined();
    });

    it('sets clarifications to undefined when LLM returns low confidence but empty clarifications', async () => {
      mockFastPathParse.mockReturnValue(null);
      mockLlmParse.mockResolvedValue({
        taskType: 'generic',
        dep: null,
        version: null,
        confidence: 'low',
        createPr: false,
        taskCategory: 'code-change',
        clarifications: [], // empty
      });

      const registry = makeRegistry();
      const result = await parseIntent('do something vague', { repoPath: '/path', registry });

      expect(result.clarifications).toBeUndefined();
    });
  });

  describe('session history threading (multi-turn follow-up)', () => {
    const historyEntry: TaskHistoryEntry = {
      taskType: 'npm-dependency-update',
      dep: 'react',
      version: 'latest',
      repo: '/path/to/repo',
      status: 'success',
    };

    it('follow-up with history: inherits taskType and repo, sets inheritedFields', async () => {
      const followUpResult: FastPathResult = { dep: 'lodash', version: 'latest', project: null, createPr: false, isFollowUp: true };
      mockFastPathParse.mockReturnValue(followUpResult);
      mockValidateDepInManifest.mockResolvedValue(true);
      mockDetectTaskType.mockResolvedValue('npm-dependency-update');

      const registry = makeRegistry();
      const result = await parseIntent('also update lodash', {
        repoPath: undefined,
        registry,
        history: [historyEntry],
      });

      expect(result.taskType).toBe('npm-dependency-update');
      expect(result.dep).toBe('lodash');
      expect(result.inheritedFields).toEqual(['taskType', 'repo']);
      expect(result.inheritedFields?.includes('taskType')).toBe(true);
      expect(result.inheritedFields?.includes('repo')).toBe(true);
      expect(mockLlmParse).not.toHaveBeenCalled();
    });

    it('follow-up with empty history: strips prefix and re-parses as fresh command', async () => {
      // First call with follow-up prefix → stripped, recursive call with standard "update lodash"
      const followUpResult: FastPathResult = { dep: 'lodash', version: 'latest', project: null, createPr: false, isFollowUp: true };
      const standardResult: FastPathResult = { dep: 'lodash', version: 'latest', project: null, createPr: false };
      mockFastPathParse
        .mockReturnValueOnce(followUpResult)  // first call: "also update lodash"
        .mockReturnValueOnce(standardResult); // second call: "update lodash" (stripped)
      mockValidateDepInManifest.mockResolvedValue(true);
      mockDetectTaskType.mockResolvedValue('npm-dependency-update');

      const registry = makeRegistry();
      const result = await parseIntent('also update lodash', {
        repoPath: '/some/repo',
        registry,
        history: [],  // empty history
      });

      // Should have re-parsed without inheritedFields
      expect(result.inheritedFields).toBeUndefined();
      expect(mockLlmParse).not.toHaveBeenCalled();
    });

    it('standard input with history: does NOT set inheritedFields', async () => {
      const standardResult: FastPathResult = { dep: 'recharts', version: 'latest', project: null, createPr: false };
      mockFastPathParse.mockReturnValue(standardResult);
      mockValidateDepInManifest.mockResolvedValue(true);
      mockDetectTaskType.mockResolvedValue('npm-dependency-update');

      const registry = makeRegistry();
      const result = await parseIntent('update recharts', {
        repoPath: '/path/to/repo',
        registry,
        history: [historyEntry],
      });

      expect(result.inheritedFields).toBeUndefined();
    });

    it('follow-up falls through to LLM when dep not in manifest: passes history to llmParse', async () => {
      const followUpResult: FastPathResult = { dep: 'unknown-dep', version: 'latest', project: null, createPr: false, isFollowUp: true };
      mockFastPathParse.mockReturnValue(followUpResult);
      mockValidateDepInManifest.mockResolvedValue(false); // dep NOT in manifest
      mockReadManifestDeps.mockResolvedValue('package.json dependencies: react');

      const registry = makeRegistry();
      await parseIntent('also update unknown-dep', {
        repoPath: '/path/to/repo',
        registry,
        history: [historyEntry],
      });

      // LLM should be called with history
      expect(mockLlmParse).toHaveBeenCalledOnce();
      const llmCallArgs = mockLlmParse.mock.calls[0];
      expect(llmCallArgs[2]).toEqual([historyEntry]);
    });
  });

  describe('repo path resolution', () => {
    it('resolves repo path before running manifest check (Pitfall 4 order)', async () => {
      const callsWithRepoPath: string[] = [];
      mockValidateDepInManifest.mockImplementation(async (repoPath: string) => {
        callsWithRepoPath.push(repoPath);
        return true;
      });

      const fastResult: FastPathResult = { dep: 'recharts', version: 'latest', project: null, createPr: false };
      mockFastPathParse.mockReturnValue(fastResult);
      mockDetectTaskType.mockResolvedValue('npm-dependency-update');

      const registry = makeRegistry();
      await parseIntent('update recharts', { repoPath: '/explicit/repo', registry });

      // validateDepInManifest should be called with the fully resolved path
      expect(callsWithRepoPath[0]).toBe('/explicit/repo');
    });
  });
});
