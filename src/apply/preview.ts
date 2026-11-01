// Read-only: shows which answer the assistant would use for each field. Fills and submits nothing.
import { chromium } from 'playwright-core';
import { env, loadProfileFacts } from '../config.js';
import type { JobRow } from '../db.js';
import { findResumeFile, loadProfile } from '../engine/resume.js';
import { type Answer, resolveLocally } from './answers.js';
import { findFormFrame, type FormField, readFields } from './fields.js';
import { applyUrl, waitForForm } from './session.js';

export async function previewForm(job: JobRow): Promise<{ url: string; rows: { field: FormField; answer: Answer }[] }> {
  const url = applyUrl(job);
  const ctx = { profile: await loadProfile(), facts: loadProfileFacts(), job, resumeFile: findResumeFile() };
  const browser = await chromium.launch({ channel: env.browserChannel === 'chromium' ? undefined : env.browserChannel, headless: true });
  try {
    const page = await browser.newPage();
    await page.addInitScript({ content: 'globalThis.__name ??= (f) => f;' });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await waitForForm(page);
    const fields = await readFields(await findFormFrame(page.frames()));
    return { url, rows: fields.map((field) => ({ field, answer: resolveLocally(field, ctx) })) };
  } finally {
    await browser.close();
  }
}
