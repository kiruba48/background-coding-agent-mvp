import path from 'node:path';
import pc from 'picocolors';
import { fastPathParse, explorationFastPath, validateDepInManifest, detectTaskType, FOLLOW_UP_PREFIX, FOLLOW_UP_TOO_SUFFIX } from './fast-path.js';
import { readManifestDeps } from './context-scanner.js';
import { llmParse, MAX_INPUT_LENGTH } from './llm-parser.js';
import { ProjectRegistry } from '../agent/registry.js';
import type { ResolvedIntent } from './types.js';
import type { TaskHistoryEntry } from '../repl/types.js';

export type { ResolvedIntent, IntentResult, FastPathResult, ClarificationOption, ExplorationSubtype } from './types.js';
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

  // Exploration fast-path — check before dependency patterns
  const explorationResult = explorationFastPath(input);
  if (explorationResult) {
    const repoPath = options.repoPath ? path.resolve(options.repoPath) : path.resolve(process.cwd());
    return {
      taskType: 'investigation',
      repo: repoPath,
      dep: null,
      version: null,
      confidence: 'high',
      explorationSubtype: explorationResult.subtype,
      scopingQuestions: [],
    };
  }

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
          scopingQuestions: [],
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

  // Track project name mentioned in input for unresolved reporting
  let mentionedProject: string | null = null;

  if (!repoPath && fastResult?.project) {
    // Try registry lookup for project name from NL
    mentionedProject = fastResult.project;
    const resolved = registry.resolve(fastResult.project);
    if (resolved) repoPath = resolved;
  }

  // Pre-LLM project extraction for generic tasks (fast-path only matches dep update patterns)
  if (!repoPath && !fastResult?.project) {
    const projectMatch = input.match(/\b(?:in|for)\s+([a-zA-Z0-9._-]+)\s+(?:repo|project)\b/i)
      ?? input.match(/\b(?:in|for)\s+([a-zA-Z0-9._-]+)\b/i);
    if (projectMatch) {
      const candidate = projectMatch[1];
      mentionedProject = candidate;
      const resolved = registry.resolve(candidate);
      if (resolved) repoPath = resolved;
    }
  }

  let usedCwdFallback = false;
  if (!repoPath) {
    // cwd fallback — CLI layer may have already prompted before calling us
    repoPath = process.cwd();
    usedCwdFallback = true;
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
          scopingQuestions: [],
        };
      }
    }
    // Fast-path matched pattern but dep not found or task type ambiguous — fall through to LLM
  }

  // Step 3: LLM path — resolve project from LLM result before reading manifest
  const llmPreResult = await llmParse(input, await readManifestDeps(repoPath), history, repoPath);

  // Step 3a: If LLM extracted a project name and we haven't resolved one yet, try registry
  if (!options.repoPath && llmPreResult.project) {
    if (!mentionedProject) mentionedProject = llmPreResult.project;
    const resolved = registry.resolve(llmPreResult.project);
    if (resolved) {
      repoPath = path.resolve(resolved);
      usedCwdFallback = false;
    }
  }

  if (usedCwdFallback) {
    console.error(pc.yellow('  Warning: No repo path specified, using current directory'));
  }

  // Step 4: Map LLM result to ResolvedIntent — pass through clarifications
  const llmResult = llmPreResult;
  // Merge createPr from fast-path (if it matched pattern but fell through) or LLM
  const createPr = fastResult?.createPr || llmResult.createPr;
  const isGeneric = llmResult.taskType === 'generic';
  // Flag unresolved project when a project name was mentioned but fell back to cwd
  const unresolvedProject = usedCwdFallback && mentionedProject ? mentionedProject : undefined;
  return {
    taskType: llmResult.taskType,
    repo: repoPath,
    dep: llmResult.dep,
    version: llmResult.version,
    confidence: llmResult.confidence,
    createPr: createPr ? true : undefined,
    description: isGeneric ? input.slice(0, MAX_INPUT_LENGTH) : undefined,
    taskCategory: isGeneric ? llmResult.taskCategory : undefined,
    clarifications: llmResult.clarifications.length > 0 ? llmResult.clarifications : undefined,
    scopingQuestions: isGeneric ? llmResult.scopingQuestions : [],
    unresolvedProject,
  };
}
