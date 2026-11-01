import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fingerprint } from './lib/text.js';
import type { JobStatus, MatchResult, RawJob, ScreeningAnswer } from './types.js';

export interface JobRow {
  id: number;
  external_id: string;
  platform: string;
  title: string;
  company: string;
  location: string;
  url: string;
  apply_url: string | null;
  description: string;
  posted_at: string | null;
  workplace: string | null;
  salary: string | null;
  seniority_hints: string[];
  status: JobStatus;
  reject_stage: 'filter' | 'score' | 'user' | null;
  reject_reason: string | null;
  match_score: number | null;
  match_reason: string | null;
  matched_skills: string[];
  missing_skills: string[];
  tailored_answers: ScreeningAnswer[];
  short_pitch: string | null;
  scorer: string | null;
  first_seen_at: string;
  last_seen_at: string;
  applied_at: string | null;
  notes: string | null;
  pipeline_stage: PipelineStage | null;
}

/** Where an application stands after you applied. */
export const PIPELINE_STAGES = ['applied', 'screening', 'assessment', 'interview', 'offer', 'accepted', 'rejected', 'withdrawn', 'no_response'] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];
export const EVENT_TYPES = [...PIPELINE_STAGES, 'follow_up', 'note'] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface AppEvent {
  id: number;
  job_id: number;
  type: EventType;
  at: string;
  note: string | null;
  created_at: string;
}

export type UpsertResult = { kind: 'new'; id: number } | { kind: 'seen'; id: number } | { kind: 'duplicate'; id: number };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id    TEXT NOT NULL,
  platform       TEXT NOT NULL,
  title          TEXT NOT NULL,
  company        TEXT NOT NULL,
  location       TEXT NOT NULL DEFAULT '',
  url            TEXT NOT NULL,
  apply_url      TEXT,
  description    TEXT NOT NULL DEFAULT '',
  posted_at      TEXT,
  workplace      TEXT,
  salary         TEXT,
  seniority_hints TEXT NOT NULL DEFAULT '[]',
  fingerprint    TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'DISCOVERED'
                 CHECK (status IN ('DISCOVERED','REJECTED','STAGED','APPLIED','FAILED')),
  reject_stage   TEXT,
  reject_reason  TEXT,
  match_score    INTEGER,
  match_reason   TEXT,
  matched_skills TEXT NOT NULL DEFAULT '[]',
  missing_skills TEXT NOT NULL DEFAULT '[]',
  tailored_answers TEXT NOT NULL DEFAULT '[]',
  short_pitch    TEXT,
  scorer         TEXT,
  first_seen_at  TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  scored_at      TEXT,
  applied_at     TEXT,
  notes          TEXT,
  UNIQUE (platform, external_id)
);
CREATE INDEX IF NOT EXISTS idx_jobs_fingerprint ON jobs (fingerprint);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status);
CREATE INDEX IF NOT EXISTS idx_jobs_url ON jobs (url);

CREATE TABLE IF NOT EXISTS apply_attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      INTEGER NOT NULL REFERENCES jobs (id),
  url         TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  outcome     TEXT,          -- submitted | submitted_by_user | dry_run | cancelled | failed
  details     TEXT NOT NULL DEFAULT '{}'
);

-- Your application pipeline after applying: screening calls, interviews, offers, follow-ups.
CREATE TABLE IF NOT EXISTS application_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     INTEGER NOT NULL REFERENCES jobs (id),
  type       TEXT NOT NULL,
  at         TEXT NOT NULL,          -- when it happens / happened (ISO date or date-time)
  note       TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_at ON application_events (at);

CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  stats       TEXT NOT NULL DEFAULT '{}'
);
`;

const JSON_COLUMNS = ['matched_skills', 'missing_skills', 'tailored_answers', 'seniority_hints'] as const;

function toRow(r: Record<string, unknown>): JobRow {
  const row = { ...r } as Record<string, unknown>;
  for (const col of JSON_COLUMNS) row[col] = JSON.parse(String(row[col] ?? '[]'));
  return row as unknown as JobRow;
}

const now = () => new Date().toISOString();

export class JobStore {
  readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Adds columns introduced after a database was first created. */
  private migrate(): void {
    const cols = new Set((this.db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[]).map((c) => c.name));
    const add: [string, string][] = [
      ['seniority_hints', `TEXT NOT NULL DEFAULT '[]'`],
      ['pipeline_stage', 'TEXT'],
    ];
    for (const [name, ddl] of add) if (!cols.has(name)) this.db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${ddl}`);
  }

  /** Insert a newly found posting, or note that it was seen again. Cross-source duplicates are not inserted. */
  upsertDiscovered(job: RawJob): UpsertResult {
    const existing = this.db
      .prepare('SELECT id FROM jobs WHERE (platform = ? AND external_id = ?) OR url = ?')
      .get(job.platform, job.externalId, job.url) as { id: number } | undefined;
    if (existing) {
      this.db.prepare('UPDATE jobs SET last_seen_at = ? WHERE id = ?').run(now(), existing.id);
      return { kind: 'seen', id: existing.id };
    }

    const fp = fingerprint(job.company, job.title, job.location);
    const twin = this.db.prepare('SELECT id FROM jobs WHERE fingerprint = ?').get(fp) as { id: number } | undefined;
    if (twin) return { kind: 'duplicate', id: twin.id };

    const ts = now();
    const res = this.db
      .prepare(
        `INSERT INTO jobs (external_id, platform, title, company, location, url, apply_url, description,
                           posted_at, workplace, salary, seniority_hints, fingerprint, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        job.externalId, job.platform, job.title, job.company, job.location, job.url, job.applyUrl ?? null,
        job.description, job.postedAt ?? null, job.workplace ?? null, job.salary ?? null,
        JSON.stringify(job.seniorityHints ?? []), fp, ts, ts,
      );
    return { kind: 'new', id: Number(res.lastInsertRowid) };
  }

  reject(id: number, stage: 'filter' | 'score' | 'user', reason: string): void {
    this.db
      .prepare(`UPDATE jobs SET status = 'REJECTED', reject_stage = ?, reject_reason = ? WHERE id = ?`)
      .run(stage, reason, id);
  }

  saveMatch(id: number, m: MatchResult, threshold: number): JobStatus {
    const status: JobStatus = m.isQualified ? 'STAGED' : 'REJECTED';
    this.db
      .prepare(
        `UPDATE jobs SET status = ?, reject_stage = ?, reject_reason = ?, match_score = ?, match_reason = ?,
                matched_skills = ?, missing_skills = ?, tailored_answers = ?, short_pitch = ?, scorer = ?, scored_at = ?
         WHERE id = ?`,
      )
      .run(
        status,
        m.isQualified ? null : 'score',
        m.isQualified ? null : `scored ${Math.round(m.matchScore)} (needs ${threshold}): ${m.reason}`,
        Math.round(m.matchScore), m.reason, JSON.stringify(m.matchedSkills), JSON.stringify(m.missingSkills),
        JSON.stringify(m.tailoredAnswers), m.shortPitch, m.scorer, now(), id,
      );
    return status;
  }

  /** Puts a job back in the scoring queue (used when a filter change lets it through). */
  reopen(id: number): void {
    this.db
      .prepare(`UPDATE jobs SET status = 'DISCOVERED', reject_stage = NULL, reject_reason = NULL WHERE id = ?`)
      .run(id);
  }

  setStatus(id: number, status: JobStatus, note?: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE jobs SET status = ?, applied_at = CASE WHEN ? = 'APPLIED' THEN ? ELSE applied_at END,
                notes = COALESCE(?, notes) WHERE id = ?`,
      )
      .run(status, status, now(), note ?? null, id);
    if (status === 'APPLIED' && Number(res.changes) > 0) this.recordApplied(id);
    return Number(res.changes) > 0;
  }

  /** Starts the pipeline for a new application: stage "applied" plus an "applied" event on the calendar. */
  private recordApplied(id: number): void {
    const job = this.get(id);
    if (!job) return;
    if (!job.pipeline_stage) this.db.prepare(`UPDATE jobs SET pipeline_stage = 'applied' WHERE id = ?`).run(id);
    const has = this.db.prepare(`SELECT 1 FROM application_events WHERE job_id = ? AND type = 'applied'`).get(id);
    if (!has) this.addEvent(id, 'applied', job.applied_at ?? now());
  }

  // ---------------------------------------------------------------- application tracker

  addEvent(jobId: number, type: EventType, at: string, note?: string | null): number {
    const res = this.db
      .prepare('INSERT INTO application_events (job_id, type, at, note, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(jobId, type, at, note ?? null, now());
    if ((PIPELINE_STAGES as readonly string[]).includes(type) && type !== 'applied') this.setStage(jobId, type as PipelineStage);
    return Number(res.lastInsertRowid);
  }

  deleteEvent(id: number): void {
    this.db.prepare('DELETE FROM application_events WHERE id = ?').run(id);
  }

  setStage(jobId: number, stage: PipelineStage): void {
    this.db.prepare('UPDATE jobs SET pipeline_stage = ? WHERE id = ?').run(stage, jobId);
  }

  events(jobId: number): AppEvent[] {
    return this.db.prepare('SELECT * FROM application_events WHERE job_id = ? ORDER BY at, id').all(jobId) as unknown as AppEvent[];
  }

  /** Calendar entries between two ISO dates (inclusive start, exclusive end). */
  eventsBetween(from: string, to: string): (AppEvent & { company: string; title: string })[] {
    return this.db
      .prepare(
        `SELECT e.*, j.company, j.title FROM application_events e JOIN jobs j ON j.id = e.job_id
         WHERE e.at >= ? AND e.at < ? ORDER BY e.at, e.id`,
      )
      .all(from, to) as unknown as (AppEvent & { company: string; title: string })[];
  }

  /** Every job you applied to, newest first. */
  applications(): JobRow[] {
    return this.db
      .prepare(`SELECT * FROM jobs WHERE status IN ('APPLIED','FAILED') ORDER BY COALESCE(applied_at, first_seen_at) DESC`)
      .all()
      .map((r) => toRow(r as Record<string, unknown>));
  }

  /** Records an application you made outside the tool (another portal, a referral, email). */
  addManualApplication(a: { company: string; title: string; url?: string; location?: string; appliedAt?: string; notes?: string }): number {
    const ts = now();
    const external = `manual:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const res = this.db
      .prepare(
        `INSERT INTO jobs (external_id, platform, title, company, location, url, description, fingerprint, status,
                           first_seen_at, last_seen_at, applied_at, notes)
         VALUES (?, 'manual', ?, ?, ?, ?, '', ?, 'APPLIED', ?, ?, ?, ?)`,
      )
      .run(external, a.title, a.company, a.location ?? '', a.url || external, `${fingerprint(a.company, a.title, a.location ?? '')}|${external}`, ts, ts, a.appliedAt ?? ts, a.notes ?? null);
    const id = Number(res.lastInsertRowid);
    this.recordApplied(id);
    return id;
  }

  // ---------------------------------------------------------------- batch prefill

  /**
   * The next jobs to prefill: ready to apply, not open or awaiting your "did you apply?" answer,
   * and not failed in the last day. Fully supported sites first, then by score.
   */
  batchCandidates(limit: number, exclude: number[] = []): JobRow[] {
    const skip = exclude.length ? `AND j.id NOT IN (${exclude.map(() => '?').join(',')})` : '';
    return this.db
      .prepare(
        `SELECT j.* FROM jobs j
         WHERE j.status = 'STAGED' ${skip}
           AND NOT EXISTS (
             SELECT 1 FROM apply_attempts a WHERE a.job_id = j.id
               AND (a.finished_at IS NULL OR a.outcome = 'closed_unconfirmed'
                    OR (a.outcome = 'failed' AND a.started_at > ?)))
         ORDER BY CASE j.platform WHEN 'greenhouse' THEN 0 WHEN 'lever' THEN 0 WHEN 'ashby' THEN 1 ELSE 2 END,
                  j.match_score DESC, j.id
         LIMIT ?`,
      )
      .all(...exclude, new Date(Date.now() - 86_400_000).toISOString(), limit)
      .map((r) => toRow(r as Record<string, unknown>));
  }

  /** Attempts left open by a dashboard that stopped: their tabs are gone, so ask whether you applied. */
  closeStaleAttempts(): number {
    return Number(
      this.db.prepare(`UPDATE apply_attempts SET finished_at = ?, outcome = 'closed_unconfirmed' WHERE finished_at IS NULL`).run(now()).changes,
    );
  }

  /** Jobs whose prefilled tab was closed without a detected submission. */
  pendingConfirmations(): JobRow[] {
    return this.db
      .prepare(
        `SELECT j.* FROM jobs j
         JOIN apply_attempts a ON a.id = (SELECT MAX(id) FROM apply_attempts WHERE job_id = j.id)
         WHERE j.status = 'STAGED' AND a.outcome = 'closed_unconfirmed'
         ORDER BY a.finished_at DESC`,
      )
      .all()
      .map((r) => toRow(r as Record<string, unknown>));
  }

  setLatestAttemptOutcome(jobId: number, outcome: string): void {
    this.db
      .prepare('UPDATE apply_attempts SET outcome = ? WHERE id = (SELECT MAX(id) FROM apply_attempts WHERE job_id = ?)')
      .run(outcome, jobId);
  }

  get(id: number): JobRow | undefined {
    const r = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    return r ? toRow(r as Record<string, unknown>) : undefined;
  }

  /** Jobs that passed the filters and still need a score. With rescore, also previously scored ones. */
  pendingScoring(limit: number, rescore = false): JobRow[] {
    // Jobs you rejected yourself ('user') are never re-scored back into the queue.
    const where = rescore
      ? `status IN ('DISCOVERED','STAGED') OR (status = 'REJECTED' AND reject_stage = 'score')`
      : `status = 'DISCOVERED'`;
    return this.db
      .prepare(`SELECT * FROM jobs WHERE ${where} ORDER BY COALESCE(posted_at, first_seen_at) DESC LIMIT ?`)
      .all(limit)
      .map((r) => toRow(r as Record<string, unknown>));
  }

  list(statuses: JobStatus[] = [], limit = 1000): JobRow[] {
    const where = statuses.length ? `WHERE status IN (${statuses.map(() => '?').join(',')})` : '';
    return this.db
      .prepare(`SELECT * FROM jobs ${where} ORDER BY match_score DESC NULLS LAST, first_seen_at DESC LIMIT ?`)
      .all(...statuses, limit)
      .map((r) => toRow(r as Record<string, unknown>));
  }

  counts(): Record<JobStatus, number> {
    const out = { DISCOVERED: 0, REJECTED: 0, STAGED: 0, APPLIED: 0, FAILED: 0 } as Record<JobStatus, number>;
    for (const r of this.db.prepare('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status').all() as {
      status: JobStatus;
      n: number;
    }[]) {
      out[r.status] = Number(r.n);
    }
    return out;
  }

  /** Edits the fields the dashboard lets you change. */
  updateJob(id: number, patch: { short_pitch?: string; notes?: string }): void {
    if (patch.short_pitch !== undefined) this.db.prepare('UPDATE jobs SET short_pitch = ? WHERE id = ?').run(patch.short_pitch, id);
    if (patch.notes !== undefined) this.db.prepare('UPDATE jobs SET notes = ? WHERE id = ?').run(patch.notes, id);
  }

  startAttempt(jobId: number, url: string): number {
    return Number(
      this.db.prepare('INSERT INTO apply_attempts (job_id, url, started_at) VALUES (?, ?, ?)').run(jobId, url, now()).lastInsertRowid,
    );
  }

  finishAttempt(id: number, outcome: string, details: object): void {
    this.db
      .prepare('UPDATE apply_attempts SET finished_at = ?, outcome = ?, details = ? WHERE id = ?')
      .run(now(), outcome, JSON.stringify(details), id);
  }

  attempts(jobId: number): { id: number; started_at: string; finished_at: string | null; outcome: string | null }[] {
    return this.db
      .prepare('SELECT id, started_at, finished_at, outcome FROM apply_attempts WHERE job_id = ? ORDER BY id DESC')
      .all(jobId) as { id: number; started_at: string; finished_at: string | null; outcome: string | null }[];
  }

  lastRun(): { started_at: string; finished_at: string | null; stats: string } | undefined {
    return this.db.prepare('SELECT started_at, finished_at, stats FROM runs ORDER BY id DESC LIMIT 1').get() as
      | { started_at: string; finished_at: string | null; stats: string }
      | undefined;
  }

  startRun(): number {
    return Number(this.db.prepare('INSERT INTO runs (started_at) VALUES (?)').run(now()).lastInsertRowid);
  }

  finishRun(id: number, stats: object): void {
    this.db.prepare('UPDATE runs SET finished_at = ?, stats = ? WHERE id = ?').run(now(), JSON.stringify(stats), id);
  }

  close(): void {
    this.db.close();
  }
}
