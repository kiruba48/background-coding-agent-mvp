import { buildMavenPrompt } from './maven.js';
import { buildNpmPrompt } from './npm.js';
import { buildGenericPrompt } from './generic.js';
export { buildMavenPrompt, buildNpmPrompt, buildGenericPrompt };

export interface PromptOptions {
  taskType: string;
  dep?: string;
  targetVersion?: string;
  description?: string;  // raw NL task description for generic tasks
  repoPath?: string;     // optional repo path for manifest dependency injection
}

/**
 * Dispatches to the appropriate prompt builder based on task type.
 *
 * @param options - Task type and optional parameters
 * @returns Promise resolving to prompt string for the agent
 * @throws Error if required parameters are missing for a task type
 */
export async function buildPrompt(options: PromptOptions): Promise<string> {
  switch (options.taskType) {
    case 'maven-dependency-update': {
      if (!options.dep) {
        throw new Error('dep is required for maven-dependency-update');
      }
      return buildMavenPrompt(options.dep, options.targetVersion ?? 'latest');
    }
    case 'npm-dependency-update': {
      if (!options.dep) {
        throw new Error('dep is required for npm-dependency-update');
      }
      return buildNpmPrompt(options.dep, options.targetVersion ?? 'latest');
    }
    case 'generic': {
      if (!options.description) {
        throw new Error('description is required for generic tasks');
      }
      return buildGenericPrompt(options.description, options.repoPath);
    }
    default:
      return `You are a coding agent. Your task: ${options.description ?? options.taskType}. Work in the current directory.`;
  }
}
