# Phase 10: Agent SDK Integration - Research

**Researched:** 2026-03-17
**Domain:** @anthropic-ai/claude-agent-sdk — query(), hooks (PreToolUse/PostToolUse), SDKResultMessage, ClaudeCodeSession wrapper design
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Coexistence strategy**
- Side-by-side with `--use-sdk` CLI flag (Commander.js boolean option on `run` command)
- Default: `true` (SDK path is primary; `--no-use-sdk` falls back to legacy AgentSession)
- RetryOrchestrator instantiates ClaudeCodeSession or AgentSession based on flag
- Both paths must have passing test suites — existing AgentSession tests untouched, new ClaudeCodeSession gets its own test suite
- Phase 11 removes the flag and legacy path

**Security hook design**
- PreToolUse hook: Repo-scoped + deny list — block writes outside repo path, block .env, .git/, and secrets file patterns
- Block behavior: Return tool error message to agent explaining why blocked + log as security audit event. Agent sees rejection and can adjust.
- Bash access: Trust SDK's `acceptEdits` permission model — no command allowlist in hook. Agent gets full Bash capability (npm, mvn, tsc, etc.)
- Turn counting: Blocked tool attempts count toward maxTurns — prevents unbounded blocked-call loops

**Error & status mapping**
- ClaudeCodeSession returns the exact same `SessionResult` interface (sessionId, status, toolCallCount, duration, finalResponse, error)
- SDK-specific data (cost, tokens) logged via Pino but NOT added to SessionResult — RetryOrchestrator unchanged
- `maxTurns` exhaustion maps to `'turn_limit'` status (terminal, no retry) — same as v1
- API error retry delegated entirely to SDK's built-in 429/529 handling — no custom retry wrapper. SDK gives up → `'failed'` status
- `maxBudgetUsd` set with a sensible default per session (researcher to determine appropriate value). SDK-09 requirement.

**Audit trail format**
- PostToolUse hook captures: file path, tool name (Edit/Write), ISO timestamp
- Only file mutations logged as audit events (Edit, Write) — not reads/searches
- Blocked tool attempts (from PreToolUse) also logged as security audit events with path, tool, reason, timestamp
- All audit events go inline with existing Pino structured JSON logger, tagged with `type: 'audit'`
- No separate audit file — single log stream

### Claude's Discretion
- Exact ClaudeCodeSession class structure and internal implementation
- How SDK query() options are configured (model, systemPrompt construction)
- Default value for maxBudgetUsd (determine during research)
- How to extract toolCallCount and duration from SDK response
- How to test-mock SDK query() calls

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| SDK-01 | Agent sessions use Claude Agent SDK `query()` instead of custom AgentSession/AgentClient | query() API confirmed; ClaudeCodeSession wrapper pattern documented |
| SDK-02 | Built-in tools (Read, Write, Edit, Bash, Glob, Grep) replace all 6 hand-built tools | Built-in tools confirmed in SDK docs; no custom tool registration needed |
| SDK-03 | Permission mode `acceptEdits` auto-approves file operations without manual interception | `permissionMode: 'acceptEdits'` confirmed in PermissionMode type |
| SDK-04 | `disallowedTools` blocks WebSearch/WebFetch in sandbox runs | `disallowedTools: ['WebSearch', 'WebFetch']` confirmed; deny rules override everything |
| SDK-05 | `maxTurns` option replaces manual turn counter | `maxTurns: number` confirmed in Options type |
| SDK-06 | `systemPrompt` option replaces custom prompt construction | `systemPrompt: string` confirmed; can pass existing prompt builder output |
| SDK-07 | PostToolUse hook logs every file change (Edit/Write) to audit trail | PostToolUse hook + `matcher: 'Edit\|Write'` pattern confirmed with code examples |
| SDK-08 | PreToolUse hook blocks writes outside repo path and to sensitive files (.env, .git) | PreToolUse `permissionDecision: 'deny'` + `systemMessage` pattern confirmed |
| SDK-09 | `maxBudgetUsd` caps session cost as a hard USD limit | `maxBudgetUsd: number` confirmed in Options; exhaustion → `error_max_budget_usd` subtype |
| SDK-10 | `ClaudeCodeSession` wrapper returns `SessionResult` compatible with RetryOrchestrator interface | SDKResultMessage fields map to SessionResult fields; toolCallCount from turn counting in hook; duration from timing |
</phase_requirements>

---

