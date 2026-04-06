/**
 * WorktreeManager — git worktree lifecycle management.
 *
 * Encapsulates all git worktree operations:
 * - Creating a sibling worktree with a new branch and PID sentinel
 * - Removing a worktree and its associated branch (best-effort)
 * - Scanning the parent directory for orphaned worktrees from crashed sessions
 *   and pruning them based on PID liveness checks
 *
 * All git operations use execFile (no shell injection risk).
 * All cleanup paths are best-effort: failures are logged but never rethrown.
 */

import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { writeFile, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type pino from 'pino';

const execFileAsync = promisify(execFile);

/** Sentinel file name written inside the worktree directory. */
const SENTINEL_FILE = '.bg-agent-pid';

/** Prefix used for all worktree directory names. */
const WORKTREE_PREFIX = '.bg-agent-';

/** Shape of the JSON sentinel file stored in each worktree. */
interface PidSentinel {
  pid: number;
  branch: string;
  createdAt: number;  // Date.now() — used for staleness check during orphan pruning
}

/** Options for the remove() method. */
export interface RemoveOptions {
  /** When true, skip `git branch -d` — branch is preserved for post-hoc PR. */
  keepBranch?: boolean;
  /** Logger for warning on best-effort failures. */
  logger?: pino.Logger;
}

/** Sentinel files older than this are considered stale regardless of PID liveness (PID reuse guard). */
const STALE_SENTINEL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Manages the lifecycle of a single git worktree used by an agent session.
 *
 * Usage pattern:
 * ```ts
 * const suffix = randomBytes(3).toString('hex');
 * const worktreePath = WorktreeManager.buildWorktreePath(repoDir, suffix);
 * const branchName = generateBranchName(taskType);
 * const wm = new WorktreeManager(repoDir, worktreePath, branchName);
 * await wm.create();
 * // ... run agent in wm.path on wm.branch ...
 * await wm.remove();
 * ```
 */
export class WorktreeManager {
  constructor(
    private repoDir: string,
    private worktreePath: string,
    private branchName: string,
  ) {}

  // ---------------------------------------------------------------------------
  // Static path helpers
  // ---------------------------------------------------------------------------

  /**
   * Compute the canonical worktree path for a given repo and suffix.
   *
   * Places the worktree as a sibling of the repo directory:
   *   /parent/.bg-agent-<repoBasename>-<suffix>
   *
   * @example
   * buildWorktreePath('/code/my-app', 'a1b2c3') // → '/code/.bg-agent-my-app-a1b2c3'
   */
  static buildWorktreePath(repoDir: string, suffix: string): string {
    const parentDir = path.dirname(repoDir);
    const repoBasename = path.basename(repoDir);
    return path.join(parentDir, WORKTREE_PREFIX + repoBasename + '-' + suffix);
  }

  // ---------------------------------------------------------------------------
  // Instance lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Create the worktree and write a PID sentinel file.
   *
   * Runs: `git worktree add <worktreePath> -b <branchName>`
   * Then writes `.bg-agent-pid` with `{ pid, branch }` for orphan detection.
   */
  async create(): Promise<void> {
    await execFileAsync(
      'git',
      ['worktree', 'add', this.worktreePath, '-b', this.branchName],
      { cwd: this.repoDir },
    );

    await writeFile(
      path.join(this.worktreePath, SENTINEL_FILE),
      JSON.stringify({ pid: process.pid, branch: this.branchName, createdAt: Date.now() }),
    );
  }

  /**
   * Remove the worktree and optionally delete the branch — best-effort on both.
   *
   * Both operations are wrapped individually so a failure on one does not
   * prevent the other from running. Neither error is rethrown.
   *
   * @param opts.keepBranch - When true, skip branch deletion (for post-hoc PR)
   * @param opts.logger     - Optional logger for warning on best-effort failures
   */
  async remove(opts?: RemoveOptions): Promise<void> {
    const { keepBranch = false, logger } = opts ?? {};

    try {
      await execFileAsync(
        'git',
        ['worktree', 'remove', '--force', this.worktreePath],
        { cwd: this.repoDir },
      );
    } catch (err) {
      logger?.warn({ error: (err as Error).message, worktreePath: this.worktreePath },
        'Best-effort worktree removal failed');
    }

    if (!keepBranch) {
      try {
        // Use -d (safe delete) — refuses to delete unmerged branches.
        // Orphan pruning uses -D for confirmed-dead worktrees.
        await execFileAsync(
          'git',
          ['branch', '-d', this.branchName],
          { cwd: this.repoDir },
        );
      } catch (err) {
        logger?.warn({ error: (err as Error).message, branch: this.branchName },
          'Best-effort branch deletion failed');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Static orphan pruning
  // ---------------------------------------------------------------------------

  /**
   * Scan the parent directory of `repoDir` for orphaned worktrees and prune them.
   *
   * A worktree is considered an orphan when:
   * - Its `.bg-agent-pid` sentinel is missing or unparseable, OR
   * - The PID in the sentinel is no longer alive (ESRCH from `process.kill(pid, 0)`)
   *
   * EPERM means the process exists but we lack permission to signal it — treated as alive.
   *
   * All failures are per-worktree and do not propagate. If `readdir` itself fails,
   * the method returns silently.
   *
   * @param repoDir - Absolute path to the main repository (not the worktree)
   * @param logger  - Optional pino logger for warning messages
   */
  static async pruneOrphans(repoDir: string, logger?: pino.Logger): Promise<void> {
    const parentDir = path.dirname(repoDir);
    const repoBasename = path.basename(repoDir);
    const prefix = WORKTREE_PREFIX + repoBasename + '-';

    let entries: string[];
    try {
      entries = await readdir(parentDir);
    } catch {
      // Parent directory unreadable — nothing to prune
      return;
    }

    for (const entry of entries) {
      if (!entry.startsWith(prefix)) continue;

      const worktreePath = path.join(parentDir, entry);

      try {
        // Confirm it is actually a directory
        const dirStat = await stat(worktreePath);
        if (!dirStat.isDirectory()) continue;

        // Read and parse the sentinel file
        let sentinel: PidSentinel | null = null;
        try {
          const raw = await readFile(path.join(worktreePath, SENTINEL_FILE), 'utf8');
          const parsed = JSON.parse(raw) as unknown;
          if (
            parsed !== null &&
            typeof parsed === 'object' &&
            'pid' in parsed &&
            typeof (parsed as PidSentinel).pid === 'number' &&
            !isNaN((parsed as PidSentinel).pid) &&
            'branch' in parsed &&
            typeof (parsed as PidSentinel).branch === 'string'
          ) {
            sentinel = parsed as PidSentinel;
          }
        } catch {
          // Missing or unparseable sentinel — treat as orphan
        }

        // Determine liveness — guard against PID reuse with staleness check
        let isOrphan = sentinel === null;
        if (sentinel !== null) {
          const age = Date.now() - (sentinel.createdAt ?? 0);
          if (age > STALE_SENTINEL_MS) {
            // Sentinel older than 24h — stale regardless of PID (PID reuse guard)
            isOrphan = true;
            logger?.warn({ worktreePath, age: Math.round(age / 3600_000) + 'h' },
              'Stale sentinel — treating as orphan despite live PID');
          } else {
            try {
              process.kill(sentinel.pid, 0);
              // No error thrown — process is alive, skip
              isOrphan = false;
            } catch (err: unknown) {
              const code = (err as NodeJS.ErrnoException).code;
              if (code === 'ESRCH') {
                // Process does not exist — orphan
                isOrphan = true;
              } else {
                // EPERM or other — process exists, treat as alive
                isOrphan = false;
              }
            }
          }
        }

        if (!isOrphan) continue;

        // Prune the orphan
        logger?.warn({ worktreePath }, 'Pruning stale worktree');

        try {
          await execFileAsync(
            'git',
            ['worktree', 'remove', '--force', worktreePath],
            { cwd: repoDir },
          );
        } catch {
          // Best-effort — ignore errors
        }

        if (sentinel?.branch) {
          try {
            await execFileAsync(
              'git',
              ['branch', '-D', sentinel.branch],
              { cwd: repoDir },
            );
          } catch {
            // Best-effort — ignore errors
          }
        }
      } catch {
        // Per-worktree failure — continue to next entry
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Getters
  // ---------------------------------------------------------------------------

  /** Absolute path to the worktree directory. */
  get path(): string {
    return this.worktreePath;
  }

  /** Branch name created in this worktree. */
  get branch(): string {
    return this.branchName;
  }
}
