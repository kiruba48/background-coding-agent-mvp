# Phase 7: GitHub PR Creation - Research

**Researched:** 2026-03-02
**Domain:** GitHub REST API, git branch management, PR body generation
**Confidence:** HIGH

---

<phase_requirements>
## Phase Requirements

| ID    | Description                                                                 | Research Support |
|-------|-----------------------------------------------------------------------------|------------------|
| PR-01 | Agent creates GitHub PR on target repo after successful verification        | Octokit `pulls.create()` after `RetryResult.finalStatus === 'success'` |
| PR-02 | Agent auto-generates branch name from task context (e.g. `agent/update-spring-boot-3.2`) | Slug generation from task type + timestamp; `agent/` prefix convention |
| PR-03 | User can override branch name via CLI flag (`--branch`)                     | Commander.js `.option('--branch <name>')` added to existing CLI |
| PR-04 | PR body includes task prompt, summary of changes, diff stats               | `git diff --stat HEAD~1` parsed; Markdown template; Octokit `body` field |
| PR-05 | PR body includes verification results (build/test/lint pass/fail)          | `RetryResult.verificationResults` surfaced in body template |
| PR-06 | PR body includes LLM Judge verdict and reasoning                            | `RetryResult.judgeResults` surfaced in body template |
| PR-07 | PR body flags potential breaking changes for reviewer                       | Heuristic scan of diff for `BREAKING CHANGE`, major API removals, renamed exports |
</phase_requirements>

---

## Summary

Phase 7 adds GitHub PR creation as the final step in the pipeline after a successful `RetryResult`. The work decomposes into three distinct sub-problems: (1) pushing a local branch to the remote repo, (2) creating the PR via GitHub's REST API, and (3) composing a structured PR body from the run's artifacts.

The standard approach in the Node.js/TypeScript ecosystem is **simple-git** for local git operations (creating branch, committing, pushing) and **Octokit** (`octokit` npm package) for the GitHub API call. Both libraries are ESM-native and TypeScript-first. The project already uses `"module": "NodeNext"` in tsconfig — simple-git v3 is fully compatible; Octokit 5.x requires the same `node16`/`NodeNext` moduleResolution and works correctly with it.

Token authentication uses a Personal Access Token (PAT) embedded in the remote URL (`https://<token>@github.com/<owner>/<repo>.git`) for the push, and passed as `auth` to the Octokit constructor for the API call. The minimum fine-grained PAT permissions required are: `Contents: write` (for branch push) and `Pull requests: write` (for PR creation). Both should be read from a single `GITHUB_TOKEN` environment variable.

**Primary recommendation:** Use `simple-git` (v3.32+) for all local git operations and `octokit` (v5.0+) with `octokit.rest.pulls.create()` for PR creation. Do NOT use the GitHub API to push branches (the Git Data API approach is complex and error-prone for multi-file commits). Push via simple-git, create PR via Octokit. This is the established separation of concerns.

---

## Standard Stack

### Core

| Library       | Version | Purpose                           | Why Standard |
|---------------|---------|-----------------------------------|--------------|
| `simple-git`  | ^3.32   | Local git ops: branch, commit, push | Thin TypeScript wrapper over git CLI; no native binaries; ESM + CJS + TS bundled |
| `octokit`     | ^5.0    | GitHub REST API (create PR, list PRs) | Official all-in-one GitHub SDK; includes throttling, retry, full TypeScript types |

### Supporting

| Library   | Version | Purpose                        | When to Use |
|-----------|---------|--------------------------------|-------------|
| `@octokit/types` | ^16.0 | TypeScript type utilities for endpoint params/responses | Already bundled in `octokit`; import directly if narrowing types |

### Alternatives Considered

| Instead of    | Could Use                        | Tradeoff |
|---------------|----------------------------------|----------|
| `simple-git`  | `node:child_process` + git CLI   | Works but verbose; no type safety; argument escaping footguns |
| `simple-git`  | `isomorphic-git`                 | Pure JS, no CLI dep — but significantly more complex API for push + auth flow |
| `octokit`     | `@octokit/rest` (smaller)        | `@octokit/rest` lacks bundled throttling/retry; `octokit` v5 bundles both at negligible size cost |
| `octokit`     | Raw `fetch` + GitHub REST        | Valid but more boilerplate; no type inference on response |

