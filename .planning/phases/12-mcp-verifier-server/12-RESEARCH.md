# Phase 12: MCP Verifier Server - Research

**Researched:** 2026-03-18
**Domain:** Claude Agent SDK in-process MCP server (`createSdkMcpServer` + `tool()`) wiring compositeVerifier as a zero-arg mid-session tool
**Confidence:** HIGH — SDK type definitions inspected directly from installed `node_modules`, combined with STACK.md and FEATURES.md prior research at HIGH confidence

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Tool response format**
- Return summarized digest: pass/fail per verifier + error summaries (from ErrorSummarizer)
- Full per-verifier breakdown in response (Build: PASS, Test: FAIL — 2 failures, Lint: PASS)
- No raw compiler/test output — only the 1-line summaries from ErrorSummarizer
- No action hints in response — just the facts, agent reasons about next steps
- No timing info in response — saves tokens, agent doesn't need it

**Prompt integration**
- System prompt instruction: "Before stopping, call mcp__verifier__verify to check your changes. Fix any failures before declaring done."
- Encourage single verify-before-stopping pattern, not iterative verify loops (agent can still call more if it wants)
- Instruction appended to systemPrompt in ClaudeCodeSession — one place, always present when MCP server is wired
- Not per-task-type in prompts/ module — session-level concern

**Verify scope and args**
- Full composite suite always (build+test+lint) — no selective verifier picking
- Zero-arg tool — MCP server captures workspaceDir at construction time, agent calls verify() with no arguments
- No rate limit on verify calls — maxTurns and maxBudgetUsd already cap the session

**Opt-in behavior**
- Always on — every ClaudeCodeSession gets the verify MCP server wired in, no CLI flag needed
- Log MCP server registration at session start: `{type: 'mcp', server: 'verifier', tools: ['verify']}`
- Verify tool calls logged via PostToolUse audit trail alongside file changes

### Claude's Discretion
- Exact MCP server module structure (`mcp/verifier-server.ts` or inline)
- How to format the summarized digest string (exact text layout)
- Test strategy for MCP server (mock compositeVerifier, test tool response format)
- Whether to add the PostToolUse matcher for MCP tool calls or rely on existing hook

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| MCP-01 | In-process MCP server wraps compositeVerifier as `mcp__verifier__verify` tool | `createSdkMcpServer()` + `tool()` exported from `@anthropic-ai/claude-agent-sdk` (verified in sdk.d.ts line 323, 3505). Zero-arg pattern works by capturing `workspaceDir` at construction via closure. |
| MCP-02 | Agent can call verify tool mid-session to self-check before stopping | `mcpServers` option on `query()` (verified: sdk.d.ts line 1019). Tool registered as `mcp__verifier__verify`, callable from any session turn. System prompt instruction directs agent to call before stopping. |
| MCP-03 | MCP server uses `createSdkMcpServer()` — no external process or HTTP server | `type: 'sdk'` transport is in-process (McpSdkServerConfigWithInstance, sdk.d.ts line 599). No subprocess, no stdio, no HTTP. RetryOrchestrator remains post-session quality gate. |
</phase_requirements>

---

## Summary

Phase 12 adds an in-process MCP server that exposes `compositeVerifier` as `mcp__verifier__verify`, allowing the agent to self-check mid-session before stopping. The `@anthropic-ai/claude-agent-sdk` package (already installed at `^0.2.77`) provides `createSdkMcpServer()` and `tool()` built-in — no additional dependencies required. Zod is a transitive dependency (v4.3.6 installed) but the SDK now imports from `zod/v4`, so tool schemas must use `z` from `zod/v4` for the `AnyZodRawShape` constraint to be satisfied.

The work is additive: a new `src/mcp/verifier-server.ts` module exports a factory function, `ClaudeCodeSession.run()` wires it into `query()` options, and the `systemPrompt` is appended with the verify instruction. The outer `RetryOrchestrator` and `compositeVerifier` are untouched. Estimated ~100 lines of new TypeScript across two changed files and one new file.

