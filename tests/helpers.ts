import { parseProfileFacts, parseSearchConfig } from '../src/config.js';
import type { CandidateProfile, RawJob } from '../src/types.js';

export const cfg = parseSearchConfig({ blacklist_companies: ['Acme Global', 'Globex Corp'] });

export const facts = parseProfileFacts({
  compensation: { expected_ctc_inr: 1200000 },
  preferences: { willing_to_relocate: true },
  notice_period_days: 60,
});

export function job(overrides: Partial<RawJob> = {}): RawJob {
  return {
    platform: 'greenhouse',
    externalId: 'acme:1',
    title: 'QA Automation Engineer',
    company: 'Acme',
    location: 'Bengaluru, India',
    url: 'https://example.com/jobs/1',
    description: 'We need 1-3 years of experience with Playwright, TypeScript and API testing. Jenkins CI/CD a plus.',
    postedAt: new Date().toISOString(),
    workplace: null,
    ...overrides,
  };
}

export const profile: CandidateProfile = {
  name: 'Test Candidate',
  contact: { email: 'a@b.c', phone: '', linkedin: '', github: '', links: [] },
  summary: 'QA engineer',
  skills: ['Playwright', 'TypeScript'],
  yearsExperience: 1.8,
  education: [],
  workHistory: [
    {
      company: 'Acme QA',
      title: 'SDET-1',
      start: 'May 2025',
      end: 'Present',
      highlights: ['Built UI and API automation with Playwright and TypeScript, cutting test time by 40%.'],
    },
  ],
  projects: [],
  certifications: [],
  rawText:
    'Playwright TypeScript Java Selenium Postman REST API testing Jenkins CI/CD Git JIRA SQL PostgreSQL regression testing Agile',
  parsedBy: 'rules',
  sourceHash: 'x',
};
