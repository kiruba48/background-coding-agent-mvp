# Stack Research

**Domain:** Claude Agent SDK migration — background-coding-agent v2.0
**Researched:** 2026-03-16
**Confidence:** HIGH — primary sources are official Anthropic docs and live npm registry data

---

## Scope

This file covers ONLY new stack additions and removals required for the v2.0 Claude Agent SDK migration.
Validated existing dependencies (Node.js 20, TypeScript ESM/NodeNext, Commander.js, Pino, Vitest, ESLint v10,
Octokit, simple-git, write-file-atomic) are not re-researched here.

---

## Existing Dependencies: What Changes

| Dependency | Current Version | v2.0 Action | Reason |
|------------|-----------------|-------------|--------|
| `@anthropic-ai/sdk` | ^0.71.2 | **Remove** | Replaced entirely by Agent SDK |
| `dockerode` | ^4.0.2 | **Remove** | Host no longer manages Docker programmatically |
| `@types/dockerode` | ^3.3.36 | **Remove** | Removed with dockerode |

All other existing dependencies are unchanged.

---

## New Stack Additions

### Core: Claude Agent SDK

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| `@anthropic-ai/claude-agent-sdk` | `^0.2.76` | Replaces `AgentSession` + `AgentClient` — provides `query()` agentic loop, 9 built-in tools, auto context compression, hooks API, native MCP server creation | Official Anthropic SDK. Validated by Spotify ("Honk" agent) as their top-performing engine across ~50 migrations. Eliminates ~1,200 lines of hand-built infrastructure. Bundles Claude Code CLI as part of its runtime — no separate install in source code. |

**Version rationale:** 0.2.76 is the latest as of 2026-03-14 (npm). The SDK is in rapid development at 0.x. Pin to `^0.2.76` to receive patch fixes while controlling minor version upgrades manually.

**What it replaces in this codebase:**

| Deleted file | Lines | Agent SDK equivalent |
|---|---|---|
| `orchestrator/agent.ts` | 273 | Built-in agentic loop (automatic tool use iterations) |
| `orchestrator/session.ts` | 667 | `query()` function handles session lifecycle, turn limits, abort |
| `orchestrator/container.ts` | ~200 | Container strategy moves to Dockerfile (see Docker section) |
| `@anthropic-ai/sdk` import | n/a | All LLM calls route through Agent SDK |
| `dockerode` import | n/a | No programmatic container management on host |

**Built-in capabilities (zero additional packages):**

