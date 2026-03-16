---
phase: 03-agent-tool-access
plan: 01
subsystem: agent-tools
tags: [security, file-operations, git-operations, command-execution]
dependency_graph:
  requires: [Phase 1 (Docker container architecture), Phase 2 (Logging infrastructure)]
  provides: [Safe file editing, Git operations, Search capabilities, Allowlisted bash commands]
  affects: [AgentSession tool routing, Container security model]
tech_stack:
  added:
    - write-file-atomic (atomic file writes)
    - @types/write-file-atomic (TypeScript types)
  patterns:
    - Host-side git execution (avoid container permission issues)
    - Multi-line-safe string matching (indexOf loop, not line.includes)
    - Atomic file operations with mode 0o644 for cross-user readability
    - Flag validation for git operations
    - Absolute path enforcement for container commands
key_files:
  created: []
  modified:
    - path: src/orchestrator/session.ts
      changes: [Tool implementations, Path validation hardening, TOOLS array update]
    - path: package.json
      changes: [Added write-file-atomic dependency]
    - path: package-lock.json
      changes: [Dependency lockfile update]
decisions:
  - decision: Execute git operations on host via execFileAsync, not in container
    rationale: Container user (UID 1001) lacks write permission to host-owned .git/ directory, causing silent failures
    alternative_considered: Run git in container with chown workaround
    why_rejected: Complexity, security risk of changing file ownership
  - decision: Use indexOf loop for multi-line match position reporting
    rationale: line.includes() fails for old_str spanning multiple lines; indexOf on full content is line-agnostic
    alternative_considered: Split by newlines and check each line
    why_rejected: Doesn't handle multi-line patterns correctly
  - decision: Write files with mode 0o644 without chown
    rationale: Container user reads via 'other' read permission, avoiding ownership mismatch pitfalls
    alternative_considered: Set chown to container user UID
    why_rejected: Causes ownership conflicts on host filesystem
  - decision: Use fs.access for file existence check in create mode
    rationale: writeFileAtomic may not support flag option; fs.access + writeFileAtomic is acceptable in single-threaded orchestrator
    alternative_considered: Use writeFileAtomic with flag option
    why_rejected: Not reliably supported across write-file-atomic versions
  - decision: Allowlist only cat, head, tail, find, wc for bash_command
    rationale: Read-only operations sufficient for agent needs; grep handled by dedicated ripgrep tool
    alternative_considered: Allow broader command set
    why_rejected: Increases attack surface without clear benefit
metrics:
  duration_minutes: 13
  tasks_completed: 4
  files_modified: 3
  commits: 4
  completed_date: 2026-02-12
---

# Phase 3 Plan 1: Implement Safe Agent Tool Access

**One-liner:** Agent can now edit files atomically, run git operations on host, search with ripgrep, and execute allowlisted bash commands—all with hardened path validation blocking null bytes, .git/hooks, and node_modules/.bin access.

## What Was Built

Implemented six secure tools for the agent to interact with the workspace:

1. **edit_file tool**: String replacement (`str_replace`) with multi-line-safe unique match validation, and atomic file creation (`create`) with existence checking
2. **git_operation tool**: Safe git status, diff, add, and commit operations executed on host (not in container) to avoid permission issues
3. **grep tool**: Pattern search using ripgrep with case-insensitive and context-line options
4. **bash_command tool**: Allowlisted read-only commands (cat, head, tail, find, wc) with verified absolute paths
5. **Path validation enhancements**: Null byte rejection, .git/hooks blocking, node_modules/.bin blocking
6. **Removed execute_bash**: Eliminated unrestricted bash execution in favor of secure alternatives

## Tasks Completed

| Task | Name                                              | Commit  | Files Modified                              |
| ---- | ------------------------------------------------- | ------- | ------------------------------------------- |
| 1    | Install dependency and harden path validation     | c7db2f6 | package.json, package-lock.json, session.ts |
| 2    | Implement edit_file and grep tools                | 4f13961 | session.ts                                  |
| 3    | Implement git_operation tool on HOST              | 9db1fad | session.ts                                  |
| 4    | Implement bash_command allowlist and remove exec  | 9d2fb28 | session.ts                                  |

## Deviations from Plan

None - plan executed exactly as written.

## Key Decisions Made

