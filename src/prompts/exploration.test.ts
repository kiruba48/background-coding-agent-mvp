import { describe, it, expect } from 'vitest';
import { buildExplorationPrompt } from './exploration.js';
import { buildPrompt } from './index.js';

describe('buildExplorationPrompt', () => {
  it('git-strategy subtype contains "FOCUS: Git branching strategy"', () => {
    const prompt = buildExplorationPrompt('explore branching', 'git-strategy');
    expect(prompt).toContain('FOCUS: Git branching strategy');
  });

  it('ci-checks subtype contains "FOCUS: CI/CD pipeline configuration"', () => {
    const prompt = buildExplorationPrompt('explore CI', 'ci-checks');
    expect(prompt).toContain('FOCUS: CI/CD pipeline configuration');
  });

  it('project-structure subtype contains "FOCUS: Project layout"', () => {
    const prompt = buildExplorationPrompt('explore structure', 'project-structure');
    expect(prompt).toContain('FOCUS: Project layout');
  });

  it('general subtype contains "FOCUS: General repository overview"', () => {
    const prompt = buildExplorationPrompt('tell me about this repo', 'general');
    expect(prompt).toContain('FOCUS: General repository overview');
  });

  it('no subtype defaults to "general"', () => {
    const prompt = buildExplorationPrompt('explore CI');
    expect(prompt).toContain('FOCUS: General repository overview');
  });

  it('unknown subtype falls back to "general"', () => {
    const prompt = buildExplorationPrompt('explore CI', 'unknown-type');
    expect(prompt).toContain('FOCUS: General repository overview');
  });

  it('all prompts contain "Do NOT create, edit, or delete any files"', () => {
    for (const subtype of ['git-strategy', 'ci-checks', 'project-structure', 'general']) {
      const prompt = buildExplorationPrompt('explore', subtype);
      expect(prompt).toContain('Do NOT create, edit, or delete any files');
    }
  });

  it('all prompts contain "OUTPUT: Produce a structured markdown report"', () => {
    for (const subtype of ['git-strategy', 'ci-checks', 'project-structure', 'general']) {
      const prompt = buildExplorationPrompt('explore', subtype);
      expect(prompt).toContain('OUTPUT: Produce a structured markdown report');
    }
  });

  it('all 4 subtypes produce distinct FOCUS sections', () => {
    const subtypes = ['git-strategy', 'ci-checks', 'project-structure', 'general'] as const;
    const focusSections = subtypes.map(s => {
      const prompt = buildExplorationPrompt('explore', s);
      const focusMatch = prompt.match(/^FOCUS:.+/m);
      return focusMatch ? focusMatch[0] : '';
    });
    const uniqueSections = new Set(focusSections);
    expect(uniqueSections.size).toBe(4);
  });

  it('includes the description in the prompt', () => {
    const prompt = buildExplorationPrompt('explore the CI configuration', 'ci-checks');
    expect(prompt).toContain('explore the CI configuration');
  });
});

describe('buildPrompt investigation dispatch', () => {
  it('dispatches to buildExplorationPrompt for investigation taskType with ci-checks subtype', async () => {
    const prompt = await buildPrompt({
      taskType: 'investigation',
      description: 'explore CI',
      explorationSubtype: 'ci-checks',
    });
    expect(prompt).toContain('FOCUS: CI/CD pipeline configuration');
  });

  it('dispatches to buildExplorationPrompt for investigation taskType with git-strategy subtype', async () => {
    const prompt = await buildPrompt({
      taskType: 'investigation',
      description: 'explore branching',
      explorationSubtype: 'git-strategy',
    });
    expect(prompt).toContain('FOCUS: Git branching strategy');
  });

  it('throws Error when description is missing for investigation task', async () => {
    await expect(buildPrompt({ taskType: 'investigation' })).rejects.toThrow('description is required');
  });
});
