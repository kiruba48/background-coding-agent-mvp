# Project Research Summary

**Project:** background-coding-agent v2.0 — Claude Agent SDK migration
**Domain:** Background coding agent infrastructure migration
**Researched:** 2026-03-16
**Confidence:** HIGH

## Executive Summary

This project is a surgical migration of an existing, production-grade background coding agent (v1.1) from a custom hand-built agentic loop to the official Claude Agent SDK. The system already works — the RetryOrchestrator, compositeVerifier, LLM Judge, and PR creator are all proven and unchanged. The migration's sole goal is deleting ~1,200 lines of home-grown agent infrastructure (AgentSession, AgentClient, ContainerManager) and replacing them with ~50 lines that call the SDK's `query()` function. The net result is a 90% reduction in agent infrastructure code while gaining battle-tested capabilities: built-in tool loop, auto context compression, native hooks API, and MCP server support.

The recommended approach is a four-phase incremental migration modeled directly on Spotify's "Honk" architecture — the top-performing agent in Spotify's 50-agent benchmark. Phase 10 creates a thin `AgentSdkSession` wrapper that satisfies the existing `SessionResult` interface so no other code changes. Phase 11 deletes the legacy files only after Phase 10 is green. Phase 12 optionally adds an in-process MCP verifier server that lets the agent self-correct mid-session. Phase 13 updates the container strategy to run the SDK process inside Docker with proper network isolation.

The primary risk is not the migration itself — the interface swap is a single line change in `retry.ts` — but the security guarantees that must be preserved. Network isolation, which today is enforced by Docker's `NetworkMode: none`, requires a proxy architecture in the new model because the Agent SDK must reach `api.anthropic.com`. Developers commonly drop `--network none` to "make the SDK work," silently eliminating the isolation guarantee. Every security constraint from v1.1 must be explicitly re-established in the new stack, not assumed to carry over.

---

## Key Findings

### Recommended Stack

The migration adds exactly one new dependency to the production codebase: `@anthropic-ai/claude-agent-sdk@^0.2.76`. This replaces `@anthropic-ai/sdk` and `dockerode`, which are both removed. Zod (`^3.24.x`) is only added if Phase 12's MCP verifier server is implemented — check whether it is already a transitive dependency before adding explicitly.

The Agent SDK bundles Claude Code CLI as its runtime. No custom tool implementations are needed: the SDK's built-in Read, Write, Edit, Bash, Glob, and Grep tools replace all six hand-built tools in the current codebase. Programmatic Docker management (`dockerode`) is eliminated — container lifecycle moves to a `docker run` call in CI/CD or a `spawnClaudeCodeProcess` hook in the SDK options.

**Core technologies:**
- `@anthropic-ai/claude-agent-sdk@^0.2.76`: replaces AgentSession + AgentClient + all custom tools — official Anthropic SDK, validated by Spotify as top-performing agent engine across ~50 comparisons
- `zod@^3.24.x` (Phase 12 only): schema validation for MCP tool definitions — Zod 3 preferred for broader ecosystem compatibility
- Docker (runtime, not an npm dep): container wraps the orchestrator process in production — `--network none` + proxy socket for API access

**Removed dependencies:**
- `@anthropic-ai/sdk` — replaced entirely by Agent SDK
- `dockerode` + `@types/dockerode` — container management moves outside the codebase

### Expected Features

The migration's table stakes are pure replacements: `query()` replaces the agentic loop, `maxTurns` replaces the manual turn counter, `permissionMode: "acceptEdits"` replaces per-file write permission interception, and built-in tools replace all six custom tool implementations. If any of these replacements regresses current behavior, the migration is a failure.

The differentiators that increase capability above v1.1: PostToolUse audit hook (replaces brittle tool-level logging in ~15 lines), PreToolUse safety hook (blocks writes to .env/git internals), MCP verifier server (exposes compositeVerifier as `mcp__verifier__verify` so the agent self-corrects mid-session), and scoped Bash rules (`Bash(git:*)`) that replace the previous hardcoded bash allowlist.

**Must have (table stakes):**
- `query()` replaces `AgentSession.run()` — same contract, SDK manages loop
- Built-in tools (Read, Write, Edit, Bash, Glob, Grep) — replace all six custom tools
- `maxTurns: 10` — replaces manual turn counter, maps to `turn_limit` status
- `permissionMode: "acceptEdits"` — auto-approves file edits, no prompt friction
- `disallowedTools: ["WebSearch", "WebFetch"]` — enforces network isolation at tool layer
- Explicit `systemPrompt` configuration — SDK default changed in v0.1.0; must set explicitly

