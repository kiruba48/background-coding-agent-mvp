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

  it('describes desired end-state (build succeeds, tests pass)', () => {
    const result = buildNpmPrompt('lodash', '5.0.0');
    expect(result).toMatch(/build/i);
    expect(result).toMatch(/tests?\s+(pass|succeed)/i);
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

  it('does NOT mention lockfile (lockfile is host-side concern)', () => {
    const result = buildNpmPrompt('lodash', '5.0.0');
    expect(result).not.toMatch(/lock.*file|package-lock|yarn\.lock/i);
  });
});

describe('buildPrompt npm-dependency-update dispatch', () => {
  it('dispatches npm-dependency-update to buildNpmPrompt', () => {
    const result = buildPrompt({
      taskType: 'npm-dependency-update',
      dep: 'lodash',
      targetVersion: '5.0.0',
    });
    expect(result).toContain('lodash');
    expect(result).toContain('5.0.0');
  });

  it('throws when npm-dependency-update is missing dep', () => {
    expect(() =>
      buildPrompt({ taskType: 'npm-dependency-update', targetVersion: '5.0.0' })
    ).toThrow();
  });

  it('throws when npm-dependency-update is missing targetVersion', () => {
    expect(() =>
      buildPrompt({ taskType: 'npm-dependency-update', dep: 'lodash' })
    ).toThrow();
  });
});
