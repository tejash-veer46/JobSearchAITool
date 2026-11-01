import type { BrowserContext } from 'playwright-core';
import { loadProfileFacts } from '../config.js';
import type { JobRow, JobStore } from '../db.js';
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

  /**
   * Opens and fills the next `size` ready jobs, each in its own background tab, a few at a time.
   * Nothing is submitted: you review each tab and press the site's Submit button.
   */
  startBatch(size = 20, opts: { concurrency?: number; onProgress?: (line: string) => void } = {}): Batch {
    if (this.batch?.filling) return this.batch;
    const busy = [...this.sessions.keys()].filter((id) => this.isActive(id));
    const jobs: JobRow[] = this.store.batchCandidates(size, busy);
    const batch: Batch = { startedAt: new Date().toISOString(), jobIds: jobs.map((j) => j.id), filling: jobs.length > 0 };
    this.batch = batch;
    if (!jobs.length) return batch;

    const queue = jobs.filter((j) => !OPEN_ONLY_PLATFORMS.has(j.platform));
    if (!queue.length) batch.filling = false;
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

  /** Each job of the current batch with its tab's state. */
  batchStatus() {
    if (!this.batch) return null;
    return {
      ...this.batch,
      items: this.batch.jobIds.map((id) => {
        const job = this.store.get(id);
        const s = this.sessions.get(id)?.snapshot();
        const manual = Boolean(job && OPEN_ONLY_PLATFORMS.has(job.platform));
        const manualState = job?.status === 'APPLIED' ? 'submitted' : job && this.store.attempts(id).length ? 'opened' : 'manual';
        return {
          id,
          company: job?.company ?? '',
          title: job?.title ?? '',
          platform: job?.platform ?? '',
          url: job?.apply_url ?? job?.url ?? '',
          jobStatus: job?.status ?? null,
          state: manual ? manualState : (s?.state ?? 'queued'),
          message: manual ? 'This site blocks automated browsers: open it in your own browser.' : (s?.message ?? 'Waiting for a free slot...'),
          missing: s ? s.fields.filter((f) => f.required && f.status !== 'filled').map((f) => f.label) : [],
          filled: s ? s.fields.filter((f) => f.status === 'filled').length : 0,
          total: s?.fields.length ?? 0,
        };
      }),
    };
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.close()));
  }
}
