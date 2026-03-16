# Pitfalls Research

**Domain:** Claude Agent SDK migration — replacing custom agentic loop in existing production system
**Researched:** 2026-03-16
**Confidence:** HIGH (Agent SDK docs verified via WebFetch; pitfalls derived from official docs + direct code analysis)

---

## Critical Pitfalls

Mistakes that lose existing safety guarantees, cause regressions, or require a full phase rewrite.

---

### Pitfall 1: Network Isolation Silently Removed During Migration

**What goes wrong:**
The existing system enforces `NetworkMode: none` via Docker. When the migration plan says "run Agent SDK inside Docker for production isolation," this can be implemented incorrectly — the container runs but the network restriction is omitted. The Agent SDK itself will happily call the Anthropic API and make web requests without any container-level restriction. The container provides filesystem isolation but not network isolation.

**Why it happens:**
The Agent SDK needs HTTPS access to `api.anthropic.com` to function. The obvious fix is to open network access. Developers drop `--network none` without implementing a proxy pattern as replacement, assuming the SDK's own permission controls are sufficient.

**How to avoid:**
Network isolation requires a proxy architecture, not just a flag. The Agent SDK supports `ANTHROPIC_BASE_URL` to route API calls through a proxy outside the container. The container keeps `--network none` and communicates only through a mounted Unix socket. This is exactly how Spotify's Honk works and what the official secure deployment guide recommends. Phase 13 (Container Strategy) must implement the proxy pattern, not just run the SDK in a container.

**Warning signs:**
- Container Dockerfile adds `--network bridge` or removes `--network none` to "make the SDK work"
- `ANTHROPIC_API_KEY` is passed directly into the container environment
- No proxy socket or `ANTHROPIC_BASE_URL` in the container config
- Phase plan says "run SDK in container" without specifying how API calls reach the outside world

**Phase to address:** Phase 13 (Container Strategy) — this is the entire point of Phase 13. Must be treated as security-critical, not an afterthought.

---

### Pitfall 2: `bypassPermissions` Used for "Simplicity" in Headless Mode

**What goes wrong:**
The Agent SDK requires permission resolution for every tool call. In the existing system, permissions were enforced by tool allowlist at definition time. Migrating developers set `permissionMode: "bypassPermissions"` to eliminate permission prompts and make the agent "just work." This is intended for containerized environments but is catastrophically wrong if the container isolation from Pitfall 1 is also missing.

**Why it happens:**
Documentation says `bypassPermissions` is for isolated environments, and the migration plan mentions running in Docker. Developers conflate "will run in Docker eventually" with "safe to bypass permissions now." The mode also silences all permission friction during development, making it attractive.

**How to avoid:**
Use `permissionMode: "acceptEdits"` with explicit `allowedTools` for the set of tools the agent needs. This auto-approves file edits (replacing the old `edit_file` tool) while still gating `Bash` commands behind allow rules. Pair with `disallowedTools` to block `WebSearch` and `WebFetch` explicitly, replicating the network isolation guarantee at the tool layer. Reserve `bypassPermissions` only for the final Phase 13 container where the proxy architecture is fully in place.

**Warning signs:**
- `permissionMode: "bypassPermissions"` appears in Phase 10 or Phase 11 code
- No `disallowedTools` list blocking network-capable tools
- Tests pass with bypassPermissions but no container isolation
- Developer reasoning: "We'll add the container later"

**Phase to address:** Phase 10 (Agent SDK Integration) — set the right permission mode from day one.

---

### Pitfall 3: `allowed_tools` Misunderstood as Tool Restriction

**What goes wrong:**
`allowedTools` does NOT prevent other tools from running. It only pre-approves listed tools so they run without prompting. Unlisted tools fall through to the permission mode — and in `bypassPermissions` mode, they run anyway. A developer sets `allowedTools: ["Read", "Edit", "Bash", "Glob", "Grep"]` expecting this to block `WebSearch`, `WebFetch`, and `Agent`. It doesn't.

