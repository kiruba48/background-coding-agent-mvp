import Anthropic from '@anthropic-ai/sdk';
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import { IntentSchema, type IntentResult } from './types.js';

const MAX_INPUT_LENGTH = 500;

const INTENT_SYSTEM_PROMPT = `You are an intent classifier for a coding agent CLI. Given a natural language task description and the project's manifest dependencies, determine:
1. taskType: 'npm-dependency-update', 'maven-dependency-update', or 'unknown'
2. dep: the dependency name (null if not identifiable)
3. version: ALWAYS set to 'latest' or null. You MUST NOT output a specific version number.
4. confidence: 'high' if the intent is clear, 'low' if ambiguous
5. clarifications: if confidence is 'low', provide 2-3 possible interpretations as {label, intent} pairs. Empty array if confidence is 'high'.

Rules:
- If the user mentions a dependency that exists in the manifest, set confidence to 'high'.
- If the user's request doesn't match a dependency update pattern, set taskType to 'unknown'.
- For unknown task types, set dep to null and confidence to 'high' (pass through as generic task).
- NEVER set version to a specific version number. Only 'latest' or null.`;

const OUTPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    taskType: { type: 'string', enum: ['npm-dependency-update', 'maven-dependency-update', 'unknown'] },
    dep: { type: ['string', 'null'] },
    version: { type: ['string', 'null'], enum: ['latest', null] },
    confidence: { type: 'string', enum: ['high', 'low'] },
    clarifications: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          intent: { type: 'string' },
        },
        required: ['label', 'intent'],
        additionalProperties: false,
      },
    },
  },
  required: ['taskType', 'dep', 'version', 'confidence', 'clarifications'],
  additionalProperties: false,
};

/** Escape XML special characters to prevent prompt injection */
function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Module-level client for connection reuse across calls */
let sharedClient: Anthropic | null = null;
function getClient(): Anthropic {
  if (!sharedClient) {
    sharedClient = new Anthropic({ timeout: 15_000 });
  }
  return sharedClient;
}

export class LlmParseError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'LlmParseError';
  }
}

export async function llmParse(input: string, manifestContext: string): Promise<IntentResult> {
  const truncatedInput = input.length > MAX_INPUT_LENGTH ? input.slice(0, MAX_INPUT_LENGTH) : input;
  const client = getClient();

  let response: BetaMessage;
  try {
    response = await client.beta.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      stream: false,
      system: INTENT_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `<manifest_context>\n${escapeXml(manifestContext)}\n</manifest_context>\n\n<user_input>${escapeXml(truncatedInput)}</user_input>`,
      }],
      betas: ['structured-outputs-2025-11-13'],
      output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any) as BetaMessage;
  } catch (err) {
    throw new LlmParseError(
      'Failed to classify intent — check ANTHROPIC_API_KEY and network connectivity',
      err,
    );
  }

  if (!response.content || response.content.length === 0) {
    throw new LlmParseError('LLM returned empty response content');
  }

  const block = response.content[0];
  if (block.type !== 'text') {
    throw new LlmParseError(`LLM returned unexpected content type: ${block.type}`);
  }

  try {
    return IntentSchema.parse(JSON.parse(block.text));
  } catch (err) {
    throw new LlmParseError('LLM returned invalid JSON or schema mismatch', err);
  }
}
