import Anthropic from '@anthropic-ai/sdk';

/**
 * Tool definition interface matching Anthropic API format
 */
export interface Tool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * Represents a tool call from Claude
 */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Input for tool result to send back to Claude
 */
export interface ToolResultInput {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

/**
 * Callback to execute a tool
 */
export type ExecuteToolFn = (
  toolName: string,
  input: Record<string, unknown>
) => Promise<string>;

/**
 * Callback for streaming text chunks
 */
export type OnTextFn = (text: string) => void;

/** Default model to use if not specified */
const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';

/** Configuration options for AgentClient */
export interface AgentClientOptions {
  /** Anthropic API key (defaults to ANTHROPIC_API_KEY env var) */
  apiKey?: string;
  /** Claude model to use (defaults to claude-sonnet-4-5-20250929) */
  model?: string;
}

/**
 * AgentClient handles communication with Claude via Anthropic SDK
 *
 * Implements the tool use agentic loop pattern:
 * 1. Send message with tools to Claude
 * 2. If stop_reason: 'tool_use', execute tools and continue
 * 3. If stop_reason: 'end_turn', return final response
 */
export class AgentClient {
  private client: Anthropic;
  private model: string;

  constructor(options: AgentClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      throw new Error(
        'ANTHROPIC_API_KEY environment variable is required. ' +
        'Get your API key from: https://console.anthropic.com/settings/keys'
      );
    }

    this.client = new Anthropic({ apiKey });
    this.model = options.model ?? process.env.CLAUDE_MODEL ?? DEFAULT_MODEL;
  }

  /**
   * Run complete agentic loop with tool use support
   *
   * @param userMessage - Initial user message to start conversation
   * @param tools - Available tools Claude can use
   * @param executeTool - Callback to execute tool (e.g., in Docker container)
   * @param onText - Optional callback for streaming text chunks
   * @param maxIterations - Maximum loop iterations to prevent infinite loops (default: 10)
   * @returns Final text response from Claude
   */
  async runAgenticLoop(
    userMessage: string,
    tools: Tool[],
    executeTool: ExecuteToolFn,
    onText?: OnTextFn,
    maxIterations: number = 10
  ): Promise<string> {
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: userMessage }
    ];

    let iterations = 0;

    while (iterations < maxIterations) {
      iterations++;

      // Send message to Claude with tools
      const response = await this.sendMessage(messages, tools);

      // Collect text content from response
      const textBlocks = response.content.filter(
        (block): block is Anthropic.TextBlock => block.type === 'text'
      );

      // Stream text if callback provided
      if (onText && textBlocks.length > 0) {
        for (const block of textBlocks) {
          onText(block.text);
        }
      }

      // Add assistant response to conversation
      messages.push({
        role: 'assistant',
        content: response.content
      });

      // Check stop reason
      if (response.stop_reason === 'end_turn') {
        // Claude is done, return final text
        return textBlocks.map(block => block.text).join('\n');
      }

      if (response.stop_reason === 'tool_use') {
        // Extract tool calls from response
        const toolCalls: ToolCall[] = response.content
          .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
          .map(block => ({
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>
          }));

        if (toolCalls.length === 0) {
          throw new Error('stop_reason is tool_use but no tool_use blocks found');
        }

        // Execute all tools and collect results
        const toolResults: Anthropic.ToolResultBlockParam[] = [];

        for (const toolCall of toolCalls) {
          try {
            const result = await executeTool(toolCall.name, toolCall.input);

            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolCall.id,
              content: result
            });
          } catch (error) {
            // Report tool execution errors to Claude
            const errorMessage = error instanceof Error
              ? error.message
              : String(error);

            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolCall.id,
              content: `Error executing tool: ${errorMessage}`,
              is_error: true
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

      // Handle max_tokens reached
      if (response.stop_reason === 'max_tokens') {
        throw new Error('Claude reached max_tokens limit. Increase max_tokens or simplify request.');
      }

      // Unexpected stop reason
      throw new Error(`Unexpected stop_reason: ${response.stop_reason}`);
    }

    // Max iterations reached
    throw new Error(
      `Maximum iterations (${maxIterations}) reached. ` +
      'This may indicate an infinite loop. Check tool implementations.'
    );
  }

  /**
   * Send a message to Claude and handle retries
   *
   * @param messages - Conversation messages
   * @param tools - Available tools
   * @returns Claude's response
   */
  private async sendMessage(
    messages: Anthropic.MessageParam[],
    tools: Tool[]
  ): Promise<Anthropic.Message> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.client.messages.create({
          model: this.model,
          max_tokens: 4096,
          tools,
          messages
        });
      } catch (error) {
        if (error instanceof Anthropic.APIError) {
          // Handle rate limits (429)
          if (error.status === 429) {
            const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
            console.error(`Rate limited (429). Retrying in ${delay}ms... (attempt ${attempt}/${maxRetries})`);
            await this.sleep(delay);
            lastError = error;
            continue;
          }

          // Handle overload (529)
          if (error.status === 529) {
            const delay = 5000; // Fixed 5s delay for overload
            console.error(`Service overloaded (529). Retrying in ${delay}ms... (attempt ${attempt}/${maxRetries})`);
            await this.sleep(delay);
            lastError = error;
            continue;
          }

          // Other API errors - don't retry
          throw new Error(
            `Anthropic API error (${error.status}): ${error.message}`
          );
        }

        // Non-API errors - don't retry
        throw error;
      }
    }

    // All retries failed
    throw new Error(
      `Failed after ${maxRetries} retries. Last error: ${lastError?.message}`
    );
  }

  /**
   * Sleep helper for retry delays
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