**Installation:**
```bash
npm install simple-git octokit
```

---

## Architecture Patterns

### Recommended Project Structure

The PR creator is a host-side service (not in Docker). It fits alongside the judge and verifier:

```
src/
├── orchestrator/
│   ├── pr-creator.ts        # New: GitHubPRCreator class
│   ├── pr-creator.test.ts   # New: unit tests (mock Octokit + simple-git)
│   ├── judge.ts             # Existing: LLM Judge
│   └── verifier.ts          # Existing: build/test/lint verifiers
├── cli/
│   ├── commands/
│   │   └── run.ts           # Modified: call PRCreator after success, pass --branch flag
│   └── index.ts             # Modified: add --branch, --pr-title CLI options
└── types.ts                 # Modified: add PRResult interface
```

### Pattern 1: Two-Phase PR Flow (local push + API create)

**What:** Branch push (git) and PR creation (REST API) are separate operations.
**When to use:** Always — mixing them (e.g. GitHub Git Data API for file commits) is far more complex.

```typescript
// Source: established Node.js GitHub automation pattern
// Step 1: Push branch using simple-git
import { simpleGit, SimpleGit } from 'simple-git';

const git: SimpleGit = simpleGit(workspaceDir);
const authedRemoteUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;

await git.checkoutLocalBranch(branchName);
await git.add('.');
await git.commit(commitMessage);
await git.push(authedRemoteUrl, `HEAD:${branchName}`, ['--force-with-lease']);

// Step 2: Create PR using Octokit
import { Octokit } from 'octokit';

const octokit = new Octokit({ auth: token });
const { data: pr } = await octokit.rest.pulls.create({
  owner,
  repo,
  title: prTitle,
  body: prBody,
  head: branchName,
  base: 'main',
  draft: false,
});
console.log(`PR created: ${pr.html_url}`);
```

### Pattern 2: Idempotent Branch + PR (check-before-create)

**What:** Check if branch/PR already exists before creating. Avoids 422 errors on re-runs.
**When to use:** Always — agent re-runs are common (retries, re-invocations).

```typescript
// Check for existing open PR before creating
const existingPRs = await octokit.rest.pulls.list({
  owner,
  repo,
  state: 'open',
  head: `${owner}:${branchName}`,
});

if (existingPRs.data.length > 0) {
  // PR already exists — return its URL without creating a duplicate
  return existingPRs.data[0].html_url;
}

// No existing PR — create it
const { data: pr } = await octokit.rest.pulls.create({ ... });
```

### Pattern 3: Branch Name Generation

**What:** Generate `agent/<slug>` branch names from task type + timestamp for uniqueness.
**When to use:** When user does not provide `--branch` override.

```typescript
// Generate branch name from task context
function generateBranchName(taskType: string): string {
  // Convert task type to lowercase slug: "maven-dependency-update" -> same
  // "Maven Dependency Update" -> "maven-dependency-update"
  const slug = taskType
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')   // replace non-alphanumeric with hyphen
    .replace(/-+/g, '-')            // collapse multiple hyphens
    .replace(/^-|-$/g, '');         // trim leading/trailing hyphens

  // Add timestamp for uniqueness (avoid conflicts on repeated runs)
  const timestamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  return `agent/${slug}-${timestamp}`;
  // e.g. "agent/maven-dependency-update-2026-03-02"
}
```

### Pattern 4: PR Body Template

**What:** Structured Markdown body assembled from run artifacts.
**When to use:** All PR creations.

