// Local dashboard: a small JSON API plus static files, bound to 127.0.0.1 only.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApplyManager } from '../apply/manager.js';
import { fullySupported, applyUrl } from '../apply/session.js';
import { env, loadProfileFacts } from '../config.js';
import { EVENT_TYPES, type EventType, type JobRow, type JobStore, PIPELINE_STAGES, type PipelineStage } from '../db.js';
import { runPipeline } from '../engine/pipeline.js';
import { hasClaude } from '../lib/claude.js';
import { JOB_STATUSES, type JobStatus } from '../types.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

/** Your default browser, not the assistant's. No shell is involved, and only http(s) URLs are opened. */
function defaultOpen(url: string) {
  if (!/^https?:\/\/\S+$/i.test(url)) return;
  if (process.platform === 'win32') execFile('rundll32', ['url.dll,FileProtocolHandler', url]);
  else execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
}

class HttpProblem extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Handler = (ctx: { params: string[]; body: Record<string, unknown>; query: URLSearchParams }) => Promise<unknown> | unknown;

export interface DashboardOptions {
  port?: number;
  manager?: ApplyManager;
  /** Opens a URL in your normal browser (tests replace it). */
  openInBrowser?: (url: string) => void;
  /** Prefill a batch of tabs as soon as the dashboard starts. */
  autoBatch?: boolean;
  batchSize?: number;
  /** How ready jobs are sorted into saved batches (config/search.yaml `batch`). */
  batching?: { includeNearMisses?: boolean; nearMissMinScore?: number };
  /** Replaces the job-fetch pipeline (tests). */
  runJobs?: (log: (line: string) => void) => Promise<unknown>;
}

const VIEWS: Record<string, (j: JobRow) => boolean> = {
  ready: (j) => j.status === 'STAGED',
  near: (j) => j.status === 'REJECTED' && j.reject_stage === 'score' && (j.match_score ?? 0) >= 60,
  applied: (j) => j.status === 'APPLIED' || j.status === 'FAILED',
  waiting: (j) => j.status === 'DISCOVERED',
  rejected: (j) => j.status === 'REJECTED',
  all: () => true,
};

const listItem = (j: JobRow) => ({
  id: j.id,
  title: j.title,
  company: j.company,
  location: j.location,
  platform: j.platform,
  workplace: j.workplace,
  status: j.status,
  match_score: j.match_score,
  posted_at: j.posted_at ?? j.first_seen_at,
  applied_at: j.applied_at,
  reject_reason: j.reject_reason,
});

