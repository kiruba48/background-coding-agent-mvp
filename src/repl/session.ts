import { parseIntent } from '../intent/index.js';
import { runAgent, type AgentOptions, type AgentContext } from '../agent/index.js';
import { autoRegisterCwd } from '../cli/auto-register.js';
import { ProjectRegistry } from '../agent/registry.js';
import { createLogger } from '../cli/utils/logger.js';
import path from 'node:path';
import type { ReplState, SessionCallbacks, SessionOutput } from './types.js';

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
    intent = await parseIntent(selectedIntent, {
      repoPath: intent.repo,
      registry,
    });
  }

  // Step 3: Auto-register repo
  await autoRegisterCwd(registry, intent.repo);

  // Step 4: Update session state with resolved project
  state.currentProject = intent.repo;
  state.currentProjectName = path.basename(intent.repo);

  // Step 5: Confirm loop via callback (CLI adapter owns readline)
  const confirmed = await callbacks.confirm(
    intent,
    async (correction: string) => parseIntent(correction, { repoPath: intent.repo, registry }),
  );
  if (!confirmed) {
    return { action: 'continue', result: null, intent };
  }

  // Step 6: Map intent to AgentOptions and run
  const logger = createLogger();
  const agentOptions: AgentOptions = {
    taskType: confirmed.taskType,
    repo: confirmed.repo,
    dep: confirmed.dep ?? undefined,
    targetVersion: confirmed.version ?? undefined,
    description: confirmed.description,
    turnLimit: 30,
    timeoutMs: 300_000,
    maxRetries: 3,
  };

  const agentContext: AgentContext = {
    logger,
    signal: callbacks.getSignal(),
    skipDockerChecks: true,
  };

  const result = await runAgent(agentOptions, agentContext);
  return { action: 'continue', result, intent: confirmed };
}