```typescript
function buildPRBody(opts: {
  task: string;
  diffStat: string;
  verificationResults: VerificationResult[];
  judgeResults: JudgeResult[] | undefined;
  breakingChangeWarnings: string[];
}): string {
  const verificationStatus = opts.verificationResults.every(r => r.passed) ? '✅ Passed' : '❌ Failed';
  const judgeVerdict = opts.judgeResults?.at(-1)?.verdict ?? 'Not run';

  const breakingSection = opts.breakingChangeWarnings.length > 0
    ? `\n## ⚠️ Potential Breaking Changes\n\n${opts.breakingChangeWarnings.map(w => `- ${w}`).join('\n')}\n`
    : '';

  return [
    `## Task`,
    ``,
    opts.task,
    ``,
    `## Changes`,
    ``,
    `\`\`\``,
    opts.diffStat,
    `\`\`\``,
    ``,
    `## Verification`,
    ``,
    `| Check | Result |`,
    `|-------|--------|`,
    ...opts.verificationResults.map(r =>
      `| ${r.errors[0]?.type ?? 'composite'} | ${r.passed ? '✅ pass' : '❌ fail'} |`
    ),
    ``,
    `## LLM Judge`,
    ``,
    `**Verdict:** ${judgeVerdict}`,
    opts.judgeResults?.at(-1)?.reasoning
      ? `\n**Reasoning:** ${opts.judgeResults.at(-1)!.reasoning}`
      : '',
    breakingSection,
    `---`,
    `*Generated by background-coding-agent*`,
  ].join('\n');
}
```

### Pattern 5: Git Diff Stat for PR Body

**What:** Get a human-readable diff summary using `git diff --stat`.
**When to use:** Always — gives reviewer quick file-level summary.

```typescript
// Already used in judge.ts — same pattern
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function getDiffStat(workspaceDir: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--stat', 'HEAD~1', 'HEAD'], {
      cwd: workspaceDir,
    });
    return stdout.trim() || 'No changes detected';
  } catch {
    return 'Could not retrieve diff stats';
  }
}
```

### Pattern 6: Breaking Change Heuristics

**What:** Scan diff text for signals that indicate breaking changes, flag them in PR body.
**When to use:** Always — pure heuristic, no external tool needed.

```typescript
// Heuristics that signal breaking changes (for PR-07)
const BREAKING_CHANGE_SIGNALS = [
  { pattern: /BREAKING CHANGE/i, label: 'Commit message declares BREAKING CHANGE' },
  { pattern: /^-\s*(export\s+(class|function|const|type|interface))/m, label: 'Exported symbol removed' },
  { pattern: /major version bump/i, label: 'Major version increment' },
];

