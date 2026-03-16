import { buildMavenPrompt } from './maven.js';
import { buildNpmPrompt } from './npm.js';
export { buildMavenPrompt, buildNpmPrompt };

export interface PromptOptions {
  taskType: string;
  dep?: string;
  targetVersion?: string;
}

/**
 * Dispatches to the appropriate prompt builder based on task type.
 *
 * @param options - Task type and optional parameters
 * @returns Prompt string for the agent
 * @throws Error if required parameters are missing for a task type
 */
export function buildPrompt(options: PromptOptions): string {
  switch (options.taskType) {
    case 'maven-dependency-update': {
      if (!options.dep) {
        throw new Error('dep is required for maven-dependency-update');
      }
      if (!options.targetVersion) {
        throw new Error('targetVersion is required for maven-dependency-update');
      }
      return buildMavenPrompt(options.dep, options.targetVersion);
    }
    case 'npm-dependency-update': {
      if (!options.dep) {
        throw new Error('dep is required for npm-dependency-update');
      }
      if (!options.targetVersion) {
        throw new Error('targetVersion is required for npm-dependency-update');
      }
      return buildNpmPrompt(options.dep, options.targetVersion);
    }
    default:
      return `You are a coding agent. Your task: ${options.taskType}. Work in the current directory.`;
  }
}
