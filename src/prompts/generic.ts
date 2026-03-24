import { readManifestDeps } from '../intent/context-scanner.js';

/**
 * Builds an end-state prompt for generic task instructions.
 *
 * Uses end-state prompting (per project decision from Spotify research, TASK-04):
 * describes the desired outcome, not step-by-step instructions. The agent
 * discovers the current state and plans its own approach.
 *
 * Includes a SCOPE fence per PROMPT-02 to prevent the agent from making
 * unrelated changes. Optionally includes a CONTEXT block with manifest
 * dependencies when a repoPath is supplied.
 *
 * @param description - Verbatim user instruction (the desired outcome)
 * @param repoPath - Optional path to repo for manifest dependency injection
 * @returns End-state prompt string
 */
export async function buildGenericPrompt(
  description: string,
  repoPath?: string,
): Promise<string> {
  const lines: string[] = [
    `You are a coding agent. ${description}`,
    '',
    `SCOPE: Only make changes necessary to accomplish the stated task. Do NOT:`,
    `- Modify files unrelated to the task`,
    `- Add or remove dependencies unless the task explicitly requires it`,
    `- Restructure the codebase or reorganize files beyond what the task requires`,
    `- Apply stylistic or formatting changes outside of modified code`,
    '',
    `After your changes, the following should be true:`,
    `- ${description}`,
    `- No files outside the task scope have been modified`,
    '',
  ];

  if (repoPath) {
    const manifestDeps = await readManifestDeps(repoPath);
    if (manifestDeps !== 'No manifest found') {
      // Insert CONTEXT block before the trailing empty line
      lines.splice(lines.length - 1, 0,
        `CONTEXT:`,
        manifestDeps,
        '',
      );
    }
  }

  lines.push(`Work in the current directory.`);
  return lines.join('\n');
}
