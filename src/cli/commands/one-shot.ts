import { parseIntent, confirmLoop, fastPathParse } from '../../intent/index.js';
import { runAgent, type AgentOptions, type AgentContext } from '../../agent/index.js';
import { createInterface } from 'node:readline/promises';
import { promises as fs } from 'node:fs';
import pc from 'picocolors';
import path from 'node:path';
import { ProjectRegistry } from '../../agent/registry.js';
import { autoRegisterCwd } from '../auto-register.js';
import { createLogger } from '../utils/logger.js';
import { mapStatusToExitCode } from './run.js';
import type { ResolvedIntent } from '../../intent/types.js';

export interface OneShotOptions {
  repo?: string;
  createPr?: boolean;
  branch?: string;
  noJudge?: boolean;
  turnLimit?: string;
  timeout?: string;
  maxRetries?: string;
}

/**
 * Resolve repo path interactively when neither -r flag nor NL project name resolves.
 * Per user decision: prompt with registered project list, or ask for local path.
 * Registers new paths in the registry before returning.
 */
async function resolveRepoInteractively(
  _input: string,
  registry: ProjectRegistry,
): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => { rl.close(); process.exit(130); });

  try {
    const registered = registry.list();
    const names = Object.keys(registered);

    if (names.length > 0) {
      // Show registered projects as numbered list
      console.log(pc.bold('\n  No project specified. Select a registered project:\n'));
      names.forEach((name, i) => {
        console.log(`    ${pc.cyan(String(i + 1))}. ${name} ${pc.dim(`(${registered[name]})`)}`);
      });
      console.log(`    ${pc.cyan(String(names.length + 1))}. Enter a different path\n`);

      const choice = await rl.question(pc.bold('  Select [number]: '));
      const choiceNum = parseInt(choice, 10);

      if (choiceNum >= 1 && choiceNum <= names.length) {
        return registered[names[choiceNum - 1]];
      }
      if (!(choiceNum === names.length + 1)) {
        console.log(pc.red('  Invalid selection.'));
      }
      // Fall through to manual path entry
    }

    // No registered projects or user chose "different path"
    const localPath = await rl.question(pc.bold('  Enter project path: '));
    const resolved = path.resolve(localPath.trim());

    // Validate the path exists and is a directory
    try {
      const stat = await fs.stat(resolved);
      if (!stat.isDirectory()) {
        console.log(pc.red(`  Error: ${resolved} is not a directory`));
        return resolved; // let downstream handle gracefully
      }
    } catch {
      console.log(pc.red(`  Warning: ${resolved} does not exist`));
    }

    // Extract a short name from the path for registration
    const shortName = path.basename(resolved);
    registry.register(shortName, resolved);
    console.log(pc.dim(`  Registered "${shortName}" → ${resolved}`));

    return resolved;
  } finally {
    rl.close();
  }
}

/**
 * Display numbered clarification choices and prompt user to pick.
 * Returns the selected clarification's intent string, or null if user cancels.
 */
async function promptClarification(
  clarifications: Array<{ label: string; intent: string }>,
): Promise<string | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => { rl.close(); process.exit(130); });

  try {
    console.log(pc.bold('\n  Ambiguous input. Did you mean:\n'));
    clarifications.forEach((c, i) => {
      console.log(`    ${pc.cyan(String(i + 1))}. ${c.label}`);
    });
    console.log('');

    const answer = await rl.question(pc.bold('  Select [number]: '));
    const num = parseInt(answer, 10);

    if (num >= 1 && num <= clarifications.length) {
      return clarifications[num - 1].intent;
    }

    console.log(pc.red('  Invalid selection.'));
    return null;
  } finally {
    rl.close();
  }
}

export async function oneShotCommand(
  input: string,
  options: OneShotOptions,
  signal?: AbortSignal,
): Promise<number> {
  const logger = createLogger();
  const registry = new ProjectRegistry();

  // Step 0: Resolve repo path if not provided via -r flag
  // Check if NL input contains a project name that resolves via registry
  let repoPath = options.repo ?? undefined;

  if (!repoPath) {
    const fastResult = fastPathParse(input);
    if (fastResult?.project) {
      const resolved = registry.resolve(fastResult.project);
      if (resolved) {
        repoPath = resolved;
      } else {
        // Project name found in NL but not in registry — prompt for path per user decision
        console.log(pc.yellow(`\n  Project "${fastResult.project}" not found in registry.`));
        repoPath = await resolveRepoInteractively(input, registry);
      }
    } else {
      // No project name in NL and no -r flag — prompt with registered projects
      repoPath = await resolveRepoInteractively(input, registry);
    }
  }

  // Parse intent (fast-path or LLM) — repo is now resolved
  let intent = await parseIntent(input, {
    repoPath,
    registry,
  });

  // Handle low-confidence with clarifications — numbered choices per user decision
  if (intent.confidence === 'low' && intent.clarifications && intent.clarifications.length > 0) {
    const selectedIntent = await promptClarification(intent.clarifications);
    if (!selectedIntent) {
      return 0; // User cancelled clarification — clean exit
    }
    // Re-parse with the selected clarification intent string
    intent = await parseIntent(selectedIntent, {
      repoPath: intent.repo,
      registry,
    });
  }

  // Auto-register the resolved repo
  await autoRegisterCwd(registry, intent.repo);

  // Confirm loop
  const confirmed = await confirmLoop(
    intent,
    async (correction: string, prior: ResolvedIntent) => {
      return parseIntent(correction, {
        repoPath: prior.repo,
        registry,
      });
    },
  );

  if (!confirmed) {
    return 0; // User aborted — clean exit
  }

  // Map ResolvedIntent to AgentOptions
  const turnLimit = parseInt(options.turnLimit ?? '30', 10);
  const timeout = parseInt(options.timeout ?? '300', 10);
  const maxRetries = parseInt(options.maxRetries ?? '3', 10);

  const agentOptions: AgentOptions = {
    taskType: confirmed.taskType,
    repo: confirmed.repo,
    dep: confirmed.dep ?? undefined,
    targetVersion: confirmed.version ?? undefined,
    description: confirmed.description,
    taskCategory: confirmed.taskCategory ?? undefined,
    turnLimit,
    timeoutMs: timeout * 1000,
    maxRetries,
    noJudge: options.noJudge,
    createPr: options.createPr,
    branchOverride: options.branch,
  };

  const agentContext: AgentContext = { logger, signal };
  const result = await runAgent(agentOptions, agentContext);
  return mapStatusToExitCode(result.finalStatus);
}
