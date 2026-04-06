---
phase: 27-repo-exploration-tasks
plan: 03
subsystem: repl, slack
tags: [investigation, exploration, report-display, slack-adapter, tdd]

requires:
  - phase: 27-01
    provides: investigation task type, explorationSubtype on ResolvedIntent

provides:
  - REPL prints exploration report inline to stdout for investigation tasks
  - REPL writes report to .reports/<timestamp>-<subtype>.md when input contains "save"
  - Slack posts exploration report as thread message for investigation tasks
  - Slack does NOT force createPr=true for investigation tasks
  - Investigation history entries have meaningful descriptions in both REPL and Slack

affects:
  - src/repl/session.ts
  - src/slack/adapter.ts

tech-stack:
  added: []
  patterns:
    - TDD (RED-GREEN per task)
    - host-side file write: agent never writes files, REPL host writes .reports/ on user request
    - investigation guard pattern: taskType === 'investigation' check before PR-specific code

key-files:
  created: []
  modified:
    - src/repl/session.ts
    - src/repl/session.test.ts
    - src/slack/adapter.ts
    - src/slack/adapter.test.ts
    - src/agent/index.ts

key-decisions:
  - "host-side .reports/ write: agent never writes files even in non-read-only mode — REPL writes when /\\bsave\\b/i matches user input"
  - "Real temp dir for INV-06 test: vi.spyOn on node:fs ESM exports is not configurable, so test uses actual filesystem in tmpDir"
  - "investigation description set in session.ts/adapter.ts after parseIntent, not in fast-path: keeps fast-path lean, display-layer sets description"

patterns-established:
  - "investigation guard: use if (confirmed.taskType === 'investigation') before post-hoc PR storage and status message logic"
  - "Slack investigation post: text = report || 'Exploration produced no report.' — nullish-like fallback handles empty string"

requirements-completed:
  - EXPLR-05

duration: 8min
completed: "2026-04-06"
---

# Phase 27 Plan 03: Investigation Display and Slack Report Posting Summary

**Exploration reports display inline in REPL stdout and post as Slack thread messages, with host-side .reports/ file save, createPr guard, and investigation-aware history descriptions.**

## Performance

- **Duration:** 8 min
- **Started:** 2026-04-06T18:16:18Z
- **Completed:** 2026-04-06T18:21:09Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments

- REPL prints the full exploration report inline to stdout after `runAgent` returns for investigation tasks, and displays a yellow warning when no report was produced
- REPL writes the report to `.reports/<timestamp>-<subtype>.md` (host-side) when the user input contains the word "save"; no file is written otherwise
- Slack posts the exploration report as a thread message for investigation tasks, falling back to "Exploration produced no report." when finalResponse is empty
- Slack no longer force-sets `createPr=true` for investigation tasks (guarded by `if (intent.taskType !== 'investigation')`)
- Investigation task history entries record the user's input text as the description in both REPL and Slack

## Task Commits

Each task was committed atomically:

1. **Task 1 RED (REPL tests)** - `8d39251` (test)
2. **Task 1 GREEN (REPL implementation)** - `cd73dfe` (feat)
3. **Task 2 RED (Slack tests)** - `4d5aad2` (test)
4. **Task 2 GREEN (Slack implementation)** - `92de9c5` (feat)

## Files Created/Modified

- `src/repl/session.ts` - Added fs import, explorationSubtype in agentOptions, investigation result block (report print + .reports/ save), updated history description ternary, set description for fast-path investigation tasks
- `src/repl/session.test.ts` - Added 7 INV-* tests in `investigation task type` describe block
- `src/slack/adapter.ts` - Added createPr guard, investigation description backfill, explorationSubtype in agentOptions, investigation report posting branch, updated history description ternary
- `src/slack/adapter.test.ts` - Added 6 INV-S* tests in `investigation task type` describe block
- `src/agent/index.ts` - `explorationSubtype?: string` field confirmed present in AgentOptions (was added by Plan 02)

## Decisions Made

- **host-side .reports/ write:** The agent never writes files even in non-read-only mode — the REPL host writes `.reports/` when `/\bsave\b/i` matches the user's raw input. This keeps the agent's read-only discipline consistent.
- **Real temp dir for INV-06 test:** `vi.spyOn` on `node:fs` named exports fails in Vitest ESM mode (`Cannot redefine property`). The test instead uses the `tmpDir` fixture to verify actual filesystem writes.
- **investigation description backfill:** `intent.description` is set in `session.ts` and `adapter.ts` after `parseIntent` returns, rather than in the fast-path. This keeps `explorationFastPath()` lean and places display-layer concerns in the display layer.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Verified explorationSubtype already in AgentOptions from Plan 02**
- **Found during:** Task 1 (REPL agentOptions construction)
- **Issue:** Plan 03's plan context showed AgentOptions without explorationSubtype; Plan 02 was not listed in STATE completed plans
- **Fix:** Confirmed field already present (Plan 02 was executed before this session); no code change needed
- **Files modified:** None
- **Committed in:** cd73dfe (Task 1 commit)

---

**Total deviations:** 1 investigation (no code change required)
**Impact on plan:** Verification only — no scope creep.

## Issues Encountered

- ESM module mock limitation: `vi.spyOn(node:fs, 'mkdirSync')` fails with "Cannot redefine property" in Vitest ESM mode. Resolved by using real filesystem with tmpDir for INV-06 (file write verification).

## Next Phase Readiness

- Phase 27 is complete: all 3 plans (01, 02, 03) implemented
- Full exploration task pipeline ready: fast-path detection → read-only Docker run → report display in REPL and Slack
- The `.reports/` save feature is a host-side capability; no changes needed to agent or Docker infrastructure

---
*Phase: 27-repo-exploration-tasks*
*Completed: 2026-04-06*
