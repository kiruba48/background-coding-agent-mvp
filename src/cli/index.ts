import { Command } from 'commander';
import pc from 'picocolors';
import { promises as fs } from 'fs';
import { runAgent } from './commands/run.js';

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

    // Run agent with validated options
    const exitCode = await runAgent({
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
    });

    process.exit(exitCode);
  });

program.parse();
