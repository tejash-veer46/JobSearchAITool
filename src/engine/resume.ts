import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { env, loadProfileFacts, paths } from '../config.js';
import { askStructured, hasClaude } from '../lib/claude.js';
import type { CandidateProfile, WorkEntry } from '../types.js';
import { findSkills } from './skills.js';

const RESUME_EXT = new Set(['.pdf', '.docx']);

/** A file path is used as-is; a folder resolves to its newest PDF/DOCX. */
export function findResumeFile(p: string = env.resumePath): string {
  if (!existsSync(p)) throw new Error(`Resume not found at ${p}. Set RESUME_PATH in .env.`);
  if (statSync(p).isFile()) return p;
  const files = readdirSync(p)
    .filter((f) => RESUME_EXT.has(path.extname(f).toLowerCase()) && !f.startsWith('~$'))
    .map((f) => path.join(p, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  if (!files[0]) throw new Error(`No .pdf or .docx resume in ${p}`);
  return files[0];
}

export interface ResumeText {
  text: string;
  links: string[];
}

export async function extractResume(file: string): Promise<ResumeText> {
  const buf = readFileSync(file);
  if (path.extname(file).toLowerCase() === '.docx') {
    const mammoth = await import('mammoth');
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return { text: value, links: [...value.matchAll(/https?:\/\/\S+|mailto:\S+/g)].map((m) => m[0]) };
  }

  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: true });
  const links: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const annotations = (await (await pdf.getPage(i)).getAnnotations()) as { subtype?: string; url?: string }[];
    for (const a of annotations) if (a.subtype === 'Link' && a.url) links.push(a.url);
  }
  return { text, links };
}

// ---------------------------------------------------------------- rule-based parsing

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const DATE_RANGE = new RegExp(`(${MONTH}\\s+\\d{4})\\s*[–—-]+\\s*(present|current|now|${MONTH}\\s+\\d{4})`, 'i');
const HEADING =
  /^(summary|profile|professional summary|objective|technical skills|skills|experience|work experience|professional experience|employment|projects|education|certifications?|achievements|awards)$/i;

function monthIndex(s: string, today: Date): number {
  if (/present|current|now/i.test(s)) return today.getFullYear() * 12 + today.getMonth();
  const [mon = '', year = '0'] = s.trim().split(/\s+/);
  return Number(year) * 12 + Math.max(0, MONTHS.indexOf(mon.slice(0, 3).toLowerCase()));
}

/** Total months worked, merging overlapping ranges. Ranges are inclusive of both end months. */
export function totalYears(ranges: [string, string][], today = new Date()): number {
  const spans = ranges
    .map(([a, b]) => [monthIndex(a, today), monthIndex(b, today)] as [number, number])
    .filter(([a, b]) => b >= a)
    .sort((x, y) => x[0] - y[0]);
  let months = 0;
  let curEnd = -1;
  for (const [a, b] of spans) {
    const start = Math.max(a, curEnd + 1);
    if (b >= start) months += b - start + 1;
    curEnd = Math.max(curEnd, b);
  }
  return Math.round((months / 12) * 10) / 10;
}

/** Split on commas that are not inside parentheses. */
function splitList(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** Collects "• bullet" lines, joining wrapped continuation lines onto the previous bullet. */
function collectBullets(lines: string[]): string[] {
  const bullets: string[] = [];
  for (const line of lines) {
    if (/^[•●▪\-*]\s*/.test(line)) bullets.push(line.replace(/^[•●▪\-*]\s*/, ''));
    else if (bullets.length) bullets[bullets.length - 1] += ` ${line}`;
  }
  return bullets;
}

/** Splits section lines into entries, each starting at a header line (one that is not a bullet or continuation). */
function entries(lines: string[], isHeader: (l: string) => boolean): { header: string; body: string[] }[] {
  const out: { header: string; body: string[] }[] = [];
  for (const line of lines) {
    if (isHeader(line)) out.push({ header: line, body: [] });
    else out.at(-1)?.body.push(line);
  }
  return out;
}

const titleCase = (s: string) =>
  s === s.toUpperCase() ? s.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase()) : s;

