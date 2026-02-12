# Phase 3: Agent Tool Access - Research

**Researched:** 2026-02-12
**Domain:** AI Agent Tool Implementation, Docker Sandboxing, File System Security
**Confidence:** HIGH

## Summary

Phase 3 implements file reading, editing, Git operations, and allowlisted Bash commands within the existing Docker sandbox. The research reveals that the current Docker isolation (network: none, read-only rootfs, non-root user, dropped capabilities) provides strong foundational security, but Phase 3 requires additional defense-in-depth layers:

1. **Edit Tool Pattern**: Use string-replacement based editing (str_replace) rather than whole-file overwrites. This is the industry standard for AI agent file editing, as demonstrated by Anthropic's official text_editor tool.

2. **Git Hook Security Risk**: Git hooks (.git/hooks/*) can execute arbitrary code. Even with allowlisted Git commands, an agent could write malicious hooks and trigger them via `git commit`. **Critical mitigation**: Either make .git/hooks read-only or use `--no-verify` flag on all Git operations.

3. **Command Allowlisting**: Use exact command matching (not prefix matching) with explicit arguments. The current `execute_bash` tool is unrestricted and must be locked down to specific commands: rg, cat, head, tail, find, wc.

4. **Atomic File Operations**: For Edit tool reliability, use temporary file + rename pattern (fs.promises with tmpfile approach) to prevent partial writes.

**Primary recommendation:** Implement three new tools (Edit, Git, Grep) to replace the unrestricted execute_bash tool, using the existing Docker sandbox infrastructure with command-specific validation.

## Standard Stack

### Core Libraries (Already in use)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| dockerode | 4.x | Docker API client | De facto standard for Docker operations in Node.js |
| @anthropic-ai/sdk | ^0.36.0 | Claude API integration | Official Anthropic SDK with tool use support |
| Node.js fs.promises | Native | File system operations | Built-in, production-ready, modern async API |

### Supporting Libraries
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| write-file-atomic | ^5.0.1 | Atomic file writes | Edit tool implementation (prevents partial writes) |
| tmp | ^0.2.3 | Temporary file creation | Edit tool temporary files with automatic cleanup |

### NOT Needed (Use Native Instead)
| Instead of | Use | Reason |
|------------|-----|--------|
| Custom path validation | path.resolve + startsWith check | Native Node.js path operations are sufficient |
| Custom command parsing | Array-based exec commands | dockerode.exec already handles arrays safely |
| Shell command allowlist library | Switch statement with Set lookup | Simple, explicit, no dependencies |

**Installation:**
```bash
npm install write-file-atomic tmp
npm install --save-dev @types/tmp
```

## Architecture Patterns

### Pattern 1: Tool-Specific Execution (Recommended)
**What:** Replace unrestricted execute_bash with dedicated tool methods (Read, Edit, Git, Grep)
**When to use:** Always - provides defense-in-depth and clear security boundaries
**Why:** Each tool can enforce its own validation rules and constraints

**Current architecture (Phase 2):**
```typescript
// session.ts - executeTool()
case 'execute_bash':
  // UNRESTRICTED - Phase 3 must fix this
  const result = await this.container.exec(['bash', '-c', input.command]);
```

**Phase 3 architecture:**
```typescript
// session.ts - New tool structure
const TOOLS: Tool[] = [
  {
    name: 'read_file',
    description: 'Read contents of a file in the workspace',
    input_schema: { /* ... */ }
  },
  {
    name: 'edit_file',
    description: 'Edit a file using string replacement',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to workspace' },
        old_str: { type: 'string', description: 'Exact text to replace' },
        new_str: { type: 'string', description: 'New text to insert' }
      },
      required: ['path', 'old_str', 'new_str']
    }
  },
  {
    name: 'git_operation',
    description: 'Execute safe Git operations: status, diff, add, commit',
    input_schema: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['status', 'diff', 'add', 'commit'],
          description: 'Git operation to perform'
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Arguments for the operation'
        }
      },
      required: ['operation']
    }
  },
  {
    name: 'grep',
    description: 'Search for patterns in files using ripgrep',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Search pattern (regex)' },
        path: { type: 'string', description: 'Path to search (default: workspace root)' },
        case_insensitive: { type: 'boolean', description: 'Case-insensitive search' }
      },
      required: ['pattern']
    }
  }
];
```

### Pattern 2: String-Replacement Based Editing
**What:** Edit files by specifying exact text to replace, not line numbers or whole-file overwrites
**When to use:** All file editing operations
**Why:** Anthropic's official pattern - handles indentation, reduces errors, provides clear intent

**Implementation:**
```typescript
// session.ts - Edit tool implementation
case 'edit_file': {
  const { path, old_str, new_str } = input;

  // 1. Validate path
  const safePath = this.validatePath(path);

  // 2. Read current content
  const readResult = await this.container.exec(['cat', safePath]);
  if (readResult.exitCode !== 0) {
    return `Error: Cannot read file: ${readResult.stderr}`;
  }

  const content = readResult.stdout;

  // 3. Check for unique match
  const occurrences = content.split(old_str).length - 1;
  if (occurrences === 0) {
    return 'Error: old_str not found in file';
  }
  if (occurrences > 1) {
    return `Error: old_str matches ${occurrences} locations. Must match exactly once.`;
  }

  // 4. Perform replacement
  const newContent = content.replace(old_str, new_str);

  // 5. Write atomically using temp file (host operation)
  const tempFile = `${safePath}.tmp.${Date.now()}`;
  const fs = await import('fs/promises');
  await fs.writeFile(tempFile, newContent, 'utf-8');
  await fs.rename(tempFile, safePath);

  return 'File edited successfully';
}
```

**Why string replacement over alternatives:**
- **Line numbers**: Brittle - breaks if file changes between read and edit
- **Whole file overwrite**: Loses context, harder for Claude to reason about
- **Diff patches**: Complex to generate, error-prone
- **String replacement**: Industry standard, used by Claude Code, clear semantics

### Pattern 3: Git Hook Prevention
**What:** Prevent Git hook execution to close privilege escalation vector
**When to use:** All Git operations
**Why:** Git hooks can execute arbitrary code, bypassing command allowlist

**Implementation approaches (choose one):**

**Option A: Use --no-verify flag (Simpler)**
```typescript
case 'git_operation': {
  const { operation, args = [] } = input;

  const gitCommands: Record<string, string[]> = {
    'status': ['git', 'status', '--porcelain'],
    'diff': ['git', 'diff', ...args],
    'add': ['git', 'add', ...args],
    'commit': ['git', 'commit', '--no-verify', ...args] // Bypass hooks
  };

  const command = gitCommands[operation];
  if (!command) {
    return `Error: Unknown operation: ${operation}`;
  }

  const result = await this.container.exec(command);
  return result.stdout + result.stderr;
}
```

**Option B: Make .git/hooks read-only (Defense-in-depth)**
```typescript
// In Dockerfile or container setup
RUN chmod 555 /workspace/.git/hooks
RUN chown root:root /workspace/.git/hooks  # Prevent non-root from changing
```

**Recommendation:** Use both - Option A for immediate protection, Option B for defense-in-depth.

### Pattern 4: Command Allowlisting with Exact Matching
**What:** Whitelist specific commands with validated arguments, no shell interpretation
**When to use:** Any command execution beyond core tools
**Why:** Prevents command injection via shell metacharacters

**Implementation:**
```typescript
// New grep tool implementation
case 'grep': {
  const { pattern, path = '.', case_insensitive = false } = input;

  // Validate path
  const safePath = this.validatePath(path);

  // Build command (no shell involved)
  const cmd = ['rg', '--color', 'never'];
  if (case_insensitive) {
    cmd.push('-i');
  }
  cmd.push('--', pattern, safePath);

  const result = await this.container.exec(cmd, 30000);
  if (result.exitCode === 0) {
    return result.stdout;
  } else if (result.exitCode === 1) {
    return '(no matches found)';
  } else {
    return `Error: ${result.stderr}`;
  }
}
```

**Why this approach:**
- Uses array-based command construction (no shell parsing)
- Uses `--` separator to prevent pattern being interpreted as flag
- Returns exit code 1 (no matches) as success case, not error
- Validates paths before passing to command

**Commands to support:**
- `rg` (ripgrep): Fast searching
- `cat`: Already implemented (read_file tool)
- `head`: First N lines of file
- `tail`: Last N lines of file
- `find`: File discovery
- `wc`: Line/word/char counts

**Do NOT support:**
- Bare `bash`, `sh`: Unrestricted execution
- `git` without operation validation: Hook execution risk
- `docker`: Access to Docker daemon (even though container has no socket)
- Network tools (curl, wget): Container has no network anyway
- Package managers (apt, npm): Read-only filesystem prevents installs

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Atomic file writes | Custom write + fsync + rename | write-file-atomic npm package | Handles edge cases: EXDEV errors, permissions, cleanup on failure |
| Path traversal prevention | Custom `..` detection or regex | path.resolve + startsWith check | Native, well-tested, handles symlinks and edge cases |
| Command parsing | Custom string splitting with quote handling | Array-based command construction | Shell metacharacters can't bypass array-based execution |
| Git hook detection | Scanning for hook keywords in workspace | --no-verify flag on git operations | Hooks are a Git feature, let Git disable them |
| File editing with diff patches | Custom diff generation/application | String-replacement (str_replace) pattern | Industry standard (Anthropic text_editor tool), clearer semantics |
| Temporary file naming | Custom timestamp + random | tmp npm package with auto-cleanup | Handles collisions, cleanup, platform-specific temp dirs |

**Key insight:** For AI agent tooling, prefer declarative patterns (specify what to change) over procedural patterns (specify how to change). String replacement is declarative ("replace X with Y"), while line-based editing is procedural ("delete line 5, insert at line 10"). Claude is better at declarative specifications.

## Common Pitfalls

### Pitfall 1: Git Hook Privilege Escalation
**What goes wrong:** Agent writes malicious script to `.git/hooks/pre-commit`, then calls allowlisted `git commit` command, triggering arbitrary code execution.

**Why it happens:** Git hooks are a legitimate Git feature. If the workspace contains a Git repository and the agent can write files, it can write executable hooks.

**How to avoid:**
1. Use `--no-verify` flag on all git commit/push operations
2. Make `.git/hooks` directory read-only (chmod 555, chown root:root)
3. Document that workspace should not contain `.git/` if using agent-driven commits

**Warning signs:**
- Agent attempts to write to `.git/hooks/*` paths
- Agent makes files executable with chmod
- Unexpected commands running during `git commit`

**Detection:**
```typescript
// In validatePath() method
if (resolved.includes('.git/hooks')) {
  throw new Error('Access to .git/hooks directory is denied');
}
```

### Pitfall 2: Non-Unique String Replacement
**What goes wrong:** Agent specifies `old_str` that matches multiple locations in file. Edit operation either fails or makes incorrect changes.

**Why it happens:** Claude may provide minimal context in `old_str` to save tokens, not realizing the string appears multiple times.

**How to avoid:**
1. Count occurrences before replacing
2. Return clear error: "Found N matches, expected 1. Provide more surrounding context."
3. Return line numbers of all matches to help Claude disambiguate

**Warning signs:**
- Edits fail with "multiple matches" error
- Agent tries same edit multiple times
- Edit succeeds but wrong location was modified

**Implementation:**
```typescript
const occurrences = content.split(old_str).length - 1;
if (occurrences === 0) {
  return 'Error: Text not found in file';
}
if (occurrences > 1) {
  // Find line numbers of matches
  const lines = content.split('\n');
  const matchedLines: number[] = [];
  lines.forEach((line, idx) => {
    if (line.includes(old_str)) matchedLines.push(idx + 1);
  });
  return `Error: Text appears ${occurrences} times (lines: ${matchedLines.join(', ')}). Provide more context to match exactly once.`;
}
```

### Pitfall 3: Partial File Writes on Error/Timeout
**What goes wrong:** Agent edits file, write operation is interrupted (timeout, crash, kill signal), leaving partial/corrupted file content.

**Why it happens:** Direct writes with fs.writeFile are not atomic - if process terminates mid-write, file contains partial data.

**How to avoid:**
1. Use atomic write pattern: write to temp file, then rename
2. Use write-file-atomic npm package
3. The rename operation is atomic on most filesystems

**Warning signs:**
- Files become corrupted after timeouts
- Syntax errors appear in previously valid files
- File truncated or contains partial content

**Implementation:**
```typescript
import writeFileAtomic from 'write-file-atomic';

// Instead of:
await fs.writeFile(path, content);

// Use:
await writeFileAtomic(path, content);
```

**Why rename is atomic:** POSIX guarantees `rename(2)` is atomic - the file either fully exists with old name, or fully exists with new name. No intermediate state is visible to readers.

### Pitfall 4: Shell Metacharacter Injection in allowlist
**What goes wrong:** Allowlisted command constructed using string concatenation. Agent injects shell metacharacters (`;`, `|`, `&`, `$()`) to execute additional commands.

**Why it happens:** Using `bash -c "command ${userInput}"` allows shell interpretation of special characters.

**How to avoid:**
1. Never construct commands with string concatenation
2. Use array-based commands: `['rg', '--', pattern, path]`
3. The `--` separator prevents arguments being interpreted as flags
4. dockerode.exec with array automatically escapes arguments

**Warning signs:**
- Tool accepts raw command strings
- Tool uses `bash -c` with interpolated variables
- Tool allows backticks or $() in inputs

**Implementation:**
```typescript
// WRONG - Vulnerable to injection
const cmd = `rg "${pattern}" ${path}`;
await this.container.exec(['bash', '-c', cmd]);

// RIGHT - Safe array-based execution
const cmd = ['rg', '--', pattern, path];
await this.container.exec(cmd);
```

**Example attack:**
```typescript
// If agent provides: pattern = '"; rm -rf /workspace; echo "'
// String concatenation produces: rg ""; rm -rf /workspace; echo "" .
// Array-based produces: rg -- "; rm -rf /workspace; echo " .
// The latter treats entire string as literal pattern, not shell code
```

### Pitfall 5: Allowlist Bypass via PATH Manipulation
**What goes wrong:** Agent creates malicious executable named `rg` or `git` in workspace, container PATH prioritizes workspace, allowlisted command runs malicious version.

**Why it happens:** If container PATH includes `/workspace` before system paths, executables in workspace override system commands.

**How to avoid:**
1. Use absolute paths in container: `/usr/bin/git`, `/usr/bin/rg`
2. Ensure container PATH does not include `/workspace`
3. Set WorkingDir to `/workspace` but PATH to system-only

**Warning signs:**
- Agent creates files named after system commands
- Agent modifies files in workspace with execute permission
- Unexpected behavior from allowlisted commands

**Implementation:**
```typescript
// In container.ts - exec() method
// Use absolute paths for allowlisted commands
const COMMAND_PATHS: Record<string, string> = {
  'rg': '/usr/bin/rg',
  'git': '/usr/bin/git',
  'cat': '/bin/cat',
  'head': '/usr/bin/head',
  'tail': '/usr/bin/tail',
  'find': '/usr/bin/find',
  'wc': '/usr/bin/wc'
};

// In Git tool implementation
const gitPath = COMMAND_PATHS['git'];
await this.container.exec([gitPath, 'status']);
```

### Pitfall 6: Read-Only Filesystem Editing Confusion
**What goes wrong:** Agent successfully reads files from container but Edit tool fails because file writing must happen on host (bind mount).

**Why it happens:** Container has read-only rootfs. Workspace is bind-mounted read-write, but file operations that create temp files in /tmp won't work because /tmp is in-container and read-only outside of the tmpfs mount.

**How to avoid:**
1. Edit tool should operate on host filesystem directly (not via container.exec)
2. Read tool can use container.exec (cat) since it's read-only
3. Document this asymmetry clearly in code comments

**Warning signs:**
- Edit operations fail with "Read-only file system" errors
- Temp files can't be created
- Rename operations fail across filesystems

**Implementation:**
```typescript
// READ: via container (read-only operation)
case 'read_file': {
  const safePath = this.validatePath(input.path);
  const result = await this.container.exec(['cat', safePath]);
  return result.stdout;
}

// EDIT: via host filesystem (write operation)
case 'edit_file': {
  const safePath = this.validatePath(input.path);

  // Read via container (works because read-only)
  const readResult = await this.container.exec(['cat', safePath]);
  const content = readResult.stdout;

  // Edit logic
  const newContent = content.replace(old_str, new_str);

  // Write via host (required because container rootfs is read-only)
  const fs = await import('fs/promises');
  await writeFileAtomic(safePath, newContent);

  return 'File edited successfully';
}
```

## Code Examples

Verified patterns from official sources and research:

### Example 1: String-Replacement Edit Tool (Anthropic Pattern)
```typescript
// Source: https://platform.claude.com/docs/en/agents-and-tools/tool-use/text-editor-tool
// Adapted for Docker sandbox context

async executeEditTool(
  path: string,
  old_str: string,
  new_str: string
): Promise<string> {
  // 1. Validate path within workspace
  const safePath = this.validatePath(path);

  // 2. Read current content via container
  const readResult = await this.container.exec(['cat', safePath]);
  if (readResult.exitCode !== 0) {
    return `Error: Cannot read file: ${readResult.stderr}`;
  }

  const content = readResult.stdout;

  // 3. Validate unique match
  const occurrences = content.split(old_str).length - 1;

  if (occurrences === 0) {
    return 'Error: old_str not found in file';
  }

  if (occurrences > 1) {
    const lines = content.split('\n');
    const matches: number[] = [];
    lines.forEach((line, idx) => {
      if (line.includes(old_str)) {
        matches.push(idx + 1);
      }
    });
    return `Error: old_str found ${occurrences} times at lines ${matches.join(', ')}. Provide more context for unique match.`;
  }

  // 4. Perform replacement
  const newContent = content.replace(old_str, new_str);

  // 5. Write atomically via host filesystem
  const fs = await import('fs/promises');
  const writeFileAtomic = (await import('write-file-atomic')).default;

  try {
    await writeFileAtomic(safePath, newContent, { encoding: 'utf-8' });
    return 'Successfully edited file';
  } catch (error) {
    return `Error writing file: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}
```

### Example 2: Safe Git Operations with Hook Prevention
```typescript
// Source: Research synthesis - git --no-verify pattern
// References:
// - https://adamj.eu/tech/2023/02/13/git-skip-hooks/
// - https://martinalderson.com/posts/why-sandboxing-coding-agents-is-harder-than-you-think/

type GitOperation = 'status' | 'diff' | 'add' | 'commit';

async executeGitTool(
  operation: GitOperation,
  args: string[] = []
): Promise<string> {
  const safePath = this.workspaceDir;

  // Build command with absolute path to prevent PATH manipulation
  const gitPath = '/usr/bin/git';

  let command: string[];

  switch (operation) {
    case 'status':
      // Show status in machine-readable format
      command = [gitPath, '-C', safePath, 'status', '--porcelain'];
      break;

    case 'diff':
      // Show diff, optionally with provided args (e.g., '--cached', 'HEAD^')
      command = [gitPath, '-C', safePath, 'diff', ...args];
      break;

    case 'add':
      // Add files - validate each path
      const validatedPaths = args.map(p => this.validatePath(p));
      command = [gitPath, '-C', safePath, 'add', '--', ...validatedPaths];
      break;

    case 'commit':
      // Commit with --no-verify to prevent hook execution
      // This is CRITICAL for security - prevents arbitrary code execution
      command = [gitPath, '-C', safePath, 'commit', '--no-verify', ...args];
      break;

    default:
      return `Error: Unknown git operation: ${operation}`;
  }

  const result = await this.container.exec(command, 30000);

  // Git commands may return non-zero for normal conditions
  if (operation === 'status' && result.exitCode === 0) {
    return result.stdout || '(no changes)';
  }

  if (operation === 'diff' && result.exitCode === 0) {
    return result.stdout || '(no differences)';
  }

  // For add/commit, only 0 is success
  if (result.exitCode === 0) {
    return result.stdout + result.stderr;
  }

  return `Error: ${result.stderr}`;
}
```

### Example 3: Safe Grep Tool with Ripgrep
```typescript
// Source: ripgrep documentation and security research
// References:
// - https://github.com/BurntSushi/ripgrep
// - Command injection prevention patterns

interface GrepOptions {
  pattern: string;
  path?: string;
  case_insensitive?: boolean;
  context_lines?: number;
}

async executeGrepTool(options: GrepOptions): Promise<string> {
  const {
    pattern,
    path = '.',
    case_insensitive = false,
    context_lines = 0
  } = options;

  // Validate path
  const safePath = this.validatePath(path);

  // Build command with absolute path and safe arguments
  const rgPath = '/usr/bin/rg';
  const cmd = [
    rgPath,
    '--color', 'never',     // No ANSI color codes
    '--no-heading',         // Simpler output format
    '--with-filename',      // Include filename in results
    '--line-number'         // Include line numbers
  ];

  if (case_insensitive) {
    cmd.push('-i');
  }

  if (context_lines > 0) {
    cmd.push('-C', String(context_lines));
  }

  // Use -- separator to prevent pattern being interpreted as flag
  cmd.push('--', pattern, safePath);

  const result = await this.container.exec(cmd, 30000);

  // Exit codes: 0 = matches found, 1 = no matches, 2+ = error
  if (result.exitCode === 0) {
    return result.stdout;
  } else if (result.exitCode === 1) {
    return '(no matches found)';
  } else {
    return `Error: ${result.stderr}`;
  }
}
```

### Example 4: Path Validation with Traversal Prevention
```typescript
// Source: OWASP recommendations and Node.js security patterns
// References:
// - https://cheatsheetseries.owasp.org/cheatsheets/Nodejs_Security_Cheat_Sheet.html
// - https://nodejsdesignpatterns.com/blog/nodejs-path-traversal-security/

import * as nodePath from 'path';

/**
 * Validate path is within workspace and prevent traversal attacks.
 *
 * This implements the two-layer defense recommended by security researchers:
 * 1. Resolve path to absolute form (handles .., symlinks, etc.)
 * 2. Verify resolved path starts with workspace directory
 *
 * @param inputPath - User-provided path (relative or absolute)
 * @returns Resolved absolute path within workspace
 * @throws Error if path escapes workspace or contains suspicious patterns
 */
