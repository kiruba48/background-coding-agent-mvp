# Phase 5: Deterministic Verification - Context

**Gathered:** 2026-02-18
**Status:** Ready for planning

<domain>
## Phase Boundary

Implement three deterministic verifiers (build, test, lint) that plug into the RetryOrchestrator's verifier callback. Each verifier runs as a host-side subprocess against the target workspace. Failed verification triggers retry with summarized error context. Also includes installing ESLint v10 and creating the project's ESLint config.

</domain>

<decisions>
## Implementation Decisions

### Lint rule strictness
- Use `typescript-eslint` **recommended** rules (not strict)
- Warnings do NOT fail verification — only errors cause failure (no `--max-warnings 0`)
- Test files (`*.test.ts`) get relaxed rules — allow `any`, allow non-null assertions, allow `@ts-ignore` usage in mocks
- Only **new violations** should fail verification — compare lint output before and after agent changes to detect regressions, not pre-existing issues

### Verification execution
- All 3 verifiers (build, test, lint) run in **parallel** via `Promise.allSettled()` — agent gets the full picture of all failures in one retry
- Default timeouts: Build 60s, Test 120s, Lint 60s — no CLI flags to override
- No skip flags (`--skip-lint`, etc.) — all 3 verifiers always run
- Log each verifier result with timing info (e.g., `Build: PASS (2.3s), Test: FAIL (8.1s)`)

### Error feedback density
- **Per-verifier budget** — each verifier gets its own character cap (not a shared 2000-char pool)
- Error digest uses **labeled sections** with headers (e.g., `## BUILD ERRORS\n...`) so the agent knows which tool failed
- When all 3 verifiers fail, **build errors listed first** — compilation is the most fundamental issue to fix
- Ordering in digest: Build > Test > Lint

### Graceful degradation
- **Pre-check** before running each verifier — detect missing config files (tsconfig.json, vitest config, eslint config) before spawning subprocess
- If config is missing, skip that verifier gracefully (return passed:true with a note) rather than failing hard

### Claude's Discretion
- Raw verifier output logging strategy (debug-level logs vs omitting)
- Exact per-verifier character budget size
- How to detect "no test suite" vs "tests exist but all fail"
- Pre-check implementation details (which files to look for per verifier)
- Approach for diff-based lint checking (before/after comparison strategy)

</decisions>

<specifics>
## Specific Ideas

- Build errors are the most fundamental — if code doesn't compile, test and lint output is noise. Digest should reflect this priority ordering.
- The "only new violations" lint approach is important for real-world repos that may not be lint-clean. The agent shouldn't be penalized for pre-existing issues it didn't create.
- Timing info in logs helps identify slow verifiers and debug performance issues.

</specifics>

<deferred>
## Deferred Ideas

- CLI flags for per-verifier timeouts (--build-timeout, --test-timeout) — future enhancement
- CLI flags to skip specific verifiers (--skip-lint) — future enhancement
- Configurable lint rule sets per workspace — future enhancement

</deferred>

---

*Phase: 05-deterministic-verification*
*Context gathered: 2026-02-18*