The key implementation risk is the Zod version: the SDK's `tool()` function uses `AnyZodRawShape = ZodRawShape | ZodRawShape_2` where `ZodRawShape_2` is `zod/v4`. Since the zero-arg tool has an empty schema `{}`, this is only relevant if a schema field is added later. For a truly zero-arg tool the schema is `{}` (an empty object), which satisfies both Zod 3 and v4 `ZodRawShape`.

**Primary recommendation:** Create `src/mcp/verifier-server.ts` exporting `createVerifierMcpServer(workspaceDir)`. Wire into `ClaudeCodeSession.run()` alongside existing hooks. Append system prompt instruction in `ClaudeCodeSession`. Test with a mock `compositeVerifier` — no live execution needed.

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@anthropic-ai/claude-agent-sdk` | `^0.2.77` (already installed) | `createSdkMcpServer()`, `tool()` for in-process MCP server; `mcpServers` option on `query()` | Already the project's agent runtime; MCP server creation is built-in, no extra package |
| `zod` (via `zod/v4`) | 4.3.6 transitive (already in node_modules) | Schema for `tool()` input parameter (empty object `{}` for zero-arg tool) | SDK imports `z` from `zod/v4`; already present as transitive dep |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `pino` | `^10.3.0` (existing) | Structured JSON logging for MCP server registration and verify tool call events | Existing project logger — use for `{type: 'mcp'}` registration log |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `createSdkMcpServer()` (in-process) | `@modelcontextprotocol/sdk` (stdio transport) | stdio requires a subprocess and IPC; in-process has zero overhead and no port/process management. Locked decision: in-process only. |
| Empty schema `{}` for zero-arg | `z.object({})` | Same result; empty plain object `{}` is idiomatic for zero-arg tools and avoids a Zod import entirely |

**Installation:** No new packages needed. `@anthropic-ai/claude-agent-sdk` and `zod` are already in `node_modules`.

---

## Architecture Patterns

### Recommended Project Structure
```
src/
├── mcp/
│   └── verifier-server.ts   # New: exports createVerifierMcpServer(workspaceDir)
├── orchestrator/
│   ├── claude-code-session.ts  # Modified: wire mcpServers + append systemPrompt
│   ├── verifier.ts             # Unchanged: compositeVerifier() wrapped by MCP server
│   └── summarizer.ts           # Unchanged: ErrorSummarizer.buildDigest() used in response
└── types.ts                    # Unchanged: VerificationResult, VerificationError used
```

### Pattern 1: Zero-Arg In-Process MCP Tool (Closure Pattern)
**What:** Factory function captures `workspaceDir` via closure. Returns `McpSdkServerConfigWithInstance` ready to pass to `mcpServers` in `query()` options.
**When to use:** Any time a tool needs a fixed runtime dependency (workspace path) not known at type-definition time.
**Example:**
```typescript
// Source: sdk.d.ts lines 323-329, 3505-3507 (verified from node_modules)
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { compositeVerifier } from '../orchestrator/verifier.js';
import { ErrorSummarizer } from '../orchestrator/summarizer.js';

export function createVerifierMcpServer(workspaceDir: string) {
  const verifyTool = tool(
    'verify',
    'Run composite verifier (build, test, lint) on the current workspace. Call before stopping to self-check your changes.',
    {},  // zero-arg: no input schema fields
    async (_args: Record<string, never>, _extra: unknown): Promise<CallToolResult> => {
      const result = await compositeVerifier(workspaceDir);
      const text = formatVerifyDigest(result);
      return { content: [{ type: 'text', text }] };
    }
  );

  return createSdkMcpServer({
    name: 'verifier',
    version: '1.0.0',
    tools: [verifyTool],
  });
}
```

### Pattern 2: Wiring mcpServers into query() Options
**What:** Pass the server config (returned by `createSdkMcpServer`) into `query()` options under `mcpServers` key.
**When to use:** At `ClaudeCodeSession.run()` time, alongside existing hooks.
**Example:**
```typescript
// Source: sdk.d.ts line 1019 — mcpServers?: Record<string, McpServerConfig>
import { createVerifierMcpServer } from '../mcp/verifier-server.js';

// In ClaudeCodeSession.run():
const verifierServer = createVerifierMcpServer(workspaceDir);
log.info({ type: 'mcp', server: 'verifier', tools: ['verify'] }, 'mcp_server_registered');

