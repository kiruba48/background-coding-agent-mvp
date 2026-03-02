/**
 * GitHub PR Creator service.
 *
 * Pushes the agent branch to GitHub and creates a richly-described PR with
 * full context: task, diff, verification results, judge verdict, and breaking
 * change detection.
 *
 * Key behaviors:
 * - Throws if GITHUB_TOKEN is not set
 * - Auto-generates branch name as `agent/<slug>-YYYY-MM-DD` from task type
 * - If branch already exists on remote, fails with clear error (includes branch name)
 * - PR body has six sections: Task, Changes, Verification, LLM Judge, Breaking Changes, footer
 * - Breaking Changes section always present — shows 'None detected' when clean
 * - PR creation failure is non-fatal — returns PRResult with error field instead of throwing
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { simpleGit } from 'simple-git';
import { Octokit } from 'octokit';
import type { RetryResult, PRResult, VerificationResult, JudgeResult } from '../types.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// generateBranchName
// ---------------------------------------------------------------------------

/**
 * Generate a branch name from a task type string.
 *
 * Slugification:
 * - Lowercase
 * - Replace non-alphanumeric chars with hyphens
 * - Collapse runs of hyphens into one
 * - Trim hyphens from start/end
 * - Append YYYY-MM-DD date suffix
 * - Prefix with `agent/`
 *
 * @example
 * generateBranchName('maven dependency update') // 'agent/maven-dependency-update-2026-03-02'
 */
export function generateBranchName(taskType: string): string {
  const slug = taskType
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')   // non-alphanumeric → hyphen
    .replace(/-+/g, '-')             // collapse multiple hyphens
    .replace(/^-+|-+$/g, '');        // trim leading/trailing hyphens

  const date = new Date().toISOString().slice(0, 10);
  return `agent/${slug}-${date}`;
}

// ---------------------------------------------------------------------------
// detectBreakingChanges
// ---------------------------------------------------------------------------

/**
 * Heuristics for detecting breaking changes in a git diff.
 *
 * Conservative set — only fires on very clear signals to minimize false positives.
 */
const SIGNALS = [
  { pattern: /BREAKING CHANGE/i, label: 'Commit message or diff declares BREAKING CHANGE' },
  { pattern: /^-\s*(export\s+(class|function|const|type|interface))/m, label: 'Exported symbol removed' },
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
  for (const signal of SIGNALS) {
    if (signal.pattern.test(diff)) {
      warnings.push(signal.label);
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
 * @throws Error if the URL cannot be parsed
 */
function parseGitHubRemote(remoteUrl: string): { owner: string; repo: string } {
  const url = remoteUrl.trim();

  // HTTPS format: https://github.com/owner/repo or https://github.com/owner/repo.git
  const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/\s]+?)(?:\.git)?$/);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  // SSH format: git@github.com:owner/repo.git
  const sshMatch = url.match(/github\.com:([^/]+)\/([^\s]+?)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  throw new Error(`Cannot parse GitHub owner/repo from remote URL: ${url}`);
}

/**
 * Service that pushes an agent branch to GitHub and creates a PR.
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
  }): Promise<PRResult> {
    // Step 1: Require GITHUB_TOKEN — throws immediately (before any try/catch)
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      throw new Error('GITHUB_TOKEN environment variable is required for --create-pr');
    }

    // Step 2: Parse owner/repo from git remote — throws immediately if unparseable
    const { stdout: remoteUrlRaw } = await execFileAsync(
      'git',
      ['remote', 'get-url', 'origin'],
      { cwd: this.workspaceDir }
    );
    const { owner, repo } = parseGitHubRemote(remoteUrlRaw);

    const branchName = opts.branchOverride ?? generateBranchName(opts.taskType);

    try {

      // Step 3: Get diff stat for PR body
      let diffStat = 'No changes detected';
      try {
        const { stdout: statOut } = await execFileAsync(
          'git',
          ['diff', '--stat', 'HEAD~1', 'HEAD'],
          { cwd: this.workspaceDir }
        );
        if (statOut.trim()) {
          diffStat = statOut;
        }
      } catch {
        // Swallow — no prior commit or no changes
      }

      // Step 4: Get full diff for breaking change detection (capped at 8000 chars)
      let fullDiff = '';
      try {
        const { stdout: diffOut } = await execFileAsync(
          'git',
          ['diff', 'HEAD~1', 'HEAD', '--no-color'],
          { cwd: this.workspaceDir }
        );
        fullDiff = diffOut.slice(0, 8000);
      } catch {
        // Swallow
      }

      // Step 5: Detect breaking changes
      const breakingChangeWarnings = detectBreakingChanges(fullDiff);

      // Step 6: Build PR body
      const lastSession = opts.retryResult.sessionResults[opts.retryResult.sessionResults.length - 1];
      const finalResponse = lastSession?.finalResponse ?? '';

      const prBody = buildPRBody({
        task: opts.originalTask,
        finalResponse,
        diffStat,
        verificationResults: opts.retryResult.verificationResults,
        judgeResults: opts.retryResult.judgeResults,
        breakingChangeWarnings,
      });

      // Step 7: Push branch via simple-git
      // Build authenticated URL — NEVER log this (token would leak)
      const authedUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;

      const git = simpleGit(this.workspaceDir);

      // Check for uncommitted changes and auto-commit
      const statusResult = await git.status();
      if (!statusResult.isClean()) {
        await git.add('--all');
        await git.commit('chore: agent changes');
      }

      // Checkout or create the branch
      try {
        await git.checkoutLocalBranch(branchName);
      } catch {
        // Branch already exists locally — just check it out
        await git.checkout(branchName);
      }

      // Push — if branch already exists on remote, fail with clear error
      try {
        await git.push(authedUrl, `HEAD:refs/heads/${branchName}`, { '--force-with-lease': null });
      } catch (pushErr) {
        const pushMsg = (pushErr as Error).message;
        if (pushMsg.includes('already exists') || pushMsg.includes('rejected')) {
          throw new Error(
            `Branch '${branchName}' already exists on the remote and push was rejected. ` +
            `Use --branch to specify a different branch name or resolve the conflict manually.`
          );
        }
        throw pushErr;
      }

      // Step 8: Create PR via Octokit
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
      const title = `Agent: ${opts.taskType} ${new Date().toISOString().slice(0, 10)}`;
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
        error: (err as Error).message,
      };
    }
  }
}
