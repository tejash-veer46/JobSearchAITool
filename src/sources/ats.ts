// Company career boards with public JSON feeds: Greenhouse, Lever, Ashby.
import { fetchJson } from '../lib/http.js';

// Large boards (thousands of postings with full descriptions) can take well over 20 seconds.
const BOARD = { timeoutMs: 60_000 };
import { htmlToText, toIso } from '../lib/text.js';
import type { RawJob, Workplace } from '../types.js';

export interface Company {
  slug: string;
  name: string;
}

export function workplaceFrom(...hints: (string | null | undefined | boolean)[]): Workplace | null {
  const s = hints.map((h) => (h === true ? 'remote' : h || '')).join(' ').toLowerCase();
  if (/remote/.test(s)) return 'remote';
  if (/hybrid/.test(s)) return 'hybrid';
  if (/on-?site|in[- ]office/.test(s)) return 'onsite';
  return null;
}

// ---------------------------------------------------------------- Greenhouse

interface GreenhouseJob {
  id: number;
  title: string;
  absolute_url: string;
  location?: { name?: string };
  content?: string;
  updated_at?: string;
  first_published?: string;
}

export function mapGreenhouse(company: Company, j: GreenhouseJob): RawJob {
  const location = j.location?.name ?? '';
  return {
    platform: 'greenhouse',
    externalId: `${company.slug}:${j.id}`,
    title: j.title.trim(),
    company: company.name,
    location,
    url: j.absolute_url,
    description: htmlToText(j.content ?? ''),
    postedAt: toIso(j.first_published ?? j.updated_at),
    workplace: workplaceFrom(location, j.title),
  };
}

export async function fetchGreenhouse(company: Company): Promise<RawJob[]> {
  const data = await fetchJson<{ jobs: GreenhouseJob[] }>(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(company.slug)}/jobs?content=true`,
    BOARD,
  );
  return data.jobs.map((j) => mapGreenhouse(company, j));
}

// ---------------------------------------------------------------- Lever

interface LeverJob {
  id: string;
  text: string;
  hostedUrl: string;
  applyUrl?: string;
  country?: string;
  categories?: { location?: string; allLocations?: string[]; commitment?: string };
  descriptionPlain?: string;
  lists?: { text: string; content: string }[];
  additionalPlain?: string;
  workplaceType?: string;
  createdAt?: number;
  salaryRange?: { min?: number; max?: number; currency?: string; interval?: string };
}

export function mapLever(company: Company, j: LeverJob): RawJob {
  const locs = j.categories?.allLocations?.length ? j.categories.allLocations : [j.categories?.location ?? ''];
  let location = locs.filter(Boolean).join('; ');
  if (j.country === 'IN' && !/india/i.test(location)) location = `${location}${location ? ', ' : ''}India`;
  // Other countries keep their code ("Massachusetts - Boston (US)") so the location filter can reject them.
  else if (j.country && j.country !== 'IN') location = `${location} (${j.country})`;
  const sections = (j.lists ?? []).map((l) => `${l.text}\n${htmlToText(l.content)}`);
  const s = j.salaryRange;
  return {
    platform: 'lever',
    externalId: `${company.slug}:${j.id}`,
    title: j.text.trim(),
    company: company.name,
    location,
    url: j.hostedUrl,
    applyUrl: j.applyUrl ?? null,
    description: [j.descriptionPlain ?? '', ...sections, j.additionalPlain ?? ''].filter(Boolean).join('\n\n').trim(),
    postedAt: toIso(j.createdAt),
    workplace: workplaceFrom(j.workplaceType, location),
    salary: s?.min ? `${s.currency ?? ''} ${s.min}-${s.max ?? ''} ${s.interval ?? ''}`.trim() : null,
  };
}

export async function fetchLever(company: Company): Promise<RawJob[]> {
  const data = await fetchJson<LeverJob[]>(`https://api.lever.co/v0/postings/${encodeURIComponent(company.slug)}?mode=json`, BOARD);
  return data.map((j) => mapLever(company, j));
}

// ---------------------------------------------------------------- Ashby

interface AshbyJob {
  id: string;
  title: string;
  location?: string;
  secondaryLocations?: { location?: string }[];
  isRemote?: boolean;
  isListed?: boolean;
  workplaceType?: string;
  descriptionPlain?: string;
  jobUrl: string;
  applyUrl?: string;
  publishedAt?: string;
  compensation?: { compensationTierSummary?: string };
}

