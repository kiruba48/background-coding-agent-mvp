# Phase 11: Legacy Deletion - Research

**Researched:** 2026-03-17
**Domain:** TypeScript codebase cleanup — delete legacy agent infrastructure, remove dockerode dependency, migrate SessionConfig type
**Confidence:** HIGH

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Deletion order & safety**
- Single atomic delete — all 6 legacy files removed in one commit (agent.ts, session.ts, container.ts + 3 test files)
- All legacy types deleted (AgentClientOptions, SessionConfig from session.ts) — no aliases or deprecated re-exports
- RetryOrchestrator simplified to ClaudeCodeSession only — remove the if/else conditional branch entirely
- Barrel file (index.ts) clean sweep — remove all legacy re-exports, only export ClaudeCodeSession, RetryOrchestrator, and active types

**LLM Judge SDK dependency**
- Keep `@anthropic-ai/sdk` as production dependency — Judge uses structured output (BetaMessage) which requires the raw SDK
- This aligns with REQUIREMENTS.md: full SDK removal is explicitly out of scope
- Remove `dockerode` + `@types/dockerode` from package.json — container.ts is the only consumer, Phase 13 will add its own strategy if needed

**CLI flag cleanup**
- Remove `--no-use-sdk` flag completely from Commander options
- Remove `useSDK` property from types.ts / SessionConfig
- No deprecation warning or error message — clean removal

**Test coverage transfer**
- Behavioral equivalence, not line-for-line parity — ensure ClaudeCodeSession tests cover the same behaviors (security hooks, status mapping, error handling, turn limits)
- Review deleted test behaviors and verify ClaudeCodeSession tests (345 LOC) already cover them; add missing behavioral tests if gaps found
- retry.test.ts: swap MockAgentSession → MockClaudeCodeSession, keep same test logic
- judge.test.ts: swap AgentSession mock references → ClaudeCodeSession

### Claude's Discretion
- Exact order of operations within the atomic commit (delete files, update imports, update package.json)
- Whether to run `npm install` to regenerate lockfile after dockerode removal, or leave for CI
- Any additional dead code discovered during import cleanup (e.g., types only used by legacy files)

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| DEL-01 | `agent.ts` (AgentClient) deleted — replaced by Agent SDK built-in agentic loop | File has zero consumers outside the legacy chain (session.ts, agent.test.ts, index.ts). Safe to delete once index.ts re-exports are removed. |
| DEL-02 | `session.ts` (AgentSession) deleted — replaced by ClaudeCodeSession wrapper | `SessionConfig` interface lives in session.ts and is imported by claude-code-session.ts and retry.ts. Must be relocated to types.ts before deletion. |
| DEL-03 | `container.ts` (ContainerManager) deleted — replaced by spawnClaudeCodeProcess | Only consumer is session.ts (being deleted). index.ts re-exports it. No other file imports container.ts directly. |
| DEL-04 | `dockerode` dependency removed from package.json | Only consumer is container.ts (being deleted). Both `dockerode` and `@types/dockerode` must be removed from dependencies and devDependencies. |
| DEL-05 | All tests for deleted files replaced with ClaudeCodeSession integration tests | legacy test files (agent.test.ts, session.test.ts, container.test.ts) are integration tests using process.exit() — no vitest `describe` blocks. ClaudeCodeSession already has 16 unit tests covering target behaviors. Gaps must be assessed from behavioral inventory. |
</phase_requirements>

---

## Summary

Phase 11 is a pure deletion and cleanup phase — approximately 1,978 lines of legacy code removed, zero lines of new production code. All deletion targets are fully self-contained: `agent.ts`, `session.ts`, and `container.ts` form a closed dependency chain (container.ts ← session.ts ← agent.ts), and no files outside this chain or the barrel `index.ts` import them directly.

There is one non-trivial prerequisite before deleting `session.ts`: the `SessionConfig` interface currently lives in `session.ts` and is actively imported by `claude-code-session.ts` (line 11) and `retry.ts` (line 2). This interface must be moved to `types.ts` (or a new dedicated types file) before `session.ts` is deleted, and all three importers updated. The `useSDK` field on `SessionConfig` is also deleted at this point.

The test situation requires attention. The three legacy test files (`agent.test.ts`, `session.test.ts`, `container.test.ts`) do not use Vitest — they are ad-hoc integration scripts using `process.exit()`. They currently cause 6 test suite failures in `npm test` because Vitest cannot find any `describe` blocks in them (and they are also present in the `dist/` folder, doubling the failures). Deleting them will immediately improve the test run. The `ClaudeCodeSession` test suite (345 LOC, 16 tests) already covers the behavioral equivalents; the planner should verify against the behavioral inventory below and add any missing behavioral tests to `claude-code-session.test.ts`.

