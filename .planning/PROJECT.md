# Background Coding Agent

## What This Is

A background coding agent platform that automates software maintenance tasks — dependency updates, refactors, config changes — using Claude as the agent engine. The agent runs in isolated Docker containers, makes verified changes, and creates PRs for human review. MVP proves the architecture with Maven dependency updates; designed to be extensible to other task types.

## Core Value

The full verification loop must work: agent changes code, deterministic verifiers catch failures, LLM Judge catches scope creep, and only verified changes become PRs. Without this, the platform can't be trusted.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] CLI can trigger agent runs with task type and target repo
- [ ] Agent executes in isolated Docker container with no external network
- [ ] Agent can explore codebase and understand project structure
- [ ] Agent can plan which changes to make based on task type
- [ ] Agent can execute changes (edit files, run commands)
- [ ] Deterministic verifiers check build, tests, linting pass
- [ ] LLM Judge evaluates changes against original prompt for scope creep
- [ ] Failed verification triggers retry with error context (configurable max retries)
- [ ] Successful verification creates PR with descriptive body
- [ ] All agent sessions tracked for observability
- [ ] Maven dependency update task type implemented end-to-end

### Out of Scope

- Queue/webhook triggers — CLI only for MVP, architecture should support later
- npm/other task types — prove with Maven first, add later
- Auto-merge — human approval required
- Slack/notification integrations — manual PR review sufficient
- Multi-repo batch operations — single repo per run
- Real-time streaming UI — CLI output sufficient

## Context

**Inspiration:** Spotify's background coding agent architecture ("The Sandwich" pattern):
1. Internal CLI (Orchestrator) — manages agent lifecycle, formatting, trace collection
2. Claude Code (Agent Engine) — agentic loop with multi-file context
3. MCP Tools Layer — limited, safe toolset
4. Verification Loop — deterministic verifiers + LLM Judge

**Key learnings from Spotify:**
- End-state prompting beats step-by-step instructions
- Limited tool access prevents unpredictability
- LLM Judge catches ~25% of problematic sessions
- Turn limits (~10) prevent cost overruns
- One change type per session

**Agent engine decision pending:** Need to evaluate Claude Code CLI vs Agent SDK vs raw API. Research phase should inform this.

**Stack flexible:** Python-based, Docker containers required. Specific libraries (CLI framework, tracking system) open to research.

## Constraints

- **Isolation**: Agent must run in Docker with no external network access — security non-negotiable
- **Verification**: Never skip verification loop — core to trust model
- **Human approval**: PRs require human merge — no auto-merge
- **Turn limits**: Agent sessions capped to prevent runaway costs
- **Single task**: One change type per agent session to maintain focus

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Docker sandbox (not subprocess) | Full isolation required for security model | — Pending |
| Retry on verification failure | Agent can often self-correct with error context | — Pending |
| PR description as spec | Keeps documentation with the change, no separate artifacts | — Pending |
| Maven first, npm later | Prove architecture with one type before extending | — Pending |
| Agent engine TBD | Need research on CLI vs SDK vs raw API tradeoffs | — Pending |

---
*Last updated: 2025-01-25 after initialization*
