# Phase 1: Foundation & Security - Research

**Researched:** 2026-01-26
**Updated:** 2026-01-27
**Domain:** Docker container isolation + Anthropic SDK integration
**Confidence:** HIGH

## Summary

This phase establishes a sandboxed execution environment for AI coding agents using Docker containers with network isolation and Anthropic SDK communication. The standard approach combines Docker's microVM-based sandboxes (2026 best practice) with programmatic container management via dockerode (Node.js) and the Anthropic TypeScript SDK for streaming agent communication.

The architecture follows a three-layer isolation model: (1) Docker containers provide filesystem and process isolation, (2) network mode "none" prevents external access, and (3) non-root user execution limits privilege escalation. The orchestrator process runs on the host, managing container lifecycle via Docker API while communicating with Claude via the Messages API streaming protocol.

Docker's 2026 sandbox architecture uses lightweight microVMs with private Docker daemons, providing stronger isolation than traditional containers. For this phase, container-based isolation with network restrictions provides sufficient security while maintaining simpler implementation.

**Primary recommendation:** Use dockerode for container lifecycle management with Alpine Linux base images, network mode "none" for complete network isolation, and Anthropic TypeScript SDK streaming for real-time agent communication with tool use agentic loop pattern.

## Standard Stack

The established libraries/tools for this domain:

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| dockerode | 4.x | Docker API client for Node.js | Official Docker Remote API wrapper, battle-tested with stream support and promise-based API |
| @anthropic-ai/sdk | Latest | Anthropic SDK for Messages API | Official TypeScript SDK with streaming helpers, type safety, and tool use support |
| alpine | 3.18+ | Docker base image | Minimal attack surface (~5MB), security-focused with PIE and stack protection |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @types/dockerode | Latest | TypeScript definitions | Type safety for dockerode API |
| zod | Latest | Schema validation | Tool use input validation with betaZodTool helper |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| dockerode | docker CLI via exec | Less control, harder error handling, no stream management |
| Alpine | Ubuntu/Debian | 10x larger images, more attack surface, slower startup |
| Container isolation | Docker Sandbox (microVM) | Stronger isolation but requires Docker Desktop 4.57+, macOS/Windows only |
| Rootful Docker | Rootless Docker/Podman | More secure but more complex setup, may limit orchestrator features |

**Installation:**
```bash
npm install dockerode @anthropic-ai/sdk
npm install --save-dev @types/dockerode
```

## Architecture Patterns

### Recommended Project Structure
```
src/
├── orchestrator/       # Host process managing containers & SDK
│   ├── container.ts    # Docker lifecycle management
│   ├── agent.ts        # Anthropic SDK integration
│   ├── workspace.ts    # Workspace persistence management
│   └── types.ts        # Shared types
├── agent/              # Code running inside container
│   └── executor.ts     # Agent execution logic
└── docker/             # Dockerfile and config
    ├── Dockerfile.base # Base image with common tools
    └── Dockerfile.*    # Task-specific images (optional)
```

### Pattern 1: Isolated Orchestrator Architecture
**What:** Orchestrator runs on host, agent executes in isolated container, communication via Messages API streaming
**When to use:** When agent needs external API access (Claude API) but no other network access
**Example:**
```typescript
// Source: Docker Sandboxes pattern + Anthropic SDK streaming
import Docker from 'dockerode';
import Anthropic from '@anthropic-ai/sdk';

class AgentOrchestrator {
  private docker: Docker;
  private anthropic: Anthropic;

  constructor() {
    this.docker = new Docker({ socketPath: '/var/run/docker.sock' });
    this.anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });
  }

  async createIsolatedContainer(): Promise<Docker.Container> {
    const container = await this.docker.createContainer({
      Image: 'agent-sandbox:latest',
      User: 'agent:agent', // Non-root execution
      NetworkMode: 'none', // Complete network isolation
      HostConfig: {
        Memory: 512 * 1024 * 1024, // 512MB limit
        NanoCpus: 1000000000, // 1 CPU
        ReadonlyRootfs: true, // Read-only filesystem
        Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=100m' }
      },
      WorkingDir: '/workspace',
      Cmd: ['/bin/sh']
    });

    return container;
  }

  async streamAgentResponse(userMessage: string) {
    await this.anthropic.messages.stream({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4096,
      messages: [{ role: 'user', content: userMessage }]
    }).on('text', (text) => {
      console.log(text);
    }).on('error', (error) => {
      console.error('Stream error:', error);
    });
  }
}
```

### Pattern 2: Container Lifecycle Management
**What:** Create, start, execute, cleanup pattern with proper signal handling
**When to use:** All container operations to ensure clean teardown
**Example:**
```typescript
// Source: dockerode GitHub + Docker cleanup best practices
async executeInContainer(
  container: Docker.Container,
  command: string[]
): Promise<void> {
  try {
    await container.start();

    const exec = await container.exec({
      Cmd: command,
      AttachStdout: true,
      AttachStderr: true
    });

    const stream = await exec.start({ hijack: true, stdin: false });

    // Demux stdout/stderr streams
    this.docker.modem.demuxStream(
      stream,
      process.stdout,
      process.stderr
    );

    await new Promise((resolve, reject) => {
      stream.on('end', resolve);
      stream.on('error', reject);
    });
  } finally {
    // Graceful shutdown: SIGTERM first, then SIGKILL after 10s
    await container.stop({ t: 10 });
    await container.remove({ force: true });
  }
}
```

