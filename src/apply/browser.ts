import { type BrowserContext, chromium, type Page } from 'playwright-core';
import { env, paths } from '../config.js';

let shared: Promise<BrowserContext> | undefined;

export interface BrowserOptions {
  headless?: boolean;
  userDataDir?: string;
  channel?: string;
}

/**
 * Opens a visible Chrome with its own profile in browser-profile/, so logins and
 * cookies you create there persist between runs. Your normal Chrome profile is never touched.
 */
export async function launchBrowser(opts: BrowserOptions = {}): Promise<BrowserContext> {
  const channel = opts.channel ?? env.browserChannel;
  try {
    const context = await chromium.launchPersistentContext(opts.userDataDir ?? paths.browserProfile, {
      channel: channel === 'chromium' ? undefined : channel,
      headless: opts.headless ?? false,
      viewport: null,
      args: ['--start-maximized'],
    });
    // Functions passed to page.evaluate are transpiled with a __name helper; give the page one.
    await context.addInitScript({ content: 'globalThis.__name ??= (f) => f;' });
    return context;
  } catch (err) {
    const msg = (err as Error).message;
    if (/ProcessSingleton|in use|lock/i.test(msg)) {
      throw new Error('The assistant browser is already open in another JobApplyAI window (dashboard or CLI). Close that one first.');
    }
    if (/Executable doesn't exist|not found|distribution/i.test(msg)) {
      throw new Error(`Browser "${channel}" not found. Set BROWSER_CHANNEL=msedge in .env, or install Chrome.`);
    }
    throw err;
  }
}

const claimed = new WeakSet<Page>();

/**
 * A tab of its own for one application. Reuses Chrome's initial empty tab once, otherwise opens a
 * new one. The claim happens before any await, so sessions starting in parallel never share a tab.
 */
export async function takePage(context: BrowserContext): Promise<Page> {
  const blank = context.pages().find((p) => p.url() === 'about:blank' && !claimed.has(p) && !p.isClosed());
  if (blank) {
    claimed.add(blank);
    return blank;
  }
  const page = await context.newPage();
  claimed.add(page);
  return page;
}

/** One browser shared by every apply session in this process. Reopens if you closed the window. */
export function sharedBrowser(opts: BrowserOptions = {}): Promise<BrowserContext> {
  shared ??= launchBrowser(opts).then((ctx) => {
    ctx.on('close', () => {
      shared = undefined;
    });
    return ctx;
  });
  shared.catch(() => {
    shared = undefined;
  });
  return shared;
}

export async function closeSharedBrowser(): Promise<void> {
  const ctx = await shared?.catch(() => undefined);
  shared = undefined;
  await ctx?.close().catch(() => {});
}