**Should have (differentiators):**
- PostToolUse audit hook — unified file-change logging, ~15 lines, replaces per-tool logging
- Scoped Bash rules (`Bash(git:*)`) — replaces hardcoded bash allowlist with declarative surface
- PreToolUse safety hook — blocks writes outside workspace, ~20 lines
- MCP verifier server (Phase 12) — in-session self-correction, Spotify's exact pattern

**Defer (v2.1+):**
- Subagents (Agent tool) — adds complexity; current tasks don't need parallelism
- Session resume for retries — explicitly an anti-pattern; fresh session per retry is correct
- `--network none` + Unix proxy socket — Phase 13 MVP uses `--network bridge` + firewall rules; full proxy is v2.1 hardening
- `@anthropic-ai/sandbox-runtime` — lighter alternative to Docker; evaluate if container overhead is a concern

**Never adopt:**
- `bypassPermissions` mode — full system access; dangerous without verified container isolation
- `settingSources: ["project"]` — loads CLAUDE.md from untrusted target repo; prompt injection vector
- `AskUserQuestion` in batch mode — blocks background execution

### Architecture Approach

The migration is a wrapper-swap, not a rewrite. `AgentSdkSession` (~50 lines) wraps `query()` and returns the same `SessionResult` interface that `AgentSession` returns today. The single change in `retry.ts` is one line: `new AgentSession(config)` becomes `new AgentSdkSession(config)`. All other components — RetryOrchestrator, compositeVerifier, llmJudge, ErrorSummarizer, GitHubPRCreator, and all prompt builders — are untouched. Two architectural patterns govern the design: outer verification in RetryOrchestrator is always the authoritative quality gate (hooks are supplementary, not primary), and fresh session per retry prevents context contamination from failed attempts.

**Major components:**
1. `AgentSdkSession` (new, ~50 lines) — thin `query()` wrapper; maps `SDKResultMessage` subtypes to `SessionResult`; manages `AbortController` timeout
2. `RetryOrchestrator` (unchanged) — outer verify/retry loop; remains the authoritative quality gate
3. `compositeVerifier` (unchanged) — build/test/lint; exposed optionally as MCP server in Phase 12
4. `llmJudge` (unchanged) — diff scope check; dependency on `@anthropic-ai/sdk` must be resolved in Phase 11
5. `mcp/verifier-server.ts` (new, Phase 12 only, ~30 lines) — wraps compositeVerifier as `mcp__verifier__verify` tool

### Critical Pitfalls

1. **Network isolation silently removed** — Phase 13 container must implement proxy architecture (`ANTHROPIC_BASE_URL` + Unix socket), not just add `--network bridge`. Warning sign: Dockerfile passes `ANTHROPIC_API_KEY` directly into container env. Prevention: proxy pattern routes API calls through an allowlisted proxy outside the container.

2. **`allowedTools` misunderstood as a blocklist** — `allowedTools` is an auto-approval list, not a restriction. Without `disallowedTools: ["WebSearch", "WebFetch", "Agent"]`, those tools can run. Always pair both lists; use `permissionMode: "dontAsk"` to deny anything not in `allowedTools`.

3. **`SessionResult` mapping breaks on SDK result types** — `error_max_turns` must map to `status: "turn_limit"` (terminal, no retry), not `"failed"`. Wrong mapping wastes money retrying exhausted-turn sessions. Write explicit unit tests for all four `ResultMessage` subtype to `SessionResult.status` mappings before connecting to `RetryOrchestrator`.

4. **Big-bang deletion leaves adapter untested** — Phase 11 deletes ~1,200 lines. Without writing tests for `AgentSdkSession` first, the adapter's mapping behavior goes untested. Write wrapper tests in Phase 10; delete old tests in Phase 11 only after new tests cover the same behaviors.

5. **Unbounded Bash tool capability** — `"Bash"` in `allowedTools` runs any shell command. Use scoped rules: `"Bash(git:*)"`, `"Bash(npm install)"`. The previous system scoped bash at tool-definition time; the SDK requires explicit scoping in `allowedTools`.

---

## Implications for Roadmap

Based on research, the migration follows a strict dependency chain with two independent parallel tracks after Phase 11.

