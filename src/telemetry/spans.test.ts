import { describe, it, expect, afterEach } from 'vitest';
import { ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api';
import { installTestTracing, resetTracingForTests } from './tracing.js';
import { textMessage, MAX_CONTENT_CHARS } from './genai.js';
import { messagesAttribute, contentAttribute, startWorkflowSpan, endWorkflowSpan, statusMessage } from './spans.js';

afterEach(async () => {
  await resetTracingForTests();
});

describe('messagesAttribute', () => {
  it('serializes messages when content capture is on', () => {
    installTestTracing();
    expect(JSON.parse(messagesAttribute([textMessage('user', 'hi')]))).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'hi' }] },
    ]);
  });

  it('redacts messages when content capture is off', () => {
    installTestTracing({ captureContent: false });
    expect(JSON.parse(messagesAttribute([textMessage('user', 'secret')]))).toEqual([
      { role: 'user', parts: [{ type: 'text', content: '[redacted]' }] },
    ]);
  });
});

describe('contentAttribute', () => {
  it('stringifies and truncates when capture is on', () => {
    installTestTracing();
    expect(contentAttribute({ a: 1 })).toBe('{"a":1}');
    expect(contentAttribute('q'.repeat(MAX_CONTENT_CHARS + 3))).toContain('[truncated 3 chars]');
  });

  it('returns a placeholder when capture is off', () => {
    installTestTracing({ captureContent: false });
    expect(contentAttribute('secret')).toBe('[redacted]');
  });
});

describe('workflow spans', () => {
  it('records input/output and nests children under the returned context', () => {
    const exporter = installTestTracing();
    const parent = startWorkflowSpan('attempt 1', ROOT_CONTEXT, 'Fix the bug', { 'bg_agent.attempt': 1 });
    const child = startWorkflowSpan('verify', parent.ctx, 'changed files: a.ts');
    endWorkflowSpan(child.span, 'passed', { attributes: { 'bg_agent.verification.passed': true } });
    endWorkflowSpan(parent.span, 'verification passed');

    const [verify, attempt] = exporter.getFinishedSpans();
    expect(verify.name).toBe('verify');
    expect(verify.parentSpanContext?.spanId).toBe(attempt.spanContext().spanId);
    expect(verify.attributes['bg_agent.verification.passed']).toBe(true);
    expect(JSON.parse(String(attempt.attributes['gen_ai.input.messages']))[0].parts[0].content).toBe('Fix the bug');
    expect(JSON.parse(String(attempt.attributes['gen_ai.output.messages']))[0].parts[0].content).toBe('verification passed');
    expect(attempt.attributes['bg_agent.attempt']).toBe(1);
    expect(trace.getSpan(parent.ctx)).toBe(parent.span);
  });

  it('marks the span as an error when an error message is given', () => {
    const exporter = installTestTracing();
    const verify = startWorkflowSpan('verify', ROOT_CONTEXT, 'x');
    endWorkflowSpan(verify.span, 'verifier crashed', { error: 'ENOENT: mvn not found' });
    const [span] = exporter.getFinishedSpans();
    expect(span.status).toEqual({ code: SpanStatusCode.ERROR, message: 'ENOENT: mvn not found' });
    expect(span.attributes['error.type']).toBe('exception');
  });
});

describe('workflow span redaction and identity', () => {
  it('stamps gen_ai.provider.name on every workflow span without gen_ai.operation.name', () => {
    const exporter = installTestTracing();
    const w = startWorkflowSpan('verify', ROOT_CONTEXT, 'x', { 'bg_agent.attempt': 2 });
    endWorkflowSpan(w.span, 'ok');
    const [span] = exporter.getFinishedSpans();
    expect(span.attributes['gen_ai.provider.name']).toBe('anthropic');
    expect(span.attributes['bg_agent.attempt']).toBe(2);
    expect(span.attributes['gen_ai.operation.name']).toBeUndefined();
  });

  it('does not export raw error text in the status message when capture is off', () => {
    const exporter = installTestTracing({ captureContent: false });
    const w = startWorkflowSpan('verify', ROOT_CONTEXT, 'x');
    endWorkflowSpan(w.span, 'crashed', { error: 'secret /home/me/token=abc' });
    const [span] = exporter.getFinishedSpans();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes['error.type']).toBe('exception');
    expect(JSON.stringify(span.status)).not.toContain('secret');
  });
});

describe('statusMessage', () => {
  it('truncates long text when capture is on', () => {
    installTestTracing();
    const out = statusMessage('e'.repeat(5000));
    expect(out.startsWith('e'.repeat(1024))).toBe(true);
    expect(out).toContain('[truncated 3976 chars]');
    expect(out.length).toBeLessThan(1200);
  });

  it('returns the placeholder when capture is off', () => {
    installTestTracing({ captureContent: false });
    expect(statusMessage('secret')).toBe('[redacted]');
  });
});

describe('robustness: unserializable content', () => {
  it('contentAttribute handles circular objects without throwing', () => {
    installTestTracing();
    const circular: any = { a: 1 };
    circular.self = circular;
    expect(contentAttribute(circular)).toBe('[unserializable]');
  });

  it('contentAttribute handles BigInt without throwing', () => {
    installTestTracing();
    expect(contentAttribute(BigInt(999))).toBe('[unserializable]');
  });

  it('contentAttribute handles functions without throwing', () => {
    installTestTracing();
    expect(contentAttribute(() => 'test')).toBe('[unserializable]');
  });

  it('messagesAttribute handles tool_call with circular arguments without throwing', () => {
    installTestTracing();
    const circular: any = { a: 1 };
    circular.self = circular;
    const messages = [
      {
        role: 'assistant' as const,
        parts: [
          { type: 'tool_call' as const, id: 't1', name: 'Edit', arguments: circular },
        ],
      },
    ];
    const result = messagesAttribute(messages);
    expect(typeof result).toBe('string');
    expect(result).toContain('[unserializable]');
  });
});
