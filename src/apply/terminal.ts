// The apply assistant in the terminal: the same session the dashboard uses, driven by prompts.
import type { Interface } from 'node:readline/promises';
import type { ApplyManager } from './manager.js';
import type { ApplySession } from './session.js';

const ICON = { filled: '✓', empty: '?', error: '✗' } as const;

function printFields(s: ApplySession) {
  for (const f of s.snapshot().fields) {
    const icon = f.status === 'empty' && !f.required ? '·' : ICON[f.status];
    const value = f.value ?? (f.required ? 'NEEDS YOUR ANSWER' : '(left empty)');
    const tag = f.source ? ` [${f.source}]` : '';
    console.log(`  ${icon} ${f.label.slice(0, 60).padEnd(60)} ${String(value).slice(0, 50)}${tag}${f.error ? `  ! ${f.error}` : ''}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits until the session leaves the given states (or the timeout passes). */
async function waitWhile(s: ApplySession, states: string[], timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  let last = '';
  while (states.includes(s.state) && Date.now() < until) {
    if (s.message !== last) console.log(`  … ${(last = s.message)}`);
    await sleep(700);
  }
}

export async function runApplyInTerminal(manager: ApplyManager, jobId: number, dryRun: boolean, rl: Interface): Promise<void> {
  const { session: s, started } = await manager.open(jobId, { dryRun });
  console.log(`\n${s.job.title} @ ${s.job.company}\n${s.url}${dryRun ? '\nDRY RUN: nothing will be submitted.' : ''}\n`);
  await started;
  if (s.state === 'failed') return console.log(s.message);
  console.log(s.message);
  printFields(s);

  // Ask for each required field the assistant could not fill.
  while (s.state === 'needs_input' || s.state === 'captcha') {
    if (s.state === 'captcha') {
      await rl.question('\nSolve the check in the browser window, then press Enter. ');
      continue;
    }
    const missing = s.snapshot().fields.filter((f) => f.required && f.status !== 'filled');
    if (!missing.length) {
      await rl.question('\nNo form found yet. Open the application form in the browser window, then press Enter to rescan. ');
      await s.scan();
      printFields(s);
      continue;
    }
    console.log('');
    for (const f of missing) {
      const opts = f.options.length ? `\n    options: ${f.options.join(' | ')}` : '';
      const note = f.note ? ` (${f.note})` : '';
      const value = (await rl.question(`  ${f.label}${note}${opts}\n  > `)).trim();
      if (!value) continue;
      const remember = f.kind !== 'file' && /^y/i.test(await rl.question('    Remember this answer for future forms? [y/N] '));
      await s.answer(f.key, value, remember).catch((err: Error) => console.log(`    Could not fill: ${err.message}`));
    }
    if (s.state === 'needs_input') {
      const again = await rl.question('\nSome required fields are still empty. Fill them in the browser window and press Enter to rescan, or type "skip" to stop. ');
      if (/^skip/i.test(again)) break;
      await s.scan();
      printFields(s);
    }
  }

  if (dryRun) {
    await rl.question('\nDry run finished. Review the browser window, then press Enter to close it (nothing is submitted). ');
    return;
  }

  const choice = (
    await rl.question(
      `\nReview every field in the browser window.\nType "submit" to send this application to ${s.job.company}, "done" if you submitted it yourself, or press Enter to cancel: `,
    )
  ).trim().toLowerCase();

  if (choice === 'done') {
    s.markSubmittedByUser();
    return console.log('Marked as applied.');
  }
  if (choice !== 'submit') return console.log('Cancelled. Nothing was submitted.');

  try {
    await s.submit();
  } catch (err) {
    return console.log((err as Error).message);
  }
  await waitWhile(s, ['submitting', 'captcha'], 180_000);
  console.log(s.message);
  if (s.state !== 'submitted') {
    const final = await rl.question('If you completed it in the browser, type "done" to mark it applied; otherwise press Enter: ');
    if (final.trim().toLowerCase() === 'done') s.markSubmittedByUser();
  }
}
