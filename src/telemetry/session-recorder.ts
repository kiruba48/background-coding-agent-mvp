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
