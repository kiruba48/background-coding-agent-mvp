/**
 * Builds an end-state prompt for npm dependency update tasks.
 *
 * Uses end-state prompting (per project decision from Spotify research, TASK-04):
 * describes the desired outcome, not step-by-step instructions. The agent
 * discovers the current state and plans its own approach.
 *
 * Note: NPM-05 (changelog link) is deferred — Docker has no network access.
 * Note: Lockfile regeneration is a host-side concern; do not instruct the agent.
 *
 * @param packageName - npm package name (e.g., lodash, @types/node)
 * @param targetVersion - Target version to update to
 * @returns End-state prompt string
 */
export function buildNpmPrompt(packageName: string, targetVersion: string): string {
  return [
    `You are a coding agent. Update the npm package ${packageName} to version ${targetVersion}.`,
    '',
    `After your changes, the following should be true:`,
    `- The package.json file references ${packageName} at version ${targetVersion}`,
    `- The project build succeeds without errors`,
    `- All existing tests pass`,
    `- Any breaking API changes introduced by the version update are resolved — adapt source code as needed so compilation and tests succeed`,
    '',
    `Work in the current directory.`,
  ].join('\n');
}