**Primary recommendation:** Relocate `SessionConfig` to `types.ts` first (removing `useSDK`), then delete the 6 legacy files, update all import sites, clean up `retry.ts` and `retry.test.ts`, simplify `index.ts`, remove dockerode from `package.json`, and remove CLI flags. All changes can be sequenced within a single commit.

---

## Standard Stack

### Core (unchanged — no new dependencies)
| Library | Version (verified) | Purpose | Status |
|---------|-------------------|---------|--------|
| vitest | ^4.0.18 | Test framework for all unit tests | Already installed |
| typescript | ^5.7.2 | Type checking | Already installed |
| @anthropic-ai/claude-agent-sdk | ^0.2.77 | SDK session (the replacement runtime) | Already installed |
| @anthropic-ai/sdk | ^0.71.2 | LLM Judge structured output — KEEP | Already installed |

### Removed
| Library | From | Reason |
|---------|------|--------|
| dockerode | dependencies | Only consumer is container.ts, which is deleted |
| @types/dockerode | devDependencies | Type definitions for deleted library |

**No installation required** — only removal:
```bash
npm uninstall dockerode @types/dockerode
```

---

## Architecture Patterns

### File Dependency Map (before deletion)

```
src/orchestrator/
├── agent.ts              # AgentClient — to DELETE
├── session.ts            # AgentSession + SessionConfig — to DELETE (after moving SessionConfig)
├── container.ts          # ContainerManager — to DELETE
├── agent.test.ts         # integration script, no vitest — to DELETE
├── session.test.ts       # integration script, no vitest — to DELETE
├── container.test.ts     # integration script, no vitest — to DELETE
│
├── claude-code-session.ts    # imports SessionConfig from session.ts — UPDATE import
├── retry.ts              # imports AgentSession + SessionConfig from session.ts — SIMPLIFY
├── retry.test.ts         # vi.mock('./session.js') + import AgentSession — REMOVE mock
├── judge.test.ts         # vi.mock('./session.js') + import AgentSession — REMOVE mock
└── index.ts              # re-exports legacy types — CLEAN UP
src/types.ts              # RECEIVE SessionConfig (minus useSDK field)
src/cli/index.ts          # --no-use-sdk flag — REMOVE
src/cli/commands/run.ts   # useSDK property in RunOptions — REMOVE
```

### Pattern 1: SessionConfig Migration (REQUIRED before deletion)

`SessionConfig` must move out of `session.ts` before that file is deleted. It is the only interface actively used by non-legacy code.

**Current state:** `session.ts` exports `SessionConfig` with `useSDK?: boolean` field.
**Target state:** `types.ts` exports `SessionConfig` without `useSDK`.

The `SessionConfig` interface post-migration:
```typescript
// Move to src/types.ts — remove useSDK field
export interface SessionConfig {
  workspaceDir: string;
  image?: string;
  model?: string;
  turnLimit?: number;    // default: 10
  timeoutMs?: number;    // default: 300000 (5 minutes)
  logger?: pino.Logger;
  // useSDK removed — ClaudeCodeSession is the only runtime
}
```

Consumers to update after moving:
- `src/orchestrator/claude-code-session.ts` line 11: `import { type SessionConfig } from './session.js'` → `import { type SessionConfig } from '../types.js'`
- `src/orchestrator/retry.ts` line 2: `import { AgentSession, SessionConfig } from './session.js'` → `import { type SessionConfig } from '../types.js'`
- `src/orchestrator/index.ts` line 27: `export type { SessionConfig } from './session.js'` → `export type { SessionConfig } from '../types.js'`

### Pattern 2: RetryOrchestrator Simplification

**Current state** (retry.ts lines 29 and 76-78):
```typescript
private activeSession: AgentSession | ClaudeCodeSession | null = null;

const session = this.config.useSDK !== false
  ? new ClaudeCodeSession(this.config)
  : new AgentSession(this.config);
```

**Target state:**
```typescript
private activeSession: ClaudeCodeSession | null = null;

const session = new ClaudeCodeSession(this.config);
```

Also update JSDoc comment on line 17 which references `AgentSession`.

### Pattern 3: retry.test.ts Cleanup