export async function startDashboard(store: JobStore, opts: DashboardOptions = {}): Promise<{ url: string; server: Server; close: () => Promise<void> }> {
  const manager = opts.manager ?? new ApplyManager(store);
  const openInBrowser = opts.openInBrowser ?? defaultOpen;
  const batchSize = opts.batchSize ?? 20;
  // Tabs from a previous dashboard run are gone; ask about those instead of re-filling them.
  store.closeStaleAttempts();
  const day = 86_400_000;
  const run = { running: false, log: [] as string[], startedAt: null as string | null, finishedAt: null as string | null, error: null as string | null };
  const runJobs = opts.runJobs ?? ((log: (l: string) => void) => runPipeline(store, { log }));

  const job = (params: string[]) => {
    const j = store.get(Number(params[0]));
    if (!j) throw new HttpProblem(404, 'No such job');
    return j;
  };
  /** Sorts any ready jobs not yet in a batch into batches (cheap when there are none). */
  const assign = () =>
    store.assignBatches(batchSize, { includeNearMisses: opts.batching?.includeNearMisses ?? true, nearMissMinScore: opts.batching?.nearMissMinScore ?? 65 });
  const batchOrThrow = (params: string[]) => {
    if (!store.batches().some((b) => b.id === Number(params[0]))) throw new HttpProblem(404, 'No such batch');
    return true;
  };
  /** Opens feed jobs in your default browser and asks later whether you applied. */
  const openManual = (items: { id: number; url: string; state: string }[]) => {
    const manual = items.filter((i) => i.state === 'manual');
    for (const i of manual) {
      openInBrowser(i.url);
      store.finishAttempt(store.startAttempt(i.id, i.url), 'closed_unconfirmed', { openedIn: 'your browser' });
    }
    return manual.length;
  };
  const session = (params: string[]) => {
    const s = manager.get(Number(params[0]));
    if (!s) throw new HttpProblem(404, 'No apply session for this job');
    return s;
  };

  const routes: [string, RegExp, Handler][] = [
    ['GET', /^\/api\/summary$/, () => {
      const last = store.lastRun();
      const facts = loadProfileFacts();
      const gaps = [
        facts.compensation.current_ctc_inr == null && 'current CTC',
        !facts.contact.current_city && 'current city',
        !facts.work_authorization && 'work authorization',
      ].filter(Boolean);
      return {
        counts: store.counts(),
        near: store.list(['REJECTED'], 1_000_000).filter(VIEWS.near!).length,
        scorer: hasClaude() ? `Claude (${env.claudeModel})` : 'keyword rules',
        adzuna: Boolean(env.adzunaId && env.adzunaKey),
        lastRun: last ? { startedAt: last.started_at, finishedAt: last.finished_at, stats: JSON.parse(last.stats) } : null,
        profileGaps: gaps,
      };
    }],
    ['GET', /^\/api\/jobs$/, ({ query }) => {
      const view = VIEWS[query.get('view') ?? 'ready'] ?? VIEWS.ready!;
      const q = (query.get('q') ?? '').toLowerCase().trim();
      return store
        .list([], 1_000_000)
        .filter(view)
        .filter((j) => !q || `${j.title} ${j.company} ${j.location}`.toLowerCase().includes(q))
        .slice(0, 500)
        .map(listItem);
    }],
    ['GET', /^\/api\/jobs\/(\d+)$/, ({ params }) => {
      const j = job(params);
      return { ...j, apply_target: applyUrl(j), supported: fullySupported(j.platform), attempts: store.attempts(j.id), session: manager.get(j.id)?.snapshot() ?? null };
    }],
    ['PATCH', /^\/api\/jobs\/(\d+)$/, ({ params, body }) => {
      const j = job(params);
      if (typeof body.short_pitch === 'string' || typeof body.notes === 'string') {
        store.updateJob(j.id, { short_pitch: body.short_pitch as string | undefined, notes: body.notes as string | undefined });
      }
      if (body.pipeline_stage !== undefined) {
        const stage = String(body.pipeline_stage);
        if (!(PIPELINE_STAGES as readonly string[]).includes(stage)) throw new HttpProblem(400, `pipeline_stage must be one of ${PIPELINE_STAGES.join(', ')}`);
        store.setStage(j.id, stage as PipelineStage);
      }
      if (body.status !== undefined) {
        const status = String(body.status).toUpperCase() as JobStatus;
        if (!JOB_STATUSES.includes(status)) throw new HttpProblem(400, `status must be one of ${JOB_STATUSES.join(', ')}`);
        if (status === 'REJECTED') store.reject(j.id, 'user', 'user: not interested');
        else store.setStatus(j.id, status);
      }
      return store.get(j.id);
    }],

    ['POST', /^\/api\/run$/, () => {
      if (run.running) throw new HttpProblem(409, 'A fetch is already running');
      Object.assign(run, { running: true, log: [], startedAt: new Date().toISOString(), finishedAt: null, error: null });
      void runJobs((line) => {
        run.log.push(line);
        if (run.log.length > 400) run.log.shift();
      })
        .catch((err: Error) => {
          run.error = err.message;
        })
        .finally(() => {
          run.running = false;
          run.finishedAt = new Date().toISOString();
        });
      return run;
    }],
    ['GET', /^\/api\/run$/, () => run],

    ['POST', /^\/api\/jobs\/(\d+)\/apply$/, async ({ params, body }) => {
      job(params);
      const { session: s, started } = await manager.open(Number(params[0]), { dryRun: body.dryRun === true });
      started.catch(() => {});
      return s.snapshot();
    }],
    ['GET', /^\/api\/jobs\/(\d+)\/apply$/, ({ params }) => session(params).snapshot()],
    ['POST', /^\/api\/jobs\/(\d+)\/apply\/answer$/, async ({ params, body }) => {
      const s = session(params);
      if (typeof body.key !== 'string' || typeof body.value !== 'string') throw new HttpProblem(400, 'key and value are required');
      await s.answer(body.key, body.value, body.remember === true).catch((err: Error) => {
        throw new HttpProblem(422, `Could not fill that field: ${err.message}`);
      });
      return s.snapshot();
    }],
    ['POST', /^\/api\/jobs\/(\d+)\/apply\/rescan$/, async ({ params }) => {
      const s = session(params);
      await s.scan();
      return s.snapshot();
    }],
    ['POST', /^\/api\/jobs\/(\d+)\/apply\/submit$/, async ({ params, body }) => {
      // The dashboard asks the user to confirm first; the flag makes an accidental call harmless.
      if (body.confirm !== true) throw new HttpProblem(400, 'Submitting needs { "confirm": true }');
      const s = session(params);
      await s.submit().catch((err: Error) => {
        throw new HttpProblem(409, err.message);
      });
      return s.snapshot();
    }],
    ['POST', /^\/api\/jobs\/(\d+)\/apply\/done$/, ({ params }) => {
      const s = session(params);
      s.markSubmittedByUser();
      return s.snapshot();
    }],
    ['POST', /^\/api\/jobs\/(\d+)\/apply\/close$/, async ({ params }) => {
      const s = session(params);
      await s.close();
      return s.snapshot();
    }],
    ['POST', /^\/api\/jobs\/(\d+)\/apply\/focus$/, async ({ params }) => {
      const s = session(params);
      await s.focus();
      return s.snapshot();
    }],
    ['POST', /^\/api\/jobs\/(\d+)\/apply\/skip$/, async ({ params }) => {
      const s = session(params);
      await s.close('skipped');
      return s.snapshot();
    }],

    // ---------------------------------------------------------------- saved batches
    ['GET', /^\/api\/batches$/, () => {
      assign();
      return manager.batchList();
    }],
    ['GET', /^\/api\/batches\/(\d+)$/, ({ params }) => batchOrThrow(params) && { items: manager.batchItems(Number(params[0])) }],
    ['POST', /^\/api\/batches\/(\d+)\/start$/, ({ params }) => {
      batchOrThrow(params);
      if (manager.batch?.filling) throw new HttpProblem(409, `Batch ${manager.batch.batchId ?? ''} is still filling tabs. Wait for it to finish.`);
      manager.startBatch({ batchId: Number(params[0]) });
      return manager.batchStatus();
    }],
    ['POST', /^\/api\/batches\/(\d+)\/open-manual$/, ({ params }) => {
      batchOrThrow(params);
      return { opened: openManual(manager.batchItems(Number(params[0]))) };
    }],

    // The batch being worked on now (live tab states), and "start the next one".
    ['GET', /^\/api\/batch$/, () => manager.batchStatus()],
    ['POST', /^\/api\/batch$/, () => {
      assign();
      const next = manager.nextBatchId();
      if (next) manager.startBatch({ batchId: next });
      return manager.batchStatus();
    }],
    ['POST', /^\/api\/batch\/open-manual$/, () => ({ opened: openManual(manager.batchStatus()?.items ?? []) })],
    ['GET', /^\/api\/confirmations$/, () => store.pendingConfirmations().map(listItem)],
    ['POST', /^\/api\/jobs\/(\d+)\/confirm$/, ({ params, body }) => {
      const j = job(params);
      if (body.answer === 'applied') {
        store.setStatus(j.id, 'APPLIED', 'Submitted in a prefilled tab');
        store.setLatestAttemptOutcome(j.id, 'submitted_by_user');
      } else if (body.answer === 'not_applied') {
        store.setLatestAttemptOutcome(j.id, 'skipped');
      } else if (body.answer === 'not_interested') {
        store.reject(j.id, 'user', 'user: not interested');
        store.setLatestAttemptOutcome(j.id, 'skipped');
      } else throw new HttpProblem(400, 'answer must be applied, not_applied or not_interested');
      return store.get(j.id);
    }],

    // ---------------------------------------------------------------- application tracker
    ['GET', /^\/api\/tracker$/, () => {
      const nowIso = new Date().toISOString();
      const apps = store.applications().map((j) => {
        const events = store.events(j.id);
        const past = events.filter((e) => e.at <= nowIso);
        const next = events.find((e) => e.at > nowIso);
        const appliedAt = j.applied_at ?? j.first_seen_at;
        return {
          ...listItem(j),
          url: j.apply_url ?? j.url,
          notes: j.notes,
          stage: j.pipeline_stage ?? 'applied',
          applied_at: appliedAt,
          days: Math.floor((Date.now() - Date.parse(appliedAt)) / day),
          last_event: past.at(-1) ?? null,
          next_event: next ?? null,
          events,
        };
      });
      const weekAgo = Date.now() - 7 * day;
      const responded = apps.filter((a) => !['applied', 'no_response'].includes(a.stage));
      return {
        stages: PIPELINE_STAGES,
        eventTypes: EVENT_TYPES,
        stats: {
          total: apps.length,
          thisWeek: apps.filter((a) => Date.parse(a.applied_at) >= weekAgo).length,
          responseRate: apps.length ? Math.round((responded.length / apps.length) * 100) : 0,
          interviews: apps.filter((a) => ['interview', 'offer', 'accepted'].includes(a.stage)).length,
          offers: apps.filter((a) => ['offer', 'accepted'].includes(a.stage)).length,
          waiting: apps.filter((a) => a.stage === 'applied' && a.days >= 21).length,
        },
        applications: apps,
      };
    }],
    ['GET', /^\/api\/calendar$/, ({ query }) => {
      const from = query.get('from');
      const to = query.get('to');
      if (!from || !to) throw new HttpProblem(400, 'from and to are required');
      return store.eventsBetween(from, to);
    }],
    ['POST', /^\/api\/jobs\/(\d+)\/events$/, ({ params, body }) => {
      const j = job(params);
      const type = String(body.type);
      if (!(EVENT_TYPES as readonly string[]).includes(type)) throw new HttpProblem(400, `type must be one of ${EVENT_TYPES.join(', ')}`);
      const at = typeof body.at === 'string' && !Number.isNaN(Date.parse(body.at)) ? new Date(body.at).toISOString() : new Date().toISOString();
      if (j.status !== 'APPLIED' && type !== 'note') store.setStatus(j.id, 'APPLIED');
      store.addEvent(j.id, type as EventType, at, typeof body.note === 'string' ? body.note : null);
      return store.events(j.id);
    }],
    ['DELETE', /^\/api\/events\/(\d+)$/, ({ params }) => {
      store.deleteEvent(Number(params[0]));
      return { ok: true };
    }],
    ['POST', /^\/api\/applications$/, ({ body }) => {
      const company = String(body.company ?? '').trim();
      const title = String(body.title ?? '').trim();
      if (!company || !title) throw new HttpProblem(400, 'company and title are required');
      const appliedAt = typeof body.appliedAt === 'string' && !Number.isNaN(Date.parse(body.appliedAt)) ? new Date(body.appliedAt).toISOString() : undefined;
      const id = store.addManualApplication({
        company,
        title,
        url: typeof body.url === 'string' ? body.url.trim() : undefined,
        location: typeof body.location === 'string' ? body.location : undefined,
        appliedAt,
        notes: typeof body.notes === 'string' ? body.notes : undefined,
      });
      return store.get(id);
    }],
  ];

  let port = opts.port ?? env.dashboardPort;
  const allowedHosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  const send = (res: ServerResponse, status: number, data: unknown, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(type.startsWith('application/json') ? JSON.stringify(data) : (data as string | Buffer));
  };

  const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 1_000_000) throw new HttpProblem(413, 'Body too large');
    }
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new HttpProblem(400, 'Invalid JSON');
    }
  };

  const server = createServer(async (req, res) => {
    try {
      // Reject other host names (DNS rebinding) and cross-site requests from pages you visit.
      if (!allowedHosts().has(req.headers.host ?? '')) throw new HttpProblem(403, 'Forbidden host');
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const method = req.method ?? 'GET';
      if (method !== 'GET') {
        const origin = req.headers.origin;
        if (req.headers['x-jobapplyai'] !== '1' || (origin && !allowedHosts().has(origin.replace(/^https?:\/\//, '')))) {
          throw new HttpProblem(403, 'Cross-site request blocked');
        }
      }

      if (url.pathname.startsWith('/api/')) {
        for (const [m, re, handler] of routes) {
          const match = url.pathname.match(re);
          if (match && m === method) {
            const body = method === 'GET' ? {} : await readBody(req);
            return send(res, 200, await handler({ params: match.slice(1), body, query: url.searchParams }));
          }
        }
        throw new HttpProblem(404, 'Not found');
      }

      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const full = path.join(PUBLIC, file);
      if (!full.startsWith(PUBLIC + path.sep) || !MIME[path.extname(full)]) throw new HttpProblem(404, 'Not found');
      send(res, 200, await readFile(full).catch(() => {
        throw new HttpProblem(404, 'Not found');
      }), MIME[path.extname(full)]);
    } catch (err) {
      const status = err instanceof HttpProblem ? err.status : 500;
      if (status === 500) console.error(err);
      send(res, status, { error: (err as Error).message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address && typeof address === 'object') port = address.port;
  assign();
  if (opts.autoBatch) {
    const next = manager.nextBatchId();
    if (next) manager.startBatch({ batchId: next });
  }

  return {
    url: `http://127.0.0.1:${port}`,
    server,
    close: async () => {
      await manager.closeAll();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
