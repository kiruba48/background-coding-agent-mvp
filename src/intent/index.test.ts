import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockedFunction } from 'vitest';
import type { FastPathResult } from './types.js';
import type { ProjectRegistry as ProjectRegistryType } from '../agent/registry.js';

// Mock all dependencies before importing parseIntent
vi.mock('./fast-path.js', () => ({
  fastPathParse: vi.fn(),
  validateDepInManifest: vi.fn(),
  detectTaskType: vi.fn(),
}));

vi.mock('./context-scanner.js', () => ({
  readManifestDeps: vi.fn(),
}));

vi.mock('./llm-parser.js', () => ({
  llmParse: vi.fn(),
}));

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

      expect(mockLlmParse).toHaveBeenCalledWith('update recharts', 'package.json dependencies: react, recharts');
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

    it('maps unknown taskType to generic with description field', async () => {
      mockFastPathParse.mockReturnValue(null);
      mockLlmParse.mockResolvedValue({
        taskType: 'unknown',
        dep: null,
        version: null,
        confidence: 'high',
        createPr: false,
        clarifications: [],
      });

      const registry = makeRegistry();
      const result = await parseIntent('fix the login bug', { repoPath: '/path', registry });

      expect(result.taskType).toBe('generic');
      expect(result.description).toBe('fix the login bug');
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
        taskType: 'unknown',
        dep: null,
        version: null,
        confidence: 'low',
        createPr: false,
        clarifications: [], // empty
      });

      const registry = makeRegistry();
      const result = await parseIntent('do something vague', { repoPath: '/path', registry });

      expect(result.clarifications).toBeUndefined();
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
