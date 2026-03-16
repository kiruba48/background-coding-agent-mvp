# Architecture Research

**Domain:** Claude Agent SDK migration — background coding agent
**Researched:** 2026-03-16
**Confidence:** HIGH (Claude Agent SDK docs via official platform.claude.com, Spotify pattern via official engineering blog)

## Context: What This Research Is

This is not a greenfield architecture doc. It is a migration analysis. The system already exists and works (v1.1). The question is: how does the Claude Agent SDK slot into the existing RetryOrchestrator/Verifier/Judge architecture, what needs to change, and what does the new data flow look like?

---

## Current Architecture (v1.1 — What Exists)

```
CLI (Commander.js)
  -> RetryOrchestrator
       -> AgentSession.start()            creates Docker container
       -> AgentSession.run(message)       drives custom agentic loop
            -> AgentClient.runAgenticLoop()
                 -> Anthropic SDK messages.create() (loop)
                 -> Tool dispatch (read_file, edit_file, grep, etc.)
                    -> ContainerManager.exec() for read/grep/bash
                    -> host execFile() for git_operation, edit_file
       -> AgentSession.stop()             tears down container
       -> compositeVerifier(workspaceDir)
       -> llmJudge(workspaceDir, originalTask)
  -> GitHubPRCreator (optional)
```

What gets deleted: AgentSession (667 lines), AgentClient (273 lines), ContainerManager (~200 lines), their tests (~650 lines). Total: ~1,190 lines.

What stays: RetryOrchestrator, compositeVerifier, llmJudge, ErrorSummarizer, GitHubPRCreator, prompts/, cli/. Total: ~1,600 lines unchanged.

---

## Target Architecture (v2.0)

```
CLI (Commander.js)
  -> RetryOrchestrator
       -> AgentSdkSession.run(message)   thin wrapper around query()
            -> Claude Agent SDK query()
                 cwd: workspaceDir
                 maxTurns: turnLimit
                 permissionMode: 'acceptEdits'
                 allowedTools: ['Read','Write','Edit','Bash','Glob','Grep']
                 model: config.model
                 hooks: { Stop: [verifyBeforeStop] }  (optional MCP path, Phase 12)
                 Built-in: auto context compression, agentic loop
       -> compositeVerifier(workspaceDir)   unchanged
       -> llmJudge(workspaceDir, task)       unchanged
  -> GitHubPRCreator                         unchanged
```

The swap is surgical: `new AgentSession(config)` becomes `new AgentSdkSession(config)` in `retry.ts`. The `AgentSdkSession` wrapper satisfies the same `SessionResult`-returning contract so `RetryOrchestrator` is untouched.

---

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           HOST PROCESS                                   │
│                                                                          │
│  CLI (run.ts)                                                            │
│     |                                                                    │
│  RetryOrchestrator.run(task)   [loop: attempt 1..maxRetries]            │
│     |                                                                    │
│     ├── AgentSdkSession.run(message)  ←─── NEW (replaces AgentSession)  │
│     |      |                                                             │
│     |      | query({ cwd, maxTurns, permissionMode, hooks, ... })       │
│     |      |                                                             │
│     |      ▼                                                             │
│     |   ┌──────────────────────────────────────────────┐                │
│     |   │  Claude Code Process  (Phase 13: in Docker)  │                │
│     |   │                                              │                │
│     |   │  Built-in tools: Read Write Edit Bash        │                │
│     |   │                  Glob Grep                   │                │
│     |   │  Auto context compression                    │                │
│     |   │  Agentic loop (managed by SDK)               │                │
│     |   │                                              │                │
│     |   │  hooks: PostToolUse → audit log              │                │
│     |   │         Stop → optional self-verify (Ph.12)  │                │
│     |   └──────────────────────────────────────────────┘                │
│     |                                                                    │
│     ├── preVerify hook (e.g., npm install)    ←── unchanged             │
│     ├── compositeVerifier(workspaceDir)        ←── unchanged            │
│     └── llmJudge(workspaceDir, originalTask)   ←── unchanged            │
│                                                                          │
│  GitHubPRCreator (optional)                    ←── unchanged            │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Component Responsibilities (Post-Migration)

