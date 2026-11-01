import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { JobStore } from '../src/db.js';
import { scoreWithRules } from '../src/engine/matcher.js';
import { emptyStats, writeReport } from '../src/engine/reporter.js';
import { facts, job, profile } from './helpers.js';

describe('JobStore', () => {
  it('dedupes by platform id, by URL, and across sources by fingerprint', () => {
    const store = new JobStore(':memory:');
    const first = store.upsertDiscovered(job());
    expect(first.kind).toBe('new');
    expect(store.upsertDiscovered(job()).kind).toBe('seen');
    expect(store.upsertDiscovered(job({ externalId: 'other' })).kind).toBe('seen'); // same URL
    const twin = store.upsertDiscovered(job({ platform: 'himalayas', externalId: 'h1', url: 'https://other.example/1' }));
    expect(twin).toEqual({ kind: 'duplicate', id: first.id });
    expect(store.counts().DISCOVERED).toBe(1);
  });

  it('moves jobs through statuses and records the applied date', () => {
    const store = new JobStore(':memory:');
    const { id } = store.upsertDiscovered(job());
    const m = scoreWithRules(store.get(id)!, { profile, facts, threshold: 75, maxRequiredYears: 3 });
    expect(store.saveMatch(id, m, 75)).toBe('STAGED');
    expect(store.pendingScoring(10)).toHaveLength(0);
    expect(store.pendingScoring(10, true)).toHaveLength(1);

    store.setStatus(id, 'APPLIED', 'via careers page');
    const row = store.get(id)!;
    expect(row.status).toBe('APPLIED');
    expect(row.applied_at).not.toBeNull();
    expect(row.notes).toBe('via careers page');
    expect(row.tailored_answers.length).toBeGreaterThan(0);
  });

  it('reopens filter rejections', () => {
    const store = new JobStore(':memory:');
    const { id } = store.upsertDiscovered(job());
    store.reject(id, 'filter', 'location: test');
    store.reopen(id);
    expect(store.get(id)).toMatchObject({ status: 'DISCOVERED', reject_reason: null });
  });
});

