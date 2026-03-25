# Phase 19: Generic Prompt Builder - Context

**Gathered:** 2026-03-24
**Status:** Ready for planning

<domain>
## Phase Boundary

Agent sessions for generic tasks receive a scope-fenced end-state prompt derived from the user's instruction, and users see a meaningful task summary before confirming. This phase builds `buildGenericPrompt()`, wires the dispatch in `buildPrompt()`, and updates `displayIntent()` for generic tasks. Verification changes are Phase 20.

</domain>

<decisions>
## Implementation Decisions

### Scope fence design
- Instruction-derived scope fence: parse key terms from user instruction, generate natural-language SCOPE block
- User instruction included **verbatim** in the prompt — no paraphrasing or rewriting (per REQUIREMENTS.md out-of-scope: "Automatic instruction rewriting")
- SCOPE block follows the npm/maven pattern: explicit "Do NOT" list (no unrelated deps, no unrelated files, no restructuring, no style changes)
- Include end-state "After your changes, the following should be true:" block derived from the instruction — follows established pattern from npm.ts/maven.ts
- Include "Work in the current directory." line at the end — consistent with existing builders

### Repo context injection
- Use existing `readManifestDeps()` from `context-scanner.ts` for manifest summary (package.json deps, pom.xml deps)
- Fetch manifest at prompt-build time inside `buildGenericPrompt()`, not during intent parsing
- Add `repoPath?: string` to `PromptOptions` interface — buildGenericPrompt() uses it to call readManifestDeps()
- If readManifestDeps() returns 'No manifest found', omit the CONTEXT block entirely — agent self-discovers
- Make `buildPrompt()` async (returns `Promise<string>`) since readManifestDeps() is async — update callers (agent/index.ts, tests)

### Confirm loop display
- Display `taskCategory` ('code-change', 'config-edit', 'refactor') in the Task line instead of raw 'generic'
- Add "Action:" line showing the raw user instruction (description field)
- Truncate description at 80 characters with ellipsis in display — full text still used in prompt
- Layout for generic tasks:
  ```
  Parsed Intent:
    Task:     code-change
    Action:   replace axios with fetch
    Project:  my-app
    PR:       yes
  ```
- Dep/Version lines hidden when null (already the case — just verify)

### Retry prompt preservation
- Existing flow is correct: `buildPrompt()` output passed as `originalTask` to `orchestrator.run()` — retries reuse the same string
- No separate caching needed — just verify generic path follows the same flow as npm/maven
- Prompt is built once, includes SCOPE + CONTEXT + end-state, and survives all retry attempts unchanged

### PR creator adaptation
- Adapt `GitHubPRCreator` for generic tasks: derive branch name from taskCategory + short slug of description (e.g., 'code-change/replace-axios-with-fetch')
- PR title uses the instruction text — meaningful for reviewers
- PR body includes the instruction and taskCategory label

### Claude's Discretion
- Exact wording of the SCOPE "Do NOT" items beyond the core four
- How to extract key terms from instruction for the SCOPE subject line
- Branch name slug generation (length limits, character sanitization)
- Test coverage breadth for the new builder and display changes

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Prompt builders (pattern to follow)
- `src/prompts/npm.ts` — End-state prompt pattern with SCOPE block, "After your changes" block, and "Work in the current directory" line
- `src/prompts/maven.ts` — Same pattern for Maven tasks
- `src/prompts/index.ts` — `buildPrompt()` dispatch, `PromptOptions` interface (needs repoPath addition + async)

### Intent types and confirm loop
- `src/intent/types.ts` — `ResolvedIntent` interface with description, taskCategory, TaskCategory type, TASK_CATEGORIES enum
- `src/intent/confirm-loop.ts` — `displayIntent()` function to update for generic task display
- `src/intent/context-scanner.ts` — `readManifestDeps()` for repo context injection

### Agent runner (caller to update)
- `src/agent/index.ts` — `runAgent()` calls `buildPrompt()` at line 169, passes result to orchestrator. Must await async buildPrompt() and pass repoPath.

### PR creator
- `src/orchestrator/pr-creator.ts` — `GitHubPRCreator` for branch naming and PR body adaptation

### Requirements
- `.planning/REQUIREMENTS.md` — PROMPT-01, PROMPT-02, PROMPT-03 requirements

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `readManifestDeps()` in `context-scanner.ts` — returns structured string of package.json/pom.xml deps, ready for prompt injection
- `buildNpmPrompt()` / `buildMavenPrompt()` — established end-state prompt pattern to replicate
- `PromptOptions` interface — extensible with new fields (repoPath)
- `displayIntent()` — already conditionally shows Dep/Version when present, just needs generic branch

### Established Patterns
- End-state prompting (TASK-04): describe desired outcome, not steps — agent discovers current state
- SCOPE block with explicit "Do NOT" constraints — proven in npm/maven builders
- `buildPrompt()` dispatches on `taskType` via switch statement — add `'generic'` case
- Instruction passed verbatim as `description` on `ResolvedIntent` — no rewriting anywhere in the pipeline

### Integration Points
- `src/agent/index.ts:169` — `buildPrompt()` call site, needs `await` and `repoPath: options.repo`
- `src/cli/commands/one-shot.ts:187` — maps `confirmed.description` to `AgentOptions.description` (already done)
- `src/repl/session.ts:120` — maps `confirmed.description` (already done)
- `src/orchestrator/pr-creator.ts` — receives taskType and originalTask, needs generic-aware branch/title logic

</code_context>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 19-generic-prompt-builder*
*Context gathered: 2026-03-24*
