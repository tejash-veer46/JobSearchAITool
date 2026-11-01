// Decides what to put in each form field. Order of trust:
// profile facts and resume > saved answers > this job's tailored answers > Claude > ask the user.
// Nothing is ever guessed: anything not backed by a fact is left for the user.
import { z } from 'zod';
import type { ProfileFacts } from '../config.js';
import type { JobRow } from '../db.js';
import { ASK_USER, candidateSkills } from '../engine/matcher.js';
import { AUTOMATION_SKILLS, findSkills } from '../engine/skills.js';
import { askStructured, hasClaude } from '../lib/claude.js';
import { normalize } from '../lib/text.js';
import type { CandidateProfile } from '../types.js';
import type { FormField } from './fields.js';

export type AnswerSource = 'profile' | 'resume' | 'saved' | 'job' | 'claude' | 'you' | 'policy';

export interface Answer {
  value: string | null;
  source?: AnswerSource;
  /** Why the field is left for the user, or a hint for review. */
  note?: string;
}

export interface AnswerContext {
  profile: CandidateProfile;
  facts: ProfileFacts;
  job: JobRow;
  resumeFile: string;
}

const ask = (note: string): Answer => ({ value: null, note });

// ---------------------------------------------------------------- option matching

const YES = /^(yes|y|true|i do|i am|i have|i will|i can)\b/i;
const NO = /^(no|n|false|i do not|i don'?t|i am not|i'?m not|i have not|i will not)\b/i;
const DECLINE = /decline|prefer not|don'?t wish|do not wish|not to (say|disclose|answer|identify)|rather not|choose not/i;

/** Picks the option that best matches the desired answer, or null when nothing fits. */
export function matchOption(options: string[], desired: string): string | null {
  if (!options.length) return null;
  const want = normalize(desired);
  const norm = options.map((o) => normalize(o));

  const exact = norm.indexOf(want);
  if (exact >= 0) return options[exact]!;

  if (YES.test(desired) || NO.test(desired)) {
    const re = YES.test(desired) ? YES : NO;
    const i = options.findIndex((o) => re.test(o.trim()));
    if (i >= 0) return options[i]!;
  }
  if (DECLINE.test(desired)) {
    const i = options.findIndex((o) => DECLINE.test(o));
    if (i >= 0) return options[i]!;
  }

  // Numbers: "1.8" against ["0","1","1.5","2",...] or ranges like "1-2 years" -> the option the value falls in,
  // otherwise the largest option not above it (never round experience up).
  const num = Number.parseFloat(desired.replace(/[^\d.]/g, ''));
  if (Number.isFinite(num) && /^\s*[₹$]?\s*[\d.,]+/.test(desired)) {
    let best: string | null = null;
    let bestVal = -Infinity;
    for (const o of options) {
      // "1-2 years", "45 Days - 60 days", "8 to 12 LPA"
      const range = o.match(/(\d+(?:\.\d+)?)\s*[a-z]*\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)/i);
      if (range && num >= Number(range[1]) && num <= Number(range[2])) return o;
      const lead = o.match(/(\d+(?:\.\d+)?)/);
      if (!lead) continue;
      const v = Number(lead[1]);
      // "Less than 1" / "up to 2" are upper bounds, not starting points.
      if (/less than|under|below|up to|<|fewer/i.test(o)) {
        if (num < v) return o;
        continue;
      }
      const isPlus = /\+|more|above|over/i.test(o);
      if ((v <= num || (isPlus && num >= v)) && v > bestVal) {
        best = o;
        bestVal = v;
      }
    }
    if (best) return best;
  }

  const starts = norm.findIndex((o) => o.startsWith(want) || want.startsWith(o));
  if (starts >= 0 && want.length >= 2) return options[starts]!;
  const contains = norm.findIndex((o) => want.length >= 3 && (o.includes(want) || want.includes(o)) && o.length >= 2);
  return contains >= 0 ? options[contains]! : null;
}

// ---------------------------------------------------------------- saved / tailored answer lookup

