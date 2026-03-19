# Phase 12: MCP Verifier Server - Context

**Gathered:** 2026-03-18
**Status:** Ready for planning

<domain>
## Phase Boundary

Expose compositeVerifier as an in-process MCP tool (`mcp__verifier__verify`) so the agent can self-check build/test/lint mid-session before stopping — reducing outer retry consumption for fixable build failures. RetryOrchestrator remains the authoritative post-session quality gate.

</domain>

<decisions>
## Implementation Decisions

### Tool response format
- Return summarized digest: pass/fail per verifier + error summaries (from ErrorSummarizer)
- Full per-verifier breakdown in response (Build: PASS, Test: FAIL — 2 failures, Lint: PASS)
- No raw compiler/test output — only the 1-line summaries from ErrorSummarizer
- No action hints in response — just the facts, agent reasons about next steps
- No timing info in response — saves tokens, agent doesn't need it

### Prompt integration
- System prompt instruction: "Before stopping, call mcp__verifier__verify to check your changes. Fix any failures before declaring done."
- Encourage single verify-before-stopping pattern, not iterative verify loops (agent can still call more if it wants)
- Instruction appended to systemPrompt in ClaudeCodeSession — one place, always present when MCP server is wired
- Not per-task-type in prompts/ module — session-level concern

### Verify scope & args
- Full composite suite always (build+test+lint) — no selective verifier picking
- Zero-arg tool — MCP server captures workspaceDir at construction time, agent calls verify() with no arguments
- No rate limit on verify calls — maxTurns and maxBudgetUsd already cap the session

### Opt-in behavior
- Always on — every ClaudeCodeSession gets the verify MCP server wired in, no CLI flag needed
- Log MCP server registration at session start: `{type: 'mcp', server: 'verifier', tools: ['verify']}`
- Verify tool calls logged via PostToolUse audit trail alongside file changes

### Claude's Discretion
- Exact MCP server module structure (`mcp/verifier-server.ts` or inline)
- How to format the summarized digest string (exact text layout)
- Test strategy for MCP server (mock compositeVerifier, test tool response format)
- Whether to add the PostToolUse matcher for MCP tool calls or rely on existing hook

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### MCP Server Pattern
- `BRIEF.md` — Migration analysis, MCP verifier mentioned as Spotify's exact pattern
- `.planning/research/STACK.md` §75-108 — `createSdkMcpServer()` + `tool()` code sketch, `type: "sdk"` transport, in-process pattern
- `.planning/research/FEATURES.md` §60-91 — MCP verifier server deep dive, complexity assessment, streaming input requirement

### Requirements
- `.planning/REQUIREMENTS.md` §MCP Verifier — MCP-01, MCP-02, MCP-03
- `.planning/ROADMAP.md` §Phase 12 — Success criteria (3 must-be-TRUE statements)

### Existing Code to Modify
- `src/orchestrator/verifier.ts` — compositeVerifier function to wrap as MCP tool
- `src/orchestrator/claude-code-session.ts` — ClaudeCodeSession: wire mcpServers option into query()
- `src/types.ts` — VerificationResult, VerificationError interfaces (tool response based on these)
- `src/orchestrator/summarizer.ts` — ErrorSummarizer produces the 1-line summaries used in tool response

### Prior Phase Decisions
- `.planning/phases/10-agent-sdk-integration/10-CONTEXT.md` — ClaudeCodeSession architecture, hook design, settingSources: []

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `compositeVerifier(workspaceDir)` (verifier.ts): Already returns `VerificationResult` with per-verifier errors — wrap directly
- `ErrorSummarizer` (summarizer.ts): Produces 1-line summaries per error type — used to build digest response
- `ClaudeCodeSession` (claude-code-session.ts): Has `query()` options — add `mcpServers` config here
- `buildPreToolUseHook` / `buildPostToolUseHook` patterns: Established hook architecture to follow

### Established Patterns
- `createSdkMcpServer()` + `tool()` from `@anthropic-ai/claude-agent-sdk` — no external MCP dependency needed
- `type: "sdk"` transport for in-process MCP — no subprocess, no stdio, no HTTP
- Pino structured JSON logging with `type: 'audit'` tag for observability events
- Zero-arg tool pattern: capture workspaceDir via closure at construction time

### Integration Points
- `ClaudeCodeSession.run()` line 226: add `mcpServers` to query() options object
- `ClaudeCodeSession` constructor or factory: create verifier MCP server with workspaceDir closure
- System prompt: append verify instruction after task-specific prompt

</code_context>

<specifics>
## Specific Ideas

- Tool is zero-arg by design — mirrors compositeVerifier's single-workspace model (one repo per session)
- Response format should match what the outer RetryOrchestrator would show on failure — agent sees the same signal
- No escape hatch flag needed — tool registration is cheap if unused, and the goal is to reduce retries by default

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 12-mcp-verifier-server*
*Context gathered: 2026-03-18*
