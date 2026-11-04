import { loadProfileFacts, loadSearchConfig, type SearchConfig } from '../config.js';
import type { JobStore } from '../db.js';
import { hasClaude } from '../lib/claude.js';
import type { RawJob } from '../types.js';
import { discoverJobs, type SourceName } from '../sources/index.js';
import { filterJob, reasonCategory } from './filters.js';
import { type MatchContext, scoreJob } from './matcher.js';
import { emptyStats, type ReportFiles, type RunStats, writeReport } from './reporter.js';
import { loadProfile } from './resume.js';

export interface RunOptions {
  only?: SourceName[];
  score?: boolean;
  rescore?: boolean;
  limit?: number;
  log?: (msg: string) => void;
}

export async function scorePending(store: JobStore, ctx: MatchContext, limit: number, rescore: boolean, stats: RunStats, log: (m: string) => void) {
  const pending = store.pendingScoring(limit, rescore);
  if (!pending.length) return;
  log(`Scoring ${pending.length} job(s) with ${hasClaude() ? 'Claude' : 'keyword rules'}...`);
  // Claude calls run a few at a time; rule scoring is instant.
  const queue = [...pending];
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const match = await scoreJob(job, ctx);
      const status = store.saveMatch(job.id, match, ctx.threshold);
      stats.scored++;
      if (status === 'STAGED') stats.staged++;
      else stats.scoreRejected++;
      log(`  ${status === 'STAGED' ? '✓' : '·'} ${String(match.matchScore).padStart(3)}  #${job.id} ${job.company} - ${job.title}`);
    }
  };
  await Promise.all(Array.from({ length: hasClaude() ? 3 : 1 }, worker));
}

/**
 * Re-applies the current filters to every job not yet applied to, so edits to
 * config/search.yaml take effect on jobs already in the database.
 */
export function refilterAll(store: JobStore, cfg: SearchConfig): { reopened: number; rejected: number } {
  let reopened = 0;
  let rejected = 0;
  for (const row of store.list(['DISCOVERED', 'REJECTED', 'STAGED'], 1_000_000)) {
    const verdict = filterJob(
      {
        platform: row.platform,
        externalId: row.external_id,
        title: row.title,
        company: row.company,
        location: row.location,
        url: row.url,
        description: row.description,
        postedAt: row.posted_at,
        workplace: row.workplace as RawJob['workplace'],
        seniorityHints: row.seniority_hints,
      },
      cfg,
    );
    if (row.reject_stage === 'user') continue;
    if (!verdict.ok && row.reject_stage !== 'filter') {
      store.reject(row.id, 'filter', verdict.reason);
      rejected++;
    } else if (verdict.ok && row.reject_stage === 'filter') {
      store.reopen(row.id);
      reopened++;
    }
  }
  return { reopened, rejected };
}

/** Discover -> filter -> score -> report. */
export async function runPipeline(store: JobStore, opts: RunOptions = {}): Promise<{ stats: RunStats; report: ReportFiles }> {
  const log = opts.log ?? console.log;
  const cfg = loadSearchConfig();
  const facts = loadProfileFacts();
  const profile = await loadProfile();
  log(`Candidate: ${profile.name}, ${profile.yearsExperience} years (${profile.parsedBy} parse)`);

  const runId = store.startRun();
  const stats = emptyStats();

  log('Fetching postings...');
  const found = await discoverJobs(cfg, { only: opts.only, onProgress: (m) => log(`  ${m}`) });
  stats.fetched = found.jobs.length;
  stats.perSource = found.perSource;
  stats.sourceErrors = found.errors;
  stats.skippedSources = found.skipped;

  for (const raw of found.jobs) {
    const res = store.upsertDiscovered(raw);
    if (res.kind === 'seen') stats.seen++;
    else if (res.kind === 'duplicate') stats.duplicates++;
    else {
      stats.new++;
      const verdict = filterJob(raw, cfg);
      if (!verdict.ok) {
        store.reject(res.id, 'filter', verdict.reason);
        stats.filteredOut++;
        const cat = reasonCategory(verdict.reason);
        stats.filterReasons[cat] = (stats.filterReasons[cat] ?? 0) + 1;
      }
    }
  }
  log(`${stats.new} new, ${stats.filteredOut} filtered out, ${stats.seen} seen before, ${stats.duplicates} duplicates.`);
  const reasons = Object.entries(stats.filterReasons).sort((a, b) => b[1] - a[1]);
  if (reasons.length) log(`Filtered out because of: ${reasons.map(([r, n]) => `${r} ${n}`).join(', ')}`);
  if (stats.new > 0 && stats.filteredOut === stats.new) {
    log(
      'Every new posting was filtered out. "title" means not a QA/testing role, "seniority" a senior/lead title, ' +
        '"experience" more years than filters.max_required_years in config/search.yaml, "location" outside India. ' +
        'Adjust config/search.yaml if these are jobs you want, then run "npm run cli -- refilter".',
    );
  }

  if (opts.score !== false) {
    const ctx: MatchContext = {
      profile,
      facts,
      threshold: cfg.scoring.qualify_threshold,
      maxRequiredYears: cfg.filters.max_required_years,
    };
    await scorePending(store, ctx, opts.limit ?? cfg.scoring.max_scored_per_run, opts.rescore ?? false, stats, log);
  }

  const created = store.assignBatches(cfg.batch.size, {
    includeNearMisses: cfg.batch.include_near_misses,
    nearMissMinScore: cfg.batch.near_miss_min_score,
  });
  if (created) log(`Sorted new jobs into ${created} new batch(es) of up to ${cfg.batch.size}. Open the Batch view to start one.`);

  stats.finishedAt = new Date().toISOString();
  store.finishRun(runId, stats);
  const report = writeReport(store, stats, facts);
  return { stats, report };
}