- Tools: Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch, AskUserQuestion
- `createSdkMcpServer()` — creates in-process MCP servers (Phase 12 verifier server)
- `tool()` — type-safe MCP tool definitions with Zod schema input validation
- Hooks: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PermissionRequest`, and more
- Auto context compression at window boundary
- `maxTurns`, `maxBudgetUsd` — native turn/cost limits (replace manual turn counter)
- `SDKResultMessage` with `total_cost_usd`, `num_turns`, `stop_reason`, `usage` — native metrics

### Zod (Phase 12 only — MCP verifier server)

| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `zod` | `^3.24.x` | Schema validation for `tool()` input parameters | Required by Agent SDK's `tool()` function, which takes `AnyZodRawShape` as its schema parameter. Only needed if implementing the MCP verifier server in Phase 12. |

**Note:** Zod may already be a transitive dependency. Check `node_modules/zod/package.json` before adding explicitly. If implementing Phase 12, add it explicitly to lock the version and prevent relying on transitive resolution.

**Version choice:** Agent SDK docs state "supports both Zod 3 and Zod 4." Use Zod 3 (`^3.24.x`) — broader ecosystem compatibility and avoids migration risk.

---

## MCP Server Strategy

The Agent SDK ships `createSdkMcpServer()` and `tool()` built-in for creating in-process MCP servers. This means `@modelcontextprotocol/sdk` (current version: 1.27.1 on npm) is NOT needed as a separate dependency.

**The in-process MCP pattern (Phase 12):**

```typescript
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const verifyTool = tool(
  "verify",
  "Run composite verifier (build, test, lint) on the current working directory",
  { cwd: z.string() },
  async ({ cwd }) => {
    const result = await compositeVerifier(cwd);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
);

const verifierServer = createSdkMcpServer({
  name: "verifier",
  version: "1.0.0",
  tools: [verifyTool]
});

for await (const msg of query({
  prompt: "...",
  options: {
    cwd: repoPath,
    mcpServers: {
      verifier: { type: "sdk", name: "verifier", instance: verifierServer.instance }
    }
  }
})) { ... }
```

The `type: "sdk"` transport is in-process — no subprocess, no stdio, no HTTP server. The verifier's TypeScript code runs directly in the same Node.js process as the orchestrator.

---

## Docker Strategy Changes

### What Changes

**Before (v1.1):** Host Node.js process manages Docker via `dockerode`. Container runs custom Alpine 3.18 image with agent tools baked in. Host orchestrates exec calls into container.

**After (v2.0):** Host Node.js process calls `query()`. Agent SDK spawns Claude Code as a subprocess on the host. For production isolation, the entire orchestrator runs inside a Docker container — managed by `docker run`, not by `dockerode`.

### Two Deployment Modes

**Mode A: Host-process (development, CI)**

Run `query()` directly on the host. No Docker required. Use `disallowedTools` for safety:

```typescript
for await (const msg of query({
  prompt: taskPrompt,
  options: {
    cwd: repoPath,
    permissionMode: "acceptEdits",
    disallowedTools: ["WebSearch", "WebFetch"],
    maxTurns: 10
  }
})) { ... }
```

**Mode B: Container isolation (production)**

Run the Node.js orchestrator process itself inside a Docker container. The orchestrator calls `query()`, which spawns Claude Code as a subprocess within that same container. Network isolation is enforced at the container level.

```dockerfile
# New Dockerfile for v2.0 — replaces Alpine 3.18 agent image
FROM node:20-alpine

# Claude Code CLI is required by the Agent SDK at runtime
RUN npm install -g @anthropic-ai/claude-code

# Install orchestrator
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY dist/ ./dist/

# Repo is mounted at runtime via -v
WORKDIR /workspace

ENTRYPOINT ["node", "/app/dist/cli/index.js"]
```

```bash
docker run \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --network none \
  --memory 2g \
  --cpus 2 \
  --pids-limit 200 \
  --user 1000:1000 \
  -v /path/to/repo:/workspace:rw \
  -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  background-agent-v2
```

**Key difference from v1.1:** `dockerode` is no longer needed. The container lifecycle is managed externally (by CI/CD scripts or the CLI's caller) — not by the orchestrator code itself.

**Network constraint:** With `--network none`, the Agent SDK subprocess cannot reach `api.anthropic.com`. Two approaches:
1. **(v2.0 MVP)** Use `--network bridge` + outbound firewall rules restricted to `api.anthropic.com:443`
2. **(v2.1 hardening)** Mount a Unix proxy socket, set `ANTHROPIC_BASE_URL` to proxy — allows `--network none` while API calls route through an allowlisted proxy outside the container

**Claude Code CLI requirement:** The Agent SDK requires the Claude Code CLI installed in the runtime environment. Official docs state: `npm install -g @anthropic-ai/claude-code`. Validate during Phase 13 whether the Agent SDK bundles the binary or requires a separate global install.

---

## Core API Surface Reference

The `query()` function is the only integration point from `RetryOrchestrator`:

```typescript
function query({
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}): Query; // AsyncGenerator<SDKMessage, void> + control methods
```

**Key `Options` fields for this project:**

| Option | Type | Use |
|--------|------|-----|
| `cwd` | `string` | Set to target repo path (replaces container volume mount) |
| `permissionMode` | `"acceptEdits" \| "bypassPermissions" \| "default"` | Use `"acceptEdits"` to auto-approve file edits without prompting |
| `maxTurns` | `number` | Replaces manual turn counter — set to 10 |
| `maxBudgetUsd` | `number` | Optional cost cap per session |
| `allowedTools` | `string[]` | Auto-approve these tools (subset of built-in tools) |
| `disallowedTools` | `string[]` | Block these tools — use to restrict network access on host-mode |
| `hooks` | `Partial<Record<HookEvent, HookCallbackMatcher[]>>` | Attach `Stop` hook for post-agent verification; `PostToolUse` for audit logging |
| `mcpServers` | `Record<string, McpServerConfig>` | Wire in-process verifier server (Phase 12) |
| `settingSources` | `SettingSource[]` | Default `[]` = no filesystem settings loaded. Set `["project"]` to load CLAUDE.md |
| `abortController` | `AbortController` | Timeout signal (replaces 5-minute session timeout) |

**Result message** (the terminal event to collect from `query()`):

```typescript
type SDKResultMessage =
  | { type: "result"; subtype: "success"; total_cost_usd: number; num_turns: number; result: string; ... }
  | { type: "result"; subtype: "error_max_turns" | "error_during_execution" | ...; errors: string[]; ... };
```

`subtype: "error_max_turns"` replaces the current `TurnLimitError`. `total_cost_usd` and `num_turns` feed `SessionMetrics` natively.

**Hook types used in this project:**

| Hook | Use Case |
|------|----------|
| `PostToolUse` with matcher `"Edit\|Write"` | Audit logging — log every file modified |
| `Stop` | Trigger verification before session completes (Spotify pattern — optional for v2.0) |

---

## Integration Points with Existing Code

**`orchestrator/retry.ts` (Modify — Phase 10)**

Replace `new AgentSession(prompt, options).run()` with:

```typescript
import { query, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

let resultMsg: SDKResultMessage | undefined;
for await (const msg of query({ prompt, options: { cwd, maxTurns: 10, permissionMode: "acceptEdits" } })) {
  if (msg.type === "result") resultMsg = msg;
}
// resultMsg.total_cost_usd, resultMsg.num_turns, resultMsg.subtype feed SessionResult
```

**`orchestrator/judge.ts` (Flag for Phase 11)**

The Judge currently imports `@anthropic-ai/sdk` directly for structured output LLM calls. After removing `@anthropic-ai/sdk`, the Judge needs assessment:
- Option A: Rewrite Judge to use `query()` with `outputFormat` structured output option
- Option B: Keep `@anthropic-ai/sdk` as a dev/peer dependency solely for Judge LLM calls
- Option C: Use Agent SDK's `query()` with a constrained prompt that returns JSON

This is a Phase 11 implementation decision. Flag it early to avoid a late-phase blocker.

**All other orchestrator files:** No changes required (`verifier.ts`, `summarizer.ts`, `pr-creator.ts`, `metrics.ts`, `prompts/`).

---

## Installation

```bash
# Add Agent SDK
npm install @anthropic-ai/claude-agent-sdk

# Add Zod only if implementing Phase 12 MCP verifier server
npm install zod

# Remove replaced dependencies
npm uninstall @anthropic-ai/sdk dockerode
npm uninstall -D @types/dockerode
```

---

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| `@anthropic-ai/claude-agent-sdk` `query()` | Keep custom `AgentSession` + `@anthropic-ai/sdk` | Never for this migration — the goal is to delete infrastructure, not maintain two systems in parallel |
| `createSdkMcpServer()` built into Agent SDK | `@modelcontextprotocol/sdk` as separate dependency | Only if verifier MCP server must run as a separate process (stdio transport) or be shared across multiple projects. Unnecessary for in-process pattern. |
| Container wraps orchestrator (Mode B) | `spawnClaudeCodeProcess` custom function | `spawnClaudeCodeProcess` is designed for advanced cases: VMs, remote environments, custom runtimes. Container wrapping achieves the same isolation with less code. |
| `--network bridge` + firewall (v2.0 MVP) | `--network none` + proxy socket | Proxy pattern is more secure but adds operational complexity. Fine for v2.1 hardening, too much for v2.0. |
| `@anthropic-ai/sandbox-runtime` | Docker + `--network none` | sandbox-runtime is lighter and simpler (uses OS-level bubblewrap/sandbox-exec). Docker gives stronger isolation matching the existing v1.1 model. Consider sandbox-runtime if Docker overhead is a concern in v2.1+. |

---

## What NOT to Add

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| `@modelcontextprotocol/sdk` | Built into Agent SDK as `createSdkMcpServer()` | Agent SDK's `tool()` + `createSdkMcpServer()` |
| Keep `@anthropic-ai/sdk` alongside Agent SDK | Two packages owning LLM calls causes confusion and version drift | Migrate Judge to Agent SDK in Phase 11 (see integration points above) |
| Keep `dockerode` | Container management moves from code to Dockerfile + docker CLI. Programmatic container management no longer needed on the host. | Dockerfile + `docker run` in CI/CD |
| LangChain / LangGraph | Unnecessary abstraction — Agent SDK provides the complete agent loop | `query()` + hooks |
| Custom tool implementations | Agent SDK built-in tools (Read, Write, Edit, Bash, Glob, Grep) replace all 6 hand-built tools | `allowedTools` / `disallowedTools` options |

---

## Version Compatibility

| Package | Compatible With | Notes |
|---------|-----------------|-------|
| `@anthropic-ai/claude-agent-sdk@^0.2.76` | Node.js 18+ | Node.js 20 (project standard) fully supported |
| `@anthropic-ai/claude-agent-sdk@^0.2.76` | TypeScript ^5.7.2 | SDK ships its own type declarations — no `@types/` package needed |
| `zod@^3.24.x` | Agent SDK `tool()` | SDK docs: "supports both Zod 3 and Zod 4"; Zod 3 has broader ecosystem compatibility |
| Agent SDK | `@anthropic-ai/sdk` | Do NOT run both simultaneously — they conflict on LLM call ownership |

---

## Sources

- [Agent SDK TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript) — `query()` signature, `Options` type, `HookEvent` types, `McpServerConfig`, `PermissionMode`, `SDKResultMessage` (HIGH confidence — official Anthropic docs, verified 2026-03-16)
- [Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview) — Built-in tools list, SDK vs Client SDK comparison, Zod version compatibility (HIGH confidence — official Anthropic docs, verified 2026-03-16)
- [Hosting the Agent SDK](https://platform.claude.com/docs/en/agent-sdk/hosting) — Container deployment patterns, system requirements, Claude Code CLI runtime dependency (HIGH confidence — official Anthropic docs, verified 2026-03-16)
- [Securely Deploying AI Agents](https://platform.claude.com/docs/en/agent-sdk/secure-deployment) — Docker hardening flags, `--network none` with Unix socket proxy pattern, gVisor option (HIGH confidence — official Anthropic docs, verified 2026-03-16)
- [GitHub anthropics/claude-agent-sdk-typescript](https://github.com/anthropics/claude-agent-sdk-typescript) — Package name `@anthropic-ai/claude-agent-sdk`, version 0.2.76 (HIGH confidence — official Anthropic GitHub, verified 2026-03-16)
- npm registry (via WebSearch) — `@anthropic-ai/claude-agent-sdk` version 0.2.76 as of 2026-03-14; `@modelcontextprotocol/sdk` version 1.27.1 as of late February 2026 (MEDIUM confidence — reported by search results, npm pages returned 403)

---
*Stack research for: Claude Agent SDK migration (background-coding-agent v2.0)*
*Researched: 2026-03-16*
