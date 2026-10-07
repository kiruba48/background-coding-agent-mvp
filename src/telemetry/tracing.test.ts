import { describe, it, expect, afterEach, vi } from 'vitest';
import type pino from 'pino';
import { InMemorySpanExporter, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { ExportResultCode } from '@opentelemetry/core';
import {
  buildSplunkExporterOptions,
  buildResourceAttributes,
  initTracing,
  getTracer,
  flushTracing,
  shouldCaptureContent,
  installTestTracing,
  resetTracingForTests,
} from './tracing.js';
import type { TelemetryConfig } from './config.js';

const config: TelemetryConfig = {
  realm: 'eu0',
  token: 'tok',
  project: 'bg-agent-spike',
  agentStream: 'dev',
  captureContent: true,
  serviceName: 'background-coding-agent',
};
const env = { SPLUNK_AO_REALM: 'eu0', SPLUNK_AO_O11Y_TOKEN: 'tok', SPLUNK_AO_PROJECT: 'p', SPLUNK_AO_AGENT_STREAM: 's' };

function fakeLogger() {
  return { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as pino.Logger & { warn: ReturnType<typeof vi.fn> };
}

afterEach(async () => {
  await resetTracingForTests();
});

describe('buildSplunkExporterOptions', () => {
  it('targets the realm ingest endpoint with SDK-compatible routing headers', () => {
    expect(buildSplunkExporterOptions(config)).toEqual({
      url: 'https://ingest.eu0.observability.splunkcloud.com/v2/trace/otlp',
      headers: { 'X-SF-Token': 'tok', project: 'bg-agent-spike', logstream: 'dev' },
      timeoutMillis: 5000,
    });
  });
});

describe('buildResourceAttributes', () => {
  it('sets service name and logstream routing attributes', () => {
    expect(buildResourceAttributes(config)).toEqual({
      'service.name': 'background-coding-agent',
      'splunk_ao.project.name': 'bg-agent-spike',
      'splunk_ao.logstream.name': 'dev',
    });
  });
});

describe('initTracing', () => {
  it('returns false and records nothing when credentials are missing', () => {
    expect(initTracing({ env: {} })).toBe(false);
    const span = getTracer().startSpan('x');
    expect(span.isRecording()).toBe(false);
    span.end();
  });

  it('exports spans with routing resource attributes when configured', async () => {
    const exporter = new InMemorySpanExporter();
    expect(initTracing({ env, exporter })).toBe(true);
    getTracer().startSpan('hello').end();
    await flushTracing();
    const [span] = exporter.getFinishedSpans();
    expect(span.name).toBe('hello');
    expect(span.resource.attributes).toMatchObject({
      'service.name': 'background-coding-agent',
      'splunk_ao.project.name': 'p',
      'splunk_ao.logstream.name': 's',
    });
  });

  it('is idempotent: the first call wins', async () => {
    const first = new InMemorySpanExporter();
    const second = new InMemorySpanExporter();
    initTracing({ env, exporter: first });
    expect(initTracing({ env, exporter: second })).toBe(true);
    getTracer().startSpan('once').end();
    await flushTracing();
    expect(first.getFinishedSpans()).toHaveLength(1);
    expect(second.getFinishedSpans()).toHaveLength(0);
  });

  it('honours SPLUNK_AO_CAPTURE_CONTENT=false', () => {
    initTracing({ env: { ...env, SPLUNK_AO_CAPTURE_CONTENT: 'false' }, exporter: new InMemorySpanExporter() });
    expect(shouldCaptureContent()).toBe(false);
  });

  it('logs a single warning when exports fail', async () => {
    const failing: SpanExporter = {
      export: (_spans, done) => done({ code: ExportResultCode.FAILED, error: new Error('Unauthorized') }),
      shutdown: async () => {},
      forceFlush: async () => {},
    };
    const logger = fakeLogger();
    initTracing({ env, exporter: failing, logger });
    getTracer().startSpan('a').end();
    await flushTracing(logger);
    getTracer().startSpan('b').end();
    await flushTracing(logger);
    // Only the first export failure should warn; flushTracing should not log additional warnings
    expect(logger.warn.mock.calls).toHaveLength(1);
    expect(logger.warn.mock.calls[0][1]).toBe('telemetry_export_failed');
  });
});

describe('flushTracing', () => {
  it('resolves when tracing is disabled', async () => {
    await expect(flushTracing()).resolves.toBeUndefined();
  });

  it('gives up after the timeout when the exporter hangs', async () => {
    const hanging: SpanExporter = {
      export: () => { /* never calls back */ },
      shutdown: async () => {},
      forceFlush: () => new Promise<void>(() => {}),
    };
    const logger = fakeLogger();
    initTracing({ env, exporter: hanging, logger });
    getTracer().startSpan('stuck').end();
    const started = Date.now();
    await flushTracing(logger, 50);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 50 }), 'telemetry_flush_timeout');
  });
});

describe('installTestTracing', () => {
  it('records spans synchronously into an in-memory exporter', () => {
    const exporter = installTestTracing({ captureContent: false });
    getTracer().startSpan('t').end();
    expect(exporter.getFinishedSpans().map(s => s.name)).toEqual(['t']);
    expect(shouldCaptureContent()).toBe(false);
  });
});
