import { parseIntent } from '../intent/index.js';
import { LlmParseError } from '../intent/llm-parser.js';
import { runAgent, type AgentOptions, type AgentContext } from '../agent/index.js';
import { autoRegisterCwd } from '../cli/auto-register.js';
import { ProjectRegistry } from '../agent/registry.js';
import { createLogger } from '../cli/utils/logger.js';
import { GitHubPRCreator } from '../orchestrator/pr-creator.js';
import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import type { ReplState, SessionCallbacks, SessionOutput, TaskHistoryEntry, ScopeHint } from './types.js';
import type { PRResult, RetryResult } from '../types.js';
import { MAX_HISTORY_ENTRIES, toHistoryStatus } from './types.js';

/** Maximum input length before LLM dispatch (characters) */
const MAX_INPUT_LENGTH = 2000;

/** Maximum number of scoping questions to present */
const MAX_SCOPING_QUESTIONS = 3;

/** Maximum length per scoping answer (characters) */
const MAX_SCOPE_ANSWER_LENGTH = 500;

/** PR meta-command pattern — matches "pr", "create pr", "create a pr", and trailing "for that/this/it" variants */
const PR_COMMAND_RE = /^(create\s+a?\s*pr|pr)(\s+for\s+(that|this|it))?$/i;

/** Default agent options for REPL sessions */
const REPL_TURN_LIMIT = 30;
const REPL_TIMEOUT_MS = 300_000;
const REPL_MAX_RETRIES = 3;

export function createSessionState(): ReplState {
  return { currentProject: null, currentProjectName: null, history: [] };
}

/** Strip ANSI escape sequences and terminal control characters */
function sanitizeForDisplay(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]|\x1B\[[0-9;]*[A-Za-z]/g, '').trim();
}

/**
 * Run the scoping dialogue — ask up to MAX_SCOPING_QUESTIONS LLM-generated questions.
 * Returns structured hint objects with separate question/answer fields.
 * Null returns (Ctrl+C) abort the entire dialogue. Empty strings (Enter) skip one question.
 */
export async function runScopingDialogue(
  questions: string[],
  askQuestion: (prompt: string) => Promise<string | null>,
): Promise<ScopeHint[]> {
  const capped = questions.slice(0, MAX_SCOPING_QUESTIONS);
  console.log('');
  console.log(pc.bold('  Scope questions') + pc.dim('  (Enter to skip, Ctrl+C to skip all)'));
  const hints: ScopeHint[] = [];
  for (let i = 0; i < capped.length; i++) {
    const sanitizedQ = sanitizeForDisplay(capped[i]).slice(0, 200);
    if (!sanitizedQ) continue;
    console.log('');
    console.log(`  ${pc.dim(`${i + 1}.`)} ${sanitizedQ}`);
    const answer = await askQuestion(`     ${pc.cyan('→')} `);
    if (answer === null) break; // Ctrl+C aborts entire dialogue
    const trimmed = answer.trim();
    if (trimmed !== '') {
      hints.push({ question: sanitizedQ, answer: trimmed.slice(0, MAX_SCOPE_ANSWER_LENGTH) });
    }
  }
  return hints;
}

export function appendHistory(state: ReplState, entry: TaskHistoryEntry): void {
  if (state.history.length >= MAX_HISTORY_ENTRIES) {
    state.history.shift();
  }
  state.history.push(entry);
}

