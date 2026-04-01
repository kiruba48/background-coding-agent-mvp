import Anthropic from '@anthropic-ai/sdk';
import path from 'node:path';
import type { Message } from '@anthropic-ai/sdk/resources/messages/messages.js';
import { IntentSchema, TASK_TYPES, TASK_CATEGORIES, type IntentResult } from './types.js';
import type { TaskHistoryEntry } from '../repl/types.js';
import { readTopLevelDirs } from './context-scanner.js';

export const MAX_INPUT_LENGTH = 500;

const INTENT_SYSTEM_PROMPT = `You are an intent classifier for a coding agent CLI. Given a natural language task description and the project's manifest dependencies, determine:
1. taskType: 'npm-dependency-update', 'maven-dependency-update', or 'generic'
2. dep: the dependency name (null if not identifiable)
3. version: ALWAYS set to 'latest' or null. You MUST NOT output a specific version number.
4. confidence: 'high' if the intent is clear, 'low' if ambiguous
5. createPr: true if the user asks to create/raise/open a PR or pull request, false otherwise
6. clarifications: if confidence is 'low', provide 2-3 possible interpretations as {label, intent} pairs. Empty array if confidence is 'high'.
7. taskCategory: for generic tasks, classify as 'code-change' (replace, add, remove code), 'config-edit' (edit config files, env vars), or 'refactor' (rename, move, extract, restructure). null for dependency updates.
8. project: if the user mentions a target project/repo name (e.g. "in strategic-planner", "for my-app repo"), extract just the project name. null if not mentioned.

Rules:
- If the user mentions a dependency that exists in the manifest, set confidence to 'high'.
- If the user's request doesn't match a dependency update pattern, set taskType to 'generic'. generic = any explicit code change instruction (replace, rename, edit config, add/remove code). NOT task discovery, analysis, or multi-repo ops.
- For generic tasks, set dep to null. Set confidence to 'high' when the instruction is a single clear action (e.g., 'replace axios with fetch', 'rename getUserData to fetchUserProfile'). Set confidence to 'low' when the instruction is vague ('clean up the code'), spans multiple unrelated changes, or sounds like task discovery ('find all deprecated calls'). For low-confidence generic tasks, provide clarifications with narrowed-down interpretations.
- NEVER set version to a specific version number. Only 'latest' or null.
- Set createPr to true when the user says phrases like "create PR", "raise PR", "open pull request", "make a PR", "and PR", etc. Default to false if not mentioned.
9. scopingQuestions: For 'generic' taskType only — generate 0-3 specific scoping questions to clarify the task scope. Questions should reference actual directories, files, or patterns visible in the manifest_context and top_level_dirs. Examples: "This repo has both src/auth/ and src/middleware/ — which area should the error handling focus on?", "Should the change include updating related test files?", "Are there any files or directories that should be excluded from this change?". Set to empty array [] for dependency update tasks or when the task is already unambiguous (e.g. "rename X to Y").`;

const OUTPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    taskType: { type: 'string', enum: [...TASK_TYPES] },
    dep: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    version: { anyOf: [{ type: 'string', enum: ['latest'] }, { type: 'null' }] },
    confidence: { type: 'string', enum: ['high', 'low'] },
    createPr: { type: 'boolean' },
    taskCategory: { anyOf: [
      { type: 'string', enum: [...TASK_CATEGORIES] },
      { type: 'null' },
    ]},
    project: { anyOf: [{ type: 'string' }, { type: 'null' }] },
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
    scopingQuestions: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['taskType', 'dep', 'version', 'confidence', 'createPr', 'taskCategory', 'project', 'clarifications'],
  additionalProperties: false,
};

/** Escape XML special characters to prevent prompt injection */
function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Truncate to last sentence boundary within 300 chars, with 50-char minimum before accepting boundary. */
export function summarize(raw: string): string {
  if (!raw || raw.length <= 300) return raw;
  const truncated = raw.slice(0, 300);
  const searchFrom = 50;
  const match = truncated.slice(searchFrom).search(/[.!?]/);
  if (match === -1) return truncated;
  return truncated.slice(0, searchFrom + match + 1);
}

/** Build a session history XML block for the LLM prompt */
function buildHistoryBlock(history: TaskHistoryEntry[]): string {
  const lines = history.map((h, i) =>
    `  ${i + 1}. ${escapeXml(h.taskType)} | dep: ${escapeXml(h.dep ?? 'none')} | repo: ${escapeXml(path.basename(h.repo))} | status: ${escapeXml(h.status)}`
  );
  return `<session_history>\nPrevious tasks this session (most recent last):\n${lines.join('\n')}\n</session_history>`;
}

/** Module-level client for connection reuse across calls */
let sharedClient: Anthropic | null = null;
function getClient(): Anthropic {
  if (!sharedClient) {
    sharedClient = new Anthropic({ timeout: 15_000 });
  }
  return sharedClient;
}

/** Reset the shared client — for testing or API key rotation */
export function resetClient(): void {
  sharedClient = null;
}

export class LlmParseError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'LlmParseError';
  }
}

export async function llmParse(input: string, manifestContext: string, history?: TaskHistoryEntry[], repoPath?: string): Promise<IntentResult> {
  const truncatedInput = input.length > MAX_INPUT_LENGTH ? input.slice(0, MAX_INPUT_LENGTH) : input;
  const client = getClient();

  const hasHistory = history && history.length > 0;
  const systemPrompt = hasHistory
    ? INTENT_SYSTEM_PROMPT + '\n\nWhen the user says "also X", "now do X", "X too", or similar follow-up phrases, inherit taskType and repo from the most recent session_history entry unless the user explicitly specifies a different project.'
    : INTENT_SYSTEM_PROMPT;

  const historyBlock = hasHistory ? `\n\n${buildHistoryBlock(history)}\n` : '';

  const topLevelDirs = repoPath ? await readTopLevelDirs(repoPath) : '';
  const topLevelDirsBlock = topLevelDirs ? `\n<top_level_dirs>\n${escapeXml(topLevelDirs)}\n</top_level_dirs>` : '';

  let response: Message;
  try {
    response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      stream: false,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: `<manifest_context>\n${escapeXml(manifestContext)}\n</manifest_context>${topLevelDirsBlock}${historyBlock}\n<user_input>${escapeXml(truncatedInput)}</user_input>`,
      }],
      output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new LlmParseError(
      `Failed to classify intent: ${detail}`,
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
