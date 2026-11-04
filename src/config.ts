import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMap, isSeq, parseDocument, parse as parseYaml, type YAMLSeq } from 'yaml';
import { z } from 'zod';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const paths = {
  root: ROOT,
  config: path.join(ROOT, 'config'),
  data: path.join(ROOT, 'data'),
  reports: path.join(ROOT, 'reports'),
  db: path.join(ROOT, 'data', 'jobs.db'),
  profileCache: path.join(ROOT, 'data', 'profile.json'),
  browserProfile: path.join(ROOT, 'browser-profile'),
};

const envFile = path.join(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

export const env = {
  anthropicKey: process.env.ANTHROPIC_API_KEY?.trim() || '',
  claudeModel: process.env.CLAUDE_MODEL?.trim() || 'claude-sonnet-5-5',
  adzunaId: process.env.ADZUNA_APP_ID?.trim() || '',
  adzunaKey: process.env.ADZUNA_APP_KEY?.trim() || '',
  resumePath: path.resolve(ROOT, process.env.RESUME_PATH?.trim() || 'resume'),
  /** chrome, msedge, or chromium (Playwright's own build, needs `npx playwright-core install chromium`). */
  browserChannel: process.env.BROWSER_CHANNEL?.trim() || 'chrome',
  dashboardPort: Number(process.env.DASHBOARD_PORT) || 4317,
};

const company = z.object({ slug: z.string(), name: z.string() });

const SearchSchema = z.object({
  filters: z
    .object({
      max_required_years: z.number().default(3),
      max_age_days: z.number().default(30),
      extra_title_keywords: z.array(z.string()).default([]),
      extra_title_excludes: z.array(z.string()).default([]),
      include_manual_qa: z.boolean().default(true),
    })
    .prefault({}),
  scoring: z
    .object({
      qualify_threshold: z.number().min(0).max(100).default(75),
      max_scored_per_run: z.number().int().positive().default(60),
    })
    .prefault({}),
  batch: z
    .object({
      size: z.number().int().min(1).max(50).default(20),
      auto_start: z.boolean().default(true),
      // Near misses on fully fillable sites (Greenhouse/Lever/Ashby) join batches after ready jobs.
      include_near_misses: z.boolean().default(true),
      near_miss_min_score: z.number().min(0).max(100).default(65),
    })
    .prefault({}),
  blacklist_companies: z.array(z.string()).default([]),
  sources: z
    .object({
      greenhouse: z.array(company).default([]),
      lever: z.array(company).default([]),
      ashby: z.array(company).default([]),
      smartrecruiters: z.array(company).default([]),
      himalayas: z.object({ enabled: z.boolean().default(true), queries: z.array(z.string()).default([]) }).prefault({}),
      remotive: z.object({ enabled: z.boolean().default(true), categories: z.array(z.string()).default(['qa']) }).prefault({}),
      adzuna: z.object({ enabled: z.boolean().default(true), queries: z.array(z.string()).default([]) }).prefault({}),
    })
    .prefault({}),
});

const ProfileSchema = z.object({
  contact: z
    .object({
      full_name: z.string().default(''),
      email: z.string().default(''),
      phone: z.string().default(''),
      linkedin: z.string().default(''),
      github: z.string().default(''),
      current_city: z.string().default(''),
    })
    .prefault({}),
  preferences: z
    .object({
      locations: z.array(z.string()).default(['India', 'Remote']),
      willing_to_relocate: z.boolean().nullable().default(null),
      workplace: z.array(z.string()).default(['onsite', 'hybrid', 'remote']),
      office_ok: z.boolean().nullable().default(null),
      shifts_ok: z.boolean().nullable().default(null),
    })
    .prefault({}),
  compensation: z
    .object({
      expected_ctc_inr: z.number().nullable().default(null),
      expected_negotiable: z.boolean().nullable().default(null),
      current_ctc_inr: z.number().nullable().default(null),
    })
    .prefault({}),
  notice_period_days: z.number().nullable().default(null),
  serving_notice: z.boolean().nullable().default(null),
  offer_in_hand: z.boolean().nullable().default(null),
  work_authorization: z.string().default(''),
  requires_sponsorship: z.boolean().nullable().default(null),
  education: z
    .object({
      degree: z.string().default(''),
      institution: z.string().default(''),
      graduation_year: z.number().nullable().default(null),
      cgpa: z.string().default(''),
      class_10_percent: z.string().default(''),
      class_12_percent: z.string().default(''),
      gap: z.string().default(''),
    })
    .prefault({}),
  languages: z.array(z.string()).default([]),
  address: z.string().default(''),
  family_at_company: z.boolean().nullable().default(null),
  extra_skills: z.array(z.string()).default([]),
  years_experience_override: z.number().nullable().default(null),
  gender: z.string().nullable().default(null),
  disability: z.string().nullable().default(null),
  self_identification: z.enum(['decline', 'ask']).default('decline'),
  heard_about: z.array(z.string()).default([]),
  standard_answers: z
    .object({
      why_change: z.string().nullable().default(null),
      about_me: z.string().nullable().default(null),
      service_bond: z.string().nullable().default(null),
    })
    .prefault({}),
  saved_answers: z.array(z.object({ question: z.string(), answer: z.string() })).default([]),
});

export type SearchConfig = z.infer<typeof SearchSchema>;
export type ProfileFacts = z.infer<typeof ProfileSchema>;

/**
 * Your own config files (profile.yaml, search.yaml) are git-ignored. On first run they are
 * created from the committed *.example.yaml next to them.
 */
export function ensureConfigFile(file: string, dir = paths.config): string {
  const full = path.join(dir, file);
  const example = path.join(dir, file.replace(/\.yaml$/, '.example.yaml'));
  if (!existsSync(full) && existsSync(example)) copyFileSync(example, full);
  return full;
}

function loadYaml<T>(file: string, schema: z.ZodType<T>): T {
  const full = ensureConfigFile(file);
  const raw = existsSync(full) ? parseYaml(readFileSync(full, 'utf8')) : {};
  const result = schema.safeParse(raw ?? {});
  if (!result.success) {
    throw new Error(`Invalid config/${file}:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/**
 * Brings your own config/search.yaml up to date with search.example.yaml after an update:
 * adds companies (by slug) and settings that are new in the example. Your own values, comments
 * and additions are kept. To stop a company coming back, add it to blacklist_companies.
 */
export function syncSearchConfig(dir = paths.config): { companies: string[]; settings: string[] } {
  const own = ensureConfigFile('search.yaml', dir);
  const examplePath = path.join(dir, 'search.example.yaml');
  const added = { companies: [] as string[], settings: [] as string[] };
  if (!existsSync(examplePath)) return added;
  const doc = parseDocument(readFileSync(own, 'utf8'));
  const example = parseYaml(readFileSync(examplePath, 'utf8')) as Record<string, unknown>;

  // New settings inside filters / scoring / batch (never overwrites a value you set).
  for (const section of ['filters', 'scoring', 'batch']) {
    const values = example[section] as Record<string, unknown> | undefined;
    for (const [key, value] of Object.entries(values ?? {})) {
      if (!doc.hasIn([section, key])) {
        doc.setIn([section, key], value);
        added.settings.push(`${section}.${key}`);
      }
    }
  }
  // New company boards.
  const sources = (example.sources ?? {}) as Record<string, unknown>;
  for (const [source, list] of Object.entries(sources)) {
    if (!Array.isArray(list)) {
      if (!doc.hasIn(['sources', source])) {
        doc.setIn(['sources', source], list);
        added.settings.push(`sources.${source}`);
      }
      continue;
    }
    if (!doc.hasIn(['sources', source])) doc.setIn(['sources', source], doc.createNode([]));
    const seq = doc.getIn(['sources', source]) as YAMLSeq;
    const have = new Set(seq.items.map((i) => (isMap(i) ? String(i.get('slug')).toLowerCase() : '')));
    for (const c of list as { slug: string; name: string }[]) {
      if (have.has(c.slug.toLowerCase())) continue;
      const node = doc.createNode({ slug: c.slug, name: c.name });
      node.flow = true;
      seq.add(node);
      added.companies.push(`${source}/${c.slug}`);
    }
  }
  if (added.companies.length || added.settings.length) writeFileSync(own, doc.toString());
  return added;
}

export const parseSearchConfig = (raw: unknown) => SearchSchema.parse(raw ?? {});
export const parseProfileFacts = (raw: unknown) => ProfileSchema.parse(raw ?? {});
export const loadSearchConfig = () => loadYaml('search.yaml', SearchSchema);
export const loadProfileFacts = () => loadYaml('profile.yaml', ProfileSchema);

/**
 * Adds (or updates) a reusable screening answer in config/profile.yaml,
 * keeping the file's comments and layout.
 */
export function saveAnswer(question: string, answer: string, file = ensureConfigFile('profile.yaml')): void {
  const doc = parseDocument(existsSync(file) ? readFileSync(file, 'utf8') : '');
  let list = doc.get('saved_answers');
  if (!isSeq(list)) {
    doc.set('saved_answers', doc.createNode([]));
    list = doc.get('saved_answers');
  }
  const seq = list as YAMLSeq;
  seq.flow = false;
  const existing = seq.items.find((item) => isMap(item) && String(item.get('question')).toLowerCase() === question.toLowerCase());
  if (existing && isMap(existing)) existing.set('answer', answer);
  else seq.add(doc.createNode({ question, answer }));
  writeFileSync(file, doc.toString());
}
