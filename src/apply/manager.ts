import type { BrowserContext } from 'playwright-core';
import { loadProfileFacts } from '../config.js';
import type { JobRow, JobStore } from '../db.js';

type BatchJob = ReturnType<JobStore['batchJobs']>[number];
import { findResumeFile, loadProfile } from '../engine/resume.js';
import { sharedBrowser } from './browser.js';
import { ApplySession } from './session.js';

const ACTIVE = new Set(['starting', 'filling', 'needs_input', 'ready', 'captcha', 'submitting']);

/**
 * Job feeds whose pages sit behind a bot check (Cloudflare) that blocks automated browsers.
 * Their jobs are opened in your own browser instead of being prefilled.
 */
export const OPEN_ONLY_PLATFORMS = new Set(['himalayas', 'remotive']);

export interface Batch {
  /** The saved batch being worked on (null for an ad-hoc batch). */
  batchId: number | null;
  startedAt: string;
  jobIds: number[];
  /** Still opening and filling tabs. */
  filling: boolean;
}

/** Keeps one apply session per job, all in one shared browser window. */
export class ApplyManager {
  private readonly sessions = new Map<number, ApplySession>();
  batch: Batch | null = null;

  constructor(
    private readonly store: JobStore,
    private readonly browser: () => Promise<BrowserContext> = () => sharedBrowser(),
  ) {}

  get(jobId: number): ApplySession | undefined {
    return this.sessions.get(jobId);
  }

  private isActive(jobId: number) {
    const s = this.sessions.get(jobId);
    return Boolean(s && ACTIVE.has(s.state));
  }

  /** Starts (or returns the running) session for a job. Opening and filling continue in the background. */
  async open(
    jobId: number,
    opts: { dryRun?: boolean; prefill?: boolean; background?: boolean } = {},
  ): Promise<{ session: ApplySession; started: Promise<void> }> {
    const existing = this.sessions.get(jobId);
    if (existing && this.isActive(jobId)) return { session: existing, started: Promise.resolve() };
    const job = this.store.get(jobId);
    if (!job) throw new Error(`No job #${jobId}`);
    const session = new ApplySession(job, {
      store: this.store,
      profile: await loadProfile(),
      facts: loadProfileFacts(),
      resumeFile: findResumeFile(),
      browser: this.browser,
      ...opts,
    });
    this.sessions.set(jobId, session);
    return { session, started: session.start() };
  }

  /** A job that can be opened in a prefilled tab now: ready (or a stretch near miss) and not waiting on you. */
  private canPrefill(job: BatchJob): boolean {
    if (OPEN_ONLY_PLATFORMS.has(job.platform) || this.isActive(job.id)) return false;
    const readyStatus = job.status === 'STAGED' || (job.status === 'REJECTED' && job.reject_stage === 'score');
    return readyStatus && job.last_outcome !== 'open' && job.last_outcome !== 'closed_unconfirmed';
  }