**1. Host-side git execution (Critical architectural decision)**
- **Context:** Container user (UID 1001) cannot write to .git/ directory owned by host user (UID 501 on macOS)
- **Decision:** Execute git via Node.js `child_process.execFileAsync` on host, not via `container.exec`
- **Security maintained through:** Hardcoded operation enum, argument validation, `--no-verify` flag, array-based command construction
- **Impact:** Git operations now work correctly without permission errors; consistent with edit_file's host-side writes

**2. Multi-line-safe match reporting with indexOf**
- **Problem:** `line.includes(old_str)` fails when `old_str` spans multiple lines
- **Solution:** Use `content.indexOf(old_str, pos)` loop on full content string, map byte offsets to line numbers
- **Result:** Accurate match position reporting regardless of pattern structure

**3. File write permissions 0o644 without chown**
- **Pattern:** All file writes use mode 0o644 (owner read/write, group/other read)
- **Rationale:** Container user (UID 1001) reads via 'other' permission, avoiding ownership mismatch
- **Rejected alternative:** Setting chown to container UID would cause host filesystem ownership issues

**4. fs.access for create mode existence check**
- **Approach:** Check file existence with `fs.access()` before `writeFileAtomic()`
- **Rationale:** `writeFileAtomic` may not support `flag: 'wx'` option reliably
- **Acceptable because:** Single-threaded orchestrator makes TOCTOU race extremely unlikely

**5. Minimal bash_command allowlist**
- **Allowed:** Only cat, head, tail, find, wc (read-only operations)
- **Rationale:** Sufficient for agent needs; grep handled by dedicated ripgrep tool
- **Security:** Verified absolute paths prevent PATH manipulation attacks

## Technical Implementation Details

### Tool Architecture

**TOOLS array (6 tools):**
1. `read_file` - Read file contents (container)
2. `edit_file` - Atomic edits and creation (host)
3. `git_operation` - Git commands (host)
4. `grep` - Search with ripgrep (container)
5. `bash_command` - Allowlisted commands (container)
6. `list_files` - Directory listing (container)

**Execution split:**
- **Host execution (via execFileAsync):** git_operation, edit_file writes
- **Container execution (via container.exec):** read_file, grep, bash_command, list_files

### Path Validation Hardening

Enhanced `validatePath()` method with four defense layers:
1. Null byte rejection: `if (inputPath.includes('\0'))` throw error
2. Path traversal check: Ensure resolved path starts with workspace directory
3. .git/hooks blocking: Prevent git hook privilege escalation
4. node_modules/.bin blocking: Prevent npm script execution

### edit_file Implementation

**str_replace command:**
- Read file via `container.exec(['cat', safePath])`
- Count occurrences: `content.split(old_str).length - 1`
- If 0: error "old_str not found"
- If >1: report all match line numbers using indexOf loop
- If 1: replace and write atomically with `writeFileAtomic(safePath, newContent, { encoding: 'utf-8', mode: 0o644 })`

**create command:**
- Check existence with `fs.access(safePath)` (throws if not exists)
- If exists: error "File already exists"
- If not exists: write atomically with mode 0o644

**Asymmetry:** Read via container (`cat`), write via host filesystem (same bind-mounted path)

### git_operation Implementation

**Allowed operations:** status, diff, add, commit (push not allowed)

**Flag validation:**
- `ALLOWED_GIT_DIFF_FLAGS`: --cached, --staged, --stat, --name-only, --name-status, --shortstat, --numstat, --no-color
- `ALLOWED_GIT_COMMIT_FLAGS`: -m, --message

**Execution pattern:**
```typescript
await execFileAsync('git', ['-C', this.workspaceDir, operation, ...args], {
  cwd: this.workspaceDir,
  timeout: 30000
});
```

**Security:**
- `--no-verify` always included on commit (prevents hook execution)
- All file paths validated via `validatePath()`
- Array-based command construction (no shell interpretation)
- Host-side execution avoids container permission issues

### grep Implementation

**Command:** `/usr/bin/rg` (ripgrep in Alpine 3.18 container)

**Flags:**
- Always: `--color never`, `--no-heading`, `--with-filename`, `--line-number`
- Optional: `-i` (case-insensitive), `-C N` (context lines)
- Safety: `--` separator before pattern (prevents flag injection)

**Exit code handling:**
- 0: return stdout (matches found)
- 1: return "(no matches found)"
- 2+: return error

### bash_command Implementation

**COMMAND_PATHS mapping (Alpine 3.18 BusyBox):**
- `cat`: `/bin/cat`
- `head`: `/usr/bin/head`
- `tail`: `/usr/bin/tail`
- `find`: `/usr/bin/find`
- `wc`: `/usr/bin/wc`

