/**
 * GitHub PR Creator service.
 *
 * Pushes the agent branch to GitHub and creates a richly-described PR with
 * full context: task, diff, verification results, judge verdict, and breaking
 * change detection.
 *
 * Key behaviors:
 * - Throws if GITHUB_TOKEN is not set
 * - Auto-generates unique branch name as `agent/<slug>-YYYY-MM-DD-<hex>` from task type
 * - If branch already exists on remote, fails with clear error (includes branch name)
 * - PR body has six sections: Task, Changes, Verification, LLM Judge, Breaking Changes, footer
 * - Breaking Changes section always present — shows 'None detected' when clean
 * - PR creation failure is non-fatal — returns PRResult with error field instead of throwing
 * - Token is sanitized from all error messages to prevent credential leaks
 * - Original branch is restored after push (even on failure)
 * - Only tracked files are staged (no accidental .env commits)
 */

import { randomBytes } from 'node:crypto';
import { simpleGit } from 'simple-git';
import { Octokit } from 'octokit';
import type { RetryResult, PRResult, VerificationResult, JudgeResult } from '../types.js';
import type { TaskCategory } from '../intent/types.js';

const MAX_BRANCH_DESC_LENGTH = 40;
const MAX_PR_TITLE_LENGTH = 72;
const MAX_DISPLAY_DESCRIPTION_LENGTH = 80;

// ---------------------------------------------------------------------------
// generateBranchName
// ---------------------------------------------------------------------------

/**
 * Generate a unique branch name from a task type string.
 *
 * Slugification:
 * - Lowercase
 * - Replace non-alphanumeric chars with hyphens
 * - Collapse runs of hyphens into one
 * - Trim hyphens from start/end
 * - Append YYYY-MM-DD date suffix and 6-char hex for uniqueness
 * - Prefix with `agent/`
 *
 * @example
 * generateBranchName('maven dependency update') // 'agent/maven-dependency-update-2026-03-02-a1b2c3'
 */
export function generateBranchName(taskType: string): string {
  const slug = taskType
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')   // non-alphanumeric → hyphen
    .replace(/-+/g, '-')             // collapse multiple hyphens
    .replace(/^-+|-+$/g, '');        // trim leading/trailing hyphens

  const date = new Date().toISOString().slice(0, 10);
  const suffix = randomBytes(3).toString('hex');
  return `agent/${slug}-${date}-${suffix}`;
}

// ---------------------------------------------------------------------------
// detectBreakingChanges
// ---------------------------------------------------------------------------

/**
 * Heuristics for detecting breaking changes in a git diff.
 *
 * Conservative set — only fires on very clear signals to minimize false positives.
 * For exported symbol removal, verifies the symbol isn't re-added (rename detection).
 */
const KEYWORD_SIGNALS = [
  { pattern: /BREAKING CHANGE/i, label: 'Commit message or diff declares BREAKING CHANGE' },
  { pattern: /major version bump/i, label: 'Major version increment detected' },
];

/**
 * Scan a git diff for breaking change signals and return a list of warnings.
 *
 * @param diff - Raw git diff string
 * @returns Array of warning labels (empty if no signals detected)
 */