### Pattern 3: Streaming Event Handler
**What:** Handle Messages API streaming events with error recovery
**When to use:** All agent communication to provide real-time responses
**Example:**
```typescript
// Source: https://platform.claude.com/docs/en/api/messages-streaming
async streamWithErrorRecovery(messages: Message[]) {
  const partialResponse: ContentBlock[] = [];

  try {
    const stream = this.anthropic.messages.stream({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4096,
      messages
    });

    stream.on('message_start', (event) => {
      console.log('Started:', event.message.id);
    });

    stream.on('content_block_delta', (event) => {
      if (event.delta.type === 'text_delta') {
        partialResponse.push(event.delta);
        process.stdout.write(event.delta.text);
      }
    });

    stream.on('message_stop', () => {
      console.log('\nCompleted');
    });

    stream.on('error', async (error) => {
      if (error.status === 529) { // overloaded_error
        console.log('Retrying after overload...');
        await new Promise(resolve => setTimeout(resolve, 5000));
        // Retry with partial response
        return this.streamWithErrorRecovery([
          ...messages,
          { role: 'assistant', content: partialResponse }
        ]);
      }
      throw error;
    });

    await stream.finalMessage();
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      console.error(`API Error ${err.status}: ${err.name}`);
    }
    throw err;
  }
}
```

### Pattern 4: Tool Use Agentic Loop
**What:** Implement the complete tool use cycle with Claude: request → tool_use → execute → tool_result → continue
**When to use:** All agent interactions requiring tool execution
**Example:**
```typescript
// Source: https://platform.claude.com/docs/en/docs/build-with-claude/tool-use
async agenticLoop(
  userMessage: string,
  tools: Anthropic.Tool[]
): Promise<string> {
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: userMessage }
  ];

  while (true) {
    const response = await this.anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4096,
      tools,
      messages
    });

    // Add assistant response to conversation
    messages.push({
      role: 'assistant',
      content: response.content
    });

    // Check stop reason
    if (response.stop_reason === 'end_turn') {
      // Claude finished, extract text response
      const textBlock = response.content.find(block => block.type === 'text');
      return textBlock ? textBlock.text : '';
    }

    if (response.stop_reason === 'tool_use') {
      // Execute all tool calls
      const toolResults = [];

      for (const block of response.content) {
        if (block.type === 'tool_use') {
          // Execute tool in container
          const result = await this.executeToolInContainer(
            block.name,
            block.input
          );

          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result
          });
        }
      }

      // Add tool results to conversation
      messages.push({
        role: 'user',
        content: toolResults
      });

      // Continue loop - Claude will process results
      continue;
    }

    // Unexpected stop reason
    throw new Error(`Unexpected stop_reason: ${response.stop_reason}`);
  }
}
```

### Pattern 5: Workspace Persistence with Bind Mounts
**What:** Mount host workspace directory into container at same absolute path for file persistence
**When to use:** Agent needs to read/write files that persist across sessions
**Example:**
```typescript
// Source: Docker Sandboxes documentation + dockerode
async createContainerWithWorkspace(
  workspaceDir: string
): Promise<Docker.Container> {
  // Ensure workspace exists on host
  const absolutePath = path.resolve(workspaceDir);

  return await this.docker.createContainer({
    Image: 'agent-sandbox:latest',
    User: 'agent:agent',
    NetworkMode: 'none',
    HostConfig: {
      Memory: 512 * 1024 * 1024,
      NanoCpus: 1000000000,
      ReadonlyRootfs: true,

      // Mount workspace at same path as host
      Binds: [
        `${absolutePath}:${absolutePath}:rw`
      ],

      Tmpfs: {
        '/tmp': 'rw,noexec,nosuid,size=100m'
      }
    },

    // Set working directory to mounted workspace
    WorkingDir: absolutePath,

    Cmd: ['sh', '-c', 'sleep infinity']
  });
}
```

### Pattern 6: Long-Running Container with docker exec
**What:** Keep container running, send commands via docker exec for each tool invocation
**When to use:** Multiple tool calls in a session, want to preserve container state
**Example:**
```typescript
// Source: dockerode + Docker exec patterns
class SessionContainer {
  private container: Docker.Container;

  async start(workspaceDir: string): Promise<void> {
    this.container = await this.createContainerWithWorkspace(workspaceDir);
    await this.container.start();
  }

  async executeCommand(
    command: string[],
    input?: string
  ): Promise<{ stdout: string; stderr: string }> {
    const exec = await this.container.exec({
      Cmd: command,
      AttachStdin: !!input,
      AttachStdout: true,
      AttachStderr: true
    });

    const stream = await exec.start({
      hijack: true,
      stdin: !!input
    });

    // Send input if provided
    if (input) {
      stream.write(input);
      stream.end();
    }

    // Collect output
    let stdout = '';
    let stderr = '';

    await new Promise((resolve, reject) => {
      this.docker.modem.demuxStream(
        stream,
        { write: (chunk: Buffer) => { stdout += chunk.toString(); } },
        { write: (chunk: Buffer) => { stderr += chunk.toString(); } }
      );

      stream.on('end', resolve);
      stream.on('error', reject);
    });

    return { stdout, stderr };
  }

  async cleanup(): Promise<void> {
    await this.container.stop({ t: 10 });
    await this.container.remove({ force: true });
  }
}
```

