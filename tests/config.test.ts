import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ensureConfigFile, parseProfileFacts, parseSearchConfig, paths } from '../src/config.js';

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

  it('first run creates your own copy from the example, and never overwrites it', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'jaa-cfg-'));
    copyFileSync(path.join(paths.config, 'profile.example.yaml'), path.join(dir, 'profile.example.yaml'));
    const own = ensureConfigFile('profile.yaml', dir);
    expect(existsSync(own)).toBe(true);
    expect(readFileSync(own, 'utf8')).toBe(readFileSync(path.join(dir, 'profile.example.yaml'), 'utf8'));
  });
});