export function detectBreakingChanges(diff: string): string[] {
  if (!diff) return [];

  const warnings: string[] = [];

  // Keyword-based signals
  for (const signal of KEYWORD_SIGNALS) {
    if (signal.pattern.test(diff)) {
      warnings.push(signal.label);
    }
  }

  // Exported symbol removal — verify the symbol isn't re-added (avoids false
  // positives on renames where the export is removed then re-added on a + line)
  const removedExportPattern = /^-\s*export\s+(?:class|function|const|type|interface)\s+(\w+)/gm;
  let match;
  while ((match = removedExportPattern.exec(diff)) !== null) {
    const symbolName = match[1];
    const reAddedPattern = new RegExp(
      `^\\+\\s*export\\s+(?:class|function|const|type|interface)\\s+${symbolName}\\b`, 'm'
    );
    if (!reAddedPattern.test(diff)) {
      warnings.push(`Exported symbol removed: ${symbolName}`);
    }
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// buildPRBody
// ---------------------------------------------------------------------------

const MAX_REASONING_CHARS = 2000;
const MAX_DIFF_STAT_CHARS = 3000;

interface BuildPRBodyOptions {
  task: string;
  finalResponse: string;
  diffStat: string;
  verificationResults: VerificationResult[];
  judgeResults: JudgeResult[] | undefined;
  breakingChangeWarnings: string[];
}

/**
 * Build the markdown body for a GitHub PR.
 *
 * Sections (in order):
 * 1. Task — the original task prompt verbatim
 * 2. Changes — agent finalResponse + diff stat in a fenced code block
 * 3. Verification — pass/fail badges for each verifier with details blocks
 * 4. LLM Judge — verdict badge with reasoning in a details block
 * 5. Breaking Changes — always present, shows warnings or 'None detected'
 * 6. Footer — horizontal rule + attribution
 */
export function buildPRBody(opts: BuildPRBodyOptions): string {
  const {
    task,
    finalResponse,
    diffStat,
    verificationResults,
    judgeResults,
    breakingChangeWarnings,
  } = opts;

  // Cap diffStat
  const cappedDiffStat = diffStat.length > MAX_DIFF_STAT_CHARS
    ? diffStat.slice(0, MAX_DIFF_STAT_CHARS) + '\n...(truncated)'
    : diffStat;

  // ---
  // Section 1: Task
  // ---
  const taskSection = `## Task\n\n${task}`;

  // ---
  // Section 2: Changes
  // ---
  const changesSection = [
    '## Changes',
    '',
    finalResponse,
    '',
    '```',
    cappedDiffStat,
    '```',
  ].join('\n');

  // ---
  // Section 3: Verification
  // ---
  let verificationContent: string;
  if (verificationResults.length === 0) {
    verificationContent = 'No verification results recorded.';
  } else {
    verificationContent = verificationResults
      .map((vr) => {
        const badge = vr.passed ? '✅ pass' : '❌ fail';
        // Collect error outputs for details block
        const errorOutputs = vr.errors
          .filter((e) => e.rawOutput)
          .map((e) => e.rawOutput as string);

        if (!vr.passed && errorOutputs.length > 0) {
          return [
            `**${badge}**`,
            '',
            '<details>',
            '<summary>Show output</summary>',
            '',
            '```',
            errorOutputs.join('\n'),
            '```',
            '</details>',
          ].join('\n');
        }
        return `**${badge}**`;
      })
      .join('\n\n');
  }
  const verificationSection = `## Verification\n\n${verificationContent}`;

  // ---
  // Section 4: LLM Judge
  // ---
  let judgeContent: string;
  if (!judgeResults || judgeResults.length === 0) {
    judgeContent = 'Judge not run.';
  } else {
    const lastJudge = judgeResults[judgeResults.length - 1];
    const verdictBadge = lastJudge.verdict === 'APPROVE' ? '✅ APPROVE' : '❌ VETO';

    // Cap reasoning
    const reasoning = lastJudge.reasoning.length > MAX_REASONING_CHARS
      ? lastJudge.reasoning.slice(0, MAX_REASONING_CHARS) + '...(truncated)'
      : lastJudge.reasoning;

    judgeContent = [
      `**${verdictBadge}**`,
      '',
      '<details>',
      '<summary>Show reasoning</summary>',
      '',
      reasoning,
      '</details>',
    ].join('\n');
  }
  const judgeSection = `## LLM Judge\n\n${judgeContent}`;

  // ---
  // Section 5: Breaking Changes
  // ---
  let breakingChangesSection: string;
  if (breakingChangeWarnings.length === 0) {
    breakingChangesSection = '## Breaking Changes\n\nNone detected.';
  } else {
    const warnings = breakingChangeWarnings.map((w) => `- ${w}`).join('\n');
    breakingChangesSection = `## ⚠️ Potential Breaking Changes\n\n${warnings}`;
  }

  // ---
  // Section 6: Footer
  // ---
  const footer = '---\n*Generated by background-coding-agent*';

  return [
    taskSection,
    '',
    changesSection,
    '',
    verificationSection,
    '',
    judgeSection,
    '',
    breakingChangesSection,
    '',
    footer,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// GitHubPRCreator
// ---------------------------------------------------------------------------

/**
 * Parse GitHub owner and repo from a remote URL.
 *
 * Supports:
 * - HTTPS: https://github.com/owner/repo.git
 * - SSH:   git@github.com:owner/repo.git
 *
 * Uses greedy matching and strips .git suffix separately for clarity.
 *
 * @throws Error if the URL cannot be parsed
 */
function parseGitHubRemote(remoteUrl: string): { owner: string; repo: string } {
  const url = remoteUrl.trim();

  // HTTPS format — greedy match, strip .git suffix separately
  const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/\s]+)$/);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2].replace(/\.git$/, '') };
  }

  // SSH format — greedy match, strip .git suffix separately
  const sshMatch = url.match(/github\.com:([^/]+)\/([^\s]+)$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2].replace(/\.git$/, '') };
  }

  throw new Error(`Cannot parse GitHub owner/repo from remote URL: ${url}`);
}

