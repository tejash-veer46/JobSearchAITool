import { describe, expect, it } from 'vitest';
import { htmlToText, fingerprint } from '../src/lib/text.js';
import { mapAshby, mapGreenhouse, mapLever, mapSmartRecruiters } from '../src/sources/ats.js';
import { mapHimalayas, mapRemotive } from '../src/sources/feeds.js';

const company = { slug: 'acme', name: 'Acme' };

describe('source mapping', () => {
  it('greenhouse: decodes double-escaped HTML', () => {
    const j = mapGreenhouse(company, {
      id: 7,
      title: ' SDET II ',
      absolute_url: 'https://boards.greenhouse.io/acme/jobs/7',
      location: { name: 'Remote - India' },
      content: '&lt;p&gt;Use &lt;strong&gt;Playwright&lt;/strong&gt; &amp;amp; TypeScript&lt;/p&gt;&lt;ul&gt;&lt;li&gt;2+ years&lt;/li&gt;&lt;/ul&gt;',
      first_published: '2026-10-01T10:00:00-04:00',
    });
    expect(j).toMatchObject({ externalId: 'acme:7', title: 'SDET II', workplace: 'remote', postedAt: '2026-10-01T14:00:00.000Z' });
    expect(j.description).toBe('Use Playwright & TypeScript\n• 2+ years');
  });

  it('lever: joins description lists and adds India from the country code', () => {
    const j = mapLever(company, {
      id: 'abc',
      text: 'QA Engineer',
      hostedUrl: 'https://jobs.lever.co/acme/abc',
      country: 'IN',
      categories: { location: 'Bangalore, Karnataka' },
      descriptionPlain: 'About us.',
      lists: [{ text: 'Requirements', content: '<li>Selenium</li><li>Java</li>' }],
      workplaceType: 'hybrid',
      createdAt: Date.UTC(2026, 9, 1),
    });
    expect(j.location).toBe('Bangalore, Karnataka, India');
    expect(mapLever(company, { id: 'us', text: 'QA', hostedUrl: 'h', country: 'US', categories: { location: 'Boston' } }).location).toBe('Boston (US)');
    expect(j.workplace).toBe('hybrid');
    expect(j.description).toContain('Requirements\n• Selenium\n• Java');
  });

  it('ashby: merges secondary locations and marks remote', () => {
    const j = mapAshby(company, {
      id: 'x',
      title: 'QA Engineer',
      location: 'Pune',
      secondaryLocations: [{ location: 'Hyderabad' }],
      isRemote: true,
      jobUrl: 'https://jobs.ashbyhq.com/acme/x',
    });
    expect(j.location).toBe('Pune; Hyderabad; Remote');
    expect(j.workplace).toBe('remote');
  });

  it('himalayas and remotive: remote with region in the location', () => {
    expect(
      mapHimalayas({ guid: 'g', title: 'QA', companyName: 'Co', applicationLink: 'https://h/x', locationRestrictions: ['India'], seniority: ['Mid-level'] }),
    ).toMatchObject({ location: 'Remote (India)', seniorityHints: ['Mid-level'] });
    expect(
      mapRemotive({ id: 1, url: 'https://r/1', title: 'QA', company_name: 'Co', publication_date: '2026-10-01T08:00:00' }),
    ).toMatchObject({ location: 'Remote (Worldwide)', postedAt: '2026-10-01T08:00:00.000Z' });
  });

  it('smartrecruiters: India location, live apply link, sections joined', () => {
    const j = mapSmartRecruiters(
      { slug: 'Acme', name: 'Acme' },
      { id: '7440', name: 'QA Automation Tester', releasedDate: '2026-11-03T10:11:14.201Z', location: { city: 'Bengaluru', country: 'in', hybrid: true, fullLocation: 'Bengaluru, KA, India' } },
      { postingUrl: 'https://jobs.smartrecruiters.com/Acme/7440-qa', applyUrl: 'https://jobs.smartrecruiters.com/Acme/7440-qa?oga=true', jobAd: { sections: { jobDescription: { title: 'Job Description', text: '<p>Playwright and API testing</p>' } } } },
    );
    expect(j).toMatchObject({ platform: 'smartrecruiters', externalId: 'Acme:7440', location: 'Bengaluru, KA, India', workplace: 'hybrid', applyUrl: 'https://jobs.smartrecruiters.com/Acme/7440-qa?oga=true' });
    expect(j.description).toContain('Playwright and API testing');
    expect(mapSmartRecruiters({ slug: 'Acme', name: 'Acme' }, { id: '1', name: 'QA', location: { city: 'Krakow', country: 'pl' } }).location).toBe('Krakow, pl (PL)');
  });

  it('bad dates become null instead of throwing', () => {
    expect(mapRemotive({ id: 2, url: 'u', title: 't', company_name: 'c', publication_date: 'not a date' }).postedAt).toBeNull();
  });
});

describe('text helpers', () => {
  it('fingerprints ignore company suffixes and punctuation', () => {
    expect(fingerprint('Acme Technologies Pvt Ltd', 'QA Engineer', 'Pune, India')).toBe(
      fingerprint('Acme', 'QA engineer', 'Pune'),
    );
  });
  it('htmlToText keeps line structure', () => {
    expect(htmlToText('<h3>Role</h3><p>Test&nbsp;things</p>')).toBe('Role\nTest things');
  });
});
