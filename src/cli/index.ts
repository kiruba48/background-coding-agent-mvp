import { Command } from 'commander';
import pc from 'picocolors';
import { promises as fs } from 'fs';
import { runAgent } from './commands/run.js';

const program = new Command();

program
  .name('background-agent')
  .description('Run background coding agent in isolated Docker sandbox')
  .version('0.1.0')
  .requiredOption('-t, --task-type <type>', 'Task type (e.g., maven-dependency-update, npm-dependency-update)')
  .requiredOption('-r, --repo <path>', 'Target repository path (absolute or relative)')
  .option('--turn-limit <number>', 'Maximum agent turns (default: 10)', '10')
  .option('--timeout <seconds>', 'Session timeout in seconds (default: 300)', '300')
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

    // Validate repo path exists
    try {
      await fs.access(options.repo);
    } catch (error) {
      console.error(pc.red(`Error: Repository path does not exist: ${options.repo}`));
      process.exit(2);
    }

    // Run agent with validated options
    const exitCode = await runAgent({
      taskType: options.taskType,
      repo: options.repo,
      turnLimit,
      timeout,
    });

    process.exit(exitCode);
  });

program.parse();
