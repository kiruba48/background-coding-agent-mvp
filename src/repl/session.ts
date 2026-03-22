import { parseIntent } from '../intent/index.js';
import { runAgent, type AgentOptions, type AgentContext } from '../agent/index.js';
import { autoRegisterCwd } from '../cli/auto-register.js';
import { ProjectRegistry } from '../agent/registry.js';
import { createLogger } from '../cli/utils/logger.js';
import path from 'node:path';
import type { ReplState, SessionCallbacks, SessionOutput } from './types.js';

/** Maximum input length before LLM dispatch (characters) */
const MAX_INPUT_LENGTH = 2000;

/** Default agent options for REPL sessions */
const REPL_TURN_LIMIT = 30;
const REPL_TIMEOUT_MS = 300_000;
const REPL_MAX_RETRIES = 3;

export function createSessionState(): ReplState {
  return { currentProject: null, currentProjectName: null };
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

  // Guard against excessively long input before LLM dispatch
  if (trimmed.length > MAX_INPUT_LENGTH) {
    return { action: 'continue', result: null };
  }

  // Step 1: Parse intent — use currentProject as repo context if available
  let intent = await parseIntent(trimmed, {
    repoPath: state.currentProject ?? undefined,
    registry,
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
    });
    if (reparsed.confidence === 'low') {
      return { action: 'continue', result: null };
    }
    intent = reparsed;
  }

  // Step 3: Confirm loop via callback (CLI adapter owns readline)
  const confirmed = await callbacks.confirm(
    intent,
    async (correction: string) => parseIntent(correction, { repoPath: intent.repo, registry }),
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
  try {
    const result = await runAgent(agentOptions, agentContext);
    return { action: 'continue', result, intent: confirmed };
  } finally {
    callbacks.onAgentEnd?.();
  }
}
