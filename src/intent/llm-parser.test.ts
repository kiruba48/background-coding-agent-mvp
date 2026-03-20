import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ZodError } from 'zod';

// Shared mock for Anthropic client's beta.messages.create method
const mockCreate = vi.fn();

// Mock @anthropic-ai/sdk before importing llm-parser
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: function MockAnthropic() {
      return {
        beta: {
          messages: {
            create: mockCreate,
          },
        },
      };
    },
  };
});

import { llmParse } from './llm-parser.js';

const VALID_RESPONSE = {
  taskType: 'npm-dependency-update',
  dep: 'recharts',
  version: 'latest',
  confidence: 'high',
  clarifications: [],
};

function makeResponse(content: object) {
  return {
    content: [{ type: 'text', text: JSON.stringify(content) }],
  };
}

describe('llmParse', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('returns IntentResult with valid fields', async () => {
    mockCreate.mockResolvedValue(makeResponse(VALID_RESPONSE));
    const result = await llmParse('update recharts', 'package.json dependencies: recharts, lodash');
    expect(result.taskType).toBe('npm-dependency-update');
    expect(result.dep).toBe('recharts');
    expect(result.version).toBe('latest');
    expect(result.confidence).toBe('high');
    expect(result.clarifications).toEqual([]);
  });

  it('throws ZodError when version is a real version string', async () => {
    const invalidResponse = { ...VALID_RESPONSE, version: '2.15.0' };
    mockCreate.mockResolvedValue(makeResponse(invalidResponse));
    await expect(llmParse('update recharts', 'package.json dependencies: recharts')).rejects.toThrow(ZodError);
  });

  it('calls beta.messages.create with correct model', async () => {
    mockCreate.mockResolvedValue(makeResponse(VALID_RESPONSE));
    await llmParse('update recharts', 'package.json dependencies: recharts');
    expect(mockCreate).toHaveBeenCalledOnce();
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.model).toBe('claude-haiku-4-5-20251001');
  });

  it('calls beta.messages.create with structured-outputs beta', async () => {
    mockCreate.mockResolvedValue(makeResponse(VALID_RESPONSE));
    await llmParse('update recharts', 'package.json dependencies: recharts');
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.betas).toContain('structured-outputs-2025-11-13');
  });

  it('includes manifest context in user message wrapped in <manifest_context> tags', async () => {
    mockCreate.mockResolvedValue(makeResponse(VALID_RESPONSE));
    const manifestContext = 'package.json dependencies: recharts, lodash';
    await llmParse('update recharts', manifestContext);
    const callArgs = mockCreate.mock.calls[0][0];
    const userMessage = callArgs.messages[0].content as string;
    expect(userMessage).toContain('<manifest_context>');
    expect(userMessage).toContain('</manifest_context>');
    expect(userMessage).toContain(manifestContext);
  });

  it('passes user input in user message', async () => {
    mockCreate.mockResolvedValue(makeResponse(VALID_RESPONSE));
    await llmParse('update recharts', 'package.json dependencies: recharts');
    const callArgs = mockCreate.mock.calls[0][0];
    const userMessage = callArgs.messages[0].content as string;
    expect(userMessage).toContain('update recharts');
  });

  it('accepts null version in response', async () => {
    const nullVersionResponse = { ...VALID_RESPONSE, version: null, dep: null };
    mockCreate.mockResolvedValue(makeResponse(nullVersionResponse));
    const result = await llmParse('do some refactoring', 'No manifest found');
    expect(result.version).toBeNull();
  });

  it('accepts low confidence with clarifications', async () => {
    const lowConfidenceResponse = {
      taskType: 'npm-dependency-update',
      dep: null,
      version: null,
      confidence: 'low',
      clarifications: [
        { label: 'Update recharts', intent: 'update recharts to latest' },
        { label: 'Update lodash', intent: 'update lodash to latest' },
      ],
    };
    mockCreate.mockResolvedValue(makeResponse(lowConfidenceResponse));
    const result = await llmParse('update the charting library', 'package.json dependencies: recharts, lodash');
    expect(result.confidence).toBe('low');
    expect(result.clarifications).toHaveLength(2);
  });
});