describe('application tracker', () => {
  it('starts the pipeline on apply and moves stages with events', () => {
    const store = new JobStore(':memory:');
    const { id } = store.upsertDiscovered(job());
    store.setStatus(id, 'APPLIED');
    store.setStatus(id, 'APPLIED'); // idempotent: one "applied" event
    expect(store.get(id)!.pipeline_stage).toBe('applied');
    // Dates relative to now, so the test doesn't depend on today's date.
    const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
    store.addEvent(id, 'screening', inDays(3), 'HR call');
    store.addEvent(id, 'follow_up', inDays(6));
    expect(store.get(id)!.pipeline_stage).toBe('screening'); // follow-ups don't change the stage
    const interview = store.addEvent(id, 'interview', inDays(40), 'Round 1');
    expect(store.get(id)!.pipeline_stage).toBe('interview');
    expect(store.events(id).map((e) => e.type)).toEqual(['applied', 'screening', 'follow_up', 'interview']);
    expect(store.eventsBetween(inDays(30), inDays(60)).map((e) => [e.type, e.company])).toEqual([['interview', 'Acme']]);
    store.deleteEvent(interview);
    expect(store.events(id)).toHaveLength(3);
  });

  it('adds applications made outside the tool', () => {
    const store = new JobStore(':memory:');
    const id = store.addManualApplication({ company: 'Zeta', title: 'SDET', appliedAt: '2026-10-20T06:30:00.000Z' });
    const app = store.applications().find((a) => a.id === id)!;
    expect(app).toMatchObject({ platform: 'manual', status: 'APPLIED', pipeline_stage: 'applied', applied_at: '2026-10-20T06:30:00.000Z' });
    expect(store.events(id)[0]).toMatchObject({ type: 'applied', at: '2026-10-20T06:30:00.000Z' });
    // Two manual entries for the same role don't collide.
    store.addManualApplication({ company: 'Zeta', title: 'SDET' });
    expect(store.applications()).toHaveLength(2);
  });

  it('upgrades a database created before the tracker existed', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'jaa-db-')), 'old.db');
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL, platform TEXT NOT NULL, title TEXT NOT NULL,
      company TEXT NOT NULL, location TEXT NOT NULL DEFAULT '', url TEXT NOT NULL, apply_url TEXT, description TEXT NOT NULL DEFAULT '',
      posted_at TEXT, workplace TEXT, salary TEXT, fingerprint TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'DISCOVERED', reject_stage TEXT,
      reject_reason TEXT, match_score INTEGER, match_reason TEXT, matched_skills TEXT NOT NULL DEFAULT '[]', missing_skills TEXT NOT NULL DEFAULT '[]',
      tailored_answers TEXT NOT NULL DEFAULT '[]', short_pitch TEXT, scorer TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
      scored_at TEXT, applied_at TEXT, notes TEXT, UNIQUE (platform, external_id))`);
    old.close();
    const store = new JobStore(file);
    const { id } = store.upsertDiscovered(job());
    store.setStatus(id, 'APPLIED');
    expect(store.get(id)).toMatchObject({ pipeline_stage: 'applied', seniority_hints: [] });
    store.close();
  });
});

describe('batch selection', () => {
  it('picks fully supported sites first, then score, and skips open or unconfirmed attempts', () => {
    const store = new JobStore(':memory:');
    const stage = (platform: string, score: number, n: number) => {
      const { id } = store.upsertDiscovered(job({ platform, externalId: `x${n}`, url: `https://e.com/${n}`, title: `QA ${n}` }));
      store.saveMatch(id, { ...scoreWithRules(store.get(id)!, { profile, facts, threshold: 0, maxRequiredYears: 3 }), matchScore: score, isQualified: true }, 0);
      return id;
    };
    const feed = stage('himalayas', 97, 1);
    const gh = stage('greenhouse', 80, 2);
    const lever = stage('lever', 85, 3);
    const ashby = stage('ashby', 90, 4);
    expect(store.batchCandidates(10).map((j) => j.id)).toEqual([lever, gh, ashby, feed]);

    store.startAttempt(lever, 'u'); // open tab
    const a = store.startAttempt(gh, 'u');
    store.finishAttempt(a, 'closed_unconfirmed', {});
    expect(store.batchCandidates(10).map((j) => j.id)).toEqual([ashby, feed]);
    expect(store.pendingConfirmations().map((j) => j.id)).toEqual([gh]);

    expect(store.closeStaleAttempts()).toBe(1); // the open one, e.g. after a restart
    expect(store.pendingConfirmations().map((j) => j.id).sort()).toEqual([gh, lever].sort());
    store.setLatestAttemptOutcome(gh, 'skipped');
    expect(store.batchCandidates(10).map((j) => j.id)).toEqual([gh, ashby, feed]);
  });
});

describe('reporter', () => {
  it('writes markdown, JSON and CSV with the staged jobs', () => {
    const store = new JobStore(':memory:');
    const { id } = store.upsertDiscovered(job());
    store.saveMatch(id, scoreWithRules(store.get(id)!, { profile, facts, threshold: 75, maxRequiredYears: 3 }), 75);

    const dir = mkdtempSync(path.join(tmpdir(), 'jobapplyai-'));
    const files = writeReport(store, { ...emptyStats(), fetched: 1, new: 1, scored: 1, staged: 1 }, facts, new Date(2026, 9, 21, 9, 5), dir);

    expect(path.basename(files.markdown)).toBe('report_2026-10-21_0905.md');
    const md = readFileSync(files.markdown, 'utf8');
    expect(md).toContain('## Ready to apply (1)');
    expect(md).toContain('| Acme | QA Automation Engineer |');
    expect(md).toContain('mark <ID> applied');
    const json = JSON.parse(readFileSync(files.json, 'utf8'));
    expect(json.jobs[0]).toMatchObject({ company: 'Acme', status: 'STAGED' });
    expect(json.jobs[0].description).toBeUndefined();
    expect(readFileSync(files.csv, 'utf8').split('\n')).toHaveLength(2);
  });
});