export function parseResumeRules(text: string, links: string[], today = new Date()): Omit<CandidateProfile, 'sourceHash'> {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const sections = new Map<string, string[]>();
  let current = 'header';
  for (const line of lines) {
    if (HEADING.test(line)) {
      current = line.toLowerCase().replace(/^(technical|work|professional) /, '').replace(/s$/, '');
      if (current === 'employment') current = 'experience';
      continue;
    }
    if (!sections.has(current)) sections.set(current, []);
    sections.get(current)!.push(line);
  }
  const section = (name: string) => sections.get(name) ?? [];

  const mailto = links.find((l) => l.startsWith('mailto:'))?.slice(7);
  const tel = links.find((l) => l.startsWith('tel:'))?.slice(4);
  const contact = {
    email: mailto ?? text.match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0] ?? '',
    phone: text.match(/\+?\d[\d\s-]{8,}\d/)?.[0]?.trim() ?? tel ?? '',
    linkedin: links.find((l) => /linkedin\.com\/in\//i.test(l)) ?? '',
    github: links.find((l) => /github\.com\/[^/]+\/?$/i.test(l)) ?? '',
    links: links.filter((l) => /^https?:/i.test(l)),
  };

  const skillItems: string[] = [];
  const certifications: string[] = [];
  for (const line of section('skill')) {
    const [label, rest] = line.includes(':') ? [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1)] : ['', line];
    if (/certific/i.test(label)) certifications.push(...splitList(rest));
    else skillItems.push(...splitList(rest));
  }
  for (const line of section('certification')) certifications.push(...splitList(line.replace(/^[•\-*]\s*/, '')));

  const workHistory: WorkEntry[] = entries(section('experience'), (l) => DATE_RANGE.test(l) && !/^[•\-*]/.test(l)).map(
    ({ header, body }) => {
      const m = header.match(DATE_RANGE)!;
      const head = header.slice(0, m.index).trim();
      const [company = head, title = ''] = head.split(/\s+\|\s+|\s+[–—-]\s+|\s+at\s+/);
      return { company: company.trim(), title: title.trim(), start: m[1]!, end: m[3]!, highlights: collectBullets(body) };
    },
  );

  const education = entries(section('education'), (l) => DATE_RANGE.test(l)).map(({ header, body }) => {
    const m = header.match(DATE_RANGE)!;
    return { institution: header.slice(0, m.index).trim(), degree: body[0] ?? '', start: m[1]!, end: m[3]! };
  });

  const projects = entries(section('project'), (l) => !/^[•\-*]/.test(l) && /\|/.test(l)).map(({ header, body }) => {
    const [name = header, tech = ''] = header.split('|');
    return { name: name.trim(), tech: splitList(tech), highlights: collectBullets(body) };
  });

  const vocab = findSkills(text);
  const skills = [...new Set([...skillItems, ...vocab])];

  return {
    name: titleCase(section('header')[0] ?? ''),
    contact,
    summary: section('summary').join(' '),
    skills,
    yearsExperience: totalYears(workHistory.map((w) => [w.start, w.end]), today),
    education,
    workHistory,
    projects,
    certifications,
    rawText: text,
    parsedBy: 'rules',
  };
}

// ---------------------------------------------------------------- Claude parsing

const ClaudeProfileSchema = z.object({
  name: z.string(),
  summary: z.string().describe('2-3 sentence professional summary in third person'),
  skills: z.array(z.string()),
  yearsExperience: z.number().describe('Total professional experience in years, one decimal'),
  education: z.array(z.object({ institution: z.string(), degree: z.string(), start: z.string(), end: z.string() })),
  workHistory: z.array(
    z.object({ company: z.string(), title: z.string(), start: z.string(), end: z.string(), highlights: z.array(z.string()) }),
  ),
  projects: z.array(z.object({ name: z.string(), tech: z.array(z.string()), highlights: z.array(z.string()) })),
  certifications: z.array(z.string()),
});

async function parseResumeClaude(text: string, rules: Omit<CandidateProfile, 'sourceHash'>) {
  const today = new Date().toISOString().slice(0, 10);
  const parsed = await askStructured(ClaudeProfileSchema, {
    system:
      'You extract structured candidate profiles from resumes. Use only facts stated in the resume; ' +
      'never infer skills or experience that are not written there. Keep highlight wording close to the original.',
    user: `Today is ${today}. Compute yearsExperience from the employment date ranges (count "Present" as today).\n\n<resume>\n${text}\n</resume>`,
    effort: 'low',
  });
  return { ...rules, ...parsed, contact: rules.contact, rawText: text, parsedBy: 'claude' as const };
}

// ---------------------------------------------------------------- entry point

/**
 * Parses the resume (cached by file hash) and applies the overrides from config/profile.yaml.
 * Uses Claude when an API key is set, otherwise the rule-based parser.
 */
export async function loadProfile(opts: { refresh?: boolean; file?: string } = {}): Promise<CandidateProfile> {
  const file = opts.file ?? findResumeFile();
  const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
  const wantClaude = hasClaude();

  let profile: CandidateProfile | undefined;
  if (!opts.refresh && existsSync(paths.profileCache)) {
    const cached = JSON.parse(readFileSync(paths.profileCache, 'utf8')) as CandidateProfile;
    // Re-parse when the resume changed, or when a key was added since a rules-only parse.
    if (cached.sourceHash === hash && (cached.parsedBy === 'claude' || !wantClaude)) profile = cached;
  }

  if (!profile) {
    const { text, links } = await extractResume(file);
    const rules = parseResumeRules(text, links);
    let parsed: Omit<CandidateProfile, 'sourceHash'> = rules;
    if (wantClaude) {
      try {
        parsed = await parseResumeClaude(text, rules);
      } catch (err) {
        console.warn(`Claude resume parsing failed, using rule-based parse: ${(err as Error).message}`);
      }
    }
    profile = { ...parsed, sourceHash: hash };
    writeFileSync(paths.profileCache, JSON.stringify(profile, null, 2));
  }

  const facts = loadProfileFacts();
  const c = facts.contact;
  return {
    ...profile,
    name: c.full_name || profile.name,
    contact: {
      ...profile.contact,
      email: c.email || profile.contact.email,
      phone: c.phone || profile.contact.phone,
      linkedin: c.linkedin || profile.contact.linkedin,
      github: c.github || profile.contact.github,
    },
    yearsExperience: facts.years_experience_override ?? profile.yearsExperience,
    // Skills you confirmed in profile.yaml count as yours for scoring and "do you have X?" questions.
    skills: [...new Set([...profile.skills, ...facts.extra_skills])],
  };
}