## Summary

Phase 10 replaces the custom `AgentSession` + `AgentClient` + Docker infrastructure with `@anthropic-ai/claude-agent-sdk` version `0.2.77`. The SDK's `query()` function is an async generator that streams `SDKMessage` events; the final `SDKResultMessage` carries `session_id`, `duration_ms`, `num_turns`, `result` (final text), `total_cost_usd`, and a `subtype` field (`'success'` | `'error_max_turns'` | `'error_during_execution'` | `'error_max_budget_usd'`) that maps cleanly onto the existing `SessionResult` interface.

Security is enforced via two hooks on `query()`: a `PreToolUse` hook with matcher `"Write|Edit"` checks file paths against the repo root and a deny-list of sensitive patterns; a `PostToolUse` hook with the same matcher logs every file mutation as a structured Pino audit event. The SDK's `disallowedTools` option blocks `WebSearch` and `WebFetch` at the API level — no hook needed for that. `permissionMode: 'acceptEdits'` auto-approves file writes so the agent is non-interactive.

The `ClaudeCodeSession` class wraps `query()`, counts tool calls by incrementing a counter in the `PostToolUse` hook, captures timing via `Date.now()`, and returns the same `SessionResult` interface that `RetryOrchestrator` already consumes — making the swap nearly invisible to the outer orchestration layer.

**Primary recommendation:** Implement `ClaudeCodeSession` as a ~60-line wrapper around `query()`. Wire it into `RetryOrchestrator` behind a `useSDK: boolean` flag in `SessionConfig`. Add a `--use-sdk` flag (defaulting to `true`) on the CLI `run` command.

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| @anthropic-ai/claude-agent-sdk | 0.2.77 (latest) | Agent loop, built-in tools, hooks | The migration target; bundles Claude Code executable |
| @anthropic-ai/sdk | 0.71.2 (already installed) | LLM Judge only — keep as peer dep | Judge uses structured output; not replaced in Phase 10 |

### Supporting (unchanged)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| pino | ^10.3.0 | Structured JSON logging + audit events | All log/audit output |
| vitest | ^4.0.18 | Test framework | ClaudeCodeSession unit tests |

**Installation:**
```bash
npm install @anthropic-ai/claude-agent-sdk
```

**Version verification (confirmed 2026-03-17):**
```bash
npm view @anthropic-ai/claude-agent-sdk version
# → 0.2.77
```

**Prerequisites:** `ANTHROPIC_API_KEY` env var. The SDK bundles its own Claude Code executable — no separate `claude` CLI install required.

---

## Architecture Patterns

### Recommended Project Structure

```
src/orchestrator/
├── claude-code-session.ts   # NEW: ClaudeCodeSession wrapping query()
├── session.ts               # KEEP: AgentSession (legacy, untouched until Phase 11)
├── retry.ts                 # MODIFY: conditional ClaudeCodeSession | AgentSession
├── index.ts                 # MODIFY: export ClaudeCodeSession
src/cli/commands/
└── run.ts                   # MODIFY: add --use-sdk flag, pass useSDK to SessionConfig
```

### Pattern 1: query() Iteration for SessionResult

**What:** Iterate the async generator from `query()`, count tool events, capture the final `SDKResultMessage`, then map to `SessionResult`.
**When to use:** Every `ClaudeCodeSession.run()` call.

```typescript
// Source: https://platform.claude.com/docs/en/agent-sdk/typescript
import { query, SDKMessage, SDKResultMessage, HookCallback, PreToolUseHookInput, PostToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import * as crypto from 'crypto';

// In ClaudeCodeSession.run():
const sessionId = crypto.randomUUID();
const startTime = Date.now();
let toolCallCount = 0;
let finalResult: SDKResultMessage | undefined;

for await (const message of query({
  prompt: userMessage,
  options: {
    cwd: workspaceDir,
    systemPrompt: systemPromptString,
    maxTurns: turnLimit,          // SDK-05
    maxBudgetUsd: 2.00,           // SDK-09 (see maxBudgetUsd recommendation below)
    permissionMode: 'acceptEdits',// SDK-03
    disallowedTools: ['WebSearch', 'WebFetch'],  // SDK-04
    model: model,
    hooks: {
      PreToolUse: [{ matcher: 'Write|Edit', hooks: [preToolUseHook] }],  // SDK-08
      PostToolUse: [{ matcher: 'Write|Edit', hooks: [postToolUseHook] }], // SDK-07
    },
    settingSources: [],  // No filesystem settings imported — isolation guaranteed
  }
})) {
  if (message.type === 'result') {
    finalResult = message as SDKResultMessage;
  }
}

const duration = Date.now() - startTime;
// Map to SessionResult...
```