| Component | Responsibility | Status |
|-----------|----------------|--------|
| `CLI (run.ts)` | Parse args, build config, wire orchestrator | Modify: remove Docker refs |
| `RetryOrchestrator` | Outer verify/retry loop, judge integration | Keep unchanged |
| `AgentSdkSession` | Thin wrapper: `query()` call, result mapping, turn/timeout tracking | New (~50 lines) |
| `compositeVerifier` | Build/test/lint — deterministic quality gate | Keep unchanged |
| `llmJudge` | Diff-vs-prompt scope check | Keep unchanged |
| `ErrorSummarizer` | Build retry context digest | Keep unchanged |
| `GitHubPRCreator` | Branch/push/PR via Octokit | Keep unchanged |
| `prompts/*.ts` | End-state prompt builders | Keep unchanged |

---

## Integration Point: RetryOrchestrator to AgentSdkSession

The only integration change is in `retry.ts` lines 70-81 (the session creation block):

```typescript
// BEFORE
const session = new AgentSession(this.config);
this.activeSession = session;
await session.start();
sessionResult = await session.run(message, logger);
// finally: await session.stop()

// AFTER
const session = new AgentSdkSession(this.config);
this.activeSession = session;
sessionResult = await session.run(message, logger);
// finally: await session.stop()   (no-op or abort)
```

`AgentSdkSession.run()` must return the same `SessionResult` shape:

```typescript
interface SessionResult {
  sessionId: string;
  status: 'success' | 'failed' | 'timeout' | 'turn_limit';
  toolCallCount: number;
  duration: number;
  finalResponse: string;
  error?: string;
}
```

The SDK's `maxTurns` option replaces `TurnLimitError`. The `AbortController` (passed via `options.abortController`) replaces the manual timeout. The result message stream (`msg.type === 'result'`) provides `finalResponse`. Tool call count is tracked by counting `tool_use` blocks in `msg.type === 'assistant'` messages.

---

## AgentSdkSession: The New Component

This is the only net-new production class. It is deliberately thin — approximately 50 lines.

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import * as crypto from 'crypto';
import pino from 'pino';
import { SessionConfig, SessionResult } from '../types.js';

export class AgentSdkSession {
  private config: SessionConfig;
  private abortController: AbortController | null = null;

  constructor(config: SessionConfig) {
    this.config = config;
  }

  async run(message: string, logger?: pino.Logger): Promise<SessionResult> {
    const sessionId = crypto.randomUUID();
    const startTime = Date.now();
    let toolCallCount = 0;
    let finalResponse = '';
    const status_ref = { value: 'success' as SessionResult['status'] };
    let error: string | undefined;

    this.abortController = new AbortController();
    const timeout = setTimeout(
      () => this.abortController?.abort(),
      this.config.timeoutMs ?? 300_000
    );

    try {
      logger?.info({ sessionId, status: 'running' }, 'Session started');

      for await (const msg of query({
        prompt: message,
        options: {
          cwd: this.config.workspaceDir,
          maxTurns: this.config.turnLimit ?? 10,
          permissionMode: 'acceptEdits',
          allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
          disallowedTools: ['WebSearch', 'WebFetch'],  // no network
          model: this.config.model,
          abortController: this.abortController,
        }
      })) {
        if (msg.type === 'assistant') {
          for (const block of msg.content) {
            if (block.type === 'tool_use') toolCallCount++;
          }
        }
        if (msg.type === 'result') {
          finalResponse = msg.result ?? '';
          if (msg.subtype === 'error_max_turns') status_ref.value = 'turn_limit';
          else if (msg.subtype !== 'success') status_ref.value = 'failed';
        }
      }
    } catch (err) {
      if (this.abortController.signal.aborted) {
        status_ref.value = 'timeout';
        error = 'Session timeout';
      } else {
        status_ref.value = 'failed';
        error = err instanceof Error ? err.message : String(err);
      }
    } finally {
      clearTimeout(timeout);
      this.abortController = null;
    }

    const duration = Date.now() - startTime;
    logger?.info({ sessionId, status: status_ref.value, toolCallCount, duration }, 'Session completed');

    return { sessionId, status: status_ref.value, toolCallCount, duration, finalResponse, error };
  }

