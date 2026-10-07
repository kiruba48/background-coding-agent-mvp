import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api';
import type { InMemorySpanExporter, ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { getTracer, installTestTracing, resetTracingForTests } from './tracing.js';
import { SessionSpanRecorder } from './session-recorder.js';
import { MAX_CONTENT_CHARS } from './genai.js';
import type { SessionResult } from '../types.js';

const BASE = 1_760_000_000_000; // epoch ms — OTel treats large numbers as wall-clock time

function clock() {
  let t = BASE;
  return () => (t += 100);
}

const init = { type: 'system', subtype: 'init', model: 'claude-sonnet-5-5', tools: ['Read', 'Edit', 'Bash'], session_id: 's' };
function assistant(id: string, content: unknown[], stopReason: string | null = null, usage?: object) {
  return {
    type: 'assistant', parent_tool_use_id: null, session_id: 's',
    message: { id, model: 'claude-sonnet-5-5', role: 'assistant', content, stop_reason: stopReason, usage },
  };
}
function toolResult(id: string, content: unknown, isError = false) {
  return {
    type: 'user', parent_tool_use_id: null, session_id: 's',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
  };
}
const resultMsg = { type: 'result', subtype: 'success', total_cost_usd: 0.0153, num_turns: 2, result: 'Bumped lodash.' };
function sessionResult(overrides: Partial<SessionResult> = {}): SessionResult {
  return { sessionId: 'sess', status: 'success', toolCallCount: 1, duration: 1000, finalResponse: 'Bumped lodash.', ...overrides };
}

const named = (spans: ReadableSpan[], name: string) => spans.filter((s) => s.name === name);
const json = (span: ReadableSpan, key: string) => JSON.parse(String(span.attributes[key]));

let exporter: InMemorySpanExporter;
beforeEach(() => {
  exporter = installTestTracing();
});
afterEach(async () => {
  await resetTracingForTests();
});

describe('SessionSpanRecorder', () => {
  it('records chat and tool spans for a full agent loop under the session span', () => {
    const parent = getTracer().startSpan('attempt 1');
    const recorder = new SessionSpanRecorder('Update lodash', trace.setSpan(ROOT_CONTEXT, parent), { now: clock() });

    recorder.onMessage(init);
    recorder.onMessage(assistant('m1', [
      { type: 'text', text: "I'll update package.json." },
      { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'package.json' } },
    ], 'tool_use', { input_tokens: 600, output_tokens: 120, cache_read_input_tokens: 1800, cache_creation_input_tokens: 0 }));
    recorder.onMessage(toolResult('t1', 'File updated'));
    recorder.onMessage(assistant('m2', [{ type: 'text', text: 'Bumped lodash.' }], 'end_turn', { input_tokens: 50, output_tokens: 10 }));
    recorder.onMessage(resultMsg);
    recorder.finish(sessionResult());
    parent.end();

    const spans = exporter.getFinishedSpans();
    const [session] = named(spans, 'invoke_agent claude-code');
    const chats = named(spans, 'chat claude-sonnet-5-5');
    const [tool] = named(spans, 'execute_tool Edit');

    expect(session.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(chats).toHaveLength(2);
    for (const span of [...chats, tool]) expect(span.parentSpanContext?.spanId).toBe(session.spanContext().spanId);

    expect(session.attributes).toMatchObject({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.provider.name': 'anthropic',
      'gen_ai.request.model': 'claude-sonnet-5-5',
      'bg_agent.cost_usd': 0.0153,
      'bg_agent.num_turns': 2,
      'bg_agent.session_status': 'success',
      'bg_agent.available_tools': ['Read', 'Edit', 'Bash'],
    });
    expect(json(session, 'gen_ai.input.messages')[0].parts[0].content).toBe('Update lodash');
    expect(json(session, 'gen_ai.output.messages')[0].parts[0].content).toBe('Bumped lodash.');

    expect(chats[0].attributes).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.usage.input_tokens': 2400,
      'gen_ai.usage.output_tokens': 120,
      'gen_ai.usage.cache_read.input_tokens': 1800,
    });
    expect(json(chats[0], 'gen_ai.input.messages')[0].parts[0].content).toBe('Update lodash');
    expect(json(chats[0], 'gen_ai.output.messages')[0].parts[1]).toEqual(
      { type: 'tool_call', id: 't1', name: 'Edit', arguments: { file_path: 'package.json' } },
    );
    // Second turn's input is the tool result that came back.
    expect(json(chats[1], 'gen_ai.input.messages')).toEqual([
      { role: 'tool', parts: [{ type: 'tool_call_response', id: 't1', response: 'File updated' }] },
    ]);

    expect(tool.attributes).toMatchObject({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'Edit',
      'gen_ai.tool.call.id': 't1',
      'gen_ai.tool.call.arguments': '{"file_path":"package.json"}',
      'gen_ai.tool.call.result': 'File updated',
    });
    // Ordering: chat1 ends before the tool starts; the tool ends before chat2 ends.
    const ms = (t: [number, number]) => t[0] * 1000 + t[1] / 1e6;
    expect(ms(tool.startTime)).toBeGreaterThanOrEqual(ms(chats[0].endTime));
    expect(ms(tool.endTime)).toBeLessThanOrEqual(ms(chats[1].endTime));
  });

  it('merges consecutive assistant messages that share a message id into one chat span', () => {
    const recorder = new SessionSpanRecorder('task', ROOT_CONTEXT, { now: clock() });
    recorder.onMessage(assistant('m1', [{ type: 'text', text: 'Reading.' }]));
    recorder.onMessage(assistant('m1', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.ts' } }], 'tool_use'));
    recorder.onMessage(toolResult('t1', 'contents'));
    recorder.finish(sessionResult());

    const spans = exporter.getFinishedSpans();
    const chats = spans.filter((s) => s.name.startsWith('chat '));
    expect(chats).toHaveLength(1);
    expect(json(chats[0], 'gen_ai.output.messages')[0].parts.map((p: { type: string }) => p.type)).toEqual(['text', 'tool_call']);
    expect(named(spans, 'execute_tool Read')).toHaveLength(1);
  });

  it('marks tool spans as errors when the tool result is an error', () => {
    const recorder = new SessionSpanRecorder('task', ROOT_CONTEXT, { now: clock() });
    recorder.onMessage(assistant('m1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }], 'tool_use'));
    recorder.onMessage(toolResult('t1', 'exit code 1', true));
    recorder.finish(sessionResult());

    const [tool] = named(exporter.getFinishedSpans(), 'execute_tool Bash');
    expect(tool.status.code).toBe(SpanStatusCode.ERROR);
    expect(tool.attributes['error.type']).toBe('tool_error');
  });

  it('closes tools that never returned as incomplete errors', () => {
    const recorder = new SessionSpanRecorder('task', ROOT_CONTEXT, { now: clock() });
    recorder.onMessage(assistant('m1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 999' } }], 'tool_use'));
    recorder.finish(sessionResult({ status: 'timeout', finalResponse: '', error: 'Session timeout reached' }));

    const spans = exporter.getFinishedSpans();
    const [tool] = named(spans, 'execute_tool Bash');
    const [session] = named(spans, 'invoke_agent claude-code');
    expect(tool.attributes['error.type']).toBe('incomplete');
    expect(tool.status.code).toBe(SpanStatusCode.ERROR);
    expect(session.status.code).toBe(SpanStatusCode.ERROR);
    expect(session.attributes['error.type']).toBe('timeout');
    expect(json(session, 'gen_ai.output.messages')[0].parts[0].content).toBe('[timeout] Session timeout reached');
  });

  it('does not mark cancelled sessions as errors', () => {
    const recorder = new SessionSpanRecorder('task', ROOT_CONTEXT, { now: clock() });
    recorder.finish(sessionResult({ status: 'cancelled', finalResponse: '', error: 'Session cancelled via AbortSignal' }));
    const [session] = named(exporter.getFinishedSpans(), 'invoke_agent claude-code');
    expect(session.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('ignores subagent traffic (parent_tool_use_id set)', () => {
    const recorder = new SessionSpanRecorder('task', ROOT_CONTEXT, { now: clock() });
    recorder.onMessage({ ...assistant('sub1', [{ type: 'text', text: 'subagent' }]), parent_tool_use_id: 'task_1' });
    recorder.finish(sessionResult());
    expect(exporter.getFinishedSpans().filter((s) => s.name.startsWith('chat '))).toHaveLength(0);
  });

  it('truncates very large tool results', () => {
    const recorder = new SessionSpanRecorder('task', ROOT_CONTEXT, { now: clock() });
    recorder.onMessage(assistant('m1', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'big.json' } }], 'tool_use'));
    recorder.onMessage(toolResult('t1', 'r'.repeat(MAX_CONTENT_CHARS * 3)));
    recorder.finish(sessionResult());
    const [tool] = named(exporter.getFinishedSpans(), 'execute_tool Read');
    const result = String(tool.attributes['gen_ai.tool.call.result']);
    expect(result.length).toBeLessThan(MAX_CONTENT_CHARS + 100);
    expect(result).toContain('[truncated');
  });

  it('does not export raw error text in the session status when capture is off', async () => {
    await resetTracingForTests();
    exporter = installTestTracing({ captureContent: false });
    const recorder = new SessionSpanRecorder('t', ROOT_CONTEXT, { now: clock() });
    recorder.finish(sessionResult({ status: 'failed', finalResponse: '', error: 'leaky secret-path error' }));
    const [session] = named(exporter.getFinishedSpans(), 'invoke_agent claude-code');
    expect(session.status.code).toBe(SpanStatusCode.ERROR);
    expect(session.attributes['error.type']).toBe('failed');
    expect(JSON.stringify(session.status)).not.toContain('secret-path');
  });

  it('redacts content but keeps structure when capture is off', async () => {
    await resetTracingForTests();
    exporter = installTestTracing({ captureContent: false });
    const recorder = new SessionSpanRecorder('secret task', ROOT_CONTEXT, { now: clock() });
    recorder.onMessage(assistant('m1', [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/secret' } }], 'tool_use'));
    recorder.onMessage(toolResult('t1', 'secret output'));
    recorder.finish(sessionResult({ finalResponse: 'secret answer' }));

    const spans = exporter.getFinishedSpans();
    const [tool] = named(spans, 'execute_tool Edit');
    const [session] = named(spans, 'invoke_agent claude-code');
    const serialized = JSON.stringify(spans.map((s) => s.attributes));
    expect(serialized).not.toContain('secret');
    expect(tool.attributes['gen_ai.tool.name']).toBe('Edit');
    expect(tool.attributes['gen_ai.tool.call.arguments']).toBe('[redacted]');
    expect(json(session, 'gen_ai.input.messages')[0].parts[0].content).toBe('[redacted]');
  });

  it('keeps concurrent sessions under their own parents', () => {
    const parentA = getTracer().startSpan('run A');
    const parentB = getTracer().startSpan('run B');
    const a = new SessionSpanRecorder('A', trace.setSpan(ROOT_CONTEXT, parentA), { now: clock() });
    const b = new SessionSpanRecorder('B', trace.setSpan(ROOT_CONTEXT, parentB), { now: clock() });
    a.onMessage(assistant('ma', [{ type: 'text', text: 'a' }]));
    b.onMessage(assistant('mb', [{ type: 'text', text: 'b' }]));
    a.finish(sessionResult());
    b.finish(sessionResult());

    const spans = exporter.getFinishedSpans();
    const sessions = named(spans, 'invoke_agent claude-code');
    const sessionA = sessions.find((s) => s.parentSpanContext?.spanId === parentA.spanContext().spanId)!;
    const sessionB = sessions.find((s) => s.parentSpanContext?.spanId === parentB.spanContext().spanId)!;
    const chatA = spans.find((s) => s.name.startsWith('chat ') && json(s, 'gen_ai.output.messages')[0].parts[0].content === 'a')!;
    const chatB = spans.find((s) => s.name.startsWith('chat ') && json(s, 'gen_ai.output.messages')[0].parts[0].content === 'b')!;
    expect(chatA.parentSpanContext?.spanId).toBe(sessionA.spanContext().spanId);
    expect(chatB.parentSpanContext?.spanId).toBe(sessionB.spanContext().spanId);
  });

  it('never throws on malformed messages and still ends the session span', () => {
    const warn = vi.fn();
    const recorder = new SessionSpanRecorder('task', ROOT_CONTEXT, { now: clock(), logger: { warn } as never });
    expect(() => recorder.onMessage(null)).not.toThrow();
    expect(() => recorder.onMessage({ type: 'assistant' })).not.toThrow();
    expect(() => recorder.onMessage({ type: 'user', message: { content: 42 } })).not.toThrow();
    recorder.finish(sessionResult());
    recorder.finish(sessionResult()); // idempotent
    expect(named(exporter.getFinishedSpans(), 'invoke_agent claude-code')).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('still ends the session and open tool spans when flushing a malformed pending chat throws', () => {
    const warn = vi.fn();
    const recorder = new SessionSpanRecorder('task', ROOT_CONTEXT, { now: clock(), logger: { warn } as never });
    recorder.onMessage(assistant('m1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }], 'tool_use'));
    recorder.onMessage(assistant('m2', [null]));
    expect(() => recorder.finish(sessionResult())).not.toThrow();

    const spans = exporter.getFinishedSpans();
    expect(named(spans, 'invoke_agent claude-code')).toHaveLength(1);
    expect(named(spans, 'execute_tool Bash')).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('SessionSpanRecorder when span creation fails', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await resetTracingForTests();
  });

  it('does not throw from constructor, onMessage or finish', () => {
    installTestTracing();
    vi.spyOn(getTracer(), 'startSpan').mockImplementation(() => { throw new Error('tracer down'); });
    const warn = vi.fn();
    const logger = { warn } as any;

    let recorder!: SessionSpanRecorder;
    expect(() => { recorder = new SessionSpanRecorder('task', undefined, { logger }); }).not.toThrow();
    expect(() => recorder.onMessage({ type: 'result', subtype: 'success' })).not.toThrow();
    expect(() => recorder.finish({
      sessionId: 's', status: 'success', toolCallCount: 0, duration: 0, finalResponse: '',
    } as SessionResult)).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });
});