queryGen = query({
  prompt: buildSystemPromptWithVerifyInstruction(userMessage),
  options: {
    cwd: workspaceDir,
    // ... existing options unchanged ...
    mcpServers: {
      verifier: verifierServer,
    },
  },
});
```

### Pattern 3: System Prompt Append
**What:** Append the verify instruction to the end of the user message passed as `prompt`. The locked decision specifies `systemPrompt` but `query()` takes `prompt` as the user message; the session-level concern means appending it as a final instruction in the prompt is the correct integration point.
**When to use:** Always — every session gets the MCP server wired, so the instruction is always relevant.
**Example:**
```typescript
// Append to userMessage before passing to query()
const promptWithVerifyInstruction =
  userMessage +
  '\n\nBefore stopping, call mcp__verifier__verify to check your changes. Fix any failures before declaring done.';
```

**Note on systemPrompt vs prompt:** The `query()` API takes `prompt` (user message) and `options.systemPrompt` (system instruction). The locked decision says "append to systemPrompt in ClaudeCodeSession." The `options` object in `query()` supports a `systemPrompt` field. Appending to `systemPrompt` is the correct approach — it separates instructions from user content.

### Pattern 4: Verify Digest Format
**What:** Format `VerificationResult` into a token-efficient string. No raw output, no timing, just pass/fail + summaries.
**When to use:** Inside the `verify` tool handler, as the text returned to the agent.
**Example:**
```typescript
function formatVerifyDigest(result: VerificationResult): string {
  if (result.passed) {
    return 'Verification PASSED: Build: PASS, Test: PASS, Lint: PASS';
  }
  const lines: string[] = [];
  // Per-verifier breakdown from error types present
  const hasType = (t: string) => result.errors.some(e => e.type === t);
  lines.push(`Verification FAILED:`);
  lines.push(`  Build: ${hasType('build') ? 'FAIL' : 'PASS'}`);
  lines.push(`  Test: ${hasType('test') ? 'FAIL' : 'PASS'}`);
  lines.push(`  Lint: ${hasType('lint') ? 'FAIL' : 'PASS'}`);
  lines.push('');
  // Error summaries from ErrorSummarizer (already 1-line each)
  for (const error of result.errors) {
    lines.push(`[${error.type.toUpperCase()}] ${error.summary}`);
  }
  return lines.join('\n');
}
```

### Anti-Patterns to Avoid
- **Passing rawOutput in tool response:** `VerificationError.rawOutput` is for logging only — never include it in the text returned to the agent. Locked decision.
- **Accepting workspaceDir as a tool argument:** Zero-arg pattern is locked. Closure captures it at construction. Prevents agent from verifying arbitrary paths.
- **Creating an HTTP/stdio MCP server:** `createSdkMcpServer()` with `type: 'sdk'` is in-process. No port, no subprocess. MCP-03 requires this explicitly.
- **Calling compositeVerifier in RetryOrchestrator replacement:** The outer retry loop still calls `compositeVerifier` after each session. The MCP tool is additive, not replacing the post-session gate.
- **Importing from `zod` root for tool schema:** The SDK uses `zod/v4` internally. For non-empty schemas, import `z` from `zod/v4` to match `AnyZodRawShape`. For zero-arg empty `{}`, no Zod import needed.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| In-process MCP server | Custom JSON-RPC handler, stdio pipe, HTTP server | `createSdkMcpServer()` + `tool()` from Agent SDK | Built-in; handles MCP protocol, tool registration, serialization; ~5 lines vs hundreds |
| Tool schema validation | Custom input validator | Zod schema passed to `tool()` | SDK handles validation automatically; empty `{}` for zero-arg is idiomatic |
| Error summarization | Custom string formatting | `ErrorSummarizer.buildDigest()` or per-error `error.summary` | Already tested, handles all verifier types, caps at 2000 chars |
| Streaming tool responses | Async generator response | Simple `Promise<CallToolResult>` with text content | `compositeVerifier` is synchronous-ish (awaits child processes); no streaming needed |

**Key insight:** The Agent SDK wraps the entire MCP protocol. The entire Phase 12 implementation is a thin adapter between `createSdkMcpServer` and the existing `compositeVerifier` — not a new system.

---

## Common Pitfalls

### Pitfall 1: Zod Version Mismatch
**What goes wrong:** Importing `z` from `zod` (v3 or v4 root) when the SDK expects `zod/v4` shapes causes TypeScript type errors on `AnyZodRawShape`.
**Why it happens:** The SDK's `sdk.d.ts` imports `ZodRawShape_2` from `zod/v4` and `ZodRawShape` from `zod` (no subpath = v3 compat). Both are valid via `AnyZodRawShape = ZodRawShape | ZodRawShape_2`. For a zero-arg tool using `{}`, no Zod import is needed at all.
**How to avoid:** For zero-arg tool: use literal `{}` as the schema — no Zod import required. For tools with arguments: `import { z } from 'zod/v4'` matches the SDK's internal type.
**Warning signs:** TypeScript error "Argument of type '{}' is not assignable to parameter of type 'AnyZodRawShape'" — though this should not occur since `{}` is a valid empty `ZodRawShape`.

### Pitfall 2: McpSdkServerConfigWithInstance vs McpSdkServerConfig Confusion
**What goes wrong:** `createSdkMcpServer()` returns `McpSdkServerConfigWithInstance` (has live `instance: McpServer`). `McpServerConfig` in `query()` options accepts `McpSdkServerConfigWithInstance`. Passing the wrong type causes runtime failures.
**Why it happens:** There are two related types: `McpSdkServerConfig` (serializable, for process transport) and `McpSdkServerConfigWithInstance` (has live instance, for in-process). The `mcpServers` option takes `Record<string, McpServerConfig>` which includes `McpSdkServerConfigWithInstance`.
**How to avoid:** Pass the return value of `createSdkMcpServer()` directly — TypeScript will type-check it correctly. Do not destructure or reconstruct the object.
**Warning signs:** TypeScript error "Property 'instance' is missing."

### Pitfall 3: Tool Name in Tool Call vs MCP Namespace
**What goes wrong:** The tool is registered as `verify` in the MCP server named `verifier`. The agent calls it as `mcp__verifier__verify`. Mismatch in the system prompt instruction vs actual registered name causes agent confusion.
**Why it happens:** Agent SDK namespaces MCP tools as `mcp__{server_name}__{tool_name}`. Server name is set in `createSdkMcpServer({ name: 'verifier' })`, tool name is the first arg to `tool('verify', ...)`.
**How to avoid:** Server name: `verifier`. Tool name: `verify`. Resulting call: `mcp__verifier__verify`. Keep these three consistent.
**Warning signs:** Agent reports tool not found; or calls `mcp__verifier__verify` but no result is produced.

### Pitfall 4: compositeVerifier Duration Inside Agent Turn Budget
**What goes wrong:** `compositeVerifier` runs all verifiers (build + test + lint) which can take 2-5 minutes. If called during a session, it consumes wall clock time against `timeoutMs` (default 300s).
**Why it happens:** The tool handler `await compositeVerifier(workspaceDir)` blocks the MCP response for the full verification duration. With maxTurns=10 and timeoutMs=300s, a single verify call could consume a significant fraction of the budget.
**How to avoid:** This is acceptable — the locked decision has no rate limit; `maxTurns` and `maxBudgetUsd` are the safeguards. Document in the tool description that verification may take 1-3 minutes.
**Warning signs:** Session hits `error_max_turns` or timeout status after a verify call.

### Pitfall 5: PostToolUse Hook Matcher Scope
**What goes wrong:** The existing `PostToolUse` hook matches `Write|Edit` — it will NOT fire for MCP tool calls (`mcp__verifier__verify`). If audit logging of verify calls is desired, the hook matcher must be extended or a separate hook added.
**Why it happens:** The matcher is a string pattern matched against `tool_name`. MCP tools have names like `mcp__verifier__verify`, not `Write` or `Edit`.
**How to avoid:** The locked decision says "Verify tool calls logged via PostToolUse audit trail alongside file changes." This requires adding `mcp__verifier__verify` to the PostToolUse matcher, or using a separate catch-all hook. The CONTEXT.md marks this as Claude's discretion.
**Warning signs:** No `file_changed` audit events appear for verify tool calls in structured logs.

---

## Code Examples

Verified patterns from SDK type definitions (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`):

