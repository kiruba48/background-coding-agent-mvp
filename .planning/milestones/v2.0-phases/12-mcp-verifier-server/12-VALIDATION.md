---
phase: 12
slug: mcp-verifier-server
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-03-18
---

# Phase 12 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.0.18 |
| **Config file** | `vitest.config.ts` |
| **Quick run command** | `npx vitest run src/mcp/verifier-server.test.ts` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~15 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run src/mcp/verifier-server.test.ts`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 15 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|-----------|-------------------|-------------|--------|
| 12-01-01 | 01 | 1 | MCP-01 | unit | `npx vitest run src/mcp/verifier-server.test.ts -t "createVerifierMcpServer"` | ❌ W0 | ⬜ pending |
| 12-01-02 | 01 | 1 | MCP-01 | unit | `npx vitest run src/mcp/verifier-server.test.ts -t "verify tool handler"` | ❌ W0 | ⬜ pending |
| 12-01-03 | 01 | 1 | MCP-01 | unit | `npx vitest run src/mcp/verifier-server.test.ts -t "digest format"` | ❌ W0 | ⬜ pending |
| 12-02-01 | 02 | 1 | MCP-02 | unit | `npx vitest run src/orchestrator/claude-code-session.test.ts -t "mcpServers"` | ❌ needs new test | ⬜ pending |
| 12-02-02 | 02 | 1 | MCP-02 | unit | `npx vitest run src/orchestrator/claude-code-session.test.ts -t "systemPrompt verify"` | ❌ needs new test | ⬜ pending |
| 12-01-04 | 01 | 1 | MCP-03 | unit | `npx vitest run src/mcp/verifier-server.test.ts -t "type sdk"` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/mcp/verifier-server.test.ts` — stubs for MCP-01, MCP-03 (mock compositeVerifier, test tool response format and server config shape)
- [ ] Additional tests in `src/orchestrator/claude-code-session.test.ts` — stubs for MCP-02 (verify mcpServers wired in query() call, verify instruction in prompt)

*Existing vitest infrastructure covers framework setup — no new test config needed.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Agent actually calls mcp__verifier__verify during session | MCP-02 | Requires live agent session with real SDK | Run a test task with `--verbose`, check logs for `mcp__verifier__verify` tool call |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 15s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