Two things to remove from `retry.test.ts`:
1. The `vi.mock('./session.js', ...)` block (lines 6-9)
2. The `import { AgentSession } from './session.js'` (line 20)
3. The `const MockAgentSession = AgentSession as ReturnType<typeof vi.fn>` (line 23)

The `MockAgentSession` variable is declared but never used in any test after Phase 10 — all tests already use `MockClaudeCodeSession`. Confirmed by reading the test file: every `mockImplementationOnce` call uses `MockClaudeCodeSession`.

### Pattern 4: judge.test.ts Cleanup

Same pattern as retry.test.ts. Remove:
1. `vi.mock('./session.js', ...)` block (lines 28-31)
2. `import { AgentSession } from './session.js'` (line 49)
3. `const MockAgentSession = AgentSession as ReturnType<typeof vi.fn>` (line 52)

Note: `MockAgentSession` is declared but completely unused in `judge.test.ts`. The comment on line 439 ("Helper to create a mock AgentSession") also needs updating — the function actually creates a generic mock session object, not tied to AgentSession.

### Pattern 5: index.ts Barrel Cleanup

**Current exports to remove:**
```typescript
// DELETE these lines:
export { ContainerManager } from './container.js';
export { AgentClient } from './agent.js';
export { AgentSession } from './session.js';
export type { Tool, ToolCall, ToolResultInput, ExecuteToolFn, OnTextFn, AgentClientOptions } from './agent.js';
export type { SessionConfig } from './session.js';
```

**Add after `SessionConfig` moves to types.ts:**
```typescript
export type { SessionConfig } from '../types.js';
```

### Pattern 6: CLI Flag Removal

**src/cli/index.ts** — delete line 18:
```typescript
// DELETE:
.option('--no-use-sdk', 'Fall back to legacy AgentSession (for debugging)')
```
And delete line 108:
```typescript
// DELETE:
useSDK: options.useSdk !== false,
```

**src/cli/commands/run.ts** — delete from `RunOptions` interface:
```typescript
// DELETE from RunOptions:
useSDK?: boolean;          // default: true — use ClaudeCodeSession; --no-use-sdk falls back to legacy AgentSession
```
And delete from the orchestrator config object (line 84):
```typescript
// DELETE:
useSDK: options.useSDK,
```

### Pattern 7: package.json scripts cleanup

After deleting legacy test files, remove from `package.json`:
```json
"test:agent": "npx tsx src/orchestrator/agent.test.ts",
"test:container": "npx tsx src/orchestrator/container.test.ts",
"test:session": "npx tsx src/orchestrator/session.test.ts",
"test:all": "npm run test:container && npm run test:agent && npm run test:session && npm run test:unit",
```
These scripts reference the deleted files. `test:unit` can be kept or renamed.

### Anti-Patterns to Avoid
- **Forgetting SessionConfig migration:** Deleting `session.ts` before moving `SessionConfig` will break `claude-code-session.ts` and `retry.ts` at compile time.
- **Partial import cleanup:** Leaving `vi.mock('./session.js')` in test files after `session.js` is deleted will cause Vitest to error at module resolution even with factory mocks.
- **Leaving dist/ stale:** The `dist/` directory still contains compiled versions of legacy files. These are picked up by Vitest's glob and cause "No test suite found" failures. Either add `dist/` to Vitest's exclude list, or re-run `npm run build` after deletion.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Type relocation | Custom type re-export alias | Move interface directly to types.ts | Aliases preserve dead code; clean move removes all coupling |
| Import path updates | Manual find-replace | TypeScript compiler errors as guide | TSC will error on every broken import after deletion — let it drive |
| Test coverage verification | Counting lines | Behavioral checklist (see below) | Line parity is meaningless; behavioral coverage is the measure |

---

## Common Pitfalls

### Pitfall 1: dist/ directory causes spurious test failures
**What goes wrong:** Vitest picks up `dist/orchestrator/agent.test.js`, `dist/orchestrator/session.test.js`, `dist/orchestrator/container.test.js` because there is no `vitest.config.ts` to exclude them. These compiled files have no `describe` blocks and cause 3 additional "No test suite found" failures on top of the 3 from `src/`.
**Why it happens:** No vitest config exists; `vitest run` uses default file discovery which includes `dist/`.
**How to avoid:** Either delete the `dist/` folder before running the final test check, add a `vitest.config.ts` with `exclude: ['dist/**']`, or run `npm run build` after all deletions to regenerate `dist/` without legacy files.
**Warning signs:** `npm test` reports 6 failures (3 in src/ + 3 in dist/) rather than 3. Currently this is the baseline state.