function detectBreakingChanges(diff: string): string[] {
  return BREAKING_CHANGE_SIGNALS
    .filter(({ pattern }) => pattern.test(diff))
    .map(({ label }) => label);
}
```

### Anti-Patterns to Avoid

- **Using GitHub Git Data API to create commits:** The REST API for creating blobs, trees, and commits is designed for single-file updates without a local clone. For multi-file agent workspaces, use `git push` via simple-git instead.
- **Hardcoding `main` as base branch:** Repos use `main`, `master`, `develop`, etc. Always call `octokit.rest.repos.get()` and read `data.default_branch`.
- **Building the remote URL in multiple places:** Token appears in the URL. Construct once in a single function, never log it.
- **Ignoring existing PR check:** `pulls.create()` returns 422 if a PR already exists for the same head+base pair. Always check first.
- **Truncating judge reasoning in the PR body:** The reasoning is for the human reviewer. Include it fully (max 2000 chars to stay within 65,536-char PR body limit).
- **Storing token in `.git/config`:** simple-git push accepts a URL with embedded token at call time. Do not call `git remote add` with the token URL — it writes to `.git/config` on disk.

---

## Don't Hand-Roll

| Problem                        | Don't Build                         | Use Instead          | Why |
|-------------------------------|-------------------------------------|----------------------|-----|
| Git branch creation + push    | Raw `child_process.execFile('git', ...)` chains | `simple-git` | Handles argument escaping, promise chains, error parsing; typed API |
| GitHub REST API calls          | `fetch()` to `api.github.com`      | `octokit.rest.*`     | Auto-retry on 429, proper 422/403 error objects, full TypeScript types |
| PR existence check             | Parse error message from 422        | `pulls.list()` before `pulls.create()` | Idempotent and doesn't rely on error text parsing |
| Diff stat parsing              | Custom regex on `git diff` output   | `git diff --stat HEAD~1 HEAD` (already in judge.ts pattern) | Already established in codebase |
| Branch name slug generation    | External `slugify` npm package      | Inline 3-line regex (see Pattern 3) | Trivial; no dependency needed for this constraint |

**Key insight:** The GitHub API is stateful and has multiple failure modes (rate limits, 422 validation, 403 permissions). Octokit handles these cleanly. Hand-rolling HTTP calls leads to silent failures and missing retry logic.

---

## Common Pitfalls

### Pitfall 1: Token Leakage in Logs

**What goes wrong:** `git push` command with embedded token URL gets logged at DEBUG level by simple-git or Pino.
**Why it happens:** simple-git logs the full command including the URL when debug is enabled.
**How to avoid:** Set `DEBUG=''` (empty) when using simple-git with token URLs. Never log the `authedRemoteUrl`. Pass token URL only to `.push()`, not to `.addRemote()`.
**Warning signs:** Log output contains `github.com` URLs with long alphanumeric strings.

### Pitfall 2: Wrong Base Branch

**What goes wrong:** PR created against `main` but repo uses `master` (or `develop`). PR immediately shows "can't be merged" or conflicts.
**Why it happens:** Hardcoding `base: 'main'`.
**How to avoid:** Always fetch `default_branch` from `octokit.rest.repos.get({ owner, repo })`.
**Warning signs:** Tests pass locally (against a `main` repo) but fail against target repos.

### Pitfall 3: Branch Already Exists

**What goes wrong:** Re-run of the same task creates a conflicting branch. `git push` fails with `rejected (already exists)`.
**Why it happens:** Branch `agent/task-2026-03-02` was created in a previous run.
**How to avoid:** Use `--force-with-lease` for push (safe force). Before push, try `checkoutLocalBranch` — if it fails (branch exists locally), use `checkout(branchName)` instead.
**Warning signs:** `GitError: Command failed` with "already exists" or "rejected" in message.

### Pitfall 4: PR Body Exceeds 65,536 Characters

**What goes wrong:** PR creation returns 422 with "body is too long".
**Why it happens:** Full judge reasoning + full diff stat + verbose verification output in body.
**How to avoid:** Cap judge reasoning at 2,000 chars. Cap diff stat at 3,000 chars. Use `--stat` (summary) not full diff in PR body. Keep total body under 50,000 chars as safety margin.
**Warning signs:** 422 error on `pulls.create()` with message about body length.

### Pitfall 5: Race Between Push and PR Create

**What goes wrong:** PR create returns 422 "No commits between main and agent/branch" immediately after push.
**Why it happens:** GitHub's API occasionally indexes branch refs before commits are fully propagated.
**How to avoid:** No sleep/retry needed in practice — this is rare and self-correcting. But if it occurs, retry `pulls.create()` once after a 2-second delay.
**Warning signs:** 422 with "No commits between" message.

### Pitfall 6: Octokit ESM + NodeNext Module Resolution

**What goes wrong:** TypeScript compilation error with Octokit imports because of conditional exports.
**Why it happens:** `octokit` v5 uses conditional exports (ESM-only). Project uses `"module": "NodeNext"`.
**How to avoid:** The project already uses `"moduleResolution": "NodeNext"` which handles conditional exports correctly — no change needed. Verified: NodeNext is a superset of node16 for this purpose.
**Warning signs:** `Cannot find module 'octokit'` or `does not provide an export named` at compile time.

### Pitfall 7: simple-git Import Syntax with NodeNext

**What goes wrong:** TypeScript error "This expression is not callable" when using default import of simple-git.
**Why it happens:** Default import behavior changed with NodeNext module resolution.
**How to avoid:** Use named import: `import { simpleGit } from 'simple-git'` (not `import simpleGit from 'simple-git'`). Fixed in simple-git v3.10+.
**Warning signs:** TypeScript error at `simpleGit()` call site.

---

## Code Examples

Verified patterns from official sources and ecosystem standards:

### Octokit Instantiation and PR Creation (Verified: octokit/octokit.js README)

```typescript
// Source: https://github.com/octokit/octokit.js/blob/main/README.md
import { Octokit } from 'octokit';

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