### Phase 10: Agent SDK Core Integration
**Rationale:** This is the blocking path. Everything downstream depends on `AgentSdkSession` existing and working. Must be done first, must be incremental (wrapper-swap, not rewrite), and must establish security defaults correctly from day one.
**Delivers:** Working `AgentSdkSession` that satisfies `SessionResult` contract; all existing RetryOrchestrator tests still pass; `query()` drives the agent loop.
**Addresses:** All table-stakes features — `query()`, built-in tools, `maxTurns`, `permissionMode: "acceptEdits"`, `disallowedTools`, `systemPrompt`, PostToolUse audit hook, scoped Bash rules.
**Avoids:** `bypassPermissions` misuse (use `acceptEdits` from day one), `allowedTools` misconfiguration (pair with `disallowedTools`), wrong `SessionResult` mapping (write explicit mapping tests), `settingSources` loading hostile configs (omit by default and document why), unbounded Bash (use scoped rules), hooks used for critical cleanup (put cleanup in `finally` block).

### Phase 11: Legacy Deletion
**Rationale:** Cannot delete legacy code until Phase 10 is green and verified. Deleting before the wrapper works leaves the system broken. Deleting after ensures the replacement is confirmed.
**Delivers:** Removal of `agent.ts` (273 lines), `session.ts` (667 lines), `container.ts` (~200 lines), their tests (~650 lines). Resolution of `@anthropic-ai/sdk` dependency for the LLM Judge (decision: migrate Judge to Agent SDK `query()` with structured output, or keep `@anthropic-ai/sdk` solely for Judge calls). Removal of `dockerode` from package.json.
**Avoids:** Test coverage gap (wrapper tests from Phase 10 must be green before this phase merges), big-bang deletion risk (gate Phase 11 PRs on Phase 10 test suite passing).

### Phase 12: MCP Verifier Server (Optional)
**Rationale:** In-session self-correction via the MCP verifier pattern increases success rate by giving the agent mid-session feedback before consuming a full outer retry. Independent of Phase 13. Can be skipped if the outer retry loop provides sufficient correction cycles for the target task types.
**Delivers:** `mcp/verifier-server.ts` (~30 lines) exposing `compositeVerifier` as `mcp__verifier__verify` MCP tool; agent can call the verifier mid-session; optional Stop hook for in-session verification feedback.
**Uses:** `createSdkMcpServer()` + `tool()` from Agent SDK; Zod for schema validation; streaming prompt input mode.
**Avoids:** Stop hook as primary verification path (outer RetryOrchestrator remains authoritative), `continue: true` in Stop hook causing infinite loops (managed by external retry counter), Stop hook exceptions swallowing verification results (wrap entire hook body in try/catch).

### Phase 13: Container Strategy
**Rationale:** Production isolation. Development and CI run `query()` directly on host with `permissionMode: "dontAsk"` + `disallowedTools`. Production requires container isolation equivalent to v1.1's Docker sandbox. Independent of Phase 12.
**Delivers:** Updated Dockerfile running the orchestrator (not just the agent subprocess) inside Docker; `spawnClaudeCodeProcess` implementation for Docker stdio bridge; network isolation via `--network bridge` + firewall rules (v2.0 MVP) with Unix proxy socket pattern deferred to v2.1.
**Avoids:** Silent network isolation removal (implement proxy architecture, not just container wrapping), running as root (preserve `--user 1001:1001` from v1.1), passing API key directly into container (proxy pattern routes key outside container), not pinning Claude Code CLI version (pin in Dockerfile).

### Phase Ordering Rationale

- Phase 10 before Phase 11: replacement must work before legacy is deleted. This is a hard dependency.
- Phase 12 and Phase 13 are independent of each other after Phase 11 completes. Either can be done first, or Phase 12 can be skipped entirely.
- All four phases are pure additions or subtractions to the existing codebase. No lateral refactoring required.
- The existing test suite acts as a regression oracle throughout. If Phase 10 breaks existing tests, it is not ready to merge.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 11:** LLM Judge's dependency on `@anthropic-ai/sdk` — three options are documented (migrate to `query()`, keep as dev dep, use constrained JSON prompt) but the choice has quality and performance implications. Needs a decision before Phase 11 planning finalizes.
- **Phase 13:** Proxy architecture specifics — the "Unix socket proxy" pattern is recommended by Anthropic's secure deployment guide and Spotify, but the implementation details (proxy server choice, socket path, container config) need a concrete plan. Flag for deeper research before planning Phase 13.

