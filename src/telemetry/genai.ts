/**
 * Pure mapping from Claude Agent SDK / Anthropic message shapes to OpenTelemetry
 * GenAI semantic-convention messages ("parts" format, as used by Splunk AO).
 * No OpenTelemetry imports — everything here is plain data.
 */

export const MAX_CONTENT_CHARS = 16_000;
export const REDACTED = '[redacted]';
export const UNSERIALIZABLE = '[unserializable]';

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

export function safeStringify(value: unknown): string {
  try {
    const result = JSON.stringify(value);
    return result !== undefined ? result : UNSERIALIZABLE;
  } catch {
    return UNSERIALIZABLE;
  }
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
  const serialized = safeStringify(value);
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
  return safeStringify(content);
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