### Pattern 2: PreToolUse Hook — Repo-Scoped + Deny List

**What:** Block writes to files outside `workspaceDir` and to sensitive file patterns. Return `permissionDecision: 'deny'` with a human-readable reason. Also log as security audit event.
**When to use:** Every Write or Edit tool call.

```typescript
// Source: https://platform.claude.com/docs/en/agent-sdk/hooks
import { HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import * as nodePath from 'path';

function buildPreToolUseHook(workspaceDir: string, logger: pino.Logger): HookCallback {
  const resolvedRepo = nodePath.resolve(workspaceDir);

  // Deny-list patterns: .env files, .git directory, common secrets
  const SENSITIVE_PATTERNS = [
    /^\.env$/,
    /^\.env\./,
    /^\.git\//,
    /\/\.git\//,
    /private_key/i,
    /\.pem$/,
    /\.key$/,
  ];

  return async (input, toolUseId, { signal }) => {
    const preInput = input as PreToolUseHookInput;
    const toolInput = preInput.tool_input as Record<string, unknown>;
    const rawPath = (toolInput?.file_path ?? toolInput?.path) as string | undefined;

    if (!rawPath) return {};  // No path to check — allow (Bash etc.)

    const resolvedPath = nodePath.resolve(resolvedRepo, rawPath);

    // Check 1: path traversal / outside repo
    if (!resolvedPath.startsWith(resolvedRepo + nodePath.sep) && resolvedPath !== resolvedRepo) {
      const reason = `Security: write outside repo path blocked (${rawPath})`;
      logger.warn({ type: 'audit', tool: preInput.tool_name, path: rawPath, reason, toolUseId }, 'tool_blocked');
      return {
        systemMessage: `File write blocked: "${rawPath}" is outside the repository. Only files within ${resolvedRepo} may be modified.`,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      };
    }

    // Check 2: sensitive file patterns
    const relativePath = nodePath.relative(resolvedRepo, resolvedPath);
    for (const pattern of SENSITIVE_PATTERNS) {
      if (pattern.test(relativePath)) {
        const reason = `Security: write to sensitive file blocked (${relativePath})`;
        logger.warn({ type: 'audit', tool: preInput.tool_name, path: relativePath, reason, toolUseId }, 'tool_blocked');
        return {
          systemMessage: `File write blocked: "${relativePath}" matches a sensitive file pattern and cannot be modified.`,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
          },
        };
      }
    }

    return {};  // Allow
  };
}
```

### Pattern 3: PostToolUse Hook — Audit Logging

**What:** Log every Write/Edit tool completion as a structured audit event.
**When to use:** After each Write or Edit tool call succeeds.

```typescript
// Source: https://platform.claude.com/docs/en/agent-sdk/hooks
import { HookCallback, PostToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';

function buildPostToolUseHook(logger: pino.Logger, counterRef: { count: number }): HookCallback {
  return async (input, toolUseId) => {
    const postInput = input as PostToolUseHookInput;
    const toolInput = postInput.tool_input as Record<string, unknown>;
    const filePath = (toolInput?.file_path ?? toolInput?.path) as string | undefined;

    counterRef.count++;  // Increment toolCallCount

    logger.info({
      type: 'audit',
      tool: postInput.tool_name,
      path: filePath,
      timestamp: new Date().toISOString(),
      toolUseId,
    }, 'file_changed');

    return {};
  };
}
```

### Pattern 4: SDKResultMessage → SessionResult Mapping

**What:** Map the final `SDKResultMessage` to the existing `SessionResult` interface.
**When to use:** After consuming all messages from `query()`.