  /**
   * Opens and fills jobs, each in its own background tab, a few at a time. Pass a saved batch
   * (`{ batchId }`) to work through it, or a number to take that many ready jobs (used by tests).
   * Nothing is submitted: you review each tab and press the site's Submit button.
   */
  startBatch(
    which: number | { batchId: number } = 20,
    opts: { concurrency?: number; onProgress?: (line: string) => void } = {},
  ): Batch {
    if (this.batch?.filling) return this.batch;
    let jobIds: number[];
    let toOpen: JobRow[];
    let batchId: number | null = null;
    if (typeof which === 'number') {
      const busy = [...this.sessions.keys()].filter((id) => this.isActive(id));
      toOpen = this.store.batchCandidates(which, busy);
      jobIds = toOpen.map((j) => j.id);
    } else {
      batchId = which.batchId;
      const jobs = this.store.batchJobs(batchId);
      jobIds = jobs.map((j) => j.id);
      toOpen = jobs.filter((j) => this.canPrefill(j));
      this.store.markBatchStarted(batchId);
    }
    const batch: Batch = { batchId, startedAt: new Date().toISOString(), jobIds, filling: false };
    this.batch = batch;

    const queue = toOpen.filter((j) => !OPEN_ONLY_PLATFORMS.has(j.platform));
    if (!queue.length) return batch;
    batch.filling = true;
    const worker = async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        try {
          const { started } = await this.open(job.id, { prefill: true, background: true });
          await started;
          opts.onProgress?.(`#${job.id} ${job.company}: ${this.sessions.get(job.id)?.state}`);
        } catch (err) {
          opts.onProgress?.(`#${job.id} ${job.company}: failed (${(err as Error).message})`);
        }
      }
    };
    void Promise.all(Array.from({ length: opts.concurrency ?? 3 }, worker)).finally(() => {
      batch.filling = false;
    });
    return batch;
  }

  /** The oldest saved batch that still has something to do, for "Start next batch" and auto-start. */
  nextBatchId(): number | null {
    const batches = this.store.batches().reverse(); // oldest first
    const hasWork = (jobs: BatchJob[]) => jobs.some((j) => this.canPrefill(j) || (OPEN_ONLY_PLATFORMS.has(j.platform) && j.status === 'STAGED' && !j.last_outcome));
    return (batches.find((b) => b.jobs.some((j) => this.canPrefill(j))) ?? batches.find((b) => hasWork(b.jobs)))?.id ?? null;
  }

  /** One job's state in a batch: its live tab if open, otherwise what has happened to it so far. */
  describe(job: BatchJob | JobRow, live = false) {
    const s = this.sessions.get(job.id)?.snapshot();
    const manual = OPEN_ONLY_PLATFORMS.has(job.platform);
    const last = 'last_outcome' in job ? job.last_outcome : null;
    let state: string;
    let message: string;
    if (job.status === 'APPLIED') [state, message] = ['submitted', 'Applied'];
    else if (s && s.state !== 'closed') [state, message] = [s.state, s.message];
    else if (job.status === 'REJECTED' && job.reject_stage === 'user') [state, message] = ['skipped', 'Marked not interested'];
    else if (job.status === 'REJECTED' && job.reject_stage === 'filter') [state, message] = ['skipped', 'No longer matches your filters'];
    else if (last === 'closed_unconfirmed') [state, message] = ['awaiting', 'Answer "Did you apply?" above'];
    else if (manual) [state, message] = [last ? 'opened' : 'manual', 'This site blocks automated browsers: open it in your own browser.'];
    else if (live && this.batch?.filling) [state, message] = ['queued', 'Waiting for a free slot...'];
    else [state, message] = ['not_started', last === 'skipped' ? 'Kept for later' : last === 'failed' ? 'Could not open last time; will retry' : 'Not started yet'];
    return {
      id: job.id,
      company: job.company,
      title: job.title,
      platform: job.platform,
      url: job.apply_url ?? job.url,
      jobStatus: job.status,
      stretch: 'stretch' in job ? job.stretch : false,
      score: job.match_score,
      state,
      message,
      missing: s ? s.fields.filter((f) => f.required && f.status !== 'filled').map((f) => f.label) : [],
      filled: s ? s.fields.filter((f) => f.status === 'filled').length : 0,
      total: s?.fields.length ?? 0,
    };
  }

  /** Each job of the batch being worked on now, with its tab's state. */
  batchStatus() {
    if (!this.batch) return null;
    const jobs = this.batch.batchId ? this.store.batchJobs(this.batch.batchId) : this.batch.jobIds.map((id) => this.store.get(id)).filter((j): j is JobRow => Boolean(j));
    return { ...this.batch, items: jobs.map((j) => this.describe(j, true)) };
  }

  /** Every saved batch with counts, for the batch list. */
  batchList() {
    return this.store.batches().map((b) => {
      const items = b.jobs.map((j) => this.describe(j, this.batch?.batchId === b.id));
      const count = (...states: string[]) => items.filter((i) => states.includes(i.state)).length;
      const toPrefill = b.jobs.filter((j) => this.canPrefill(j)).length;
      const toOpen = count('manual');
      return {
        id: b.id,
        createdAt: b.created_at,
        startedAt: b.started_at,
        active: this.batch?.batchId === b.id,
        filling: this.batch?.batchId === b.id && this.batch.filling,
        total: items.length,
        toPrefill,
        toOpen,
        inTabs: count('ready', 'needs_input', 'captcha', 'filling', 'starting', 'submitting', 'queued'),
        applied: count('submitted'),
        awaiting: count('awaiting', 'opened'),
        stretch: items.filter((i) => i.stretch).length,
        done: toPrefill === 0 && toOpen === 0 && count('ready', 'needs_input', 'captcha', 'filling', 'starting', 'submitting', 'queued') === 0,
      };
    });
  }

  batchItems(batchId: number) {
    return this.store.batchJobs(batchId).map((j) => this.describe(j, this.batch?.batchId === batchId));
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.close()));
  }
}