export function mapAshby(company: Company, j: AshbyJob): RawJob {
  const location = [j.location, ...(j.secondaryLocations ?? []).map((s) => s.location)].filter(Boolean).join('; ');
  return {
    platform: 'ashby',
    externalId: `${company.slug}:${j.id}`,
    title: j.title.trim(),
    company: company.name,
    location: j.isRemote && !/remote/i.test(location) ? `${location}${location ? '; ' : ''}Remote` : location,
    url: j.jobUrl,
    applyUrl: j.applyUrl ?? null,
    description: j.descriptionPlain ?? '',
    postedAt: toIso(j.publishedAt),
    workplace: workplaceFrom(j.workplaceType, j.isRemote),
    salary: j.compensation?.compensationTierSummary ?? null,
  };
}

export async function fetchAshby(company: Company): Promise<RawJob[]> {
  const data = await fetchJson<{ jobs: AshbyJob[] }>(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(company.slug)}?includeCompensation=true`,
    BOARD,
  );
  return data.jobs.filter((j) => j.isListed !== false).map((j) => mapAshby(company, j));
}

// ---------------------------------------------------------------- SmartRecruiters

interface SmartRecruitersPosting {
  id: string;
  name: string;
  company?: { identifier?: string; name?: string };
  releasedDate?: string;
  location?: { city?: string; country?: string; remote?: boolean; hybrid?: boolean; fullLocation?: string };
  ref?: string;
}

interface SmartRecruitersDetail {
  postingUrl?: string;
  applyUrl?: string;
  jobAd?: { sections?: Record<string, { title?: string; text?: string }> };
}

// Only QA-like titles get their full description fetched (one extra request each); the rest are
// rejected by the title filter anyway.
const SR_DETAIL_TITLE = /\b(qa|qe|sdet|test|tester|testing|quality|automation)\b/i;

export function mapSmartRecruiters(company: Company, p: SmartRecruitersPosting, d?: SmartRecruitersDetail): RawJob {
  const loc = p.location ?? {};
  let location = loc.fullLocation ?? [loc.city, loc.country].filter(Boolean).join(', ');
  const country = (loc.country ?? '').toUpperCase();
  if (country === 'IN' && !/india/i.test(location)) location = `${location}${location ? ', ' : ''}India`;
  else if (country && country !== 'IN') location = `${location} (${country})`;
  if (loc.remote && !/remote/i.test(location)) location = `${location}; Remote`;
  const sections = Object.values(d?.jobAd?.sections ?? {}).map((s) => `${s.title ?? ''}\n${htmlToText(s.text ?? '')}`.trim());
  return {
    platform: 'smartrecruiters',
    externalId: `${company.slug}:${p.id}`,
    title: p.name.trim(),
    company: p.company?.name ?? company.name,
    location,
    url: d?.postingUrl ?? `https://jobs.smartrecruiters.com/${encodeURIComponent(company.slug)}/${p.id}`,
    applyUrl: d?.applyUrl ?? null,
    description: sections.filter(Boolean).join('\n\n'),
    postedAt: toIso(p.releasedDate),
    workplace: loc.remote ? 'remote' : loc.hybrid ? 'hybrid' : 'onsite',
  };
}

/** India postings of one SmartRecruiters company (official public Posting API). */
export async function fetchSmartRecruiters(company: Company): Promise<RawJob[]> {
  const out: RawJob[] = [];
  const base = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company.slug)}/postings`;
  for (let offset = 0; offset < 1000; offset += 100) {
    const page = await fetchJson<{ content: SmartRecruitersPosting[]; totalFound: number }>(`${base}?limit=100&offset=${offset}&country=in`, BOARD);
    for (const p of page.content) {
      const detail = SR_DETAIL_TITLE.test(p.name)
        ? await fetchJson<SmartRecruitersDetail>(`${base}/${encodeURIComponent(p.id)}`, BOARD).catch(() => undefined)
        : undefined;
      out.push(mapSmartRecruiters(company, p, detail));
    }
    if (page.content.length < 100 || offset + 100 >= page.totalFound) break;
  }
  return out;
}
