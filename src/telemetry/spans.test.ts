import { describe, it, expect, afterEach } from 'vitest';
import { ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api';
import { installTestTracing, resetTracingForTests } from './tracing.js';
import { textMessage, MAX_CONTENT_CHARS } from './genai.js';
import { messagesAttribute, contentAttribute, startWorkflowSpan, endWorkflowSpan } from './spans.js';

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