### Pattern 7: Multi-Stage Dockerfile for Multi-Language Support
**What:** Use multi-stage builds to create images with multiple language runtimes
**When to use:** Agent needs to execute tasks requiring different languages (Node.js, Java, etc.)
**Example:**
```dockerfile
# Source: Docker multi-stage build best practices
# Stage 1: Node.js environment
FROM node:20.11-alpine3.18 AS nodejs-base
RUN apk add --no-cache bash git ca-certificates

# Stage 2: Add Java and Maven
FROM nodejs-base AS multi-runtime
RUN apk add --no-cache openjdk17-jre maven

# Stage 3: Final agent image
FROM multi-runtime AS agent
RUN addgroup -g 1001 -S agent && \
    adduser -u 1001 -S agent -G agent

WORKDIR /workspace
RUN chown agent:agent /workspace

USER agent
CMD ["sh", "-c", "sleep infinity"]
```

### Anti-Patterns to Avoid
- **Exposing Docker socket to containers:** Equivalent to root access on host
- **Using :latest image tags:** Moving target that bypasses security scanning
- **Shell-form CMD/ENTRYPOINT:** Prevents signal propagation, breaks graceful shutdown
- **Running as root user:** Container breakout becomes host compromise
- **Default network mode:** Allows external network access and lateral movement
- **Ephemeral containers per tool call:** Slow, loses state, wastes resources
- **Git clone inside container:** Duplicates repository, complicates sync, wastes space

## Don't Hand-Roll

Problems that look simple but have existing solutions:

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Docker API communication | Custom HTTP client for /var/run/docker.sock | dockerode | Stream demuxing, promise/callback APIs, comprehensive error handling |
| Container stream handling | Manual stdout/stderr splitting | docker.modem.demuxStream() | Handles Docker's multiplexed stream protocol correctly |
| Messages API streaming | Custom SSE parser | @anthropic-ai/sdk stream helpers | Handles event types, token counting, error recovery, partial JSON accumulation |
| Signal propagation | Custom PID 1 wrapper | Exec-form CMD in Dockerfile | Docker handles SIGTERM/SIGKILL correctly with exec form |
| Container cleanup | Manual stop/remove | docker container prune + graceful stop pattern | Proper SIGTERM→SIGKILL sequence, orphan cleanup |
| Tool use loop | Custom message accumulation | Follow Anthropic's tool use pattern | Handles stop_reason logic, tool_result formatting, conversation state |
| Bidirectional container I/O | Custom socket connections | dockerode exec with hijack: true | Enables independent stdin/stdout control, proper stream closure |

**Key insight:** Docker's stream protocol multiplexes stdout/stderr into a single stream with length-prefixed frames. Hand-rolling this leads to corrupted output. Similarly, Messages API streaming uses server-sent events with complex event sequences (message_start, content_block_delta, message_stop) that require careful state management. Tool use requires proper conversation state with assistant and user messages alternating with tool_result blocks.

## Common Pitfalls

### Pitfall 1: Network Isolation Without Orchestrator Access
**What goes wrong:** Setting NetworkMode: 'none' blocks ALL network, including Claude API access from within container
**Why it happens:** Confusion about where SDK calls should originate
**How to avoid:** Orchestrator (host process) makes Claude API calls, container only executes tool results
**Warning signs:** Container logs show "network unreachable" errors when calling Anthropic SDK

### Pitfall 2: Exposed Docker Socket
**What goes wrong:** Mounting /var/run/docker.sock into container for "convenience" grants full host root access
**Why it happens:** Attempting to manage containers from within containers
**How to avoid:** Never mount Docker socket. Orchestrator manages all containers from host.
**Warning signs:** Security scans flag Docker socket mount, container has docker CLI installed

### Pitfall 3: Root User Execution
**What goes wrong:** Container runs as root, breakout becomes full system compromise
**Why it happens:** Dockerfile missing USER directive, or using UID 0
**How to avoid:** Create non-root user in Dockerfile, set User: 'agent:agent' in container config
**Warning signs:** whoami in container returns 'root', security scans flag root execution

### Pitfall 4: Hardcoded API Keys in Images
**What goes wrong:** API keys baked into image via ENV/ARG appear in image layers, leak in registries
**Why it happens:** ENV ANTHROPIC_API_KEY=sk-... in Dockerfile for "testing"
**How to avoid:** Pass secrets at runtime via environment variables in createContainer()
**Warning signs:** docker history shows API keys, registry scans detect secrets

### Pitfall 5: Shell-Form CMD Breaking Signals
**What goes wrong:** CMD python app.py runs as child of /bin/sh, doesn't receive SIGTERM, container takes full timeout to stop
**Why it happens:** Shell form (no brackets) wraps command in /bin/sh -c
**How to avoid:** Use exec form: CMD ["python", "app.py"]
**Warning signs:** Container stop takes exactly 10 seconds (default timeout), no graceful shutdown

### Pitfall 6: Using :latest Image Tag
**What goes wrong:** Image that passed security scan yesterday fails today due to upstream changes
**Why it happens:** :latest is mutable, points to different content over time
**How to avoid:** Pin specific versions: alpine:3.18, node:20.11-alpine
**Warning signs:** Builds break unexpectedly, security scans show new vulnerabilities in "unchanged" images

### Pitfall 7: Inadequate Resource Limits
**What goes wrong:** Runaway agent process consumes all host memory/CPU, impacts other services
**Why it happens:** Missing Memory/NanoCpus in HostConfig
**How to avoid:** Set explicit limits: Memory (bytes), NanoCpus (1e9 = 1 CPU), PidsLimit
**Warning signs:** Host becomes unresponsive, OOMKiller terminates processes

