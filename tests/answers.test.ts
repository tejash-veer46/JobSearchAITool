import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { matchOption, resolveLocally, similarity } from '../src/apply/answers.js';
import type { FormField } from '../src/apply/fields.js';
import { parseProfileFacts, saveAnswer } from '../src/config.js';
import { JobStore } from '../src/db.js';
import { facts, job, profile } from './helpers.js';

const store = new JobStore(':memory:');
const row = store.get(store.upsertDiscovered(job()).id)!;
const ctx = { profile, facts, job: row, resumeFile: 'C:/resume.pdf' };
const f = (label: string, extra: Partial<FormField> = {}): FormField => ({ key: 'f0', kind: 'text', label, name: '', required: true, options: [], currentValue: '', ...extra });

describe('matchOption', () => {
  it('matches exact, yes/no and decline wording', () => {
    expect(matchOption(['India', 'Indonesia'], 'india')).toBe('India');
    expect(matchOption(['Yes, I am', 'No, I am not'], 'Yes')).toBe('Yes, I am');
    expect(matchOption(['Male', 'Female', 'I prefer not to answer'], 'Prefer not to say')).toBe('I prefer not to answer');
  });
  it('never rounds experience up', () => {
    expect(matchOption(['0', '1', '1.5', '2', '3'], '1.8')).toBe('1.5');
    expect(matchOption(['0-1 years', '1-2 years', '2-4 years'], '1.8')).toBe('1-2 years');
    expect(matchOption(['Less than 1', '1+', '3+', '5+'], '1.8')).toBe('1+');
  });
  it('returns null when nothing fits', () => {
    expect(matchOption(['Red', 'Blue'], 'Green')).toBeNull();
  });
});

describe('resolveLocally', () => {
  it('fills identity and logistics from facts', () => {
    expect(resolveLocally(f('Email'), ctx).value).toBe('a@b.c');
    expect(resolveLocally(f('Notice period (in days)'), ctx).value).toBe('60');
    expect(resolveLocally(f('Notice period', { kind: 'select', options: ['Immediate', '30 days', '60 days', '90 days'] }), ctx).value).toBe('60 days');
    expect(resolveLocally(f('Expected CTC (yearly)'), ctx).value).toBe('1200000');
    expect(resolveLocally(f('Willing to relocate?', { kind: 'radio', options: ['Yes', 'No'] }), ctx).value).toBe('Yes');
    expect(resolveLocally(f('Resume', { kind: 'file' }), ctx)).toMatchObject({ value: 'C:/resume.pdf', source: 'resume' });
  });

  it('treats long labels as questions, not identity fields', () => {
    const yesNo = { kind: 'combobox' as const, options: ['Yes', 'No'] };
    // Mentions "GitHub" but asks about GitHub Actions, which the resume lacks: left for the user.
    expect(resolveLocally(f('Are you proficient in automation and CI/CD, specifically GitHub actions and Jenkins?', yesNo), ctx).value).toBeNull();
    expect(resolveLocally(f('GitHub profile'), { ...ctx, profile: { ...profile, contact: { ...profile.contact, github: 'https://github.com/me' } } }).value).toBe('https://github.com/me');
  });

  it('attaches the resume to inputs identified by id, but not cover-letter uploads', () => {
    expect(resolveLocally(f('Attach', { kind: 'file', name: 'resume', required: false }), ctx).value).toBe('C:/resume.pdf');
    expect(resolveLocally(f('Attach', { kind: 'file', name: 'cover_letter', required: false }), ctx).value).toBeNull();
  });

  it('says yes to skill questions only when the resume shows every skill', () => {
    const yesNo = { kind: 'radio' as const, options: ['Yes', 'No'] };
    expect(resolveLocally(f('Do you have hands-on experience with Playwright and TypeScript?', yesNo), ctx).value).toBe('Yes');
    expect(resolveLocally(f('Do you have experience with Playwright and Cypress?', yesNo), ctx).value).toBeNull();
  });

  it('leaves consent, unknown facts and open questions to the user', () => {
    expect(resolveLocally(f('I agree to the privacy policy', { kind: 'checkbox' }), ctx)).toMatchObject({ value: null, note: 'Tick this yourself if you agree' });
    expect(resolveLocally(f('Current CTC'), ctx).value).toBeNull();
    expect(resolveLocally(f('Will you require visa sponsorship?'), ctx).value).toBeNull();
    expect(resolveLocally(f('Describe a bug you are proud of finding', { kind: 'textarea' }), ctx).value).toBeNull();
  });

  it('declines self-identification only when allowed, and only with a matching option', () => {
    const gender = f('Gender', { kind: 'select', options: ['Male', 'Female', 'Decline to self identify'] });
    expect(resolveLocally(gender, ctx)).toMatchObject({ value: 'Decline to self identify', source: 'policy' });
    expect(resolveLocally(f('Gender', { kind: 'select', options: ['Male', 'Female'] }), ctx).value).toBeNull();
    const askCtx = { ...ctx, facts: { ...facts, self_identification: 'ask' as const } };
    expect(resolveLocally(gender, askCtx).value).toBeNull();
  });

  it('reuses saved answers for similar questions', () => {
    const withSaved = { ...ctx, facts: { ...facts, saved_answers: [{ question: 'How did you hear about this role?', answer: 'Company website' }] } };
    expect(similarity('How did you hear about this job?', 'How did you hear about this role?')).toBeGreaterThan(0.5);
    expect(resolveLocally(f('How did you hear about this role?'), withSaved)).toMatchObject({ value: 'Company website', source: 'saved' });
  });
});