const STOP = new Set(['the', 'a', 'an', 'you', 'your', 'do', 'are', 'is', 'of', 'in', 'to', 'for', 'with', 'what', 'have', 'how', 'please']);
const words = (s: string) => new Set(normalize(s).split(' ').filter((w) => w.length > 1 && !STOP.has(w)));

/** Word-overlap similarity between two questions (0-1). */
export function similarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (!wa.size || !wb.size) return 0;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / Math.max(wa.size, wb.size);
}

function lookup(question: string, answers: { question: string; answer: string }[], min = 0.75) {
  let best: { answer: string; score: number } | null = null;
  for (const a of answers) {
    if (a.answer === ASK_USER) continue;
    const s = similarity(question, a.question);
    if (s >= min && (!best || s > best.score)) best = { answer: a.answer, score: s };
  }
  return best?.answer ?? null;
}

// ---------------------------------------------------------------- rules

const inr = (n: number) => `${n}`;
const lakhs = (n: number) => `${Number((n / 100_000).toFixed(2))}`;

function money(field: FormField, l: string, amount: number | null): Answer {
  if (amount == null) return ask('Not in config/profile.yaml');
  if (field.options.length) {
    // Ranges are usually in lakhs ("8-10 LPA"), sometimes in rupees.
    const opt = matchOption(field.options, lakhs(amount)) ?? matchOption(field.options, inr(amount));
    return opt ? { value: opt, source: 'profile' } : ask('No option matches your figure');
  }
  if (/lpa|lakh|lac\b/.test(l)) return { value: lakhs(amount), source: 'profile' };
  // Numeric fields want a plain number; free-text ones read better with the unit.
  if (/yearly|annual|per annum|in inr|\(inr\)|amount|number|in rupees/.test(l) || field.kind === 'number') {
    return { value: inr(amount), source: 'profile' };
  }
  return { value: `${inr(amount)} INR per annum (${lakhs(amount)} LPA)`, source: 'profile' };
}

/** Yes/No questions: the matching option, or plain Yes/No for text fields. */
function yesNo(field: FormField, yes: boolean, source: AnswerSource = 'profile', note?: string): Answer {
  const want = yes ? 'Yes' : 'No';
  if (field.kind === 'checkbox') return { value: want, source, note };
  if (!field.options.length) return { value: want, source, note };
  const opt = matchOption(field.options, want);
  return opt ? { value: opt, source, note } : ask(`No "${want}" option`);
}

const CITY_ALIASES: [RegExp, string][] = [
  [/bengaluru|bangalore/, 'bengaluru'],
  [/gurugram|gurgaon/, 'gurugram'],
  [/mumbai|bombay/, 'mumbai'],
  [/chennai|madras/, 'chennai'],
  [/kolkata|calcutta/, 'kolkata'],
  [/hyderabad|secunderabad/, 'hyderabad'],
  [/delhi|ncr|noida/, 'delhi ncr'],
];
const cityKey = (s: string) => CITY_ALIASES.find(([re]) => re.test(s.toLowerCase()))?.[1] ?? normalize(s);

/** A city answer for a field: the option naming the same city (Bangalore = Bengaluru), or the city itself. */
function cityAnswer(field: FormField, city: string): Answer {
  if (!field.options.length) return { value: city, source: 'profile' };
  const opt =
    field.options.find((o) => cityKey(o) === cityKey(city)) ??
    // "Any other locations in India" / "Other (India)" when your city isn't listed.
    field.options.find((o) => /\b(other|any)\b/i.test(o) && /india/i.test(o));
  return opt ? { value: opt, source: 'profile' } : ask(`No "${city}" option`);
}