// Create a pull request
const { data: pr } = await octokit.rest.pulls.create({
  owner: 'myorg',
  repo:  'myrepo',
  title: 'Agent: maven-dependency-update 2026-03-02',
  body:  prBody,
  head:  'agent/maven-dependency-update-2026-03-02',
  base:  'main',   // Use default_branch from repos.get()
  draft: false,
});

console.log(pr.html_url);  // https://github.com/myorg/myrepo/pull/42
```

### Getting Default Branch (Verified: GitHub REST API docs)

```typescript
// Source: https://docs.github.com/en/rest/repos/repos#get-a-repository
const { data: repoData } = await octokit.rest.repos.get({ owner, repo });
const baseBranch = repoData.default_branch;  // 'main' or 'master' etc.
```

### Check Existing PR Before Create (Verified: GitHub REST API docs + community pattern)

```typescript
// Source: GitHub REST API - List pull requests
const { data: existingPRs } = await octokit.rest.pulls.list({
  owner,
  repo,
  state: 'open',
  head: `${owner}:${branchName}`,   // Format: "owner:branch"
  base: baseBranch,
});

if (existingPRs.length > 0) {
  return { url: existingPRs[0].html_url, created: false };
}
```

### simple-git Named Import and Push with Token (Verified: simple-git issue #804 resolution)

```typescript
// Source: https://github.com/steveukx/git-js/issues/804
import { simpleGit, SimpleGit } from 'simple-git';   // Named import — required for NodeNext

const git: SimpleGit = simpleGit(workspaceDir);

// CRITICAL: Construct token URL once; never log or store
const authedUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;

await git.checkoutLocalBranch(branchName);
await git.add('--all');
await git.commit(`agent: ${taskType}`);

// Push using authenticated URL directly (not via git remote add)
// --force-with-lease: safe force push (fails if remote diverged unexpectedly)
await git.push(authedUrl, `HEAD:refs/heads/${branchName}`, { '--force-with-lease': null });
```

### Token from Environment (Security pattern)

```typescript
// Source: GitHub docs + project established pattern (judge.ts uses env vars)
const token = process.env.GITHUB_TOKEN;
if (!token) {
  throw new Error('GITHUB_TOKEN environment variable is required for PR creation');
}