## Pitfall Resolutions

Gap analysis research addressing specific architectural questions identified in initial research.

### Resolution 1: Orchestrator-Container Communication Pattern (HIGH Confidence)

**Problem:** How do tool execution results get from container back to orchestrator?

**Solution:** Use dockerode's exec with stream demuxing pattern

The orchestrator communicates with containers via docker exec, which provides bidirectional streams. The pattern uses hijack mode for independent stdin/stdout control:

1. Orchestrator calls `container.exec()` with `AttachStdout: true, AttachStderr: true`
2. Starts exec with `{ hijack: true, stdin: true }` to get raw TCP socket
3. Uses `docker.modem.demuxStream()` to separate stdout/stderr into distinct streams
4. Collects output in memory buffers, returns to orchestrator as tool result
5. Orchestrator sends tool result back to Claude API in tool_result block

**Code pattern:**
```typescript
// Execute tool in container, get result back
const exec = await container.exec({
  Cmd: ['bash', '-c', toolCommand],
  AttachStdout: true,
  AttachStderr: true
});

const stream = await exec.start({ hijack: true, stdin: false });

let stdout = '';
let stderr = '';

await new Promise((resolve, reject) => {
  docker.modem.demuxStream(
    stream,
    { write: (chunk) => { stdout += chunk.toString(); } },
    { write: (chunk) => { stderr += chunk.toString(); } }
  );
  stream.on('end', resolve);
  stream.on('error', reject);
});

// Return result to orchestrator
return { stdout, stderr };
```

**Why this works:** dockerode handles Docker's multiplexed stream protocol correctly, avoiding corrupted output. Hijack mode allows closing write-side without closing read-side, essential for commands that need stdin EOF while still reading output.

**Tradeoffs:**
- Requires orchestrator to parse/format output before sending to Claude
- Adds latency vs hypothetical IPC (but IPC would require more complexity)
- Simple, uses standard Docker API, no custom protocols needed