export async function processInput(
  input: string,
  state: ReplState,
  callbacks: SessionCallbacks,
  registry: ProjectRegistry,
): Promise<SessionOutput> {
  const trimmed = input.trim();

  // Quit commands
  if (trimmed === 'exit' || trimmed === 'quit') {
    return { action: 'quit' };
  }

  // Empty input — re-prompt
  if (!trimmed) {
    return { action: 'continue' };
  }

  // History command — show completed tasks
  if (trimmed === 'history') {
    if (state.history.length === 0) {
      console.log(pc.dim('\n  No tasks in session history.\n'));
    } else {
      console.log('');
      state.history.forEach((h, i) => {
        const statusColor = h.status === 'success' ? pc.green : h.status === 'cancelled' ? pc.yellow : pc.red;
        console.log(
          `  ${pc.dim(String(i + 1).padStart(2))}. ${pc.cyan(h.taskType)} | ${h.dep ?? pc.dim('no dep')} | ${pc.dim(path.basename(h.repo))} | ${statusColor(h.status)}`
        );
      });
      console.log('');
    }
    return { action: 'continue' };
  }

  // Post-hoc PR command — intercept before parseIntent
  if (PR_COMMAND_RE.test(trimmed)) {
    if (!state.lastRetryResult || !state.lastIntent || state.lastRetryResult.finalStatus !== 'success') {
      console.log(pc.yellow('\n  No completed task in this session.\n'));
      return { action: 'continue' };
    }
    const projectName = state.currentProjectName ?? 'unknown';
    const description = state.lastIntent?.description
      ?? state.lastIntent?.dep
      ?? state.lastIntent?.taskType
      ?? 'task';
    console.log(pc.dim(`\n  Creating PR for: ${description} (${projectName})`));
    try {
      const repo = state.lastIntent!.repo;
      const branchToCleanup = state.lastWorktreeBranch;
      const creator = new GitHubPRCreator(repo);
      const prResult: PRResult = await creator.create({
        taskType: state.lastIntent!.taskType,
        originalTask: description,
        retryResult: state.lastRetryResult,
        branchOverride: branchToCleanup,
        description: state.lastIntent?.description,
        taskCategory: state.lastIntent?.taskCategory ?? undefined,
      });
      // Clear state to prevent duplicate PRs for the same task
      state.lastRetryResult = undefined;
      state.lastIntent = undefined;
      state.lastWorktreeBranch = undefined;
      // Clean up the local worktree branch now that it has been pushed to remote
      if (branchToCleanup && prResult.created && !prResult.error) {
        try {
          const { execFile } = await import('node:child_process');
          const { promisify } = await import('node:util');
          const execAsync = promisify(execFile);
          await execAsync('git', ['branch', '-d', branchToCleanup], { cwd: repo });
        } catch {
          // Best-effort — branch may already be gone or not fully merged
        }
      }
      return { action: 'continue', prResult };
    } catch (err) {
      return { action: 'continue', prResult: { url: '', created: false, branch: '', error: (err as Error).message } };
    }
  }

  // Guard against excessively long input before LLM dispatch
  if (trimmed.length > MAX_INPUT_LENGTH) {
    console.error(pc.yellow(`  Input too long (max ${MAX_INPUT_LENGTH} chars). Please shorten your request.`));
    return { action: 'continue', result: null };
  }

  // Snapshot history at input time so follow-up context reflects pre-task state
  const historySnapshot = [...state.history];

  // Step 1: Parse intent — use currentProject as repo context if available
  let intent;
  callbacks.onParseStart?.();
  try {
    intent = await parseIntent(trimmed, {
      repoPath: state.currentProject ?? undefined,
      registry,
      history: historySnapshot,
    });
  } catch (err) {
    if (err instanceof LlmParseError) {
      console.error(pc.yellow('  Could not understand that request. This tool handles concrete code changes'));
      console.error(pc.yellow('  (e.g., "rename X to Y", "update lodash", "add error handling to auth.ts").'));
      console.error(pc.yellow('  Try rephrasing as a specific action.'));
      return { action: 'continue', result: null };
    }
    throw err;
  } finally {
    callbacks.onParseEnd?.();
  }

  // Set description for investigation tasks when fast-path didn't set it
  if (intent.taskType === 'investigation' && !intent.description) {
    intent.description = trimmed.slice(0, MAX_INPUT_LENGTH);
  }

  // Step 2: Handle low-confidence with clarifications
  if (intent.confidence === 'low' && intent.clarifications && intent.clarifications.length > 0) {
    const selectedIntent = await callbacks.clarify(intent.clarifications);
    if (!selectedIntent) {
      return { action: 'continue', result: null };
    }
    // Re-parse with original context so the LLM sees repo/file/function names
    const enrichedIntent = `${trimmed} — specifically: ${selectedIntent}`;
    callbacks.onParseStart?.();
    let reparsed;
    try {
      reparsed = await parseIntent(enrichedIntent, {
        repoPath: intent.repo,
        registry,
        history: historySnapshot,
      });
    } finally {
      callbacks.onParseEnd?.();
    }
    // User already disambiguated by picking a clarification — force high confidence
    reparsed.confidence = 'high';
    // Preserve the clarification as the description (cleaner than the enriched string)
    if (reparsed.taskType === 'generic') {
      reparsed.description = selectedIntent;
    }
    intent = reparsed;
  }

  // Step 2.5: Scoping dialogue (generic tasks only, if adapter implements askQuestion)
  let scopeHints: ScopeHint[] = [];
  if (
    intent.taskType === 'generic' &&
    intent.scopingQuestions.length > 0 &&
    callbacks.askQuestion
  ) {
    scopeHints = await runScopingDialogue(intent.scopingQuestions, callbacks.askQuestion);
  }

  // Step 3: Confirm loop via callback (CLI adapter owns readline)
  const confirmed = await callbacks.confirm(
    intent,
    async (correction: string) => parseIntent(correction, { repoPath: intent.repo, registry, history: historySnapshot }),
    scopeHints,
  );
  if (!confirmed) {
    return { action: 'continue', result: null, intent };
  }

  // Step 4: Auto-register repo and update state AFTER confirmation
  await autoRegisterCwd(registry, confirmed.repo);
  state.currentProject = confirmed.repo;
  state.currentProjectName = path.basename(confirmed.repo);

  // Step 5: Map intent to AgentOptions and run
  const logger = createLogger();
  const agentOptions: AgentOptions = {
    taskType: confirmed.taskType,
    repo: confirmed.repo,
    dep: confirmed.dep ?? undefined,
    targetVersion: confirmed.version ?? undefined,
    description: confirmed.description,
    taskCategory: confirmed.taskCategory ?? undefined,
    createPr: confirmed.createPr ?? false,
    turnLimit: REPL_TURN_LIMIT,
    timeoutMs: REPL_TIMEOUT_MS,
    maxRetries: REPL_MAX_RETRIES,
    scopeHints: scopeHints.length > 0 ? scopeHints.map(h => `${h.question}: ${h.answer}`) : undefined,
    explorationSubtype: confirmed.explorationSubtype,
  };

  const agentContext: AgentContext = {
    logger,
    signal: callbacks.getSignal(),
    skipDockerChecks: true,
  };

  callbacks.onAgentStart?.();
  let historyStatus: TaskHistoryEntry['status'] = 'failed';
  let taskResult: RetryResult | undefined;
  try {
    const result = await runAgent(agentOptions, agentContext);
    taskResult = result;

    // Investigation tasks: display report inline and skip post-hoc PR storage
    if (confirmed.taskType === 'investigation') {
      const report = result.sessionResults.at(-1)?.finalResponse;
      if (report) {
        console.log('\n' + report + '\n');

        // Save report to .reports/ if user asked to save (host-side write, agent never writes files)
        if (/\bsave\b/i.test(trimmed)) {
          const reportsDir = path.join(confirmed.repo, '.reports');
          fs.mkdirSync(reportsDir, { recursive: true });
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const subtype = confirmed.explorationSubtype ?? 'general';
          const filename = `${timestamp}-${subtype}.md`;
          fs.writeFileSync(path.join(reportsDir, filename), report, 'utf-8');
          console.log(pc.green(`  Report saved to .reports/${filename}\n`));
        }
      } else {
        console.log(pc.yellow('\n  Exploration produced no report.\n'));
      }
    } else if (result.finalStatus === 'success') {
      // Store for post-hoc PR and follow-up referencing (FLLW-02) — success path only, non-investigation.
      // Non-success results must NOT overwrite a previous successful result,
      // so the user can still `pr` after a subsequent failed task.
      state.lastRetryResult = result;
      state.lastIntent = confirmed;
      state.lastWorktreeBranch = result.worktreeBranch;
    }
    historyStatus = toHistoryStatus(result.finalStatus);
    return { action: 'continue', result, intent: confirmed };
  } catch (err) {
    historyStatus = err instanceof Error && err.name === 'AbortError' ? 'cancelled' : 'failed';
    throw err;
  } finally {
    callbacks.onAgentEnd?.();
    appendHistory(state, {
      taskType: confirmed.taskType,
      dep: confirmed.dep ?? null,
      version: confirmed.version ?? null,
      repo: confirmed.repo,
      status: historyStatus,
      description: confirmed.taskType === 'generic' || confirmed.taskType === 'investigation'
        ? (confirmed.description ?? trimmed.slice(0, 200))
        : confirmed.dep
          ? `update ${confirmed.dep} to ${confirmed.version ?? 'latest'}`
          : undefined,
      finalResponse: taskResult?.sessionResults?.at(-1)?.finalResponse,
    });
  }
}
