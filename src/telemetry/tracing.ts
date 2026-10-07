/**
 * Tracer provider lifecycle for Splunk Agent Observability.
 *
 * When telemetry is not configured no provider is installed and
 * @opentelemetry/api hands out a no-op tracer, so instrumentation is free.
 * Context is always passed explicitly (no global context manager is needed).
 */
import { trace, type Tracer } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import type pino from 'pino';
import { readTelemetryConfig, type TelemetryConfig } from './config.js';

export const TRACER_NAME = 'background-coding-agent';
const DEFAULT_FLUSH_TIMEOUT_MS = 5000;

let provider: BasicTracerProvider | null = null;
let initialized = false;
let captureContent = true;

export function buildSplunkExporterOptions(config: TelemetryConfig) {
  return {
    url: `https://ingest.${config.realm}.observability.splunkcloud.com/v2/trace/otlp`,
    // Same routing headers the official splunk_ao Python SDK sends (legacy "logstream" keys).
    headers: { 'X-SF-Token': config.token, project: config.project, logstream: config.agentStream },
    timeoutMillis: DEFAULT_FLUSH_TIMEOUT_MS,
  };
}

export function buildResourceAttributes(config: TelemetryConfig): Record<string, string> {
  return {
    'service.name': config.serviceName,
    'splunk_ao.project.name': config.project,
    'splunk_ao.logstream.name': config.agentStream,
  };
}

/** Logs the first export failure; telemetry problems must never surface as run failures. */
class LoggingExporter implements SpanExporter {
  private warned = false;

  constructor(private readonly inner: SpanExporter, private readonly logger?: pino.Logger) {}

  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    this.inner.export(spans, (result) => {
      if (result.code !== ExportResultCode.SUCCESS && !this.warned) {
        this.warned = true;
        this.logger?.warn({ err: result.error?.message, spanCount: spans.length }, 'telemetry_export_failed');
      }
      done(result);
    });
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

export interface InitTracingOptions {
  env?: NodeJS.ProcessEnv;
  logger?: pino.Logger;
  /** Override the OTLP exporter (tests). */
  exporter?: SpanExporter;
}

/** Install the global tracer provider once. Returns true when telemetry is enabled. */
export function initTracing(options: InitTracingOptions = {}): boolean {
  if (initialized) return provider !== null;
  initialized = true;

  const config = readTelemetryConfig(options.env ?? process.env);
  if (!config) {
    options.logger?.debug('Splunk AO telemetry disabled (SPLUNK_AO_REALM / SPLUNK_AO_O11Y_TOKEN not set)');
    return false;
  }

  captureContent = config.captureContent;
  const exporter = new LoggingExporter(
    options.exporter ?? new OTLPTraceExporter(buildSplunkExporterOptions(config)),
    options.logger,
  );
  provider = new BasicTracerProvider({
    resource: resourceFromAttributes(buildResourceAttributes(config)),
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);

  options.logger?.info(
    { realm: config.realm, project: config.project, agentStream: config.agentStream, captureContent },
    'Splunk AO telemetry enabled',
  );
  return true;
}

export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

export function shouldCaptureContent(): boolean {
  return captureContent;
}

/** Export buffered spans. Never rejects and never waits longer than timeoutMs. */
export async function flushTracing(logger?: pino.Logger, timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS): Promise<void> {
  if (!provider) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    const outcome = await Promise.race([provider.forceFlush().then(() => 'flushed' as const), timeout]);
    if (outcome === 'timeout') logger?.warn({ timeoutMs }, 'telemetry_flush_timeout');
  } catch (err) {
    logger?.debug({ err }, 'telemetry_flush_failed');
  } finally {
    clearTimeout(timer);
  }
}

/** Tests only: record spans synchronously in memory instead of exporting. */
export function installTestTracing(options: { captureContent?: boolean } = {}): InMemorySpanExporter {
  trace.disable();
  const exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
  initialized = true;
  captureContent = options.captureContent ?? true;
  return exporter;
}

/** Tests only: tear down the global provider so the next test starts clean. */
export async function resetTracingForTests(): Promise<void> {
  const current = provider;
  provider = null;
  initialized = false;
  captureContent = true;
  trace.disable();
  // Don't await: a hanging exporter (flush-timeout test) must not block teardown.
  void current?.shutdown().catch(() => {});
}