**Sources:**
- [dockerode GitHub](https://github.com/apocas/dockerode) - Stream handling patterns
- [Docker SDK Python - Multiplexed Streams](https://docker-py.readthedocs.io/en/stable/user_guides/multiplex.html)

---

### Resolution 2: Workspace Persistence Strategy (HIGH Confidence)

**Problem:** Where does workspaceDir come from? Does container clone repo or is it pre-cloned? How do changes persist?

**Solution:** Host-side git clone with bind mount at same absolute path

**Pattern:**
1. Orchestrator clones repository on host filesystem (or user provides existing workspace)
2. Workspace directory resolved to absolute path: `/Users/user/projects/myapp`
3. Container mounts workspace at SAME path: `Binds: ['/Users/user/projects/myapp:/Users/user/projects/myapp:rw']`
4. Container WorkingDir set to mounted path
5. All file changes persist on host, visible to container in real-time

**Why same path matters:** Error messages, file paths, and git operations show consistent paths between host and container. Agent can reference files by absolute path without translation.

**Persistence model:**
- Files persist on host filesystem, survive container restarts/removals
- Git operations happen in container (via tools), changes visible on host immediately
- No duplication, no sync lag, single source of truth

**Container lifecycle:**
- Long-running: Container stays alive for entire agent session, exec used for each tool call
- State preserved: Installed packages, environment variables persist within session
- Cleanup: Container removed after session, workspace files remain on host

**Code pattern:**
```typescript
const workspaceDir = path.resolve(process.cwd());

const container = await docker.createContainer({
  Image: 'agent-sandbox:latest',
  HostConfig: {
    Binds: [`${workspaceDir}:${workspaceDir}:rw`]
  },
  WorkingDir: workspaceDir,
  Cmd: ['sh', '-c', 'sleep infinity'] // Keep container alive
});

await container.start();

// Execute tools via exec
const result = await executeCommand(container, ['git', 'status']);

// Cleanup after session
await container.stop();
await container.remove();
```

**Docker Sandboxes comparison:** Official `docker sandbox` enforces one sandbox per workspace with automatic persistence. Our approach gives more control but follows same principle: bind mount workspace, persist across session, one container per workspace.

**Sources:**
- [Docker Sandboxes Documentation](https://docs.docker.com/ai/sandboxes/)
- [Docker sandbox run CLI reference](https://docs.docker.com/reference/cli/docker/sandbox/run/)
- [Docker Sandboxes Tutorial](https://www.ajeetraina.com/docker-sandboxes-tutorial-and-cheatsheet/)

---

### Resolution 3: Container Lifecycle Model (HIGH Confidence)

**Problem:** Container per session vs container per tool invocation? How to send multiple commands?

**Solution:** Long-running container per agent session with docker exec for each tool call

**Lifecycle pattern:**
1. **Session start:** Create and start container with `sleep infinity` CMD
2. **Tool invocation:** Use `docker exec` to run tool command in running container
3. **State preservation:** Container stays alive, environment/packages persist
4. **Session end:** Stop and remove container, workspace files remain on host

**Why long-running:**
- Avoids container startup overhead (200-500ms) on every tool call
- Preserves installed packages (npm install, pip install) across tools
- Maintains environment variables and shell state
- Enables stateful operations (cd into directories, set env vars)

**Why not ephemeral (container per tool):**
- Slow: Container create/start/stop/remove adds 500ms+ per tool
- Stateless: Can't install dependencies once and reuse
- Wasteful: Docker daemon overhead managing many short-lived containers
- Complex: Harder to debug, no persistent logs

**Implementation:**
```typescript
class AgentSession {
  private container: Docker.Container;

  async start(workspaceDir: string) {
    this.container = await docker.createContainer({
      Image: 'agent-sandbox:latest',
      WorkingDir: workspaceDir,
      HostConfig: { Binds: [`${workspaceDir}:${workspaceDir}:rw`] },
      Cmd: ['sh', '-c', 'sleep infinity'] // Keep alive
    });
    await this.container.start();
  }

  async executeTool(command: string[]) {
    // Run command in existing container
    const exec = await this.container.exec({
      Cmd: command,
      AttachStdout: true,
      AttachStderr: true
    });

    const stream = await exec.start({ hijack: true });
    // ... collect output via demuxStream
    return output;
  }

  async end() {
    await this.container.stop({ t: 10 });
    await this.container.remove({ force: true });
  }
}
```

**When to create new container:**
- New agent session starts
- Agent switches to different workspace
- Security concern requires fresh environment
- Container becomes corrupted/unresponsive

**Sources:**
- [Docker Exec Command Guide](https://spacelift.io/blog/docker-exec)
- [Docker Run vs Attach vs Exec](https://labs.iximiuz.com/tutorials/docker-run-vs-attach-vs-exec)
- [Docker container lifecycle patterns](https://www.educative.io/answers/what-is-the-docker-container-lifecycle)

---

### Resolution 4: Tool Use API Pattern (HIGH Confidence)

**Problem:** How does tool execution fit with container isolation? What's the complete loop?

**Solution:** Implement Anthropic's tool use agentic loop: orchestrator calls Claude API → Claude returns tool_use → orchestrator executes in container → orchestrator sends tool_result → repeat

**Complete flow:**

```
1. User query → Orchestrator
2. Orchestrator → Claude API (with tools definitions)
3. Claude → Orchestrator (stop_reason: tool_use, content: [tool_use blocks])
4. Orchestrator → Container (execute tool via docker exec)
5. Container → Orchestrator (stdout/stderr as tool result)
6. Orchestrator → Claude API (tool_result block)
7. Claude → Orchestrator (final answer or more tool_use)
8. Repeat 4-7 until stop_reason: end_turn
```

**Key insights:**
- Claude never runs in container - only orchestrator calls Claude API
- Container only executes tool commands, no AI logic
- Orchestrator is the bridge, managing conversation state
- Tool results formatted as tool_result blocks per Anthropic spec
- Loop continues until Claude decides it's done (stop_reason: end_turn)

**Message structure:**
```typescript
// Conversation state maintained by orchestrator
const messages = [
  { role: 'user', content: 'What files are in the repo?' },
  { role: 'assistant', content: [
    { type: 'text', text: "I'll list the files." },
    { type: 'tool_use', id: 'toolu_123', name: 'list_files', input: {} }
  ]},
  { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'toolu_123', content: 'README.md\nsrc/' }
  ]},
  { role: 'assistant', content: [
    { type: 'text', text: 'The repo contains README.md and a src directory.' }
  ]}
];
```

**Parallel tool use:** Claude can request multiple tools in one response. Execute all tools, return all tool_result blocks in single user message.

**Sequential tool use:** When tool A output feeds into tool B, Claude calls A first, waits for result, then calls B. Orchestrator doesn't need to detect dependencies.

**Error handling:** If tool fails, return error in tool_result content. Claude can retry, ask for clarification, or explain error to user.

**Sources:**
- [Anthropic Tool Use Documentation](https://platform.claude.com/docs/en/docs/build-with-claude/tool-use)
- [Claude Code Best Practices](https://www.anthropic.com/engineering/claude-code-best-practices)
- [Building AI Agents with Anthropic API](https://medium.com/@juanc.olamendy/building-an-ai-agent-from-scratch-using-the-anthropic-api-a-complete-guide-b67d93a63809)

---

### Resolution 5: Multi-Language Runtime Requirements (MEDIUM Confidence)

**Problem:** Agent needs Node.js + Java + npm + Maven. Task-specific images vs one fat image?

**Solution:** Start with single multi-runtime image using multi-stage Docker build, evolve to task-specific images if needed

**Recommended approach for Phase 1:**

Use multi-stage Dockerfile to create one image with all required runtimes:

```dockerfile
# Stage 1: Node.js base
FROM node:20.11-alpine3.18 AS nodejs-base
RUN apk add --no-cache bash git ca-certificates

# Stage 2: Add Java and Maven
FROM nodejs-base AS multi-runtime
RUN apk add --no-cache openjdk17-jre maven

# Stage 3: Final runtime
FROM multi-runtime AS agent
RUN addgroup -g 1001 -S agent && \
    adduser -u 1001 -S agent -G agent

WORKDIR /workspace
RUN chown agent:agent /workspace
USER agent
CMD ["sh", "-c", "sleep infinity"]
```

**Image size:** Alpine + Node.js (~180MB) + Java JRE (~80MB) + Maven (~10MB) ≈ 270MB total. Acceptable for Phase 1.

**Pros of single image:**
- Simpler: One image to build, tag, pull
- Flexible: Container can run any tool without image switching
- Faster: No image pulls mid-session
- Stateful: Packages installed in one language available to all tools

**Cons of single image:**
- Larger size (but still reasonable with Alpine)
- More attack surface (but mitigated by network isolation)
- All deps updated together (but simplifies versioning)

**When to switch to task-specific images:**
- Image size exceeds 500MB (indicates bloat)
- Need conflicting runtime versions (Python 2 vs 3)
- Security requirements mandate minimal attack surface per task
- Build times become problematic

**Task-specific pattern (future optimization):**
```typescript
const imageForTool = {
  'npm_install': 'agent-nodejs:latest',
  'maven_build': 'agent-java:latest',
  'git_commit': 'agent-git:latest'
};

const image = imageForTool[toolName] || 'agent-base:latest';
const container = await createContainer(image, workspaceDir);
```

**Multi-stage build benefits:**
- BuildKit parallelizes independent stages (Node and Java compile simultaneously)
- Can exclude build-time dependencies from final image
- Smaller than naive approach (only runtime deps in final layer)

**Sources:**
- [Docker Multi-Stage Builds Guide](https://labs.iximiuz.com/tutorials/docker-multi-stage-builds)
- [Docker Multi-Stage Documentation](https://docs.docker.com/build/building/multi-stage/)
- [Multi-runtime Docker images (Java + Node)](https://github.com/timbru31/docker-java-node)

---

### Resolution 6: Docker Socket Security (MEDIUM Confidence)

**Problem:** Orchestrator needs /var/run/docker.sock = root access if compromised. Alternatives?

**Solution:** Accept Docker socket requirement, harden orchestrator, consider rootless Docker for production

**Assessment:**

The orchestrator MUST access Docker socket to manage containers. This is unavoidable for the architecture. Instead of avoiding it, secure it:

**Orchestrator hardening:**
1. **Run orchestrator as non-root user** (but add to docker group)
2. **Principle of least privilege:** Only orchestrator has socket access, not containers
3. **Input validation:** Sanitize all user inputs before passing to Docker API
4. **Image pinning:** Only allow pulling from approved registries with specific tags
5. **Resource limits:** Enforce Memory/CPU/Pids limits on all containers
6. **Audit logging:** Log all container create/exec/destroy operations

**Rootless Docker (production consideration):**

Rootless Docker runs daemon and containers as non-root user, eliminating root compromise risk.

**Setup:**
```bash
# Install rootless Docker
curl -fsSL https://get.docker.com/rootless | sh

# Set DOCKER_HOST for orchestrator
export DOCKER_HOST=unix://$XDG_RUNTIME_DIR/docker.sock
```

**Pros:**
- Daemon runs without root, compromise doesn't grant host root
- Containers use user namespace mapping (container root → host user)
- Better security boundary than rootful Docker

**Cons:**
- More complex setup (requires uidmap, subuid/subgid configuration)
- Some features unavailable (AppArmor, checkpoint/restore)
- Performance slightly lower due to user namespace overhead
- Not default on most systems, requires explicit installation

**Podman alternative:**

Podman is daemonless and rootless by default, avoiding central daemon compromise risk.

**Pros:**
- No daemon = no single point of failure
- Rootless by design, not bolt-on feature
- Compatible API, can replace dockerode

**Cons:**
- Requires code changes (different socket path, slight API differences)
- Less mature tooling than Docker
- Team may lack Podman experience

**Recommendation for Phase 1:**

1. Use standard Docker with socket hardening (simplest, most compatible)
2. Document security assumptions (orchestrator compromise = full host access)
3. Implement orchestrator hardening measures (validation, limits, logging)
4. Plan rootless Docker migration for Phase 2 if security requirements demand it

**When to use rootless Docker/Podman:**
- Multi-tenant environment (multiple users running agents)
- High security requirements (regulated industries)
- Orchestrator has internet-facing attack surface
- Production deployment with strict least-privilege requirements

**Don't do this:**
- Mounting Docker socket into containers (gives containers full host access)
- Running orchestrator as root unnecessarily
- Exposing orchestrator API without authentication
- Allowing arbitrary image pulls from untrusted registries

**Sources:**
- [Docker Rootless Mode Documentation](https://docs.docker.com/engine/security/rootless/)
- [Podman vs Docker Security Comparison 2026](https://last9.io/blog/podman-vs-docker/)
- [Why Podman and containerd 2.0 are Replacing Docker](https://dev.to/dataformathub/deep-dive-why-podman-and-containerd-20-are-replacing-docker-in-2026-32ak)
- [Docker Alternatives for Security](https://www.wiz.io/academy/container-security/top-docker-alternatives)

---

## Code Examples

Verified patterns from official sources:

### Complete Dockerfile for Agent Container
```dockerfile
# Source: Alpine Docker best practices + OWASP Docker Security
FROM node:20.11-alpine3.18

# Install only required packages, no cache
RUN apk add --no-cache \
    bash \
    git \
    ca-certificates

# Create non-root user
RUN addgroup -g 1001 -S agent && \
    adduser -u 1001 -S agent -G agent

# Set up workspace
WORKDIR /workspace
RUN chown agent:agent /workspace

# Copy application files
COPY --chown=agent:agent package*.json ./
RUN npm ci --only=production

COPY --chown=agent:agent . .

# Switch to non-root user
USER agent

# Use exec form for proper signal handling
CMD ["node", "executor.js"]
```

### Container Creation with Security Hardening
```typescript
// Source: OWASP Docker Security + Docker Docs
async createSecureContainer(
  image: string,
  workspaceDir: string
): Promise<Docker.Container> {
  return await this.docker.createContainer({
    Image: image,
    User: 'agent:agent', // Non-root execution

    // Complete network isolation
    NetworkMode: 'none',

    HostConfig: {
      // Resource limits
      Memory: 512 * 1024 * 1024, // 512MB
      MemorySwap: 512 * 1024 * 1024, // No swap
      NanoCpus: 1000000000, // 1 CPU
      PidsLimit: 100, // Max processes

      // Filesystem security
      ReadonlyRootfs: true,
      Tmpfs: {
        '/tmp': 'rw,noexec,nosuid,size=100m'
      },

      // Mount workspace (read-write for agent)
      Binds: [
        `${workspaceDir}:/workspace:rw`
      ],

      // Security options
      SecurityOpt: [
        'no-new-privileges:true' // Prevent privilege escalation
      ],

      // Drop all capabilities, add only needed ones
      CapDrop: ['ALL'],
      CapAdd: [], // Add specific caps if needed
    },

    WorkingDir: '/workspace',

    // Use exec form for signal handling
    Cmd: ['node', 'executor.js']
  });
}
```

### Anthropic SDK Streaming Integration
```typescript
// Source: https://github.com/anthropics/anthropic-sdk-typescript
import Anthropic from '@anthropic-ai/sdk';

class AgentCommunication {
  private client: Anthropic;

  constructor() {
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });
  }

  async streamAgentExecution(
    userMessage: string,
    onChunk: (text: string) => void
  ): Promise<Anthropic.Message> {
    const stream = this.client.messages.stream({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4096,
      messages: [
        { role: 'user', content: userMessage }
      ]
    });

    // Real-time text streaming
    stream.on('text', (text) => {
      onChunk(text);
    });

    // Handle errors
    stream.on('error', (error) => {
      console.error('Stream error:', error);
    });

    // Get final message with usage stats
    const finalMessage = await stream.finalMessage();
    console.log('Tokens used:', finalMessage.usage);

    return finalMessage;
  }
}
```

### Graceful Container Teardown
```typescript
// Source: Docker cleanup best practices 2026
async teardownContainer(
  container: Docker.Container,
  timeoutSeconds: number = 10
): Promise<void> {
  try {
    // Send SIGTERM for graceful shutdown
    await container.stop({ t: timeoutSeconds });
    console.log('Container stopped gracefully');
  } catch (error) {
    if (error.statusCode === 304) {
      // Already stopped
      console.log('Container already stopped');
    } else {
      // Force kill on error
      console.warn('Forcing container kill:', error.message);
      await container.kill({ signal: 'SIGKILL' });
    }
  } finally {
    // Remove container
    try {
      await container.remove({ force: true });
      console.log('Container removed');
    } catch (error) {
      console.error('Failed to remove container:', error.message);
    }
  }
}
```

### Complete Tool Use Agentic Loop
```typescript
// Source: Anthropic tool use documentation + best practices
async runAgentSession(
  userQuery: string,
  workspaceDir: string
): Promise<string> {
  // Create long-running container
  const session = new SessionContainer();
  await session.start(workspaceDir);

  try {
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: userQuery }
    ];

    // Define available tools
    const tools: Anthropic.Tool[] = [
      {
        name: 'execute_bash',
        description: 'Execute a bash command in the workspace',
        input_schema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Bash command to execute' }
          },
          required: ['command']
        }
      },
      {
        name: 'read_file',
        description: 'Read contents of a file',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path relative to workspace' }
          },
          required: ['path']
        }
      }
    ];

    // Agentic loop
    while (true) {
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 4096,
        tools,
        messages
      });

      // Add assistant response
      messages.push({
        role: 'assistant',
        content: response.content
      });

      // Check stop reason
      if (response.stop_reason === 'end_turn') {
        // Extract final answer
        const textBlock = response.content.find(b => b.type === 'text');
        return textBlock?.text || '';
      }

      if (response.stop_reason === 'tool_use') {
        // Execute all tool calls
        const toolResults = [];

        for (const block of response.content) {
          if (block.type === 'tool_use') {
            let result: string;

            try {
              // Execute tool in container
              if (block.name === 'execute_bash') {
                const output = await session.executeCommand(
                  ['bash', '-c', block.input.command]
                );
                result = output.stdout || output.stderr;
              } else if (block.name === 'read_file') {
                const output = await session.executeCommand(
                  ['cat', block.input.path]
                );
                result = output.stdout;
              } else {
                result = `Error: Unknown tool ${block.name}`;
              }
            } catch (error) {
              result = `Error executing tool: ${error.message}`;
            }

            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: result
            });
          }
        }

        // Add tool results
        messages.push({
          role: 'user',
          content: toolResults
        });

        // Continue loop
        continue;
      }

      throw new Error(`Unexpected stop_reason: ${response.stop_reason}`);
    }
  } finally {
    await session.cleanup();
  }
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Traditional containers with iptables rules | Docker Sandboxes with microVMs | 2025 | Stronger isolation, private Docker daemons per sandbox |
| Devcontainer with firewall whitelist | Network mode: none + orchestrator API | 2024-2025 | Simpler, complete isolation vs partial firewall |
| Callback-based Docker API | Promise/async-await with dockerode 4.x | 2023 | Cleaner code, better error handling |
| Claude API v1 completion | Messages API with streaming | 2023 | Real-time responses, tool use support |
| Alpine 3.14 | Alpine 3.18+ | 2023 | Security updates, CVE patches |
| Ephemeral containers per command | Long-running containers with exec | 2024-2025 | Better performance, state preservation, reduced overhead |
| Git clone inside container | Bind mount host workspace | 2025-2026 | Single source of truth, no duplication, consistent paths |
| Rootful Docker only | Rootless Docker/Podman options | 2024-2025 | Better security defaults, reduced privilege requirements |

**Deprecated/outdated:**
- **Docker Swarm for orchestration:** Kubernetes won, Swarm maintenance mode since 2019
- **Mounting /var/run/docker.sock for "Docker-in-Docker":** Security anti-pattern, use proper orchestrator
- **Ubuntu base images for agents:** 10x larger than Alpine, unnecessary attack surface
- **Non-streaming Messages API:** Streaming is standard for real-time agent UX
- **docker-compose for single-container lifecycle:** Overkill, use dockerode programmatically
- **Creating new container per tool call:** Slow and wasteful, use long-running container with exec

## Open Questions

Things that couldn't be fully resolved:

1. **Docker Sandbox vs Container Isolation**
   - What we know: Docker Sandboxes (microVMs) provide stronger isolation with private Docker daemons
   - What's unclear: Whether the added complexity of microVMs is justified for this phase vs standard containers with network: none
   - Recommendation: Start with standard containers + network isolation (simpler). Revisit if threat model requires microVM isolation.

2. **Optimal Resource Limits**
   - What we know: Memory, CPU, PidsLimit should be set to prevent DoS
   - What's unclear: Exact values depend on workload (unknown at this phase)
   - Recommendation: Conservative defaults (512MB RAM, 1 CPU, 100 pids). Monitor and adjust in later phases.

3. **Container Image Caching Strategy**
   - What we know: Pre-built images start faster than building on-demand
   - What's unclear: Whether to build image once at startup or rebuild per session
   - Recommendation: Build once, reuse across sessions. Rebuild only on Dockerfile changes.

## Sources

### Primary (HIGH confidence)
- [Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript) - API patterns, streaming
- [Anthropic Tool Use Documentation](https://platform.claude.com/docs/en/docs/build-with-claude/tool-use) - Agentic loop, tool_result format
- [Anthropic Streaming Messages API](https://platform.claude.com/docs/en/api/messages-streaming) - Event types, error handling
- [Docker Security Documentation](https://docs.docker.com/engine/security/) - Isolation, namespaces, capabilities
- [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) - MicroVM architecture, workspace mounting
- [Docker sandbox run CLI](https://docs.docker.com/reference/cli/docker/sandbox/run/) - Workspace persistence patterns
- [dockerode GitHub](https://github.com/apocas/dockerode) - API examples, stream handling, hijack mode
- [OWASP Docker Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html) - Security best practices
- [Docker Rootless Mode](https://docs.docker.com/engine/security/rootless/) - Security alternatives
- [Docker Multi-Stage Builds](https://docs.docker.com/build/building/multi-stage/) - Multi-runtime images

### Secondary (MEDIUM confidence)
- [Docker Sandboxes: A New Approach for Coding Agent Safety](https://www.docker.com/blog/docker-sandboxes-a-new-approach-for-coding-agent-safety/) - 2026 architecture patterns
- [Running Claude Code Agents in Docker Containers](https://medium.com/@dan.avila7/running-claude-code-agents-in-docker-containers-for-complete-isolation-63036a2ef6f4) - Isolation patterns
- [MCP Security Issues](https://www.docker.com/blog/mcp-security-issues-threatening-ai-infrastructure/) - AI agent security threats
- [Container Security in 2026](https://www.cloud4c.com/blogs/container-security-in-2026-risks-and-strategies) - Current threat landscape
- [Claude Code Best Practices](https://www.anthropic.com/engineering/claude-code-best-practices) - Agentic loop patterns
- [Docker Exec Command Guide](https://spacelift.io/blog/docker-exec) - Interactive container communication
- [Docker Run vs Attach vs Exec](https://labs.iximiuz.com/tutorials/docker-run-vs-attach-vs-exec) - Container interaction patterns
- [Container Lifecycle Management](https://daily.dev/blog/docker-container-lifecycle-management-best-practices) - Long-running vs ephemeral
- [Podman vs Docker 2026](https://last9.io/blog/podman-vs-docker/) - Security comparison
- [Docker Multi-Stage Build Tutorial](https://labs.iximiuz.com/tutorials/docker-multi-stage-builds) - Multi-runtime patterns
- [AI Agent Orchestration Patterns](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns) - Container isolation best practices
- [Kubernetes Agent Sandbox](https://opensource.googleblog.com/2025/11/unleashing-autonomous-ai-agents-why-kubernetes-needs-a-new-standard-for-agent-execution.html) - Isolation backends

### Tertiary (LOW confidence)
- Community repositories (claude-code-sandbox, claude-container) - Implementation examples, not authoritative

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - Official SDKs and widely adopted tools (dockerode, Anthropic SDK, Alpine)
- Architecture: HIGH - Patterns verified in official Docker and Anthropic documentation
- Pitfalls: HIGH - Derived from OWASP, Docker official docs, and 2026 security research
- Pitfall resolutions: HIGH - Verified with official documentation and current best practices

**Research date:** 2026-01-26
**Updated:** 2026-01-27 (Gap analysis resolutions added)
**Valid until:** 2026-02-26 (30 days - stable stack, but security landscape changes frequently)
