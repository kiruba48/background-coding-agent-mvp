# Phase 15: Intent Parser + One-Shot Mode - Context

**Gathered:** 2026-03-20
**Status:** Ready for planning

<domain>
## Phase Boundary

Natural language input is parsed into structured task parameters with a fast path for obvious patterns, and a complete one-shot workflow (parse → confirm → run) is functional from the command line. No REPL, no multi-turn sessions, no new task types.

</domain>

<decisions>
## Implementation Decisions

### Confirm flow UX
- Structured summary display after parsing: show task type, repo, dep, version in a compact block, then `Proceed? [Y/n]`
- On redirect ('n'): user types a correction, intent parser re-parses the correction in context of the original parse
- Maximum 3 redirect attempts before aborting with "Please try again with a clearer command"
- Always confirm — no `--yes` skip mechanism. Every run requires interactive confirmation (aligns with human-in-the-loop trust model)

### Fast-path patterns
- Regex/heuristic handles dependency update patterns: "update recharts", "update recharts to 2.15.0", "upgrade lodash"
- Task type inferred by scanning cwd/resolved project for manifest: package.json → npm-dependency-update, pom.xml → maven-dependency-update. Both or neither → fall through to LLM
- When no version specified, fast-path sets `"latest"` sentinel — agent resolves actual version at runtime inside Docker. Version never comes from LLM (matches STATE.md decision)
- Fast-path validates dependency exists in manifest (package.json/pom.xml). If dep not found, falls through to LLM for possible fuzzy match or clarification

### Ambiguity handling
- LLM uses `messages.create()` structured output (Haiku 4.5) with Zod schema — NOT `query()` (matches STATE.md decision)
- Zod schema fields: taskType, dep, version (sentinel), confidence (high/low), clarifications[] (label + intent pairs)
- Context scan happens BEFORE LLM call: read package.json/pom.xml dep list and inject as structured context into LLM prompt (satisfies INTENT-03)
- Clarification presented as numbered choices: LLM generates 2-3 interpretations, user picks a number
- Unrecognized input passes through as generic task with the raw input as prompt (uses existing default prompt path in buildPrompt)

### CLI invocation shape
- Positional arg as natural language input: first non-flag arg is treated as NL. Existing flags (-t, -r, --dep, etc.) still work for backward compat. Both paths converge at runAgent()
- Flags and NL can mix: `bg-agent -r ~/code/myapp 'update recharts'`

### Repo/project resolution
- Primary: registry name extracted from NL input ("update recharts in myapp" → registry lookup)
- Fallback: `-r` flag for explicit path (backward compat, one-off runs)
- If project name not in registry: prompt user for local path, register it, then proceed
- If neither registry name nor `-r` flag: prompt with list of registered projects
- Channel-agnostic design: same resolution works from terminal, future Slack, or any input source

### Claude's Discretion
- Intent parser module structure and internal architecture
- Regex patterns for fast-path matching (exact syntax)
- LLM system prompt design for intent parsing
- How to detect positional arg vs flag in Commander.js
- Confirm flow rendering (colors, formatting, spacing)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Architecture & entry points
- `src/cli/index.ts` — Current CLI entry point with flag-based invocation (to be extended with positional NL arg)
- `src/agent/index.ts` — runAgent() public API that one-shot path calls after confirm
- `src/agent/registry.ts` — ProjectRegistry for short name → repo path resolution

### Prompt system
- `src/prompts/index.ts` — buildPrompt() dispatcher with task type routing + generic fallback (line 38-40)
- `src/prompts/maven.ts` — Maven prompt builder (pattern for new prompt paths)
- `src/prompts/npm.ts` — npm prompt builder

### Type definitions
- `src/types.ts` — SessionConfig, AgentOptions, RetryResult types that intent parser must produce

### Requirements
- `.planning/REQUIREMENTS.md` — INTENT-01, INTENT-02, INTENT-03, CLI-01, CLI-03 requirement definitions

### Prior decisions
- `.planning/STATE.md` §Accumulated Context — Intent parser uses messages.create() (not query()), version sentinel decision, "latest" resolution integration point

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `ProjectRegistry` (src/agent/registry.ts): Already has CRUD + resolve. Used for "in myapp" extraction
- `buildPrompt()` (src/prompts/index.ts): Has generic fallback at line 38 — unrecognized task types pass through naturally
- `autoRegisterCwd` (src/cli/auto-register.ts): Auto-registration logic for newly prompted paths
- `runAgent()` (src/agent/index.ts): Clean library API accepting AgentOptions — intent parser produces these

### Established Patterns
- Commander.js for CLI parsing (src/cli/index.ts) — extend with positional arg detection
- Pino structured logging — intent parser should log parse results at debug level
- Zod already in use for structured output (LLM Judge) — same pattern for intent parser schema
- Task type dispatching via switch in buildPrompt() — new task types plug in here

### Integration Points
- CLI entry (src/cli/index.ts): Add NL positional arg path before existing flag validation
- `AgentOptions` interface (src/agent/index.ts): Intent parser output must map to this interface
- `buildPrompt()`: Generic task type uses raw input as prompt — no new prompt builder needed for unknown types
- Phase 16 REPL will reuse the same intent parser module

</code_context>

<specifics>
## Specific Ideas

- Confirm flow should feel like a quick sanity check, not a wizard — one compact block, one Y/n
- Registry-first design is intentionally channel-agnostic: same "in myapp" syntax works from terminal and future Slack bot (INTG-01)
- Fast-path should feel instant — no spinner, no delay. LLM path shows a brief "Parsing..." indicator
- Correction re-parse ("no, update to 2.14.0 instead") should feel conversational, not like starting over

</specifics>

<deferred>
## Deferred Ideas

- `--yes` flag for auto-confirming high-confidence parses (CI/scripting use case) — defer to v2.2 (INTG-02)
- GitHub clone on demand for repos not cloned locally — future phase
- Tab completion for project names — deferred (CLI-04)

</deferred>

---

*Phase: 15-intent-parser-one-shot-mode*
*Context gathered: 2026-03-20*
