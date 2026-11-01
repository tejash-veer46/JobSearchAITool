import { env, type SearchConfig } from '../config.js';
import { HttpError } from '../lib/http.js';
import type { RawJob } from '../types.js';
import { type Company, fetchAshby, fetchGreenhouse, fetchLever } from './ats.js';
import { fetchAdzuna, fetchHimalayas, fetchRemotive } from './feeds.js';

export const SOURCE_NAMES = ['greenhouse', 'lever', 'ashby', 'himalayas', 'remotive', 'adzuna'] as const;
export type SourceName = (typeof SOURCE_NAMES)[number];

interface Task {
  source: SourceName;
  target: string;
  run: () => Promise<RawJob[]>;
}

export interface DiscoveryResult {
  jobs: RawJob[];
  perSource: Record<string, number>;
  errors: { source: string; target: string; message: string }[];
  skipped: string[];
}

function buildTasks(cfg: SearchConfig, only?: SourceName[]): { tasks: Task[]; skipped: string[] } {
  const want = (s: SourceName) => !only?.length || only.includes(s);
  const tasks: Task[] = [];
  const skipped: string[] = [];
  const ats = (source: SourceName, list: Company[], fn: (c: Company) => Promise<RawJob[]>) => {
    if (want(source)) for (const c of list) tasks.push({ source, target: c.slug, run: () => fn(c) });
  };
  ats('greenhouse', cfg.sources.greenhouse, fetchGreenhouse);
  ats('lever', cfg.sources.lever, fetchLever);
  ats('ashby', cfg.sources.ashby, fetchAshby);

  const { himalayas, remotive, adzuna } = cfg.sources;
  if (want('himalayas') && himalayas.enabled)
    tasks.push({ source: 'himalayas', target: 'search', run: () => fetchHimalayas(himalayas.queries) });
  if (want('remotive') && remotive.enabled)
    tasks.push({ source: 'remotive', target: 'search', run: () => fetchRemotive(remotive.categories) });
  if (want('adzuna') && adzuna.enabled) {
    if (env.adzunaId && env.adzunaKey) {
      tasks.push({
        source: 'adzuna',
        target: 'search',
        run: () => fetchAdzuna(adzuna.queries, { id: env.adzunaId, key: env.adzunaKey }, cfg.filters.max_age_days),
      });
    } else skipped.push('adzuna (no ADZUNA_APP_ID / ADZUNA_APP_KEY in .env)');
  }
  return { tasks, skipped };
}

/** Runs every enabled source. One failing company or feed is logged and skipped, never fatal. */
export async function discoverJobs(
  cfg: SearchConfig,
  opts: { only?: SourceName[]; concurrency?: number; onProgress?: (msg: string) => void } = {},
): Promise<DiscoveryResult> {
  const { tasks, skipped } = buildTasks(cfg, opts.only);
  const result: DiscoveryResult = { jobs: [], perSource: {}, errors: [], skipped };
  const queue = [...tasks];

  const worker = async () => {
    for (let task = queue.shift(); task; task = queue.shift()) {
      try {
        const jobs = await task.run();
        result.jobs.push(...jobs);
        result.perSource[task.source] = (result.perSource[task.source] ?? 0) + jobs.length;
        opts.onProgress?.(`${task.source}/${task.target}: ${jobs.length} postings`);
      } catch (err) {
        const message = err instanceof HttpError && err.status === 404 ? 'board not found (check the slug)' : (err as Error).message;
        result.errors.push({ source: task.source, target: task.target, message });
        opts.onProgress?.(`${task.source}/${task.target}: FAILED - ${message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 4 }, worker));
  return result;
}
