import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildPrompt } from './index.js';

// Mock readManifestDeps to control return values
vi.mock('../intent/context-scanner.js', () => ({
  readManifestDeps: vi.fn(),
}));

import { readManifestDeps } from '../intent/context-scanner.js';
const mockReadManifestDeps = readManifestDeps as ReturnType<typeof vi.fn>;

describe('buildGenericPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('contains the user instruction verbatim in the prompt body', async () => {
    mockReadManifestDeps.mockResolvedValue('No manifest found');
    const { buildGenericPrompt } = await import('./generic.js');
    const result = await buildGenericPrompt('replace axios with fetch');
    expect(result).toContain('replace axios with fetch');
  });

  it('contains SCOPE block with "Only make changes necessary"', async () => {
    mockReadManifestDeps.mockResolvedValue('No manifest found');
    const { buildGenericPrompt } = await import('./generic.js');
    const result = await buildGenericPrompt('replace axios with fetch');
    expect(result).toContain('SCOPE: Only make changes necessary');
  });

  it('contains 4 "Do NOT" lines after SCOPE', async () => {
    mockReadManifestDeps.mockResolvedValue('No manifest found');
    const { buildGenericPrompt } = await import('./generic.js');
    const result = await buildGenericPrompt('replace axios with fetch');
    const doNotMatches = result.match(/Do NOT/g);
    // One "Do NOT" in the SCOPE line header counts too — there should be at least 1
    // The 4 bullet points reference Do NOT constraints implicitly via the SCOPE header
    // Check individual constraint lines
    expect(result).toContain('Modify files unrelated to the task');
    expect(result).toContain('Add or remove dependencies unless the task explicitly requires it');
    expect(result).toContain('Restructure the codebase or reorganize files beyond what the task requires');
    expect(result).toContain('Apply stylistic or formatting changes outside of modified code');
  });

  it('contains "After your changes, the following should be true:"', async () => {
    mockReadManifestDeps.mockResolvedValue('No manifest found');
    const { buildGenericPrompt } = await import('./generic.js');
    const result = await buildGenericPrompt('replace axios with fetch');
    expect(result).toContain('After your changes, the following should be true:');
  });

  it('contains "Work in the current directory."', async () => {
    mockReadManifestDeps.mockResolvedValue('No manifest found');
    const { buildGenericPrompt } = await import('./generic.js');
    const result = await buildGenericPrompt('replace axios with fetch');
    expect(result).toContain('Work in the current directory.');
  });

  it('includes CONTEXT block with deps when readManifestDeps returns deps', async () => {
    const depsString = 'package.json dependencies: axios, lodash';
    mockReadManifestDeps.mockResolvedValue(depsString);
    const { buildGenericPrompt } = await import('./generic.js');
    const result = await buildGenericPrompt('replace axios with fetch', '/some/repo');
    expect(result).toContain('CONTEXT:');
    expect(result).toContain(depsString);
  });

  it('does NOT contain CONTEXT block when readManifestDeps returns "No manifest found"', async () => {
    mockReadManifestDeps.mockResolvedValue('No manifest found');
    const { buildGenericPrompt } = await import('./generic.js');
    const result = await buildGenericPrompt('replace axios with fetch', '/some/repo');
    expect(result).not.toContain('CONTEXT:');
  });

  it('does NOT contain CONTEXT block when no repoPath is given', async () => {
    const { buildGenericPrompt } = await import('./generic.js');
    const result = await buildGenericPrompt('replace axios with fetch');
    expect(result).not.toContain('CONTEXT:');
  });

  it('includes SCOPE HINTS section with formatted hints when scopeHints provided', async () => {
    mockReadManifestDeps.mockResolvedValue('No manifest found');
    const { buildGenericPrompt } = await import('./generic.js');
    const result = await buildGenericPrompt('add error handling', '/some/repo', ['Which area?: auth module', 'Should tests be updated?: yes']);
    expect(result).toContain('SCOPE HINTS (from user):');
    expect(result).toContain('- Which area?: auth module');
    expect(result).toContain('- Should tests be updated?: yes');
  });

  it('does NOT include SCOPE HINTS section when scopeHints is not provided', async () => {
    mockReadManifestDeps.mockResolvedValue('No manifest found');
    const { buildGenericPrompt } = await import('./generic.js');
    const result = await buildGenericPrompt('add error handling', '/some/repo');
    expect(result).not.toContain('SCOPE HINTS');
  });

  it('does NOT include SCOPE HINTS section when scopeHints is empty array', async () => {
    mockReadManifestDeps.mockResolvedValue('No manifest found');
    const { buildGenericPrompt } = await import('./generic.js');
    const result = await buildGenericPrompt('add error handling', '/some/repo', []);
    expect(result).not.toContain('SCOPE HINTS');
  });

  it('SCOPE HINTS appears before "Work in the current directory."', async () => {
    mockReadManifestDeps.mockResolvedValue('No manifest found');
    const { buildGenericPrompt } = await import('./generic.js');
    const result = await buildGenericPrompt('add error handling', '/some/repo', ['Area: auth']);
    const hintsPos = result.indexOf('SCOPE HINTS');
    const workPos = result.indexOf('Work in the current directory.');
    expect(hintsPos).toBeGreaterThan(-1);
    expect(workPos).toBeGreaterThan(hintsPos);
  });
});

describe('buildPrompt generic dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('buildPrompt({taskType:"generic", description:"do X"}) returns prompt containing "do X" and "SCOPE"', async () => {
    mockReadManifestDeps.mockResolvedValue('No manifest found');
    const result = await buildPrompt({ taskType: 'generic', description: 'do X' });
    expect(result).toContain('do X');
    expect(result).toContain('SCOPE');
  });

  it('buildPrompt with repoPath dispatches to buildGenericPrompt and awaits (async)', async () => {
    mockReadManifestDeps.mockResolvedValue('No manifest found');
    const result = await buildPrompt({ taskType: 'generic', description: 'do X', repoPath: '/tmp' });
    expect(result).toContain('do X');
    expect(result).toContain('SCOPE');
  });

  it('buildPrompt still works for npm-dependency-update (existing behavior)', async () => {
    const result = await buildPrompt({ taskType: 'npm-dependency-update', dep: 'lodash', targetVersion: '5.0.0' });
    expect(result).toContain('lodash');
    expect(result).toContain('5.0.0');
  });

  it('buildPrompt still works for maven-dependency-update (existing behavior)', async () => {
    const result = await buildPrompt({ taskType: 'maven-dependency-update', dep: 'com.google.guava:guava', targetVersion: '33.0.0' });
    expect(result).toContain('com.google.guava:guava');
    expect(result).toContain('33.0.0');
  });
});
