import { createInterface } from 'node:readline/promises';
import pc from 'picocolors';
import path from 'node:path';
import type { ResolvedIntent } from './types.js';
import type { ScopeHint } from '../repl/types.js';

const MAX_DISPLAY_DESCRIPTION_LENGTH = 80;

export function displayIntent(intent: ResolvedIntent, scopeHints?: ScopeHint[]): void {
  const fromSession = pc.dim(' (from session)');
  console.log('');
  console.log(pc.bold('  Parsed Intent:'));
  const taskSuffix = intent.inheritedFields?.includes('taskType') ? fromSession : '';
  const taskLabel = intent.taskType === 'generic'
    ? (intent.taskCategory ?? 'generic')
    : intent.taskType;
  console.log(`    Task:    ${pc.cyan(taskLabel)}${taskSuffix}`);
  if (intent.taskType === 'generic' && intent.description) {
    const truncated = intent.description.length > MAX_DISPLAY_DESCRIPTION_LENGTH
      ? intent.description.slice(0, MAX_DISPLAY_DESCRIPTION_LENGTH) + '...'
      : intent.description;
    console.log(`    Action:  ${pc.cyan(truncated)}`);
  }
  const projSuffix = intent.inheritedFields?.includes('repo') ? fromSession : '';
  console.log(`    Project: ${pc.cyan(path.basename(intent.repo))}${projSuffix}`);
  if (intent.dep) console.log(`    Dep:     ${pc.cyan(intent.dep)}`);
  if (intent.version) console.log(`    Version: ${pc.cyan(intent.version)}`);
  if (intent.createPr) console.log(`    PR:      ${pc.cyan('yes')}`);
  if (scopeHints && scopeHints.length > 0) {
    console.log(`    ${pc.bold('Scope:')}`);
    scopeHints.forEach(h => {
      console.log(`      ${pc.dim('Q:')} ${pc.dim(h.question)}`);
      console.log(`      ${pc.cyan('A:')} ${h.answer}`);
    });
  }
  console.log('');
}

const CANCEL_WORDS = new Set(['exit', 'quit', 'cancel', 'abort', 'nevermind']);

export async function confirmLoop(
  initialIntent: ResolvedIntent,
  reparse: (correction: string, prior: ResolvedIntent) => Promise<ResolvedIntent>,
  maxRedirects = 3,
  scopeHints?: ScopeHint[],
): Promise<ResolvedIntent | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => { rl.close(); process.exit(130); });

  let current = initialIntent;
  let attempts = 0;
  // Scope hints become stale after a correction — track mutably
  let activeHints = scopeHints;

  try {
    while (attempts < maxRedirects) {
      displayIntent(current, activeHints);
      const answer = await rl.question(pc.bold('  Proceed? [Y/n] '));

      if (answer === '' || answer.toLowerCase() === 'y') {
        return current;
      }

      if (answer.toLowerCase() !== 'n') {
        // Bail out on cancel words typed at the Proceed prompt
        if (CANCEL_WORDS.has(answer.trim().toLowerCase())) {
          return null;
        }
        // Treat any non-y/n input as a correction directly — clear stale hints
        current = await reparse(answer, current);
        activeHints = undefined;
        attempts++;
        continue;
      }

      attempts++;
      if (attempts >= maxRedirects) {
        console.log(pc.red('\n  Please try again with a clearer command'));
        return null;
      }

      const correction = await rl.question('  Correction: ');
      if (!correction.trim() || CANCEL_WORDS.has(correction.trim().toLowerCase())) {
        return null;
      }
      current = await reparse(correction, current);
      activeHints = undefined; // Clear stale hints after correction
    }
    // Final display after last correction — user gets one more chance to accept
    displayIntent(current, activeHints);
    const finalAnswer = await rl.question(pc.bold('  Proceed? [Y/n] '));
    if (finalAnswer === '' || finalAnswer.toLowerCase() === 'y') {
      return current;
    }
    console.log(pc.red('\n  Please try again with a clearer command'));
    return null;
  } finally {
    rl.close();
  }
}
