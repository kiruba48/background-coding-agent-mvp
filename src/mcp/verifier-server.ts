import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { compositeVerifier } from '../orchestrator/verifier.js';
import type { VerificationResult } from '../types.js';

type CallToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

/**
 * Format a VerificationResult into an LLM-digestible digest string.
 *
 * Locked decisions (do NOT change):
 * - No rawOutput — only error.summary is included
 * - No durationMs / timing info
 * - No action hints — just the facts
 */
export function formatVerifyDigest(result: VerificationResult): string {
  if (result.passed) {
    return 'Verification PASSED: Build: PASS, Test: PASS, Lint: PASS';
  }

  const hasType = (t: string) => result.errors.some(e => e.type === t);
  const lines: string[] = [];
  lines.push('Verification FAILED:');
  lines.push(`  Build: ${hasType('build') ? 'FAIL' : 'PASS'}`);
  lines.push(`  Test: ${hasType('test') ? 'FAIL' : 'PASS'}`);
  lines.push(`  Lint: ${hasType('lint') ? 'FAIL' : 'PASS'}`);
  lines.push('');
  for (const error of result.errors) {
    lines.push(`[${error.type.toUpperCase()}] ${error.summary}`);
  }
  return lines.join('\n');
}

/**
 * Create the verify tool handler bound to a specific workspaceDir.
 * Exported for testing — allows direct invocation without MCP plumbing.
 */
export function _createVerifyHandler(workspaceDir: string) {
  return async (_args: Record<string, never>, _extra: unknown): Promise<CallToolResult> => {
    const result = await compositeVerifier(workspaceDir);
    const text = formatVerifyDigest(result);
    return { content: [{ type: 'text', text }] };
  };
}

/**
 * Create an in-process MCP verifier server that wraps compositeVerifier as a zero-arg tool.
 *
 * The returned config has type: 'sdk' (in-process, no subprocess).
 * Register it as an MCP server in ClaudeCodeSession to expose mcp__verifier__verify.
 *
 * @param workspaceDir - Absolute path to the workspace directory to verify.
 *   Captured at construction time — all verify calls use this directory.
 */
export function createVerifierMcpServer(workspaceDir: string) {
  const verifyTool = tool(
    'verify',
    'Run composite verifier (build, test, lint) on the current workspace. Call before stopping to self-check your changes. Verification may take 1-3 minutes.',
    {},
    _createVerifyHandler(workspaceDir)
  );

  return createSdkMcpServer({
    name: 'verifier',
    version: '1.0.0',
    tools: [verifyTool],
  });
}
