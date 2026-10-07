/**
 * Span helpers shared by the pipeline (runAgent, RetryOrchestrator) and the
 * session recorder. All content goes through messagesAttribute/contentAttribute
 * so SPLUNK_AO_CAPTURE_CONTENT=false is enforced in one place.
 */
import { SpanStatusCode, trace, type Attributes, type Context, type Span } from '@opentelemetry/api';
import { getTracer, shouldCaptureContent } from './tracing.js';
import { REDACTED, redactMessages, safeStringify, textMessage, truncate, type GenAIMessage } from './genai.js';

export function messagesAttribute(messages: GenAIMessage[]): string {
  return safeStringify(shouldCaptureContent() ? messages : redactMessages(messages));
}

export function contentAttribute(value: unknown): string {
  if (!shouldCaptureContent()) return REDACTED;
  return truncate(typeof value === 'string' ? value : safeStringify(value ?? null));
}

const MAX_STATUS_MESSAGE_CHARS = 1024;

/** Span status messages carry error text; redact or cap them like any other content. */
export function statusMessage(text: string): string {
  return shouldCaptureContent() ? truncate(text, MAX_STATUS_MESSAGE_CHARS) : REDACTED;
}

export interface TracedSpan {
  span: Span;
  ctx: Context;
}

/** Start a "workflow" span (Splunk AO requires input and output on these). */
export function startWorkflowSpan(name: string, parent: Context, input: string, attributes: Attributes = {}): TracedSpan {
  const span = getTracer().startSpan(
    name,
    { attributes: { ...attributes, 'gen_ai.provider.name': 'anthropic', 'gen_ai.input.messages': messagesAttribute([textMessage('user', input)]) } },
    parent,
  );
  return { span, ctx: trace.setSpan(parent, span) };
}

export function endWorkflowSpan(
  span: Span,
  output: string,
  options: { error?: string; attributes?: Attributes } = {},
): void {
  if (options.attributes) span.setAttributes(options.attributes);
  span.setAttribute('gen_ai.output.messages', messagesAttribute([textMessage('assistant', output)]));
  if (options.error !== undefined) {
    span.setAttribute('error.type', 'exception');
    span.setStatus({ code: SpanStatusCode.ERROR, message: statusMessage(options.error) });
  }
  span.end();
}
