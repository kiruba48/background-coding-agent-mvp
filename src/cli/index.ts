import { Command } from 'commander';
import pc from 'picocolors';
import { promises as fs } from 'fs';
import { runCommand } from './commands/run.js';
import { createProjectsCommand } from './commands/projects.js';
import { autoRegisterCwd } from './auto-register.js';
import { ProjectRegistry } from '../agent/registry.js';

const program = new Command();

program
  .name('background-agent')
  .description('Run background coding agent using Claude Agent SDK')
  .version('0.1.0')
  .requiredOption('-t, --task-type <type>', 'Task type (e.g., maven-dependency-update, npm-dependency-update)')
  .requiredOption('-r, --repo <path>', 'Target repository path (absolute or relative)')
  .option('--turn-limit <number>', 'Maximum agent turns (default: 10)', '10')
  .option('--timeout <seconds>', 'Session timeout in seconds (default: 300)', '300')
  .option('--max-retries <number>', 'Maximum retry attempts on verification failure (default: 3)', '3')
  .option('--no-judge', 'Disable LLM Judge semantic verification (also: JUDGE_ENABLED=false)')
  .option('--create-pr', 'Create a GitHub PR after successful agent run (requires GITHUB_TOKEN)')
  .option('--branch <name>', 'Branch name for the PR (default: auto-generated from task type). Only valid with --create-pr')
  .option('--dep <name>', 'Dependency to update (e.g., org.springframework:spring-core for Maven, lodash for npm)')
  .option('--target-version <version>', 'Target version for dependency update')
  .action(async (options) => {
    // Validate turn-limit
    const turnLimit = parseInt(options.turnLimit, 10);
    if (isNaN(turnLimit) || turnLimit < 1 || turnLimit > 100) {
      console.error(pc.red('Error: --turn-limit must be a number between 1 and 100'));
      process.exit(2);
    }

    // Validate timeout
    const timeout = parseInt(options.timeout, 10);
    if (isNaN(timeout) || timeout < 30 || timeout > 3600) {
      console.error(pc.red('Error: --timeout must be a number between 30 and 3600 seconds'));
      process.exit(2);
    }

    // Validate max-retries
    const maxRetries = parseInt(options.maxRetries, 10);
    if (isNaN(maxRetries) || maxRetries < 1 || maxRetries > 10) {
      console.error(pc.red('Error: --max-retries must be a number between 1 and 10'));
      process.exit(2);
    }

    // Validate repo path exists
    try {
      await fs.access(options.repo);
    } catch {
      console.error(pc.red(`Error: Repository path does not exist: ${options.repo}`));
      process.exit(2);
    }

    // Validate --branch requires --create-pr
    if (options.branch && !options.createPr) {
      console.error(pc.red('Error: --branch requires --create-pr'));
      process.exit(2);
    }

    // Validate GITHUB_TOKEN is set when --create-pr is used
    if (options.createPr && !process.env.GITHUB_TOKEN) {
      console.error(pc.red('Error: GITHUB_TOKEN environment variable is required for --create-pr'));
      process.exit(2);
    }

    // Validate --dep and --target-version for task types that require them
    const depRequiringTaskTypes = ['maven-dependency-update', 'npm-dependency-update'];
    if (depRequiringTaskTypes.includes(options.taskType)) {
      if (!options.dep) {
        console.error(pc.red('Error: --dep is required for task type: ' + options.taskType));
        process.exit(2);
      }
      if (!options.targetVersion) {
        console.error(pc.red('Error: --target-version is required for task type: ' + options.taskType));
        process.exit(2);
      }
      // Validate --dep format: task-type-aware
      if (options.taskType === 'maven-dependency-update') {
        // Maven: strict groupId:artifactId format (alphanumeric, dots, hyphens, underscores)
        const depPattern = /^[a-zA-Z0-9._-]+:[a-zA-Z0-9._-]+$/;
        if (!depPattern.test(options.dep)) {
          console.error(pc.red('Error: --dep must be in groupId:artifactId format (e.g., org.springframework:spring-core)'));
          process.exit(2);
        }
      } else if (options.taskType === 'npm-dependency-update') {
        // npm: validate against npm package name spec (scoped and unscoped)
        const npmPkgPattern = /^(@[a-z0-9\-~][a-z0-9._\-~]*\/)?[a-z0-9\-~][a-z0-9._\-~]*$/;
        if (!npmPkgPattern.test(options.dep) || options.dep.length > 214) {
          console.error(pc.red('Error: --dep must be a valid npm package name (e.g., lodash, @types/node)'));
          process.exit(2);
        }
      }
      // Validate --target-version: reject control characters and newlines
      const versionPattern = /^[a-zA-Z0-9._\-+]+$/;
      if (!versionPattern.test(options.targetVersion)) {
        console.error(pc.red('Error: --target-version contains invalid characters'));
        process.exit(2);
      }
    }

    // Auto-register the target repo as a project (not cwd — user may run from agent's own directory)
    const registry = new ProjectRegistry();
    const resolvedRepo = (await import('node:path')).resolve(options.repo);
    await autoRegisterCwd(registry, resolvedRepo);

    // Create AbortController at CLI level for signal handling
    const abortController = new AbortController();

    // Track run promise for clean shutdown
    let runPromise: Promise<number> | null = null;

    // Signal handlers live here at the CLI entry point — not in library code.
    // Use process.on (not once) with a guard flag so double-signal (rapid Ctrl+C)
    // triggers a force-exit instead of falling through to Node's default handler.
    let shuttingDown = false;
    const handleSignal = (code: number) => {
      if (shuttingDown) {
        // Second signal — force exit immediately
        process.exit(code);
      }
      shuttingDown = true;
      abortController.abort();
      // Safety net: force exit after 10s if cleanup hangs
      const forceTimer = setTimeout(() => process.exit(code), 10_000);
      forceTimer.unref(); // don't block event loop from exiting naturally
      if (runPromise) {
        runPromise.catch(() => {}).then(() => process.exit(code));
      } else {
        process.exit(code);
      }
    };
    process.on('SIGINT', () => handleSignal(130));
    process.on('SIGTERM', () => handleSignal(143));

    runPromise = runCommand({
      taskType: options.taskType,
      repo: options.repo,
      turnLimit,
      timeout,
      maxRetries,
      noJudge: options.judge === false,    // Commander.js: --no-judge sets options.judge = false
      createPr: options.createPr === true,
      branchOverride: options.branch as string | undefined,
      dep: options.dep as string | undefined,
      targetVersion: options.targetVersion as string | undefined,
    }, abortController.signal);

    const exitCode = await runPromise;
    process.exit(exitCode);
  });

program.addCommand(createProjectsCommand());

program.parse();