// Parse owner/repo from remote URL (already cloned repo)
const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
  cwd: workspaceDir,
});
// Parse: "https://github.com/owner/repo.git" or "git@github.com:owner/repo.git"
const match = stdout.trim().match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
if (!match) throw new Error(`Cannot parse GitHub owner/repo from remote URL: ${stdout}`);
const [, owner, repo] = match;
```

### Diff Stat for PR Body (Verified: git docs, matches judge.ts pattern)

```typescript
// Source: git-diff docs + existing judge.ts pattern in this codebase
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function getDiffStat(workspaceDir: string, maxChars = 3_000): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git', ['diff', '--stat', 'HEAD~1', 'HEAD'],
      { cwd: workspaceDir }
    );
    const stat = stdout.trim();
    if (stat.length > maxChars) {
      return stat.slice(0, maxChars) + '\n... (truncated)';
    }
    return stat || 'No changes detected';
  } catch {
    return 'Could not retrieve diff stats';
  }
}
```

---

## State of the Art

| Old Approach              | Current Approach                     | When Changed     | Impact |
|---------------------------|--------------------------------------|------------------|--------|
| `@octokit/rest` standalone | `octokit` v5 (all-batteries-included) | 2022 → GA 2024  | Includes throttling + retry by default; no extra install |
| Classic PAT (coarse)      | Fine-grained PAT (GA March 2025)     | March 2025       | Can scope token to specific repos + operations |
| `nodegit` (native bindings) | `simple-git` (CLI wrapper)          | ~2020 steady state | No native compile step; works with any Node.js version |
| Password auth in git URL  | Token in `x-access-token:` URL      | 2021             | GitHub removed password auth; token format is current standard |

**Deprecated/outdated:**
- `nodegit`: Requires native compilation, libgit2 dep; not recommended for new projects. Use simple-git instead.
- `@octokit/rest` alone: Still maintained, but the `octokit` umbrella package bundles it with throttling/retry; prefer `octokit` for new work.
- Classic GitHub PATs with `repo` scope: Still functional but overly broad. Fine-grained PATs (GA March 2025) are the current best practice for automation.

---

## Open Questions

1. **Where to call PRCreator in the pipeline**
   - What we know: `runAgent()` in `run.ts` already returns after `RetryResult`. The right insertion point is after `finalStatus === 'success'` check.
   - What's unclear: Should PR creation be mandatory (fail the run if PR fails) or advisory (log error, return success)?
   - Recommendation: PR creation failure should be a non-zero exit code but distinct from agent failure. PR-01 says "a GitHub PR exists after successful run" — treat it as required.

2. **Target repo owner/repo detection**
   - What we know: Agent workspace is a local directory. The remote URL is in `.git/config`. Can be parsed via `git remote get-url origin`.
   - What's unclear: Repos without a `origin` remote or with SSH remotes need fallback.
   - Recommendation: Parse `git remote get-url origin`, handle both HTTPS (`github.com/owner/repo`) and SSH (`git@github.com:owner/repo`) formats. If neither, fail with a clear error message — PR-01 cannot be satisfied without a GitHub remote.

3. **Commit message strategy before push**
   - What we know: Agent runs in Docker and commits its own changes. The branch already has agent commits.
   - What's unclear: Does the agent always commit? Or does it leave changes staged/unstaged?
   - Recommendation: Before push, run `git status --porcelain`. If there are uncommitted changes, make a "chore: agent changes" commit. If clean, push as-is.

---

## Sources

### Primary (HIGH confidence)

- `octokit` npm package v5.0.5 — verified via `npm view octokit version` and `npm view octokit dependencies`
- `simple-git` npm package v3.32.3 — verified via `npm view simple-git version`
- GitHub REST API docs (pulls.create) — https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#create-a-pull-request — verified params, response shape, status codes
- GitHub REST API docs (git/refs create) — https://docs.github.com/en/rest/git/refs?apiVersion=2022-11-28#create-a-reference — verified SHA + ref format requirements
- GitHub REST API docs (permissions for fine-grained PATs) — https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens — verified `Contents: write` + `Pull requests: write` are required

### Secondary (MEDIUM confidence)

- simple-git issue #804 resolution (named import fix) — https://github.com/steveukx/git-js/issues/804 — resolved in v3.10.0; named import `{ simpleGit }` is the canonical form
- octokit/octokit.js issue #2680 (ESM + NodeNext) — https://github.com/octokit/octokit.js/issues/2680 — confirmed NodeNext is compatible (octokit is ESM-only; NodeNext handles this correctly)
- Octokit README — https://github.com/octokit/octokit.js/blob/main/README.md — `octokit.rest.pulls.create()` signature confirmed
- GitHub blog: fine-grained PATs GA — https://github.blog/changelog/2025-03-18-fine-grained-pats-are-now-generally-available/ — confirmed GA status March 2025

### Tertiary (LOW confidence)

- PR body 65,536 char limit — community discussion #41331 — limit is on gzipped request body, not raw chars; keep under 50,000 chars to be safe

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — verified package versions from npm registry; both libraries are well-established
- Architecture: HIGH — two-phase push+create pattern is universal in GitHub automation tooling; verified in official docs
- Pitfalls: MEDIUM-HIGH — most pitfalls verified against GitHub community discussions and official API error codes; token leak pitfall is engineering common sense

**Research date:** 2026-03-02
**Valid until:** 2026-09-02 (6 months — Octokit and GitHub API are stable; fine-grained PAT scopes could change)