  async stop(): Promise<void> {
    this.abortController?.abort();
  }
}
```

---

## Container Strategy

**Verdict: Run Claude Agent SDK (the Claude Code process) inside Docker for production isolation.**

### Why Container Is Still Required

The Agent SDK's built-in tools (`Bash`, `Write`, `Edit`) execute on the host machine as the current user. Without a container, the agent can:
- Modify any file the Node.js process can reach
- Execute arbitrary shell commands via `Bash` tool
- Make network calls (if `WebSearch`/`WebFetch` not disallowed)

The core constraint is unchanged: "Agent must run in Docker with no external network access — security non-negotiable."

### Why This Is Not Docker-in-Docker

Docker-in-Docker (DinD) means the orchestrator on the host spins up a container and then the tools inside that container make further Docker calls. That is not the pattern here.

The correct pattern: the Agent SDK's Claude Code process (the thing that runs `query()`) runs inside Docker. The orchestrator process (RetryOrchestrator, verifier, judge) stays on the host. The SDK communicates with its subprocess via the process interface, which the `spawnClaudeCodeProcess` option makes configurable.

```
Host machine
  Node.js orchestrator process (RetryOrchestrator, verifier, judge, PR creator)
       |
       | docker run --network=none --user=1001 -v workspace:/workspace agent-sdk:latest
       |      node dist/orchestrator/sdk-session-entrypoint.js
       |
       v
  Docker container (network=none, non-root, workspace bind-mounted)
       Node.js Agent SDK process
            query() runs here
            Built-in tools execute inside container
                 Read/Write/Edit/Bash/Glob/Grep against /workspace
```

The Agent SDK `Options.spawnClaudeCodeProcess` accepts a custom spawn function that takes `SpawnOptions` and returns a `SpawnedProcess`. This is the integration point for the container launch.

### Development Mode (Phases 10-11)

For development and CI, skip the container. Use strict permission controls instead:

```typescript
options: {
  permissionMode: 'dontAsk',  // deny anything not in allowedTools
  allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
  disallowedTools: ['WebSearch', 'WebFetch', 'Agent'],
}
```

This provides adequate blast-radius limitation for testing without Docker startup overhead.

### Production Mode (Phase 13)

Build a Dockerfile that:
- Installs `@anthropic-ai/claude-agent-sdk` and ripgrep (for Grep tool)
- Runs as non-root user (UID 1001)
- Bind-mounts the workspace directory at `/workspace`
- Has no network access (`--network=none`)
- Has read-only root filesystem except `/workspace`

The `spawnClaudeCodeProcess` implementation in `AgentSdkSession` wraps the docker run command.

---

## MCP Verifier Server Pattern (Spotify Pattern — Phase 12)

Spotify's Honk agent exposes verifiers as MCP servers. The key quote from their engineering blog: "the agent doesn't know what the verification does and how, it just knows that it can (and in certain cases must) call it to verify its changes."

### Two-Level Verification Architecture

```
Agent SDK session (inside container)
     |
     | calls mcp__verifier__verify
     v
MCP verifier server (stdio, host process)
     |
     | imports compositeVerifier
     v
compositeVerifier(workspaceDir)  [same function as outer RetryOrchestrator uses]
     |
     v
{ passed: boolean, errors: VerificationError[] }
     |
     | returned to agent as tool result
     v
Agent self-corrects within the session if errors exist
     |
     | when agent is satisfied, stops
     v
