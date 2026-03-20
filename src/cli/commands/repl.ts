import { createInterface, type Interface } from 'node:readline/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createSpinner } from 'nanospinner';
import pc from 'picocolors';
import { assertDockerRunning, ensureNetworkExists, buildImageIfNeeded } from '../docker/index.js';
import { ProjectRegistry } from '../../agent/registry.js';
import { createSessionState, processInput } from '../../repl/session.js';
import { displayIntent } from '../../intent/confirm-loop.js';
import type { ReplState, SessionCallbacks } from '../../repl/types.js';
import type { RetryResult } from '../../types.js';
import type { ResolvedIntent } from '../../intent/types.js';

const HISTORY_FILE = join(homedir(), '.config', 'background-agent', 'history');
const MAX_HISTORY = 500;

export function loadHistory(): string[] {
  try {
    const content = readFileSync(HISTORY_FILE, 'utf-8');
    return content
      .split('\n')
      .filter((line) => line.length > 0)
      .slice(0, MAX_HISTORY);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    return [];
  }
}

export function saveHistory(history: string[]): void {
  try {
    mkdirSync(dirname(HISTORY_FILE), { recursive: true });
    writeFileSync(HISTORY_FILE, history.join('\n'));
  } catch {
    // Non-fatal — history persistence failure should not crash the REPL
  }
}

export function getPrompt(state: ReplState): string {
  const name = state.currentProjectName ?? 'bg';
  return pc.bold(`${name}> `);
}

export function renderResultBlock(result: RetryResult, _intent?: ResolvedIntent): void {
  const statusColor =
    result.finalStatus === 'success'
      ? pc.green
      : result.finalStatus === 'cancelled'
      ? pc.yellow
      : pc.red;

  const verifyResult =
    result.verificationResults.length > 0
      ? result.verificationResults[result.verificationResults.length - 1].passed
        ? 'PASS'
        : 'FAIL'
      : 'N/A';

  const judgeVerdict =
    result.judgeResults && result.judgeResults.length > 0
      ? result.judgeResults[result.judgeResults.length - 1].verdict
      : 'N/A';

  console.log('');
  console.log(pc.dim('  ┌─────────────────────────────────────────┐'));
  console.log(`  │  ${pc.bold('Status:')}    ${statusColor(result.finalStatus.padEnd(28))}│`);
  console.log(`  │  ${pc.bold('Attempts:')}  ${String(result.attempts).padEnd(28)}│`);
  console.log(`  │  ${pc.bold('Verify:')}    ${verifyResult.padEnd(28)}│`);
  console.log(`  │  ${pc.bold('Judge:')}     ${judgeVerdict.padEnd(28)}│`);
  console.log(pc.dim('  └─────────────────────────────────────────┘'));
  console.log('');
}

