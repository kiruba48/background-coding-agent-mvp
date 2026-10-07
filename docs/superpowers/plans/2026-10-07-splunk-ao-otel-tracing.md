# Splunk Agent Observability Tracing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every agent run produces an OpenTelemetry trace in Splunk Agent Observability. The trace contains:
- the run
- each retry attempt
- each LLM turn
- each tool call
- the verifier and judge steps

Splunk's agent evaluators can score these traces.

**Architecture:** A new `src/telemetry/` module owns a global OTel `BasicTracerProvider`. The provider is installed only when `SPLUNK_AO_REALM` and `SPLUNK_AO_O11Y_TOKEN` are set; otherwise `@opentelemetry/api` falls back to a no-op tracer, so every instrumentation call is free.

Spans are built **on the host**, from the Claude Agent SDK message stream that `ClaudeCodeSession` already consumes, using OTel GenAI semantic conventions. The trace context is passed explicitly down the call chain: `runAgent` → `RetryOrchestrator` → `ClaudeCodeSession`, via `SessionConfig.traceContext`. Concurrent Slack runs therefore never share a parent.

Nothing changes inside the Docker container. The container's egress firewall stays as it is, because the Claude Code CLI's own telemetry is not used.

**Tech Stack:** TypeScript (ESM, NodeNext), `@opentelemetry/api`, `@opentelemetry/sdk-trace-base`, `@opentelemetry/exporter-trace-otlp-proto`, `@opentelemetry/resources`, `@opentelemetry/core`, vitest, pino.

**Spec:** `galileo-observability-research.md`, §0 "Update 2026-10-07". It contains the verified endpoint, routing, span-validity rules, evaluator results and the spike outcome. The working spike script is `scratchpad/splunk-spike/spike.ts`. It is not in the repo; every value it proved is copied into the Global Constraints below.

## Global Constraints

- Imports use the ESM `.js` suffix (`import { x } from './tracing.js'`). TypeScript `strict` is on.
- Dependency versions:
  - `@opentelemetry/api` `^1.9.1`
  - `@opentelemetry/sdk-trace-base` `^2.12.0`
  - `@opentelemetry/resources` `^2.12.0`
  - `@opentelemetry/core` `^2.12.0`
  - `@opentelemetry/exporter-trace-otlp-proto` `^0.223.0`
- OTLP endpoint: `https://ingest.<realm>.observability.splunkcloud.com/v2/trace/otlp`.
- Auth header: `X-SF-Token: <SPLUNK_AO_O11Y_TOKEN>`.
- Routing uses **both** of these:
  - request headers `project` and `logstream`
  - resource attributes `splunk_ao.project.name` and `splunk_ao.logstream.name`

  Do **not** use the documented `agentstream` keys: they did not route traces in the spike.
- Environment variables:
  - `SPLUNK_AO_REALM` (required)
  - `SPLUNK_AO_O11Y_TOKEN` (required)
  - `SPLUNK_AO_PROJECT` (default `background-coding-agent`)
  - `SPLUNK_AO_AGENT_STREAM` (default `default`)
  - `SPLUNK_AO_CAPTURE_CONTENT` (default on; `false` redacts prompts, outputs, tool arguments and tool results)
  - `SPLUNK_AO_LOGGING_DISABLED` (`true` turns telemetry off)
  - `OTEL_SERVICE_NAME` (default `background-coding-agent`)
- Telemetry is disabled unless both required variables are set. Telemetry code must never throw into, or block, the agent pipeline.
- Span shapes:
  - Every span carries GenAI semconv attributes.
  - Agent spans: `gen_ai.operation.name=invoke_agent`, `gen_ai.provider.name=anthropic`, `gen_ai.input.messages`, `gen_ai.output.messages`.
  - LLM spans: `chat` with `gen_ai.request.model`.
  - Tool spans: `execute_tool` with `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`.
  - Error spans: `error.type` plus status `ERROR`.
- Message JSON uses the "parts" format: `[{ "role": "...", "parts": [{ "type": "text", "content": "..." } | { "type": "tool_call", "id", "name", "arguments" } | { "type": "tool_call_response", "id", "response" }], "finish_reason"? }]`.
- Token attributes: `gen_ai.usage.input_tokens` (including cached tokens), `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_creation.input_tokens`.
- Project-specific attributes use the `bg_agent.` prefix.
- Do **not** send `gen_ai.tool.definitions`. Splunk ignores it over OTLP, and Tool Selection Quality is out of scope.
- Splunk variables are host-only. Do not modify `src/cli/docker/index.ts` or `docker/entrypoint.sh`.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Splunk is unreachable or rejects the token.** The agent run still completes normally, and the result arrives no more than ~5 s later than without telemetry. A single `telemetry_export_failed` warning is logged. Tests: Task 2 (failing exporter, flush timeout).
2. **Credentials are missing, partial, or turned off** (`SPLUNK_AO_LOGGING_DISABLED=true`). No provider is installed, nothing is exported, and no error appears. A developer whose shell exports the Splunk variables must not send data from `npm test`. Tests: Task 1 (config) and Task 1's vitest env guard.
3. **Huge payloads**, such as reading a 2 MB file or a long `npm test` output. Every content attribute is capped at 16,000 characters, with a `[truncated N chars]` marker. Tests: Task 3 (truncate) and Task 5 (long tool result).
4. **`SPLUNK_AO_CAPTURE_CONTENT=false`.** No prompt text, model output, tool arguments or tool results leave the host. Tool names, ids, token counts and statuses still do, and the spans stay valid for Splunk because placeholders keep the input/output keys present. Tests: Task 3 (redact) and Task 5 (capture off).
5. **Two runs at once** (the Slack bot handles concurrent threads). Each run's spans nest only under that run's root span. Tests: Task 5 (interleaved recorders).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/telemetry/config.ts` (new) | Read and validate Splunk env vars into a `TelemetryConfig`, or `null` |
| `src/telemetry/tracing.ts` (new) | Provider lifecycle: `initTracing`, `getTracer`, `flushTracing`, `shouldCaptureContent`, exporter options, test install/reset helpers |
| `src/telemetry/genai.ts` (new) | Pure mapping from Anthropic/SDK shapes to GenAI "parts" messages, plus `truncate`, `redactMessages` and `usageAttributes`. No OTel imports |
| `src/telemetry/spans.ts` (new) | Content-aware attribute helpers (`messagesAttribute`, `contentAttribute`) and workflow-span helpers (`startWorkflowSpan`, `endWorkflowSpan`) |
| `src/telemetry/session-recorder.ts` (new) | `SessionSpanRecorder`: turns the SDK message stream into session, chat and tool spans |
| `src/types.ts` | `SessionConfig.traceContext?: Context` |
| `src/orchestrator/claude-code-session.ts` | Feed every SDK message to the recorder, and always finish it |
| `src/orchestrator/retry.ts` | `attempt N`, `verify` and `judge` spans; pass the attempt context to the session |
| `src/agent/index.ts` | Run root span, `initTracing`, `flushTracing`; pass the root context down |
| `vitest.config.ts` | `SPLUNK_AO_LOGGING_DISABLED=true` for all tests |
| `README.md` | Document the env vars |

Span tree produced per run:

```
invoke_agent background-coding-agent      (runAgent; gen_ai.conversation.id = run id)
└─ attempt 1                               (RetryOrchestrator, workflow span)
   ├─ invoke_agent claude-code             (ClaudeCodeSession / SessionSpanRecorder)
   │  ├─ chat claude-…                     (one per assistant turn)
   │  ├─ execute_tool Edit                 (one per tool_use → tool_result)
   │  └─ …
   ├─ verify                               (workflow span)
   └─ judge                                (workflow span)
```

Investigation tasks have no attempt, verify or judge spans: `invoke_agent claude-code` hangs directly under the root.

---

### Task 1: Dependencies and telemetry config

**Files:**
- Modify: `package.json` (via npm install)
- Modify: `vitest.config.ts`
- Create: `src/telemetry/config.ts`
- Test: `src/telemetry/config.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  ```ts
  export interface TelemetryConfig { realm: string; token: string; project: string; agentStream: string; captureContent: boolean; serviceName: string; }
  export function readTelemetryConfig(env: NodeJS.ProcessEnv): TelemetryConfig | null;
  ```

- [ ] **Step 1: Install dependencies**

Run:
```bash
npm install @opentelemetry/api@^1.9.1 @opentelemetry/sdk-trace-base@^2.12.0 @opentelemetry/resources@^2.12.0 @opentelemetry/core@^2.12.0 @opentelemetry/exporter-trace-otlp-proto@^0.223.0
```
Expected: the five packages appear under `dependencies` in `package.json`.

- [ ] **Step 2: Guard the test suite against real exports**

