// Company career boards with public JSON feeds: Greenhouse, Lever, Ashby.
import { fetchJson } from '../lib/http.js';
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
  const data = await fetchJson<LeverJob[]>(`https://api.lever.co/v0/postings/${encodeURIComponent(company.slug)}?mode=json`);
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
  );
  return data.jobs.filter((j) => j.isListed !== false).map((j) => mapAshby(company, j));
}
