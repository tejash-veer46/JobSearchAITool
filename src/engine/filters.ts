// Cheap, explainable rules that run before any scoring. Every rejection carries
// a "category: detail" reason so the report can show why jobs were dropped.
import type { SearchConfig } from '../config.js';
import { normalize } from '../lib/text.js';
import type { RawJob } from '../types.js';
import { AUTOMATION_SKILLS, findSkills } from './skills.js';

export type FilterResult = { ok: true; minYears: number | null } | { ok: false; reason: string };

const QA_TITLE =
  /\b(qa|q\.a\.|sdet|quality assurance|quality engineer(ing)?|quality analyst|test(ing|er|ers)?|automation engineer|engineer in test|qe)\b/i;
const MANUAL_TITLE = /\bmanual\b/i;
const SENIOR_TITLE =
  /\b(senior|snr|sr\.?|lead|staff|principal|manager|mgr|head|director|architect|vp|vice president|chief|distinguished|fellow|expert)\b/i;
const HIGH_LEVEL = /\b(iii|iv|v)\b|\b(engineer|sdet|qa|analyst|tester|developer)[\s-]*[3-9]\b|\bl[5-9]\b/i;
const JUNIOR_ONLY = /\b(intern|internship|apprentice|trainee)\b/i;
// "Quality" and "test" titles from other industries.
const OTHER_DOMAIN =
  /\b(hardware|silicon|post-silicon|pre-silicon|asic|soc|vlsi|fpga|dft|rf|analog|mechanical|manufacturing|clinical|laboratory|lab|medical device|pharma|food|civil|electrical|quality control|qc inspector|supplier quality|quality inspector|customer quality|process quality|data quality|call quality|quality auditor|sales|marketing|content|teacher|tutor|driver|psychometric|exam|a\/b testing|rater|annotator|linguist|translator|hil|sil|mil|hardware-in-the-loop|mbd|adas|avionics|embedded|ecu|autosar|firmware)\b/i;

const INDIA =
  /\b(india|bengaluru|bangalore|hyderabad|secunderabad|pune|mumbai|navi mumbai|thane|gurgaon|gurugram|noida|delhi|new delhi|ncr|chennai|kolkata|ahmedabad|jaipur|kochi|cochin|trivandrum|thiruvananthapuram|coimbatore|indore|chandigarh|mohali|nagpur|vadodara|bhubaneswar|mysore|mysuru|visakhapatnam|vizag|lucknow|goa|karnataka|telangana|maharashtra|tamil nadu|haryana|kerala|gujarat|west bengal|uttar pradesh|rajasthan)\b/i;
const REMOTE = /\b(remote|anywhere|work from home|wfh|distributed)\b/i;
const GLOBAL = /\b(worldwide|anywhere|global(ly)?|apac|asia|asia[- ]pacific|international)\b/i;
const FOREIGN =
  /\b(united states|usa|u\.s\.a?\.?|canada|united kingdom|uk|england|europe|european|emea|eu|latam|latin america|americas|north america|germany|france|spain|poland|brazil|mexico|argentina|colombia|australia|new zealand|japan|singapore|philippines|netherlands|ireland|portugal|israel|romania|ukraine|south africa|nigeria|kenya|uae|dubai|saudi|pakistan|bangladesh|sri lanka|vietnam|indonesia|malaysia|china|korea|taiwan|turkey|italy|sweden|switzerland|denmark|norway|finland|belgium|austria|czech|cet|est|pst)\b/i;
const US_CODE = /\b(US|USA|CA|UK)\b/; // country codes, case-sensitive
const BASED_IN = /\b(must|should|need to|required to)\s+(be\s+)?(based|located|living|reside|residing)\s+in\b[^.\n]{0,80}/gi;

const YEARS =
  /(?:minimum(?: of)?|at least|min\.?)?\s*(\d{1,2})(?:\.\d)?\s*(?:\+|plus)?\s*(?:(?:-|–|to)\s*(\d{1,2})\s*)?\+?\s*(?:years?|yrs?)\b/gi;
const EXPERIENCE_CONTEXT =
  /experience|exp\b|hands[- ]on|background|working (in|with|as)|\b(in|of|with) (a |an )?(similar|software|qa|quality|test|testing|automation|manual|professional|relevant|industry)\b/i;
const PREFERRED_CONTEXT = /prefer|nice to have|bonus|plus\b|ideally|desirable/i;

export function isRelevantTitle(title: string, cfg: SearchConfig): string | null {
  const extraInclude = cfg.filters.extra_title_keywords.some((k) => title.toLowerCase().includes(k.toLowerCase()));
  const extraExclude = cfg.filters.extra_title_excludes.find((k) => title.toLowerCase().includes(k.toLowerCase()));
  if (extraExclude) return `title: excluded keyword "${extraExclude}"`;
  if (!QA_TITLE.test(title) && !extraInclude) return 'title: not a QA/testing role';
  if (OTHER_DOMAIN.test(title)) return `title: different field (${title.match(OTHER_DOMAIN)![0]})`;
  if (!cfg.filters.include_manual_qa && MANUAL_TITLE.test(title)) return 'title: manual-only role';
  return null;
}

