import { describe, it, expect } from 'vitest';
import { buildNpmPrompt } from './npm.js';
import { buildPrompt } from './index.js';

describe('buildNpmPrompt', () => {
  it('returns a string containing the package name', () => {
    const result = buildNpmPrompt('lodash', '5.0.0');
    expect(result).toContain('lodash');
  });

  it('returns a string containing the target version', () => {
    const result = buildNpmPrompt('lodash', '5.0.0');
    expect(result).toContain('5.0.0');
  });

  it('mentions package.json (not pom.xml)', () => {
    const result = buildNpmPrompt('lodash', '5.0.0');
    expect(result).toContain('package.json');
    expect(result).not.toContain('pom.xml');
  });

  it('describes desired end-state (version updated, compilation succeeds)', () => {
    const result = buildNpmPrompt('lodash', '5.0.0');
    expect(result).toMatch(/version/i);
    expect(result).toMatch(/compilation/i);
  });

  it('mentions fixing breaking API changes', () => {
    const result = buildNpmPrompt('lodash', '5.0.0');
    expect(result).toMatch(/breaking/i);
  });

  it('does NOT contain step-by-step instructions', () => {
    const result = buildNpmPrompt('lodash', '5.0.0');
    expect(result).not.toMatch(/step\s+\d/i);
    expect(result).not.toMatch(/^\d+\.\s/m);
  });

  it('includes "Work in the current directory"', () => {
    const result = buildNpmPrompt('lodash', '5.0.0');
    expect(result).toContain('Work in the current directory');
  });

  it('instructs agent NOT to modify lockfile (lockfile is host-side concern)', () => {
    const result = buildNpmPrompt('lodash', '5.0.0');
    expect(result).toMatch(/package-lock/i);
    expect(result).toMatch(/not|do not/i);
  });

  it('handles "latest" sentinel — says "latest available version" not "version latest"', () => {
    const result = buildNpmPrompt('recharts', 'latest');
    expect(result).toContain('latest available version');
    expect(result).not.toContain('to version latest');
  });

  it('handles "latest" sentinel — prompts agent to find latest from registry', () => {
    const result = buildNpmPrompt('recharts', 'latest');
    expect(result).toMatch(/npm registry|latest/i);
  });

  it('still uses exact version for non-latest versions', () => {
    const result = buildNpmPrompt('lodash', '5.0.0');
    expect(result).toContain('to version 5.0.0');
    expect(result).not.toContain('latest available version');
  });
});

describe('buildPrompt npm-dependency-update dispatch', () => {
  it('dispatches npm-dependency-update to buildNpmPrompt', async () => {
    const result = await buildPrompt({
      taskType: 'npm-dependency-update',
      dep: 'lodash',
      targetVersion: '5.0.0',
    });
    expect(result).toContain('lodash');
    expect(result).toContain('5.0.0');
  });

  it('throws when npm-dependency-update is missing dep', async () => {
    await expect(
      buildPrompt({ taskType: 'npm-dependency-update', targetVersion: '5.0.0' })
    ).rejects.toThrow();
  });

  it('defaults targetVersion to "latest" when omitted for npm-dependency-update', async () => {
    // Should NOT throw — defaults to latest
    const result = await buildPrompt({ taskType: 'npm-dependency-update', dep: 'lodash' });
    expect(result).toContain('latest available version');
  });

  it('handles "latest" sentinel in buildPrompt for npm', async () => {
    const result = await buildPrompt({
      taskType: 'npm-dependency-update',
      dep: 'recharts',
      targetVersion: 'latest',
    });
    expect(result).toContain('latest available version');
  });
});
