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

  it('describes desired end-state (build succeeds, tests pass)', () => {
    const result = buildMavenPrompt('org.springframework:spring-core', '6.1.0');
    // End-state prompting: should mention build and tests passing
    expect(result).toMatch(/build/i);
    expect(result).toMatch(/tests?\s+(pass|succeed)/i);
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
});

describe('buildPrompt', () => {
  it('dispatches maven-dependency-update to buildMavenPrompt', () => {
    const result = buildPrompt({
      taskType: 'maven-dependency-update',
      dep: 'com.google.guava:guava',
      targetVersion: '33.0.0',
    });
    expect(result).toContain('com.google.guava:guava');
    expect(result).toContain('33.0.0');
  });

  it('throws when maven-dependency-update is missing dep', () => {
    expect(() =>
      buildPrompt({ taskType: 'maven-dependency-update', targetVersion: '1.0' })
    ).toThrow();
  });

  it('throws when maven-dependency-update is missing targetVersion', () => {
    expect(() =>
      buildPrompt({ taskType: 'maven-dependency-update', dep: 'g:a' })
    ).toThrow();
  });

  it('returns generic fallback for unknown task types', () => {
    const result = buildPrompt({ taskType: 'some-other-task' });
    expect(result).toContain('some-other-task');
    expect(result).toContain('Work in the current directory');
  });
});
