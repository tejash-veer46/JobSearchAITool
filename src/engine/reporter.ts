import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { env, paths, type ProfileFacts } from '../config.js';
import type { JobRow, JobStore } from '../db.js';
import { hasClaude } from '../lib/claude.js';
import { ASK_USER } from './matcher.js';

export interface RunStats {
  startedAt: string;
  finishedAt?: string;
  fetched: number;
  new: number;
  seen: number;
  duplicates: number;
  filteredOut: number;
  filterReasons: Record<string, number>;
  scored: number;
  staged: number;
  scoreRejected: number;
  perSource: Record<string, number>;
  sourceErrors: { source: string; target: string; message: string }[];
  skippedSources: string[];
}

export const emptyStats = (): RunStats => ({
  startedAt: new Date().toISOString(),
  fetched: 0,
  new: 0,
  seen: 0,
  duplicates: 0,
  filteredOut: 0,
  filterReasons: {},
  scored: 0,
  staged: 0,
  scoreRejected: 0,
  perSource: {},
  sourceErrors: [],
  skippedSources: [],
});

const cell = (s: string | number | null | undefined) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : '');
const csvCell = (s: unknown) => `"${String(s ?? '').replace(/"/g, '""')}"`;

function jobTable(jobs: JobRow[], withApplied = false): string {
  if (!jobs.length) return '_None._\n';
  const head = withApplied
    ? '| ID | Company | Title | Match % | Status | Applied | Link |\n|---:|---|---|---:|---|---|---|'
    : '| ID | Company | Title | Location | Match % | Posted | Link |\n|---:|---|---|---|---:|---|---|';
  const rows = jobs.map((j) =>
    withApplied
      ? `| ${j.id} | ${cell(j.company)} | ${cell(j.title)} | ${j.match_score ?? ''} | ${j.status} | ${day(j.applied_at)} | [open](${j.apply_url ?? j.url}) |`
      : `| ${j.id} | ${cell(j.company)} | ${cell(j.title)} | ${cell(j.location)} | ${j.match_score ?? ''} | ${day(j.posted_at ?? j.first_seen_at)} | [open](${j.apply_url ?? j.url}) |`,
  );
  return `${head}\n${rows.join('\n')}\n`;
}

function topMissingSkills(jobs: JobRow[], n = 8): [string, number][] {
  const counts = new Map<string, number>();
  for (const j of jobs) for (const s of j.missing_skills) counts.set(s, (counts.get(s) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

export interface ReportFiles {
  markdown: string;
  json: string;
  csv: string;
}

export function writeReport(store: JobStore, stats: RunStats, facts: ProfileFacts, now = new Date(), dir = paths.reports): ReportFiles {
  mkdirSync(dir, { recursive: true });
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const stamp = `${date}_${time.replace(':', '')}`;
  const staged = store.list(['STAGED']);
  const applied = store.list(['APPLIED', 'FAILED']);
  const nearMisses = store
    .list(['REJECTED'])
    .filter((j) => j.reject_stage === 'score' && (j.match_score ?? 0) >= 60)
    .slice(0, 15);
  const totals = store.counts();

  const actions: string[] = [];
  if (staged.length) {
    actions.push(
      `**${staged.length} job(s) ready to apply.** Open each link, apply, then record it: \`npm run cli -- mark <ID> applied\`.`,
    );
  }
  const unknown = new Set(staged.flatMap((j) => j.tailored_answers.filter((a) => a.answer === ASK_USER).map((a) => a.question)));
  if (unknown.size) {
    actions.push(`Fill these in \`config/profile.yaml\` so screening answers are complete: ${[...unknown].join('; ')}.`);
  }
  const missing = topMissingSkills(staged);
  if (missing.length) {
    actions.push(
      `Skills these jobs ask for that your resume doesn't show: ${missing.map(([s, n]) => `${s} (${n})`).join(', ')}. ` +
        'If you have any of them, add them to your resume.',
    );
  }
  if (!hasClaude()) actions.push('Scores come from keyword rules. Add `ANTHROPIC_API_KEY` to `.env` for Claude scoring, then run `npm run cli -- score --rescore`.');
  for (const s of stats.skippedSources) actions.push(`Source skipped: ${s}.`);
  for (const e of stats.sourceErrors) actions.push(`Source failed: ${e.source}/${e.target} - ${e.message}.`);

  const reasons = Object.entries(stats.filterReasons).sort((a, b) => b[1] - a[1]);
  const md = [
    `# JobApplyAI report - ${date} ${time}`,
    '',
    `Scoring: ${hasClaude() ? `Claude (${env.claudeModel})` : 'keyword rules (no Anthropic API key)'}`,
    '',
    '## This run',
    '',
    '| Postings fetched | New | Already known | Cross-site duplicates | Filtered out | Scored | Staged | Below threshold |',
    '|---:|---:|---:|---:|---:|---:|---:|---:|',
    `| ${stats.fetched} | ${stats.new} | ${stats.seen} | ${stats.duplicates} | ${stats.filteredOut} | ${stats.scored} | ${stats.staged} | ${stats.scoreRejected} |`,
    '',
    `By source: ${Object.entries(stats.perSource).map(([s, n]) => `${s} ${n}`).join(', ') || 'none'}`,
    '',
    reasons.length ? `Filtered out because of: ${reasons.map(([r, n]) => `${r} ${n}`).join(', ')}` : '',
    '',
    '## Action items',
    '',
    ...(actions.length ? actions.map((a) => `- ${a}`) : ['- Nothing to do.']),
    '',
    `## Ready to apply (${staged.length})`,
    '',
    jobTable(staged),
    `## Near misses: scored 60 or more but below the threshold (${nearMisses.length})`,
    '',
    'Worth a manual look; the keyword scorer can under-rate good matches.',
    '',
    jobTable(nearMisses),
    `## Applications so far (${applied.length})`,
    '',
    jobTable(applied, true),
    '## All-time totals',
    '',
    Object.entries(totals).map(([s, n]) => `${s} ${n}`).join(' · '),
    '',
  ].join('\n');

  const files: ReportFiles = {
    markdown: path.join(dir, `report_${stamp}.md`),
    json: path.join(dir, 'applications_report.json'),
    csv: path.join(dir, `report_${stamp}.csv`),
  };
  writeFileSync(files.markdown, md);

  const exported = [...staged, ...applied, ...nearMisses].map(({ description, ...j }) => j);
  writeFileSync(files.json, JSON.stringify({ generatedAt: now.toISOString(), run: stats, totals, jobs: exported }, null, 2));

  const cols = ['id', 'status', 'match_score', 'company', 'title', 'location', 'platform', 'posted_at', 'applied_at', 'url', 'missing_skills', 'short_pitch'] as const;
  const csv = [
    cols.join(','),
    ...[...staged, ...applied].map((j) => cols.map((c) => csvCell(Array.isArray(j[c]) ? (j[c] as string[]).join('; ') : j[c])).join(',')),
  ].join('\n');
  writeFileSync(files.csv, csv);
  return files;
}