### createSdkMcpServer() Signature
```typescript
// Source: sdk.d.ts line 323-329
export declare function createSdkMcpServer(_options: CreateSdkMcpServerOptions): McpSdkServerConfigWithInstance;

// CreateSdkMcpServerOptions:
type CreateSdkMcpServerOptions = {
    name: string;
    version?: string;
    tools?: Array<SdkMcpToolDefinition<any>>;
};
```

### tool() Signature
```typescript
// Source: sdk.d.ts line 3505-3507
export declare function tool<Schema extends AnyZodRawShape>(
  _name: string,
  _description: string,
  _inputSchema: Schema,
  _handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>,
  _extras?: { annotations?: ToolAnnotations; }
): SdkMcpToolDefinition<Schema>;
```

### McpServerConfig in query() Options
```typescript
// Source: sdk.d.ts line 1019
options?: {
  // ...
  mcpServers?: Record<string, McpServerConfig>;
  // McpServerConfig = McpStdioServerConfig | McpSSEServerConfig | McpHttpServerConfig | McpSdkServerConfigWithInstance
}
```

### McpSdkServerConfigWithInstance (in-process transport)
```typescript
// Source: sdk.d.ts lines 590-601
type McpSdkServerConfig = {
    type: 'sdk';
    name: string;
};
type McpSdkServerConfigWithInstance = McpSdkServerConfig & {
    instance: McpServer;  // live McpServer object from @modelcontextprotocol/sdk
};
```