RetryOrchestrator runs compositeVerifier again (authoritative)
```

### Why Run Verifier Twice

The MCP verifier gives the agent in-session feedback — it can fix its own mistakes without consuming a full outer retry. The outer `RetryOrchestrator` verification is still the mandatory quality gate because it cannot be bypassed and runs regardless of what happened inside the session.

The outer verification is cheap to run (it was already running). The MCP path reduces the number of outer retries needed, not the number of verifications.

### MCP Server Configuration

```typescript
// In AgentSdkSession.run(), add to options:
mcpServers: {
  verifier: {
    command: 'node',
    args: ['dist/mcp/verifier-server.js'],
    env: { WORKSPACE_DIR: this.config.workspaceDir }
  }
},
allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'mcp__verifier__verify']
```

The MCP server itself is a stdio server (~30 lines) that reads `WORKSPACE_DIR` from env and calls `compositeVerifier`:

```typescript
// mcp/verifier-server.ts
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { compositeVerifier } from '../orchestrator/verifier.js';

const server = createSdkMcpServer({
  name: 'verifier',
  tools: [
    tool('verify', 'Run build, test, and lint checks on the workspace', {}, async () => {
      const result = await compositeVerifier(process.env.WORKSPACE_DIR!);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    })
  ]
});
```

### MCP Verifier Is Optional

This is a Phase 12 optimization. The system works correctly without it. Implement after Phase 10 (core migration) and Phase 11 (deletion) are stable.

---

## Data Flow: New Request Lifecycle

```
CLI: background-agent run --task npm-dependency-update --repo /path/to/repo
     |
     v
RetryOrchestrator.run(originalTask)   [loop: attempt 1..maxRetries=3]
     |
     | attempt 1: message = originalTask
     | attempt 2: message = task + "\n---\n" + errorDigest + "\n---\nFix and complete."
     |
     v
AgentSdkSession.run(message, logger)
     |
     | query({
     |   prompt: message,
     |   options: {
     |     cwd: workspaceDir,
     |     maxTurns: 10,
     |     permissionMode: 'acceptEdits',
     |     allowedTools: ['Read','Write','Edit','Bash','Glob','Grep'],
     |     disallowedTools: ['WebSearch','WebFetch'],
     |     model: 'claude-sonnet-4-5',
     |     abortController: (5 min timeout)
     |   }
     | })
     |
     v  (async generator streams messages)
     |
     | type='assistant' with tool_use blocks -> toolCallCount++
     | type='result', subtype='success'      -> finalResponse = msg.result
     | type='result', subtype='error_max_turns' -> status = 'turn_limit'
     |
     v
SessionResult { status:'success', toolCallCount:7, duration:45000, finalResponse:'...' }
     |
     v  (back in RetryOrchestrator)
     |
     | if status !== 'success': return terminal failure (no retry)
     |
     v
preVerify hook (e.g., runNpmInstall for lockfile regen)
     |
     v
compositeVerifier(workspaceDir)   [tsc, vitest, eslint, maven build+test, npm build+test]
     |
     | if passed:
     v
llmJudge(workspaceDir, originalTask)   [diff scope check, ~25% veto rate]
     |
     | if APPROVE:
     v
RetryResult { finalStatus:'success', attempts:1, sessionResults, verificationResults }
     |
     v
