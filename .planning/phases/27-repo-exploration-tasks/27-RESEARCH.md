# Phase 27: Repo Exploration Tasks - Research

**Researched:** 2026-04-06
**Domain:** TypeScript/Node.js — intent parsing, Claude Agent SDK hooks, Docker read-only mounts, REPL/Slack display
**Confidence:** HIGH

## Summary

Phase 27 adds a 4th task type (`investigation`) that routes user phrasing like "explore the branching strategy" or "check the CI setup" through a read-only execution path. The agent produces a markdown report via `finalResponse` and the pipeline skips verification, LLM Judge, and PR creation entirely.

The implementation is a set of coordinated additions to well-understood seams: intent detection (fast-path.ts + llm-parser.ts + types.ts), prompt building (prompts/index.ts + new prompts/exploration.ts), Docker mount mode (docker/index.ts line 79: `:rw` → `:ro`), PreToolUse hook blocking (claude-code-session.ts), orchestration bypass (agent/index.ts), and display (repl/session.ts + slack/adapter.ts). No new infrastructure is required — every insertion point already exists and has established conventions.

The primary risk is the `zero_diff` short-circuit in `RetryOrchestrator.run()`: for read-only sessions there will never be a diff, and the current code surfaces `zero_diff` as a distinct final status. Exploration tasks must either bypass the retry orchestrator entirely (run a bare `ClaudeCodeSession` directly from `runAgent()`) or the zero-diff check must be gated on task type before it fires.

**Primary recommendation:** Run exploration tasks as a single bare `ClaudeCodeSession.run()` call inside `runAgent()`, bypassing `RetryOrchestrator` entirely. Return a new `finalStatus: 'report'` (or reuse `'success'`) that signals the caller to display `finalResponse` as the report. This avoids zero-diff logic, verifier, judge, and retry loop with no special-casing inside those classes.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Dual detection: fast-path regex patterns + LLM fallback (same approach as dependency updates)
- EXPLORATION_PATTERNS regex list matching verbs like "explore", "investigate", "analyze", "check the CI", "branching strategy", etc.
- Exploration-first heuristic: if input contains read verbs (explore/investigate/analyze/check) and NO action verbs (update/fix/add/remove), classify as investigation
- LLM parser handles ambiguous cases that fast-path can't resolve
- Routes to `investigation` task type (4th type alongside npm-dependency-update, maven-dependency-update, generic)
- 4 subtypes: git-strategy, ci-checks, project-structure, general (fallback)
- Auto-detect subtype from user phrasing
- Registry pattern for extensibility: each subtype is a config object (name, keywords, prompt template)
- Common base prompt + subtype-specific FOCUS section injected
- Base preamble: read-only constraints, structured markdown report output, no code changes
- End-state prompting discipline applies
- Agent's finalResponse IS the report — no post-processing or structured JSON extraction
- REPL: print full report inline to stdout
- Slack: single thread message with full markdown report
- File output: host-side code writes finalResponse to `.reports/` directory when user asks — agent never writes files
- Docker workspace mounted as `:ro` — OS-level enforcement
- PreToolUse hook blocks Write and Edit tools entirely with "blocked: read-only session" message
- No Bash command blocklist needed — `:ro` mount handles it at OS level
- Investigation tasks skip: composite verifier, LLM Judge, PR creation
- `zero_diff` result must not surface as failure — task-type-aware result rendering
- Exploration tasks do NOT create worktrees — use `:ro` Docker mount from Phase 26 infrastructure only
- No retry loop needed — exploration either produces a report or fails

### Claude's Discretion
- Whether "general" fallback exploration uses a guided checklist or is fully open-ended
- Exact regex patterns for EXPLORATION_PATTERNS
- Error handling when agent produces no useful report
- Exact markdown structure of report per subtype