**Validation:**
- Command name must be in allowlist
- File path arguments validated via `validatePath()`
- Flags passed through as-is (BusyBox commands have limited flag options)
- Execution: `container.exec([cmdPath, ...validatedArgs], 30000)`

## Verification Results

All 14 verification criteria passed:

✓ TypeScript compiles without errors
✓ No execute_bash references in session.ts
✓ TOOLS array has exactly 6 tools
✓ validatePath blocks null bytes
✓ validatePath blocks .git/hooks paths
✓ edit_file uses writeFileAtomic
✓ File writes use mode 0o644
✓ edit_file create uses fs.access check
✓ Multi-line match reporting uses indexOf loop
✓ git_operation uses execFileAsync (host-side)
✓ git commit uses --no-verify flag
✓ git diff/commit validate flags against allowlists
✓ bash_command uses COMMAND_PATHS with absolute paths
✓ grep uses /usr/bin/rg absolute path

## Security Posture

**Attack surface reduction:**
- Removed unrestricted `execute_bash` tool
- Replaced with five specialized, constrained tools
- All commands use array construction (no bash -c, no shell metacharacters)

**Defense-in-depth layers:**
1. **Container isolation:** Network: none, read-only rootfs, non-root user, dropped capabilities
2. **Path validation:** Null bytes, traversal, .git/hooks, node_modules/.bin blocked
3. **Command allowlisting:** Only verified absolute paths executed
4. **Flag validation:** Git operations limited to known-safe flags
5. **No hook execution:** `--no-verify` on all commits

**Host/container boundary:**
- **Container:** Read operations (read_file, grep, bash_command, list_files)
- **Host:** Write operations (edit_file, git_operation) to avoid permission mismatches

## Known Limitations

1. **git_operation does not support push:** By design (requires network access, outside scope)
2. **bash_command limited to 5 commands:** Sufficient for current needs; expandable if justified
3. **No git rebase/reset:** Only safe operations (status/diff/add/commit) allowed
4. **TOCTOU window in edit_file create:** Extremely unlikely in single-threaded orchestrator; acceptable risk

## Testing Recommendations

1. **edit_file tests:**
   - str_replace with single match (success)
   - str_replace with multi-line old_str (success)
   - str_replace with multiple matches (error with line numbers)
   - str_replace with no match (error)
   - create new file (success)
   - create existing file (error)

2. **git_operation tests:**
   - git status (empty and with changes)
   - git diff (with various flags)
   - git add multiple files
   - git commit with message
   - Verify --no-verify is included
   - Verify disallowed flags rejected

3. **grep tests:**
   - Pattern match with results
   - Pattern with no matches
   - Case-insensitive search
   - Context lines

4. **bash_command tests:**
   - Each allowed command (cat, head, tail, find, wc)
   - Disallowed command (error)
   - File path validation

5. **Path validation tests:**
   - Null byte in path (rejected)
   - .git/hooks access (rejected)
   - node_modules/.bin access (rejected)
   - Path traversal attempt (rejected)

## Integration Points

**Upstream dependencies:**
- Phase 1: Docker container architecture (ContainerManager)
- Phase 2: Logging infrastructure (Pino logger)

**Downstream impact:**
- Phase 4: Git provider integration can use git_operation tool
- Phase 5: CI/CD verification can use read_file and bash_command
- Phase 6: LLM Judge can analyze code via read_file and grep

**External dependencies:**
- write-file-atomic@7.0.0 (atomic file writes)
- @types/write-file-atomic (TypeScript types)
- Node.js child_process (host git execution)
- Alpine 3.18 BusyBox commands (container)
- ripgrep in agent-sandbox image (search)

## Self-Check: PASSED

**Created files:** None (all modifications)

**Modified files:**
- /Users/kiruba/code/Projects/ai/background-coding-agent/src/orchestrator/session.ts (FOUND)
- /Users/kiruba/code/Projects/ai/background-coding-agent/package.json (FOUND)
- /Users/kiruba/code/Projects/ai/background-coding-agent/package-lock.json (FOUND)

**Commits:**
- c7db2f6 (FOUND): chore(03-01): install write-file-atomic and harden path validation
- 4f13961 (FOUND): feat(03-01): implement edit_file and grep tools
- 9db1fad (FOUND): feat(03-01): implement git_operation tool on host
- 9d2fb28 (FOUND): feat(03-01): implement bash_command allowlist and remove execute_bash

All claimed artifacts verified.
