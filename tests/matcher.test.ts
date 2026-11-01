import { describe, expect, it } from 'vitest';
import { JobStore } from '../src/db.js';
import { ASK_USER, roleKind, scoreWithRules, standardAnswers } from '../src/engine/matcher.js';
import { facts, job, profile } from './helpers.js';

const ctx = { profile, facts, threshold: 75, maxRequiredYears: 3 };

function stored(overrides: Parameters<typeof job>[0] = {}) {
  const store = new JobStore(':memory:');
  const res = store.upsertDiscovered(job(overrides));
  return store.get(res.id)!;
}

describe('rule-based scoring', () => {
  it('stages a strong automation match at the right level', () => {
    const m = scoreWithRules(
      stored({ description: '1-3 years of experience. Playwright, TypeScript, API testing, Jenkins, CI/CD, SQL.' }),
      ctx,
    );
    expect(m.matchScore).toBeGreaterThanOrEqual(75);
    expect(m.isQualified).toBe(true);
    expect(m.missingSkills).toEqual([]);
    expect(m.shortPitch).toContain('Acme');
  });

  it('never stages a role asking for more years than the candidate has', () => {
    const m = scoreWithRules(
      stored({ description: '3+ years of experience. Playwright, TypeScript, API testing, Jenkins, CI/CD, SQL.' }),
      ctx,
    );
    expect(m.isQualified).toBe(false);
    expect(m.matchScore).toBeLessThan(75);
  });

  it('lists skills the job wants that the resume lacks', () => {
    const m = scoreWithRules(stored({ description: 'Cypress, Appium, Kubernetes, Playwright. 2 years of experience.' }), ctx);
    expect(m.missingSkills).toEqual(expect.arrayContaining(['Cypress', 'Appium', 'Kubernetes']));
    expect(m.matchedSkills).toContain('Playwright');
  });

  it('classifies role kinds', () => {
    expect(roleKind('SDET II', [])).toBe('automation');
    expect(roleKind('Manual QA Engineer', ['Selenium'])).toBe('manual');
    expect(roleKind('QA Engineer', ['Selenium'])).toBe('qa');
    expect(roleKind('QA Engineer', ['JIRA'])).toBe('manual');
  });
});

describe('screening answers', () => {
  it('answers from facts and flags unknowns instead of guessing', () => {
    const answers = Object.fromEntries(standardAnswers(profile, facts).map((a) => [a.question, a.answer]));
    expect(answers['Notice period?']).toBe('60 days');
    expect(answers['Expected CTC?']).toBe('₹12,00,000 per annum (12.0 LPA)');
    expect(answers['Current CTC?']).toBe(ASK_USER);
    expect(answers['Work authorization?']).toBe(ASK_USER);
  });
});
