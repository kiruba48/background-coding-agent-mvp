# Requirements: Background Coding Agent

**Defined:** 2026-03-16
**Core Value:** The full verification loop must work: agent changes code, deterministic verifiers catch failures, LLM Judge catches scope creep, and only verified changes proceed.

## v2.0 Requirements

Requirements for Claude Agent SDK migration. Each maps to roadmap phases.

### SDK Integration

- [x] **SDK-01**: Agent sessions use Claude Agent SDK `query()` instead of custom AgentSession/AgentClient
- [x] **SDK-02**: Built-in tools (Read, Write, Edit, Bash, Glob, Grep) replace all 6 hand-built tools
- [x] **SDK-03**: Permission mode `acceptEdits` auto-approves file operations without manual interception
- [x] **SDK-04**: `disallowedTools` blocks WebSearch/WebFetch in sandbox runs
- [x] **SDK-05**: `maxTurns` option replaces manual turn counter
- [x] **SDK-06**: `systemPrompt` option replaces custom prompt construction
- [x] **SDK-07**: PostToolUse hook logs every file change (Edit/Write) to audit trail
- [x] **SDK-08**: PreToolUse hook blocks writes outside repo path and to sensitive files (.env, .git)
- [x] **SDK-09**: `maxBudgetUsd` caps session cost as a hard USD limit
- [x] **SDK-10**: `ClaudeCodeSession` wrapper returns `SessionResult` compatible with RetryOrchestrator interface

### Legacy Deletion

- [x] **DEL-01**: `agent.ts` (AgentClient) deleted — replaced by Agent SDK built-in agentic loop
- [x] **DEL-02**: `session.ts` (AgentSession) deleted — replaced by ClaudeCodeSession wrapper
- [x] **DEL-03**: `container.ts` (ContainerManager) deleted — replaced by spawnClaudeCodeProcess
- [x] **DEL-04**: `dockerode` dependency removed from package.json
- [x] **DEL-05**: All tests for deleted files replaced with ClaudeCodeSession integration tests

### MCP Verifier

- [x] **MCP-01**: In-process MCP server wraps compositeVerifier as `mcp__verifier__verify` tool
- [x] **MCP-02**: Agent can call verify tool mid-session to self-check before stopping
- [x] **MCP-03**: MCP server uses `createSdkMcpServer()` — no external process or HTTP server

### Container Strategy

- [x] **CTR-01**: Dockerfile runs Claude Agent SDK (Claude Code) inside Docker container
- [ ] **CTR-02**: `spawnClaudeCodeProcess` pipes stdio between host orchestrator and container
- [x] **CTR-03**: Container maintains network isolation equivalent to v1.x `NetworkMode: none`
- [x] **CTR-04**: Container runs as non-root user with minimal capabilities

## Future Requirements

Deferred to v2.1+. Tracked but not in current roadmap.

### Enhanced Capabilities

- **ENH-01**: WebSearch enabled for non-sandboxed runs (changelog lookups during dependency updates)
- **ENH-02**: Subagent support (Agent tool) for parallel subtask execution
- **ENH-03**: File checkpointing with `enableFileCheckpointing` and `rewindFiles()`
- **ENH-04**: Effort control (`effort: 'low' | 'medium' | 'high'`) per task type
- **ENH-05**: Custom verifier plugins (from v1.x backlog)
- **ENH-06**: Cost per run metric tracking (from v1.x backlog)

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| `bypassPermissions` mode | Grants full system access; `acceptEdits` + `disallowedTools` is safer |
| Session resume in retry loop | Context accumulation causes scope drift; fresh session per retry is correct pattern |
| AskUserQuestion in batch mode | Blocks background execution; agent must work autonomously |
| Stop hook for retry logic | Creates infinite loop risk; RetryOrchestrator is cleaner boundary |
| `settingSources: ["user"]` | Imports operator's personal config into agent; breaks isolation |
| Full `@anthropic-ai/sdk` removal | LLM Judge still needs it for structured output; keep for judge only |
| Network proxy architecture | Complex Unix socket proxy; defer if simpler Docker networking suffices |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| SDK-01 | Phase 10 | Complete |
| SDK-02 | Phase 10 | Complete |
| SDK-03 | Phase 10 | Complete |
| SDK-04 | Phase 10 | Complete |
| SDK-05 | Phase 10 | Complete |
| SDK-06 | Phase 10 | Complete |
| SDK-07 | Phase 10 | Complete |
| SDK-08 | Phase 10 | Complete |
| SDK-09 | Phase 10 | Complete |
| SDK-10 | Phase 10 | Complete |
| DEL-01 | Phase 11 | Complete |
| DEL-02 | Phase 11 | Complete |
| DEL-03 | Phase 11 | Complete |
| DEL-04 | Phase 11 | Complete |
| DEL-05 | Phase 11 | Complete |
| MCP-01 | Phase 12 | Complete |
| MCP-02 | Phase 12 | Complete |
| MCP-03 | Phase 12 | Complete |
| CTR-01 | Phase 13 | Complete |
| CTR-02 | Phase 13 | Pending |
| CTR-03 | Phase 13 | Complete |
| CTR-04 | Phase 13 | Complete |

**Coverage:**
- v2.0 requirements: 22 total
- Mapped to phases: 22
- Unmapped: 0 ✓

---
*Requirements defined: 2026-03-16*
*Last updated: 2026-03-16 after roadmap creation*