/**
 * Service that pushes an agent branch to GitHub and creates a PR.
 *
 * Safety guarantees:
 * - GITHUB_TOKEN is never included in error messages or PRResult.error
 * - Original branch is restored after push (even on failure)
 * - Only tracked files are staged (no accidental .env commits)
 */
export class GitHubPRCreator {
  constructor(private workspaceDir: string) {}

  /**
   * Push the current HEAD to a new branch and create a GitHub PR.
   *
   * @param opts.taskType - Used to auto-generate a branch name if no override provided
   * @param opts.originalTask - The task given to the agent (used in PR body and title)
   * @param opts.retryResult - Full retry result with session/verification/judge data
   * @param opts.branchOverride - If set, use this as the branch name instead of auto-generating
   * @returns PRResult — never throws (errors are returned in result.error)
   */
  async create(opts: {
    taskType: string;
    originalTask: string;
    retryResult: RetryResult;
    branchOverride?: string;
    description?: string;
    taskCategory?: TaskCategory;
  }): Promise<PRResult> {
    // Step 1: Require GITHUB_TOKEN — throws immediately (before any try/catch)
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      throw new Error('GITHUB_TOKEN environment variable is required for --create-pr');
    }

    // Sanitize any error message to strip the token before it reaches logs or output
    const sanitize = (msg: string) => msg.replaceAll(token, '***');

    const git = simpleGit(this.workspaceDir);

    // Step 2: Parse owner/repo from git remote (uses simple-git, not execFile)
    const remoteUrl = await git.remote(['get-url', 'origin']);
    if (!remoteUrl) {
      throw new Error('No origin remote configured in workspace');
    }
    const { owner, repo } = parseGitHubRemote(remoteUrl);

    const isGenericTask = opts.taskType === 'generic' && !!opts.description;

    const branchInput = isGenericTask
      ? `${opts.taskCategory ?? 'generic'} ${opts.description!.slice(0, MAX_BRANCH_DESC_LENGTH)}`
      : opts.taskType;
    const branchName = opts.branchOverride ?? generateBranchName(branchInput);

    // Save original branch for restoration — don't leave user on agent branch
    let originalBranch: string | null = null;
    try {
      originalBranch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
    } catch {
      // Detached HEAD or other issue — best-effort, no restore possible
    }

