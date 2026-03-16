# Feature Landscape: Claude Agent SDK Migration

**Domain:** Claude Agent SDK migration for background coding agent (v2.0)
**Researched:** 2026-03-16
**Confidence:** HIGH (all features verified against official Agent SDK documentation)

## Context

This replaces the v1.0/v1.1 platform feature landscape. This file focuses exclusively
on what the Claude Agent SDK provides — what we gain in the migration, what maps to
existing infrastructure, what is new capability, and what to explicitly not adopt.

Existing shipped features (unchanged): Docker sandbox, retry orchestrator, composite
verifier, LLM Judge, PR creator, Maven/npm prompts, structured logging. This research
covers what the Agent SDK adds on top of that foundation.

---

## Table Stakes

Features users expect from any production Agent SDK integration. Missing these means
the migration is worse than the current custom loop.

| Feature | Why Expected | Complexity | Status | Notes |
|---------|--------------|------------|--------|-------|
| **query() replaces AgentSession** | Same interface, less code | Low | New | Drop-in replacement for the custom agentic loop |
| **Built-in tool: Read** | File reading without custom implementation | Low | Replace | Replaces hand-built `read_file` tool |
| **Built-in tool: Write** | File creation without custom implementation | Low | Replace | Replaces hand-built `edit_file` for new files |
| **Built-in tool: Edit** | Precise file patching without uniqueness checks | Low | Replace | Replaces `str_replace` + custom uniqueness logic |
| **Built-in tool: Bash** | Shell execution without allowlist reimplementation | Medium | Replace | Replaces `bash_command` with allowlist; SDK provides `disallowedTools` for blocking |
| **Built-in tool: Glob** | File pattern matching without custom implementation | Low | Replace | Replaces `list_files` tool |
| **Built-in tool: Grep** | Regex search without custom implementation | Low | Replace | Replaces `grep` tool |
| **maxTurns option** | Turn limit to cap cost | Low | Replace | Replaces manual turn counter in `AgentSession` |
| **permissionMode: acceptEdits** | Auto-approve file changes for background agent | Low | New config | Removes need to intercept every file write permission |
| **allowedTools / disallowedTools** | Declarative tool surface control | Low | New config | Replaces runtime allowlist checking in bash_command |
| **cwd option** | Set working directory for the session | Low | New config | Replaces container working directory setup |
| **systemPrompt option** | Inject system-level instructions | Low | Replace | Replaces system prompt construction in `AgentSession` |
| **Auto context compression** | Prevent context window overflow | Low | New (free) | Handled automatically; replaces PreCompact planning |
| **Structured output via result messages** | Capture final result text | Low | New | `message.type === "result"` provides final answer |

### Rationale

These are table stakes because the migration's primary value is deleting code, not
gaining capability. If the SDK cannot replicate what `AgentSession` already does,
the migration adds risk without payoff. Everything in this table has been verified
in official Agent SDK docs (HIGH confidence).

---

## Differentiators

Features the Agent SDK provides that we do not have today and that increase
capability, safety, or observability.

| Feature | Value Proposition | Complexity | Dependencies | Notes |
|---------|-------------------|------------|--------------|-------|
| **PostToolUse audit hook** | Log every file change to audit trail without custom tool interception | Low | None | `PostToolUse` with `Edit|Write` matcher; replaces brittle custom logging in tool handlers |
| **PreToolUse safety hook** | Block dangerous operations (writes outside repo, .env files) | Low | None | `permissionDecision: "deny"` replaces Docker volume mount restrictions as primary safety layer |
| **Stop hook for verification** | Trigger composite verifier at end of agent session without separate orchestration call | Medium | Composite verifier | Spotify's pattern: agent finishes, Stop hook runs verification, result injected back via `systemMessage` or signals retry |
| **MCP verifier server (in-process)** | Expose composite verifier as `mcp__verifier__verify` tool so agent self-verifies mid-session | High | createSdkMcpServer + compositeVerifier | Spotify's exact pattern; agent calls verify tool, gets error feedback, corrects before Stop |
| **WebSearch built-in tool** | Agent can look up changelog/release notes during dependency update | Medium | Network access (disable in Docker) | Available in non-sandboxed runs; disable via `disallowedTools: ["WebSearch"]` in isolation mode |
| **AskUserQuestion tool** | Agent pauses and asks human for clarification on ambiguous choices | Medium | CLI streaming mode | Enables human-in-the-loop without webhook infrastructure; breaks background model, use carefully |
| **Session resume** | Continue a session after interruption or across retry attempts | Medium | session_id tracking | `options.resume = sessionId`; potential for richer retry context than fresh-session-per-retry |
| **Subagents (Agent tool)** | Spawn specialized sub-agents for subtasks | High | Agent tool in allowedTools | Parallel subtask execution; defer until core migration complete |
| **File checkpointing + rewind** | Restore files to state at specific turn | High | enableFileCheckpointing | `rewindFiles(messageId)`; alternative to git-based rollback in retry loop |
| **spawnClaudeCodeProcess hook** | Custom process spawning — point at Docker container | Medium | Docker | `spawnClaudeCodeProcess: (opts) => spawnInDocker(opts)` is the isolation strategy for production |
| **Budget cap: maxBudgetUsd** | Hard USD cap per session | Low | None | Complements maxTurns; prevents runaway cost |
| **Effort control** | `effort: 'low' | 'medium' | 'high' | 'max'` adjusts thinking depth | Low | None | Use 'high' for dependency updates; 'low' for exploration/planning turns |