### Deferred Ideas (OUT OF SCOPE)
- EXPLR-06: Security scan subtype (analyze dependencies for known vulnerabilities) — deferred to v2.5+
- EXPLR-07: Exploration results stored in session history for follow-up referencing — deferred to v2.5+
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| EXPLR-01 | Intent parser recognizes exploration intents and routes to `investigation` task type | fast-path EXPLORATION_PATTERNS + LLM schema extension; established dual-detection pattern in fast-path.ts |
| EXPLR-02 | Structured exploration prompts with 3 subtypes: git-strategy, ci-checks, project-structure | New `buildExplorationPrompt()` in prompts/exploration.ts; registry pattern with subtype config objects |
| EXPLR-03 | Exploration tasks skip composite verifier, LLM Judge, and PR creation — return report via finalResponse | Bypass in `runAgent()` before `RetryOrchestrator` instantiation; `finalResponse` already on `SessionResult` |
| EXPLR-04 | PreToolUse hook blocks Write/Edit/destructive-Bash tools when session is read-only | `buildPreToolUseHook()` in claude-code-session.ts already has the hook architecture; add `readOnly` mode |
| EXPLR-05 | Exploration report displayed inline in REPL and posted as thread message in Slack | `processInput()` in repl/session.ts and `processSlackMention()` in slack/adapter.ts; display from `finalResponse` |
</phase_requirements>

## Standard Stack

### Core (already in project)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| TypeScript | 5.x | All source files | Project standard |
| Vitest | current | Unit tests | Project test framework (vitest.config.ts) |
| picocolors | current | Terminal color output | Already used in repl/session.ts |
| pino | current | Structured logging | Already used throughout |
| @anthropic-ai/claude-agent-sdk | current | `query()` + hook types | Already used in claude-code-session.ts |

### No New Dependencies Required
All functionality can be built using existing project dependencies. No npm installs needed for this phase.

## Architecture Patterns

### Recommended Project Structure additions

```
src/
├── intent/
│   ├── fast-path.ts          # Add EXPLORATION_PATTERNS, explorationFastPath()
│   ├── llm-parser.ts         # Add 'investigation' to TASK_TYPES enum + OUTPUT_SCHEMA
│   └── types.ts              # Add 'investigation' to TASK_TYPES array; ExplorationSubtype type
├── prompts/
│   ├── exploration.ts        # NEW: buildExplorationPrompt(), subtype registry
│   └── index.ts              # Add 'investigation' case to buildPrompt()
├── orchestrator/
│   └── claude-code-session.ts  # buildPreToolUseHook() read-only mode
├── agent/
│   └── index.ts              # Skip worktree + RetryOrchestrator for investigation type
├── repl/
│   └── session.ts            # Display finalResponse as report, optional .reports/ write
└── slack/
    └── adapter.ts            # Post finalResponse as thread message instead of status
```

### Pattern 1: Fast-Path Exploration Detection

**What:** New `explorationFastPath()` function in fast-path.ts that returns an `ExplorationFastPathResult | null` (separate from the existing `FastPathResult` which is dep-update specific).
**When to use:** Called before the existing fast-path check in `parseIntent()`. Returns quickly on read-verb matches with no action verbs.

```typescript
// Source: existing DEPENDENCY_PATTERNS pattern in src/intent/fast-path.ts
export const EXPLORATION_PATTERNS = [
  /^(?:explore|investigate|analyze|analyse|examine|inspect)\b/i,
  /\b(?:branching\s+strategy|git\s+strategy|branch\s+strategy)\b/i,
  /\b(?:check|look\s+at|show\s+me)\s+(?:the\s+)?(?:ci|cd|pipeline|workflows?)\b/i,
  /\b(?:project\s+structure|repo\s+structure|codebase\s+structure|directory\s+structure)\b/i,
  /^(?:what(?:'s|\s+is)\s+the|tell\s+me\s+about)\s+/i,
];

// Action verb guard — prevents misclassification when user ALSO wants a code change
export const ACTION_VERB_GUARD = /\b(?:update|upgrade|bump|fix|add|remove|delete|create|refactor|rename|move|replace|implement|migrate)\b/i;

export interface ExplorationFastPathResult {
  subtype: 'git-strategy' | 'ci-checks' | 'project-structure' | 'general';
}

export function explorationFastPath(input: string): ExplorationFastPathResult | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (ACTION_VERB_GUARD.test(trimmed)) return null;

  const hasExplorationVerb = EXPLORATION_PATTERNS.some(p => p.test(trimmed));
  if (!hasExplorationVerb) return null;

  // Subtype detection
  if (/\b(?:branch|git\s+strategy|branching)\b/i.test(trimmed)) return { subtype: 'git-strategy' };
  if (/\b(?:ci|cd|pipeline|workflow|github.?action)\b/i.test(trimmed)) return { subtype: 'ci-checks' };
  if (/\b(?:structure|layout|architecture|directory|folder|organization)\b/i.test(trimmed)) return { subtype: 'project-structure' };
  return { subtype: 'general' };
}
```