private validatePath(inputPath: string): string {
  // Defense layer 1: Reject obviously malicious patterns
  if (inputPath.includes('\0')) {
    throw new Error('Null bytes in path are not allowed');
  }

  // Defense layer 2: Resolve to canonical absolute path
  // This handles: .., ., symlinks, duplicate slashes, etc.
  const resolved = nodePath.resolve(this.workspaceDir, inputPath);

  // Defense layer 3: Verify path is within workspace
  // Use path.sep to handle OS differences (/ vs \)
  const workspaceWithSep = this.workspaceDir + nodePath.sep;

  if (!resolved.startsWith(workspaceWithSep) && resolved !== this.workspaceDir) {
    throw new Error('Path traversal detected - access denied');
  }

  // Defense layer 4: Reject sensitive paths even within workspace
  const relativePath = nodePath.relative(this.workspaceDir, resolved);

  if (relativePath.startsWith('.git/hooks')) {
    throw new Error('Access to .git/hooks directory is denied');
  }

  if (relativePath.includes('node_modules/.bin')) {
    throw new Error('Access to node_modules/.bin is denied');
  }

  return resolved;
}
```

### Example 5: Atomic File Write Pattern
```typescript
// Source: npm write-file-atomic package and Node.js patterns
// References:
// - https://www.npmjs.com/package/write-file-atomic
// - https://thelinuxcode.com/nodejs-file-system-in-practice-a-production-grade-guide-for-2026/

