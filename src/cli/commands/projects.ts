import { Command } from 'commander';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { ProjectRegistry } from '../../agent/registry.js';

interface ProjectsCommandOptions {
  /** Factory for creating a ProjectRegistry instance (allows test injection) */
  registryFactory?: () => ProjectRegistry;
}

export function createProjectsCommand(opts: ProjectsCommandOptions = {}): Command {
  const makeRegistry = opts.registryFactory ?? (() => new ProjectRegistry());

  const projects = new Command('projects')
    .description('Manage registered project short names');

  projects
    .command('list')
    .description('List all registered projects')
    .action(() => {
      const registry = makeRegistry();
      const all = registry.list();
      const entries = Object.entries(all);
      if (entries.length === 0) {
        console.log('No projects registered. Use `bg-agent projects add <name> <path>` to register one.');
        return;
      }
      for (const [name, repoPath] of entries) {
        console.log(`  ${pc.bold(name)} → ${repoPath}`);
      }
    });

  projects
    .command('add <name> <path>')
    .description('Register a project short name to a repo path')
    .action(async (name: string, repoPath: string) => {
      const registry = makeRegistry();
      const absPath = path.resolve(repoPath);

      // Validate path exists and is a directory
      try {
        const stat = await fs.stat(absPath);
        if (!stat.isDirectory()) {
          console.error(pc.red(`Error: Path is not a directory: ${absPath}`));
          process.exitCode = 1;
          return;
        }
      } catch {
        console.error(pc.red(`Error: Path does not exist: ${absPath}`));
        process.exitCode = 1;
        return;
      }

      // Conflict handling: TTY prompt vs non-TTY error
      const existing = registry.resolve(name);
      if (existing !== undefined && existing !== absPath) {
        if (process.stdout.isTTY) {
          // Interactive mode: prompt to confirm overwrite
          const readline = await import('node:readline');
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const answer = await new Promise<string>(resolve => {
            rl.question(
              `Project "${name}" is already registered to ${existing}. Overwrite? [y/N] `,
              resolve
            );
          });
          rl.close();
          if (answer.toLowerCase() !== 'y') {
            console.log('Cancelled.');
            return;
          }
        } else {
          // Non-interactive mode: error
          console.error(pc.red(`Error: Project "${name}" is already registered to ${existing}. Use a different name or remove it first.`));
          process.exitCode = 1;
          return;
        }
      }

      registry.register(name, absPath);
      console.log(`Registered: ${pc.bold(name)} → ${absPath}`);
    });

  projects
    .command('remove <name>')
    .description('Remove a registered project')
    .action((name: string) => {
      const registry = makeRegistry();
      const removed = registry.remove(name);
      if (removed) {
        console.log(`Removed project: ${name}`);
      } else {
        console.error(pc.red(`Error: Project "${name}" not found`));
        process.exitCode = 1;
      }
    });

  return projects;
}