Phases with standard patterns (skip research-phase):
- **Phase 10:** Agent SDK integration is well-documented with official TypeScript reference, verified option types, and concrete code examples in the research. The `AgentSdkSession` implementation is fully specified (~50 lines in ARCHITECTURE.md).
- **Phase 12:** MCP verifier server pattern is documented and the implementation is specified (~30 lines in ARCHITECTURE.md). Zod version choice is resolved.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Primary sources are official Anthropic docs (platform.claude.com) and GitHub, verified 2026-03-16. npm registry data is MEDIUM (pages returned 403, confirmed via search results). |
| Features | HIGH | All feature claims verified against official Agent SDK docs. `spawnClaudeCodeProcess` for Docker is MEDIUM (option confirmed in docs, implementation pattern inferred). Stop hook for verification is MEDIUM (Spotify blog + SDK docs combined). |
| Architecture | HIGH | Official SDK TypeScript reference confirms `query()` signature, `Options` type, `SDKMessage` types, and `spawnClaudeCodeProcess`. Spotify engineering blog confirms the outer-verification-authoritative pattern and fresh-session-per-retry. Current codebase is first-party source for existing interfaces and contracts. |
| Pitfalls | HIGH | Derived from official docs (breaking changes, hook behavior, `allowedTools` semantics) and direct code analysis of `src/orchestrator/`. Network isolation pitfall confirmed by Anthropic's secure deployment guide. |

**Overall confidence:** HIGH

### Gaps to Address

- **LLM Judge migration path (Phase 11):** Three options exist for handling the Judge's `@anthropic-ai/sdk` dependency after removal. The research flags this as a Phase 11 implementation decision. Decide before Phase 11 planning: Option A (migrate Judge to `query()` with structured output), Option B (keep `@anthropic-ai/sdk` as a peer dep for Judge only), or Option C (`query()` with constrained JSON prompt). Option A is cleanest but requires validating structured output quality matches current Judge behavior.

- **Claude Code CLI bundling (Phase 13):** The stack research notes: "Validate during Phase 13 whether the Agent SDK bundles the binary or requires a separate global install." The Dockerfile template includes `RUN npm install -g @anthropic-ai/claude-code` as a precaution, but this should be validated against the actual SDK package contents before finalizing the Dockerfile.

- **Unix proxy socket implementation (Phase 13 / v2.1):** The v2.0 MVP uses `--network bridge` + outbound firewall rules. The full proxy pattern (`--network none` + Unix socket + `ANTHROPIC_BASE_URL`) is the production-hardened target but its implementation specifics are not detailed in the research. Flag for Phase 13 deep research before planning.

---

## Sources

### Primary (HIGH confidence)
- [Claude Agent SDK TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript) — `query()` signature, `Options` type, `HookEvent` types, `McpServerConfig`, `PermissionMode`, `SDKResultMessage`
- [Claude Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview) — built-in tools list, SDK vs Client SDK comparison, Zod compatibility
- [Claude Agent SDK Hooks](https://platform.claude.com/docs/en/agent-sdk/hooks) — PreToolUse, PostToolUse, Stop callback types, hook availability on `maxTurns`
- [Claude Agent SDK Permissions](https://platform.claude.com/docs/en/agent-sdk/permissions) — `acceptEdits`, `dontAsk`, `bypassPermissions`, `allowedTools` vs `disallowedTools` semantics
- [Claude Agent SDK MCP](https://platform.claude.com/docs/en/agent-sdk/mcp) — `mcpServers` config, `createSdkMcpServer`, `tool()`
- [Claude Agent SDK Secure Deployment](https://platform.claude.com/docs/en/agent-sdk/secure-deployment) — Docker hardening, `--network none` + Unix proxy socket pattern
- [Claude Agent SDK Hosting](https://platform.claude.com/docs/en/agent-sdk/hosting) — container deployment patterns, system requirements, Claude Code CLI runtime dependency
- [Migrate to Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/migration-guide) — breaking changes including system prompt default change in v0.1.0
- [GitHub anthropics/claude-agent-sdk-typescript](https://github.com/anthropics/claude-agent-sdk-typescript) — package name, version 0.2.76 confirmed
- Existing codebase `src/orchestrator/` — first-party source for current interfaces and contracts

### Secondary (MEDIUM confidence)
- [Spotify Engineering: Background Coding Agent Part 1](https://engineering.atspotify.com/2025/11/spotifys-background-coding-agent-part-1) — architecture evolution, top-performing agent claim, surrounding infrastructure pattern
- [Spotify Engineering: Feedback Loops Part 3](https://engineering.atspotify.com/2025/12/feedback-loops-background-coding-agents-part-3) — container isolation, MCP verifiers, stop hook, LLM Judge 25% veto rate
- npm registry (via search) — `@anthropic-ai/claude-agent-sdk` version 0.2.76; `@modelcontextprotocol/sdk` version 1.27.1

---
*Research completed: 2026-03-16*
*Ready for roadmap: yes*
