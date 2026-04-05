---
created: 2026-04-05T12:10:00.000Z
title: Git worktrees for concurrent Slack tasks
area: slack
priority: high
files:
  - src/slack/index.ts:52-77
  - src/slack/adapter.ts:100-190
  - src/orchestrator/pr-creator.ts:413-450
---

## Problem

When multiple users (or the same user) mention the Slack bot for tasks on the same repo, the agent runs in the actual repo working directory. Concurrent tasks corrupt each other — file writes collide, git commits interleave, and branch operations race. The sequential cherry-pick fix (d3b56e0) prevents commit bleed for back-to-back tasks, but parallel execution is still unsafe.

## Solution

Use `git worktree add` to give each Slack task an isolated copy of the repo:

1. **On `app_mention`**: Before calling `processSlackMention`, create a temporary worktree:
   ```
   git worktree add /tmp/agent-<threadTs> origin/main
   ```
   Pass the worktree path as the workspace directory instead of the original repo.

2. **Agent runs in the worktree**: Fully isolated filesystem — no interference with other tasks or the user's working directory. The agent commits to its own detached branch within the worktree.

3. **PR creation**: `GitHubPRCreator` already accepts a `workspaceDir` — just pass the worktree path. Branch creation and push work normally from the worktree.

4. **Cleanup**: In the `.finally()` block after the agent completes:
   ```
   git worktree remove /tmp/agent-<threadTs> --force
   ```

5. **Benefits**:
   - True parallel execution — multiple tasks on the same repo simultaneously
   - No risk of corrupting the user's local working directory
   - No need for repo-level mutexes or sequential queuing
   - Each worktree shares the same `.git` storage (disk-efficient)

6. **Edge cases to handle**:
   - Worktree cleanup on process crash (stale worktree lockfiles)
   - Disk space for many concurrent worktrees
   - Worktree base ref should be `origin/main` (fetch before creating)
