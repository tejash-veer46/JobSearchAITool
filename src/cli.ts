import { exec } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Command, Option } from 'commander';
import { closeSharedBrowser } from './apply/browser.js';
import { ApplyManager } from './apply/manager.js';
import { previewForm } from './apply/preview.js';
import { runApplyInTerminal } from './apply/terminal.js';
import { startDashboard } from './web/server.js';
import { loadProfileFacts, loadSearchConfig, paths, syncSearchConfig } from './config.js';
import { JobStore } from './db.js';
import { ASK_USER } from './engine/matcher.js';
import { refilterAll, runPipeline, scorePending } from './engine/pipeline.js';
import { emptyStats, writeReport } from './engine/reporter.js';
import { findResumeFile, loadProfile } from './engine/resume.js';
import { hasClaude } from './lib/claude.js';
import { truncate } from './lib/text.js';
import { SOURCE_NAMES, type SourceName } from './sources/index.js';
import { JOB_STATUSES, type JobStatus } from './types.js';

const rel = (p: string) => path.relative(paths.root, p);

function withStore<T>(fn: (store: JobStore) => Promise<T> | T): Promise<T> {
  const store = new JobStore(paths.db);
  return Promise.resolve(fn(store)).finally(() => store.close());
}

const program = new Command()
  .name('jobapplyai')
  .description('Find QA/SDET jobs that fit your resume, score them, and track applications.');

program
  .command('run')
  .description('Fetch new postings, filter them, score the survivors and write a report')
  .addOption(new Option('-s, --source <names...>', 'only these sources').choices([...SOURCE_NAMES]))
  .option('--no-score', 'fetch and filter only')
  .option('--rescore', 'also re-score jobs scored in earlier runs')
  .option('-l, --limit <n>', 'max jobs to score this run', (v) => parseInt(v, 10))
  .action(async (opts: { source?: SourceName[]; score: boolean; rescore?: boolean; limit?: number }) => {
    await withStore(async (store) => {
      const { stats, report } = await runPipeline(store, { only: opts.source, score: opts.score, rescore: opts.rescore, limit: opts.limit });
      console.log(`\nDone: ${stats.staged} new job(s) ready to apply.`);
      console.log(`Report: ${rel(report.markdown)}\n        ${rel(report.json)}\n        ${rel(report.csv)}`);
    });
  });

program
  .command('score')
  .description('Score jobs that passed the filters (use --rescore after adding an API key)')
  .option('--rescore', 're-score jobs that were already scored')
  .option('-l, --limit <n>', 'max jobs to score', (v) => parseInt(v, 10))
  .action(async (opts: { rescore?: boolean; limit?: number }) => {
    await withStore(async (store) => {
      const cfg = loadSearchConfig();
      const facts = loadProfileFacts();
      const stats = emptyStats();
      const ctx = { profile: await loadProfile(), facts, threshold: cfg.scoring.qualify_threshold, maxRequiredYears: cfg.filters.max_required_years };
      await scorePending(store, ctx, opts.limit ?? cfg.scoring.max_scored_per_run, opts.rescore ?? false, stats, console.log);
      const report = writeReport(store, stats, facts);
      console.log(`\n${stats.scored} scored, ${stats.staged} staged. Report: ${rel(report.markdown)}`);
    });
  });

program
  .command('refilter')
  .description('Re-apply config/search.yaml filters to stored jobs, then score any that now pass')
  .action(async () => {
    await withStore(async (store) => {
      const cfg = loadSearchConfig();
      const facts = loadProfileFacts();
      const { reopened, rejected } = refilterAll(store, cfg);
      console.log(`${reopened} job(s) now pass the filters, ${rejected} newly filtered out.`);
      const stats = emptyStats();
      const ctx = { profile: await loadProfile(), facts, threshold: cfg.scoring.qualify_threshold, maxRequiredYears: cfg.filters.max_required_years };
      await scorePending(store, ctx, cfg.scoring.max_scored_per_run, false, stats, console.log);
      console.log(`Report: ${rel(writeReport(store, stats, facts).markdown)}`);
    });
  });

program
  .command('profile')
  .description('Show the profile parsed from your resume')
  .option('--refresh', 'ignore the cached parse')
  .action(async (opts: { refresh?: boolean }) => {
    const p = await loadProfile({ refresh: opts.refresh });
    console.log(`Resume: ${rel(findResumeFile())} (parsed by ${p.parsedBy}${hasClaude() ? '' : ', no API key'})\n`);
    console.log(`${p.name} · ${p.yearsExperience} years · ${p.contact.email} · ${p.contact.phone}`);
    console.log(`LinkedIn: ${p.contact.linkedin}\nGitHub:   ${p.contact.github}\n`);
    for (const w of p.workHistory) console.log(`  ${w.start} – ${w.end}  ${w.title}, ${w.company}`);
    console.log(`\nSkills (${p.skills.length}): ${p.skills.join(', ')}`);
    console.log(`Education: ${p.education.map((e) => `${e.degree}, ${e.institution}`).join('; ')}`);
    console.log(`Projects: ${p.projects.map((x) => x.name).join('; ')}`);
  });

