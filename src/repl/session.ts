import { parseIntent } from '../intent/index.js';
import { runAgent, type AgentOptions, type AgentContext } from '../agent/index.js';
import { autoRegisterCwd } from '../cli/auto-register.js';
import { ProjectRegistry } from '../agent/registry.js';
import { createLogger } from '../cli/utils/logger.js';
import path from 'node:path';
import pc from 'picocolors';
import type { ReplState, SessionCallbacks, SessionOutput, TaskHistoryEntry } from './types.js';
import { MAX_HISTORY_ENTRIES } from './types.js';

/** Maximum input length before LLM dispatch (characters) */
const MAX_INPUT_LENGTH = 2000;

/** Default agent options for REPL sessions */
const REPL_TURN_LIMIT = 30;
const REPL_TIMEOUT_MS = 300_000;
const REPL_MAX_RETRIES = 3;

export function createSessionState(): ReplState {
  return { currentProject: null, currentProjectName: null, history: [] };
}

function appendHistory(state: ReplState, entry: TaskHistoryEntry): void {
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

  // Guard against excessively long input before LLM dispatch
  if (trimmed.length > MAX_INPUT_LENGTH) {
    console.error(pc.yellow(`  Input too long (max ${MAX_INPUT_LENGTH} chars). Please shorten your request.`));
    return { action: 'continue', result: null };
  }

  // Snapshot history at input time so follow-up context reflects pre-task state
  const historySnapshot = [...state.history];

  // Step 1: Parse intent — use currentProject as repo context if available
  let intent = await parseIntent(trimmed, {
    repoPath: state.currentProject ?? undefined,
    registry,
    history: historySnapshot,
  });

  // Step 2: Handle low-confidence with clarifications
  if (intent.confidence === 'low' && intent.clarifications && intent.clarifications.length > 0) {
    const selectedIntent = await callbacks.clarify(intent.clarifications);
    if (!selectedIntent) {
      return { action: 'continue', result: null };
    }
    // Re-parse the selected clarification; if still ambiguous, bail out
    const reparsed = await parseIntent(selectedIntent, {
      repoPath: intent.repo,
      registry,
      history: historySnapshot,
    });
    if (reparsed.confidence === 'low') {
      return { action: 'continue', result: null };
    }
    intent = reparsed;
  }

  // Step 3: Confirm loop via callback (CLI adapter owns readline)
  const confirmed = await callbacks.confirm(
    intent,
    async (correction: string) => parseIntent(correction, { repoPath: intent.repo, registry, history: historySnapshot }),
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
  };

  const agentContext: AgentContext = {
    logger,
    signal: callbacks.getSignal(),
    skipDockerChecks: true,
  };

  callbacks.onAgentStart?.();
  let historyStatus: TaskHistoryEntry['status'] = 'failed';
  try {
    const result = await runAgent(agentOptions, agentContext);
    historyStatus = result.finalStatus === 'success' ? 'success' : 'failed';
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
    });
  }
}
