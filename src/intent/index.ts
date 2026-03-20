import path from 'node:path';
import { fastPathParse, validateDepInManifest, detectTaskType } from './fast-path.js';
import { readManifestDeps } from './context-scanner.js';
import { llmParse } from './llm-parser.js';
import { ProjectRegistry } from '../agent/registry.js';
import type { ResolvedIntent } from './types.js';

export type { ResolvedIntent, IntentResult, FastPathResult, ClarificationOption } from './types.js';
export { fastPathParse } from './fast-path.js';
export { readManifestDeps } from './context-scanner.js';
export { llmParse } from './llm-parser.js';
export { confirmLoop, displayIntent } from './confirm-loop.js';

export interface ParseOptions {
  repoPath?: string;        // explicit repo path (from -r flag or CLI)
  registry?: ProjectRegistry; // for resolving project names from NL
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

  // Step 1: Resolve repo path
  // Try fast-path first to extract project name, but repo resolution happens here
  const fastResult = fastPathParse(input);
  let repoPath = options.repoPath ?? null;

  if (!repoPath && fastResult?.project) {
    // Try registry lookup for project name from NL
    const resolved = registry.resolve(fastResult.project);
    if (resolved) repoPath = resolved;
  }

  if (!repoPath) {
    // cwd fallback — CLI layer may have already prompted before calling us
    repoPath = process.cwd();
  }

  repoPath = path.resolve(repoPath);

  // Step 2: If fast-path matched, validate dep in manifest and detect task type
  if (fastResult) {
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
        };
      }
    }
    // Fast-path matched pattern but dep not found or task type ambiguous — fall through to LLM
  }

  // Step 3: LLM path — read manifest context first (INTENT-03)
  const manifestContext = await readManifestDeps(repoPath);
  const llmResult = await llmParse(input, manifestContext);

  // Step 4: Map LLM result to ResolvedIntent — pass through clarifications
  return {
    taskType: llmResult.taskType === 'unknown' ? input : llmResult.taskType,
    repo: repoPath,
    dep: llmResult.dep,
    version: llmResult.version,
    confidence: llmResult.confidence,
    clarifications: llmResult.clarifications.length > 0 ? llmResult.clarifications : undefined,
  };
}
