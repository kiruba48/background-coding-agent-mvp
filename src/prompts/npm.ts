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
    `SCOPE: Only modify what is necessary to update ${packageName}. Do NOT:`,
    `- Add, remove, or update any other dependencies`,
    `- Change scripts, project configuration, or unrelated fields in package.json`,
    `- Reformat or reorganize package.json beyond the targeted version change`,
    `- Modify files unrelated to the ${packageName} version update`,
    `- Read or modify package-lock.json (lockfile regeneration is handled externally)`,
    '',
    `After your changes, the following should be true:`,
    `- The version string for ${packageName} in package.json is exactly ${targetVersion}`,
    `- Only the ${packageName} version line in package.json has changed`,
    `- If the update introduces breaking API changes in source code that imports ${packageName}, adapt only those affected source files so compilation succeeds`,
    '',
    `Work in the current directory.`,
  ].join('\n');
}