### Pitfall 2: SessionConfig import chain breaks on deletion
**What goes wrong:** `claude-code-session.ts` line 11 imports `SessionConfig` from `./session.js`. If `session.ts` is deleted without relocating `SessionConfig`, the entire ClaudeCodeSession module fails to compile.
**Why it happens:** SessionConfig was defined in session.ts for historical reasons (it was the primary session type's config).
**How to avoid:** Move `SessionConfig` to `types.ts` (removing `useSDK` field) and update all three import sites BEFORE deleting `session.ts`. TypeScript compiler errors will confirm all sites are updated.

### Pitfall 3: vi.mock for deleted module causes test errors
**What goes wrong:** Leaving `vi.mock('./session.js', ...)` in `retry.test.ts` and `judge.test.ts` after `session.ts` is deleted causes Vitest to try to load the module factory. In hoisted mode, it attempts to resolve the path.
**Why it happens:** vi.mock factory runs at hoist time regardless of whether the module is used.
**How to avoid:** Remove both `vi.mock('./session.js')` blocks AND the corresponding import statements from both test files.

### Pitfall 4: package.json scripts reference deleted test files
**What goes wrong:** `npm run test:agent`, `npm run test:session`, `npm run test:container`, and `npm run test:all` all reference deleted files and will fail with "file not found".
**Why it happens:** Package.json was never updated to remove legacy-specific scripts.
**How to avoid:** Delete all four legacy test scripts from package.json as part of the same cleanup commit.

---

## Code Examples

### SessionConfig relocated to types.ts
```typescript
// Source: src/orchestrator/session.ts lines 35-43 (current), moving to src/types.ts
// Remove image? (docker-specific) and useSDK? fields; keep SDK-relevant fields
export interface SessionConfig {
  workspaceDir: string;
  model?: string;
  turnLimit?: number;    // default: 10
  timeoutMs?: number;    // default: 300000 (5 minutes)
  logger?: pino.Logger;
}
```

Note: `image?` is a Docker image field used only by `ContainerManager` (being deleted). Research confirms `claude-code-session.ts` does not use it. Removing it eliminates dead config from the interface.

### RetryOrchestrator after simplification (key lines only)
```typescript
// retry.ts — three changes
// 1. Line 2: remove AgentSession import entirely; import only SessionConfig from types.ts
import { type SessionConfig } from '../types.js';

// 2. Line 29: drop union type
private activeSession: ClaudeCodeSession | null = null;

// 3. Lines 76-78: remove conditional
const session = new ClaudeCodeSession(this.config);
```

### Vitest config to fix dist/ inclusion (optional but recommended)
```typescript
// vitest.config.ts (new file)
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    exclude: ['dist/**', 'node_modules/**'],
  },
});
```
This is a discretionary add — the planner may choose to simply delete `dist/` instead.

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Custom AgentSession + ContainerManager | ClaudeCodeSession (SDK query()) | Phase 10 | 940 LOC replaced by ~200 LOC wrapper |
| dockerode for container lifecycle | SDK manages its own subprocess | Phase 10 | No Docker dependency in the hot path |
| --no-use-sdk flag for debug fallback | SDK-only path | Phase 11 | Flag removal simplifies all entry paths |

**Deprecated after Phase 11:**
- `AgentClientOptions` type: only used in agent.ts exports
- `SessionConfig.useSDK`: replaced by unconditional ClaudeCodeSession instantiation
- `ContainerConfig` interface in types.ts: still there but only referenced by container.ts. Verify whether it's used after deletion — if not, remove it too.

---

## Behavioral Inventory: Legacy Tests vs. ClaudeCodeSession Tests

This is the critical coverage transfer check. Legacy test files are integration scripts (not Vitest), so behaviors must be inferred from reading them.

| Legacy Behavior | Source File | Covered in claude-code-session.test.ts? |
|----------------|-------------|----------------------------------------|
| Session succeeds, returns SessionResult with status='success' | session.test.ts | YES — makeSuccessResult() helpers |
| Session maps turn_limit to status='turn_limit' | session.test.ts | YES — turn limit tests |
| Session maps timeout to status='timeout' | session.test.ts | YES — timeout tests |
| Security hook blocks writes outside repo | session.test.ts | YES — PreToolUse hook tests |
| Security hook blocks writes to .env files | session.test.ts | YES — SENSITIVE_PATTERNS tests |
| Audit trail logs Edit/Write tool calls | session.test.ts | YES — PostToolUse hook tests |
| toolCallCount incremented per tool use | session.test.ts | YES — toolCallCount tests |
| AgentClient retry on 429/529 | agent.test.ts | N/A — SDK handles this internally; not needed |
| ContainerManager start/stop lifecycle | container.test.ts | N/A — no container in SDK path |

**Assessment:** ClaudeCodeSession test suite (16 tests, 345 LOC) already covers all semantically relevant behaviors from the legacy tests. No additional tests are required unless the planner finds gaps during implementation review.

---

## Open Questions

1. **ContainerConfig interface in types.ts**
   - What we know: `ContainerConfig` interface (lines 1-7 of types.ts) is a Docker container config struct
   - What's unclear: Whether any code outside `container.ts` still references it after Phase 11
   - Recommendation: Grep for `ContainerConfig` after deleting container.ts. If no other consumer, remove from types.ts in the same commit.

2. **`image?` field in SessionConfig**
   - What we know: Defined in session.ts as part of `SessionConfig`, but `claude-code-session.ts` never reads it
   - What's unclear: Whether any external consumer (e.g., test fixtures, docs) passes `image` and would break silently if removed
   - Recommendation: Remove when migrating SessionConfig to types.ts. No code outside session.ts uses it (confirmed by grep).

3. **dist/ directory handling**
   - What we know: dist/ currently contains compiled legacy test files that cause 3 spurious Vitest failures
   - What's unclear: Whether the project's CI workflow rebuilds dist/ automatically
   - Recommendation: Planner should include either (a) adding `vitest.config.ts` with exclude, or (b) deleting `dist/` as a step. Option (a) is cleaner long-term.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest ^4.0.18 |
| Config file | none — default discovery (dist/ issue noted above) |
| Quick run command | `npx vitest run src/orchestrator/retry.test.ts src/orchestrator/judge.test.ts src/orchestrator/claude-code-session.test.ts` |
| Full suite command | `npm test` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DEL-01 | agent.ts no longer exists in src/ | compile check | `npx tsc --noEmit` | N/A (deletion) |
| DEL-02 | session.ts no longer exists in src/ | compile check | `npx tsc --noEmit` | N/A (deletion) |
| DEL-03 | container.ts no longer exists in src/ | compile check | `npx tsc --noEmit` | N/A (deletion) |
| DEL-04 | dockerode absent from package.json | manual check | `grep dockerode package.json` | N/A (deletion) |
| DEL-05 | npm test passes with same or greater coverage | unit | `npm test` | ✅ claude-code-session.test.ts |

### Sampling Rate
- **Per task commit:** `npx vitest run src/orchestrator/retry.test.ts src/orchestrator/judge.test.ts src/orchestrator/claude-code-session.test.ts`
- **Per wave merge:** `npm test`
- **Phase gate:** Full suite green (all 363+ tests pass) before `/gsd:verify-work`

### Wave 0 Gaps
None — existing test infrastructure covers all phase requirements. The 6 current test failures are caused by legacy test files that will be deleted in this phase, so they resolve automatically.

---

## Sources

### Primary (HIGH confidence)
- Direct code inspection of all affected source files (agent.ts, session.ts, container.ts, retry.ts, retry.test.ts, judge.test.ts, index.ts, types.ts, cli/index.ts, cli/commands/run.ts)
- `package.json` — confirmed dockerode at ^4.0.2, @types/dockerode at ^3.3.36
- `npm test` output — confirmed current baseline: 6 failed (legacy test files) | 13 passed | 363 tests

### Secondary (MEDIUM confidence)
- CONTEXT.md — locked decisions from /gsd:discuss-phase session
- REQUIREMENTS.md — DEL-01 through DEL-05 requirement definitions
- STATE.md — accumulated context including LLM Judge migration decision

### Tertiary (LOW confidence)
- None required — all findings are grounded in direct code inspection

---

## Metadata

**Confidence breakdown:**
- File inventory and deletion targets: HIGH — direct filesystem inspection
- SessionConfig migration requirement: HIGH — confirmed by reading import statements in claude-code-session.ts line 11
- Test coverage adequacy: HIGH — 16 tests in claude-code-session.test.ts confirmed against behavioral inventory
- dist/ spurious failure issue: HIGH — observed in npm test output (6 failures, not 3)
- ContainerConfig cleanup: MEDIUM — likely dead code after deletion, but requires post-deletion grep to confirm

**Research date:** 2026-03-17
**Valid until:** 2026-04-17 (stable codebase, no fast-moving dependencies)
