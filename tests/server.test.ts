import { request } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobStore } from '../src/db.js';
import { startDashboard } from '../src/web/server.js';
import { job } from './helpers.js';

describe('dashboard API', () => {
  const store = new JobStore(':memory:');
  let url: string;
  let close: () => Promise<void>;
  const ran: string[] = [];

  beforeAll(async () => {
    const a = store.upsertDiscovered(job());
    store.setStatus(a.id, 'STAGED');
    store.upsertDiscovered(job({ externalId: 'acme:2', url: 'https://example.com/jobs/2', title: 'SDET II' }));
    const d = await startDashboard(store, {
      port: 0,
      runJobs: async (log) => {
        ran.push('run');
        log('fetched 3 postings');
      },
    });
    url = d.url;
    close = d.close;
  });
  afterAll(() => close());

  const post = (path: string, body: unknown, headers: Record<string, string> = { 'x-jobapplyai': '1' }) =>
    fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  it('serves the app and lists jobs by view', async () => {
    expect((await fetch(url)).headers.get('content-type')).toContain('text/html');
    const ready = await (await fetch(`${url}/api/jobs?view=ready`)).json();
    expect(ready.map((j: { title: string }) => j.title)).toEqual(['QA Automation Engineer']);
    const all = await (await fetch(`${url}/api/jobs?view=all&q=sdet`)).json();
    expect(all).toHaveLength(1);
    const detail = await (await fetch(`${url}/api/jobs/${ready[0].id}`)).json();
    expect(detail).toMatchObject({ title: 'QA Automation Engineer', session: null, attempts: [] });
  });

  it('blocks writes without the app header or from another origin', async () => {
    const patch = (headers: Record<string, string>) =>
      fetch(`${url}/api/jobs/1`, { method: 'PATCH', headers: { 'content-type': 'application/json', ...headers }, body: '{"status":"APPLIED"}' });
    expect((await patch({})).status).toBe(403);
    expect((await patch({ 'x-jobapplyai': '1', origin: 'https://evil.example' })).status).toBe(403);
    expect(store.get(1)!.status).toBe('STAGED');
  });

  it('blocks requests for a different host name (DNS rebinding)', async () => {
    const { port } = new URL(url);
    const status = await new Promise<number>((resolve) => {
      request({ host: '127.0.0.1', port, path: '/api/jobs', headers: { host: `evil.example:${port}` } }, (res) => resolve(res.statusCode ?? 0)).end();
    });
    expect(status).toBe(403);
  });

  it('updates status, notes and pitch; user rejections are not re-scored', async () => {
    const res = await fetch(`${url}/api/jobs/1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-jobapplyai': '1' },
      body: JSON.stringify({ notes: 'Referral from Priya', short_pitch: 'Hello', status: 'REJECTED' }),
    });
    expect(await res.json()).toMatchObject({ status: 'REJECTED', reject_stage: 'user', notes: 'Referral from Priya', short_pitch: 'Hello' });
    expect(store.pendingScoring(10, true).map((j) => j.id)).not.toContain(1);
  });

  it('refuses to submit without explicit confirmation', async () => {
    expect((await post('/api/jobs/1/apply/submit', {})).status).toBe(400);
    expect((await post('/api/jobs/1/apply/submit', { confirm: true })).status).toBe(404); // no session open
  });

  it('tracks applications: manual add, events, stage, calendar and stats', async () => {
    const add = await (await post('/api/applications', { company: 'Zeta', title: 'SDET', appliedAt: '2026-10-01T06:30:00.000Z' })).json();
    expect(add).toMatchObject({ platform: 'manual', status: 'APPLIED' });
    expect((await post('/api/applications', { company: '' })).status).toBe(400);

    const events = await (await post(`/api/jobs/${add.id}/events`, { type: 'interview', at: '2026-10-30T09:00:00.000Z', note: 'Round 1' })).json();
    expect(events.map((e: { type: string }) => e.type)).toEqual(['applied', 'interview']);
    expect((await post(`/api/jobs/${add.id}/events`, { type: 'party' })).status).toBe(400);

    const cal = await (await fetch(`${url}/api/calendar?from=2026-10-01T00:00:00.000Z&to=2026-11-01T00:00:00.000Z`)).json();
    expect(cal.map((e: { type: string; company: string }) => `${e.type}:${e.company}`)).toEqual(['applied:Zeta', 'interview:Zeta']);

    await fetch(`${url}/api/jobs/${add.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-jobapplyai': '1' }, body: JSON.stringify({ pipeline_stage: 'offer' }) });
    const t = await (await fetch(`${url}/api/tracker`)).json();
    expect(t.stats).toMatchObject({ total: 1, offers: 1, interviews: 1, responseRate: 100 });
    expect(t.applications[0]).toMatchObject({ company: 'Zeta', stage: 'offer' });
  });

  it('answers "did you apply?" for closed prefilled tabs', async () => {
    const { id } = store.upsertDiscovered(job({ externalId: 'acme:9', url: 'https://example.com/jobs/9', title: 'QA Analyst' }));
    store.setStatus(id, 'STAGED');
    store.finishAttempt(store.startAttempt(id, 'u'), 'closed_unconfirmed', {});
    const list = await (await fetch(`${url}/api/confirmations`)).json();
    expect(list.map((j: { id: number }) => j.id)).toContain(id);
    expect((await post(`/api/jobs/${id}/confirm`, { answer: 'maybe' })).status).toBe(400);
    expect(await (await post(`/api/jobs/${id}/confirm`, { answer: 'applied' })).json()).toMatchObject({ status: 'APPLIED', pipeline_stage: 'applied' });
    expect(await (await fetch(`${url}/api/confirmations`)).json()).not.toContainEqual(expect.objectContaining({ id }));
  });

  it('opens bot-protected feed jobs in your own browser instead of prefilling them', async () => {
    const own = new JobStore(':memory:');
    const { id } = own.upsertDiscovered(job({ platform: 'himalayas', externalId: 'h1', url: 'https://himalayas.app/companies/x/jobs/qa' }));
    own.setStatus(id, 'STAGED');
    const opened: string[] = [];
    const d = await startDashboard(own, { port: 0, openInBrowser: (u) => opened.push(u) });
    try {
      const call = (path: string) => fetch(d.url + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-jobapplyai': '1' }, body: '{}' }).then((r) => r.json());
      const batch = await call('/api/batch');
      expect(batch).toMatchObject({ filling: false, items: [{ id, state: 'manual' }] });
      expect(await call('/api/batch/open-manual')).toEqual({ opened: 1 });
      expect(opened).toEqual(['https://himalayas.app/companies/x/jobs/qa']);
      expect(own.pendingConfirmations().map((j) => j.id)).toEqual([id]);
      expect(own.batchCandidates(20)).toEqual([]); // waits for your "did you apply?" answer
    } finally {
      await d.close();
    }
  });

  it('runs the job fetch in the background and reports its log', async () => {
    expect((await post('/api/run', {})).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    const run = await (await fetch(`${url}/api/run`)).json();
    expect(run).toMatchObject({ running: false, log: ['fetched 3 postings'], error: null });
    expect(ran).toEqual(['run']);
  });
});