/** Answers from facts alone. Returns undefined when no rule applies. */
export function ruleAnswer(field: FormField, ctx: AnswerContext): Answer | undefined {
  const { profile, facts } = ctx;
  const l = field.label.toLowerCase();
  const [first = '', ...rest] = profile.name.split(/\s+/);
  const current = profile.workHistory[0];
  const p = (value: string | null | undefined, source: AnswerSource = 'profile'): Answer =>
    value ? { value, source } : ask('Not in your resume or config/profile.yaml');

  if (field.kind === 'file') {
    if (/cover/i.test(`${l} ${field.name}`)) return { value: null, note: 'Cover letter upload, left empty' };
    if (/resume|\bcv\b|curriculum/i.test(`${l} ${field.name}`) || field.required) {
      return { value: ctx.resumeFile, source: 'resume' };
    }
    return { value: null, note: 'Optional upload, left empty' };
  }

  // Consent and declarations are the candidate's call, always.
  if (/\b(agree|consent|acknowledge|certify|confirm that|privacy (policy|notice)|terms)\b/i.test(l)) {
    return ask('Tick this yourself if you agree');
  }

  const identity = selfIdentification(field, l, ctx);
  if (identity) return identity;

  // Identity and link fields have short labels. A long label is a question that merely mentions
  // a word like "GitHub" or "email", so it falls through to the question rules below.
  // "What is your Legal First Name?" is still an identity field once the wrapping is removed.
  const core = l
    .replace(/^(what is|what's|please (enter|provide|share|mention)|enter|provide|share)\s+(your\s+)?/, '')
    .replace(/[\s?:*]+$/, '')
    .trim();
  if (core.length <= 45 && !/\?/.test(core)) {
    const id = identityAnswer(core, ctx, p, first, rest.join(' '), current);
    if (id) return id;
  }
  return questionAnswer(field, l, ctx);
}

function selfIdentification(field: FormField, l: string, ctx: AnswerContext): Answer | undefined {
  const { facts } = ctx;
  if (/\b(gender|sex)\b/.test(l) && !/orientation|transgender|pronoun/.test(l)) {
    if (!facts.gender) return facts.self_identification === 'decline' ? decline(field) : ask('Self-identification question');
    const v = field.options.length ? matchOption(field.options, facts.gender) : facts.gender;
    return v ? { value: v, source: 'profile' } : ask(`No "${facts.gender}" option`);
  }
  if (/disabilit|differently abled|\bpwd\b|handicap/.test(l)) {
    if (!facts.disability) return facts.self_identification === 'decline' ? decline(field) : ask('Self-identification question');
    if (!field.options.length) return { value: facts.disability, source: 'profile' };
    // "No, I don't have a disability" - but never an "I don't wish to answer" option.
    const no = /^no\b/i.test(facts.disability);
    const opt = no
      ? field.options.find((o) => /^no\b|do not have|don'?t have|not have a disab/i.test(o) && !/wish|prefer|answer|disclose/i.test(o))
      : matchOption(field.options, facts.disability);
    return opt ? { value: opt, source: 'profile' } : ask('No matching option');
  }
  if (/\b(race|ethnic|hispanic|latino|veteran|pronoun|sexual orientation|transgender|caste|religion)\b/.test(l)) {
    return facts.self_identification === 'decline' ? decline(field) : ask('Self-identification question');
  }
  return undefined;
}

function decline(field: FormField): Answer {
  const opt = matchOption(field.options, 'Prefer not to say');
  return opt ? { value: opt, source: 'policy', note: 'Declined to self-identify' } : ask('No "prefer not to say" option');
}

function identityAnswer(
  l: string,
  ctx: AnswerContext,
  p: (value: string | null | undefined, source?: AnswerSource) => Answer,
  first: string,
  last: string,
  current: CandidateProfile['workHistory'][number] | undefined,
): Answer | undefined {
  const { profile, facts } = ctx;
  const c = profile.contact;
  const e = facts.education;
  if (/^(legal )?first name|given name|^first$/.test(l)) return p(first);
  if (/^(legal )?last name|surname|family name/.test(l)) return p(last);
  if (/preferred last name/.test(l)) return p(last);
  if (/preferred (first )?name/.test(l)) return p(first);
  if (/^(full )?name$|^your name|full name|legal name/.test(l)) return p(profile.name);
  if (/e-?mail/.test(l) && !/confirm/.test(l)) return p(c.email);
  if (/confirm.*e-?mail/.test(l)) return p(c.email);
  if (/phone|mobile|contact number|whatsapp/.test(l) && !/type|country code/.test(l)) return p(c.phone);
  if (/linkedin/.test(l)) return p(c.linkedin);
  if (/github/.test(l)) return p(c.github);
  if (/portfolio|personal (website|site)|^website/.test(l)) {
    const site = c.links.find((u) => !/linkedin|github/i.test(u));
    return site ? p(site) : { value: null, note: 'No portfolio link in resume' };
  }
  if (/naukri|twitter|^other (url|link|website)/.test(l)) return { value: null, note: 'Optional, left empty' };
  if (/^country$|country of residence|which country/.test(l)) return { value: 'India', source: 'profile' };
  if (/current (location|city)|^location$|^city$|where are you (based|located)|city of residence/.test(l)) {
    return p(facts.contact.current_city, 'profile');
  }
  if (/current (company|employer|organi[sz]ation)|^company$|^org/.test(l)) return p(current?.company, 'resume');
  if (/current (job )?title|designation|current role|current position/.test(l)) return p(current?.title, 'resume');
  if (/(college|university|institute|institution)( name)?$|^school$/.test(l)) return p(e.institution || profile.education[0]?.institution);
  if (/^(degree|qualification|highest (qualification|degree|education))/.test(l)) return p(e.degree || profile.education[0]?.degree);
  return undefined;
}

/** Logistics, education, availability and experience questions; labels may be long. */
function questionAnswer(field: FormField, l: string, ctx: AnswerContext): Answer | undefined {
  const { profile, facts } = ctx;
  const e = facts.education;
  const std = facts.standard_answers;
  const opts = field.options;

  const current = profile.workHistory[0];
  const employed = Boolean(current && /present|current|now/i.test(current.end));
  const freeText = !opts.length && field.kind !== 'checkbox';

  // --- relatives at the company. Checked first: "friends or relatives currently employed at X"
  // must never be read as "are you currently employed?".
  if (/(family|relative|related to|spouse|friends?).{0,60}(work|employ)|(work|employ).{0,40}(family|relative)/.test(l)) {
    return facts.family_at_company == null ? ask('Not in config/profile.yaml') : yesNo(field, facts.family_at_company);
  }

  // --- current job and location (long-form wording of the identity questions)
  if (/^(are you )?(currently|presently) (working|employed)\s*\??$|^are you (currently |presently )?(working|employed)\b/.test(l)) {
    return yesNo(field, employed, 'resume');
  }
  if (/(current|present|last)( or (last|previous))? (payroll )?(company|employer|organi[sz]ation)/.test(l)) {
    return current ? { value: current.company, source: 'resume' } : ask('No work history in resume');
  }
  if (/(current|present) (job )?(title|designation|role)/.test(l)) return current ? { value: current.title, source: 'resume' } : ask('No work history in resume');
  if (/preferred (job |work )?locations?|location preference|which (city|location) do you prefer/.test(l)) {
    const city = facts.contact.current_city;
    if (!city && !facts.preferences.willing_to_relocate) return ask('Not in config/profile.yaml');
    if (opts.length) return city ? cityAnswer(field, city) : ask('No current city in config/profile.yaml');
    return { value: facts.preferences.willing_to_relocate ? `${city ? `${city}; ` : ''}open to any location in India, and remote` : city, source: 'profile' };
  }
  if (/(current|present) (work )?(location|city)|where (are you|do you) (currently )?(based|located|live)|which (of the following )?(locations?|cities|city) do you (live|reside)/.test(l) && facts.contact.current_city) {
    return cityAnswer(field, facts.contact.current_city);
  }
  if (/mailing address|postal address|residential address|current address|full address|home address|^address$/.test(l)) {
    return facts.address ? { value: facts.address, source: 'profile' } : ask('Address not in config/profile.yaml');
  }

  // --- age: you are a working graduate, so adulthood is a fact
  if (/at least 18|over (the age of )?18|18 years (of age|or older)|of legal (working )?age|above 18/.test(l)) {
    return yesNo(field, true, 'resume', 'You are a working graduate');
  }

  if (/if .{0,30}yes.{0,80}(employee|relative|family|name|relationship)/.test(l) && facts.family_at_company === false) {
    return { value: 'N/A', source: 'profile', note: 'You have no family at the company' };
  }

  // --- availability
  if (/serving (your )?notice|currently (serving|on) notice|last working day/.test(l)) {
    if (facts.serving_notice == null) return ask('Not in config/profile.yaml');
    if (freeText && !facts.serving_notice) return { value: `Not serving notice yet (notice period ${facts.notice_period_days ?? '-'} days)`, source: 'profile' };
    return freeText ? ask('Type your last working day') : yesNo(field, facts.serving_notice);
  }
  if (/buy ?out|join (immediately|earlier|early)|immediate joiner|early joining/.test(l)) {
    if (facts.notice_period_days == null) return ask('Notice period not set in config/profile.yaml');
    return opts.length || field.kind === 'checkbox'
      ? yesNo(field, facts.notice_period_days === 0)
      : { value: `My notice period is ${facts.notice_period_days} days.`, source: 'profile' };
  }
  if (/notice period|joining time|how soon (can )?you( can)? (join|start)|earliest start|when can you (join|start)/.test(l)) {
    if (facts.notice_period_days == null) return ask('Notice period not set in config/profile.yaml');
    const d = facts.notice_period_days;
    const opt = opts.length ? matchOption(opts, `${d} days`) ?? matchOption(opts, `${Math.round(d / 30)} months`) : null;
    if (opts.length && !opt) return ask('No option matches your notice period');
    return { value: opt ?? (/days?\)?/.test(l) || field.kind === 'number' ? String(d) : `${d} days`), source: 'profile' };
  }
  if (/offer in hand|other offers?|holding (an |any )?offers?|pending offers?|any offers?|offer details/.test(l)) {
    if (facts.offer_in_hand == null) return ask('Not in config/profile.yaml');
    if (freeText) return facts.offer_in_hand ? ask('Type your offer details') : { value: 'No offers in hand', source: 'profile' };
    return yesNo(field, facts.offer_in_hand);
  }

  // --- compensation
  if (/negotiable/.test(l)) {
    return facts.compensation.expected_negotiable == null ? ask('Not in config/profile.yaml') : yesNo(field, facts.compensation.expected_negotiable);
  }
  if (/expected (ctc|salary|compensation|pay)|salary expectation|desired (salary|compensation|pay)|compensation expectation|expectations? (on|for|around) (salary|compensation|ctc)/.test(l)) {
    return money(field, l, facts.compensation.expected_ctc_inr);
  }
  if (/current (ctc|salary|compensation|pay|package)|present (ctc|salary)|last drawn/.test(l)) return money(field, l, facts.compensation.current_ctc_inr);

  // --- location and work arrangement
  if (/relocat/.test(l)) {
    return facts.preferences.willing_to_relocate == null ? ask('Not in config/profile.yaml') : yesNo(field, facts.preferences.willing_to_relocate);
  }
  const basedIn = l.match(/(?:are you|currently) (?:based|located|living|residing) (?:in|out of|at) ([a-z ]+)|do you (?:live|reside) in ([a-z ]+)/);
  if (basedIn && facts.contact.current_city) {
    const asked = (basedIn[1] ?? basedIn[2] ?? '').replace(/\b(currently|now|or nearby|area|city)\b/g, '').trim();
    if (asked) return yesNo(field, cityKey(asked) === cityKey(facts.contact.current_city), 'profile', `You live in ${facts.contact.current_city}`);
  }
  if (/work(ing)? from (the |our |an )?office|on-?site|in[- ]office|days a week|office \d|hybrid/.test(l) && facts.preferences.office_ok != null) {
    return yesNo(field, facts.preferences.office_ok);
  }
  if (/shift|night|rotational|odd hours|us time ?zone|uk time ?zone|weekend/.test(l) && facts.preferences.shifts_ok != null) {
    return yesNo(field, facts.preferences.shifts_ok);
  }

  // --- work authorization: India only; other countries are your call
  if (/sponsor/.test(l)) {
    return facts.requires_sponsorship == null ? ask('Not in config/profile.yaml') : yesNo(field, facts.requires_sponsorship);
  }
  if (/work (authori[sz]ation|permit)|authori[sz]ed to work|right to work|legally (eligible|allowed|permitted)|eligible to work/.test(l)) {
    if (!facts.work_authorization) return ask('Work authorization not set in config/profile.yaml');
    const foreign = /\b(united states|usa|u\.s|us\b|uk|united kingdom|canada|europe|eu\b|germany|australia|singapore|uae)\b/.test(l);
    if (foreign) return ask('Asks about another country');
    return opts.length || field.kind === 'checkbox' ? yesNo(field, true) : { value: facts.work_authorization, source: 'profile' };
  }

  // --- background
  if (/(previously|ever|before) (been )?(worked|employed)|former employee|worked (for|at|with) us/.test(l)) {
    const worked = profile.workHistory.some((w) => normalize(w.company) === normalize(ctx.job.company));
    return yesNo(field, worked, 'resume');
  }
  if (/service (agreement|bond)|\bbond\b/.test(l)) {
    return std.service_bond ? fromValue(field, std.service_bond) : ask('You asked to answer bond questions yourself');
  }
  if (/how did you (hear|get to know|find|learn|come across)|where did you (hear|find|see)|source of (this )?(application|job)|referred by|job source/.test(l)) {
    if (!opts.length) return facts.heard_about[0] ? { value: facts.heard_about[0], source: 'profile' } : undefined;
    for (const h of facts.heard_about) {
      const opt = matchOption(opts, h);
      if (opt) return { value: opt, source: 'profile' };
    }
    return ask('None of your heard_about choices is offered');
  }

  // --- education
  if (/\b(10th|class (x|10)|ssc|secondary school|matric)/.test(l)) return fromValue(field, e.class_10_percent);
  if (/\b(12th|class (xii|12)|hsc|higher secondary|intermediate|puc|senior secondary)/.test(l)) return fromValue(field, e.class_12_percent);
  if (/cgpa|\bgpa\b|grade point|graduation (percentage|score|marks)|(b\.?tech|degree|ug) (percentage|score|marks|cgpa)/.test(l)) return fromValue(field, e.cgpa);
  if (/graduation year|year of (graduation|passing)|passing year|passed out|batch/.test(l)) return fromValue(field, e.graduation_year ? String(e.graduation_year) : '');
  if (/\bgaps?\b|break in (your )?(education|career|studies)|year drop|career break/.test(l)) {
    if (!e.gap) return ask('Not in config/profile.yaml');
    const has = !/^no\b/i.test(e.gap);
    return opts.length || field.kind === 'checkbox' ? yesNo(field, has) : { value: e.gap, source: 'profile' };
  }
  if (/languages?/.test(l) && /speak|known|spoken|proficien|fluent|which/.test(l) && facts.languages.length) {
    return field.kind === 'checkboxes' ? { value: facts.languages.join(', '), source: 'profile' } : fromValue(field, facts.languages.join(', '));
  }

  // --- standard written answers
  if (/reason for (job |the )?(change|switch|leaving)|why (are you|do you want to) (look|leav|chang|switch|mov)|why.*(change|switch|leave).*(job|role|company)|looking for a change/.test(l)) {
    return fromValue(field, std.why_change ?? '');
  }
  if (/tell (us|me) (a bit )?about yourself|introduce yourself|about yourself|brief (summary|introduction)|professional summary|summary of your (profile|experience)/.test(l)) {
    return fromValue(field, std.about_me ?? '');
  }

  // --- automation and tools, from what the resume shows
  const resumeSkills = findSkills(profile.rawText);
  if (/(do you have|any) (test )?automation (testing )?experience|experience (in|with) (test )?automation|have you (done|worked on) (test )?automation/.test(l)) {
    const tools = resumeSkills.filter((s) => AUTOMATION_SKILLS.has(s));
    return tools.length ? yesNo(field, true, 'resume', `Resume shows ${tools.join(', ')}`) : ask('No automation tools on your resume');
  }
  if (/interested in (working (in|on) )?(test )?(automation|qa|quality|testing|sdet)/.test(l)) {
    return yesNo(field, true, 'profile', 'You are targeting QA/SDET roles');
  }
  if (/programming languages|languages ?\/ ?tools|tools (do )?you (use|know|have used)|tech(nical)? stack|which tools|tools and technologies/.test(l) && !opts.length) {
    const langs = resumeSkills.filter((s) => ['Java', 'JavaScript', 'TypeScript', 'Python', 'SQL', 'C#/.NET'].includes(s));
    const tools = resumeSkills.filter((s) => AUTOMATION_SKILLS.has(s) || ['Postman', 'JMeter', 'Jenkins', 'Git', 'JIRA', 'Docker', 'SoapUI', 'PostgreSQL'].includes(s));
    if (!langs.length && !tools.length) return ask('No tools found on your resume');
    return { value: [langs.length ? `Languages: ${langs.join(', ')}` : '', tools.length ? `Tools: ${tools.join(', ')}` : ''].filter(Boolean).join('. '), source: 'resume' };
  }

  // --- experience
  if (/(total|overall|professional|relevant|work) (years of )?experience|years of (professional |total |overall |work )?experience|how many years|what is your .{0,40}experience\s*\??$|your .{0,30}experience level/.test(l)) {
    const skills = findSkills(field.label);
    // Years with specific tools: your total experience, but only when the resume itself (not just
    // profile.yaml's extra skills) shows every tool named, i.e. you used them at work.
    const onResume = new Set(findSkills(profile.rawText));
    if (skills.length === 0 || /sdet|qa|test|quality/.test(l) || skills.every((s) => onResume.has(s))) {
      if (skills.length && !skills.every((s) => onResume.has(s))) return ask(`Your resume doesn't show ${skills.filter((s) => !onResume.has(s)).join(', ')}`);
      const y = String(profile.yearsExperience);
      const v = opts.length ? matchOption(opts, y) : y;
      return v ? { value: v, source: 'resume' } : ask('No option matches your years of experience');
    }
    return ask(`Your resume doesn't show ${skills.filter((s) => !onResume.has(s)).join(', ')}`);
  }

  // "Do you have experience with X?" / "Are you proficient in X?" - yes only when you have every X.
  if (/^(do|are|have|can|is) (you|your)|experience (with|in)|experience .{0,20}\b(in|with)\b|proficien|hands-on|familiar|worked (on|with)/.test(l)) {
    const skills = findSkills(field.label);
    if (skills.length) {
      const mine = candidateSkills(profile);
      if (skills.every((s) => mine.has(s)) && ['radio', 'select', 'combobox', 'checkbox'].includes(field.kind)) {
        const yes = yesNo(field, true, 'resume', `You have ${skills.join(', ')}`);
        if (yes.value) return yes;
      }
      return undefined; // partial or no match: let the saved answers or Claude decide, else ask
    }
  }
  return undefined;
}

/** A stored text answer, matched to an option when the field has options. */
function fromValue(field: FormField, value: string): Answer {
  if (!value) return ask('Not in config/profile.yaml');
  if (!field.options.length) return { value, source: 'profile' };
  const opt = matchOption(field.options, value);
  return opt ? { value: opt, source: 'profile' } : ask('No option matches your answer');
}

function fromList(field: FormField, list: { question: string; answer: string }[], source: AnswerSource): Answer | undefined {
  const a = lookup(field.label, list);
  if (!a) return undefined;
  if (field.options.length) {
    const opt = matchOption(field.options, a);
    return opt ? { value: opt, source } : undefined;
  }
  return { value: a, source };
}

/** Resolves one field without calling Claude. */
export function resolveLocally(field: FormField, ctx: AnswerContext): Answer {
  if (!field.label) return ask('Field has no label');
  return (
    ruleAnswer(field, ctx) ??
    fromList(field, ctx.facts.saved_answers, 'saved') ??
    fromList(field, ctx.job.tailored_answers, 'job') ??
    (/cover letter|why (do you want|are you interested)|tell us about yourself|additional information/i.test(field.label) &&
    (field.kind === 'textarea' || field.kind === 'text') &&
    ctx.job.short_pitch
      ? { value: ctx.job.short_pitch, source: 'job', note: 'Your saved pitch for this job, review it' }
      : undefined) ??
    ask(field.required ? 'Needs your answer' : 'Optional, left empty')
  );
}

// ---------------------------------------------------------------- Claude, for what rules cannot answer

const ClaudeAnswers = z.object({
  answers: z.array(
    z.object({
      key: z.string(),
      answer: z.string().describe(`An option label exactly as listed, free text, or "${ASK_USER}"`),
    }),
  ),
});

export async function resolveWithClaude(fields: FormField[], ctx: AnswerContext): Promise<Map<string, Answer>> {
  const out = new Map<string, Answer>();
  if (!hasClaude() || !fields.length) return out;
  const { rawText, sourceHash, parsedBy, ...profile } = ctx.profile;
  const res = await askStructured(ClaudeAnswers, {
    system: [
      'You fill job application forms for one candidate, truthfully.',
      '- Use only facts from the resume, the structured profile and the candidate facts.',
      '- Never invent experience, skills, numbers, links, dates or personal details.',
      `- If a question cannot be answered from those facts, or is a legal, consent or personal-identity question, answer exactly "${ASK_USER}".`,
      '- For fields with options, answer with one option label copied exactly.',
      '- Free-text answers: first person, plain and specific, at most 120 words.',
      '',
      `<candidate_facts>${JSON.stringify({ ...ctx.facts, contact: undefined })}</candidate_facts>`,
      `<candidate_profile>${JSON.stringify(profile)}</candidate_profile>`,
      `<resume_text>${rawText}</resume_text>`,
    ].join('\n'),
    user: [
      `Job: ${ctx.job.title} at ${ctx.job.company}.`,
      `Job description (excerpt): ${ctx.job.description.slice(0, 4000)}`,
      '',
      'Fields to answer:',
      JSON.stringify(fields.map((f) => ({ key: f.key, question: f.label, type: f.kind, options: f.options.length ? f.options : undefined }))),
    ].join('\n'),
    maxTokens: 6000,
    effort: 'medium',
  });
  for (const a of res.answers) {
    const field = fields.find((f) => f.key === a.key);
    if (!field || a.answer === ASK_USER || !a.answer.trim()) continue;
    const value = field.options.length ? matchOption(field.options, a.answer) : a.answer.trim();
    if (value) out.set(field.key, { value, source: 'claude', note: 'Drafted by Claude, review it' });
  }
  return out;
}

/** All answers for a form: local rules first, then one Claude call for the rest. */
export async function resolveAll(fields: FormField[], ctx: AnswerContext): Promise<Map<string, Answer>> {
  const answers = new Map(fields.map((f) => [f.key, resolveLocally(f, ctx)]));
  const open = fields.filter((f) => answers.get(f.key)!.value == null && f.label && f.kind !== 'file' && !/Tick this yourself|Self-identification|Optional/.test(answers.get(f.key)!.note ?? ''));
  try {
    for (const [k, a] of await resolveWithClaude(open, ctx)) answers.set(k, a);
  } catch (err) {
    console.warn(`Claude could not draft answers: ${(err as Error).message}`);
  }
  return answers;
}
