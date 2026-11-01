// Keyword job-search feeds: Himalayas, Remotive, Adzuna.
import { fetchJson } from '../lib/http.js';
import { htmlToText, toIso } from '../lib/text.js';
import type { RawJob } from '../types.js';

// ---------------------------------------------------------------- Himalayas (remote jobs, filterable to India)

interface HimalayasJob {
  guid: string;
  title: string;
  companyName: string;
  locationRestrictions?: string[];
  description?: string;
  applicationLink: string;
  pubDate?: number;
  seniority?: string[];
  minSalary?: number | null;
  maxSalary?: number | null;
  currency?: string | null;
}

export function mapHimalayas(j: HimalayasJob): RawJob {
  const where = j.locationRestrictions?.length ? j.locationRestrictions.join(', ') : 'Worldwide';
  return {
    platform: 'himalayas',
    externalId: j.guid,
    title: j.title.trim(),
    company: j.companyName,
    location: `Remote (${where})`,
    url: j.applicationLink,
    description: htmlToText(j.description ?? ''),
    postedAt: j.pubDate ? toIso(j.pubDate * 1000) : null,
    workplace: 'remote',
    salary: j.minSalary ? `${j.currency ?? ''} ${j.minSalary}-${j.maxSalary ?? ''}`.trim() : null,
    seniorityHints: j.seniority ?? [],
  };
}

export async function fetchHimalayas(queries: string[], maxPages = 3): Promise<RawJob[]> {
  const out: RawJob[] = [];
  for (const q of queries) {
    for (let page = 1; page <= maxPages; page++) {
      const data = await fetchJson<{ jobs: HimalayasJob[]; totalCount: number }>(
        `https://himalayas.app/jobs/api/search?q=${encodeURIComponent(q)}&country=IN&page=${page}`,
        { minIntervalMs: 1500 },
      );
      out.push(...data.jobs.map(mapHimalayas));
      if (data.jobs.length < 20 || page * 20 >= data.totalCount) break;
    }
  }
  return out;
}

// ---------------------------------------------------------------- Remotive (remote jobs)

interface RemotiveJob {
  id: number;
  url: string;
  title: string;
  company_name: string;
  candidate_required_location?: string;
  description?: string;
  publication_date?: string;
  salary?: string;
}

export function mapRemotive(j: RemotiveJob): RawJob {
  return {
    platform: 'remotive',
    externalId: String(j.id),
    title: j.title.trim(),
    company: j.company_name,
    location: `Remote (${j.candidate_required_location || 'Worldwide'})`,
    url: j.url,
    description: htmlToText(j.description ?? ''),
    // Remotive timestamps are UTC but usually carry no zone suffix.
    postedAt: toIso(j.publication_date && !/[zZ]|[+-]\d\d:?\d\d$/.test(j.publication_date) ? `${j.publication_date}Z` : j.publication_date),
    workplace: 'remote',
    salary: j.salary || null,
  };
}

export async function fetchRemotive(categories: string[]): Promise<RawJob[]> {
  const out: RawJob[] = [];
  for (const c of categories) {
    const data = await fetchJson<{ jobs: RemotiveJob[] }>(
      `https://remotive.com/api/remote-jobs?category=${encodeURIComponent(c)}`,
      { minIntervalMs: 3000 },
    );
    out.push(...data.jobs.map(mapRemotive));
  }
  return out;
}

// ---------------------------------------------------------------- Adzuna (India-wide listings, free key)

interface AdzunaJob {
  id: string;
  title: string;
  company?: { display_name?: string };
  location?: { display_name?: string };
  redirect_url: string;
  description?: string;
  created?: string;
  salary_min?: number;
  salary_max?: number;
}

export function mapAdzuna(j: AdzunaJob): RawJob {
  const location = j.location?.display_name ?? 'India';
  return {
    platform: 'adzuna',
    externalId: j.id,
    title: htmlToText(j.title),
    company: j.company?.display_name ?? 'Unknown',
    location: /india/i.test(location) ? location : `${location}, India`,
    url: j.redirect_url,
    // Adzuna only returns a ~500 character snippet of the description.
    description: htmlToText(j.description ?? ''),
    postedAt: toIso(j.created),
    workplace: /remote/i.test(`${j.title} ${location}`) ? 'remote' : null,
    salary: j.salary_min ? `INR ${Math.round(j.salary_min)}-${Math.round(j.salary_max ?? j.salary_min)}` : null,
  };
}

export async function fetchAdzuna(queries: string[], creds: { id: string; key: string }, maxAgeDays: number): Promise<RawJob[]> {
  const out: RawJob[] = [];
  for (const q of queries) {
    for (let page = 1; page <= 2; page++) {
      const params = new URLSearchParams({
        app_id: creds.id,
        app_key: creds.key,
        what: q,
        results_per_page: '50',
        max_days_old: String(maxAgeDays),
        'content-type': 'application/json',
      });
      const data = await fetchJson<{ results: AdzunaJob[] }>(`https://api.adzuna.com/v1/api/jobs/in/search/${page}?${params}`, {
        minIntervalMs: 1200,
      });
      out.push(...data.results.map(mapAdzuna));
      if (data.results.length < 50) break;
    }
  }
  return out;
}