export function seniorityProblem(title: string, hints: string[] = []): string | null {
  const senior = title.match(SENIOR_TITLE) ?? title.match(HIGH_LEVEL);
  if (senior) return `seniority: "${senior[0]}" in title`;
  if (JUNIOR_ONLY.test(title)) return 'seniority: internship/trainee role';
  const h = hints.map((x) => x.toLowerCase());
  if (h.length && h.every((x) => /senior|lead|manager|director|executive|principal/.test(x))) {
    return `seniority: listed as ${hints.join('/')}`;
  }
  return null;
}

/**
 * Minimum years of experience the posting requires, ignoring "preferred" mentions.
 * When several are listed (e.g. "5+ years software, 2+ years testing") the highest minimum wins.
 */
export function requiredYears(text: string): number | null {
  let best: number | null = null;
  for (const m of text.matchAll(YEARS)) {
    const min = Number(m[1]);
    if (!Number.isFinite(min) || min === 0 || min > 20) continue;
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const before = text.slice(Math.max(0, start - 60), start);
    const after = text.slice(end, end + 80);
    if (!EXPERIENCE_CONTEXT.test(before + m[0] + after)) continue;
    // "3+ years ... is a plus" / "ideally 5 years": not a hard requirement.
    const sameClause = after.split(/[.;\n]/)[0] ?? '';
    if (PREFERRED_CONTEXT.test(sameClause) || /prefer|ideally|nice to have/i.test(before.slice(-30))) continue;
    best = best === null ? min : Math.max(best, min);
  }
  return best;
}

export function locationProblem(job: Pick<RawJob, 'location' | 'description' | 'workplace'>): string | null {
  const loc = job.location;
  const desc = job.description;

  for (const m of desc.matchAll(BASED_IN)) {
    if (FOREIGN.test(m[0]) && !INDIA.test(m[0])) return `location: posting says "${m[0].trim().slice(0, 70)}"`;
  }

  if (INDIA.test(loc)) return null;
  // A source-supplied country code, e.g. Lever's "Buenos Aires (AR)".
  const country = loc.match(/\(([A-Z]{2})\)\s*$/)?.[1];
  if (country && country !== 'IN') return `location: outside India (${loc})`;
  const remote = REMOTE.test(loc) || job.workplace === 'remote';
  if (remote) {
    if (GLOBAL.test(loc)) return null;
    if (FOREIGN.test(loc) || US_CODE.test(loc)) return `location: remote, but limited to ${loc}`;
    // Bare "Remote": only keep it when the posting mentions India or a worldwide scope.
    if (INDIA.test(desc) || GLOBAL.test(desc)) return null;
    return `location: remote, region not stated (${loc || 'blank'})`;
  }
  if (!loc.trim()) return INDIA.test(desc) ? null : 'location: not stated';
  return `location: outside India (${loc})`;
}

export function blacklistHit(company: string, blacklist: string[]): string | null {
  const name = ` ${normalize(company)} `;
  const hit = blacklist.find((b) => normalize(b) && name.includes(` ${normalize(b)} `));
  return hit ? `blacklist: ${hit}` : null;
}

export function staleProblem(postedAt: string | null | undefined, maxAgeDays: number, now = Date.now()): string | null {
  if (!postedAt) return null;
  const ageDays = (now - new Date(postedAt).getTime()) / 86_400_000;
  return ageDays > maxAgeDays ? `stale: posted ${Math.floor(ageDays)} days ago` : null;
}

// Company career boards drop closed jobs, so an old posting date there still means "open".
const LIVE_BOARDS = new Set(['greenhouse', 'lever', 'ashby', 'smartrecruiters']);

export function filterJob(job: RawJob, cfg: SearchConfig): FilterResult {
  const problem =
    blacklistHit(job.company, cfg.blacklist_companies) ??
    isRelevantTitle(job.title, cfg) ??
    seniorityProblem(job.title, job.seniorityHints) ??
    locationProblem(job) ??
    (LIVE_BOARDS.has(job.platform) ? null : staleProblem(job.postedAt, cfg.filters.max_age_days));
  if (problem) return { ok: false, reason: problem };

  // "Automation Engineer" alone can mean RPA or workflow automation: require a test tool in the posting.
  const testTitle = /\b(qa|qe|sdet|test|tests|testing|tester|quality)\b/i.test(job.title);
  if (!testTitle && !findSkills(job.description).some((s) => AUTOMATION_SKILLS.has(s))) {
    return { ok: false, reason: 'title: automation role without a test-automation stack' };
  }

  const minYears = requiredYears(`${job.title}\n${job.description}`);
  if (minYears !== null && minYears > cfg.filters.max_required_years) {
    return { ok: false, reason: `experience: needs ${minYears}+ years (max ${cfg.filters.max_required_years})` };
  }
  return { ok: true, minYears };
}

export const reasonCategory = (reason: string) => reason.split(':')[0] ?? reason;
