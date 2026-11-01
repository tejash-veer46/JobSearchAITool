// One application in progress: open the form, fill what is known, wait for the user,
// and submit only on an explicit confirmation. CAPTCHAs and login checks pause for the user.
import type { BrowserContext, Frame, Page } from 'playwright-core';
import { type ProfileFacts, saveAnswer } from '../config.js';
import type { JobRow, JobStore } from '../db.js';
import type { CandidateProfile } from '../types.js';
import { type Answer, type AnswerContext, resolveAll } from './answers.js';
import { takePage } from './browser.js';
import { fillField } from './fill.js';
import { findFormFrame, type FormField, readFields } from './fields.js';

export type ApplyState =
  | 'starting'
  | 'filling'
  | 'needs_input'
  | 'ready'
  | 'captcha'
  | 'submitting'
  | 'submitted'
  | 'failed'
  | 'closed';

export interface FieldState {
  field: FormField;
  answer: Answer;
  status: 'filled' | 'empty' | 'error';
  error?: string;
}

export interface ApplyDeps {
  store: JobStore;
  profile: CandidateProfile;
  facts: ProfileFacts;
  resumeFile: string;
  browser: () => Promise<BrowserContext>;
  dryRun?: boolean;
  /**
   * Batch prefill: fill the tab and leave it for you to submit. The assistant never submits,
   * but still notices when you do and marks the job applied.
   */
  prefill?: boolean;
  /** Open the tab without bringing it to the front (batch prefill). */
  background?: boolean;
  /** Saves "remember this answer" choices; defaults to config/profile.yaml. */
  saveAnswer?: (question: string, answer: string) => void;
  onChange?: (s: ApplySession) => void;
}

/** Where the application form lives for each source. */
export function applyUrl(job: Pick<JobRow, 'platform' | 'external_id' | 'url' | 'apply_url'>): string {
  if (job.platform === 'greenhouse') {
    const [slug, id] = job.external_id.split(':');
    return `https://job-boards.greenhouse.io/embed/job_app?for=${encodeURIComponent(slug!)}&token=${encodeURIComponent(id!)}`;
  }
  if (job.platform === 'lever') return job.apply_url ?? `${job.url.replace(/\/$/, '')}/apply`;
  return job.apply_url ?? job.url;
}

/** Greenhouse and Lever forms are fully supported; other sites get a best-effort fill. */
export const fullySupported = (platform: string) => platform === 'greenhouse' || platform === 'lever';