### CallToolResult (MCP response format)
```typescript
// Source: sdk.d.ts line 4 — imported from '@modelcontextprotocol/sdk/types.js'
// Standard MCP tool result:
const result: CallToolResult = {
  content: [{ type: 'text', text: 'Verification PASSED: Build: PASS, Test: PASS, Lint: PASS' }]
};
```

### Existing PostToolUse Hook Pattern (for extending to MCP calls)
```typescript
// Source: src/orchestrator/claude-code-session.ts lines 106-124
// Current matcher: 'Write|Edit'
// To include verify calls: 'Write|Edit|mcp__verifier__verify'
hooks: {
  PreToolUse: [{ matcher: 'Write|Edit', hooks: [preHook] }],
  PostToolUse: [{ matcher: 'Write|Edit|mcp__verifier__verify', hooks: [postHook] }],
},
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Separate MCP server process via stdio | `createSdkMcpServer()` in-process | Agent SDK v0.2.x | No subprocess, no IPC, no port management |
| External `@modelcontextprotocol/sdk` for server creation | Built into Agent SDK | Agent SDK v0.2.x | Zero additional dependencies for in-process MCP |
| Post-session only verification | Mid-session + post-session verification | Phase 12 (this phase) | Agent can self-correct before consuming a full outer retry |

**Deprecated/outdated:**
- Separate `@modelcontextprotocol/sdk` as a dependency: Not needed for in-process MCP servers. The SDK imports it transitively; consumers do not install it directly (it appears as a transitive dep in `@anthropic-ai/claude-agent-sdk`).

---

## Open Questions

1. **`systemPrompt` option availability in `query()` options**
   - What we know: `query()` takes `prompt` (user message) and `options`. STACK.md lists `systemPrompt` as a key `Options` field.
   - What's unclear: The `sdk.d.ts` was not fully scanned for `systemPrompt` in `Options`. The locked decision says "append to systemPrompt in ClaudeCodeSession."
   - Recommendation: Verify `systemPrompt` exists in `Options` type before implementation. If absent, append the verify instruction to the end of `userMessage` instead (equivalent effect). The planner should include a verification sub-task.

2. **PostToolUse hook firing for MCP tool calls**
   - What we know: Existing hook matches `Write|Edit`. MCP tool name is `mcp__verifier__verify`.
   - What's unclear: Whether the Agent SDK fires PostToolUse for MCP tool calls or only for built-in tools.
   - Recommendation: Extend matcher to `Write|Edit|mcp__verifier__verify` as a safe default. If MCP tool calls don't fire PostToolUse, the broader pattern still works for file changes.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.0.18 |
| Config file | `vitest.config.ts` (project root) |
| Quick run command | `npx vitest run src/mcp/verifier-server.test.ts` |
| Full suite command | `npx vitest run` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| MCP-01 | `createVerifierMcpServer(workspaceDir)` returns a valid `McpSdkServerConfigWithInstance` with `type: 'sdk'` and `instance` | unit | `npx vitest run src/mcp/verifier-server.test.ts -t "createVerifierMcpServer"` | ❌ Wave 0 |
| MCP-01 | Verify tool handler calls `compositeVerifier(workspaceDir)` with the captured path | unit | `npx vitest run src/mcp/verifier-server.test.ts -t "verify tool handler"` | ❌ Wave 0 |
| MCP-01 | Tool response text contains PASS/FAIL breakdown per verifier type, no rawOutput | unit | `npx vitest run src/mcp/verifier-server.test.ts -t "digest format"` | ❌ Wave 0 |
| MCP-02 | `ClaudeCodeSession.run()` passes `mcpServers.verifier` in `query()` options | unit | `npx vitest run src/orchestrator/claude-code-session.test.ts -t "mcpServers"` | ❌ needs new test |
| MCP-02 | System prompt includes verify instruction when MCP server is wired | unit | `npx vitest run src/orchestrator/claude-code-session.test.ts -t "systemPrompt verify"` | ❌ needs new test |
| MCP-03 | Returned server config has `type: 'sdk'` (not 'stdio', 'sse', 'http') | unit | `npx vitest run src/mcp/verifier-server.test.ts -t "type sdk"` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npx vitest run src/mcp/verifier-server.test.ts`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/mcp/verifier-server.test.ts` — covers MCP-01, MCP-03 (mock `compositeVerifier`, test tool response format and server config shape)
- [ ] Additional tests in `src/orchestrator/claude-code-session.test.ts` — covers MCP-02 (verify `mcpServers` wired in `query()` call, verify instruction in prompt)

---

## Sources

### Primary (HIGH confidence)
- `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` — `createSdkMcpServer()` signature (line 323), `tool()` signature (line 3505), `McpServerConfig` union (line 606), `McpSdkServerConfigWithInstance` (line 599), `mcpServers` option in query `Options` (line 1019), `AnyZodRawShape` (line 94) — verified 2026-03-18
- `src/orchestrator/verifier.ts` — `compositeVerifier(workspaceDir)` signature, returns `VerificationResult`, seven-verifier composite — verified 2026-03-18
- `src/orchestrator/claude-code-session.ts` — Existing `query()` wiring, hook patterns, `buildPostToolUseHook`, `buildPreToolUseHook` — verified 2026-03-18
- `src/orchestrator/summarizer.ts` — `ErrorSummarizer.buildDigest()`, per-error `summary` field usage — verified 2026-03-18
- `src/types.ts` — `VerificationResult`, `VerificationError` interfaces — verified 2026-03-18
- `.planning/research/STACK.md` §75-108 — `createSdkMcpServer()` + `tool()` code sketch, `type: "sdk"` transport — verified 2026-03-18
- `.planning/research/FEATURES.md` §60-91 — MCP verifier server deep dive, complexity assessment — verified 2026-03-18

### Secondary (MEDIUM confidence)
- `.planning/phases/12-mcp-verifier-server/12-CONTEXT.md` — All locked decisions, canonical references, integration points — verified 2026-03-18

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — SDK type definitions inspected directly from installed node_modules; no network lookup needed
- Architecture: HIGH — Tool signature, mcpServers option, and McpServerConfig types all verified against live node_modules
- Pitfalls: HIGH (Zod version, type confusion) / MEDIUM (PostToolUse for MCP calls) — type-check pitfalls verified from SDK types; PostToolUse behavior for MCP calls is an inference

**Research date:** 2026-03-18
**Valid until:** 2026-04-18 (stable SDK; 30-day window reasonable for 0.2.x patch range)
