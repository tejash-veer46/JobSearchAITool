import { z } from 'zod';
import type { ProfileFacts } from '../config.js';
import type { JobRow } from '../db.js';
import { askStructured, hasClaude } from '../lib/claude.js';
import { truncate } from '../lib/text.js';
import type { CandidateProfile, MatchResult, ScreeningAnswer } from '../types.js';
import { requiredYears } from './filters.js';
import { AUTOMATION_SKILLS, findSkills } from './skills.js';

export interface MatchContext {
  profile: CandidateProfile;
  facts: ProfileFacts;
  threshold: number;
  maxRequiredYears: number;
}

/** Marker for answers the tool must not guess; the apply step asks the user instead. */
export const ASK_USER = 'ASK_USER';

const formatInr = (n: number) => `₹${n.toLocaleString('en-IN')} per annum (${(n / 100_000).toFixed(1)} LPA)`;

/** Answers to the screening questions most forms ask, built only from known facts. */
export function standardAnswers(profile: CandidateProfile, facts: ProfileFacts): ScreeningAnswer[] {
  const a: ScreeningAnswer[] = [
    { question: 'Total years of professional experience?', answer: String(profile.yearsExperience) },
    { question: 'Notice period?', answer: facts.notice_period_days != null ? `${facts.notice_period_days} days` : ASK_USER },
    {
      question: 'Expected CTC?',
      answer: facts.compensation.expected_ctc_inr != null ? formatInr(facts.compensation.expected_ctc_inr) : ASK_USER,
    },
    {
      question: 'Current CTC?',
      answer: facts.compensation.current_ctc_inr != null ? formatInr(facts.compensation.current_ctc_inr) : ASK_USER,
    },
    {
      question: 'Willing to relocate?',
      answer: facts.preferences.willing_to_relocate == null ? ASK_USER : facts.preferences.willing_to_relocate ? 'Yes' : 'No',
    },
    { question: 'Current location?', answer: facts.contact.current_city || ASK_USER },
    { question: 'Work authorization?', answer: facts.work_authorization || ASK_USER },
  ];
  return [...a, ...facts.saved_answers];
}

// ---------------------------------------------------------------- rule-based scorer

// Skills a resume implies without naming them.
const IMPLIED: [string, string[]][] = [
  ['Regression testing', ['Manual testing', 'Test case design']],
  ['Functional testing', ['Manual testing', 'Test case design']],
  ['GitLab CI', ['Git']],
  ['GitHub Actions', ['Git']],
  ['PostgreSQL', ['SQL']],
  ['MySQL', ['SQL']],
];

export function candidateSkills(profile: CandidateProfile): Set<string> {
  const skills = new Set(findSkills(`${profile.rawText}\n${profile.skills.join(', ')}`));
  for (const [has, implies] of IMPLIED) if (skills.has(has)) implies.forEach((s) => skills.add(s));
  return skills;
}

type RoleKind = 'automation' | 'qa' | 'manual';

export function roleKind(title: string, jdSkills: string[]): RoleKind {
  if (/\bmanual\b/i.test(title)) return 'manual';
  if (/\b(sdet|automation|automated|engineer in test)\b/i.test(title)) return 'automation';
  return jdSkills.some((s) => AUTOMATION_SKILLS.has(s)) ? 'qa' : 'manual';
}

function bestHighlight(profile: CandidateProfile, matched: string[]): string | undefined {
  const highlights = profile.workHistory.flatMap((w) => w.highlights);
  const scored = highlights.map((h) => ({
    h,
    score: matched.filter((s) => findSkills(h).includes(s)).length + (/\d+%/.test(h) ? 1 : 0),
  }));
  return scored.sort((a, b) => b.score - a.score)[0]?.h;
}

export function scoreWithRules(job: JobRow, ctx: MatchContext): MatchResult {
  const { profile, facts, threshold, maxRequiredYears } = ctx;
  const jdText = `${job.title}\n${job.description}`;
  const jdSkills = findSkills(jdText);
  const mine = candidateSkills(profile);
  const matched = jdSkills.filter((s) => mine.has(s));
  const missing = jdSkills.filter((s) => !mine.has(s));

  // Thin descriptions (e.g. Adzuna snippets) list few skills: treat coverage as neutral.
  const coverage = jdSkills.length >= 3 ? matched.length / jdSkills.length : 0.6;
  const kind = roleKind(job.title, jdSkills);
  const titleFit = kind === 'automation' ? 1 : kind === 'qa' ? 0.9 : 0.65;

  const minYears = requiredYears(jdText);
  const years = profile.yearsExperience;
  const expFit = minYears === null ? 0.8 : minYears <= years + 0.5 ? 1 : 0.6;
  // Asking for more years than the candidate has is a stretch: dock the whole score, more so beyond the cap.
  // At 0.8 even a perfect stretch match tops out at 72, so it shows as a near miss rather than being staged.
  const stretch = minYears === null || minYears <= years + 0.5 ? 1 : minYears <= maxRequiredYears ? 0.8 : 0.5;

  const score = Math.round(100 * (0.45 * coverage + 0.3 * titleFit + 0.25 * expFit) * stretch);
  const isQualified = score >= threshold && stretch === 1;

  const reasonParts = [
    `${matched.length}/${jdSkills.length} listed skills matched`,
    `${kind} role`,
    minYears === null ? 'experience not stated' : `asks ${minYears}+ yrs (you have ${years})`,
  ];
  const top = matched.slice(0, 3).join(', ') || 'software testing';
  const highlight = bestHighlight(profile, matched);
  const current = profile.workHistory[0];
  const shortPitch = [
    `I'm ${current ? `${/^[aeiou]/i.test(current.title) ? 'an' : 'a'} ${current.title} at ${current.company}` : 'a QA engineer'} with ${years} years of hands-on experience in ${top}.`,
    highlight ? `${highlight.replace(/\.$/, '')}.` : '',
    `I'd welcome the chance to bring this to the ${job.title} role at ${job.company}.`,
  ]
    .filter(Boolean)
    .join(' ');

  return {
    matchScore: score,
    isQualified,
    matchedSkills: matched,
    missingSkills: missing,
    experienceRequired: minYears === null ? null : `${minYears}+ years`,
    reason: reasonParts.join('; '),
    tailoredAnswers: standardAnswers(profile, facts),
    shortPitch,
    scorer: 'rules',
  };
}

