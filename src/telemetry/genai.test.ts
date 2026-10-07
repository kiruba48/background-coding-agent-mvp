import { describe, it, expect } from 'vitest';
import {
  MAX_CONTENT_CHARS,
  REDACTED,
  UNSERIALIZABLE,
  safeStringify,
  truncate,
  textMessage,
  assistantBlocksToMessage,
  extractToolResults,
  toolResultText,
  toolResultMessage,
  usageAttributes,
  redactMessages,
} from './genai.js';

describe('truncate', () => {
  it('leaves short text untouched', () => {
    expect(truncate('hello')).toBe('hello');
  });

  it('caps long text and reports how much was dropped', () => {
    const long = 'x'.repeat(MAX_CONTENT_CHARS + 500);
    const out = truncate(long);
    expect(out.startsWith('x'.repeat(MAX_CONTENT_CHARS))).toBe(true);
    expect(out.endsWith('[truncated 500 chars]')).toBe(true);
  });
});

describe('textMessage', () => {
  it('builds a single text part and truncates it', () => {
    const msg = textMessage('user', 'y'.repeat(MAX_CONTENT_CHARS + 1));
    expect(msg.role).toBe('user');
    expect(msg.parts).toHaveLength(1);
    expect((msg.parts[0] as { content: string }).content).toContain('[truncated 1 chars]');
  });
});

describe('assistantBlocksToMessage', () => {
  it('maps text and tool_use blocks, drops thinking, infers tool_call finish reason', () => {
    const msg = assistantBlocksToMessage([
      { type: 'thinking' },
      { type: 'text', text: "I'll edit the file." },
      { type: 'tool_use', id: 'toolu_1', name: 'Edit', input: { file_path: 'package.json' } },
    ], 'tool_use');
    expect(msg).toEqual({
      role: 'assistant',
      finish_reason: 'tool_call',
      parts: [
        { type: 'text', content: "I'll edit the file." },
        { type: 'tool_call', id: 'toolu_1', name: 'Edit', arguments: { file_path: 'package.json' } },
      ],
    });
  });

  it('maps end_turn to stop and max_tokens to length', () => {
    expect(assistantBlocksToMessage([{ type: 'text', text: 'done' }], 'end_turn').finish_reason).toBe('stop');
    expect(assistantBlocksToMessage([{ type: 'text', text: '…' }], 'max_tokens').finish_reason).toBe('length');
  });

  it('infers tool_call when stop reason is missing but a tool was called', () => {
    const msg = assistantBlocksToMessage([{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } }], undefined);
    expect(msg.finish_reason).toBe('tool_call');
  });

  it('replaces oversized tool arguments with a truncated JSON string', () => {
    const msg = assistantBlocksToMessage(
      [{ type: 'tool_use', id: 't', name: 'Write', input: { content: 'z'.repeat(MAX_CONTENT_CHARS * 2) } }],
      'tool_use',
    );
    const args = (msg.parts[0] as { arguments: unknown }).arguments;
    expect(typeof args).toBe('string');
    expect(args as string).toContain('[truncated');
  });
});

describe('safeStringify', () => {
  it('stringifies normal objects', () => {
    expect(safeStringify({ a: 1, b: 'x' })).toBe('{"a":1,"b":"x"}');
    expect(safeStringify([1, 2, 3])).toBe('[1,2,3]');
    expect(safeStringify('text')).toBe('"text"');
  });

  it('returns [unserializable] for circular references', () => {
    const circular: any = { a: 1 };
    circular.self = circular;
    expect(safeStringify(circular)).toBe(UNSERIALIZABLE);
  });

  it('returns [unserializable] for BigInt', () => {
    expect(safeStringify(BigInt(123))).toBe(UNSERIALIZABLE);
  });

  it('returns [unserializable] for functions', () => {
    expect(safeStringify(() => 'test')).toBe(UNSERIALIZABLE);
  });
});

describe('tool results', () => {
  it('extracts only well-formed tool_result blocks', () => {
    expect(extractToolResults('plain text')).toEqual([]);
    expect(extractToolResults([
      { type: 'text', text: 'hi' },
      { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
      { type: 'tool_result' },
      null,
    ])).toEqual([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]);
  });

  it('flattens string, block-array and empty content', () => {
    expect(toolResultText('ok')).toBe('ok');
    expect(toolResultText([{ type: 'text', text: 'line 1' }, { type: 'image' }, { type: 'text', text: 'line 2' }]))
      .toBe('line 1\n[image]\nline 2');
    expect(toolResultText(undefined)).toBe('');
    expect(toolResultText({ a: 1 })).toBe('{"a":1}');
  });

  it('returns [unserializable] for circular content in toolResultText', () => {
    const circular: any = { a: 1 };
    circular.self = circular;
    expect(toolResultText(circular)).toBe(UNSERIALIZABLE);
  });

  it('returns [unserializable] for BigInt in toolResultText', () => {
    expect(toolResultText(BigInt(456))).toBe(UNSERIALIZABLE);
  });

  it('builds a tool role message with a truncated response', () => {
    expect(toolResultMessage({ type: 'tool_result', tool_use_id: 't1', content: 'File updated' })).toEqual({
      role: 'tool',
      parts: [{ type: 'tool_call_response', id: 't1', response: 'File updated' }],
    });
  });
});

describe('usageAttributes', () => {
  it('returns nothing without usage', () => {
    expect(usageAttributes(undefined)).toEqual({});
  });

  it('includes cache reads and writes in input tokens, per GenAI semconv', () => {
    expect(usageAttributes({ input_tokens: 600, output_tokens: 120, cache_read_input_tokens: 1800, cache_creation_input_tokens: 0 })).toEqual({
      'gen_ai.usage.input_tokens': 2400,
      'gen_ai.usage.output_tokens': 120,
      'gen_ai.usage.cache_read.input_tokens': 1800,
    });
    expect(usageAttributes({ input_tokens: 10, output_tokens: 1, cache_read_input_tokens: null, cache_creation_input_tokens: 50 })).toEqual({
      'gen_ai.usage.input_tokens': 60,
      'gen_ai.usage.output_tokens': 1,
      'gen_ai.usage.cache_creation.input_tokens': 50,
    });
  });
});

describe('redactMessages', () => {
  it('removes content but keeps roles, tool names, ids and finish reasons', () => {
    const redacted = redactMessages([
      { role: 'assistant', finish_reason: 'tool_call', parts: [
        { type: 'text', content: 'secret plan' },
        { type: 'tool_call', id: 't1', name: 'Edit', arguments: { file_path: '/secret' } },
      ] },
      { role: 'tool', parts: [{ type: 'tool_call_response', id: 't1', response: 'secret output' }] },
    ]);
    expect(redacted).toEqual([
      { role: 'assistant', finish_reason: 'tool_call', parts: [
        { type: 'text', content: REDACTED },
        { type: 'tool_call', id: 't1', name: 'Edit', arguments: REDACTED },
      ] },
      { role: 'tool', parts: [{ type: 'tool_call_response', id: 't1', response: REDACTED }] },
    ]);
  });
});
