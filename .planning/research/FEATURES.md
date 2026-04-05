# Feature Research

**Domain:** Background coding agent — git worktree isolation for concurrent execution and read-only repo exploration tasks
**Researched:** 2026-04-05
**Confidence:** HIGH (worktree mechanics from official git docs + ecosystem patterns), MEDIUM (exploration task subtypes based on general agent patterns)

---

## Context

This milestone (v2.4) adds two new feature areas to the existing background coding agent, plus accumulated tech debt cleanup. Already shipped and not re-researched: REPL/one-shot/Slack interfaces, intent parser, confirm-before-execute, generic + dep-update task types, composite verifier + LLM Judge, RetryOrchestrator, post-hoc PR creation, SessionCallbacks, conversational scoping dialogue, follow-up referencing.

The research question: what do git worktree isolation and repo exploration tasks require — what are the expected mechanics, user-facing behaviors, and integration patterns?

---

## Feature Landscape

### Table Stakes (Users Expect These)

Features users expect once concurrent agent execution is offered. Missing these makes the feature feel broken.

| Feature | Why Expected | Complexity | Notes | Depends On |
|---------|--------------|------------|-------|-----------|
| One worktree per agent session | Concurrent runs must not share a working directory — file edits from run A would corrupt run B. This is the foundational isolation primitive. | LOW | `git worktree add <path> -b <branch>` creates a linked working directory sharing the same `.git` object store. No full clone needed. Host-side git execution is already established (Key Decision: "Host-side git execution"). | Existing `ClaudeCodeSession` Docker mount path (must mount worktree dir, not main repo dir) |
| Sibling directory naming that avoids collisions | Multiple simultaneous worktrees need unique paths. Predictable naming aids debugging and cleanup. | LOW | Standard pattern: `<repo-name>-worktrees/<branch-slug>` as sibling directory. Branch slug generated from task description: slugify + short UUID suffix to guarantee uniqueness. Example: `my-api-worktrees/rename-fetchuser-a3f7`. | Branch name generation (auto-generates today, extend to include UUID suffix) |
| Worktree cleanup after PR creation or task failure | Abandoned worktrees accumulate and consume disk. Users expect cleanup to be automatic, not manual. | MEDIUM | `git worktree remove <path>` + `git worktree prune` must run post-task (success + PR, failure, veto, zero-diff). Important: cleanup must happen even if agent errors mid-run — wrap in finally block. Branch deletion is separate: `git branch -d <branch>` only after PR is merged or explicitly abandoned (don't delete on failure — PR may still be raised). | `RetryOrchestrator` result handling path, existing branch name management |
| Docker container mounts worktree directory, not main repo | Container must see the worktree's working files. If the main repo directory is mounted, the container operates on the wrong filesystem state. | MEDIUM | Current pattern: bind-mount repo root into container. With worktrees, bind-mount the worktree directory instead. The `.git` pointer file in the worktree root is sufficient — container doesn't need access to the main `.git` directory for reads/edits. Git ops that need the object store (commits, push) remain host-side. | Docker run config in `ClaudeCodeSession`, existing host-side git execution pattern |
| Exploration tasks do not produce PRs or code changes | Read-only tasks return a textual report. Users expect a clear distinction: code-change tasks → PR, exploration tasks → report output. Mixing these would erode trust in the pipeline. | LOW | Separate task type: `explore`. No `GitHubPRCreator` invoked. No verifier pipeline. Output is a markdown report string written to stdout / REPL / Slack thread. | Intent parser (add `explore` taskType), pipeline routing in `runAgent()` |
| Exploration tasks still run in Docker with no network | Security model is non-negotiable per PROJECT.md constraints. Exploration tasks read the repo — they don't need network access and should not be granted it. | LOW | Use the same Docker + iptables setup. No new security surface introduced. The read-only nature is enforced by prompt construction (no write tools in the prompt), not by OS-level restrictions — consistent with how the agent SDK works. | Existing Docker isolation infrastructure |

### Differentiators (Competitive Advantage)

Features that raise the quality of worktree and exploration beyond baseline expectations.

| Feature | Value Proposition | Complexity | Notes | Depends On |
|---------|-------------------|------------|-------|-----------|
| Worktree-aware branch name shown at confirm step | User sees the exact branch that will be created before proceeding. Improves transparency and lets user catch naming issues before the run starts. | LOW | The branch name is generated during intent parsing today. Display it at the confirm step alongside task description and repo. Zero new infrastructure — add `branchName` to the `displayIntent` output. | Branch name generation (already exists), `confirm-loop.ts` |
| Exploration report structured with clear section headers | Raw LLM output is hard to skim. A report with `## Branching Strategy`, `## CI Pipeline`, `## File Structure` sections is scannable and actionable. | LOW | Prompt construction for `explore` tasks specifies a markdown section structure. The agent uses Read/Glob/Grep/Bash(git log, gh run list) to gather data, then writes a structured report. Section schema defined per exploration subtype. | `buildExplorePrompt` (new prompts module function) |
| Exploration subtypes: branching strategy, CI checks, project structure | General "explore this repo" is too vague for the agent to produce a high-signal report. Explicit subtypes scoped to known questions produce better output consistently. | MEDIUM | Three subtypes to begin with: `git-strategy` (branching model, PR workflow, commit conventions), `ci-checks` (workflows in `.github/workflows/`, common failure patterns, test coverage signals), `project-structure` (directory layout, key modules, dependency graph summary). Each subtype has a purpose-built prompt section. | `buildExplorePrompt`, intent parser update |
| Worktree cleanup runs even on SIGINT / process exit | If the user Ctrl+Cs mid-run, orphaned worktrees accumulate silently. Cleanup on exit makes worktrees feel ephemeral. | MEDIUM | Register a `process.on('SIGINT')` and `process.on('beforeExit')` handler that prunes known worktrees. Track active worktrees in a module-level set. `git worktree prune` as the fallback sweep. Critical: don't leave orphaned `.git/worktrees/` metadata entries. | Worktree lifecycle manager (new module), process signal handling |
| Tech debt: cancelled tasks recorded as `failed` fixed | Misleading status in session history makes it harder to reason about what happened. `cancelled` should map to its own terminal state. | LOW | Exit code switch in CLI output handler has missing explicit `vetoed` and `turn_limit` cases; `cancelled` goes to `failed`. Add explicit cases. This is cleanup work but improves observability across all task types. | `src/cli/output.ts` or equivalent status-mapping path |

### Anti-Features (Commonly Requested, Often Problematic)

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Shared worktree across multi-turn REPL tasks | "Reuse the same branch for a series of related changes" sounds productive | PROJECT.md explicitly out-of-scope: "Shared workspace across multi-turn tasks — breaks one-container-per-task isolation invariant." Two tasks in the same worktree create ordering dependencies and make the verifier's diff ambiguous. | Each REPL task gets its own worktree + branch. "Now add tests for that" creates a second branch from the first one's HEAD if the first was merged, or from main if not. |
| Exploration tasks that write code as a side-effect | "Analyze and then fix the CI failures you find" is appealing — one step instead of two | Mixing read and write in the same session makes the scope contract ambiguous. The verifier cannot determine what changes are in-scope. The LLM Judge has no clear criterion. The trust model requires human review of changes, which presupposes the scope was declared upfront. | Exploration returns a report. User reads the report, then issues a separate code-change task with a specific instruction drawn from the report. |
| Auto-cleanup of worktree branches after PR merge | "I shouldn't have to think about branch cleanup at all" | Auto-detecting a merged PR requires polling the GitHub API or listening to webhooks — infrastructure that does not exist in this project and is explicitly out-of-scope (no queue/webhook triggers). Silent deletion of branches could surprise users who expected them to persist. | Worktree directory and agent-local metadata are cleaned after task completion. The remote branch's lifecycle follows normal GitHub PR merge + delete workflow (automated or manual per repo settings). |
| Exploration tasks that modify `.github/workflows/` or CI config | "The agent found a CI problem — let it fix it too" | Config-only changes have their own verification routing path (lint-only), but CI config changes are especially high-risk — a bad workflow file can break all future PRs. The trust model requires human review for any config change, and exploration tasks are designed to be zero-risk. | Exploration identifies the issue and describes the fix in the report. User issues a separate generic task: "Fix the YAML syntax error in `.github/workflows/ci.yml` described in [report]." |
| Worktrees stored inside the repo directory | "Simpler path management if worktrees live in a subdirectory of the repo" | Placing worktrees inside the repo means they appear as untracked directories in `git status`, confuse file-based search tools (Glob/Grep would traverse them), and risk being accidentally committed. | Sibling directory pattern: `<repo>-worktrees/<slug>`. Standard convention used across the ecosystem. Entirely outside the repo directory. |

---

## Feature Dependencies

```
Git Worktree Isolation
    └──requires──> Worktree lifecycle manager (new: create, track, cleanup)
    └──requires──> Branch name generation with UUID suffix (extend existing)
    └──requires──> Docker mount path targets worktree dir (change to ClaudeCodeSession)
    └──requires──> Worktree cleanup in RetryOrchestrator result path (finally block)
    └──enhances──> Concurrent execution (multiple simultaneous sessions without conflict)

Worktree Lifecycle Manager
    └──requires──> git worktree add / remove / prune (host-side git, already established)
    └──requires──> Active worktree tracking (module-level set or map)
    └──enables──>  SIGINT cleanup handler (register once at startup)

Repo Exploration Tasks
    └──requires──> New `explore` taskType in intent parser
    └──requires──> buildExplorePrompt (new prompts module function)
    └──requires──> Exploration subtype routing (git-strategy | ci-checks | project-structure)
    └──requires──> Report output path in runAgent() (bypass verifier + PR creation)
    └──uses──>     Existing Docker isolation (same container, no network)
    └──uses──>     Existing SessionCallbacks (report text posted via onMessage)

Tech Debt Cleanup
    └──touches──>  Exit code switch (CLI status mapping)
    └──touches──>  SessionTimeoutError dead code removal
    └──touches──>  retry.ts configOnly path (bypasses retryConfig.verifier)
    └──touches──>  Slack dead code (buildIntentBlocks, buildStatusMessage)
    └──touches──>  Slack multi-turn history population

Git Worktree Isolation ──independent──> Repo Exploration Tasks
    (separate feature areas, no ordering dependency between them)

Git Worktree Isolation ──does NOT conflict──> Existing single-run flows
    (worktree is created + cleaned per run; REPL single-task UX unchanged)
```

### Dependency Notes

- **Worktree isolation depends on Docker mount change:** The single most load-bearing change is `ClaudeCodeSession` passing the worktree path as the bind-mount root instead of the repo root. Everything else (cleanup, naming) is orchestration around this.
- **Exploration tasks are pipeline bypass:** They go through intent parsing and Docker execution, but skip the composite verifier, LLM Judge, and PR creation entirely. The routing branch is in `runAgent()` (or a sibling function). This is the cleanest implementation boundary.
- **Tech debt cleanup is independent:** None of the tech debt items block or are blocked by the two feature areas. They can be done in any phase or interleaved.
- **Worktree cleanup in finally block is critical:** If cleanup is only in the success path, failure or cancellation leaves orphaned worktrees. The `RetryOrchestrator` result handling path must wrap worktree cleanup in a `finally` block.

---

## MVP Definition

### Launch With (v2.4)

Minimum for this milestone to deliver value end-to-end.

- [ ] **Worktree lifecycle manager** — `createWorktree(repoPath, branchName): worktreePath`, `removeWorktree(worktreePath)`, `pruneWorktrees(repoPath)`. Required as the foundation for all isolation work.
- [ ] **Docker mount uses worktree path** — `ClaudeCodeSession` bind-mounts the worktree directory, not the repo root. Required to actually achieve file isolation.
- [ ] **Worktree cleanup in finally block** — Post-task cleanup (success, failure, veto, zero-diff, cancelled) ensures no orphans. Required for the feature to be production-usable.
- [ ] **Sibling directory naming with UUID suffix** — `<repo>-worktrees/<slug>-<uuid>`. Required for concurrent runs without path collisions.
- [ ] **Exploration taskType in intent parser** — Parse "explore", "investigate", "analyze", "check the CI", "what is the branching strategy" into `explore` taskType with subtype. Required for the new task category to be reachable.
- [ ] **buildExplorePrompt with subtype routing** — Structured prompt per exploration subtype. Required for useful report output.
- [ ] **Report output path in runAgent()** — Skip verifier + PR, return report string. Display via `onMessage` callback. Required for end-to-end completion.
- [ ] **Tech debt: exit code switch explicit cases** — `vetoed`, `turn_limit`, `cancelled` as explicit cases in status mapping. Required as stated tech debt item.

### Add After Validation (v2.4.x)

- [ ] **SIGINT cleanup handler** — Register once at startup, prune known worktrees on process exit. Trigger: orphaned worktrees observed in real usage.
- [ ] **Worktree branch shown at confirm step** — Display the branch name being created in the confirm UI. Trigger: user feedback that they couldn't predict the branch name.

### Future Consideration (v2.5+)

- [ ] **Exploration subtype: security scan** — Analyze package.json/pom.xml for known vulnerable deps without making changes. Higher complexity (needs a defined vulnerability data source). Defer until basic subtypes are validated.
- [ ] **Exploration results stored in session history for follow-up referencing** — "Based on the CI report, fix the flaky test" as a follow-up. Requires storing report text in `TaskHistoryEntry`. Trigger: exploration → action workflow becoming common.
- [ ] **Parallel agent execution orchestration** — Expose concurrent runs as a first-class feature (queue multiple tasks, run in parallel worktrees). Requires a task queue, concurrency limits, and a status display. Worktree isolation is the prerequisite; orchestration is the follow-on.

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Worktree lifecycle manager | HIGH | LOW | P1 |
| Docker mount uses worktree path | HIGH | LOW | P1 |
| Worktree cleanup in finally block | HIGH | LOW | P1 |
| Sibling directory naming + UUID | HIGH | LOW | P1 |
| Exploration taskType + intent parsing | HIGH | MEDIUM | P1 |
| buildExplorePrompt (3 subtypes) | HIGH | MEDIUM | P1 |
| Report output path (bypass verifier/PR) | HIGH | LOW | P1 |
| Tech debt: exit code switch | MEDIUM | LOW | P1 |
| Tech debt: dead code removal | LOW | LOW | P1 |
| SIGINT cleanup handler | MEDIUM | LOW | P2 |
| Branch name shown at confirm step | MEDIUM | LOW | P2 |
| Exploration → follow-up referencing | MEDIUM | MEDIUM | P3 |
| Parallel execution orchestration | HIGH | HIGH | P3 |

**Priority key:**
- P1: Required for v2.4 milestone
- P2: Add after P1 validated in real usage
- P3: Future milestone

---

## Interaction Pattern Reference

### Worktree Isolation — What Changes (Internal, Not User-Facing)

```
Before (v2.3):
  runAgent(repoPath: /home/user/my-api, branch: rename-fetchuser)
    └──> Docker bind-mount: /home/user/my-api → /repo
    └──> Agent edits /repo/src/... (directly on main checkout)
    └──> git commit + push (host-side)

After (v2.4):
  runAgent(repoPath: /home/user/my-api, branch: rename-fetchuser-a3f7)
    └──> git worktree add /home/user/my-api-worktrees/rename-fetchuser-a3f7 -b rename-fetchuser-a3f7
    └──> Docker bind-mount: /home/user/my-api-worktrees/rename-fetchuser-a3f7 → /repo
    └──> Agent edits /repo/src/... (on isolated worktree)
    └──> git commit + push (host-side, from worktree path)
    └──> [finally] git worktree remove /home/user/my-api-worktrees/rename-fetchuser-a3f7
```

User-visible change: concurrent REPL tasks no longer block on each other. The branch name includes a short UUID suffix. Otherwise UX is identical.

### Exploration Tasks — Expected Interaction Pattern

```
REPL:
  > what is the branching strategy for my-api?

  Parsed Intent:
    Task:     explore
    Subtype:  git-strategy
    Project:  my-api

  Proceed? [Y/n] y

  Investigating... (read-only, no changes will be made)

  ## Git Branching Strategy — my-api

  **Model:** Trunk-based development with short-lived feature branches.
  **Default branch:** main
  **Branch naming:** feature/<ticket-id>-<slug>, hotfix/<slug>
  **PR workflow:** All changes via PR, squash merge preferred (observed in 80% of recent merges).
  **Commit conventions:** Conventional Commits enforced by commitlint (found in package.json scripts).
  **Branch protection:** main is protected (inferred from no direct pushes in git log).

  ---

Slack:
  User: @coding-agent check the CI for my-api
  Bot (thread): Task: explore / ci-checks / my-api  [Proceed] [Cancel]
  User: [Proceed]
  Bot (thread): Investigating... (read-only)
  Bot (thread): [Formatted CI report as thread message]
```

Key behaviors:
- No confirm-and-wait for result — exploration is read-only so the confirm step can be lightweight
- No PR link posted — the output IS the result, rendered inline
- "Investigating..." progress indicator to signal read-only mode (distinct from "Running..." for code tasks)
- Report is markdown, rendered in terminal via REPL or as Slack message blocks

---

## Sources

- Git official docs: [git-worktree](https://git-scm.com/docs/git-worktree) — HIGH confidence; `git worktree add/remove/prune` semantics, shared `.git` object store behavior
- BSWEN blog: [Worktree Isolation in AI Agents](https://docs.bswen.com/blog/2026-03-18-ai-agent-worktree-isolation/) — MEDIUM confidence; one-task-one-worktree-one-agent pattern, concurrent execution
- Upsun Developer Center: [Git worktrees for parallel AI coding agents](https://devcenter.upsun.com/posts/git-worktrees-for-parallel-ai-coding-agents/) — MEDIUM confidence; sibling directory naming, Docker bind-mount interaction
- Nick Mitchinson: [Git Worktrees for Multi-Feature Development with AI Agents](https://www.nrmitchi.com/2025/10/using-git-worktrees-for-multi-feature-development-with-ai-agents/) — MEDIUM confidence; branch-per-task, naming conventions
- Penligent: [Git Worktrees Need Runtime Isolation](https://www.penligent.ai/hackinglabs/git-worktrees-need-runtime-isolation-for-parallel-ai-agent-development/) — MEDIUM confidence; shared `.git` pitfall, silent fallback failure mode
- Jon Roosevelt: [Git Worktrees Ate My Edits](https://jonroosevelt.com/blog/git-worktrees-broke-dedicated-machines-fixed-it) — MEDIUM confidence; worktree error → main checkout fallback pitfall
- Paperclip RFC: [Adapter-level worktree isolation](https://github.com/paperclipai/paperclip/issues/175) — MEDIUM confidence; adapter-level creation pattern, path naming `<project>-worktrees/<slug>`
- GitHub Blog: [Automate repository tasks with GitHub Agentic Workflows](https://github.blog/ai-and-ml/automate-repository-tasks-with-github-agentic-workflows/) — MEDIUM confidence; CI analysis, branching strategy, project structure as canonical exploration task subtypes
- Anthropic: [Claude Code common workflows](https://code.claude.com/docs/en/common-workflows) — MEDIUM confidence; worktree cleanup pattern (no changes → auto-remove branch + worktree)
- Project memory: `project_repo_exploration_tasks.md` — HIGH confidence; directly from prior project decisions, read-only investigative tasks returning reports

---

*Feature research for: git worktree isolation, repo exploration tasks, tech debt cleanup (background-coding-agent v2.4)*
*Researched: 2026-04-05*