GitHubPRCreator (if --create-pr flag)
```

Nothing in this flow changes except the AgentSdkSession box. All error paths, retry logic, judge logic, and PR creation are identical.

---

## Hooks Integration

### PostToolUse Hook (Audit Logging)

Replaces the custom tool logging from the old session. Non-blocking (async: true).

```typescript
import { HookCallback, PostToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';

const auditHook: HookCallback = async (input, toolUseId) => {
  const post = input as PostToolUseHookInput;
  logger?.debug({ toolName: post.tool_name, toolUseId }, 'Tool executed');
  return { async: true };  // non-blocking — don't wait
};

// In query() options:
hooks: {
  PostToolUse: [{ hooks: [auditHook] }]
}
```

### Stop Hook (Optional In-Session Verification, Phase 12)

When the agent decides to stop, this fires before the session ends. Can inject verification results back into the conversation and keep the agent going.

```typescript
const verifyBeforeStop: HookCallback = async (input) => {
  const result = await compositeVerifier(workspaceDir);
  if (!result.passed) {
    const errorSummary = ErrorSummarizer.buildDigest([result]);
    return {
      systemMessage: `Verification failed:\n${errorSummary}\nFix these issues before stopping.`,
      continue: true   // keep the session going
    };
  }
  return {};  // allow stop — verification passed
};
```

Note: The Stop hook fires when the agent tries to stop. The outer `RetryOrchestrator` verification fires after the session actually ends. Both can fire for the same session. This is correct — the Stop hook gives the agent a chance to self-correct; the outer verification is the final authority.

### No PreToolUse Hooks Needed for Path Safety

The old `AgentSession` had explicit path traversal checks and git flag allowlists. The Agent SDK's `cwd` option scopes the agent to the workspace directory. `allowedTools` without `Bash git push` prevents unauthorized git operations. The combination replaces the need for `PreToolUse` path validation hooks in the common case.

If fine-grained git control is needed (e.g., blocking `git push`), add a `PreToolUse` hook with `matcher: 'Bash'` that checks `tool_input.command` for blocked patterns.

---

## Removed vs Replaced vs Retained

### Deleted (~1,190 lines)

| File | Lines | Replaced By |
|------|-------|-------------|
| `orchestrator/agent.ts` | 273 | Agent SDK built-in agentic loop |
| `orchestrator/session.ts` | 667 | `AgentSdkSession` wrapper (~50 lines) |
| `orchestrator/container.ts` | ~200 | Agent SDK process runs in container (Phase 13) |
| Tests for above | ~650 | New integration tests for `AgentSdkSession` |

### New

| File | Lines | Purpose |
|------|-------|---------|
| `orchestrator/sdk-session.ts` | ~50 | `AgentSdkSession`: thin `query()` wrapper, `SessionResult` mapping |
| `mcp/verifier-server.ts` | ~30 | MCP stdio server exposing `compositeVerifier` (Phase 12 only) |

### Modified (minimal)

| File | Change |
|------|--------|
| `orchestrator/retry.ts` | Line 70: `new AgentSession` -> `new AgentSdkSession`. Remove Docker/container import. |
| `orchestrator/index.ts` | Remove `AgentClient`, `AgentSession`, `ContainerManager` exports. Add `AgentSdkSession`. |
| `cli/commands/run.ts` | Remove `image` option. Remove DockerContainerManager references. |
| `package.json` | Add `@anthropic-ai/claude-agent-sdk`. Remove `dockerode` and `write-file-atomic` (if only used in session.ts). |

### Unchanged (everything else)

`retry.ts` loop logic, `verifier.ts`, `judge.ts`, `summarizer.ts`, `pr-creator.ts`, `metrics.ts`, `prompts/`, `cli/index.ts` core, `types.ts`, all type definitions, all prompt builders.

---

## Architectural Patterns

### Pattern 1: Wrapper with Same Contract

**What:** `AgentSdkSession` wraps `query()` and returns the same `SessionResult` interface that `AgentSession` returned. `RetryOrchestrator` sees no API difference.

**When to use:** Replacing an implementation without changing callers. The existing interface acts as the migration contract.

**Trade-offs:** Slight indirection, but all orchestrator logic and tests remain unchanged. The wrapper is so thin that it adds negligible complexity.

### Pattern 2: Outer Verification Is Always Authoritative

**What:** Verification in `RetryOrchestrator` is the mandatory quality gate. Any in-session verification (via MCP Stop hook) is an optimization for faster feedback, not a replacement.

**When to use:** Every time, without exception.

**Trade-offs:** Some redundancy (verifier runs twice if MCP path is active), but correctness is guaranteed even if the MCP path fails or the Stop hook crashes.

### Pattern 3: Fresh Session Per Retry

**What:** Create a new `AgentSdkSession` (new `query()` call) for each retry attempt. Never resume a failed session.

**When to use:** Always for retry attempts. The Agent SDK supports session resumption via `resume: sessionId`. Do not use this for the retry loop.

**Why:** Prior failure context from a bad session contaminates the model's approach. The retry message (task + error digest, built by `buildRetryMessage()`) provides precisely the right context. Spotify's engineering blog explicitly validates this: fresh session per retry prevents context accumulation.

### Pattern 4: Surrounding Infrastructure Stays Outside the Agent

**What:** PR creation, branch naming, git push, Slack notifications, logging — all of these happen in the orchestrator, not inside the agent session.

**When to use:** Anything that interacts with external systems (GitHub, Slack, monitoring).

**Why:** This is the core Spotify pattern. The agent's scope is: read, understand, edit, verify. The orchestrator's scope is: lifecycle, retry, quality gate, output. Keeping infrastructure outside the agent makes the agent's behavior more predictable and the infrastructure independently testable.

---

## Anti-Patterns

### Anti-Pattern 1: Running Agent SDK on Host for Production

**What people do:** Skip the container step — run `query()` directly in the orchestrator process for simplicity. Rely on `permissionMode: 'dontAsk'` and `disallowedTools` for safety.

**Why it's wrong:** No network isolation. `Bash` tool can make network calls unless `WebSearch`/`WebFetch` are disallowed AND the Bash commands themselves are restricted. File access is scoped only by the agent's compliance with `cwd`, not by OS-level enforcement.

**Do this instead:** Container for production (Phase 13). Permission restrictions alone for development/CI only.

### Anti-Pattern 2: Using Stop Hook as Primary Verification

**What people do:** Move `compositeVerifier` into a Stop hook, remove it from `RetryOrchestrator`, let the hook be the quality gate.

**Why it's wrong:** Hooks can crash, be misconfigured, or not fire if the session errors out before stopping cleanly. The `RetryOrchestrator` verification runs on the host with full access to tooling and is completely decoupled from the agent session state.

**Do this instead:** Keep `compositeVerifier` in `RetryOrchestrator`. Add a Stop hook only as an in-session feedback optimization (Phase 12).

### Anti-Pattern 3: Resuming Failed Sessions for Retry

**What people do:** Pass `resume: previousSessionId` when retrying after verification failure, thinking the agent can "continue from where it left off."

**Why it's wrong:** The failed session's context window contains all the wrong tool calls, dead-end reasoning, and possibly invalid workspace state. The model anchors to the prior bad approach instead of starting fresh.

**Do this instead:** Create a fresh `query()` call. The `buildRetryMessage()` in `RetryOrchestrator` already constructs the correct retry prompt: original task first, error digest second.

### Anti-Pattern 4: Migrating Everything at Once

**What people do:** Delete `AgentSession`, replace `RetryOrchestrator` internals directly, update all exports simultaneously, then try to get tests green.

**Why it's wrong:** ~100 passing unit tests become unrunnable mid-migration. Hard to isolate failures. No incremental validation.

**Do this instead:** Phase 10 creates `AgentSdkSession` with same interface, swaps one line in `retry.ts`. All existing unit tests still pass (they mock the session). Phase 11 deletes legacy only after Phase 10 is green and verified.

### Anti-Pattern 5: Putting git push Inside the Agent

**What people do:** Give the agent `allowedTools: ['Bash']` with git push enabled, and let it push its own branch.

**Why it's wrong:** Agent should not push to remote. From Spotify: infrastructure like branch management, pushing, and PR creation lives outside the agent. This is a security and predictability boundary.

**Do this instead:** Agent commits locally (Bash git commit or the Agent SDK's Bash tool with scoped git). `GitHubPRCreator` on the host handles branch creation, push, and PR.

---

## Spotify "Honk" Architecture Reference

Spotify's background coding agent evolved through the same trajectory as this project:

1. Open-source agents (brittle, hard to maintain)
2. Custom agentic loop (what v1.0/v1.1 built)
3. Claude Code as agent engine (where v2.0 goes)

Their validated architecture after migration (Spotify Engineering Part 1/3, 2025):

- **Agent runs in a sandboxed container** with limited binaries and no network access to surrounding systems
- **Verifiers exposed as MCP servers** — agent calls a verify tool, doesn't know if it's Maven or npm underneath. Verifier activates automatically based on codebase contents (pom.xml triggers Maven verifier, package.json triggers npm verifier)
- **Stop hook triggers verification** before PR creation is attempted
- **LLM Judge vetoes ~25% of proposals** — agents self-correct roughly half the time when given veto feedback
- **Surrounding infrastructure stays outside** — fleet management, Slack, PR creation, prompt authoring all external to Claude Code itself
- **Top-performing agent** across ~50 migration comparisons in their evaluation framework

The architecture described in this document implements all of these patterns. Their "small internal CLI" that "delegates to Claude Code, runs MCP verifiers, evaluates diff with LLM Judge, uploads logs" maps directly to our `CLI -> RetryOrchestrator -> AgentSdkSession + compositeVerifier + llmJudge` stack.

---

## Build Order Rationale

Dependencies flow as:

```
Phase 10: AgentSdkSession          -> Phase 11: Delete Legacy
  (new wrapper, swap in retry.ts)       (cleanup, simplify)
         |                                     |
         v                                     v
Phase 12: MCP Verifiers (optional)   Phase 13: Container Strategy
  (Spotify pattern, in-session        (production isolation,
   self-verification)                  spawnClaudeCodeProcess)
```

Phase 10 must precede Phase 11: cannot delete until replacement works.

Phase 12 and Phase 13 are independent of each other. Phase 12 adds the MCP verifier server (runs on host). Phase 13 puts the agent process inside Docker. Neither depends on the other.

Phase 12 can be skipped if the outer retry loop provides sufficient correction cycles. Phase 13 is required for production but can be deferred for development.

---

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| Anthropic API | Agent SDK `query()` handles auth, retries, rate limits | `ANTHROPIC_API_KEY` env var, same as before |
| Docker (Phase 13) | `spawnClaudeCodeProcess` custom spawn function in `Options` | SDK docs confirm this option exists for container/VM execution |
| GitHub | Octokit in `GitHubPRCreator`, unchanged | Outside the agent, pure host infrastructure |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| `RetryOrchestrator` to `AgentSdkSession` | Direct method call, `SessionResult` return | Same contract as `AgentSession` |
| `AgentSdkSession` to Agent SDK | Async generator (`for await`), `Options` object | SDK streams `SDKMessage` objects |
| `RetryOrchestrator` to `compositeVerifier` | Direct function call, `VerificationResult` return | Unchanged |
| Agent SDK to MCP verifier server (Phase 12) | stdio transport, MCP protocol | Server runs as child process spawned by SDK |
| MCP verifier server to `compositeVerifier` | Direct TypeScript import | Same function, new caller |

---

## Sources

- [Claude Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview) — HIGH confidence, official docs
- [Claude Agent SDK TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript) — HIGH confidence, official docs (Options type, query() signature, Query object, spawnClaudeCodeProcess, SDKMessage types)
- [Claude Agent SDK Hooks](https://platform.claude.com/docs/en/agent-sdk/hooks) — HIGH confidence, official docs (PreToolUse, PostToolUse, Stop, HookCallback interface, permissionDecision)
- [Claude Agent SDK Permissions](https://platform.claude.com/docs/en/agent-sdk/permissions) — HIGH confidence, official docs (acceptEdits, dontAsk, bypassPermissions, allowedTools vs disallowedTools)
- [Claude Agent SDK MCP](https://platform.claude.com/docs/en/agent-sdk/mcp) — HIGH confidence, official docs (mcpServers config, stdio transport, createSdkMcpServer, tool())
- [Spotify Engineering Part 1: Architecture](https://engineering.atspotify.com/2025/11/spotifys-background-coding-agent-part-1) — MEDIUM confidence, engineering blog
- [Spotify Engineering Part 3: Feedback Loops](https://engineering.atspotify.com/2025/12/feedback-loops-background-coding-agents-part-3) — MEDIUM confidence, engineering blog (container isolation, MCP verifiers, stop hook, judge veto rate, surrounding infrastructure)
- Existing codebase (`src/orchestrator/`) — HIGH confidence, first-party source for current interfaces and contracts

---
*Architecture research for: Claude Agent SDK migration — background coding agent*
*Researched: 2026-03-16*