    try {
      // Step 3: Find diff base — use merge-base with remote default branch
      // so we capture ALL agent commits, not just the last one (fixes HEAD~1 issue)
      let diffBase = 'HEAD~1';
      for (const candidate of ['origin/main', 'origin/master']) {
        try {
          const base = (await git.raw(['merge-base', candidate, 'HEAD'])).trim();
          if (base) { diffBase = base; break; }
        } catch { /* candidate doesn't exist, try next */ }
      }

      // Step 4: Get diff stat for PR body
      let diffStat = 'No changes detected';
      try {
        const statOut = await git.diff(['--stat', diffBase, 'HEAD']);
        if (statOut.trim()) diffStat = statOut;
      } catch {
        // No prior commit or diff base invalid — proceed with default
      }

      // Step 5: Get full diff for breaking change detection (capped at 8000 chars)
      let fullDiff = '';
      try {
        const diffOut = await git.diff([diffBase, 'HEAD', '--no-color']);
        fullDiff = diffOut.slice(0, 8000);
      } catch {
        // No changes to diff — proceed with empty
      }

      // Step 6: Detect breaking changes
      const breakingChangeWarnings = detectBreakingChanges(fullDiff);

      // Step 7: Build PR body
      if (opts.retryResult.sessionResults.length === 0) {
        throw new Error('No session results available — cannot build PR body');
      }
      const lastSession = opts.retryResult.sessionResults[opts.retryResult.sessionResults.length - 1];
      const finalResponse = lastSession.finalResponse ?? '';

      // For generic tasks, show category + instruction instead of the full expanded prompt
      const taskContent = isGenericTask
        ? [
            `**Task category:** ${opts.taskCategory ?? 'generic'}`,
            '',
            `**Instruction:** ${opts.description}`,
          ].join('\n')
        : opts.originalTask;

      const prBody = buildPRBody({
        task: taskContent,
        finalResponse,
        diffStat,
        verificationResults: opts.retryResult.verificationResults,
        judgeResults: opts.retryResult.judgeResults,
        breakingChangeWarnings,
      });

      // Step 8: Push branch via simple-git
      // Build authenticated URL — NEVER log this (token would leak)
      const authedUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;

      // Stage only tracked file changes — avoids committing .env, secrets, etc.
      const statusResult = await git.status();
      if (!statusResult.isClean()) {
        await git.add('-u');
        await git.commit('chore: agent changes');
      }

      // Save HEAD — this is the tip with all agent commits for this task
      const agentHead = (await git.revparse(['HEAD'])).trim();

      // Fetch origin so we have the latest remote state
      try {
        await git.fetch('origin');
      } catch {
        // If fetch fails (no network), fall back to existing origin refs
      }

      // Determine remote default branch ref for branch isolation
      let remoteBase: string | null = null;
      for (const candidate of ['origin/main', 'origin/master']) {
        try {
          const sha = (await git.revparse([candidate])).trim();
          if (sha) { remoteBase = candidate; break; }
        } catch { /* candidate doesn't exist, try next */ }
      }

      // Create branch from remote base (not local HEAD) so each PR only
      // contains its own commits — prevents commit bleed across sequential tasks
      if (remoteBase) {
        try {
          await git.checkout(['-b', branchName, remoteBase]);
        } catch (e) {
          const msg = (e as Error).message;
          if (msg.includes('already exists')) {
            await git.checkout(branchName);
          } else {
            throw new Error(`Failed to create branch '${branchName}': ${sanitize(msg)}`);
          }
        }

        // Cherry-pick this task's commits onto the clean branch
        // diffBase..agentHead gives us exactly this task's commits
        try {
          await git.raw(['cherry-pick', `${diffBase}..${agentHead}`]);
        } catch (cpErr) {
          // Cherry-pick conflict — abort and fall back to pushing agentHead directly
          try { await git.raw(['cherry-pick', '--abort']); } catch { /* already clean */ }
          await git.checkout(branchName);
          await git.reset(['--hard', agentHead]);
        }
      } else {
        // No remote ref available — fall back to branching from HEAD (original behavior)
        try {
          await git.checkoutLocalBranch(branchName);
        } catch (e) {
          const msg = (e as Error).message;
          if (msg.includes('already exists')) {
            await git.checkout(branchName);
          } else {
            throw new Error(`Failed to create branch '${branchName}': ${sanitize(msg)}`);
          }
        }
      }

      // Push without --force-with-lease: not meaningful with URL push (no tracking
      // ref to compare against), and we're pushing a new branch anyway. A plain push
      // correctly rejects if the branch already exists on remote.
      try {
        await git.push(authedUrl, `HEAD:refs/heads/${branchName}`);
      } catch (pushErr) {
        const pushMsg = sanitize((pushErr as Error).message);
        if (pushMsg.includes('already exists') || pushMsg.includes('rejected')) {
          throw new Error(
            `Branch '${branchName}' already exists on the remote and push was rejected. ` +
            `Use --branch to specify a different branch name or resolve the conflict manually.`
          );
        }
        throw new Error(`Push failed: ${pushMsg}`);
      }

      // Step 9: Create PR via Octokit
      const octokit = new Octokit({ auth: token });

      // Get default branch
      const { data: repoData } = await octokit.rest.repos.get({ owner, repo });
      const baseBranch = repoData.default_branch;

      // Check for existing open PR
      const { data: existingPRs } = await octokit.rest.pulls.list({
        owner,
        repo,
        state: 'open',
        head: `${owner}:${branchName}`,
        base: baseBranch,
      });

      if (existingPRs.length > 0) {
        return {
          url: existingPRs[0].html_url,
          created: false,
          branch: branchName,
        };
      }

      // Create new PR
      const title = isGenericTask
        ? (opts.description!.length > MAX_PR_TITLE_LENGTH
          ? opts.description!.slice(0, MAX_PR_TITLE_LENGTH) + '...'
          : opts.description!)
        : `Agent: ${opts.taskType} ${new Date().toISOString().slice(0, 10)}`;
      const { data: pr } = await octokit.rest.pulls.create({
        owner,
        repo,
        title,
        body: prBody,
        head: branchName,
        base: baseBranch,
        draft: false,
      });

      return {
        url: pr.html_url,
        created: true,
        branch: branchName,
      };
    } catch (err) {
      return {
        url: '',
        created: false,
        branch: branchName,
        error: sanitize((err as Error).message),
      };
    } finally {
      // Restore original branch if we switched away from it
      if (originalBranch) {
        try {
          const currentBranch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
          if (currentBranch !== originalBranch) {
            await git.checkout(originalBranch);
          }

          // Reset local branch to origin so next task starts clean —
          // prevents commit bleed across sequential tasks on the same repo
          for (const candidate of ['origin/main', 'origin/master']) {
            try {
              await git.reset(['--hard', candidate]);
              break;
            } catch { /* candidate doesn't exist, try next */ }
          }
        } catch {
          // Best-effort restoration — if this fails, user is left on agent branch
        }
      }
    }
  }
}