```typescript
// Source: https://platform.claude.com/docs/en/agent-sdk/typescript (SDKResultMessage type)
function mapResult(
  finalResult: SDKResultMessage | undefined,
  sessionId: string,
  toolCallCount: number,
  duration: number,
  logger: pino.Logger
): SessionResult {
  if (!finalResult) {
    return { sessionId, status: 'failed', toolCallCount, duration, finalResponse: '', error: 'No result message received' };
  }

  // Log SDK-specific cost/usage data (NOT added to SessionResult per decision)
  logger.info({
    totalCostUsd: finalResult.total_cost_usd,
    numTurns: finalResult.num_turns,
    usage: finalResult.usage,
  }, 'sdk_session_cost');

  switch (finalResult.subtype) {
    case 'success':
      return {
        sessionId,
        status: 'success',
        toolCallCount,
        duration,
        finalResponse: finalResult.result,
      };
    case 'error_max_turns':
      return {
        sessionId,
        status: 'turn_limit',   // Maps to existing terminal status — no retry
        toolCallCount,
        duration,
        finalResponse: '',
        error: 'Turn limit exceeded',
      };
    case 'error_max_budget_usd':
      // Budget exhaustion is treated as turn_limit (terminal, no retry)
      return {
        sessionId,
        status: 'turn_limit',
        toolCallCount,
        duration,
        finalResponse: '',
        error: 'Session budget exceeded',
      };
    case 'error_during_execution':
    default:
      return {
        sessionId,
        status: 'failed',
        toolCallCount,
        duration,
        finalResponse: '',
        error: (finalResult as any).errors?.join('; ') ?? 'Session failed',
      };
  }
}
```

### Pattern 5: RetryOrchestrator Integration (Conditional Session Creation)

**What:** Add `useSDK?: boolean` to `SessionConfig` and branch in the orchestrator.
**When to use:** In `RetryOrchestrator.run()`, line 70.

```typescript
// Modify src/orchestrator/retry.ts
// Add to SessionConfig interface (session.ts):
//   useSDK?: boolean;  // default: true — Phase 11 removes this

// In RetryOrchestrator.run():
const session = this.config.useSDK !== false
  ? new ClaudeCodeSession(this.config)
  : new AgentSession(this.config);
```

### Pattern 6: CLI Flag (Commander.js)

**What:** Add `--use-sdk` boolean option defaulting to `true`.
**When to use:** In `src/cli/commands/run.ts`.

```typescript
// In the Commander.js `run` command definition:
.option('--no-use-sdk', 'Fall back to legacy AgentSession (for debugging)')
// Commander parses --no-use-sdk as useSDK: false, default is useSDK: true
```

### Anti-Patterns to Avoid