Replace `vitest.config.ts` with:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['dist/**', 'node_modules/**'],
    // Never export real telemetry from tests, even if the shell has SPLUNK_AO_* set.
    env: { SPLUNK_AO_LOGGING_DISABLED: 'true' },
  },
});
```

- [ ] **Step 3: Write the failing test**

Create `src/telemetry/config.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readTelemetryConfig } from './config.js';

const base = { SPLUNK_AO_REALM: 'eu0', SPLUNK_AO_O11Y_TOKEN: 'tok' };

describe('readTelemetryConfig', () => {
  it('returns null when realm or token is missing', () => {
    expect(readTelemetryConfig({})).toBeNull();
    expect(readTelemetryConfig({ SPLUNK_AO_REALM: 'eu0' })).toBeNull();
    expect(readTelemetryConfig({ SPLUNK_AO_O11Y_TOKEN: 'tok' })).toBeNull();
    expect(readTelemetryConfig({ SPLUNK_AO_REALM: '  ', SPLUNK_AO_O11Y_TOKEN: 'tok' })).toBeNull();
  });

  it('returns null when explicitly disabled', () => {
    expect(readTelemetryConfig({ ...base, SPLUNK_AO_LOGGING_DISABLED: 'true' })).toBeNull();
    expect(readTelemetryConfig({ ...base, SPLUNK_AO_LOGGING_DISABLED: 'TRUE' })).toBeNull();
  });

  it('applies defaults', () => {
    expect(readTelemetryConfig(base)).toEqual({
      realm: 'eu0',
      token: 'tok',
      project: 'background-coding-agent',
      agentStream: 'default',
      captureContent: true,
      serviceName: 'background-coding-agent',
    });
  });

  it('reads overrides and trims whitespace', () => {
    expect(readTelemetryConfig({
      SPLUNK_AO_REALM: ' eu0 ',
      SPLUNK_AO_O11Y_TOKEN: ' tok ',
      SPLUNK_AO_PROJECT: 'bg-agent-spike',
      SPLUNK_AO_AGENT_STREAM: 'dev',
      SPLUNK_AO_CAPTURE_CONTENT: 'false',
      OTEL_SERVICE_NAME: 'bg-agent-local',
    })).toEqual({
      realm: 'eu0',
      token: 'tok',
      project: 'bg-agent-spike',
      agentStream: 'dev',
      captureContent: false,
      serviceName: 'bg-agent-local',
    });
  });

  it('treats any capture value other than "false" as enabled', () => {
    expect(readTelemetryConfig({ ...base, SPLUNK_AO_CAPTURE_CONTENT: 'no' })?.captureContent).toBe(true);
    expect(readTelemetryConfig({ ...base, SPLUNK_AO_CAPTURE_CONTENT: 'FALSE' })?.captureContent).toBe(false);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run src/telemetry/config.test.ts`
Expected: FAIL with "Failed to resolve import ./config.js".

- [ ] **Step 5: Write minimal implementation**

Create `src/telemetry/config.ts`:
```ts
/**
 * Splunk Agent Observability telemetry configuration.
 *
 * Telemetry is opt-in: it is enabled only when both SPLUNK_AO_REALM and
 * SPLUNK_AO_O11Y_TOKEN are set (and SPLUNK_AO_LOGGING_DISABLED is not "true").
 */
export interface TelemetryConfig {
  realm: string;
  token: string;
  project: string;
  agentStream: string;
  /** false → prompts, outputs, tool args and tool results are redacted before export */
  captureContent: boolean;
  serviceName: string;
}

function value(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key]?.trim();
  return raw ? raw : undefined;
}

export function readTelemetryConfig(env: NodeJS.ProcessEnv): TelemetryConfig | null {
  if (value(env, 'SPLUNK_AO_LOGGING_DISABLED')?.toLowerCase() === 'true') return null;

  const realm = value(env, 'SPLUNK_AO_REALM');
  const token = value(env, 'SPLUNK_AO_O11Y_TOKEN');
  if (!realm || !token) return null;

  return {
    realm,
    token,
    project: value(env, 'SPLUNK_AO_PROJECT') ?? 'background-coding-agent',
    agentStream: value(env, 'SPLUNK_AO_AGENT_STREAM') ?? 'default',
    captureContent: value(env, 'SPLUNK_AO_CAPTURE_CONTENT')?.toLowerCase() !== 'false',
    serviceName: value(env, 'OTEL_SERVICE_NAME') ?? 'background-coding-agent',
  };
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/telemetry/config.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json vitest.config.ts src/telemetry/config.ts src/telemetry/config.test.ts
git commit -m "feat(telemetry): add Splunk AO telemetry config and OTel dependencies

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Tracer provider lifecycle

**Files:**
- Create: `src/telemetry/tracing.ts`
- Test: `src/telemetry/tracing.test.ts`

**Interfaces:**
- Consumes: `readTelemetryConfig`, `TelemetryConfig` (Task 1)
- Produces:
  ```ts
  export const TRACER_NAME = 'background-coding-agent';
  export function buildSplunkExporterOptions(config: TelemetryConfig): { url: string; headers: Record<string, string>; timeoutMillis: number };
  export function buildResourceAttributes(config: TelemetryConfig): Record<string, string>;
  export interface InitTracingOptions { env?: NodeJS.ProcessEnv; logger?: pino.Logger; exporter?: SpanExporter }
  export function initTracing(options?: InitTracingOptions): boolean;          // idempotent; true = enabled
  export function getTracer(): Tracer;                                          // no-op tracer when disabled
  export function shouldCaptureContent(): boolean;
  export function flushTracing(logger?: pino.Logger, timeoutMs?: number): Promise<void>; // never rejects
  export function installTestTracing(options?: { captureContent?: boolean }): InMemorySpanExporter; // tests only
  export function resetTracingForTests(): Promise<void>;                                            // tests only
  ```

- [ ] **Step 1: Write the failing test**

Create `src/telemetry/tracing.test.ts`:
```ts
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
    const exportWarnings = logger.warn.mock.calls.filter((c: unknown[]) => c[1] === 'telemetry_export_failed');
    expect(exportWarnings).toHaveLength(1);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/telemetry/tracing.test.ts`
Expected: FAIL with "Failed to resolve import ./tracing.js".

- [ ] **Step 3: Write minimal implementation**

Create `src/telemetry/tracing.ts`:
```ts
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
    logger?.warn({ err }, 'telemetry_flush_failed');
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/telemetry/tracing.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/telemetry/tracing.ts src/telemetry/tracing.test.ts
git commit -m "feat(telemetry): add Splunk AO tracer provider lifecycle

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: GenAI message mapping

**Files:**
- Create: `src/telemetry/genai.ts`
- Test: `src/telemetry/genai.test.ts`

**Interfaces:**
- Consumes: nothing (pure module, no OTel imports)
- Produces:
  ```ts
  export const MAX_CONTENT_CHARS = 16_000;
  export const REDACTED = '[redacted]';
  export type GenAIPart =
    | { type: 'text'; content: string }
    | { type: 'tool_call'; id: string; name: string; arguments: unknown }
    | { type: 'tool_call_response'; id: string; response: unknown };
  export interface GenAIMessage { role: 'user' | 'assistant' | 'tool'; parts: GenAIPart[]; finish_reason?: string }
  export interface AssistantContentBlock { type: string; text?: string; id?: string; name?: string; input?: unknown }
  export interface ToolResultBlock { type: 'tool_result'; tool_use_id: string; content?: unknown; is_error?: boolean }
  export interface TokenUsage { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }
  export function truncate(text: string, max?: number): string;
  export function textMessage(role: GenAIMessage['role'], text: string): GenAIMessage;
  export function assistantBlocksToMessage(blocks: AssistantContentBlock[], stopReason: string | null | undefined): GenAIMessage;
  export function extractToolResults(content: unknown): ToolResultBlock[];
  export function toolResultText(content: unknown): string;
  export function toolResultMessage(result: ToolResultBlock): GenAIMessage;
  export function usageAttributes(usage: TokenUsage | undefined): Record<string, number>;
  export function redactMessages(messages: GenAIMessage[]): GenAIMessage[];
  ```

- [ ] **Step 1: Write the failing test**

Create `src/telemetry/genai.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import {
  MAX_CONTENT_CHARS,
  REDACTED,
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/telemetry/genai.test.ts`
Expected: FAIL with "Failed to resolve import ./genai.js".

- [ ] **Step 3: Write minimal implementation**

Create `src/telemetry/genai.ts`:
```ts
/**
 * Pure mapping from Claude Agent SDK / Anthropic message shapes to OpenTelemetry
 * GenAI semantic-convention messages ("parts" format, as used by Splunk AO).
 * No OpenTelemetry imports — everything here is plain data.
 */

export const MAX_CONTENT_CHARS = 16_000;
export const REDACTED = '[redacted]';

export type GenAIPart =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; id: string; name: string; arguments: unknown }
  | { type: 'tool_call_response'; id: string; response: unknown };

export interface GenAIMessage {
  role: 'user' | 'assistant' | 'tool';
  parts: GenAIPart[];
  finish_reason?: string;
}

/** Structural subset of Anthropic content blocks (text, tool_use, thinking, …). */
export interface AssistantContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: unknown;
  is_error?: boolean;
}

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

export function truncate(text: string, max = MAX_CONTENT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [truncated ${text.length - max} chars]`;
}

export function textMessage(role: GenAIMessage['role'], text: string): GenAIMessage {
  return { role, parts: [{ type: 'text', content: truncate(text) }] };
}

function boundedArguments(input: unknown): unknown {
  const value = input ?? {};
  const serialized = JSON.stringify(value);
  return serialized.length <= MAX_CONTENT_CHARS ? value : truncate(serialized);
}

function finishReason(stopReason: string | null | undefined, hasToolCall: boolean): string {
  if (stopReason === 'tool_use' || (!stopReason && hasToolCall)) return 'tool_call';
  if (stopReason === 'max_tokens') return 'length';
  return 'stop';
}

export function assistantBlocksToMessage(
  blocks: AssistantContentBlock[],
  stopReason: string | null | undefined,
): GenAIMessage {
  const parts: GenAIPart[] = [];
  for (const block of blocks) {
    if (block.type === 'text' && block.text) {
      parts.push({ type: 'text', content: truncate(block.text) });
    } else if (block.type === 'tool_use' && block.id && block.name) {
      parts.push({ type: 'tool_call', id: block.id, name: block.name, arguments: boundedArguments(block.input) });
    }
    // thinking / redacted_thinking / other block types are intentionally not exported
  }
  const hasToolCall = parts.some((p) => p.type === 'tool_call');
  return { role: 'assistant', parts, finish_reason: finishReason(stopReason, hasToolCall) };
}

export function extractToolResults(content: unknown): ToolResultBlock[] {
  if (!Array.isArray(content)) return [];
  return content.filter(
    (block): block is ToolResultBlock =>
      !!block && typeof block === 'object' &&
      (block as { type?: unknown }).type === 'tool_result' &&
      typeof (block as { tool_use_id?: unknown }).tool_use_id === 'string',
  );
}

export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content === undefined || content === null) return '';
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        const block = item as { type?: unknown; text?: unknown } | null;
        if (block && typeof block.text === 'string') return block.text;
        return `[${typeof block?.type === 'string' ? block.type : 'content'}]`;
      })
      .join('\n');
  }
  return JSON.stringify(content);
}

export function toolResultMessage(result: ToolResultBlock): GenAIMessage {
  return {
    role: 'tool',
    parts: [{ type: 'tool_call_response', id: result.tool_use_id, response: truncate(toolResultText(result.content)) }],
  };
}

export function usageAttributes(usage: TokenUsage | undefined): Record<string, number> {
  if (!usage) return {};
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const attrs: Record<string, number> = {};
  if (typeof usage.input_tokens === 'number') {
    // GenAI semconv: input_tokens includes tokens read from and written to the prompt cache.
    attrs['gen_ai.usage.input_tokens'] = usage.input_tokens + cacheRead + cacheWrite;
  }
  if (typeof usage.output_tokens === 'number') attrs['gen_ai.usage.output_tokens'] = usage.output_tokens;
  if (cacheRead) attrs['gen_ai.usage.cache_read.input_tokens'] = cacheRead;
  if (cacheWrite) attrs['gen_ai.usage.cache_creation.input_tokens'] = cacheWrite;
  return attrs;
}

export function redactMessages(messages: GenAIMessage[]): GenAIMessage[] {
  return messages.map((message) => ({
    ...message,
    parts: message.parts.map((part): GenAIPart => {
      if (part.type === 'text') return { type: 'text', content: REDACTED };
      if (part.type === 'tool_call') return { ...part, arguments: REDACTED };
      return { ...part, response: REDACTED };
    }),
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/telemetry/genai.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add src/telemetry/genai.ts src/telemetry/genai.test.ts
git commit -m "feat(telemetry): map SDK messages to GenAI semconv parts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Content-aware span helpers

**Files:**
- Create: `src/telemetry/spans.ts`
- Test: `src/telemetry/spans.test.ts`

**Interfaces:**
- Consumes: `getTracer`, `shouldCaptureContent`, `installTestTracing`, `resetTracingForTests` (Task 2); `GenAIMessage`, `textMessage`, `redactMessages`, `truncate`, `REDACTED` (Task 3)
- Produces:
  ```ts
  export function messagesAttribute(messages: GenAIMessage[]): string;   // JSON, redacted when capture is off
  export function contentAttribute(value: unknown): string;              // truncated string, or '[redacted]'
  export interface TracedSpan { span: Span; ctx: Context }
  export function startWorkflowSpan(name: string, parent: Context, input: string, attributes?: Attributes): TracedSpan;
  export function endWorkflowSpan(span: Span, output: string, options?: { error?: string; attributes?: Attributes }): void;
  ```

- [ ] **Step 1: Write the failing test**

Create `src/telemetry/spans.test.ts`:
```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/telemetry/spans.test.ts`
Expected: FAIL with "Failed to resolve import ./spans.js".

- [ ] **Step 3: Write minimal implementation**

Create `src/telemetry/spans.ts`:
```ts
/**
 * Span helpers shared by the pipeline (runAgent, RetryOrchestrator) and the
 * session recorder. All content goes through messagesAttribute/contentAttribute
 * so SPLUNK_AO_CAPTURE_CONTENT=false is enforced in one place.
 */
import { SpanStatusCode, trace, type Attributes, type Context, type Span } from '@opentelemetry/api';
import { getTracer, shouldCaptureContent } from './tracing.js';
import { REDACTED, redactMessages, textMessage, truncate, type GenAIMessage } from './genai.js';

export function messagesAttribute(messages: GenAIMessage[]): string {
  return JSON.stringify(shouldCaptureContent() ? messages : redactMessages(messages));
}

export function contentAttribute(value: unknown): string {
  if (!shouldCaptureContent()) return REDACTED;
  return truncate(typeof value === 'string' ? value : JSON.stringify(value ?? null));
}

export interface TracedSpan {
  span: Span;
  ctx: Context;
}

/** Start a "workflow" span (Splunk AO requires input and output on these). */
export function startWorkflowSpan(name: string, parent: Context, input: string, attributes: Attributes = {}): TracedSpan {
  const span = getTracer().startSpan(
    name,
    { attributes: { ...attributes, 'gen_ai.input.messages': messagesAttribute([textMessage('user', input)]) } },
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
    span.setStatus({ code: SpanStatusCode.ERROR, message: options.error });
  }
  span.end();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/telemetry/spans.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/telemetry/spans.ts src/telemetry/spans.test.ts
git commit -m "feat(telemetry): add content-aware span helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Session span recorder

**Files:**
- Create: `src/telemetry/session-recorder.ts`
- Test: `src/telemetry/session-recorder.test.ts`

**Interfaces:**
- Consumes:
  - `getTracer`, `installTestTracing`, `resetTracingForTests` (Task 2)
  - from Task 3: `assistantBlocksToMessage`, `extractToolResults`, `textMessage`, `toolResultMessage`, `toolResultText`, `usageAttributes`, and the types `AssistantContentBlock`, `GenAIMessage`, `TokenUsage`
  - `messagesAttribute`, `contentAttribute` (Task 4)
  - `SessionResult` from `src/types.ts`
- Produces:
  ```ts
  export interface SessionSpanRecorderOptions { model?: string; logger?: pino.Logger; now?: () => number }
  export class SessionSpanRecorder {
    constructor(prompt: string, parent: Context | undefined, options?: SessionSpanRecorderOptions);
    onMessage(message: unknown): void;     // never throws
    finish(result: SessionResult): void;   // idempotent, never throws; ends the session span
  }
  ```
  Span names: `invoke_agent claude-code`, `chat <model>`, `execute_tool <tool name>`.

- [ ] **Step 1: Write the failing test**

Create `src/telemetry/session-recorder.test.ts`:
```ts
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/telemetry/session-recorder.test.ts`
Expected: FAIL with "Failed to resolve import ./session-recorder.js".

- [ ] **Step 3: Write minimal implementation**

Create `src/telemetry/session-recorder.ts`:
```ts
/**
 * Turns the Claude Agent SDK message stream of one ClaudeCodeSession into
 * GenAI-semconv spans:
 *
 *   invoke_agent claude-code
 *   ├─ chat <model>            one per assistant turn (messages sharing message.id are merged)
 *   └─ execute_tool <name>     one per tool_use, closed by the matching tool_result
 *
 * Telemetry must never break a run: public methods swallow and log errors.
 */
import { SpanKind, SpanStatusCode, context as otelContext, trace, type Context, type Span } from '@opentelemetry/api';
import type pino from 'pino';
import type { SessionResult } from '../types.js';
import { getTracer } from './tracing.js';
import { contentAttribute, messagesAttribute } from './spans.js';
import {
  assistantBlocksToMessage,
  extractToolResults,
  textMessage,
  toolResultMessage,
  toolResultText,
  usageAttributes,
  type AssistantContentBlock,
  type GenAIMessage,
  type TokenUsage,
} from './genai.js';

const PROVIDER = 'anthropic';
const AGENT_NAME = 'claude-code';

interface LooseMessage {
  type?: unknown;
  subtype?: unknown;
  parent_tool_use_id?: unknown;
  message?: unknown;
  model?: unknown;
  tools?: unknown;
  total_cost_usd?: unknown;
  num_turns?: unknown;
}

interface AssistantPayload {
  id?: string;
  model?: string;
  content?: AssistantContentBlock[];
  stop_reason?: string | null;
  usage?: TokenUsage;
}

interface PendingChat {
  id: string;
  model: string;
  start: number;
  end: number;
  blocks: AssistantContentBlock[];
  stopReason: string | null | undefined;
  usage: TokenUsage | undefined;
  input: GenAIMessage[];
}

export interface SessionSpanRecorderOptions {
  model?: string;
  logger?: pino.Logger;
  /** Clock override (tests). Must return epoch milliseconds. */
  now?: () => number;
}

export class SessionSpanRecorder {
  private readonly now: () => number;
  private readonly logger?: pino.Logger;
  private readonly sessionSpan: Span;
  private readonly ctx: Context;
  private readonly openTools = new Map<string, Span>();
  private model: string | undefined;
  private pending: PendingChat | null = null;
  private nextInput: GenAIMessage[];
  private lastBoundary: number;
  private anonymousIds = 0;
  private finished = false;
  private warned = false;

  constructor(prompt: string, parent: Context | undefined, options: SessionSpanRecorderOptions = {}) {
    this.now = options.now ?? Date.now;
    this.logger = options.logger;
    this.model = options.model;

    const parentCtx = parent ?? otelContext.active();
    const start = this.now();
    const promptMessage = textMessage('user', prompt);
    this.sessionSpan = getTracer().startSpan(
      `invoke_agent ${AGENT_NAME}`,
      {
        kind: SpanKind.INTERNAL,
        startTime: start,
        attributes: {
          'gen_ai.operation.name': 'invoke_agent',
          'gen_ai.provider.name': PROVIDER,
          'gen_ai.agent.name': AGENT_NAME,
          'gen_ai.input.messages': messagesAttribute([promptMessage]),
          ...(this.model ? { 'gen_ai.request.model': this.model } : {}),
        },
      },
      parentCtx,
    );
    this.ctx = trace.setSpan(parentCtx, this.sessionSpan);
    this.nextInput = [promptMessage];
    this.lastBoundary = start;
  }

  onMessage(message: unknown): void {
    if (this.finished) return;
    try {
      this.handle(message as LooseMessage);
    } catch (err) {
      this.warnOnce(err);
    }
  }

  finish(result: SessionResult): void {
    if (this.finished) return;
    this.finished = true;
    try {
      this.close(result);
    } catch (err) {
      this.warnOnce(err);
    }
  }

  private handle(message: LooseMessage): void {
    // Subagent traffic is covered by the parent's Task tool span.
    if (message.parent_tool_use_id) return;

    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') this.onInit(message);
        return;
      case 'assistant':
        this.onAssistant(message.message as AssistantPayload | undefined);
        return;
      case 'user':
        this.flushChat();
        this.onUser((message.message as { content?: unknown } | undefined)?.content);
        return;
      case 'result':
        this.flushChat();
        this.onResult(message);
        return;
    }
  }

  private onInit(message: LooseMessage): void {
    if (typeof message.model === 'string') {
      this.model = message.model;
      this.sessionSpan.setAttribute('gen_ai.request.model', message.model);
    }
    if (Array.isArray(message.tools)) {
      this.sessionSpan.setAttribute(
        'bg_agent.available_tools',
        message.tools.filter((tool): tool is string => typeof tool === 'string'),
      );
    }
  }

  private onAssistant(payload: AssistantPayload | undefined): void {
    if (!payload) return;
    const id = payload.id ?? `anonymous-${++this.anonymousIds}`;
    if (this.pending && this.pending.id !== id) this.flushChat();
    if (!this.pending) {
      this.pending = {
        id,
        model: payload.model ?? this.model ?? 'unknown',
        start: this.lastBoundary,
        end: this.lastBoundary,
        blocks: [],
        stopReason: undefined,
        usage: undefined,
        input: this.nextInput,
      };
      this.nextInput = [];
    }
    this.pending.blocks.push(...(payload.content ?? []));
    if (payload.stop_reason) this.pending.stopReason = payload.stop_reason;
    if (payload.usage) this.pending.usage = payload.usage;
    this.pending.end = this.now();
  }

  private flushChat(): void {
    const chat = this.pending;
    if (!chat) return;
    this.pending = null;

    const output = assistantBlocksToMessage(chat.blocks, chat.stopReason);
    getTracer()
      .startSpan(
        `chat ${chat.model}`,
        {
          kind: SpanKind.CLIENT,
          startTime: chat.start,
          attributes: {
            'gen_ai.operation.name': 'chat',
            'gen_ai.provider.name': PROVIDER,
            'gen_ai.request.model': chat.model,
            'gen_ai.response.id': chat.id,
            ...usageAttributes(chat.usage),
            'gen_ai.input.messages': messagesAttribute(chat.input),
            'gen_ai.output.messages': messagesAttribute([output]),
          },
        },
        this.ctx,
      )
      .end(chat.end);
    this.lastBoundary = chat.end;

    for (const part of output.parts) {
      if (part.type !== 'tool_call') continue;
      const toolSpan = getTracer().startSpan(
        `execute_tool ${part.name}`,
        {
          kind: SpanKind.INTERNAL,
          startTime: chat.end,
          attributes: {
            'gen_ai.operation.name': 'execute_tool',
            'gen_ai.provider.name': PROVIDER,
            'gen_ai.tool.name': part.name,
            'gen_ai.tool.call.id': part.id,
            'gen_ai.tool.call.arguments': contentAttribute(part.arguments),
          },
        },
        this.ctx,
      );
      this.openTools.set(part.id, toolSpan);
    }
  }

  private onUser(content: unknown): void {
    const now = this.now();
    if (typeof content === 'string') {
      this.nextInput.push(textMessage('user', content));
      this.lastBoundary = now;
      return;
    }
    for (const result of extractToolResults(content)) {
      this.nextInput.push(toolResultMessage(result));
      const toolSpan = this.openTools.get(result.tool_use_id);
      if (!toolSpan) continue;
      this.openTools.delete(result.tool_use_id);
      toolSpan.setAttribute('gen_ai.tool.call.result', contentAttribute(toolResultText(result.content)));
      if (result.is_error) {
        toolSpan.setAttribute('error.type', 'tool_error');
        toolSpan.setStatus({ code: SpanStatusCode.ERROR, message: 'tool returned an error' });
      }
      toolSpan.end(now);
    }
    this.lastBoundary = now;
  }

  private onResult(message: LooseMessage): void {
    if (typeof message.total_cost_usd === 'number') this.sessionSpan.setAttribute('bg_agent.cost_usd', message.total_cost_usd);
    if (typeof message.num_turns === 'number') this.sessionSpan.setAttribute('bg_agent.num_turns', message.num_turns);
    if (typeof message.subtype === 'string') this.sessionSpan.setAttribute('bg_agent.sdk_result', message.subtype);
  }

  private close(result: SessionResult): void {
    this.flushChat();
    const end = this.now();

    for (const toolSpan of this.openTools.values()) {
      toolSpan.setAttribute('error.type', 'incomplete');
      toolSpan.setStatus({ code: SpanStatusCode.ERROR, message: 'session ended before the tool returned' });
      toolSpan.end(end);
    }
    this.openTools.clear();

    // Splunk AO requires an output on agent spans, so failures get a status line instead.
    const output = result.finalResponse || `[${result.status}] ${result.error ?? ''}`.trim();
    this.sessionSpan.setAttributes({
      'bg_agent.session_status': result.status,
      'bg_agent.tool_call_count': result.toolCallCount,
      'gen_ai.output.messages': messagesAttribute([textMessage('assistant', output)]),
    });
    if (result.status !== 'success' && result.status !== 'cancelled') {
      this.sessionSpan.setAttribute('error.type', result.status);
      this.sessionSpan.setStatus({ code: SpanStatusCode.ERROR, message: result.error ?? result.status });
    }
    this.sessionSpan.end(end);
  }

  private warnOnce(err: unknown): void {
    if (this.warned) return;
    this.warned = true;
    this.logger?.warn({ err }, 'telemetry_recorder_error');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/telemetry/session-recorder.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/telemetry/session-recorder.ts src/telemetry/session-recorder.test.ts
git commit -m "feat(telemetry): record session, chat and tool spans from SDK stream

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Wire the recorder into ClaudeCodeSession

**Files:**
- Modify: `src/types.ts:3-11` (`SessionConfig`)
- Modify: `src/orchestrator/claude-code-session.ts:1-16` (imports), `:276-466` (`run`)
- Test: `src/orchestrator/claude-code-session.test.ts` (append a new `describe`)

**Interfaces:**
- Consumes: `SessionSpanRecorder` (Task 5); `getTracer`, `installTestTracing`, `resetTracingForTests` (Task 2)
- Produces: `SessionConfig.traceContext?: Context`. A session's spans nest under this context, or start a new trace when it is absent.

- [ ] **Step 1: Write the failing test**

Append to `src/orchestrator/claude-code-session.test.ts`. Add the new imports at the top of the file, next to the existing imports and after the `vi.mock` calls:
```ts
import { afterEach } from 'vitest';
import { ROOT_CONTEXT, SpanStatusCode, trace } from '@opentelemetry/api';
import type { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { getTracer, installTestTracing, resetTracingForTests } from '../telemetry/tracing.js';
```
Then append at the end of the file:
```ts
describe('ClaudeCodeSession tracing', () => {
  let exporter: InMemorySpanExporter;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ANTHROPIC_API_KEY = 'test-api-key';
    mockExecFile.mockImplementation((...args: any[]) => {
      const callback = args[args.length - 1];
      if (typeof callback === 'function') callback(null, '', '');
    });
    exporter = installTestTracing();
  });

  afterEach(async () => {
    await resetTracingForTests();
  });

  function assistantMsg(id: string, content: any[], stopReason: string) {
    return {
      type: 'assistant', parent_tool_use_id: null, session_id: 's', uuid: `u-${id}`,
      message: {
        id, model: 'claude-sonnet-5-5', role: 'assistant', content, stop_reason: stopReason,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    };
  }

  it('records session, chat and tool spans under the provided trace context', async () => {
    mockQuery.mockReturnValue(makeQueryGen([
      { type: 'system', subtype: 'init', model: 'claude-sonnet-5-5', tools: ['Read', 'Edit'], session_id: 's', uuid: 'u0' },
      assistantMsg('m1', [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'a.ts' } }], 'tool_use'),
      { type: 'user', parent_tool_use_id: null, session_id: 's', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
      assistantMsg('m2', [{ type: 'text', text: 'Done' }], 'end_turn'),
      makeSuccessResult(),
    ]));
    const parent = getTracer().startSpan('attempt 1');
    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace', traceContext: trace.setSpan(ROOT_CONTEXT, parent) });

    const result = await session.run('Fix the bug');
    parent.end();

    expect(result.status).toBe('success');
    const spans = exporter.getFinishedSpans();
    const sessionSpan = spans.find((s) => s.name === 'invoke_agent claude-code')!;
    expect(sessionSpan.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(spans.filter((s) => s.name === 'chat claude-sonnet-5-5')).toHaveLength(2);
    expect(spans.filter((s) => s.name === 'execute_tool Edit')).toHaveLength(1);
    expect(sessionSpan.attributes['bg_agent.cost_usd']).toBe(0.05);
    expect(sessionSpan.attributes['bg_agent.session_status']).toBe('success');
  });

  it('ends the session span as an error when the query throws', async () => {
    mockQuery.mockImplementationOnce(() => { throw new Error('boom'); });
    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace' });

    const result = await session.run('task');

    expect(result.status).toBe('failed');
    const sessionSpan = exporter.getFinishedSpans().find((s) => s.name === 'invoke_agent claude-code')!;
    expect(sessionSpan.status.code).toBe(SpanStatusCode.ERROR);
    expect(sessionSpan.attributes['error.type']).toBe('failed');
  });

  it('records a cancelled session span when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace' });

    const result = await session.run('task', undefined, controller.signal);

    expect(result.status).toBe('cancelled');
    const sessionSpan = exporter.getFinishedSpans().find((s) => s.name === 'invoke_agent claude-code')!;
    expect(sessionSpan.attributes['bg_agent.session_status']).toBe('cancelled');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/orchestrator/claude-code-session.test.ts -t "ClaudeCodeSession tracing"`
Expected: FAIL. The type check rejects `traceContext` ("Object literal may only specify known properties"), and at runtime no `invoke_agent claude-code` span is found (`Cannot read properties of undefined`).

- [ ] **Step 3: Add `traceContext` to `SessionConfig`**

In `src/types.ts`, replace lines 1-11 with:
```ts
import type pino from 'pino';
import type { Context } from '@opentelemetry/api';

export interface SessionConfig {
  workspaceDir: string;
  model?: string;
  turnLimit?: number;    // default: 10
  timeoutMs?: number;    // default: 300000 (5 minutes)
  logger?: pino.Logger;
  signal?: AbortSignal;  // external cancellation signal
  readOnly?: boolean;    // mount workspace :ro, block Write/Edit via hook
  traceContext?: Context; // OTel parent context; session spans nest under it (telemetry)
}
```

- [ ] **Step 4: Split `run` into a traced wrapper and `runInner`**

In `src/orchestrator/claude-code-session.ts`:

1. After the line `import { buildDockerRunArgs } from '../cli/docker/index.js';`, add:
```ts
import { SessionSpanRecorder } from '../telemetry/session-recorder.js';
```

2. Replace the `run` method's signature and its first line:
```ts
  async run(userMessage: string, logger?: pino.Logger, signal?: AbortSignal): Promise<SessionResult> {
    const log = logger ?? pino({ level: 'silent' });
    const sessionId = crypto.randomUUID();
```
with:
```ts
  async run(userMessage: string, logger?: pino.Logger, signal?: AbortSignal): Promise<SessionResult> {
    const log = logger ?? pino({ level: 'silent' });
    const recorder = new SessionSpanRecorder(userMessage, this.config.traceContext, { model: this.config.model, logger: log });
    let result: SessionResult | undefined;
    try {
      result = await this.runInner(userMessage, log, signal, recorder);
      return result;
    } finally {
      recorder.finish(result ?? {
        sessionId: '',
        status: 'failed',
        toolCallCount: 0,
        duration: 0,
        finalResponse: '',
        error: 'Session threw before returning a result',
      });
    }
  }

  private async runInner(
    userMessage: string,
    log: pino.Logger,
    signal: AbortSignal | undefined,
    recorder: SessionSpanRecorder,
  ): Promise<SessionResult> {
    const sessionId = crypto.randomUUID();
```
Everything after `const sessionId = crypto.randomUUID();` stays as it is and is now the body of `runInner`.

3. In `runInner`, replace the message loop:
```ts
      for await (const message of queryGen) {
        if (message.type === 'result') {
          finalResult = message as SDKResultMessage;
        }
      }
```
with:
```ts
      for await (const message of queryGen) {
        recorder.onMessage(message);
        if (message.type === 'result') {
          finalResult = message as SDKResultMessage;
        }
      }
```

- [ ] **Step 5: Run the session tests to verify they pass**

Run: `npx vitest run src/orchestrator/claude-code-session.test.ts`
Expected: PASS. All pre-existing tests plus the 3 new tracing tests pass.

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/orchestrator/claude-code-session.ts src/orchestrator/claude-code-session.test.ts
git commit -m "feat(telemetry): trace ClaudeCodeSession turns and tool calls

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Attempt, verify and judge spans in RetryOrchestrator

**Files:**
- Modify: `src/orchestrator/retry.ts:1-8` (imports), `:149-390` (loop body in `run`)
- Test: `src/orchestrator/retry.test.ts` (append a new `describe`)

**Interfaces:**
- Consumes: `startWorkflowSpan`, `endWorkflowSpan` (Task 4); `SessionConfig.traceContext` (Task 6); `installTestTracing`, `resetTracingForTests` (Task 2)
- Produces:
  - one `attempt <n>` span per loop iteration that reaches session creation, with attributes `bg_agent.attempt`, `bg_agent.session_status`, `bg_agent.verification.passed`, `bg_agent.judge.verdict`
  - a `verify` span with `bg_agent.config_only`, `bg_agent.verification.passed`, `bg_agent.verification.error_count`, `bg_agent.verification.duration_ms`
  - a `judge` span with `bg_agent.judge.verdict`, `bg_agent.judge.skipped`, `bg_agent.judge.duration_ms`
  - each session is constructed with `traceContext` = the attempt span's context

- [ ] **Step 1: Write the failing test**

In `src/orchestrator/retry.test.ts`, change the first import line to include `afterEach`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
```
and add after the existing imports (below `import { compositeVerifier } from './verifier.js';`):
```ts
import { trace, SpanStatusCode } from '@opentelemetry/api';
import type { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { installTestTracing, resetTracingForTests } from '../telemetry/tracing.js';
```
Append at the end of the file:
```ts
describe('RetryOrchestrator tracing', () => {
  let exporter: InMemorySpanExporter;

  beforeEach(() => {
    vi.clearAllMocks();
    exporter = installTestTracing();
  });

  afterEach(async () => {
    await resetTracingForTests();
  });

  it('wraps an attempt in a span with verify and judge children, and passes its context to the session', async () => {
    const session = createMockSession(makeSessionResult());
    MockClaudeCodeSession.mockImplementationOnce(function () { return session; });
    const verifier = vi.fn().mockResolvedValue(makePassedVerification());
    const judge = vi.fn().mockResolvedValue({ verdict: 'APPROVE', reasoning: 'In scope', veto_reason: '', durationMs: 5 });
    const orchestrator = new RetryOrchestrator({ workspaceDir: '/tmp/workspace' }, { maxRetries: 3, verifier, judge });

    const result = await orchestrator.run('Fix the bug');

    expect(result.finalStatus).toBe('success');
    const spans = exporter.getFinishedSpans();
    const attempt = spans.find((s) => s.name === 'attempt 1')!;
    const verify = spans.find((s) => s.name === 'verify')!;
    const judgeSpan = spans.find((s) => s.name === 'judge')!;
    expect(attempt.attributes).toMatchObject({
      'bg_agent.attempt': 1,
      'bg_agent.session_status': 'success',
      'bg_agent.verification.passed': true,
      'bg_agent.judge.verdict': 'APPROVE',
    });
    expect(verify.parentSpanContext?.spanId).toBe(attempt.spanContext().spanId);
    expect(verify.attributes).toMatchObject({ 'bg_agent.verification.passed': true, 'bg_agent.verification.error_count': 0 });
    expect(judgeSpan.parentSpanContext?.spanId).toBe(attempt.spanContext().spanId);
    expect(judgeSpan.attributes).toMatchObject({ 'bg_agent.judge.verdict': 'APPROVE', 'bg_agent.judge.skipped': false });

    const sessionConfig = MockClaudeCodeSession.mock.calls[0][0];
    expect(trace.getSpan(sessionConfig.traceContext)?.spanContext().spanId).toBe(attempt.spanContext().spanId);
  });

  it('records one attempt span per retry and the failing verification', async () => {
    MockClaudeCodeSession
      .mockImplementationOnce(function () { return createMockSession(makeSessionResult()); })
      .mockImplementationOnce(function () { return createMockSession(makeSessionResult()); });
    const verifier = vi.fn()
      .mockResolvedValueOnce(makeFailedVerification('Build failed'))
      .mockResolvedValueOnce(makePassedVerification());
    const orchestrator = new RetryOrchestrator({ workspaceDir: '/tmp/workspace' }, { maxRetries: 3, verifier });

    await orchestrator.run('Fix the bug');

    const spans = exporter.getFinishedSpans();
    expect(spans.filter((s) => s.name.startsWith('attempt ')).map((s) => s.name).sort()).toEqual(['attempt 1', 'attempt 2']);
    const firstVerify = spans.filter((s) => s.name === 'verify')[0];
    expect(firstVerify.attributes).toMatchObject({ 'bg_agent.verification.passed': false, 'bg_agent.verification.error_count': 1 });
    expect(String(firstVerify.attributes['gen_ai.output.messages'])).toContain('Build failed');
  });

  it('ends the verify span as an error when the verifier crashes', async () => {
    MockClaudeCodeSession.mockImplementationOnce(function () { return createMockSession(makeSessionResult()); });
    const verifier = vi.fn().mockRejectedValue(new Error('mvn not found'));
    const orchestrator = new RetryOrchestrator({ workspaceDir: '/tmp/workspace' }, { maxRetries: 3, verifier });

    const result = await orchestrator.run('Fix the bug');

    expect(result.finalStatus).toBe('failed');
    const verify = exporter.getFinishedSpans().find((s) => s.name === 'verify')!;
    expect(verify.status).toEqual({ code: SpanStatusCode.ERROR, message: 'mvn not found' });
    expect(exporter.getFinishedSpans().find((s) => s.name === 'attempt 1')).toBeDefined();
  });

  it('ends the attempt span when the session fails terminally', async () => {
    MockClaudeCodeSession.mockImplementationOnce(function () {
      return createMockSession(makeSessionResult({ status: 'timeout', error: 'Session timeout reached' }));
    });
    const orchestrator = new RetryOrchestrator({ workspaceDir: '/tmp/workspace' }, { maxRetries: 3 });

    await orchestrator.run('Fix the bug');

    const attempt = exporter.getFinishedSpans().find((s) => s.name === 'attempt 1')!;
    expect(attempt.attributes['bg_agent.session_status']).toBe('timeout');
    expect(String(attempt.attributes['gen_ai.output.messages'])).toContain('session timeout');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/orchestrator/retry.test.ts -t "RetryOrchestrator tracing"`
Expected: FAIL. `attempt 1` span not found (`Cannot read properties of undefined (reading 'attributes')`).

- [ ] **Step 3: Add imports**

In `src/orchestrator/retry.ts`, after `import { ErrorSummarizer } from './summarizer.js';`, add:
```ts
import { context as otelContext } from '@opentelemetry/api';
import { startWorkflowSpan, endWorkflowSpan } from '../telemetry/spans.js';
```

- [ ] **Step 4: Wrap the attempt body in an attempt span**

In `run`, after this existing block:
```ts
      const message = attempt === 1
        ? originalTask
        : this.buildRetryMessage(originalTask, attempt, verificationResults);
```
insert:
```ts
      const attemptTrace = startWorkflowSpan(
        `attempt ${attempt}`,
        this.config.traceContext ?? otelContext.active(),
        message,
        { 'bg_agent.attempt': attempt },
      );
      let attemptSummary = 'attempt started';
      try {
```
Then close the `try` at the very end of the `for` loop body. The loop body currently ends with the `logger?.warn(... 'Verification failed, retrying with error context' ...)` call followed by `    }` (the `for` loop's closing brace). Replace:
```ts
        'Verification failed, retrying with error context'
      );
    }
```
with:
```ts
        'Verification failed, retrying with error context'
      );
      } finally {
        endWorkflowSpan(attemptTrace.span, attemptSummary);
      }
    }
```
Re-indent the wrapped block by two spaces (your editor's "indent selection"). No other changes are needed for `return` and `continue` inside the `try`: they run the `finally` automatically.

- [ ] **Step 5: Pass the attempt context to the session and record outcomes**

Make these replacements inside the wrapped block.

a) Session construction:
```ts
      const session = new ClaudeCodeSession(this.config);
```
→
```ts
      const session = new ClaudeCodeSession({ ...this.config, traceContext: attemptTrace.ctx });
```

b) Right after `sessionResults.push(sessionResult);` add:
```ts
      attemptTrace.span.setAttribute('bg_agent.session_status', sessionResult.status);
      attemptSummary = `session ${sessionResult.status}${sessionResult.error ? `: ${sessionResult.error}` : ''}`;
```

c) Inside the zero-diff `if`, before its `return`, add:
```ts
        attemptSummary = 'zero diff: agent produced no meaningful changes';
```

d) Inside `if (!this.retryConfig.verifier) {`, before its `return`, add:
```ts
        attemptSummary = 'session succeeded (no verifier configured)';
```

e) In the preVerify `catch`: before `continue; // next attempt with error context`, add `attemptSummary = 'pre-verify failed (retryable)';`. Before the terminal `return` (after `logger?.error({ attempt, err }, 'Pre-verify hook failed (terminal)');`), add `attemptSummary = 'pre-verify failed (terminal)';`.

f) Replace the verification block:
```ts
      let verification: VerificationResult;
      try {
        verification = configOnly
          ? await this.retryConfig.verifier(this.config.workspaceDir, { configOnly: true })
          : await this.retryConfig.verifier(this.config.workspaceDir);
      } catch (err) {
        logger?.error({ attempt, err }, 'Verifier crashed');
```
with:
```ts
      const verifyTrace = startWorkflowSpan(
        'verify',
        attemptTrace.ctx,
        changedFiles.length > 0 ? `changed files:\n${changedFiles.join('\n')}` : 'changed files: (none committed)',
        { 'bg_agent.config_only': configOnly },
      );
      let verification: VerificationResult;
      try {
        verification = configOnly
          ? await this.retryConfig.verifier(this.config.workspaceDir, { configOnly: true })
          : await this.retryConfig.verifier(this.config.workspaceDir);
      } catch (err) {
        endWorkflowSpan(verifyTrace.span, 'verifier crashed', { error: err instanceof Error ? err.message : String(err) });
        attemptSummary = 'verifier crashed';
        logger?.error({ attempt, err }, 'Verifier crashed');
```
and immediately after `verificationResults.push(verification);` add:
```ts
      endWorkflowSpan(
        verifyTrace.span,
        verification.passed
          ? 'passed'
          : `failed:\n${verification.errors.map((e) => `[${e.type}] ${e.summary}`).join('\n')}`,
        {
          attributes: {
            'bg_agent.verification.passed': verification.passed,
            'bg_agent.verification.error_count': verification.errors.length,
            'bg_agent.verification.duration_ms': verification.durationMs,
          },
        },
      );
      attemptTrace.span.setAttribute('bg_agent.verification.passed', verification.passed);
      attemptSummary = verification.passed ? 'verification passed' : 'verification failed';
```

g) Judge: replace
```ts
          let judgeResult: JudgeResult;
          try {
```
with:
```ts
          const judgeTrace = startWorkflowSpan('judge', attemptTrace.ctx, originalTask);
          let judgeResult: JudgeResult;
          try {
```
and immediately after `judgeResults.push(judgeResult);` add:
```ts
          endWorkflowSpan(judgeTrace.span, `${judgeResult.verdict}: ${judgeResult.reasoning}`, {
            attributes: {
              'bg_agent.judge.verdict': judgeResult.verdict,
              'bg_agent.judge.skipped': judgeResult.skipped ?? false,
              'bg_agent.judge.duration_ms': judgeResult.durationMs,
            },
          });
          attemptTrace.span.setAttribute('bg_agent.judge.verdict', judgeResult.verdict);
          attemptSummary = `verification passed; judge ${judgeResult.verdict}${judgeResult.skipped ? ' (skipped)' : ''}`;
```

h) In the judge-budget-exhausted branch (`if (judgeVetoCount >= maxJudgeVetoes) {`), before its `return`, add:
```ts
            attemptSummary = 'judge veto budget exhausted';
```

- [ ] **Step 6: Run the retry tests to verify they pass**

Run: `npx vitest run src/orchestrator/retry.test.ts`
Expected: PASS. All pre-existing tests plus the 4 new tracing tests pass.

- [ ] **Step 7: Type-check and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/orchestrator/retry.ts src/orchestrator/retry.test.ts
git commit -m "feat(telemetry): trace retry attempts, verification and judge

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Run root span in runAgent, plus docs

**Files:**
- Modify: `src/agent/index.ts:14-28` (imports), `:75-384` (`runAgent`)
- Test: `src/agent/index.test.ts` (append a new `describe`)
- Modify: `README.md` (Getting Started)

**Interfaces:**
- Consumes:
  - `initTracing`, `flushTracing`, `getTracer`, `installTestTracing`, `resetTracingForTests` (Task 2)
  - `messagesAttribute` (Task 4)
  - `textMessage` (Task 3)
  - `SessionConfig.traceContext` (Task 6)
- Produces: the root span `invoke_agent background-coding-agent`, with:
  - `gen_ai.conversation.id`, `splunk_ao.session.id` and `bg_agent.run_id`: all the same UUID
  - `bg_agent.task_type`, `bg_agent.repo` (basename only), `bg_agent.final_status`, `bg_agent.attempts`, and `bg_agent.pr_url` when present

  Its context is passed as `traceContext` to `RetryOrchestrator` and to the investigation `ClaudeCodeSession`. `runAgent` flushes telemetry before returning.

- [ ] **Step 1: Write the failing test**

In `src/agent/index.test.ts`, change the first import to include `afterEach`:
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
```
and add after `import { runAgent } from './index.js';`:
```ts
import { trace, SpanStatusCode } from '@opentelemetry/api';
import type { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { installTestTracing, resetTracingForTests } from '../telemetry/tracing.js';
```
Append at the end of the file:
```ts
describe('runAgent tracing', () => {
  let exporter: InMemorySpanExporter;
  const options = {
    taskType: 'maven-dependency-update',
    repo: '/tmp/my-app',
    turnLimit: 10,
    timeoutMs: 300_000,
    maxRetries: 3,
    dep: 'com.example:lib',
    targetVersion: '1.0.0',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
    exporter = installTestTracing();
  });

  afterEach(async () => {
    await resetTracingForTests();
  });

  const rootSpan = () => exporter.getFinishedSpans().find((s) => s.name === 'invoke_agent background-coding-agent')!;

  it('wraps the run in a root span and passes its context to the orchestrator', async () => {
    mockOrchestrator('success');

    await runAgent(options, { skipWorktree: true });

    const root = rootSpan();
    expect(root.attributes).toMatchObject({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': 'background-coding-agent',
      'bg_agent.task_type': 'maven-dependency-update',
      'bg_agent.repo': 'my-app',
      'bg_agent.final_status': 'success',
      'bg_agent.attempts': 1,
    });
    expect(root.attributes['gen_ai.conversation.id']).toBe(root.attributes['bg_agent.run_id']);
    expect(root.attributes['splunk_ao.session.id']).toBe(root.attributes['bg_agent.run_id']);
    expect(String(root.attributes['gen_ai.input.messages'])).toContain('Fix the bug'); // mocked buildPrompt
    expect(root.status.code).toBe(SpanStatusCode.UNSET);

    const orchestratorConfig = MockRetryOrchestrator.mock.calls[0][0];
    expect(trace.getSpan(orchestratorConfig.traceContext)?.spanContext().spanId).toBe(root.spanContext().spanId);
  });

  it('marks the root span as an error when the run fails', async () => {
    mockOrchestrator('max_retries_exhausted');

    await runAgent(options, { skipWorktree: true });

    const root = rootSpan();
    expect(root.status.code).toBe(SpanStatusCode.ERROR);
    expect(root.attributes['error.type']).toBe('max_retries_exhausted');
    expect(String(root.attributes['gen_ai.output.messages'])).toContain('max_retries_exhausted');
  });

  it('gives every run its own conversation id', async () => {
    mockOrchestrator('success');
    mockOrchestrator('success');

    await runAgent(options, { skipWorktree: true });
    await runAgent(options, { skipWorktree: true });

    const roots = exporter.getFinishedSpans().filter((s) => s.name === 'invoke_agent background-coding-agent');
    expect(roots).toHaveLength(2);
    expect(roots[0].attributes['gen_ai.conversation.id']).not.toBe(roots[1].attributes['gen_ai.conversation.id']);
  });

  it('records the root span and rethrows when the run throws', async () => {
    MockRetryOrchestrator.mockImplementationOnce(function () {
      return { run: vi.fn().mockRejectedValue(new Error('orchestrator exploded')), stop: vi.fn() };
    });

    await expect(runAgent(options, { skipWorktree: true })).rejects.toThrow('orchestrator exploded');

    const root = rootSpan();
    expect(root.status).toEqual({ code: SpanStatusCode.ERROR, message: 'orchestrator exploded' });
  });

  it('passes the root context to investigation sessions', async () => {
    mockSessionRun.mockResolvedValue({ sessionId: 's', status: 'success', toolCallCount: 0, duration: 10, finalResponse: 'Report' });

    await runAgent(
      { taskType: 'investigation', repo: '/tmp/my-app', turnLimit: 5, timeoutMs: 60_000, maxRetries: 1, description: 'analyze git strategy' },
      { skipDockerChecks: true },
    );

    const root = rootSpan();
    const MockCtor = ClaudeCodeSession as unknown as ReturnType<typeof vi.fn>;
    const sessionConfig = MockCtor.mock.calls[0][0];
    expect(trace.getSpan(sessionConfig.traceContext)?.spanContext().spanId).toBe(root.spanContext().spanId);
    expect(root.attributes['bg_agent.task_type']).toBe('investigation');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/agent/index.test.ts -t "runAgent tracing"`
Expected: FAIL. `invoke_agent background-coding-agent` span not found (`Cannot read properties of undefined (reading 'attributes')`).

- [ ] **Step 3: Add imports**

In `src/agent/index.ts`:
- Replace `import { randomBytes } from 'node:crypto';` with `import { randomBytes, randomUUID } from 'node:crypto';`
- Replace `import type { RetryResult } from '../types.js';` with:
```ts
import type { RetryResult } from '../types.js';
import { SpanKind, SpanStatusCode, context as otelContext, trace, type Context, type Span } from '@opentelemetry/api';
import { initTracing, flushTracing, getTracer } from '../telemetry/tracing.js';
import { messagesAttribute } from '../telemetry/spans.js';
import { textMessage } from '../telemetry/genai.js';
```

- [ ] **Step 4: Add the traced wrapper**

Rename the existing function. Change
```ts
export async function runAgent(
  options: AgentOptions,
  context: AgentContext = {}
): Promise<RetryResult> {
```
to
```ts
async function runAgentInner(
  options: AgentOptions,
  context: AgentContext,
  runSpan: Span,
  runCtx: Context,
): Promise<RetryResult> {
```
Then insert this **above** `runAgentInner`, keeping the existing JSDoc block on the new exported `runAgent`:
```ts
/** Run outcomes that are not failures (zero_diff: agent finished cleanly; cancelled: user asked). */
const NON_ERROR_STATUSES: ReadonlySet<RetryResult['finalStatus']> = new Set(['success', 'zero_diff', 'cancelled']);

function summarizeRun(result: RetryResult): string {
  const lines = [`status: ${result.finalStatus} after ${result.attempts} attempt(s)`];
  if (result.prResult?.url) lines.push(`PR: ${result.prResult.url}`);
  if (result.error) lines.push(`error: ${result.error}`);
  const lastResponse = result.sessionResults[result.sessionResults.length - 1]?.finalResponse;
  if (lastResponse) lines.push(lastResponse);
  return lines.join('\n');
}

export async function runAgent(
  options: AgentOptions,
  context: AgentContext = {}
): Promise<RetryResult> {
  const logger = context.logger ?? pino({ level: 'silent' });
  initTracing({ logger });

  const runId = randomUUID();
  const runSpan = getTracer().startSpan('invoke_agent background-coding-agent', {
    kind: SpanKind.INTERNAL,
    attributes: {
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.provider.name': 'anthropic',
      'gen_ai.agent.name': 'background-coding-agent',
      'gen_ai.conversation.id': runId,
      'splunk_ao.session.id': runId,
      'bg_agent.run_id': runId,
      'bg_agent.task_type': options.taskType,
      'bg_agent.repo': path.basename(options.repo),
      'gen_ai.input.messages': messagesAttribute([textMessage('user', options.description ?? options.taskType)]),
    },
  });
  const runCtx = trace.setSpan(otelContext.active(), runSpan);

  try {
    const result = await runAgentInner(options, context, runSpan, runCtx);
    runSpan.setAttributes({ 'bg_agent.final_status': result.finalStatus, 'bg_agent.attempts': result.attempts });
    if (result.prResult?.url) runSpan.setAttribute('bg_agent.pr_url', result.prResult.url);
    runSpan.setAttribute('gen_ai.output.messages', messagesAttribute([textMessage('assistant', summarizeRun(result))]));
    if (!NON_ERROR_STATUSES.has(result.finalStatus)) {
      runSpan.setAttribute('error.type', result.finalStatus);
      runSpan.setStatus({ code: SpanStatusCode.ERROR, message: result.error ?? result.finalStatus });
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    runSpan.setAttribute('error.type', err instanceof Error ? err.name : 'Error');
    runSpan.setAttribute('gen_ai.output.messages', messagesAttribute([textMessage('assistant', `run threw: ${message}`)]));
    runSpan.setStatus({ code: SpanStatusCode.ERROR, message });
    throw err;
  } finally {
    runSpan.end();
    await flushTracing(logger);
  }
}
```

- [ ] **Step 5: Thread the root context through `runAgentInner`**

Inside `runAgentInner`:

a) Investigation branch: after
```ts
      const prompt = await buildPrompt({
        taskType: options.taskType,
        description: options.description,
        explorationSubtype: options.explorationSubtype,
      });
```
add:
```ts
      runSpan.setAttribute('gen_ai.input.messages', messagesAttribute([textMessage('user', prompt)]));
```
and in that branch's `new ClaudeCodeSession({ ... readOnly: true, })`, add the property `traceContext: runCtx,` after `readOnly: true,`.

b) Main path: in `new RetryOrchestrator({ workspaceDir: effectiveWorkspaceDir, ... signal: context.signal, }, ...)`, add `traceContext: runCtx,` after `signal: context.signal,  // Thread AbortSignal through the full chain`.

c) Main path: after
```ts
    const prompt = await buildPrompt({
      taskType: options.taskType,
      dep: options.dep,
      targetVersion: resolvedVersion,
      description: options.description,
      repoPath: effectiveWorkspaceDir,
      scopeHints: options.scopeHints,
    });
```
add:
```ts
    runSpan.setAttribute('gen_ai.input.messages', messagesAttribute([textMessage('user', prompt)]));
```

- [ ] **Step 6: Run the runAgent tests to verify they pass**

Run: `npx vitest run src/agent/index.test.ts`
Expected: PASS. All pre-existing tests plus the 5 new tracing tests pass.

- [ ] **Step 7: Document the env vars**

In `README.md`, in `### Prerequisites`, after the line `- **Slack app credentials** — only needed for \`background-agent slack start\``, add:
```markdown
- **Splunk Agent Observability** (optional) — traces every run (attempts, LLM turns, tool calls, verifier, judge) when these are set:

  | Variable | Required | Default | Purpose |
  |---|---|---|---|
  | `SPLUNK_AO_REALM` | yes | — | Splunk Observability Cloud realm, e.g. `eu0` |
  | `SPLUNK_AO_O11Y_TOKEN` | yes | — | Access token with the **INGEST** scope |
  | `SPLUNK_AO_PROJECT` | no | `background-coding-agent` | Agent Observability project |
  | `SPLUNK_AO_AGENT_STREAM` | no | `default` | Agent Stream inside the project |
  | `SPLUNK_AO_CAPTURE_CONTENT` | no | `true` | `false` redacts prompts, model output, tool arguments and tool results |
  | `SPLUNK_AO_LOGGING_DISABLED` | no | — | `true` turns telemetry off |

  Telemetry is exported from the host process only; the agent container never sees these values.
  With `.env`, run via `npx tsx --env-file=.env src/cli/index.ts`.
```

- [ ] **Step 8: Run the full suite, type-check, lint**

Run: `npm test && npx tsc --noEmit && npm run lint`
Expected: all tests pass, no type or lint errors.

- [ ] **Step 9: Commit**

```bash
git add src/agent/index.ts src/agent/index.test.ts README.md
git commit -m "feat(telemetry): trace each agent run and flush to Splunk AO

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: End-to-end verification against Splunk

This task has no code. It confirms that the real pipeline lands in Splunk the way the spike did, and it checks the one behaviour the spike couldn't: whether each run becomes its own Splunk session.

**Files:** none

- [ ] **Step 1: Confirm `.env` has the Splunk settings**

Run: `grep -E '^SPLUNK_AO_(REALM|PROJECT|AGENT_STREAM)=' .env && grep -c '^SPLUNK_AO_O11Y_TOKEN=.\+' .env`
Expected: three lines (`eu0`, `bg-agent-spike`, `dev`) and `1`.

- [ ] **Step 2: Run a small real task**

Run (against a small local npm repo you own; replace the path):
```bash
npx tsx --env-file=.env src/cli/index.ts "update lodash to latest in /path/to/small-npm-repo"
```
Expected: the run completes as before. The log contains `Splunk AO telemetry enabled` and no `telemetry_export_failed` or `telemetry_flush_timeout`.

- [ ] **Step 3: Check the trace in Splunk**

In Splunk Observability Cloud → Agent Observability → `bg-agent-spike` → Agent Stream `dev`, open the newest trace. Expected tree:
`invoke_agent background-coding-agent` → `attempt 1` → (`invoke_agent claude-code` → `chat …` / `execute_tool …`), `verify`, `judge`.

Also check:
- the `chat` steps show token counts
- `execute_tool` steps show arguments and results
- Action Completion, Agent Efficiency and Tool Error Rate produce scores within ~2 minutes

- [ ] **Step 4: Check session grouping**

Run the Step 2 command a second time. Expected: the stream shows **two sessions**, one per run. If both runs land in a single session, `gen_ai.conversation.id` / `splunk_ao.session.id` on the root span is not what Splunk groups by. Record that in `galileo-observability-research.md` §0, and open a follow-up to move `splunk_ao.session.id` to the place Splunk actually reads.

- [ ] **Step 5: Check the redaction switch**

Run Step 2 again with `SPLUNK_AO_CAPTURE_CONTENT=false npx tsx --env-file=.env src/cli/index.ts "…"`. Expected: the new trace shows `[redacted]` for prompts, outputs, tool arguments and results. Tool names, token counts and statuses are still visible.

- [ ] **Step 6: Record the outcome**

Append an "Integration verified (date)" paragraph to `galileo-observability-research.md` §0 with what Steps 3–5 showed, then commit:
```bash
git add galileo-observability-research.md
git commit -m "docs: record Splunk AO integration verification

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
