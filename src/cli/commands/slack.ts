import { Command } from 'commander';

export function createSlackCommand(): Command {
  return new Command('slack')
    .description('Start the Slack bot adapter (Socket Mode)')
    .action(async () => {
      const { startSlack } = await import('../../slack/index.js');
      await startSlack();
    });
}
