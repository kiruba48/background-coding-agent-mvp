# Stage 1: Node.js base with essential tools
FROM node:20-alpine3.18 AS nodejs-base

# Install bash, git, and CA certificates
RUN apk add --no-cache \
    bash \
    git \
    ca-certificates \
    ripgrep

# Stage 2: Add Java and Maven for future Maven task support
FROM nodejs-base AS multi-runtime

RUN apk add --no-cache \
    openjdk17-jre-headless \
    maven

# Stage 3: Final agent image with security hardening
FROM multi-runtime AS agent

# Create non-root user with specific UID/GID
RUN addgroup -g 1001 -S agent && \
    adduser -u 1001 -S agent -G agent -h /home/agent

# Create workspace directory
WORKDIR /workspace
RUN chown agent:agent /workspace

# Switch to non-root user
USER agent

# Use exec-form CMD for proper signal handling
# Container stays alive for docker exec commands
CMD ["sh", "-c", "sleep infinity"]