const SUCCESS_TEXT =
  /thank you for (applying|your application|submitting)|application (has been |was )?(successfully )?(submitted|received|sent)|we('|’)ve received your application|successfully (submitted|applied)/i;
const CAPTCHA_FRAMES =
  'iframe[src*="hcaptcha.com"][src*="frame=challenge"], iframe[src*="recaptcha"][src*="bframe"], iframe[src*="challenges.cloudflare.com"], iframe[title*="challenge" i]';
const SUBMIT_BUTTON = 'button[type="submit"], input[type="submit"], button:has-text("Submit application"), button:has-text("Submit Application")';

/**
 * Single-page apps (Ashby, many career sites) render the form a few seconds after the page loads.
 * Waits until some frame has a visible text field or dropdown, or the timeout passes.
 */
export async function waitForForm(page: Page, timeoutMs = 12_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  const selector = 'input:not([type=hidden]):not([type=file]):visible, textarea:visible, select:visible, [role="combobox"]:visible';
  while (Date.now() < until && !page.isClosed()) {
    for (const f of page.frames()) {
      if (await f.locator(selector).count().catch(() => 0)) return;
    }
    await page.waitForTimeout(500).catch(() => {});
  }
}

export class ApplySession {
  state: ApplyState = 'starting';
  message = 'Opening the application form...';
  fields: FieldState[] = [];
  readonly url: string;
  readonly log: string[] = [];
  readonly startedAt = new Date().toISOString();
  private page?: Page;
  private frame?: Frame;
  private attemptId?: number;
  private timer?: NodeJS.Timeout;
  private stateBeforeCaptcha?: ApplyState;
  private formUrl = '';
  /** Set once the assistant clicked submit (after the user confirmed). */
  private submitClicked = false;

  constructor(
    readonly job: JobRow,
    private readonly deps: ApplyDeps,
  ) {
    this.url = applyUrl(job);
  }

  get dryRun() {
    return this.deps.dryRun ?? false;
  }

  get prefill() {
    return this.deps.prefill ?? false;
  }

  /** Outcome recorded when the tab goes away without a detected submission. */
  private get closedOutcome() {
    return this.dryRun ? 'dry_run' : this.prefill ? 'closed_unconfirmed' : 'cancelled';
  }

  private watchClose(page: Page) {
    page.on('close', () => {
      if (page === this.page) void this.onPageClosed();
    });
  }

  private ctx(): AnswerContext {
    return { profile: this.deps.profile, facts: this.deps.facts, job: this.job, resumeFile: this.deps.resumeFile };
  }

  private set(state: ApplyState, message: string) {
    this.state = state;
    this.message = message;
    this.note(message);
  }

  private note(line: string) {
    this.log.push(`${new Date().toLocaleTimeString()}  ${line}`);
    if (this.log.length > 200) this.log.shift();
    this.deps.onChange?.(this);
  }

  async start(): Promise<void> {
    this.attemptId = this.deps.store.startAttempt(this.job.id, this.url);
    try {
      const context = await this.deps.browser();
      this.page = await takePage(context);
      this.watchClose(this.page);
      try {
        await this.page.goto(this.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      } catch (err) {
        // One retry for transient failures (aborted navigation, network blip).
        if (!/ERR_ABORTED|ERR_NETWORK|ERR_CONNECTION|ERR_TIMED_OUT|Timeout/i.test((err as Error).message)) throw err;
        this.note('The page did not load; trying once more...');
        await this.page.waitForTimeout(2000);
        await this.page.goto(this.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      }
      await this.page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      if (!this.deps.background) await this.page.bringToFront();
      await this.scan();
      this.timer = setInterval(() => void this.watch(), 1500);
    } catch (err) {
      this.fail(`Could not open the form: ${(err as Error).message}`);
    }
  }

  /** Reads the form on the current page and fills everything that has a known answer. */
  async scan(depth = 0): Promise<void> {
    if (!this.page) return;
    this.set('filling', 'Reading the form...');
    await waitForForm(this.page);
    this.frame = await findFormFrame(this.page.frames());
    const fields = await readFields(this.frame);
    if (!fields.some((f) => f.kind !== 'file')) {
      // Job pages (feeds, career sites) usually have an "Apply" link to the real form: follow it.
      if (depth < 3 && (await this.followApplyLink())) return this.scan(depth + 1);
      this.fields = [];
      this.set('needs_input', 'No application form on this page. Open the form in the browser window (e.g. click "Apply"), then press Rescan.');
      return;
    }
    this.formUrl = this.frame.url();
    this.note(`Found ${fields.length} fields. Working out answers...`);
    const answers = await resolveAll(fields, this.ctx());

    this.fields = [];
    for (const field of fields) {
      const answer = answers.get(field.key) ?? { value: null };
      const fs: FieldState = { field, answer, status: 'empty' };
      this.fields.push(fs);
      // Keep anything already on the page (typed by you, or remembered by the site).
      if (field.currentValue && field.kind !== 'file') {
        fs.status = 'filled';
        fs.answer = { value: field.currentValue, source: 'you', note: 'Already on the page' };
        continue;
      }
      if (answer.value == null) continue;
      try {
        await fillField(this.frame, field, answer.value);
        fs.status = 'filled';
      } catch (err) {
        fs.status = 'error';
        fs.error = (err as Error).message;
      }
    }
    this.refreshState();
  }

  /**
   * Clicks the page's "Apply" link or button and moves to where it leads (same tab or a new one).
   * Returns false when there is none. LinkedIn "Easy Apply" is deliberately not followed.
   */
  private async followApplyLink(): Promise<boolean> {
    const page = this.page;
    if (!page) return false;
    const label = /^\s*(apply|apply now|apply for this (job|position|role)|apply on (the )?(company|employer)('s)? (site|website)|apply here|apply to this job|i'?m interested)\s*[›→>]?\s*$/i;
    for (const frame of page.frames()) {
      const target = frame.locator('a, button, [role="button"], input[type="button"]').filter({ hasText: label }).filter({ visible: true }).first();
      if (!(await target.count().catch(() => 0))) continue;
      this.note(`Following "${(await target.innerText().catch(() => 'Apply')).trim()}" to the application form...`);
      const popup = page.context().waitForEvent('page', { timeout: 6000 }).catch(() => null);
      await target.click({ timeout: 5000 }).catch(() => {});
      const opened = await popup;
      if (opened) {
        // The form opened in a new tab: continue there and close the job page.
        this.page = opened;
        this.watchClose(opened);
        await page.close().catch(() => {});
      }
      const now = opened ?? page;
      await now.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
      await now.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      return true;
    }
    return false;
  }

  /** Shows this application's tab. */
  async focus(): Promise<void> {
    await this.page?.bringToFront();
  }

  private missingRequired(): FieldState[] {
    return this.fields.filter((f) => f.field.required && f.status !== 'filled');
  }

  private refreshState() {
    const missing = this.missingRequired();
    const filled = this.fields.filter((f) => f.status === 'filled').length;
    if (missing.length) {
      this.set('needs_input', `Filled ${filled} of ${this.fields.length} fields. ${missing.length} required field(s) need your answer.`);
    } else {
      this.set(
        'ready',
        this.dryRun
          ? `Dry run: filled ${filled} fields. Nothing will be submitted. Review the browser window.`
          : this.prefill
            ? `Filled (${filled} fields). Review the tab and press the site's Submit button.`
            : `All required fields filled (${filled}). Review everything in the browser window, then submit.`,
      );
    }
  }

  /** The user's answer for one field, optionally remembered for future forms. */
  async answer(key: string, value: string, remember = false): Promise<void> {
    const fs = this.fields.find((f) => f.field.key === key);
    if (!fs || !this.frame) throw new Error(`Unknown field ${key}`);
    try {
      await fillField(this.frame, fs.field, value);
      fs.status = 'filled';
      fs.error = undefined;
      fs.answer = { value, source: 'you' };
    } catch (err) {
      fs.status = 'error';
      fs.error = (err as Error).message;
      this.refreshState();
      throw err;
    }
    if (remember && fs.field.label && fs.field.kind !== 'file') {
      (this.deps.saveAnswer ?? saveAnswer)(fs.field.label, value);
      this.deps.facts.saved_answers.push({ question: fs.field.label, answer: value });
      this.note(`Saved your answer to "${fs.field.label}" for future forms.`);
    }
    this.refreshState();
  }

  /**
   * Clicks the form's submit button. Only ever called after the user explicitly confirms.
   * Never in dry-run mode.
   */
  async submit(): Promise<void> {
    if (this.dryRun) throw new Error('Dry run: submitting is disabled.');
    if (this.prefill) throw new Error('Prefilled tab: submit it yourself in the browser.');
    if (!this.frame || !this.page) throw new Error('No form open.');
    if (this.state === 'submitted') return;
    const missing = this.missingRequired();
    if (missing.length) throw new Error(`Answer the required fields first: ${missing.map((m) => m.field.label).join('; ')}`);

    const button = this.frame.locator(SUBMIT_BUTTON).filter({ visible: true }).last();
    if (!(await button.count())) throw new Error('Could not find the submit button. Submit it yourself in the browser window.');
    this.set('submitting', 'Submitting...');
    this.submitClicked = true;
    await button.click({ timeout: 10_000 });
    // watch() picks up success, CAPTCHAs and validation errors from here.
    setTimeout(() => void this.checkStuckSubmit(), 15_000);
  }

  private async checkStuckSubmit() {
    if (this.state !== 'submitting' || !this.frame) return;
    const errors = await this.frame
      .locator('[aria-invalid="true"], .error:visible, .field-error:visible, [class*="error-message"]:visible')
      .count()
      .catch(() => 0);
    this.set(
      'needs_input',
      errors
        ? 'The form shows errors. Fix them in the browser window (or here), then submit again.'
        : 'No confirmation yet. Check the browser window. If it went through, press "I submitted it".',
    );
  }

  /** The user submitted in the browser themselves. */
  markSubmittedByUser(): void {
    this.finish('submitted_by_user', 'Marked as applied.');
  }

  private finish(outcome: 'submitted' | 'submitted_by_user', message: string) {
    if (this.state === 'submitted') return;
    this.deps.store.setStatus(this.job.id, 'APPLIED', outcome === 'submitted' ? 'Submitted with the apply assistant' : 'Submitted in the browser');
    if (this.attemptId) this.deps.store.finishAttempt(this.attemptId, outcome, { fields: this.summary() });
    this.set('submitted', message);
  }

  private fail(message: string) {
    if (this.attemptId) this.deps.store.finishAttempt(this.attemptId, 'failed', { error: message, fields: this.summary() });
    this.set('failed', message);
  }

  private summary() {
    return this.fields.map((f) => ({ label: f.field.label, status: f.status, source: f.answer.source ?? null }));
  }

  private async captchaVisible(): Promise<boolean> {
    for (const frame of this.page?.frames() ?? []) {
      const boxes = frame.locator(CAPTCHA_FRAMES);
      const n = await boxes.count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        const box = await boxes.nth(i).boundingBox().catch(() => null);
        if (box && box.width > 100 && box.height > 100 && (await boxes.nth(i).isVisible().catch(() => false))) return true;
      }
    }
    const body = await this.page?.locator('body').innerText({ timeout: 1000 }).catch(() => '');
    return /verify you are (a )?human|are you a robot|security check|complete the captcha/i.test(body?.slice(0, 2000) ?? '');
  }

  private async submittedOnPage(): Promise<boolean> {
    if (!this.page) return false;
    const formGone = this.frame ? (await this.frame.locator('[data-jaa]').count().catch(() => 0)) === 0 : true;
    const moved = this.frame ? this.frame.url() !== this.formUrl : true;
    if (!formGone && !moved) return false;
    for (const frame of this.page.frames()) {
      const text = await frame.locator('body').innerText({ timeout: 1000 }).catch(() => '');
      if (SUCCESS_TEXT.test(text.slice(0, 4000))) return true;
    }
    return /confirmation|thank[-_]?you|application[-_]?submitted/i.test(this.page.url());
  }

  private async watch() {
    if (!this.page || this.page.isClosed() || this.state === 'submitted' || this.state === 'closed' || this.state === 'failed') return;
    try {
      if (await this.submittedOnPage()) {
        this.finish(this.submitClicked ? 'submitted' : 'submitted_by_user', 'Application submitted. Marked as applied.');
        return;
      }
      const captcha = await this.captchaVisible();
      if (captcha && this.state !== 'captcha') {
        this.stateBeforeCaptcha = this.state;
        this.set('captcha', 'CAPTCHA or security check: solve it in the browser window. The assistant is paused.');
      } else if (!captcha && this.state === 'captcha') {
        this.state = this.stateBeforeCaptcha ?? 'needs_input';
        this.set(this.state, this.state === 'submitting' ? 'Check passed. Waiting for confirmation...' : 'Check passed. Continue when ready.');
      }
    } catch {
      // Page navigating; try again on the next tick.
    }
  }

  private async onPageClosed() {
    // A failed session already recorded its outcome; closing it must not turn that into "did you apply?".
    if (this.state === 'submitted' || this.state === 'closed' || this.state === 'failed') return;
    clearInterval(this.timer);
    if (this.attemptId) this.deps.store.finishAttempt(this.attemptId, this.closedOutcome, { fields: this.summary() });
    this.set(
      'closed',
      this.prefill ? 'Tab closed. No submission was detected: confirm in the dashboard whether you applied.' : 'Browser tab closed. Nothing was submitted.',
    );
  }

  /**
   * Closes the tab. `outcome` overrides what is recorded, e.g. "skipped" when you skip a
   * prefilled job from the dashboard.
   */
  async close(outcome?: string): Promise<void> {
    clearInterval(this.timer);
    if (this.state !== 'submitted' && this.state !== 'closed' && this.state !== 'failed') {
      if (this.attemptId) this.deps.store.finishAttempt(this.attemptId, outcome ?? this.closedOutcome, { fields: this.summary() });
      this.set('closed', this.dryRun ? 'Dry run finished. Nothing was submitted.' : 'Closed. Nothing was submitted.');
    }
    await this.page?.close().catch(() => {});
  }

  snapshot() {
    return {
      jobId: this.job.id,
      url: this.url,
      state: this.state,
      message: this.message,
      dryRun: this.dryRun,
      prefill: this.prefill,
      supported: fullySupported(this.job.platform),
      startedAt: this.startedAt,
      log: this.log.slice(-30),
      fields: this.fields.map((f) => ({
        key: f.field.key,
        label: f.field.label,
        kind: f.field.kind,
        required: f.field.required,
        options: f.field.options,
        value: f.field.kind === 'file' && f.answer.value ? f.answer.value.split(/[\\/]/).pop() : f.answer.value,
        source: f.answer.source ?? null,
        note: f.answer.note ?? null,
        status: f.status,
        error: f.error ?? null,
      })),
    };
  }
}

export type ApplySnapshot = ReturnType<ApplySession['snapshot']>;
