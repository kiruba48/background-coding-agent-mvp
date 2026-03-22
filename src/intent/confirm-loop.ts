import { createInterface } from 'node:readline/promises';
import pc from 'picocolors';
import path from 'node:path';
import type { ResolvedIntent } from './types.js';

export function displayIntent(intent: ResolvedIntent): void {
  console.log('');
  console.log(pc.bold('  Parsed Intent:'));
  console.log(`    Task:    ${pc.cyan(intent.taskType)}`);
  console.log(`    Project: ${pc.cyan(path.basename(intent.repo))}`);
  if (intent.dep) console.log(`    Dep:     ${pc.cyan(intent.dep)}`);
  if (intent.version) console.log(`    Version: ${pc.cyan(intent.version)}`);
  if (intent.createPr) console.log(`    PR:      ${pc.cyan('yes')}`);
  console.log('');
}

export async function confirmLoop(
  initialIntent: ResolvedIntent,
  reparse: (correction: string, prior: ResolvedIntent) => Promise<ResolvedIntent>,
  maxRedirects = 3,
): Promise<ResolvedIntent | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.on('SIGINT', () => { rl.close(); process.exit(130); });

  let current = initialIntent;
  let attempts = 0;

  try {
    while (attempts < maxRedirects) {
      displayIntent(current);
      const answer = await rl.question(pc.bold('  Proceed? [Y/n] '));

      if (answer === '' || answer.toLowerCase() === 'y') {
        return current;
      }

      if (answer.toLowerCase() !== 'n') {
        // Treat any non-y/n input as a correction directly
        current = await reparse(answer, current);
        attempts++;
        continue;
      }

      attempts++;
      if (attempts >= maxRedirects) {
        console.log(pc.red('\n  Please try again with a clearer command'));
        return null;
      }

      const correction = await rl.question('  Correction: ');
      current = await reparse(correction, current);
    }
    // Final display after last correction — user gets one more chance to accept
    displayIntent(current);
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