async function askQuestion(rl: Interface, prompt: string, activeQuestionControllerRef: { current: AbortController | null }): Promise<string | null> {
  const ctrl = new AbortController();
  activeQuestionControllerRef.current = ctrl;
  try {
    return await rl.question(prompt, { signal: ctrl.signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') return null;
    throw err;
  } finally {
    activeQuestionControllerRef.current = null;
  }
}

export async function replCommand(): Promise<void> {
  // Only run in a TTY
  if (!process.stdout.isTTY) {
    console.warn('Warning: REPL requires a terminal (stdout is not a TTY).');
    return;
  }

  // Docker startup check — runs ONCE at REPL startup, not per-task
  const spinner = createSpinner('Checking Docker...').start();
  try {
    await assertDockerRunning();
    await ensureNetworkExists();
    await buildImageIfNeeded();
    spinner.success({ text: 'Docker ready' });
  } catch (err) {
    spinner.error({ text: `Docker check failed: ${(err as Error).message}` });
    return;
  }

  // Project count for banner
  const registry = new ProjectRegistry();
  const projects = registry.list();
  const projectCount = Object.keys(projects).length;

  // Startup banner
  console.log('');
  console.log(`  ${pc.bold('background-agent v0.1.0')}`);
  console.log(`  ${pc.green('Docker: ready')} ${pc.dim('|')} Projects: ${projectCount} registered`);
  console.log(pc.dim('  Type a task in natural language, or "exit" to quit.'));
  console.log('');

  // Load history and create readline interface
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    historySize: MAX_HISTORY,
    history: loadHistory(),
    removeHistoryDuplicates: true,
    terminal: true,
  });

  // Persist history on every change
  rl.on('history', (history: string[]) => saveHistory(history));

  // Signal handling state — use refs so closures can observe mutations
  let activeTaskController: AbortController | null = null;
  const activeQuestionControllerRef: { current: AbortController | null } = { current: null };
  let firstSigint = false;

  // SIGINT handler on readline — cancels active task or clears idle line
  rl.on('SIGINT', () => {
    if (activeTaskController) {
      if (firstSigint) {
        // Double Ctrl+C: force-kill
        activeTaskController.abort(new Error('force'));
      } else {
        firstSigint = true;
        process.stdout.write('\nCancelling...\n');
        activeTaskController.abort();
      }
    } else if (activeQuestionControllerRef.current) {
      activeQuestionControllerRef.current.abort();
    } else {
      // Idle prompt: clear line and re-show prompt
      process.stdout.write('\n');
      rl.prompt();
    }
  });

  // Ctrl+D — clean exit
  rl.on('close', () => {
    console.log(pc.dim('\n  Goodbye.\n'));
    process.exit(0);
  });

  // Build SessionCallbacks using the shared readline interface

  const confirmCb: SessionCallbacks['confirm'] = async (intent, reparse) => {
    let current = intent;
    let attempts = 0;
    const maxRedirects = 3;

    while (attempts < maxRedirects) {
      displayIntent(current);
      const answer = await askQuestion(rl, pc.bold('  Proceed? [Y/n] '), activeQuestionControllerRef);
      if (answer === null) return null; // Ctrl+C

      if (answer === '' || answer.toLowerCase() === 'y') return current;

      if (answer.toLowerCase() !== 'n') {
        // Treat any non-y/n input as inline correction
        current = await reparse(answer);
        attempts++;
        continue;
      }

      attempts++;
      if (attempts >= maxRedirects) {
        console.log(pc.red('\n  Please try again with a clearer command'));
        return null;
      }

      const correction = await askQuestion(rl, '  Correction: ', activeQuestionControllerRef);
      if (correction === null) return null;
      current = await reparse(correction);
    }

    // Final display after last correction
    displayIntent(current);
    const finalAnswer = await askQuestion(rl, pc.bold('  Proceed? [Y/n] '), activeQuestionControllerRef);
    if (finalAnswer === null) return null;
    if (finalAnswer === '' || finalAnswer.toLowerCase() === 'y') return current;
    console.log(pc.red('\n  Please try again with a clearer command'));
    return null;
  };

  const clarifyCb: SessionCallbacks['clarify'] = async (clarifications) => {
    console.log(pc.bold('\n  Ambiguous input. Did you mean:\n'));
    clarifications.forEach((c, i) => {
      console.log(`    ${pc.cyan(String(i + 1))}. ${c.label}`);
    });
    console.log('');

    const answer = await askQuestion(rl, pc.bold('  Select [number]: '), activeQuestionControllerRef);
    if (answer === null) return null;

    const num = parseInt(answer, 10);
    if (num >= 1 && num <= clarifications.length) return clarifications[num - 1].intent;

    console.log(pc.red('  Invalid selection.'));
    return null;
  };

  // Main REPL loop
  const state = createSessionState();

  while (true) {
    rl.setPrompt(getPrompt(state));
    const input = await askQuestion(rl, getPrompt(state), activeQuestionControllerRef);
    if (input === null) continue; // Ctrl+C at idle — re-prompt

    // Create per-task AbortController
    activeTaskController = new AbortController();
    firstSigint = false;

    const callbacks: SessionCallbacks = {
      confirm: confirmCb,
      clarify: clarifyCb,
      getSignal: () => activeTaskController!.signal,
    };

    try {
      const output = await processInput(input, state, callbacks, registry);

      if (output.action === 'quit') {
        console.log(pc.dim('\n  Goodbye.\n'));
        rl.close();
        return;
      }

      if (output.result) {
        renderResultBlock(output.result, output.intent);
      } else if (output.result === null) {
        // User cancelled — re-prompt silently
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError' || activeTaskController.signal.aborted) {
        const forced = (activeTaskController.signal.reason as Error | undefined)?.message === 'force';
        console.log(pc.yellow(`\n  Task cancelled${forced ? ' (forced)' : ''}.`));
      } else {
        console.error(pc.red(`\n  Error: ${(err as Error).message}`));
      }
    } finally {
      activeTaskController = null;
      firstSigint = false;
    }
  }
}