**Why it happens:**
The naming is misleading. "Allowed tools" sounds like an allowlist, but it's an auto-approval list. The actual block mechanism is `disallowedTools`. The docs have a warning about this but it's easy to miss.

**How to avoid:**
Always pair `allowedTools` with `disallowedTools` for tools that must be blocked:
```typescript
{
  allowedTools: ["Read", "Edit", "Bash", "Glob", "Grep"],
  disallowedTools: ["WebSearch", "WebFetch", "Agent"],
  permissionMode: "dontAsk"  // TypeScript only: deny anything not in allowedTools
}
```
`dontAsk` mode (TypeScript only) is the correct setting for a headless agent: anything not in `allowedTools` is denied without prompting. In Python, `disallowedTools` is the only option.

**Warning signs:**
- `allowedTools` used without `disallowedTools`
- No explicit block on `WebSearch` or `WebFetch`
- Agent session logs show `WebSearch` calls that shouldn't be happening
- Security review asks "can the agent make external requests?" and the answer is "it's in the allowedTools list"

**Phase to address:** Phase 10 (Agent SDK Integration) — configure both lists together from the start.

---

### Pitfall 4: RetryOrchestrator `session.status` Logic Breaks on SDK Result Types

**What goes wrong:**
The current `RetryOrchestrator` relies on `SessionResult.status` values: `'success'`, `'failed'`, `'timeout'`, `'turn_limit'`. The Agent SDK `ResultMessage` has different subtype values: `'success'`, `'error_max_turns'`, `'error_max_budget_usd'`, `'error_during_execution'`. If the adapter mapping is wrong, `error_max_turns` might be treated as `'success'` (triggering verification on an incomplete run) or as `'failed'` (triggering a retry that won't help).

**Why it happens:**
The `ClaudeCodeSession` wrapper has to translate SDK result subtypes into the `SessionResult` interface. The mapping is easy to get slightly wrong — especially for `error_max_turns`, which is a turn-limit exhaustion (should map to `turn_limit`, which is terminal — do NOT retry per the existing retry logic comment in retry.ts).

**How to avoid:**
Write explicit mapping tests before connecting the wrapper to `RetryOrchestrator`. The mapping must be:
- `success` → `status: 'success'`
- `error_max_turns` → `status: 'turn_limit'` (terminal — no retry)
- `error_during_execution` → `status: 'failed'` (terminal — no retry)
- `error_max_budget_usd` → `status: 'failed'` (terminal — no retry)

Verify that `RetryOrchestrator.run()` short-circuits on these statuses (line 89 in retry.ts: `if (sessionResult.status !== 'success')`).

**Warning signs:**
- Retrying after `error_max_turns` (wastes money — agent already hit its limit)
- Skipping verification on a run that actually hit the turn limit
- `finalResponse` is empty string but status is `'success'`
- Unit tests for the adapter test the mapping explicitly

**Phase to address:** Phase 10 (Agent SDK Integration) — the wrapper interface is the highest-risk integration point.

---

### Pitfall 5: Stop Hook Throws and Verification Is Silently Skipped

**What goes wrong:**
The plan mentions using a Stop hook for verification within the agent session. If the Stop hook throws an unhandled exception, the Agent SDK's behavior is undefined — it may swallow the error or surface it as `error_during_execution`. Either way, the verification result is lost, and the calling code may not know verification was skipped. With the current architecture (verification outside the agent in `RetryOrchestrator`), this risk only applies if Phase 12 (MCP Verifiers) moves verification into the agent session via Stop hook.

**Why it happens:**
Stop hooks are async callbacks. An exception in an async hook that isn't caught propagates unpredictably. The official docs say unhandled exceptions in hooks can interrupt the agent. If the composite verifier throws (e.g., git stash fails, Maven not on PATH), the Stop hook crashes.

**How to avoid:**
Keep verification outside the agent in `RetryOrchestrator`. The existing architecture is correct. If Phase 12 adds a Stop hook, wrap the entire hook body in try/catch and return a structured result even on failure — never let exceptions propagate from hook callbacks. The hook should call `compositeVerifier()` and handle its errors the same way `RetryOrchestrator` does today.

**Warning signs:**
- Stop hook body not wrapped in try/catch
- Hook throws on `compositeVerifier` crash instead of returning error result
- Integration test: if maven is not installed, does the Stop hook still return cleanly?
- Verification metrics show 0ms duration (verifier never ran)

**Phase to address:** Phase 12 (MCP Verifiers, optional) — if Stop hook verification is added, this is the critical pattern to get right.

---

### Pitfall 6: System Prompt Disappears After SDK Upgrade (Breaking Change)

**What goes wrong:**
The Agent SDK v0.1.0 broke the default system prompt behavior. Prior versions used Claude Code's system prompt by default. v0.1.0+ uses a minimal system prompt unless you explicitly configure `systemPrompt`. If the migration pins an older SDK version and then upgrades, agent behavior changes silently — the agent loses coding context without any error.

**Why it happens:**
This is a documented breaking change, but it's easy to miss during upgrades. The agent still runs, still produces output, still passes verification — but produces lower-quality results because it lacks the system context that tells it how to behave as a coding agent.

**How to avoid:**
Explicitly set `systemPrompt` in the SDK options. For this project, the agent should use the SDK's built-in coding preset or a custom system prompt:
```typescript
options: {
  systemPrompt: { type: "preset", preset: "claude_code" }
  // OR custom prompt describing the task type
}
```
Pin the SDK version in `package.json` and test on upgrade with a known reference task.

**Warning signs:**
- SDK version pinned with `^` allowing minor/patch auto-upgrades
- No `systemPrompt` configured in the `ClaudeCodeSession` wrapper
- Agent quality regresses after `npm update` without code changes
- CHANGELOG.md for the SDK not checked before upgrading

**Phase to address:** Phase 10 (Agent SDK Integration) — set systemPrompt on initial integration; Phase 11 add upgrade testing note.

---

### Pitfall 7: Settings Sources Loading CLAUDE.md From Host Filesystem

**What goes wrong:**
The Agent SDK v0.1.0 no longer loads filesystem settings by default, but enabling `settingSources: ["project"]` loads `.claude/settings.json`, `CLAUDE.md`, and custom slash commands from the working directory. If the SDK runs with `cwd` pointing to the target workspace, it may load CLAUDE.md from the target repo — potentially injecting arbitrary instructions into the agent session.

**Why it happens:**
Developers enable `settingSources` because it sounds useful for loading project context. They don't realize it also loads any CLAUDE.md the target repository happens to contain, which could include instructions that conflict with the agent's task or enable prompt injection.

**How to avoid:**
Do not enable `settingSources` unless you control the target repository. For the background coding agent, where target repos are untrusted, `settingSources` should be left unset (the default). Project-level configuration should be passed explicitly via `systemPrompt` in the SDK options, not loaded from the filesystem.

**Warning signs:**
- `settingSources: ["project"]` in the SDK configuration
- `cwd` in the SDK options points to the target repo workspace
- No documentation on what CLAUDE.md files the target repos might contain
- Agent behaves differently on different target repos for the same task type

**Phase to address:** Phase 10 (Agent SDK Integration) — explicitly omit `settingSources` and document why.

---

### Pitfall 8: Test Coverage Gap During Big-Bang Deletion (Phase 11)

**What goes wrong:**
Phase 11 deletes `agent.ts`, `session.ts`, and `container.ts` (~1,200 lines) in one pass. The existing test files (`agent.test.ts`, `session.test.ts`, `container.test.ts`) test the deleted code directly. After deletion, there are no unit tests for the adapter layer, and the gap is only discovered when integration tests fail. If the integration tests are run against a real repo with a real API key, failures are slow and expensive to debug.

**Why it happens:**
The migration plan says "delete legacy agent infrastructure." It's easy to delete the old tests along with the old code without writing replacement tests first. The new `ClaudeCodeSession` wrapper is thin ("~50 lines"), making it feel like it doesn't need tests. But the behavior mapping (Pitfall 4) lives in those 50 lines.

**How to avoid:**
Write tests for `ClaudeCodeSession` wrapper behavior before deleting the legacy code. At minimum: unit tests for the `SessionResult` mapping from SDK `ResultMessage` subtypes, and integration tests that verify the wrapper fits the `RetryOrchestrator` contract. Only delete old tests after the new tests cover the same behaviors.

**Warning signs:**
- Phase 11 plan says "delete legacy code and their tests"
- No test file for `ClaudeCodeSession` wrapper
- `RetryOrchestrator` tests still mock `AgentSession` directly (they'd need updating)
- Integration test requires live API key and a real workspace

**Phase to address:** Phase 10 (write wrapper tests before Phase 11 deletion) and Phase 11 (verify test coverage before deleting).

---

### Pitfall 9: Bash Tool Is Unbounded Without `allowedTools` Scoping

**What goes wrong:**
The existing system's `bash_command` tool only allows `cat`, `head`, `tail`, `find`, `wc`. The Agent SDK's `Bash` tool runs any shell command. When `Bash` is in `allowedTools`, the agent can run arbitrary commands — `git push`, `curl`, `npm publish`, anything available in the container. This is a significant capability expansion that must be intentional.

**Why it happens:**
The migration plan says "gain 15+ built-in tools." `Bash` is one of them. Developers add `Bash` to `allowedTools` without restricting which commands it can run, because the previous system handled restriction at the tool definition layer.

**How to avoid:**
The Agent SDK supports scoped `Bash` allow rules: `"Bash(git:*)"` permits any git command, `"Bash(npm install)"` permits only that exact command. Use these granular rules instead of bare `Bash` in `allowedTools`. The rule syntax from `.claude/settings.json` works in the SDK `allowedTools` array. Example:
```typescript
allowedTools: ["Read", "Edit", "Glob", "Grep", "Bash(git status)", "Bash(git diff:*)"]
```
Define the minimal bash surface needed for the agent's task type, not open-ended `Bash`.

**Warning signs:**
- `"Bash"` appears in `allowedTools` without any command scoping
- No documentation of which bash commands the agent is expected to run
- Agent session logs show unexpected commands (npm install, git push)
- Security review can't answer "what bash commands can the agent run?"

**Phase to address:** Phase 10 (Agent SDK Integration) — get tool scoping right before connecting to `RetryOrchestrator`.

---

### Pitfall 10: hooks Not Firing When Agent Hits `maxTurns`

**What goes wrong:**
The official SDK documentation notes: "Hooks may not fire when the agent hits the `max_turns` limit because the session ends before hooks can execute." If the Stop hook is used for audit logging or cleanup, it may be silently skipped on turn-limit exhaustion — exactly the case the retry orchestrator treats as terminal.

**Why it happens:**
The hook documentation lists Stop as firing "when agent execution stops." Developers assume this means "always, for any reason." It doesn't. If `maxTurns` is hit, the session exits before the Stop hook runs.

**How to avoid:**
Don't rely on hooks for anything critical to correctness (verification, cleanup, audit). Place cleanup logic in the `finally` block of the `RetryOrchestrator.run()` method, which already exists and is guaranteed to run. Use hooks only for supplementary concerns (audit logging, metrics) and accept that they may not fire on limit-exceeded exits. Check `ResultMessage.subtype` explicitly instead of relying on hooks to signal terminal states.

**Warning signs:**
- Stop hook handles resource cleanup that must run on every exit
- Audit log shows sessions with no Stop hook entry but `error_max_turns` result
- Integration test doesn't cover "what happens on turn limit hit?"
- Cleanup logic only in Stop hook, not in retry.ts finally block

**Phase to address:** Phase 10 (Agent SDK Integration) — establish this pattern before Phase 12 adds hooks.

---

## Technical Debt Patterns

Shortcuts that seem reasonable but create long-term problems.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Use `bypassPermissions` during development | No permission friction | Security illusion if container not in place; dangerous habit | Never — use `acceptEdits` + `dontAsk` instead |
| Skip `disallowedTools` list | Simpler config | `WebSearch`/`WebFetch` run without warning; network requests from agent | Never for this project |
| Enable `settingSources: ["project"]` for convenience | Automatic project context | Loads CLAUDE.md from untrusted target repo; prompt injection vector | Only if target repos are trusted and controlled |
| Big-bang delete of legacy code in Phase 11 | Cleaner PR | No tests during transition; failures expensive to debug | Only after wrapper tests written in Phase 10 |
| Pin SDK with `^` range | Auto security patches | Breaking changes to system prompt/defaults silently change behavior | Only if upgrade testing exists |
| Keep `AgentSession` interface identical to old custom one | Minimal changes to retry.ts | Hides SDK-specific concepts (ResultMessage subtypes); harder to debug | Acceptable for Phase 10 adapter, but document the mapping clearly |

---

## Integration Gotchas

Common mistakes when connecting the Agent SDK to the existing verification pipeline.

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| `RetryOrchestrator` + SDK wrapper | Treating `error_max_turns` as retryable | Map to `turn_limit` status, which is terminal in retry.ts (line 89) |
| `compositeVerifier` timing | Running verifier before agent session stream closes | Await the full `for await` loop before calling verifier |
| Git operations | Assuming agent uses the same git execution model | Agent SDK's `Bash` runs git inside the container; host-side git in `session.ts` will no longer exist |
| `preVerify` hook (npm install) | Assuming it runs at same point in lifecycle | `preVerify` is called in `RetryOrchestrator` between session success and verifier — this contract is unchanged |
| LLM Judge | Judge receives `workspaceDir` + original task | Judge reads diff from the workspace; this is unchanged and doesn't interact with the SDK |
| `ErrorSummarizer` + retry message | Retry message format unchanged | The `buildRetryMessage` method in retry.ts is unchanged; only the session creation changes |
| Test mocking | Tests mock `AgentSession` — need to mock `ClaudeCodeSession` instead | Update `RetryOrchestrator` tests to mock the new wrapper; same interface |

---

## Security Mistakes

Migration-specific security issues.

| Mistake | Risk | Prevention |
|---------|------|------------|
| Passing `ANTHROPIC_API_KEY` into Docker container env | Key exposed to agent; agent could exfiltrate via prompt injection | Use proxy pattern: key lives outside container, injected by proxy into API calls |
| Mounting `.env` from target workspace into container | Secrets exposed to agent | Never mount credential files; the existing `edit_file` host-side execution model avoided this naturally |
| Running Agent SDK as root inside container | Container escape is more dangerous; `bypassPermissions` explicitly blocked for root | Non-root user (existing `--user 1001:1001`) must be preserved in Phase 13 |
| Not pinning Claude Code CLI version | CLI update changes agent behavior silently | Pin in Dockerfile; test before upgrading |
| `WebSearch` tool enabled without network restriction | Agent can exfiltrate code via search queries | Block via `disallowedTools`; enforce at container level |
| `Agent` tool enabled (subagents) | Subagents inherit `bypassPermissions`; each subagent is a new attack surface | Block `Agent` tool via `disallowedTools` for all phases; subagents not needed for this use case |

---

## "Looks Done But Isn't" Checklist

Things that appear complete but are missing critical pieces.

- [ ] **Agent SDK integration done:** Verify `disallowedTools` blocks `WebSearch`, `WebFetch`, and `Agent` — not just that `allowedTools` doesn't include them
- [ ] **Docker isolation preserved:** Verify `--network none` is in the Phase 13 container config, not just that the agent "runs in a container"
- [ ] **Turn limit works:** Verify `error_max_turns` result maps to `turn_limit` (terminal) not `failed` (also terminal) — the distinction matters for metrics
- [ ] **Hooks are optional:** Verify the system works correctly when Stop hook throws — verification must still run via `RetryOrchestrator`
- [ ] **Legacy tests replaced:** Verify that deleting `agent.test.ts` and `session.test.ts` doesn't leave the adapter layer untested
- [ ] **System prompt set:** Verify `systemPrompt` is explicitly configured, not relying on SDK default behavior
- [ ] **git operations work:** The agent previously used host-side git via `git_operation` tool. With Agent SDK's `Bash`, git runs inside the container — verify the container has git installed and the workspace is writable

---

## Recovery Strategies

When pitfalls occur despite prevention, how to recover.

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Network isolation removed | HIGH | Revert container config; add proxy pattern before re-deploying |
| `bypassPermissions` in production | HIGH | Roll back immediately; audit session logs for unexpected tool calls |
| Wrong `SessionResult` mapping | MEDIUM | Fix mapping in adapter; re-run integration tests; no data loss |
| Test coverage gap after Phase 11 deletion | MEDIUM | Write wrapper tests from scratch using integration tests as oracle; expensive but doable |
| System prompt disappears after upgrade | LOW | Pin SDK version; add explicit `systemPrompt` config; re-test with reference task |
| Stop hook swallowing verification results | HIGH | Move verification back to `RetryOrchestrator` (where it already is); never trust Stop hook for correctness |
| `settingSources` loading hostile CLAUDE.md | MEDIUM | Remove `settingSources`; audit recent sessions for unexpected behavior |

---

## Pitfall-to-Phase Mapping

How roadmap phases should address these pitfalls.

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Network isolation removed | Phase 13 (Container Strategy) | Docker config has `--network none` + proxy socket; agent can still reach API |
| `bypassPermissions` misuse | Phase 10 (Agent SDK Integration) | Permission mode set to `acceptEdits` + `dontAsk`; `bypassPermissions` absent |
| `allowedTools` misunderstood | Phase 10 (Agent SDK Integration) | `disallowedTools` list present; integration test shows `WebSearch` call is blocked |
| RetryOrchestrator mapping breaks | Phase 10 (Agent SDK Integration) | Unit test covers all `ResultMessage` subtype → `SessionResult.status` mappings |
| Stop hook throws silently | Phase 12 (MCP Verifiers, optional) | Hook body wrapped in try/catch; test with simulated verifier crash |
| System prompt breaking change | Phase 10 (Agent SDK Integration) | `systemPrompt` explicitly set; SDK pinned in package.json |
| settingSources loads hostile config | Phase 10 (Agent SDK Integration) | `settingSources` omitted; documented as intentional |
| Test coverage gap at deletion | Phase 10 → Phase 11 | `ClaudeCodeSession` wrapper tests pass before Phase 11 PRs merge |
| Bash tool unbounded | Phase 10 (Agent SDK Integration) | `allowedTools` uses scoped `Bash(...)` rules; integration test shows unbounded bash blocked |
| Stop hook skipped on maxTurns | Phase 10 (Agent SDK Integration) | Cleanup in `RetryOrchestrator.finally`; hooks used only for non-critical logging |

---

## Sources

- [Claude Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview) — HIGH confidence; verified via WebFetch 2026-03-16
- [Migrate to Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/migration-guide) — HIGH confidence; breaking changes confirmed via WebFetch 2026-03-16
- [Agent SDK Hooks](https://platform.claude.com/docs/en/agent-sdk/hooks) — HIGH confidence; hook availability, behavior, and "looks done but isn't" warnings from docs
- [Agent SDK Permissions](https://platform.claude.com/docs/en/agent-sdk/permissions) — HIGH confidence; `allowedTools` vs `disallowedTools` semantics confirmed
- [Agent SDK Secure Deployment](https://platform.claude.com/docs/en/agent-sdk/secure-deployment) — HIGH confidence; Docker + proxy pattern, `--network none` + Unix socket architecture
- [Agent SDK Hosting](https://platform.claude.com/docs/en/agent-sdk/hosting) — HIGH confidence; system requirements, container patterns
- [How the Agent Loop Works](https://platform.claude.com/docs/en/agent-sdk/agent-loop) — HIGH confidence; `maxTurns`, `ResultMessage` subtypes, hook-on-limit behavior
- Direct code analysis of `src/orchestrator/retry.ts`, `session.ts`, `agent.ts`, `verifier.ts` — HIGH confidence; first-party source

---
*Pitfalls research for: Claude Agent SDK migration (v2.0) — adding Agent SDK to existing background coding agent*
*Researched: 2026-03-16*
