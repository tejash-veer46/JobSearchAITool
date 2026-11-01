import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { env } from '../src/config.js';
import { extractResume, findResumeFile, parseResumeRules, totalYears } from '../src/engine/resume.js';

const SAMPLE = `JANE DOE
+91-9000000000 Email LinkedIn
SUMMARY
QA engineer focused on API testing.
TECHNICAL SKILLS
Test Automation: Playwright, Cucumber (BDD), Postman
DevOps & Languages: CI/CD (Jenkins, GitHub), TypeScript, SQL
Certifications: ISTQB Foundation
EXPERIENCE
Acme | QA Engineer Jan 2024 – Present
• Automated regression suites with Playwright, cutting cycle time
by 30%.
• Tested REST APIs with Postman.
Beta Corp | Intern Jun 2023 – Dec 2023
• Wrote manual test cases.
PROJECTS
TestBot – Requirement to test generator | Node.js, Claude API
• Generates Playwright tests from user stories.
EDUCATION
State University Aug 2019 – May 2023
B.Tech in Computer Science`;

describe('rule-based resume parser', () => {
  const today = new Date(2026, 9, 21);
  const p = parseResumeRules(SAMPLE, ['mailto:jane@example.com', 'https://linkedin.com/in/jane', 'https://github.com/jane'], today);

  it('reads contact details from text and links', () => {
    expect(p.name).toBe('Jane Doe');
    expect(p.contact).toMatchObject({
      email: 'jane@example.com',
      phone: '+91-9000000000',
      linkedin: 'https://linkedin.com/in/jane',
      github: 'https://github.com/jane',
    });
  });

  it('splits skills without breaking parenthesised groups', () => {
    expect(p.skills).toEqual(expect.arrayContaining(['Playwright', 'Cucumber (BDD)', 'CI/CD (Jenkins, GitHub)', 'TypeScript']));
    expect(p.certifications).toEqual(['ISTQB Foundation']);
  });

  it('parses work history with wrapped bullets and computes years', () => {
    expect(p.workHistory).toHaveLength(2);
    expect(p.workHistory[0]).toMatchObject({ company: 'Acme', title: 'QA Engineer', start: 'Jan 2024', end: 'Present' });
    expect(p.workHistory[0]!.highlights[0]).toBe('Automated regression suites with Playwright, cutting cycle time by 30%.');
    // Jun 2023 – Oct 2026 = 41 months
    expect(p.yearsExperience).toBe(3.4);
  });

  it('parses projects and education', () => {
    expect(p.projects[0]).toMatchObject({ name: 'TestBot – Requirement to test generator', tech: ['Node.js', 'Claude API'] });
    expect(p.education[0]).toMatchObject({ institution: 'State University', degree: 'B.Tech in Computer Science' });
  });
});

describe('totalYears', () => {
  it('merges overlapping ranges', () => {
    const today = new Date(2026, 0, 15);
    expect(totalYears([['Jan 2025', 'Dec 2025']], today)).toBe(1);
    expect(totalYears([['Jan 2025', 'Dec 2025'], ['Jun 2025', 'Present']], today)).toBe(1.1);
  });
});

// Runs against your real resume when it is present (it is git-ignored).
const hasResume = existsSync(env.resumePath);
describe.skipIf(!hasResume)('your resume (data/resume reader)', () => {
  it('extracts text, links and a sensible profile', async () => {
    const { text, links } = await extractResume(findResumeFile());
    expect(text.length).toBeGreaterThan(500);
    const p = parseResumeRules(text, links);
    expect(p.name).not.toBe('');
    expect(p.contact.email).toMatch(/@/);
    expect(p.workHistory.length).toBeGreaterThan(0);
    expect(p.yearsExperience).toBeGreaterThan(0);
    expect(p.skills.length).toBeGreaterThan(5);
  });
});
