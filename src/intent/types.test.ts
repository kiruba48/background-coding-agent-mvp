import { describe, it, expect } from 'vitest';
import { IntentSchema } from './types.js';

describe('IntentSchema', () => {
  it('accepts a valid IntentResult with high confidence', () => {
    const result = IntentSchema.parse({
      taskType: 'npm-dependency-update',
      dep: 'recharts',
      version: 'latest',
      confidence: 'high',
      createPr: false,
      taskCategory: null,
      project: null,
      clarifications: [],
    });
    expect(result.taskType).toBe('npm-dependency-update');
    expect(result.dep).toBe('recharts');
    expect(result.version).toBe('latest');
    expect(result.confidence).toBe('high');
    expect(result.createPr).toBe(false);
  });

  it('accepts version: null', () => {
    const result = IntentSchema.parse({
      taskType: 'maven-dependency-update',
      dep: 'spring-core',
      version: null,
      confidence: 'low',
      createPr: false,
      taskCategory: null,
      project: null,
      clarifications: [{ label: 'Update spring-core', intent: 'update spring-core to latest' }],
    });
    expect(result.version).toBeNull();
  });

  it('accepts taskType: generic with taskCategory', () => {
    const result = IntentSchema.parse({
      taskType: 'generic',
      dep: null,
      version: null,
      confidence: 'high',
      createPr: false,
      taskCategory: 'refactor',
      project: null,
      clarifications: [],
    });
    expect(result.taskType).toBe('generic');
    expect(result.taskCategory).toBe('refactor');
    expect(result.dep).toBeNull();
  });

  it('accepts taskType: generic with taskCategory: null (analysis/read-only tasks)', () => {
    const result = IntentSchema.parse({
      taskType: 'generic',
      dep: null,
      version: null,
      confidence: 'high',
      createPr: false,
      taskCategory: null,
      project: null,
      clarifications: [],
    });
    expect(result.taskType).toBe('generic');
    expect(result.taskCategory).toBeNull();
  });

  it('rejects taskType: unknown', () => {
    expect(() =>
      IntentSchema.parse({
        taskType: 'unknown',
        dep: null,
        version: null,
        confidence: 'high',
        createPr: false,
        taskCategory: null,
        clarifications: [],
      })
    ).toThrow();
  });

  it('rejects invalid taskCategory', () => {
    expect(() =>
      IntentSchema.parse({
        taskType: 'generic',
        dep: null,
        version: null,
        confidence: 'high',
        createPr: false,
        taskCategory: 'invalid',
        project: null,
        clarifications: [],
      })
    ).toThrow();
  });

  it('rejects version values other than "latest" or null', () => {
    expect(() =>
      IntentSchema.parse({
        taskType: 'npm-dependency-update',
        dep: 'recharts',
        version: '2.15.0',
        confidence: 'high',
        createPr: false,
        taskCategory: null,
        clarifications: [],
      })
    ).toThrow();
  });

  it('rejects invalid taskType', () => {
    expect(() =>
      IntentSchema.parse({
        taskType: 'invalid-type',
        dep: null,
        version: null,
        confidence: 'high',
        createPr: false,
        taskCategory: null,
        clarifications: [],
      })
    ).toThrow();
  });

  it('rejects invalid confidence value', () => {
    expect(() =>
      IntentSchema.parse({
        taskType: 'npm-dependency-update',
        dep: null,
        version: null,
        confidence: 'medium',
        createPr: false,
        taskCategory: null,
        clarifications: [],
      })
    ).toThrow();
  });

  it('accepts clarifications array with label and intent fields', () => {
    const result = IntentSchema.parse({
      taskType: 'npm-dependency-update',
      dep: null,
      version: null,
      confidence: 'low',
      createPr: true,
      taskCategory: null,
      project: null,
      clarifications: [
        { label: 'Update recharts', intent: 'update recharts to latest' },
        { label: 'Update react-chartjs', intent: 'update react-chartjs to latest' },
      ],
    });
    expect(result.clarifications).toHaveLength(2);
    expect(result.clarifications[0].label).toBe('Update recharts');
    expect(result.createPr).toBe(true);
  });
});
