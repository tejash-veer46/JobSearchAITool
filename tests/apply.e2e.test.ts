// Drives a real (headless) Chrome against local fixture forms. Skipped when Chrome is not installed.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrowserContext, Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchBrowser } from '../src/apply/browser.js';
import { ApplyManager } from '../src/apply/manager.js';
import { ApplySession } from '../src/apply/session.js';
import { env } from '../src/config.js';
import { JobStore } from '../src/db.js';
import { startDashboard } from '../src/web/server.js';
import { facts, job, profile } from './helpers.js';

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/Applications/Google Chrome.app', '/usr/bin/google-chrome'].some(existsSync);
const fixture = (name: string) => pathToFileURL(path.join(import.meta.dirname, 'fixtures', name)).href;

const scoreStub = { matchScore: 80, isQualified: true, matchedSkills: [], missingSkills: [], experienceRequired: null, reason: 'test', tailoredAnswers: [], shortPitch: '', scorer: 'rules' as const };
const me = { ...profile, name: 'Asha Verma', contact: { ...profile.contact, phone: '+91 90000 00000', linkedin: 'https://linkedin.com/in/asha' } };

describe.skipIf(!CHROME)('apply assistant (headless Chrome, local fixtures)', () => {
  let browser: BrowserContext;
  let dir: string;
  let resumeFile: string;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'jobapplyai-e2e-'));
    resumeFile = path.join(dir, 'Asha_Verma_Resume.pdf');
    writeFileSync(resumeFile, '%PDF-1.4 test resume');
    browser = await launchBrowser({ headless: true, userDataDir: path.join(dir, 'profile') });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function setup(fixtureName: string, opts: { dryRun?: boolean } = {}) {
    const store = new JobStore(':memory:');
    const { id } = store.upsertDiscovered(job({ platform: 'fixture', externalId: fixtureName, url: fixture(fixtureName), applyUrl: fixture(fixtureName) }));
    store.setStatus(id, 'STAGED');
    const saved: [string, string][] = [];
    const session = new ApplySession(store.get(id)!, {
      store,
      profile: me,
      facts: structuredClone(facts),
      resumeFile,
      browser: async () => browser,
      dryRun: opts.dryRun,
      saveAnswer: (q, a) => saved.push([q, a]),
    });
    return { store, id, session, saved };
  }

  const field = (s: ApplySession, label: RegExp) => {
    const f = s.snapshot().fields.find((x) => label.test(x.label));
    if (!f) throw new Error(`no field ${label} in ${s.snapshot().fields.map((x) => x.label).join(' | ')}`);
    return f;
  };
  const page = (s: ApplySession) => (s as unknown as { page: Page }).page;
  async function waitFor(s: ApplySession, state: string, ms = 20_000) {
    const until = Date.now() + ms;
    while (s.state !== state && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
    expect(s.state).toBe(state);
  }

  it('fills a Greenhouse-style form, waits for the user, then submits on confirmation', async () => {
    const { session: s, store, id, saved } = setup('greenhouse-like.html');
    await s.start();

    expect(s.state).toBe('needs_input');
    expect(field(s, /^First Name/).value).toBe('Asha');
    expect(field(s, /^Last Name/).value).toBe('Verma');
    expect(field(s, /^Country/)).toMatchObject({ value: 'India', status: 'filled' });
    expect(field(s, /years of professional experience/)).toMatchObject({ value: '1.5', status: 'filled' }); // never rounded up from 1.8
    expect(field(s, /salary expectations/).value).toBe('1200000 INR per annum (12 LPA)');
    expect(field(s, /^Gender/)).toMatchObject({ value: 'Decline to self identify', source: 'policy' });
    expect(field(s, /Resume/)).toMatchObject({ value: 'Asha_Verma_Resume.pdf', status: 'filled' });
    // Not backed by a fact: left for the user.
    expect(field(s, /Bangalore office/)).toMatchObject({ status: 'empty', required: true });
    expect(field(s, /privacy policy/)).toMatchObject({ status: 'empty', note: 'Tick this yourself if you agree' });

    // Submitting before the required answers is refused.
    await expect(s.submit()).rejects.toThrow(/required fields/);

    await s.answer(field(s, /Bangalore office/).key, 'Yes', true);
    expect(saved).toEqual([['Are you able to work from our Bangalore office at least three days a week?', 'Yes']]);
    await s.answer(field(s, /privacy policy/).key, 'Yes');
    expect(s.state).toBe('ready');
    expect(store.get(id)!.status).toBe('STAGED'); // nothing sent yet

    await s.submit();
    await waitFor(s, 'submitted');
    expect(store.get(id)!.status).toBe('APPLIED');
    expect(store.attempts(id)[0]!.outcome).toBe('submitted');
    const sent = await page(s).evaluate(() => (window as unknown as { __submitted: unknown }).__submitted);
    expect(sent).toMatchObject({ first: 'Asha', country: 'India', years: '1.5', office: 'Yes', resume: 'Asha_Verma_Resume.pdf', gender: 'Decline to self identify' });
    await s.close();
  }, 60_000);

  it('dry run fills but can never submit', async () => {
    const { session: s, store, id } = setup('greenhouse-like.html', { dryRun: true });
    await s.start();
    await expect(s.submit()).rejects.toThrow(/Dry run/);
    await s.close();
    expect(store.get(id)!.status).toBe('STAGED');
    expect(store.attempts(id)[0]!.outcome).toBe('dry_run');
  }, 60_000);

  it('fills a Lever-style form and pauses on a CAPTCHA until it is solved', async () => {
    const { session: s, store, id } = setup('lever-like.html');
    await s.start();

    expect(field(s, /^Resume/)).toMatchObject({ value: 'Asha_Verma_Resume.pdf', status: 'filled' }); // hidden, tabindex -1
    expect(field(s, /^Full name/).value).toBe('Asha Verma');
    expect(field(s, /^Current company/).value).toBe('Acme QA');
    expect(field(s, /^Gender/)).toMatchObject({ kind: 'radio', value: 'Prefer not to disclose' });
    expect(field(s, /Total Years/).value).toBe('1.8');
    expect(field(s, /Expected Compensation/).value).toBe('1200000');
    expect(field(s, /Notice Period/).value).toBe('60');
    expect(field(s, /Current Compensation/)).toMatchObject({ status: 'empty', note: 'Not in config/profile.yaml' });
    expect(field(s, /Naukri/).status).toBe('empty');

    await s.answer(field(s, /Current Compensation/).key, '700000');
    await s.answer(field(s, /How did you get to know/).key, 'Company Job Site');
    expect(s.state).toBe('ready');

    await s.submit();
    await waitFor(s, 'captcha', 10_000);
    await waitFor(s, 'submitted', 15_000);
    expect(store.get(id)!.status).toBe('APPLIED');
    await s.close();
  }, 60_000);

  it.skipIf(!existsSync(env.resumePath))('runs the whole flow through the dashboard API', async () => {
    const store = new JobStore(':memory:');
    const { id } = store.upsertDiscovered(job({ platform: 'fixture', externalId: 'gh', url: fixture('greenhouse-like.html'), applyUrl: fixture('greenhouse-like.html') }));
    store.setStatus(id, 'STAGED');
    const dash = await startDashboard(store, { port: 0, manager: new ApplyManager(store, async () => browser) });
    const call = async (path: string, body?: unknown) => {
      const res = await fetch(dash.url + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-jobapplyai': '1' }, body: JSON.stringify(body) });
      return res.json();
    };
    try {
      await call(`/api/jobs/${id}/apply`, {});
      let snap = await call(`/api/jobs/${id}/apply`);
      for (let i = 0; i < 100 && ['starting', 'filling'].includes(snap.state); i++) {
        await new Promise((r) => setTimeout(r, 200));
        snap = await call(`/api/jobs/${id}/apply`);
      }
      expect(snap.state).toBe('needs_input');
      const key = (re: RegExp) => snap.fields.find((f: { label: string }) => re.test(f.label)).key;
      for (const [re, value] of [[/Bangalore office/, 'Yes'], [/privacy policy/, 'Yes'], [/^Phone/, '+91 90000 00000']] as const) {
        snap = await call(`/api/jobs/${id}/apply/answer`, { key: key(re), value });
      }
      expect(snap.state).toBe('ready');
      expect((await call(`/api/jobs/${id}/apply/submit`, {})).error).toMatch(/confirm/);
      await call(`/api/jobs/${id}/apply/submit`, { confirm: true });
      for (let i = 0; i < 50 && store.get(id)!.status !== 'APPLIED'; i++) await new Promise((r) => setTimeout(r, 200));
      expect(store.get(id)!.status).toBe('APPLIED');
    } finally {
      await dash.close();
    }
  }, 60_000);

  // The manager loads your real resume and profile.yaml, so this needs the resume to be present.
  it.skipIf(!existsSync(env.resumePath))('prefills a batch of tabs, follows "Apply" links, never submits, and records your own submissions', async () => {
    const store = new JobStore(':memory:');
    const add = (name: string, platform: string, score: number) => {
      const { id } = store.upsertDiscovered(job({ platform, externalId: `${name}:${score}`, title: `QA ${score}`, url: `${fixture(name)}?${score}`, applyUrl: `${fixture(name)}?${score}` }));
      store.setStatus(id, 'STAGED');
      store.saveMatch(id, { ...scoreStub, matchScore: score }, 75);
      return id;
    };
    const feedJob = add('job-page.html', 'adzuna', 90); // a feed whose link leads to the company site
    const formJob = add('greenhouse-like.html', 'fixture', 80);
    const third = add('lever-like.html', 'fixture', 78);
    const manager = new ApplyManager(store, async () => browser);

    const batch = manager.startBatch(2, { concurrency: 2 });
    expect(batch.jobIds).toEqual([feedJob, formJob]); // best two by score; the third waits for the next batch
    for (let i = 0; i < 150 && manager.batch!.filling; i++) await new Promise((r) => setTimeout(r, 200));
    const status = manager.batchStatus()!;
    expect(status.items.map((i) => i.state)).toEqual(['needs_input', 'needs_input']);

    // The feed posting was followed to the real form in a new tab.
    const feed = manager.get(feedJob)!;
    expect(feed.snapshot().fields.find((f) => /^First Name/.test(f.label))).toMatchObject({ status: 'filled', source: 'profile' });
    await expect(feed.submit()).rejects.toThrow(/yourself/);

    // You finish the form in the tab and press the site's Submit button.
    const p = page(feed);
    await p.locator('#q2').click();
    await p.locator('#q2-listbox [role=option]', { hasText: 'Yes' }).click();
    await p.locator('input[name=consent]').check();
    await p.locator('button[type=submit]').click();
    for (let i = 0; i < 50 && store.get(feedJob)!.status !== 'APPLIED'; i++) await new Promise((r) => setTimeout(r, 200));
    expect(store.get(feedJob)!.status).toBe('APPLIED');
    expect(store.get(feedJob)!.pipeline_stage).toBe('applied');
    expect(store.events(feedJob).map((e) => e.type)).toEqual(['applied']);

    // Closing a tab without submitting asks "did you apply?" instead of re-filling it.
    await page(manager.get(formJob)!).close();
    await new Promise((r) => setTimeout(r, 300));
    expect(store.pendingConfirmations().map((j) => j.id)).toEqual([formJob]);
    expect(store.batchCandidates(20).map((j) => j.id)).toEqual([third]);
    await manager.closeAll();
  }, 90_000);

  // Regression: parallel fills on a freshly launched Chrome all grabbed its single empty tab and
  // aborted each other's navigation, so only the last job of a batch ended up filled.
  it.skipIf(!existsSync(env.resumePath))('fills every job of a batch in its own tab on a freshly launched browser', async () => {
    const fresh = await launchBrowser({ headless: true, userDataDir: path.join(dir, `fresh-${Date.now()}`) });
    try {
      const store = new JobStore(':memory:');
      const ids = ['greenhouse-like.html', 'lever-like.html', 'greenhouse-like.html'].map((name, n) => {
        const { id } = store.upsertDiscovered(job({ platform: 'fixture', externalId: `fresh${n}`, title: `QA ${n}`, url: `${fixture(name)}?fresh=${n}`, applyUrl: `${fixture(name)}?fresh=${n}` }));
        store.setStatus(id, 'STAGED');
        return id;
      });
      const manager = new ApplyManager(store, async () => fresh);
      manager.startBatch(3, { concurrency: 3 });
      for (let i = 0; i < 150 && manager.batch!.filling; i++) await new Promise((r) => setTimeout(r, 200));

      const states = manager.batchStatus()!.items.map((i) => i.state);
      expect(states.every((s) => s === 'needs_input' || s === 'ready')).toBe(true);
      expect(store.attempts(ids[0]!).concat(store.attempts(ids[1]!), store.attempts(ids[2]!)).every((a) => a.outcome !== 'failed')).toBe(true);
      const urls = fresh.pages().map((p) => p.url()).filter((u) => u.includes('fresh='));
      expect(new Set(urls).size).toBe(3); // three separate tabs, one per job
      await manager.closeAll();
    } finally {
      await fresh.close();
    }
  }, 90_000);

  // Regression: shutting the dashboard down rewrote failed attempts as "closed, did you apply?".
  it('keeps a failed attempt as failed when the session is closed', async () => {
    const store = new JobStore(':memory:');
    const missing = pathToFileURL(path.join(import.meta.dirname, 'fixtures', 'does-not-exist.html')).href;
    const { id } = store.upsertDiscovered(job({ platform: 'fixture', externalId: 'missing', url: missing, applyUrl: missing }));
    store.setStatus(id, 'STAGED');
    const s = new ApplySession(store.get(id)!, { store, profile: me, facts: structuredClone(facts), resumeFile, browser: async () => browser, prefill: true });
    await s.start();
    expect(s.state).toBe('failed');
    await s.close();
    expect(store.attempts(id)[0]!.outcome).toBe('failed');
    expect(store.pendingConfirmations()).toEqual([]);
  }, 60_000);

  it('records an application the user submitted in the browser themselves', async () => {
    const { session: s, store, id } = setup('lever-like.html');
    await s.start();
    s.markSubmittedByUser();
    expect(store.get(id)!.status).toBe('APPLIED');
    expect(store.attempts(id)[0]!.outcome).toBe('submitted_by_user');
    await s.close();
  }, 60_000);
});
