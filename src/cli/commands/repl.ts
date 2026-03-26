import { createInterface, type Interface } from 'node:readline/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, lstatSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createSpinner } from 'nanospinner';
import pc from 'picocolors';
import { assertDockerRunning, ensureNetworkExists, buildImageIfNeeded } from '../docker/index.js';
import { ProjectRegistry } from '../../agent/registry.js';
import { createSessionState, processInput } from '../../repl/session.js';
import { displayIntent } from '../../intent/confirm-loop.js';
import type { ReplState, SessionCallbacks } from '../../repl/types.js';
import type { RetryResult } from '../../types.js';

const HISTORY_FILE = join(homedir(), '.config', 'background-agent', 'history');
const MAX_HISTORY = 500;
const HISTORY_FILE_MODE = 0o600; // owner-only read/write

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
    mkdirSync(dirname(HISTORY_FILE), { recursive: true, mode: 0o700 });
    // Guard against symlink-based overwrites
    try {
      const stat = lstatSync(HISTORY_FILE);
      if (stat.isSymbolicLink()) return;
    } catch {
      // File doesn't exist yet — safe to create
    }
    writeFileSync(HISTORY_FILE, history.join('\n'), { mode: HISTORY_FILE_MODE });
  } catch {
    // Non-fatal — history persistence failure should not crash the REPL
  }
}

export function getPrompt(state: ReplState): string {
  const name = state.currentProjectName ?? 'bg';
  return pc.bold(`${name}> `);
}

/** Format elapsed seconds as human-friendly string (e.g. "1m 23s", "45s") */
function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

const AGENT_PHASES = [
  'Resolving version',
  'Running agent',
  'Verifying changes',
  'Evaluating result',
] as const;

/** Creates a live progress indicator that shows elapsed time while the agent runs. */
export function createProgressIndicator() {
  let interval: ReturnType<typeof setInterval> | null = null;
  let startTime = 0;
  let phaseIndex = 0;

  function render() {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);

    // Advance phase label based on elapsed time for visual feedback
    if (elapsed >= 90 && phaseIndex < 3) phaseIndex = 3;
    else if (elapsed >= 30 && phaseIndex < 2) phaseIndex = 2;
    else if (elapsed >= 5 && phaseIndex < 1) phaseIndex = 1;

    const phase = AGENT_PHASES[phaseIndex];
    const line = `  ${pc.yellow('⟳')} ${pc.yellow(phase + '…')} ${pc.dim(`(${formatElapsed(elapsed)})`)}`;

    // Clear current line and write status
    process.stdout.write(`\r\x1b[K${line}`);
  }

  return {
    start() {
      startTime = Date.now();
      phaseIndex = 0;
      render();
      interval = setInterval(render, 1000);
    },
    stop() {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      // Clear the status line
      process.stdout.write('\r\x1b[K');
    },
  };
}

export function renderResultBlock(result: RetryResult): void {
  const statusColor =
    result.finalStatus === 'success'
      ? pc.green
      : result.finalStatus === 'zero_diff'
      ? pc.yellow
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

  if (result.error) {
    console.log(pc.red(`  Error: ${result.error}`));
  }

  if (result.finalStatus === 'zero_diff') {
    console.log(pc.yellow('  No changes detected \u2014 agent completed without modifying any files.'));
    console.log(pc.yellow('  Try rephrasing your instruction or check if the change was already applied.'));
    console.log('');
  }

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
  const require = createRequire(import.meta.url);
  const { version } = require('../../../package.json') as { version: string };
  console.log('');
  console.log(`  ${pc.bold(`background-agent v${version}`)}`);
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

  // Ctrl+D — clean exit (flag prevents double "Goodbye" when quit command triggers close)
  let quitting = false;
  rl.on('close', () => {
    if (!quitting) {
      console.log(pc.dim('\n  Goodbye.\n'));
    }
  });

  // Build SessionCallbacks using the shared readline interface

  const cancelWords = new Set(['exit', 'quit', 'cancel', 'abort', 'nevermind']);

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
        if (cancelWords.has(answer.trim().toLowerCase())) return null;
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
      if (correction === null || !correction.trim() || cancelWords.has(correction.trim().toLowerCase())) return null;
      current = await reparse(correction);
    }

    // Loop exhausted via corrections — show final parsed result
    displayIntent(current);
    console.log(pc.red('\n  Max corrections reached. Please try again with a clearer command.'));
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
  const progress = createProgressIndicator();

  while (true) {
    rl.setPrompt(getPrompt(state));
    const input = await askQuestion(rl, getPrompt(state), activeQuestionControllerRef);
    if (input === null) continue; // Ctrl+C at idle — re-prompt

    // Create per-task AbortController
    const taskController = new AbortController();
    activeTaskController = taskController;
    firstSigint = false;

    const callbacks: SessionCallbacks = {
      confirm: confirmCb,
      clarify: clarifyCb,
      getSignal: () => taskController.signal,
      onAgentStart: () => progress.start(),
      onAgentEnd: () => progress.stop(),
    };

    try {
      const output = await processInput(input, state, callbacks, registry);

      if (output.action === 'quit') {
        quitting = true;
        console.log(pc.dim('\n  Goodbye.\n'));
        rl.close();
        return;
      }

      if (output.result) {
        renderResultBlock(output.result);
      } else if (output.result === null) {
        // User cancelled — re-prompt silently
      }

      // Display post-hoc PR result
      if (output.prResult) {
        if (output.prResult.error) {
          console.error(pc.red(`  PR creation failed: ${output.prResult.error}\n`));
        } else {
          console.log(pc.green(`  PR created: ${output.prResult.url}\n`));
        }
      }
    } catch (err) {
      progress.stop(); // Ensure progress indicator is cleared on error
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
