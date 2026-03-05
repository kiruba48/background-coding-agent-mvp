/**
 * Builds an end-state prompt for Maven dependency update tasks.
 *
 * Uses end-state prompting (per project decision from Spotify research, TASK-04):
 * describes the desired outcome, not step-by-step instructions. The agent
 * discovers the current state and plans its own approach.
 *
 * @param dep - Maven coordinate in groupId:artifactId format
 * @param targetVersion - Target version to update to
 * @returns End-state prompt string
 */
export function buildMavenPrompt(dep: string, targetVersion: string): string {
  return [
    `You are a coding agent. Update the Maven dependency ${dep} to version ${targetVersion}.`,
    '',
    `After your changes, the following should be true:`,
    `- All pom.xml files that reference ${dep} use version ${targetVersion}`,
    `- The project build succeeds without errors`,
    `- All existing tests pass`,
    `- Any breaking API changes introduced by the version update are resolved — adapt source code as needed so compilation and tests succeed`,
    '',
    `Work in the current directory.`,
  ].join('\n');
}
