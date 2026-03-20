import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockedFunction } from 'vitest';
import type { FastPathResult, IntentResult, ResolvedIntent } from './types.js';

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

vi.mock('../agent/registry.js', () => ({
  ProjectRegistry: vi.fn().mockImplementation(() => ({
    resolve: vi.fn().mockReturnValue(undefined),
    list: vi.fn().mockReturnValue({}),
    register: vi.fn(),
    has: vi.fn().mockReturnValue(false),
  })),
}));

import { parseIntent } from './index.js';
import { fastPathParse, validateDepInManifest, detectTaskType } from './fast-path.js';
import { readManifestDeps } from './context-scanner.js';
import { llmParse } from './llm-parser.js';
import { ProjectRegistry } from '../agent/registry.js';

const mockFastPathParse = fastPathParse as MockedFunction<typeof fastPathParse>;
const mockValidateDepInManifest = validateDepInManifest as MockedFunction<typeof validateDepInManifest>;
const mockDetectTaskType = detectTaskType as MockedFunction<typeof detectTaskType>;
const mockReadManifestDeps = readManifestDeps as MockedFunction<typeof readManifestDeps>;
const mockLlmParse = llmParse as MockedFunction<typeof llmParse>;
const MockProjectRegistry = ProjectRegistry as unknown as MockedFunction<() => {
  resolve: MockedFunction<(name: string) => string | undefined>;
  list: MockedFunction<() => Record<string, string>>;
  register: MockedFunction<(name: string, path: string) => void>;
  has: MockedFunction<(name: string) => boolean>;
}>;

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
      clarifications: [],
    });
  });

  describe('fast-path success — no LLM call', () => {
    it('returns high confidence result via fast-path without calling LLM', async () => {
      const fastResult: FastPathResult = { dep: 'recharts', version: 'latest', project: null };
      mockFastPathParse.mockReturnValue(fastResult);
      mockValidateDepInManifest.mockResolvedValue(true);
      mockDetectTaskType.mockResolvedValue('npm-dependency-update');

      const result = await parseIntent('update recharts', { repoPath: '/path/to/repo' });

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
      const fastResult: FastPathResult = { dep: 'recharts', version: '2.0.0', project: null };
      mockFastPathParse.mockReturnValue(fastResult);
      mockValidateDepInManifest.mockResolvedValue(true);
      mockDetectTaskType.mockResolvedValue('npm-dependency-update');

      await parseIntent('update recharts to 2.0.0', { repoPath: '/my/project' });

      expect(mockValidateDepInManifest).toHaveBeenCalledWith('/my/project', 'recharts');
    });
  });

  describe('fast-path fallthrough to LLM', () => {
    it('calls LLM when dep not found in manifest', async () => {
      const fastResult: FastPathResult = { dep: 'unknown-dep', version: 'latest', project: null };
      mockFastPathParse.mockReturnValue(fastResult);
      mockValidateDepInManifest.mockResolvedValue(false); // dep not in manifest

      await parseIntent('update unknown-dep', { repoPath: '/path/to/repo' });

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
          clarifications: [],
        };
      });
      mockFastPathParse.mockReturnValue(null);

      await parseIntent('fix the login bug', { repoPath: '/path' });

      expect(callOrder).toEqual(['readManifestDeps', 'llmParse']);
    });

    it('passes manifest context to llmParse', async () => {
      mockFastPathParse.mockReturnValue(null);
      mockReadManifestDeps.mockResolvedValue('package.json dependencies: react, recharts');

      await parseIntent('update recharts', { repoPath: '/path' });

      expect(mockLlmParse).toHaveBeenCalledWith('update recharts', 'package.json dependencies: react, recharts');
    });

    it('calls LLM when fast-path matched but detectTaskType returns null', async () => {
      const fastResult: FastPathResult = { dep: 'recharts', version: 'latest', project: null };
      mockFastPathParse.mockReturnValue(fastResult);
      mockValidateDepInManifest.mockResolvedValue(true);
      mockDetectTaskType.mockResolvedValue(null); // ambiguous — both or neither manifest

      await parseIntent('update recharts', { repoPath: '/path' });

      expect(mockLlmParse).toHaveBeenCalledOnce();
    });
  });

  describe('full LLM path', () => {
    it('calls LLM when fast-path returns null', async () => {
      mockFastPathParse.mockReturnValue(null);

      const result = await parseIntent('fix the login bug', { repoPath: '/path' });

      expect(mockLlmParse).toHaveBeenCalledOnce();
      expect(result.taskType).toBe('npm-dependency-update'); // from mocked LLM
    });

    it('maps unknown taskType to raw input as generic task', async () => {
      mockFastPathParse.mockReturnValue(null);
      mockLlmParse.mockResolvedValue({
        taskType: 'unknown',
        dep: null,
        version: null,
        confidence: 'high',
        clarifications: [],
      });

      const result = await parseIntent('fix the login bug', { repoPath: '/path' });

      expect(result.taskType).toBe('fix the login bug'); // raw input as task description
    });
  });

  describe('project name resolution from NL', () => {
    it('resolves project name via registry when fast-path extracts it', async () => {
      const mockRegistry = {
        resolve: vi.fn().mockReturnValue('/registered/myapp/path'),
        list: vi.fn().mockReturnValue({ myapp: '/registered/myapp/path' }),
        register: vi.fn(),
        has: vi.fn().mockReturnValue(true),
      };
      MockProjectRegistry.mockImplementation(() => mockRegistry as any);

      const fastResult: FastPathResult = { dep: 'recharts', version: 'latest', project: 'myapp' };
      mockFastPathParse.mockReturnValue(fastResult);
      mockValidateDepInManifest.mockResolvedValue(true);
      mockDetectTaskType.mockResolvedValue('npm-dependency-update');

      const result = await parseIntent('update recharts in myapp', {});

      // Registry is consulted and path resolved
      expect(mockRegistry.resolve).toHaveBeenCalledWith('myapp');
      expect(result.repo).toBe('/registered/myapp/path');
    });

    it('uses options.repoPath over NL project name when both present', async () => {
      const mockRegistry = {
        resolve: vi.fn().mockReturnValue('/from/registry'),
        list: vi.fn().mockReturnValue({}),
        register: vi.fn(),
        has: vi.fn().mockReturnValue(false),
      };
      MockProjectRegistry.mockImplementation(() => mockRegistry as any);

      const fastResult: FastPathResult = { dep: 'recharts', version: 'latest', project: 'myapp' };
      mockFastPathParse.mockReturnValue(fastResult);
      mockValidateDepInManifest.mockResolvedValue(true);
      mockDetectTaskType.mockResolvedValue('npm-dependency-update');

      const result = await parseIntent('update recharts in myapp', { repoPath: '/explicit/path' });

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
        clarifications: [
          { label: 'Update recharts to latest', intent: 'update recharts' },
          { label: 'Update react-charts', intent: 'update react-charts' },
        ],
      });

      const result = await parseIntent('update the chart lib', { repoPath: '/path' });

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
        clarifications: [],
      });

      const result = await parseIntent('update recharts', { repoPath: '/path' });

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
        clarifications: [], // empty
      });

      const result = await parseIntent('do something vague', { repoPath: '/path' });

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

      const fastResult: FastPathResult = { dep: 'recharts', version: 'latest', project: null };
      mockFastPathParse.mockReturnValue(fastResult);
      mockDetectTaskType.mockResolvedValue('npm-dependency-update');

      await parseIntent('update recharts', { repoPath: '/explicit/repo' });

      // validateDepInManifest should be called with the fully resolved path
      expect(callsWithRepoPath[0]).toBe('/explicit/repo');
    });
  });
});
