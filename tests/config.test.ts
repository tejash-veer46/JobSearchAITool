import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ensureConfigFile, parseProfileFacts, parseSearchConfig, paths, syncSearchConfig } from '../src/config.js';

const example = (name: string) => parse(readFileSync(path.join(paths.config, name), 'utf8'));

describe('example config files (what a new user starts from)', () => {
  it('search.example.yaml is valid, has sources, and an empty blacklist', () => {
    const cfg = parseSearchConfig(example('search.example.yaml'));
    expect(cfg.blacklist_companies).toEqual([]);
    expect(cfg.sources.greenhouse.length + cfg.sources.lever.length + cfg.sources.ashby.length).toBeGreaterThan(50);
  });

  it('profile.example.yaml is valid and contains no personal facts', () => {
    const facts = parseProfileFacts(example('profile.example.yaml'));
    expect(facts.contact).toMatchObject({ full_name: '', email: '', phone: '', current_city: '' });
    expect(facts.compensation).toEqual({ expected_ctc_inr: null, expected_negotiable: null, current_ctc_inr: null });
    expect(facts.notice_period_days).toBeNull();
    expect(facts.gender).toBeNull();
    expect(facts.saved_answers).toEqual([]);
  });

  it('sync-config adds new companies and settings but keeps your own edits and comments', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'jaa-sync-'));
    writeFileSync(
      path.join(dir, 'search.example.yaml'),
      'filters:\n  max_required_years: 3\nbatch:\n  size: 20\n  include_near_misses: true\nsources:\n  lever:\n    - { slug: acme, name: Acme }\n    - { slug: globex, name: Globex }\n  smartrecruiters:\n    - { slug: Initech, name: Initech }\n',
    );
    writeFileSync(path.join(dir, 'search.yaml'), '# my settings\nfilters:\n  max_required_years: 4 # I have 3 years\nbatch:\n  size: 10\nsources:\n  lever:\n    - { slug: acme, name: Acme }\n    - { slug: mine, name: Mine }\n');
    const added = syncSearchConfig(dir);
    expect(added).toEqual({ companies: ['lever/globex', 'smartrecruiters/Initech'], settings: ['batch.include_near_misses'] });
    const text = readFileSync(path.join(dir, 'search.yaml'), 'utf8');
    expect(text).toContain('# my settings');
    expect(text).toContain('# I have 3 years');
    const cfg = parseSearchConfig(parse(text));
    expect(cfg.filters.max_required_years).toBe(4); // your value wins
    expect(cfg.batch).toMatchObject({ size: 10, include_near_misses: true });
    expect(cfg.sources.lever.map((c) => c.slug)).toEqual(['acme', 'mine', 'globex']);
    expect(cfg.sources.smartrecruiters.map((c) => c.slug)).toEqual(['Initech']);
    expect(syncSearchConfig(dir)).toEqual({ companies: [], settings: [] }); // idempotent
  });

  it('first run creates your own copy from the example, and never overwrites it', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'jaa-cfg-'));
    copyFileSync(path.join(paths.config, 'profile.example.yaml'), path.join(dir, 'profile.example.yaml'));
    const own = ensureConfigFile('profile.yaml', dir);
    expect(existsSync(own)).toBe(true);
    expect(readFileSync(own, 'utf8')).toBe(readFileSync(path.join(dir, 'profile.example.yaml'), 'utf8'));
  });
});