describe('screening facts from profile.yaml', () => {
  const full = {
    ...ctx,
    job: { ...row, company: 'Acme' },
    facts: parseProfileFacts({
      contact: { current_city: 'Bengaluru' },
      preferences: { office_ok: true, shifts_ok: true },
      compensation: { expected_ctc_inr: 1200000, expected_negotiable: true, current_ctc_inr: 650000 },
      notice_period_days: 60,
      serving_notice: false,
      offer_in_hand: false,
      work_authorization: 'Indian citizen, authorised to work in India; no visa sponsorship required',
      requires_sponsorship: false,
      education: { cgpa: '8.2/10', class_10_percent: '88%', class_12_percent: '82%', graduation_year: 2022, gap: 'Yes, one year between school and college.' },
      languages: ['English', 'Hindi'],
      gender: 'Male',
      disability: 'No',
      heard_about: ['LinkedIn', 'Indeed', 'Job portal'],
      standard_answers: { why_change: 'Growth and compensation.', about_me: 'SDET with 1.8 years.' },
    }),
  };
  const yn = { kind: 'radio' as const, options: ['Yes', 'No'] };
  const v = (label: string, extra: Partial<FormField> = {}) => resolveLocally(f(label, extra), full).value;

  it('answers availability and compensation', () => {
    expect(v('Are you currently serving your notice period?', yn)).toBe('No');
    expect(v('Can you join immediately?', yn)).toBe('No');
    expect(v('Do you have any offers in hand?', yn)).toBe('No');
    expect(v('Is your expected CTC negotiable?', yn)).toBe('Yes');
    expect(v('Current CTC (in LPA)')).toBe('6.5');
    expect(v('Expected CTC', { kind: 'select', options: ['5-8 LPA', '8-12 LPA', '12+ LPA'] })).toBe('8-12 LPA');
  });

  it('handles wording seen on a live Capco form', () => {
    const combo = (options: string[]) => ({ kind: 'combobox' as const, options });
    expect(v('How soon you can join us?', combo(['Immediate', '0 days- 15 days', '30 Days - 45 days', '45 Days - 60 days', '60 days - 90 days']))).toBe('45 Days - 60 days');
    expect(v('What is your preferred location?', combo(['Bangalore', 'Pune', 'Mumbai', 'Others']))).toBe('Bangalore');
    expect(v('experience do you have in Selenium Java / Playwright Automation?', combo(['Yes', 'No']))).toBe('Yes');
    expect(v('Are you currently working?', combo(['Yes', 'No']))).toBe('Yes');
    expect(v('What is you current or last payroll company name?')).toBe('Acme QA');
    expect(v('If you are serving notice, please mention official last working day')).toMatch(/Not serving notice/);
    expect(v('Please mention holding offer details (CTC, DOJ and Location)')).toBe('No offers in hand');
  });

  it('handles wording seen on live Capco and Cohere Health forms', () => {
    const combo = (options: string[]) => ({ kind: 'combobox' as const, options });
    expect(v('What is your Automation Testing experience?', combo(['No Experience', 'Exposure Only', '1-3 Years', '3+ Years']))).toBe('1-3 Years');
    expect(v('Are you at least 18 years of age?', combo(['Yes', 'No']))).toBe('Yes');
    expect(v('In which of the following locations do you live?', combo(['United States', 'Hyderabad, Telangana, India', 'Any other locations in India']))).toBe('Any other locations in India');
    // No stored fact: left for you.
    expect(v('Do any of your current or former family members work at Cohere Health?', combo(['Yes', 'No']))).toBeNull();
    expect(v('What is your legal mailing address?')).toBeNull();
  });

  it('handles wording seen on live Veeva and ZoomInfo forms', () => {
    const combo = (options: string[]) => ({ kind: 'combobox' as const, options });
    // Regression: "currently employed" here is about relatives, not you.
    expect(v('Do you have any friends or relatives currently employed at ZoomInfo?', combo(['Yes', 'No']))).toBeNull();
    expect(v('Are you currently employed?', combo(['Yes', 'No']))).toBe('Yes');
    expect(v('What is your Legal First Name?')).toBe('Test');
    expect(v('What is your Legal Last Name?')).toBe('Candidate');
    expect(v('What is your Preferred Last Name?')).toBe('Candidate');
    expect(v('Current Work Location:')).toBe('Bengaluru');
    expect(v('Do you have automation experience?', combo(['Yes', 'No']))).toBe('Yes');
    expect(v('Are you interested in working in Automation Testing?', combo(['Yes', 'No']))).toBe('Yes');
    expect(v('What programming languages / tools do you use?')).toMatch(/Languages: Java, TypeScript.*Tools: Playwright, Selenium/);
  });

  it('answers family and address questions once they are in profile.yaml', () => {
    const more = { ...full, facts: { ...full.facts, family_at_company: false, address: 'HSR Layout, Bengaluru 560102' } };
    const w = (label: string, extra: Partial<FormField> = {}) => resolveLocally(f(label, extra), more).value;
    expect(w('Do any of your current or former family members work at Cohere Health?', yn)).toBe('No');
    expect(w('If you answered "yes" to the above, what is the name of the employee?')).toBe('N/A');
    expect(w('What is your legal mailing address?')).toBe('HSR Layout, Bengaluru 560102');
  });

  it('answers location, office and shift questions', () => {
    expect(v('Are you based out of Bangalore ?', yn)).toBe('Yes');
    expect(v('Are you currently located in Pune?', yn)).toBe('No');
    expect(v('Are you able to work from our Bangalore office at least three days a week?', yn)).toBe('Yes');
    expect(v('Are you comfortable working in rotational shifts?', yn)).toBe('Yes');
  });

  it('answers authorization for India but leaves other countries to you', () => {
    expect(v('Will you now or in the future require visa sponsorship?', yn)).toBe('No');
    expect(v('Are you legally authorized to work in India?', yn)).toBe('Yes');
    expect(v('Are you legally authorized to work in the United States?', yn)).toBeNull();
  });

  it('answers education, identity and standard questions', () => {
    expect(v('B.Tech CGPA')).toBe('8.2/10');
    expect(v('Class 10th percentage')).toBe('88%');
    expect(v('12th Percentage')).toBe('82%');
    expect(v('Year of passing')).toBe('2022');
    expect(v('Do you have any gaps in your education?', yn)).toBe('Yes');
    expect(v('Gender', { kind: 'select', options: ['Male', 'Female', 'Other'] })).toBe('Male');
    expect(v('Do you have a disability?', { kind: 'select', options: ["I don't wish to answer", 'Yes, I have a disability', "No, I don't have a disability"] })).toBe("No, I don't have a disability");
    expect(v('Veteran status', { kind: 'select', options: ['I am a veteran', 'I decline to self-identify'] })).toBe('I decline to self-identify');
    expect(v('How did you hear about this job?', { kind: 'select', options: ['Employee referral', 'Indeed', 'Company website'] })).toBe('Indeed');
    expect(v('Have you previously worked for Acme?', yn)).toBe('No');
    expect(v('Why are you looking for a change?', { kind: 'textarea' })).toBe('Growth and compensation.');
    expect(v('Tell us about yourself', { kind: 'textarea' })).toBe('SDET with 1.8 years.');
    expect(v('Are you willing to sign a service bond?', yn)).toBeNull();
  });
});

describe('saveAnswer', () => {
  it('appends to profile.yaml and keeps comments', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'jaa-')), 'profile.yaml');
    writeFileSync(file, '# my facts\nnotice_period_days: 60 # two months\nsaved_answers: []\n');
    saveAnswer('How did you hear about us?', 'LinkedIn', file);
    saveAnswer('How did you hear about us?', 'Company website', file); // updates, no duplicate
    saveAnswer('Open to night shifts?', 'No', file);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('# my facts');
    expect(text).toContain('# two months');
    expect(parseProfileFacts(parse(text)).saved_answers).toEqual([
      { question: 'How did you hear about us?', answer: 'Company website' },
      { question: 'Open to night shifts?', answer: 'No' },
    ]);
  });
});