### Pattern 2: Subtype Registry in exploration.ts

**What:** Array of subtype config objects. Each object has `name`, `keywords[]`, and `focusSection` string. `buildExplorationPrompt()` matches subtype from fast-path result and injects the focus section.
**When to use:** Called from `buildPrompt()` when `taskType === 'investigation'`.

```typescript
// Source: mirrors buildGenericPrompt() pattern in src/prompts/generic.ts
interface ExplorationSubtype {
  name: string;
  focusSection: string;
}

const SUBTYPES: Record<string, ExplorationSubtype> = {
  'git-strategy': {
    name: 'Git Strategy',
    focusSection: `FOCUS: Git branching strategy
- What branches exist and their naming conventions (main, develop, feature/*, release/*)
- Merge vs rebase policy (look for .git/config, GitHub settings clues, recent merge commits)
- Branch protection indicators (.github/ configs, PR templates)
- Typical workflow inferred from git log --oneline --graph
Report sections: Branch Overview, Merge Strategy, Workflow Summary`,
  },
  'ci-checks': {
    name: 'CI/CD Setup',
    focusSection: `FOCUS: CI/CD pipeline configuration
- CI platform (GitHub Actions, CircleCI, Jenkins — check .github/workflows/, .circleci/, Jenkinsfile)
- Workflow triggers (push, PR, schedule, manual)
- Key jobs: build, test, lint, deploy stages
- Environment targets (staging, production)
Report sections: CI Platform, Workflow Triggers, Pipeline Stages, Deployment Targets`,
  },
  'project-structure': {
    name: 'Project Structure',
    focusSection: `FOCUS: Project layout and architecture
- Top-level directory layout and purpose of each directory
- Build system and tooling (package.json scripts, pom.xml, Makefile, etc.)
- Key entry points (main files, index files, CLI entry)
- Test organization and coverage setup
Report sections: Directory Layout, Build System, Entry Points, Test Setup`,
  },
  'general': {
    name: 'General Exploration',
    focusSection: `FOCUS: General repository overview
- Language, runtime, and primary framework
- Project purpose and key features (README, package.json description)
- Top-level structure and notable files
- Development setup (how to install and run locally)
Report sections: Project Overview, Technology Stack, Structure, Getting Started`,
  },
};

export function buildExplorationPrompt(description: string, subtype: string = 'general'): string {
  const config = SUBTYPES[subtype] ?? SUBTYPES['general'];
  return [
    `You are a read-only repository investigator. Your task: ${description}`,
    '',
    'CONSTRAINTS:',
    '- Do NOT create, edit, or delete any files',
    '- Do NOT run commands that modify state (git commit, npm install, etc.)',
    '- Use only read commands: ls, cat, git log, git branch, git status, find, grep',
    '',
    config.focusSection,
    '',
    'OUTPUT: Produce a structured markdown report with clear section headers.',
    'After your investigation, the following should be true:',
    '- Your final response IS the complete report (not a summary)',
    '- All report sections are populated with findings from the actual repo',
    '- No files have been created or modified',
    '',
    'Work in the current directory.',
  ].join('\n');
}
```

### Pattern 3: Bypass RetryOrchestrator in runAgent()

**What:** When `options.taskType === 'investigation'`, skip worktree creation, mount workspace `:ro`, run a bare `ClaudeCodeSession`, and return directly without verifier/judge/PR.
**When to use:** Inside `runAgent()` in agent/index.ts, guarded by task type check before `RetryOrchestrator` is instantiated.

```typescript
// Source: existing skipWorktree pattern in src/agent/index.ts
if (options.taskType === 'investigation') {
  // Mount :ro — enforced via DockerRunOptions.readOnly flag
  // No worktree needed — direct :ro mount of repo
  const session = new ClaudeCodeSession({
    workspaceDir: options.repo,
    turnLimit: options.turnLimit,
    timeoutMs: options.timeoutMs,
    readOnly: true,  // new flag passed to buildDockerRunArgs
  });
  await session.start();
  const sessionResult = await session.run(prompt, logger, context.signal);
  await session.stop();
  return {
    finalStatus: sessionResult.status === 'success' ? 'success' : sessionResult.status,
    attempts: 1,
    sessionResults: [sessionResult],
    verificationResults: [],
    judgeResults: [],
    finalResponse: sessionResult.finalResponse,
  };
}
// ... existing RetryOrchestrator path for all other task types
```

### Pattern 4: Docker :ro Mount

**What:** `buildDockerRunArgs()` accepts a new `readOnly?: boolean` option. When true, the `-v` workspace mount uses `:ro` instead of `:rw`.
**When to use:** Passed from `ClaudeCodeSession` when `SessionConfig.readOnly === true`.

```typescript
// Source: src/cli/docker/index.ts line 79 (current value: ':rw')
'-v', `${opts.workspaceDir}:/workspace:${opts.readOnly ? 'ro' : 'rw'}`,
```

### Pattern 5: Read-Only PreToolUse Hook

**What:** `buildPreToolUseHook()` in claude-code-session.ts receives a `readOnly: boolean` parameter. When true, it blocks all `Write` and `Edit` tool calls immediately with a clear message, before path or sensitive-file checks.
**When to use:** Threaded through from `SessionConfig.readOnly`.

```typescript
// Source: existing buildPreToolUseHook() in src/orchestrator/claude-code-session.ts
if (readOnly && (preInput.tool_name === 'Write' || preInput.tool_name === 'Edit')) {
  return {
    systemMessage: 'blocked: read-only session — this investigation task cannot modify files',
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny' as const,
      permissionDecisionReason: 'Read-only session: Write/Edit tools are disabled',
    },
  };
}
```

### Pattern 6: types.ts Extension

**What:** Add `'investigation'` to `TASK_TYPES` and export `ExplorationSubtype` type.

```typescript
// Source: src/intent/types.ts
export const TASK_TYPES = ['npm-dependency-update', 'maven-dependency-update', 'generic', 'investigation'] as const;
export type ExplorationSubtype = 'git-strategy' | 'ci-checks' | 'project-structure' | 'general';

// ResolvedIntent gets an optional explorationSubtype field:
export interface ResolvedIntent {
  // ... existing fields ...
  explorationSubtype?: ExplorationSubtype;  // populated when taskType === 'investigation'
}
```

### Pattern 7: LLM Parser Extension

**What:** Add `'investigation'` to `TASK_TYPES` enum in both the Zod schema and the `OUTPUT_SCHEMA` JSON schema. Update `INTENT_SYSTEM_PROMPT` to teach the classifier when to use the investigation type.

```typescript
// Source: src/intent/llm-parser.ts
// In OUTPUT_SCHEMA.properties.taskType.enum: add 'investigation'
// In INTENT_SYSTEM_PROMPT: add rule
// "If the user wants to learn about the repo without making changes (explore, investigate,
//  analyze, check CI, branching strategy, project structure), set taskType to 'investigation'."
```

### Pattern 8: REPL Report Display

**What:** In `processInput()`, after `runAgent()` returns, check if `taskType === 'investigation'`. If so, print `finalResponse` to stdout. Optionally write to `.reports/` if user said "save" in their original input.

```typescript
// Source: existing result handling in src/repl/session.ts processInput()
if (confirmed.taskType === 'investigation' && result.sessionResults.at(-1)?.finalResponse) {
  const report = result.sessionResults.at(-1)!.finalResponse;
  console.log('\n' + report + '\n');
  // Optional: host-side file write when user said "save"
  if (/\bsave\b/i.test(trimmed)) {
    // write report to .reports/<timestamp>-<subtype>.md
  }
}
```

### Anti-Patterns to Avoid

- **Running RetryOrchestrator for investigation tasks:** The zero-diff check fires before verification and returns `zero_diff` — which is technically correct (no diff) but misleading for exploration tasks. Bypass the orchestrator entirely rather than adding type guards inside it.
- **Using the existing `buildPreToolUseHook` with workspace path check:** The `:ro` Docker mount already prevents writes at OS level. The PreToolUse hook adds fast feedback to the agent. Don't try to derive read-only status from the mount mode at hook construction time — pass an explicit `readOnly` flag.
- **Adding investigation subtype to `TaskCategory`:** `TaskCategory` is for generic task subcategorization (code-change, config-edit, refactor). Exploration subtypes are a separate concept — keep them in a new `ExplorationSubtype` type on `ResolvedIntent`.
- **Posting `zero_diff` to Slack as failure:** The Slack adapter's `statusMessages` map treats `zero_diff` as "no changes". For exploration tasks this is accurate but should never reach that map — return before it.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Read-only workspace enforcement | Custom bash command blocklist | Docker `:ro` mount (OS level) + PreToolUse hook (agent feedback) | Blocklist has holes; `:ro` mount is OS-enforced and unchallengeable |
| Report formatting | Custom markdown renderer | Agent produces markdown directly via prompt instruction | The SDK already handles finalResponse extraction; no parsing needed |
| Subtype keyword matching at LLM level | Separate classifier API call | Fast-path keyword detection first, LLM fallback for ambiguous cases | Existing dual-detection pattern is proven and avoids extra latency |

## Common Pitfalls

### Pitfall 1: zero_diff surfaces as failure for exploration
**What goes wrong:** `RetryOrchestrator.run()` checks `getWorkspaceDiff()` after every session. A read-only session always has zero diff, so this returns `finalStatus: 'zero_diff'`. The REPL's history status maps this as `'zero_diff'`, which the existing `toHistoryStatus()` function maps to... what? Check `repl/types.ts`.
**Why it happens:** The orchestrator assumes a diff is expected after every session success.
**How to avoid:** Bypass `RetryOrchestrator` entirely for investigation tasks. The bare `ClaudeCodeSession.run()` → `SessionResult` path never hits `getWorkspaceDiff()`.
**Warning signs:** If you see `zero_diff` in exploration task results, the bypass is not in place.

### Pitfall 2: LLM schema change breaks existing callers
**What goes wrong:** Adding `'investigation'` to `TASK_TYPES` array changes the Zod enum, which affects `IntentSchema.parse()`. If `llmParse()` returns `investigation` for a query that existing callers don't handle, they may error at the `switch (taskType)` in `buildPrompt()`.
**Why it happens:** The `default:` fallback in `buildPrompt()` exists but produces a generic message, not a proper investigation prompt.
**How to avoid:** Add `case 'investigation':` to `buildPrompt()` before releasing the schema change. Keep changes to types.ts and llm-parser.ts in the same commit as the prompt builder change.
**Warning signs:** TypeScript compilation errors at `buildPrompt()` switch exhaustiveness check when `investigation` is added to TASK_TYPES but not handled.

### Pitfall 3: Hook receives tool_name check for Bash (destructive commands)
**What goes wrong:** CONTEXT.md says "No Bash command blocklist/allowlist needed — `:ro` mount handles it at OS level." But the Bash tool does not carry a `file_path` parameter, so the existing path-check hook already skips it (line 52: `if (!rawPath) return {};`). The read-only PreToolUse hook only needs to block `Write` and `Edit` — not Bash.
**Why it happens:** Confusion between "blocking file writes" and "blocking Bash commands."
**How to avoid:** In the read-only hook extension, match only on `tool_name === 'Write' || tool_name === 'Edit'`. Trust the `:ro` mount for everything else. This is exactly what CONTEXT.md prescribes.
**Warning signs:** Over-engineering the hook to inspect Bash command strings.

### Pitfall 4: Slack's `intent.createPr = true` forced assignment
**What goes wrong:** In `processSlackMention()` line 141, `intent.createPr = true` is unconditionally set. If investigation reaches Slack, the PR flag is meaninglessly set to true but `runAgent()` bypasses PR creation. This is harmless but confusing.
**Why it happens:** The Slack adapter forces PR creation for all tasks.
**How to avoid:** Add a guard: `if (confirmed.taskType !== 'investigation') { intent.createPr = true; }`. Keep the existing Slack behavior for all other task types.
**Warning signs:** PR creation attempted for exploration tasks in Slack (would fail silently since `runAgent()` bypasses it, but the intent object is misleading).

### Pitfall 5: Session history records investigation tasks incorrectly
**What goes wrong:** `appendHistory()` always records `taskType` from the confirmed intent. For exploration tasks, `dep` and `version` are null, which is fine. But if the `status` is mapped from `finalStatus`, and the exploration session returns `'success'` from `sessionResult.status`, but the `finalStatus` on `RetryResult` is `'success'`, the history entry is correctly `'success'`.
**Why it happens:** Not a real pitfall if the bypass returns `finalStatus: 'success'` on session success.
**How to avoid:** Ensure the exploration bypass path on `runAgent()` returns `finalStatus: 'success'` when `sessionResult.status === 'success'`, and the normal failed/cancelled statuses otherwise.

## Code Examples

Verified patterns from the existing codebase:

### Existing PreToolUse hook architecture (add read-only block at top)
```typescript
// Source: src/orchestrator/claude-code-session.ts buildPreToolUseHook()
return async (input, toolUseId) => {
  const preInput = input as PreToolUseHookInput;
  // NEW: Read-only session block (before path checks)
  if (readOnly && (preInput.tool_name === 'Write' || preInput.tool_name === 'Edit')) {
    return {
      systemMessage: 'blocked: read-only session — this investigation task cannot modify files',
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny' as const,
        permissionDecisionReason: 'Read-only session',
      },
    };
  }
  // ... existing path and sensitive-file checks follow
```

### SDK hooks registration pattern (for investigation — only PostToolUse, no Write/Edit hooks needed)
```typescript
// Source: src/orchestrator/claude-code-session.ts query() options
hooks: readOnly
  ? {
      PreToolUse: [{ matcher: 'Write|Edit', hooks: [preHook] }],  // blocks all write attempts
      PostToolUse: [],  // no write audit needed
    }
  : {
      PreToolUse: [{ matcher: 'Write|Edit', hooks: [preHook] }],
      PostToolUse: [{ matcher: 'Write|Edit|mcp__verifier__verify', hooks: [postHook] }],
    },
```

### SessionConfig extension
```typescript
// Source: src/types.ts SessionConfig interface
export interface SessionConfig {
  workspaceDir: string;
  model?: string;
  turnLimit?: number;
  timeoutMs?: number;
  logger?: pino.Logger;
  signal?: AbortSignal;
  readOnly?: boolean;  // NEW: mount workspace :ro, block Write/Edit via hook
}
```

### DockerRunOptions extension
```typescript
// Source: src/cli/docker/index.ts DockerRunOptions interface
export interface DockerRunOptions {
  workspaceDir: string;
  apiKey: string;
  sessionId: string;
  networkName?: string;
  imageTag?: string;
  readOnly?: boolean;  // NEW: switches workspace mount from :rw to :ro
}
// In buildDockerRunArgs(): change line 79:
'-v', `${opts.workspaceDir}:/workspace:${opts.readOnly ? 'ro' : 'rw'}`,
```

### AgentOptions extension
```typescript
// Source: src/agent/index.ts AgentOptions interface
export interface AgentOptions {
  // ... existing fields ...
  explorationSubtype?: string;  // NEW: 'git-strategy' | 'ci-checks' | 'project-structure' | 'general'
}
```

### parseIntent() — exploration fast-path insertion point
```typescript
// Source: src/intent/index.ts parseIntent() — add before existing fastResult check
const explorationResult = explorationFastPath(input);
if (explorationResult) {
  return {
    taskType: 'investigation',
    repo: repoPath,
    dep: null,
    version: null,
    confidence: 'high',
    explorationSubtype: explorationResult.subtype,
    scopingQuestions: [],
  };
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Direct repo mount `:rw` | Exploration gets `:ro` | Phase 27 | OS-level write prevention |
| 3 task types (npm, maven, generic) | 4 task types + investigation | Phase 27 | New intent routing branch |
| All tasks run RetryOrchestrator | Investigation bypasses it | Phase 27 | No zero_diff false failure |

**No deprecated patterns to replace in this phase.**

## Open Questions

1. **Should `finalStatus: 'report'` be a new value on `RetryResult.finalStatus`?**
   - What we know: Current union is `'success' | 'failed' | 'timeout' | 'turn_limit' | 'max_retries_exhausted' | 'vetoed' | 'cancelled' | 'zero_diff'`. TypeScript enforces exhaustiveness at switch sites (`mapStatusToExitCode`, `toHistoryStatus`, etc.).
   - What's unclear: Adding `'report'` requires touching every switch statement. Reusing `'success'` avoids this but obscures intent.
   - Recommendation: Reuse `'success'` for exploration tasks. The distinction from regular success is that `explorationSubtype` is set on the original intent. This avoids touching `mapStatusToExitCode`, `toHistoryStatus`, and Slack's `statusMessages` map.

2. **Should investigation skip the confirm step in REPL?**
   - What we know: The confirm step exists to prevent accidental code changes. Exploration tasks cannot change code.
   - What's unclear: Skipping confirm makes exploration faster but deviates from the established UX pattern.
   - Recommendation: Keep the confirm step for consistency. The confirm display should show `taskType: investigation` and `subtype: git-strategy` (etc.) so the user knows what's coming.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest (vitest.config.ts) |
| Config file | vitest.config.ts (minimal — excludes dist, node_modules) |
| Quick run command | `npx vitest run src/intent/fast-path.test.ts` |
| Full suite command | `npx vitest run` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| EXPLR-01 | `explorationFastPath("explore the branching strategy")` returns `{subtype:'git-strategy'}` | unit | `npx vitest run src/intent/fast-path.test.ts` | ❌ Wave 0 |
| EXPLR-01 | `explorationFastPath("update lodash")` returns null (action verb guard) | unit | `npx vitest run src/intent/fast-path.test.ts` | ❌ Wave 0 |
| EXPLR-01 | `explorationFastPath("check the CI setup")` returns `{subtype:'ci-checks'}` | unit | `npx vitest run src/intent/fast-path.test.ts` | ❌ Wave 0 |
| EXPLR-01 | `parseIntent("explore the branching strategy")` resolves to `taskType:'investigation'` | unit | `npx vitest run src/intent/index.test.ts` | ✅ (add cases) |
| EXPLR-02 | `buildExplorationPrompt("explore CI", "ci-checks")` contains FOCUS and CONSTRAINTS sections | unit | `npx vitest run src/prompts/exploration.test.ts` | ❌ Wave 0 |
| EXPLR-02 | `buildPrompt({taskType:'investigation', description:'...', explorationSubtype:'git-strategy'})` dispatches correctly | unit | `npx vitest run src/prompts/index.test.ts` | ❌ Wave 0 (or add to existing) |
| EXPLR-03 | `runAgent({taskType:'investigation',...})` does not call `RetryOrchestrator`, calls `ClaudeCodeSession` directly | unit | `npx vitest run src/agent/index.test.ts` | ✅ (add cases) |
| EXPLR-03 | `runAgent({taskType:'investigation',...})` does not call `compositeVerifier` or `llmJudge` | unit | `npx vitest run src/agent/index.test.ts` | ✅ (add cases) |
| EXPLR-03 | `runAgent({taskType:'investigation',...})` does not call `WorktreeManager.create()` | unit | `npx vitest run src/agent/index.test.ts` | ✅ (add cases) |
| EXPLR-04 | `buildPreToolUseHook(workspaceDir, logger, true)` blocks Write tool | unit | `npx vitest run src/orchestrator/claude-code-session.test.ts` | ✅ (add cases) |
| EXPLR-04 | `buildPreToolUseHook(workspaceDir, logger, true)` blocks Edit tool | unit | `npx vitest run src/orchestrator/claude-code-session.test.ts` | ✅ (add cases) |
| EXPLR-04 | `buildDockerRunArgs({..., readOnly:true},...)` produces `:ro` mount | unit | `npx vitest run src/cli/docker/index.test.ts` | ✅ (add cases) |
| EXPLR-05 | `processInput("explore the CI", ...)` prints report to stdout when taskType is investigation | unit | `npx vitest run src/repl/session.test.ts` | ✅ (add cases) |
| EXPLR-05 | `processSlackMention(...)` posts `finalResponse` as thread message for investigation tasks | unit | `npx vitest run src/slack/adapter.test.ts` | ✅ (add cases) |

### Sampling Rate
- **Per task commit:** `npx vitest run src/intent/fast-path.test.ts src/prompts/exploration.test.ts`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/intent/fast-path.test.ts` — add `explorationFastPath()` test cases (file exists; add describe block)
- [ ] `src/prompts/exploration.test.ts` — new file, covers `buildExplorationPrompt()` for all 4 subtypes
- [ ] `src/prompts/index.test.ts` — add investigation dispatch case (file may not exist; check if tests are inline)

## Sources

### Primary (HIGH confidence)
- Source code direct inspection: `src/intent/fast-path.ts`, `src/intent/types.ts`, `src/intent/llm-parser.ts`, `src/intent/index.ts` — TASK_TYPES enum, fastPathParse pattern, llmParse schema
- Source code direct inspection: `src/orchestrator/claude-code-session.ts` — `buildPreToolUseHook()` architecture, hook registration via SDK `query()` options
- Source code direct inspection: `src/cli/docker/index.ts` — `buildDockerRunArgs()`, current `:rw` mount on line 79
- Source code direct inspection: `src/agent/index.ts` — `runAgent()` orchestration flow, `skipWorktree` pattern, `RetryOrchestrator` instantiation
- Source code direct inspection: `src/repl/session.ts` — `processInput()` flow, `appendHistory()`, display patterns
- Source code direct inspection: `src/slack/adapter.ts` — `processSlackMention()`, forced `createPr = true`, thread message posting
- Source code direct inspection: `src/prompts/generic.ts` — base + section injection pattern to mirror in exploration.ts
- Source code direct inspection: `.planning/phases/27-repo-exploration-tasks/27-CONTEXT.md` — all locked decisions

### Secondary (MEDIUM confidence)
- `src/orchestrator/retry.ts` — zero_diff logic confirmed: `getWorkspaceDiff()` check at line 215-224 fires before verifier, returns `finalStatus: 'zero_diff'` immediately
- `src/types.ts` — `RetryResult.finalStatus` union confirmed: no `'report'` type exists; reusing `'success'` is the lower-impact path

### Tertiary (LOW confidence)
- None — all findings sourced directly from project files

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries confirmed in existing codebase
- Architecture: HIGH — all integration points verified by reading source files
- Pitfalls: HIGH — zero_diff path confirmed by reading RetryOrchestrator.run() source; other pitfalls confirmed by reading Slack adapter and hook source

**Research date:** 2026-04-06
**Valid until:** 2026-05-06 (stable TypeScript codebase, no external API changes needed)
