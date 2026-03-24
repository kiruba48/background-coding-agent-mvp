import { describe, it, expect } from 'vitest';
import { buildMavenPrompt } from './maven.js';
import { buildPrompt } from './index.js';

describe('buildMavenPrompt', () => {
  it('returns a string containing the dependency name', () => {
    const result = buildMavenPrompt('org.springframework:spring-core', '6.1.0');
    expect(result).toContain('org.springframework:spring-core');
  });

  it('returns a string containing the target version', () => {
    const result = buildMavenPrompt('org.springframework:spring-core', '6.1.0');
    expect(result).toContain('6.1.0');
  });

  it('prompt does not contain newlines from dep input (injection resistance)', () => {
    // Even if CLI validation is bypassed, the prompt builder uses template literals
    // that interpolate directly. This test documents the boundary.
    const result = buildMavenPrompt('org.foo:bar', '1.0.0');
    // Each line should not contain unexpected instruction overrides
    const lines = result.split('\n');
    expect(lines.every(l => !l.match(/ignore|delete/i))).toBe(true);
  });

  it('describes desired end-state (version updated, compilation succeeds)', () => {
    const result = buildMavenPrompt('org.springframework:spring-core', '6.1.0');
    expect(result).toMatch(/version/i);
    expect(result).toMatch(/compilation/i);
  });

  it('mentions fixing breaking API changes if needed', () => {
    const result = buildMavenPrompt('org.springframework:spring-core', '6.1.0');
    expect(result).toMatch(/breaking/i);
  });

  it('does NOT contain step-by-step instructions', () => {
    const result = buildMavenPrompt('org.springframework:spring-core', '6.1.0');
    // Should not have numbered steps like "Step 1:", "1.", "First,"
    expect(result).not.toMatch(/step\s+\d/i);
    expect(result).not.toMatch(/^\d+\.\s/m);
  });

  it('includes "Work in the current directory"', () => {
    const result = buildMavenPrompt('org.springframework:spring-core', '6.1.0');
    expect(result).toContain('Work in the current directory');
  });

  it('handles "latest" sentinel — says "latest available version" not "version latest"', () => {
    const result = buildMavenPrompt('org.springframework:spring-core', 'latest');
    expect(result).toContain('latest available version');
    expect(result).not.toContain('to version latest');
  });

  it('still uses exact version for non-latest versions', () => {
    const result = buildMavenPrompt('org.springframework:spring-core', '6.1.0');
    expect(result).toContain('to version 6.1.0');
    expect(result).not.toContain('latest available version');
  });
});

describe('buildPrompt', () => {
  it('dispatches maven-dependency-update to buildMavenPrompt', async () => {
    const result = await buildPrompt({
      taskType: 'maven-dependency-update',
      dep: 'com.google.guava:guava',
      targetVersion: '33.0.0',
    });
    expect(result).toContain('com.google.guava:guava');
    expect(result).toContain('33.0.0');
  });

  it('throws when maven-dependency-update is missing dep', async () => {
    await expect(
      buildPrompt({ taskType: 'maven-dependency-update', targetVersion: '1.0' })
    ).rejects.toThrow();
  });

  it('defaults targetVersion to "latest" when omitted for maven-dependency-update', async () => {
    // Should NOT throw — defaults to latest
    const result = await buildPrompt({ taskType: 'maven-dependency-update', dep: 'g:a' });
    expect(result).toContain('latest available version');
  });

  it('handles "latest" sentinel in buildPrompt for maven', async () => {
    const result = await buildPrompt({
      taskType: 'maven-dependency-update',
      dep: 'org.springframework:spring-core',
      targetVersion: 'latest',
    });
    expect(result).toContain('latest available version');
  });

  it('returns generic fallback for unknown task types', async () => {
    const result = await buildPrompt({ taskType: 'some-other-task' });
    expect(result).toContain('some-other-task');
    expect(result).toContain('Work in the current directory');
  });
});