### Differentiator Deep Dive

**PostToolUse audit hook** — replaces the brittle approach of logging inside each
custom tool handler. One hook with matcher `"Edit|Write"` captures all file changes
with file path, session ID, and timestamp. Add to `./audit.log` or feed into Pino.
Complexity: ~15 lines of TypeScript. HIGH value, LOW effort.

**Stop hook for verification** — the Spotify pattern. When the agent stops, the Stop
hook fires. The hook can: (1) run `compositeVerifier` synchronously, (2) if it fails,
return `systemMessage` with error digest and `continue: true` to restart the agent, or
(3) if it passes, return `{}` to let the session complete. This merges the Stop hook
with the existing `RetryOrchestrator` logic. Requires care: `continue: true` from a
Stop hook restarts execution, meaning the retry counter must be managed externally to
prevent infinite loops. The current `RetryOrchestrator` wrapping `query()` is simpler
and safer than this pattern for our use case.

**MCP verifier server** — `createSdkMcpServer` runs in-process with no separate
server process. Tool definition: `verify(args: {repoPath: string})` calls
`compositeVerifier(repoPath)` and returns `{success, errors}` as text. The agent
calls `mcp__verifier__verify` mid-session to check progress before final Stop.
This is Spotify's exact architecture. Complexity: Medium (MCP server wrapping
existing verifier, plus streaming input requirement for custom tools).

**spawnClaudeCodeProcess** — the production isolation strategy. Instead of running
the Agent SDK in the host process, pass a custom spawn function that starts a Docker
container and pipes stdio. The SDK communicates with Claude Code running inside the
container. This replaces the current `ContainerManager` with a much simpler stdio
bridge. Complexity: Medium (Docker stdio bridge, replacing ~200 lines in container.ts).

---

## Anti-Features

Features the Agent SDK provides that we must explicitly avoid in this migration.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| **bypassPermissions mode** | Grants full system access; subagents inherit it | Use `acceptEdits` + `disallowedTools` for targeted bypass |
| **WebSearch/WebFetch in Docker** | Network-isolated containers break these tools; agent wastes turns trying | Set `disallowedTools: ["WebSearch", "WebFetch"]` in sandbox runs |
| **AskUserQuestion in batch mode** | Blocks background execution waiting for human input | Omit from `allowedTools`; agent must work autonomously |
| **Session resume for retry** | Context accumulation across retries causes scope drift | Keep fresh session per retry (existing pattern); do not use `resume` in retry loop |
| **settingSources: ["user"]** | Loads ~/.claude/settings.json from host — imports operator's personal config into agent | Keep `settingSources: []` (default) for isolation |
| **Multi-agent subagents for v2.0** | Adds complexity to the core migration; current tasks don't need parallelism | Defer Agent tool to v2.1+; single-agent loop sufficient |
| **plan mode** | Prevents execution; agent cannot make changes | Never use in production runs; only for testing/dry-runs |
| **enableFileCheckpointing** | Adds overhead; we already have git-based rollback | Keep git as the source of truth for rollback |
| **promptSuggestions** | Emits predicted next prompts; irrelevant for background agent | Leave disabled (default false) |
| **continue: true in Stop hook** | Restarts agent execution from Stop hook — can create infinite loops if retry counter not managed | Use `RetryOrchestrator` wrapping `query()` instead; cleaner boundary |

### Anti-Feature Rationale

**WebSearch/WebFetch in Docker**: These tools make outbound HTTP calls. Docker with
`NetworkMode: none` will cause them to fail silently or throw errors, wasting agent
turns. Explicit `disallowedTools` prevents the agent from attempting them. For
future non-sandboxed runs, WebSearch can be enabled to look up changelogs.

**Session resume for retry**: The existing RetryOrchestrator creates a fresh session
per retry with a summarized error digest injected into the prompt. This prevents
context accumulation where previous failed attempts pollute the current attempt's
context. The Agent SDK's `resume` feature is the opposite pattern — explicitly do
not use it in the retry loop.

**continue: true in Stop hook**: Tempting pattern for self-retry, but the boundary
between "agent loop" and "retry orchestration" must stay clean. The Stop hook is for
side effects (logging, verification reporting). Retry logic belongs in
`RetryOrchestrator`. Mixing them creates race conditions with the max-retry counter.

---

## Feature Dependencies

Agent SDK feature dependency graph for the v2.0 implementation:

```
query() + allowedTools + permissionMode: acceptEdits
    ↓
Replace AgentSession + AgentClient (delete ~940 lines)
    ↓
disallowedTools: ["WebSearch", "WebFetch"] + maxTurns
    ↓
PostToolUse audit hook (15 lines)
    ↓
[PHASE 10: CORE MIGRATION COMPLETE]
    ↓
├─→ spawnClaudeCodeProcess → Docker stdio bridge
│       Replaces ContainerManager (delete ~200 lines)
│       [PHASE 13: CONTAINER STRATEGY]
│
├─→ createSdkMcpServer → MCP verifier server
│       Exposes compositeVerifier as mcp__verifier__verify
│       Requires streaming input mode for query()
│       [PHASE 12: MCP VERIFIERS — optional]
│
└─→ PreToolUse safety hook (optional enhancement)
        Block writes outside repo path
        Complements permission mode
        [PHASE 10 or 12, low effort]
```

### Critical Path for v2.0

Phase 10 (core migration) is the blocking path. Everything else is additive. The
MCP verifier server (Phase 12) is optional — the existing outer verification loop
in `RetryOrchestrator` already works. MCP verifier enables in-session self-correction,
which increases success rate but is not required for correctness.

---

## MVP Recommendation

For Phase 10 (Agent SDK Integration), prioritize:

1. **query() with allowedTools + permissionMode + maxTurns** — core replacement
2. **disallowedTools: ["WebSearch", "WebFetch"]** — sandbox safety
3. **PostToolUse audit hook** — replaces existing tool-level logging, low effort
4. **PreToolUse safety hook** — block writes to .env/git internals, ~20 lines

Defer to Phase 12 (optional):
- MCP verifier server — increases mid-session self-correction
- Stop hook integration — exploratory; keep RetryOrchestrator as primary retry mechanism

Defer to Phase 13:
- spawnClaudeCodeProcess with Docker bridge — production isolation strategy

Never adopt:
- bypassPermissions mode
- Session resume in retry loop
- AskUserQuestion in batch mode

---

## SDK Features Summary by Migration Phase

| Phase | Agent SDK Features Used | Lines Deleted | Lines Added |
|-------|------------------------|---------------|-------------|
| Phase 10: Core | `query()`, `allowedTools`, `permissionMode`, `maxTurns`, `disallowedTools`, `PostToolUse hook` | ~940 (agent.ts + session.ts) | ~50 (ClaudeCodeSession wrapper) |
| Phase 11: Delete | Remove `container.ts`, Docker image, stale tests | ~200 + ~650 tests | New integration tests |
| Phase 12: MCP | `createSdkMcpServer`, `tool()`, streaming prompt | 0 (additive) | ~100 (verifier MCP server) |
| Phase 13: Container | `spawnClaudeCodeProcess` with Docker stdio | ~200 (container.ts already deleted in Phase 11) | ~50 (Docker spawn bridge) |

**Net result:** ~1,800 lines deleted, ~200 lines added. 90% reduction in agent infrastructure code.

---

## Confidence Assessment

| Area | Confidence | Source | Notes |
|------|------------|--------|-------|
| Built-in tools (Read, Write, Edit, Bash, Glob, Grep) | HIGH | Official Agent SDK docs (verified) | Exact tool names confirmed |
| Hooks (PreToolUse, PostToolUse, Stop) | HIGH | Official Agent SDK hooks docs (verified) | Input/output types confirmed |
| Permission modes (acceptEdits, dontAsk, bypassPermissions) | HIGH | Official Agent SDK permissions docs (verified) | Mode semantics confirmed |
| MCP verifier pattern (createSdkMcpServer) | HIGH | Official Agent SDK custom tools docs (verified) | Streaming input requirement confirmed |
| spawnClaudeCodeProcess for Docker | MEDIUM | Official docs (option exists, confirmed); Docker stdio bridge implementation detail | Implementation pattern inferred from docs, not shown in examples |
| Stop hook for verification (Spotify pattern) | MEDIUM | Spotify blog + SDK docs combined | continue: true behavior in Stop hook not tested against our retry loop |
| Session resume anti-pattern rationale | MEDIUM | Architectural inference from existing RetryOrchestrator design | Not a documented anti-pattern; reasoned from context accumulation risk |

---

## Sources

- [Claude Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview) — HIGH confidence, official docs
- [Hooks Reference](https://platform.claude.com/docs/en/agent-sdk/hooks) — HIGH confidence, official docs
- [Permissions Reference](https://platform.claude.com/docs/en/agent-sdk/permissions) — HIGH confidence, official docs
- [MCP Integration](https://platform.claude.com/docs/en/agent-sdk/mcp) — HIGH confidence, official docs
- [Custom Tools (createSdkMcpServer)](https://platform.claude.com/docs/en/agent-sdk/custom-tools) — HIGH confidence, official docs
- [TypeScript SDK Reference](https://platform.claude.com/docs/en/agent-sdk/typescript) — HIGH confidence, official docs
- [Spotify Honk Architecture Blog](https://engineering.atspotify.com/2025/11/spotifys-background-coding-agent-part-1) — MEDIUM confidence, third-party but architectural reference