- **Using `settingSources: ['user']`:** Imports operator's personal ~/.claude/settings.json — breaks isolation (explicitly out of scope in REQUIREMENTS.md).
- **Using `bypassPermissions`:** Grants full system access, unsafe (explicitly out of scope).
- **Resuming sessions across retry attempts:** `resume` option re-uses context; always omit it for fresh sessions (established pattern: fresh session per retry).
- **Relying on Stop hook for verification:** Stop hooks do NOT fire on maxTurns (STATE.md decision). RetryOrchestrator remains the quality gate.
- **Async hook for security decisions:** Security `permissionDecision: 'deny'` must be synchronous (return `{async: true}` only for side-effects like logging that don't influence the agent).
- **Registering PreToolUse without a matcher:** Without `matcher: 'Write|Edit'`, the hook fires on every Bash, Read, Grep, etc. — use the matcher.
- **toolCallCount from `num_turns`:** `num_turns` counts API round-trips (turns), not individual tool calls. Use the PostToolUse counter instead for `toolCallCount`.
- **Checking `tool_input.path` only:** Some SDK tools use `file_path`, others use `path`. Always check both in PreToolUse.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Tool execution loop | Custom agentic loop | SDK `query()` built-in loop | ~650 lines of agent.ts + session.ts — SDK does it with 429/529 retry, context compression, token management |
| Context window management | Manual truncation | SDK auto context compression | SDK compresses automatically; `SDKCompactBoundaryMessage` signals it |
| Tool permission system | Custom allowlist | `acceptEdits` + `disallowedTools` + hooks | SDK's permission model is battle-tested; `disallowedTools` deny rules override everything including `bypassPermissions` |
| Network blocking | Docker `NetworkMode: none` | `disallowedTools: ['WebSearch','WebFetch']` | Blocks at the tool layer; no container needed for Phase 10 |
| Rate limit retry | Custom exponential backoff | SDK built-in 429/529 handling | SDK delegates to its built-in retry; our `AgentClient.sendMessage()` retry logic is replaced entirely |

**Key insight:** The SDK replaces ~1200 lines of infrastructure with ~60 lines of wrapper code.

---

## Common Pitfalls

### Pitfall 1: `toolCallCount` Mismatch — `num_turns` vs PostToolUse Counter

**What goes wrong:** Using `finalResult.num_turns` for `toolCallCount` gives the count of API round-trips (each "turn" = one assistant response + tool results), not the number of individual tool calls.
**Why it happens:** The existing `AgentSession` counts each `executeTool()` call, which can be multiple per turn if Claude calls tools in parallel.
**How to avoid:** Maintain a separate counter in the PostToolUse hook, incrementing once per tool call. Pass via a mutable `{ count: number }` reference or close over a variable.
**Warning signs:** Test compares `toolCallCount` to expected number of tool invocations and gets a lower number.

### Pitfall 2: PreToolUse Hook File Path Field Name

**What goes wrong:** `Write` tool uses `file_path`; some tools may use `path`. Checking only one causes missed blocks.
**Why it happens:** SDK built-in tools don't all use the same field name for the target path.
**How to avoid:** Check `toolInput?.file_path ?? toolInput?.path` in PreToolUse. For `Edit` tool: `file_path`. For `Write` tool: `file_path`. For `Bash`: no path field to check.
**Warning signs:** Security tests pass for Write but not Edit (or vice versa).

### Pitfall 3: `query()` Generator Must Be Fully Consumed or Closed

**What goes wrong:** If an error thrown inside the `for await` loop causes early exit without `query.close()`, the underlying Claude Code process leaks.
**Why it happens:** The SDK spawns a subprocess; early iteration termination doesn't automatically clean up.
**How to avoid:** Wrap the `for await` loop in a `try/finally` block that calls `query.close()` if the generator hasn't been exhausted. The Query object has a `close()` method.
**Warning signs:** Zombie `node` processes after test failures.

### Pitfall 4: Stop Hook Does Not Fire on maxTurns

**What goes wrong:** Expecting a Stop hook to trigger when `maxTurns` is exhausted — it doesn't.
**Why it happens:** This is documented in STATE.md (v2.0 planning decision). The `Stop` hook fires on natural agent stop (`end_turn`), not on hard limits.
**How to avoid:** Use `SDKResultMessage.subtype === 'error_max_turns'` to detect turn limit exhaustion. RetryOrchestrator handles all retry logic.
**Warning signs:** Turn-limit tests pass but integration test exits early without proper cleanup.

### Pitfall 5: `settingSources` Default is Empty — No CLAUDE.md Loaded

**What goes wrong:** Project's CLAUDE.md (if present) is NOT loaded unless `settingSources: ['project']` is explicitly set. The default `[]` means no filesystem config.
**Why it happens:** SDK default behavior (documented: "When omitted, the SDK does not load any filesystem settings").
**How to avoid:** For Phase 10, leave `settingSources` as default `[]` — the background agent should not load operator's project config. Isolation is the goal. The `systemPrompt` option handles all prompt needs.
**Warning signs:** Agent behaves differently when run from different directories.

### Pitfall 6: `maxBudgetUsd` Exhaustion Vs. `maxTurns` Exhaustion

**What goes wrong:** `error_max_budget_usd` subtype is not checked; the code falls into the default error branch and returns `'failed'` instead of `'turn_limit'` — causing RetryOrchestrator to attempt a retry.
**Why it happens:** Easy to forget this new error subtype has no equivalent in the legacy implementation.
**How to avoid:** Map `error_max_budget_usd` → `'turn_limit'` (terminal, no retry). The budget is effectively a hard session limit, not a recoverable error.
**Warning signs:** Integration test for budget exhaustion shows 3 retry attempts instead of 1.

### Pitfall 7: ClaudeCodeSession Has No `start()` / `stop()` Methods — RetryOrchestrator Calls Both

**What goes wrong:** `RetryOrchestrator.run()` calls `session.start()` before `session.run()` and `session.stop()` in a finally block. If `ClaudeCodeSession` doesn't implement these, it throws.
**Why it happens:** The interface mismatch — the new session doesn't need start/stop (no container), but the orchestrator expects them.
**How to avoid:** Implement no-op `start()` and `stop()` methods on `ClaudeCodeSession`. Phase 11 will clean up the interface.
**Warning signs:** "session.start is not a function" at runtime.

---

## Code Examples

### Complete ClaudeCodeSession Skeleton

```typescript
// Source: pattern from https://platform.claude.com/docs/en/agent-sdk/typescript
// src/orchestrator/claude-code-session.ts

import * as crypto from 'crypto';
import * as nodePath from 'path';
import { query, HookCallback, PreToolUseHookInput, PostToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import pino from 'pino';
import { SessionConfig } from './session.js';
import { SessionResult } from '../types.js';

export class ClaudeCodeSession {
  private config: SessionConfig;
  private abortController: AbortController | null = null;

  constructor(config: SessionConfig) {
    this.config = config;
  }

  // No-op: SDK needs no container startup
  async start(): Promise<void> {}

  async run(userMessage: string, logger?: pino.Logger): Promise<SessionResult> {
    const log = logger ?? pino({ level: 'silent' });
    const sessionId = crypto.randomUUID();
    const workspaceDir = nodePath.resolve(this.config.workspaceDir);
    const startTime = Date.now();
    const toolCallCounter = { count: 0 };

    this.abortController = new AbortController();
    let queryGen: AsyncGenerator<any, void> | null = null;

    try {
      const preHook = buildPreToolUseHook(workspaceDir, log);
      const postHook = buildPostToolUseHook(log, toolCallCounter);

      queryGen = query({
        prompt: userMessage,
        options: {
          cwd: workspaceDir,
          systemPrompt: userMessage, // systemPrompt supplements the user prompt
          maxTurns: this.config.turnLimit ?? 10,
          maxBudgetUsd: 2.00,
          permissionMode: 'acceptEdits',
          disallowedTools: ['WebSearch', 'WebFetch'],
          model: this.config.model,
          abortController: this.abortController,
          hooks: {
            PreToolUse: [{ matcher: 'Write|Edit', hooks: [preHook] }],
            PostToolUse: [{ matcher: 'Write|Edit', hooks: [postHook] }],
          },
          settingSources: [],
        },
      });

      let finalResult: any | undefined;
      for await (const message of queryGen) {
        if (message.type === 'result') {
          finalResult = message;
        }
      }

      return mapSDKResult(finalResult, sessionId, toolCallCounter.count, Date.now() - startTime, log);

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error({ sessionId, err }, 'ClaudeCodeSession failed');
      return {
        sessionId,
        status: 'failed',
        toolCallCount: toolCallCounter.count,
        duration: Date.now() - startTime,
        finalResponse: '',
        error: errMsg,
      };
    } finally {
      // Close generator if not exhausted (prevents subprocess leak)
      if (queryGen) {
        try { await queryGen.return(undefined); } catch {}
      }
      this.abortController = null;
    }
  }

  // Called by RetryOrchestrator signal handler — abort the SDK query
  async stop(): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }
}
```

### Vitest Mock Pattern for query()

```typescript
// Source: pattern matching existing vi.mock usage in retry.test.ts
// src/orchestrator/claude-code-session.test.ts

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the SDK module before importing ClaudeCodeSession
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeCodeSession } from './claude-code-session.js';

const mockQuery = query as ReturnType<typeof vi.fn>;

// Helper: create an async generator that yields specified messages
async function* makeQueryGen(messages: any[]) {
  for (const msg of messages) yield msg;
}

function makeSuccessResult() {
  return {
    type: 'result',
    subtype: 'success',
    session_id: 'sdk-session-id',
    result: 'Task completed',
    duration_ms: 1500,
    num_turns: 3,
    total_cost_usd: 0.05,
    usage: {},
    is_error: false,
  };
}

describe('ClaudeCodeSession', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns success SessionResult on successful query', async () => {
    mockQuery.mockReturnValue(makeQueryGen([makeSuccessResult()]));
    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace' });
    await session.start();
    const result = await session.run('Fix the bug');
    expect(result.status).toBe('success');
    expect(result.finalResponse).toBe('Task completed');
  });

  it('maps error_max_turns to turn_limit status', async () => {
    mockQuery.mockReturnValue(makeQueryGen([{
      type: 'result', subtype: 'error_max_turns',
      session_id: 's', duration_ms: 1000, num_turns: 10,
      total_cost_usd: 0.5, usage: {}, is_error: true,
    }]));
    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace', turnLimit: 10 });
    await session.start();
    const result = await session.run('task');
    expect(result.status).toBe('turn_limit');
  });

  it('no-op start() and stop() do not throw', async () => {
    const session = new ClaudeCodeSession({ workspaceDir: '/tmp/workspace' });
    await expect(session.start()).resolves.toBeUndefined();
    await expect(session.stop()).resolves.toBeUndefined();
  });
});
```

---

## maxBudgetUsd Recommendation

**Recommended default: `2.00` USD per session** (Claude's Discretion item from CONTEXT.md).

Rationale:
- A `maven-dependency-update` or `npm-dependency-update` task requires ~5-15 tool calls (read pom.xml/package.json, make edits, git add/commit). At claude-sonnet pricing (~$0.003/1K input tokens, ~$0.015/1K output), a 10-turn session with moderate context costs roughly $0.05-0.30.
- `$2.00` gives a 6-40x safety margin above typical cost — tight enough to prevent runaway loops, generous enough that legitimate tasks never hit it.
- If a session exceeds $2.00, something is wrong (infinite loop, enormous context, model confusion) and it should be treated as a terminal failure (mapped to `turn_limit`).
- Can be made configurable via `SessionConfig.maxBudgetUsd?: number` for callers who need different limits.

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Custom agentic loop (agent.ts) | SDK query() built-in loop | Phase 10 | Eliminates ~273 lines; gets built-in 429/529 retry |
| Docker container isolation | SDK `acceptEdits` + `disallowedTools` + hooks | Phase 10 | No Docker required for isolation; network blocking via disallowedTools |
| 6 hand-built tools | 15+ SDK built-in tools (Read, Write, Edit, Bash, Glob, Grep, WebSearch...) | Phase 10 | Better tools, no custom implementation |
| Manual context window management | SDK auto context compression | Phase 10 | Context never blows up; `SDKCompactBoundaryMessage` signals compaction |
| `@anthropic-ai/sdk` for agentic loop | `@anthropic-ai/claude-agent-sdk` | Phase 10 | `@anthropic-ai/sdk` kept for LLM Judge only |
| TurnLimitError (thrown exception) | SDKResultMessage.subtype: 'error_max_turns' | Phase 10 | No exception; structured result |

**Deprecated/outdated in this codebase:**
- `AgentClient` class: entirely replaced by SDK's built-in loop (Phase 11 will delete)
- `ContainerManager`: Docker container management replaced by SDK subprocess (Phase 11 will delete)
- `TurnLimitError`: not needed in ClaudeCodeSession (SDK returns structured result, not exception)

---

## Open Questions

1. **systemPrompt vs prompt relationship**
   - What we know: `query()` takes both `prompt` (the user message) and `options.systemPrompt` (the system instruction). The existing `buildPrompt()` builders return the full end-state task description, which was previously the "user message" in the API call.
   - What's unclear: Should the end-state prompt go in `systemPrompt` or `prompt`? Or both?
   - Recommendation: Pass the `buildPrompt()` output as `prompt` (the user instruction). Leave `systemPrompt` as a minimal system directive or use `{ type: 'preset', preset: 'claude_code' }` to get Claude Code's default system prompt. The Spotify pattern uses the end-state description as the user prompt. This is "Claude's Discretion" per CONTEXT.md.

2. **toolCallCount semantic drift**
   - What we know: `num_turns` in `SDKResultMessage` counts API round-trips. PostToolUse hook fires per tool call. These are different numbers.
   - What's unclear: What does `MetricsCollector.recordSession()` in `run.ts` expect — tool calls or turns?
   - Recommendation: Implement counter in PostToolUse (fires for Write/Edit). Note this only counts Write/Edit calls, not Bash/Read/Glob. If total tool count is needed, remove the matcher from PostToolUse and count all tools. Leave matcher in PreToolUse (security) and remove from PostToolUse (audit). Both hooks should fire for Write|Edit per decision, so counter is accurate for file mutations. Planner to decide if Bash counts are needed.

3. **query() generator early termination on AbortController.abort()**
   - What we know: The SDK takes an `AbortController` in options. `stop()` on the session should abort it.
   - What's unclear: Does aborting cause the `for await` loop to throw (AbortError), return normally, or hang?
   - Recommendation: Wrap the `for await` in try/catch to handle both cases. Always call `generator.return()` in finally.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest ^4.0.18 |
| Config file | none — uses package.json test script |
| Quick run command | `npx vitest run src/orchestrator/claude-code-session.test.ts` |
| Full suite command | `npm test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SDK-01 | ClaudeCodeSession calls query() instead of AgentClient | unit | `npx vitest run src/orchestrator/claude-code-session.test.ts` | ❌ Wave 0 |
| SDK-02 | Built-in tools available (no custom tool registration) | unit/smoke | `npx vitest run src/orchestrator/claude-code-session.test.ts` | ❌ Wave 0 |
| SDK-03 | permissionMode: 'acceptEdits' passed to query() | unit | `npx vitest run src/orchestrator/claude-code-session.test.ts` | ❌ Wave 0 |
| SDK-04 | disallowedTools blocks WebSearch/WebFetch | unit | `npx vitest run src/orchestrator/claude-code-session.test.ts` | ❌ Wave 0 |
| SDK-05 | maxTurns passed correctly; error_max_turns → turn_limit | unit | `npx vitest run src/orchestrator/claude-code-session.test.ts` | ❌ Wave 0 |
| SDK-06 | systemPrompt / prompt from buildPrompt() wired correctly | unit | `npx vitest run src/orchestrator/claude-code-session.test.ts` | ❌ Wave 0 |
| SDK-07 | PostToolUse hook fires and logs audit events | unit | `npx vitest run src/orchestrator/claude-code-session.test.ts` | ❌ Wave 0 |
| SDK-08 | PreToolUse hook blocks outside-repo and .env/.git paths | unit | `npx vitest run src/orchestrator/claude-code-session.test.ts` | ❌ Wave 0 |
| SDK-09 | maxBudgetUsd passed; error_max_budget_usd → turn_limit | unit | `npx vitest run src/orchestrator/claude-code-session.test.ts` | ❌ Wave 0 |
| SDK-10 | SessionResult fields match interface contract | unit | `npx vitest run src/orchestrator/claude-code-session.test.ts` | ❌ Wave 0 |
| RetryOrchestrator (--use-sdk) | With --use-sdk, ClaudeCodeSession used; existing retry tests pass | unit | `npx vitest run src/orchestrator/retry.test.ts` | ✅ exists |
| CLI flag | --no-use-sdk falls back to AgentSession | unit/smoke | `npx vitest run src/orchestrator/retry.test.ts` | ✅ exists |

### Sampling Rate
- **Per task commit:** `npx vitest run src/orchestrator/claude-code-session.test.ts`
- **Per wave merge:** `npm test`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `src/orchestrator/claude-code-session.test.ts` — covers SDK-01 through SDK-10
- [ ] `src/orchestrator/claude-code-session.ts` — the ClaudeCodeSession implementation

*(All existing tests in `src/orchestrator/retry.test.ts` etc. must remain green throughout — they mock AgentSession and are unaffected by the new class.)*

---

## Sources

### Primary (HIGH confidence)

- `https://platform.claude.com/docs/en/agent-sdk/typescript` — Full TypeScript API: Options type, SDKResultMessage type, HookEvent/HookInput/HookJSONOutput types, PermissionMode, Query object
- `https://platform.claude.com/docs/en/agent-sdk/hooks` — Hook examples: PreToolUse deny pattern, PostToolUse logging pattern, matcher syntax, block + systemMessage combination
- `https://platform.claude.com/docs/en/agent-sdk/overview` — Installation, prerequisites, ANTHROPIC_API_KEY, no separate CLI install required
- `npm view @anthropic-ai/claude-agent-sdk version` — Confirmed version 0.2.77 (2026-03-17)
- Existing codebase: `src/types.ts`, `src/orchestrator/retry.ts`, `src/orchestrator/session.ts`, `src/orchestrator/agent.ts`, `src/cli/commands/run.ts`, `src/orchestrator/retry.test.ts`

### Secondary (MEDIUM confidence)

- `BRIEF.md` — Migration analysis, target architecture diagram, what-to-delete/keep/modify table
- `.planning/STATE.md` — Accumulated decisions: disallowedTools list, Stop hook limitation, @anthropic-ai/sdk retention

### Tertiary (LOW confidence)

- None — all critical claims verified against official docs or source code.

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — version confirmed via `npm view`, docs fetched from platform.claude.com
- Architecture: HIGH — query() API, hook shapes, SDKResultMessage all confirmed from official TypeScript reference
- Pitfalls: HIGH — pitfall 1 (toolCallCount/num_turns) confirmed from SDKResultMessage type; pitfall 4 (Stop hook) confirmed in STATE.md; others from official docs
- maxBudgetUsd recommendation: MEDIUM — pricing estimate based on training knowledge; exact cost per session requires runtime observation

**Research date:** 2026-03-17
**Valid until:** 2026-04-17 (SDK is actively developed; check for breaking changes before implementation if delayed)