program
  .command('list')
  .description('List jobs, best match first')
  .addOption(new Option('--status <status...>', 'filter by status').choices([...JOB_STATUSES]).default(['STAGED']))
  .option('-n, --limit <n>', 'max rows', (v) => parseInt(v, 10), 50)
  .action(async (opts: { status: JobStatus[]; limit: number }) => {
    await withStore((store) => {
      const jobs = store.list(opts.status, opts.limit);
      if (!jobs.length) return console.log(`No ${opts.status.join('/')} jobs.`);
      for (const j of jobs) {
        const why = j.status === 'REJECTED' ? `  [${j.reject_reason}]` : '';
        console.log(`#${String(j.id).padEnd(5)} ${String(j.match_score ?? '-').padStart(3)}  ${truncate(`${j.company} - ${j.title}`, 70).padEnd(70)}  ${truncate(j.location, 30)}${truncate(why, 90)}`);
      }
    });
  });

program
  .command('show <id>')
  .description('Show one job with its score, pitch and screening answers')
  .action(async (id: string) => {
    await withStore((store) => {
      const j = store.get(Number(id));
      if (!j) return console.log(`No job #${id}`);
      console.log(`#${j.id} ${j.title} @ ${j.company}\n${j.location} · ${j.platform} · ${j.status}${j.reject_reason ? ` (${j.reject_reason})` : ''}`);
      console.log(`Link: ${j.apply_url ?? j.url}\n`);
      if (j.match_score != null) {
        console.log(`Match ${j.match_score}/100 (${j.scorer}): ${j.match_reason}`);
        console.log(`Matched: ${j.matched_skills.join(', ') || '-'}\nMissing: ${j.missing_skills.join(', ') || '-'}\n`);
        console.log(`Pitch:\n  ${j.short_pitch}\n\nScreening answers:`);
        for (const a of j.tailored_answers) console.log(`  ${a.question} -> ${a.answer === ASK_USER ? '(you need to answer)' : a.answer}`);
      }
      console.log(`\n${truncate(j.description, 1500)}`);
    });
  });

program
  .command('mark <id> <status>')
  .description(`Set a job's status: ${JOB_STATUSES.join(', ')} (e.g. "mark 42 applied")`)
  .option('--note <text>', 'note to store with the job')
  .action(async (id: string, status: string, opts: { note?: string }) => {
    const s = status.toUpperCase() as JobStatus;
    if (!JOB_STATUSES.includes(s)) throw new Error(`Status must be one of ${JOB_STATUSES.join(', ')}`);
    await withStore((store) => console.log(store.setStatus(Number(id), s, opts.note) ? `#${id} -> ${s}` : `No job #${id}`));
  });

program
  .command('apply <id>')
  .description('Open the application form in a visible browser and fill it in; you confirm before anything is submitted')
  .option('--dry-run', 'fill the form but never submit')
  .action(async (id: string, opts: { dryRun?: boolean }) => {
    await withStore(async (store) => {
      const manager = new ApplyManager(store);
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        await runApplyInTerminal(manager, Number(id), opts.dryRun ?? false, rl);
      } finally {
        rl.close();
        await manager.closeAll();
        await closeSharedBrowser();
      }
    });
  });

program
  .command('preview <id>')
  .description("Show what the assistant would put in each field of a job's form (read-only, nothing is filled)")
  .action(async (id: string) => {
    await withStore(async (store) => {
      const job = store.get(Number(id));
      if (!job) return console.log(`No job #${id}`);
      const { url, rows } = await previewForm(job);
      console.log(`${job.company} - ${job.title}\n${url}\n`);
      if (!rows.length) return console.log('No form fields found on this page (it may be a job description; use the apply assistant and open the form).');
      for (const { field: f, answer: a } of rows) {
        const value = a.value ? (f.kind === 'file' ? path.basename(a.value) : a.value) : `- ${a.note}`;
        console.log(`${f.required ? '*' : ' '} ${truncate(f.label, 60).padEnd(60)} ${truncate(value, 50)}${a.source ? ` [${a.source}]` : ''}`);
      }
      if (hasClaude()) console.log('\n(Claude drafts answers for the open questions when the assistant runs.)');
    });
  });

program
  .command('dashboard')
  .description('Start the local dashboard (http://127.0.0.1:4317) and open it')
  .option('--no-open', "don't open the browser")
  .option('--no-batch', "don't prefill a batch of tabs on start")
  .action(async (opts: { open: boolean; batch: boolean }) => {
    const store = new JobStore(paths.db);
    const { batch } = loadSearchConfig();
    const autoBatch = opts.batch && batch.auto_start;
    const { url } = await startDashboard(store, {
      autoBatch,
      batchSize: batch.size,
      batching: { includeNearMisses: batch.include_near_misses, nearMissMinScore: batch.near_miss_min_score },
    });
    console.log(`Dashboard: ${url}  (Ctrl+C to stop)`);
    console.log(autoBatch ? 'Prefilling the oldest unfinished batch in the assistant browser. Nothing is submitted; you submit each tab.' : 'Open the Batch view and press Start on the batch you want.');
    if (opts.open) exec(process.platform === 'win32' ? `start "" "${url}"` : `open "${url}"`);
  });

program
  .command('sync-config')
  .description('Add new companies and settings from config/search.example.yaml to your config/search.yaml (run by setup)')
  .action(() => {
    const { companies, settings } = syncSearchConfig();
    if (!companies.length && !settings.length) return console.log('Your config/search.yaml is up to date.');
    if (settings.length) console.log(`Added settings: ${settings.join(', ')}`);
    if (companies.length) console.log(`Added ${companies.length} company board(s): ${companies.join(', ')}`);
  });

program
  .command('report')
  .description('Rebuild the report from the database')
  .action(async () => {
    await withStore((store) => console.log(rel(writeReport(store, emptyStats(), loadProfileFacts()).markdown)));
  });

program.parseAsync().catch((err: Error) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