import * as fs from 'fs/promises';
import writeFileAtomic from 'write-file-atomic';

/**
 * Atomically write content to a file using temp file + rename pattern.
 *
 * This prevents partial writes that could corrupt the file if the process
 * is killed or times out during writing.
 *
 * @param filePath - Absolute path to file
 * @param content - Content to write
 */
async function safeWriteFile(filePath: string, content: string): Promise<void> {
  // Using write-file-atomic package (recommended)
  await writeFileAtomic(filePath, content, {
    encoding: 'utf-8',
    mode: 0o644,  // rw-r--r--
    chown: {
      uid: 1001,  // agent user
      gid: 1001   // agent group
    }
  });

  // Alternative: Manual implementation if package not available
  /*
  const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;

  try {
    await fs.writeFile(tempPath, content, { encoding: 'utf-8', mode: 0o644 });
    await fs.rename(tempPath, filePath);  // Atomic operation
  } catch (error) {
    // Clean up temp file if rename fails
    try {
      await fs.unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
  */
}
```

## State of the Art

| Old Approach | Current Approach (2026) | When Changed | Impact |
|--------------|-------------------------|--------------|--------|
| Bare shell execution with `bash -c` | Array-based command construction with dockerode | Ongoing best practice | Prevents command injection via shell metacharacters |
| Line-number based file editing | String-replacement based editing (str_replace) | 2024-2025 (Anthropic text_editor tool) | More reliable, handles indentation, clearer intent |
| Standard Docker containers for AI agents | MicroVMs (Firecracker, Kata Containers) or gVisor | 2025-2026 | Stronger isolation with dedicated kernel, but Phase 3 uses existing Docker (sufficient for current threat model) |
| Allowlist by command prefix | Allowlist by exact command + absolute paths | Security best practice | Prevents PATH manipulation attacks |
| `git commit` without restrictions | `git commit --no-verify` | 2025-2026 (AI agent security) | Prevents hook-based privilege escalation |
| fs.writeFile for edits | Atomic writes (temp + rename) | Production best practice | Prevents partial writes on timeout/crash |

**Deprecated/outdated:**
- **Relying solely on container isolation**: Container isolation is foundational but insufficient. Defense-in-depth (allowlisting, path validation, hook prevention) is now standard for AI agents.
- **Manual command string escaping**: Error-prone. Use array-based commands instead.
- **Line-based file editing for AI agents**: Industry has moved to string-replacement pattern (Anthropic, others).

## Open Questions

1. **Should Git operations require explicit user approval?**
   - What we know: Git commit creates permanent state in repository
   - What's unclear: Whether Phase 3 should auto-commit or require user confirmation
   - Recommendation: Phase 3 implements tool, Phase 4 (user approval) adds confirmation layer

2. **Should Edit tool support create-file operation?**
   - What we know: text_editor tool supports `create` command
   - What's unclear: Whether Phase 3 scope includes file creation or just editing
   - Recommendation: Phase 3 implements edit-only, Phase 4+ adds create if needed

3. **Container vs. host execution for file operations?**
   - What we know: Read-only container rootfs requires host-side writes
   - What's unclear: Best pattern for mixed read (container) / write (host) operations
   - Recommendation: Document asymmetry, implement read via container, write via host

4. **Should allowlist be configurable or hardcoded?**
   - What we know: Hardcoded is more secure, configurable is more flexible
   - What's unclear: Whether users need to customize allowed commands
   - Recommendation: Phase 3 hardcodes, Phase 5+ could add configuration with security warnings

5. **Performance impact of multiple cat calls for large files?**
   - What we know: Edit tool reads file via `cat` in container
   - What's unclear: Performance at scale (100+ KB files, frequent edits)
   - Recommendation: Implement and measure. Optimize later if needed.

## Sources

### Primary (HIGH confidence)

**Official Anthropic Documentation:**
- [Tool Use with Claude](https://platform.claude.com/docs/en/docs/build-with-claude/tool-use) - Tool architecture, error handling, input validation patterns
- [Text Editor Tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/text-editor-tool) - String-replacement pattern, command types (view, str_replace, create, insert)
- [Implementing Tool Use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use) - Parallel tools, error handling, validation
- [Advanced Tool Use](https://www.anthropic.com/engineering/advanced-tool-use) - Tool search, programmatic tool calling, 2026 best practices

**Docker & Node.js Documentation:**
- [Docker Security Best Practices](https://docs.docker.com/engine/security/) - Non-root user, capabilities, rootless mode
- [Node.js File System API](https://nodejs.org/api/fs.html) - fs.promises, atomic operations
- [write-file-atomic npm](https://www.npmjs.com/package/write-file-atomic) - Atomic write implementation, EXDEV handling

**Security Standards:**
- [OWASP Node.js Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Nodejs_Security_Cheat_Sheet.html) - Path traversal prevention, command injection
- [OWASP Docker Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html) - Container hardening, user permissions

### Secondary (MEDIUM confidence)

**AI Agent Security Research:**
- [Why Sandboxing Coding Agents is Harder Than You Think - Martin Alderson](https://martinalderson.com/posts/why-sandboxing-coding-agents-is-harder-than-you-think/) - Git hook attack vector, MCP initialization risks
- [Practical Security Guidance for Sandboxing Agentic Workflows - NVIDIA](https://developer.nvidia.com/blog/practical-security-guidance-for-sandboxing-agentic-workflows-and-managing-execution-risk) - File system protection, configuration control
- [How to Sandbox AI Agents in 2026 - Northflank](https://northflank.com/blog/how-to-sandbox-ai-agents) - MicroVMs, gVisor, isolation strategies

**Path Traversal Prevention:**
- [Node.js Path Traversal Security - Node.js Design Patterns](https://nodejsdesignpatterns.com/blog/nodejs-path-traversal-security/) - Two-layer defense, URL decoding
- [Node.js Path Traversal Guide - StackHawk](https://www.stackhawk.com/blog/node-js-path-traversal-guide-examples-and-prevention/) - Validation patterns, real-world examples
- [Node.js Secure Coding: Path Traversal - nodejs-security.com](https://www.nodejs-security.com/book/path-traversal) - Production-grade patterns

**Command Injection Prevention:**
- [NodeJS Command Injection Guide - StackHawk](https://www.stackhawk.com/blog/nodejs-command-injection-examples-and-prevention/) - Allowlist approach, execFile vs exec
- [Command Injection in JavaScript - Semgrep](https://semgrep.dev/docs/cheat-sheets/javascript-command-injection) - Array-based arguments, validation

**Git Hooks Security:**
- [Git: How to Skip Hooks - Adam Johnson](https://adamj.eu/tech/2023/02/13/git-skip-hooks/) - --no-verify flag usage
- [Do Pre-Commit Hooks Prevent Secrets Leakage? - Truffle Security](https://trufflesecurity.com/blog/do-pre-commit-hooks-prevent-secrets-leakage) - Hook security limitations

**Docker Security:**
- [Docker Security Best Practices 2026 - TheLinuxCode](https://thelinuxcode.com/docker-security-best-practices-2026-hardening-the-host-images-and-runtime-without-slowing-teams-down/) - Non-root users, capabilities, 2026 updates
- [How to Run Docker Containers as Non-Root Users - OneUpTime](https://oneuptime.com/blog/post/2026-01-16-docker-run-non-root-user/view) - UID/GID patterns, security impact

**Atomic File Operations:**
- [Node.js File System in Practice 2026 - TheLinuxCode](https://thelinuxcode.com/nodejs-file-system-in-practice-a-production-grade-guide-for-2026/) - Modern patterns, fs.promises, atomic writes
- [atomically npm](https://www.npmjs.com/package/atomically) - Enhanced atomic write library

### Tertiary (LOW confidence - for awareness only)

**AI Coding Tools Landscape:**
- [Best AI Coding Agents for 2026 - Faros AI](https://www.faros.ai/blog/best-ai-coding-agents-2026) - Industry trends, multi-file editing
- [Claude Code Complete Guide 2026 - jitendrazaa.com](https://www.jitendrazaa.com/blog/ai/claude-code-complete-guide-2026-from-basics-to-advanced-mcp-2/) - Workflows, permissions
- [Claude Code Sandbox Guide 2026 - claudefa.st](https://claudefa.st/blog/guide/sandboxing-guide) - Docker sandbox patterns

## Metadata

**Confidence breakdown:**
- **Standard stack:** HIGH - Using existing dependencies (dockerode) + well-established packages (write-file-atomic, tmp)
- **Architecture patterns:** HIGH - Based on official Anthropic text_editor tool + Docker security best practices
- **Git hook security:** HIGH - Multiple authoritative sources confirm attack vector and --no-verify mitigation
- **Path traversal prevention:** HIGH - OWASP standards + Node.js native APIs
- **Command injection prevention:** HIGH - Industry standard array-based execution pattern
- **Pitfalls:** MEDIUM-HIGH - Synthesized from multiple security sources, validated against official docs

**Research date:** 2026-02-12
**Valid until:** March 2026 (30 days) - Security practices stable, tool patterns established
**Re-validate:** If Anthropic releases new text_editor tool versions, or if Docker security advisories published

**Coverage verification:**
- [x] File editing patterns (string replacement)
- [x] Git operations and hook security
- [x] Command allowlisting approach
- [x] Path traversal prevention
- [x] Atomic file operations
- [x] Docker security context (non-root, capabilities)
- [x] Error handling patterns
- [x] Common pitfalls identified
- [x] Code examples provided
- [x] State of the art vs deprecated approaches
- [x] Integration with existing codebase architecture

**Dependencies on prior phases:**
- Phase 2: Docker sandbox infrastructure (container.ts, session.ts, agent.ts)
- Phase 2: Path validation method (validatePath)
- Phase 2: Tool execution routing (executeTool switch/case)
- Phase 2: Error handling pattern (tool errors as strings to Claude)

**Impact on future phases:**
- Phase 4: User approval layer will wrap Edit/Git tools
- Phase 5: Tool result streaming will need to handle Edit tool's multi-step flow
- Phase 6: Advanced tools may use Edit tool as building block