// ---------------------------------------------------------------- Claude scorer

const ClaudeMatchSchema = z.object({
  match_score: z.number().int().min(0).max(100),
  is_qualified: z.boolean(),
  experience_required: z.string().nullable().describe('e.g. "2-4 years", or null if not stated'),
  matched_skills: z.array(z.string()),
  missing_skills: z.array(z.string()).describe('Required or important skills the candidate does not show'),
  reason: z.string().describe('1-2 sentences explaining the score'),
  tailored_answers: z
    .array(z.object({ question: z.string(), answer: z.string() }))
    .describe('Likely screening questions for this job, answered from the candidate facts only'),
  short_pitch: z.string().describe('2-sentence cover note to this company, first person, no invented facts'),
});

function claudeSystemPrompt(ctx: MatchContext): string {
  const { profile, facts, threshold, maxRequiredYears } = ctx;
  const { rawText, sourceHash, parsedBy, ...structured } = profile;
  return [
    'You evaluate job postings for one candidate and decide whether they should apply.',
    '',
    'Scoring rubric (0-100):',
    '- 90-100: role, level and stack fit; nearly all must-have skills present.',
    '- 75-89: good fit with minor, learnable gaps.',
    '- 50-74: notable skill gaps, or the experience asked is a stretch.',
    '- below 50: wrong level, wrong field, or most must-haves missing.',
    `The candidate has ${profile.yearsExperience} years of experience. If the posting requires more than ` +
      `${maxRequiredYears} years, or is a senior/lead/manager role, score at most 40 and set is_qualified false.`,
    'Automation/SDET roles suit the candidate best. Manual QA roles are acceptable but score them lower ' +
      'than an equivalent automation role.',
    `Set is_qualified true only when match_score >= ${threshold} and the level fits.`,
    '',
    'Rules for tailored_answers and short_pitch:',
    '- Use only facts from the resume and the candidate facts below. Never invent experience, numbers or skills.',
    `- If a question cannot be answered from those facts, answer exactly "${ASK_USER}".`,
    '- Years with a specific skill: count only roles where the resume shows that skill in use.',
    '',
    '<candidate_facts>',
    JSON.stringify(
      {
        notice_period_days: facts.notice_period_days,
        expected_ctc_inr: facts.compensation.expected_ctc_inr,
        current_ctc_inr: facts.compensation.current_ctc_inr,
        willing_to_relocate: facts.preferences.willing_to_relocate,
        preferred_locations: facts.preferences.locations,
        current_city: facts.contact.current_city || null,
        work_authorization: facts.work_authorization || null,
        saved_answers: facts.saved_answers,
      },
      null,
      2,
    ),
    '</candidate_facts>',
    '',
    '<candidate_profile>',
    JSON.stringify(structured, null, 2),
    '</candidate_profile>',
    '',
    '<resume_text>',
    rawText,
    '</resume_text>',
  ].join('\n');
}

export async function scoreWithClaude(job: JobRow, ctx: MatchContext): Promise<MatchResult> {
  const r = await askStructured(ClaudeMatchSchema, {
    system: claudeSystemPrompt(ctx),
    user: [
      `<job>`,
      `Title: ${job.title}`,
      `Company: ${job.company}`,
      `Location: ${job.location}${job.workplace ? ` (${job.workplace})` : ''}`,
      job.salary ? `Salary: ${job.salary}` : '',
      '',
      truncate(job.description, 15_000),
      `</job>`,
    ]
      .filter((l) => l !== '')
      .join('\n'),
    maxTokens: 4000,
    effort: 'medium',
  });

  // Keep the standard answers; Claude's job-specific ones take precedence on the same question.
  const asked = new Set(r.tailored_answers.map((a) => a.question.toLowerCase()));
  const answers = [...r.tailored_answers, ...standardAnswers(ctx.profile, ctx.facts).filter((a) => !asked.has(a.question.toLowerCase()))];

  return {
    matchScore: r.match_score,
    isQualified: r.is_qualified && r.match_score >= ctx.threshold,
    matchedSkills: r.matched_skills,
    missingSkills: r.missing_skills,
    experienceRequired: r.experience_required,
    reason: r.reason,
    tailoredAnswers: answers,
    shortPitch: r.short_pitch,
    scorer: 'claude',
  };
}

/** Claude when an API key is set (falling back to rules if the call fails), rules otherwise. */
export async function scoreJob(job: JobRow, ctx: MatchContext): Promise<MatchResult> {
  if (!hasClaude()) return scoreWithRules(job, ctx);
  try {
    return await scoreWithClaude(job, ctx);
  } catch (err) {
    console.warn(`  Claude scoring failed for #${job.id} (${(err as Error).message}); using rules`);
    return scoreWithRules(job, ctx);
  }
}
