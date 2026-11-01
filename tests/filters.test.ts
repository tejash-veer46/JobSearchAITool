import { describe, expect, it } from 'vitest';
import {
  blacklistHit,
  filterJob,
  isRelevantTitle,
  locationProblem,
  requiredYears,
  seniorityProblem,
  staleProblem,
} from '../src/engine/filters.js';
import { cfg, job } from './helpers.js';

describe('title relevance', () => {
  it.each([
    'QA Engineer',
    'SDET II',
    'Software Development Engineer in Test',
    'Manual Tester',
    'Quality Assurance Analyst',
    'Test Automation Engineer',
  ])('keeps "%s"', (title) => expect(isRelevantTitle(title, cfg)).toBeNull());

  it.each([
    ['Frontend Engineer', 'not a QA'],
    ['Hardware Test Engineer', 'different field'],
    ['Supplier Quality Engineer', 'different field'],
    ['Quality Assurance Rater - Indonesian', 'different field'],
    ['Territory Account Executive, Qatar', 'not a QA'],
  ])('drops "%s"', (title, why) => expect(isRelevantTitle(title, cfg)).toContain(why));

  it('drops manual roles when include_manual_qa is off', () => {
    const strict = { ...cfg, filters: { ...cfg.filters, include_manual_qa: false } };
    expect(isRelevantTitle('Manual QA Engineer', strict)).toContain('manual');
  });
});

describe('seniority', () => {
  it.each(['Senior QA Engineer', 'Sr. SDET', 'QA Lead', 'Staff Software Engineer in Test', 'SDET III', 'QA Engineer 3'])(
    'rejects "%s"',
    (title) => expect(seniorityProblem(title)).not.toBeNull(),
  );
  it.each(['SDET II', 'QA Engineer', 'Junior QA Engineer', 'Software Engineer in Test 2'])('accepts "%s"', (title) =>
    expect(seniorityProblem(title)).toBeNull(),
  );
  it('rejects internships and source-provided senior labels', () => {
    expect(seniorityProblem('QA Intern')).toContain('internship');
    expect(seniorityProblem('QA Engineer', ['Senior'])).toContain('Senior');
    expect(seniorityProblem('QA Engineer', ['Mid-level', 'Senior'])).toBeNull();
  });
});

describe('required years', () => {
  it.each([
    ['2-4 years of experience in QA', 2],
    ['Minimum 3+ years of experience in software testing', 3],
    ['3+ years in software testing; 2+ years focused on automation', 3],
    ['4+ years of manual QA of web applications', 4],
    ['5+ years of software experience, 2+ years of testing experience', 5],
    ['Experience: 1–3 Yrs', 1],
  ])('"%s" -> %d', (text, years) => expect(requiredYears(text)).toBe(years));

  it('ignores preferred years and unrelated numbers', () => {
    expect(requiredYears('Founded 12 years ago. Strong testing skills.')).toBeNull();
    expect(requiredYears('2+ years of experience required. 5+ years of experience is a plus.')).toBe(2);
    expect(requiredYears('Ideally 6 years of experience with Selenium')).toBeNull();
  });
});

describe('location', () => {
  const loc = (location: string, description = '', workplace: 'remote' | null = null) =>
    locationProblem({ location, description, workplace });

  it('accepts Indian cities and India-open remote roles', () => {
    expect(loc('Bangalore, Karnataka')).toBeNull();
    expect(loc('Hybrid in Gurugram')).toBeNull();
    expect(loc('Remote (India)')).toBeNull();
    expect(loc('Remote (Worldwide)')).toBeNull();
    expect(loc('Remote', 'Team spread across India and Europe')).toBeNull();
  });

  it('rejects other countries and remote roles limited elsewhere', () => {
    expect(loc('Taipei, Taiwan')).toContain('outside India');
    expect(loc('Remote - USA')).toContain('limited to');
    expect(loc('Remote, US')).toContain('limited to');
    expect(loc('Remote')).toContain('region not stated');
    expect(loc('Remote (Worldwide)', 'You must be based in Europe or the UK.')).toContain('posting says');
    // Lever country codes: remote roles in another country, even when the description mentions India.
    expect(loc('Massachusetts - Boston (US)', 'Offices in Boston and Hyderabad, India', 'remote')).toContain('outside India');
    expect(loc('Buenos Aires (AR)', 'Teams in India', 'remote')).toContain('outside India');
    expect(loc('Hyderabad (IN)')).toBeNull();
  });
});

describe('blacklist and freshness', () => {
  it('matches whole company words only', () => {
    expect(blacklistHit('Acme Global', ['Acme Global'])).toContain('Acme Global');
    expect(blacklistHit('Globex Corp Ltd', ['Globex Corp'])).toContain('Globex Corp');
    expect(blacklistHit('Globexian Labs', ['Globex'])).toBeNull();
  });

  it('flags old postings', () => {
    const now = Date.parse('2026-10-21T00:00:00Z');
    expect(staleProblem('2026-08-01T00:00:00Z', 30, now)).toContain('stale');
    expect(staleProblem('2026-10-10T00:00:00Z', 30, now)).toBeNull();
    expect(staleProblem(null, 30, now)).toBeNull();
  });
});

describe('filterJob', () => {
  it('passes a good fit and reports the years asked', () => {
    expect(filterJob(job(), cfg)).toEqual({ ok: true, minYears: 1 });
  });

  it('rejects jobs asking for too much experience', () => {
    const r = filterJob(job({ description: 'Requires 5+ years of experience in test automation.' }), cfg);
    expect(r).toEqual({ ok: false, reason: 'experience: needs 5+ years (max 3)' });
  });

  it('rejects blacklisted companies', () => {
    expect(filterJob(job({ company: 'Acme Global' }), cfg)).toMatchObject({ ok: false, reason: 'blacklist: Acme Global' });
  });

  it('keeps old listings on company boards but drops them from aggregators', () => {
    const old = new Date(Date.now() - 100 * 86_400_000).toISOString();
    expect(filterJob(job({ postedAt: old }), cfg).ok).toBe(true);
    expect(filterJob(job({ platform: 'himalayas', postedAt: old }), cfg)).toMatchObject({ ok: false });
  });

  it('rejects "automation engineer" roles with no test tooling', () => {
    const rpa = job({ title: 'Automation Engineer', description: 'Build Zapier and n8n workflows. 2 years of experience.' });
    expect(filterJob(rpa, cfg)).toMatchObject({ ok: false, reason: expect.stringContaining('test-automation') });
  });
});
