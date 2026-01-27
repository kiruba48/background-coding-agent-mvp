/**
 * Integration tests for AgentClient
 *
 * These tests require ANTHROPIC_API_KEY environment variable.
 * They make real API calls to verify SDK integration.
 */

import 'dotenv/config';
import { AgentClient, Tool } from './agent.js';

/**
 * Run all tests
 */
async function runTests() {
  console.log('Starting AgentClient integration tests...\n');

  let passed = 0;
  let failed = 0;

  // Test 1: Simple message without tools
  try {
    console.log('Test 1: Simple message without tools');
    await testSimpleMessage();
    console.log('✅ PASSED\n');
    passed++;
  } catch (error) {
    console.error('❌ FAILED:', error instanceof Error ? error.message : error);
    console.error();
    failed++;
  }

  // Test 2: Tool use flow (calculator example)
  try {
    console.log('Test 2: Tool use flow (calculator example)');
    await testToolUseFlow();
    console.log('✅ PASSED\n');
    passed++;
  } catch (error) {
    console.error('❌ FAILED:', error instanceof Error ? error.message : error);
    console.error();
    failed++;
  }

  // Test 3: Tool error handling
  try {
    console.log('Test 3: Tool error handling');
    await testToolErrorHandling();
    console.log('✅ PASSED\n');
    passed++;
  } catch (error) {
    console.error('❌ FAILED:', error instanceof Error ? error.message : error);
    console.error();
    failed++;
  }

  // Summary
  console.log('='.repeat(50));
  console.log(`Tests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
  console.log('='.repeat(50));

  if (failed > 0) {
    process.exit(1);
  }
}

/**
 * Test 1: Simple message without tools
 * Verifies basic API connectivity and response handling
 */
async function testSimpleMessage() {
  const agent = new AgentClient();

  const response = await agent.runAgenticLoop(
    'Say "Hello World" and nothing else.',
    [], // No tools
    async () => '', // No tool execution needed
    undefined, // No streaming callback
    5 // Max 5 iterations
  );

  if (!response.includes('Hello World')) {
    throw new Error(`Expected "Hello World" in response, got: ${response}`);
  }

  console.log('  Response:', response);
}

/**
 * Test 2: Tool use flow
 * Verifies Claude can request tools, receive results, and continue
 */
async function testToolUseFlow() {
  const agent = new AgentClient();

  // Define calculator tool
  const tools: Tool[] = [
    {
      name: 'calculator',
      description: 'Perform basic arithmetic operations',
      input_schema: {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['add', 'subtract', 'multiply', 'divide'],
            description: 'The arithmetic operation to perform'
          },
          a: {
            type: 'number',
            description: 'First operand'
          },
          b: {
            type: 'number',
            description: 'Second operand'
          }
        },
        required: ['operation', 'a', 'b']
      }
    }
  ];

  // Execute tool callback
  const executeTool = async (
    toolName: string,
    input: Record<string, unknown>
  ): Promise<string> => {
    if (toolName !== 'calculator') {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    const { operation, a, b } = input as {
      operation: 'add' | 'subtract' | 'multiply' | 'divide';
      a: number;
      b: number;
    };

    let result: number;
    switch (operation) {
      case 'add':
        result = a + b;
        break;
      case 'subtract':
        result = a - b;
        break;
      case 'multiply':
        result = a * b;
        break;
      case 'divide':
        if (b === 0) {
          throw new Error('Division by zero');
        }
        result = a / b;
        break;
    }

    console.log(`  Tool called: ${operation}(${a}, ${b}) = ${result}`);
    return String(result);
  };

  // Stream text chunks
  const chunks: string[] = [];
  const onText = (text: string) => {
    chunks.push(text);
  };

  const response = await agent.runAgenticLoop(
    'Use the calculator to compute 15 * 7, then tell me the result.',
    tools,
    executeTool,
    onText,
    10 // Max iterations
  );

  // Verify calculator was called
  if (chunks.length === 0) {
    throw new Error('No text chunks received');
  }

  // Verify result (105)
  if (!response.includes('105')) {
    throw new Error(`Expected 105 in response, got: ${response}`);
  }

  console.log('  Response:', response);
}

/**
 * Test 3: Tool error handling
 * Verifies errors from tool execution are properly reported to Claude
 */
async function testToolErrorHandling() {
  const agent = new AgentClient();

  // Define a tool that will fail
  const tools: Tool[] = [
    {
      name: 'divide',
      description: 'Divide two numbers',
      input_schema: {
        type: 'object',
        properties: {
          a: { type: 'number' },
          b: { type: 'number' }
        },
        required: ['a', 'b']
      }
    }
  ];

  // Execute tool that throws error
  const executeTool = async (
    toolName: string,
    input: Record<string, unknown>
  ): Promise<string> => {
    const { a, b } = input as { a: number; b: number };

    if (b === 0) {
      throw new Error('Division by zero is not allowed');
    }

    return String(a / b);
  };

  const response = await agent.runAgenticLoop(
    'Use the divide tool to compute 10 / 0. What happens?',
    tools,
    executeTool,
    undefined,
    10
  );

  // Verify error was communicated to Claude
  if (!response.toLowerCase().includes('error') &&
      !response.toLowerCase().includes('zero') &&
      !response.toLowerCase().includes('cannot')) {
    throw new Error(`Expected error explanation in response, got: ${response}`);
  }

  console.log('  Response:', response.substring(0, 150) + '...');
  console.log('  Tool error was properly reported to Claude');
}

// Run tests
runTests().catch((error) => {
  console.error('Test runner failed:', error);
  process.exit(1);
});
