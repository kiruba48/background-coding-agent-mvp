import path from 'node:path';
import pc from 'picocolors';
import { fastPathParse, validateDepInManifest, detectTaskType, FOLLOW_UP_PREFIX, FOLLOW_UP_TOO_SUFFIX } from './fast-path.js';
import { readManifestDeps } from './context-scanner.js';
import { llmParse } from './llm-parser.js';
import { ProjectRegistry } from '../agent/registry.js';
import type { ResolvedIntent } from './types.js';
import type { TaskHistoryEntry } from '../repl/types.js';

export type { ResolvedIntent, IntentResult, FastPathResult, ClarificationOption } from './types.js';
export type { TaskHistoryEntry } from '../repl/types.js';
export { fastPathParse } from './fast-path.js';
export { readManifestDeps } from './context-scanner.js';
export { llmParse } from './llm-parser.js';
export { confirmLoop, displayIntent } from './confirm-loop.js';

export interface ParseOptions {
  repoPath?: string;        // explicit repo path (from -r flag or CLI)
  registry?: ProjectRegistry; // for resolving project names from NL
  history?: TaskHistoryEntry[]; // recent task history for multi-turn follow-up context
  _depth?: number;            // internal: recursion depth guard for follow-up stripping
}

/**
 * Coordinator: parse natural language input into a ResolvedIntent.
 *
 * Flow:
 * 1. Resolve repo path (from options, project name in NL, or cwd fallback)
 * 2. Try fast-path regex parse
 * 3. If fast-path matches: validate dep in manifest, detect task type
 * 4. If fast-path fails or dep not in manifest: call LLM with manifest context
 * 5. Return ResolvedIntent with clarifications if confidence is low (caller handles UI)
 *
 * Note: This function is channel-agnostic. Repo prompting and clarification
 * UI are handled by the CLI layer (one-shot.ts), not here.
 */
export async function parseIntent(
  input: string,
  options: ParseOptions = {},
): Promise<ResolvedIntent> {
  const registry = options.registry ?? new ProjectRegistry();
  const history = options.history;

  // Step 1: Resolve repo path
  // Try fast-path first to extract project name, but repo resolution happens here
  const fastResult = fastPathParse(input);
  let repoPath = options.repoPath ?? null;

  // Step 1a: Follow-up handling — if fast-path detected a follow-up pattern
  if (fastResult?.isFollowUp) {
    const lastEntry = history && history.length > 0 ? history[history.length - 1] : null;

    if (lastEntry) {
      // Inherit repo from last history entry if not explicitly provided
      const inheritedRepo = repoPath ?? lastEntry.repo;
      const resolvedRepo = path.resolve(inheritedRepo);
      const depExists = await validateDepInManifest(resolvedRepo, fastResult.dep);
      if (depExists) {
        return {
          taskType: lastEntry.taskType,
          repo: resolvedRepo,
          dep: fastResult.dep,
          version: fastResult.version,
          confidence: 'high',
          createPr: fastResult.createPr ? true : undefined,
          inheritedFields: ['taskType', 'repo'],
        };
      }
      // dep not in manifest — fall through to LLM with history (repoPath stays as inheritedRepo)
      repoPath = resolvedRepo;
    } else if (!(options._depth)) {
      // No history: graceful degradation — strip follow-up prefix and re-parse as fresh
      let stripped = input.replace(FOLLOW_UP_PREFIX, '');
      stripped = stripped.replace(FOLLOW_UP_TOO_SUFFIX, '');
      if (stripped !== input) {
        // Re-enter parseIntent with stripped input (depth=1 prevents further recursion)
        return parseIntent(stripped, { ...options, history: undefined, _depth: 1 });
      }
      // Could not strip — fall through to LLM
    }
  }

  if (!repoPath && fastResult?.project) {
    // Try registry lookup for project name from NL
    const resolved = registry.resolve(fastResult.project);
    if (resolved) repoPath = resolved;
  }

  if (!repoPath) {
    // cwd fallback — CLI layer may have already prompted before calling us
    repoPath = process.cwd();
    console.error(pc.yellow('  Warning: No repo path specified, using current directory'));
  }

  repoPath = path.resolve(repoPath);

  // Step 2: If fast-path matched (non-follow-up), validate dep in manifest and detect task type
  if (fastResult && !fastResult.isFollowUp) {
    const depExists = await validateDepInManifest(repoPath, fastResult.dep);
    if (depExists) {
      const taskType = await detectTaskType(repoPath);
      if (taskType) {
        return {
          taskType,
          repo: repoPath,
          dep: fastResult.dep,
          version: fastResult.version,
          confidence: 'high',
          createPr: fastResult.createPr ? true : undefined,
        };
      }
    }
    // Fast-path matched pattern but dep not found or task type ambiguous — fall through to LLM
  }

  // Step 3: LLM path — read manifest context first (INTENT-03)
  const manifestContext = await readManifestDeps(repoPath);
  const llmResult = await llmParse(input, manifestContext, history);

  // Step 4: Map LLM result to ResolvedIntent — pass through clarifications
  // Merge createPr from fast-path (if it matched pattern but fell through) or LLM
  const createPr = fastResult?.createPr || llmResult.createPr;
  const isGeneric = llmResult.taskType === 'unknown';
  return {
    taskType: isGeneric ? 'generic' : llmResult.taskType,
    repo: repoPath,
    dep: llmResult.dep,
    version: llmResult.version,
    confidence: llmResult.confidence,
    createPr: createPr ? true : undefined,
    description: isGeneric ? input : undefined,
    clarifications: llmResult.clarifications.length > 0 ? llmResult.clarifications : undefined,
  };
}
