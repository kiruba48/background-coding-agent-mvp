/**
 * Builds an end-state prompt for Maven dependency update tasks.
 *
 * Uses end-state prompting (per project decision from Spotify research, TASK-04):
 * describes the desired outcome, not step-by-step instructions. The agent
 * discovers the current state and plans its own approach.
 *
 * @param dep - Maven coordinate in groupId:artifactId format
 * @param targetVersion - Target version to update to, or 'latest' sentinel
 * @returns End-state prompt string
 */
export function buildMavenPrompt(dep: string, targetVersion: string): string {
  const isLatest = targetVersion === 'latest';

  const firstLine = isLatest
    ? `You are a coding agent. Update the Maven dependency ${dep} to the latest available version.`
    : `You are a coding agent. Update the Maven dependency ${dep} to version ${targetVersion}.`;

  const afterChangesVersion = isLatest
    ? `- All pom.xml files that reference ${dep} use the latest available version`
    : `- All pom.xml files that reference ${dep} use version ${targetVersion}`;

  return [
    firstLine,
    '',
    `SCOPE: Only modify what is necessary to update ${dep}. Do NOT:`,
    `- Add, remove, or update any other dependencies`,
    `- Change plugins, build configuration, or unrelated fields in pom.xml`,
    `- Reformat or reorganize pom.xml beyond the targeted version change`,
    `- Modify files unrelated to the ${dep} version update`,
    '',
    `After your changes, the following should be true:`,
    afterChangesVersion,
    `- Only the ${dep} version entries in pom.xml files have changed`,
    `- If the update introduces breaking API changes in source code that imports ${dep}, adapt only those affected source files so compilation succeeds`,
    '',
    `Work in the current directory.`,
  ].join('\n');
}
