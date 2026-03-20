import Anthropic from '@anthropic-ai/sdk';
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import { IntentSchema, type IntentResult } from './types.js';

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

export async function llmParse(input: string, manifestContext: string): Promise<IntentResult> {
  const client = new Anthropic({ timeout: 15_000 });
  const response = await client.beta.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    stream: false,
    system: INTENT_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `<manifest_context>\n${manifestContext}\n</manifest_context>\n\n<user_input>${input}</user_input>`,
    }],
    betas: ['structured-outputs-2025-11-13'],
    output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any) as BetaMessage;

  const text = response.content[0].type === 'text' ? response.content[0].text : '{}';
  return IntentSchema.parse(JSON.parse(text));
}
