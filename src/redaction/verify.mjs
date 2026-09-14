/**
 * Step 1 verification harness.
 *
 *   node verify.mjs <path-to-index.html> <path-to-fixture.json>
 *
 * Three tests, per spec §10.1:
 *   1. Differential — site layer vs ported layer over the fixture. Identical
 *      game-for-game except where WORKER_OVERRIDES declares a divergence.
 *   2. Invariant  — no digits in the emittable VOCABULARY. Not in fixture
 *      output: fixture output is NCAAF-only and passes while tennis entries
 *      carry digits. Vocabulary-level or it proves nothing.
 *   3. Tier       — no Tier 2 field, no raw factor label, in any safe view.
 */

import { readFileSync } from 'node:fs';
import {
  INSIGHT_MAP, WORKER_OVERRIDES, formatDynamicLabel,
  getInsightPhrases, buildSafeView, TIER1_FIELDS,
} from './redaction.js';

const [htmlPath, fixturePath] = process.argv.slice(2);
if (!htmlPath || !fixturePath) {
  console.error('usage: node verify.mjs <index.html> <fixture.json>');
  process.exit(2);
}

const SPORT = 'ncaaf';
let failures = 0;
const fail = (test, msg) => { failures++; console.log(`  FAIL [${test}] ${msg}`); };

// ── Load the site's live layer by extracting it from index.html ──────────────
// Extracted, not copy-pasted: a stale copy would make the differential test
// compare the port against itself.

const html = readFileSync(htmlPath, 'utf8');
const start = html.indexOf('const INSIGHT_MAP = {');
const endMarker = '\n  function buildInsightHTML(';
const end = html.indexOf(endMarker);
if (start === -1 || end === -1 || end < start) {
  console.error('Could not locate the redaction block in index.html. '
    + 'If the site moved it, fix the markers here rather than pasting a copy.');
  process.exit(2);
}
const block = html.slice(start, end);
const site = await import(
  'data:text/javascript,' + encodeURIComponent(
    block + '\nexport {INSIGHT_MAP, formatDynamicLabel, getInsightPhrases};'
  )
);

// ── Fixture ──────────────────────────────────────────────────────────────────

const raw = JSON.parse(readFileSync(fixturePath, 'utf8'));
const games = raw[SPORT]?.recent ?? raw.recent ?? raw;
if (!Array.isArray(games)) { console.error('Unexpected fixture shape'); process.exit(2); }
const recommendable = games.filter(g => buildSafeView(g, SPORT) !== null);

console.log(`\nFixture: ${games.length} games, ${recommendable.length} recommendable\n`);

// ── Test 1: differential ─────────────────────────────────────────────────────

console.log('1. Differential (site vs port)');
{
  const overridden = new Set(Object.keys(WORKER_OVERRIDES));
  let drifted = 0, declared = 0;

  for (const g of games) {
    const factors = g.confidence?.factors ?? [];
    const a = site.getInsightPhrases(factors, SPORT).join(' | ');
    const b = getInsightPhrases(factors, SPORT).join(' | ');
    if (a === b) continue;

    const touched = factors.some(f => overridden.has(f.label));
    if (touched) { declared++; continue; }
    drifted++;
    fail('differential', `${g.id} ${g.away} @ ${g.home}\n        site: ${a}\n        port: ${b}`);
  }
  console.log(`  ${games.length - drifted - declared} identical, `
    + `${declared} differ via declared override, ${drifted} drifted`);
  if (drifted === 0) console.log('  PASS — no undeclared drift');
}

// ── Test 2: invariant, over the vocabulary ───────────────────────────────────

console.log('\n2. Invariant 1 (no digits describing play)');
{
  const emittable = new Set();

  // Every non-null value the map can return.
  for (const v of Object.values(INSIGHT_MAP)) if (v) emittable.add(v);

  // Every string literal formatDynamicLabel can return. Source-scanned so a
  // new return added later is picked up without editing this test.
  const src = formatDynamicLabel.toString();
  for (const m of src.matchAll(/return\s+'([^']*)'/g)) if (m[1]) emittable.add(m[1]);
  const ternary = src.matchAll(/\?\s*'([^']*)'\s*:\s*'([^']*)'/g);
  for (const m of ternary) { emittable.add(m[1]); emittable.add(m[2]); }

  const offenders = [...emittable].filter(p => /\d/.test(p));
  console.log(`  ${emittable.size} emittable phrases scanned`);
  if (offenders.length) {
    for (const o of offenders) fail('invariant', `digit in phrase: ${JSON.stringify(o)}`);
  } else {
    console.log('  PASS — no digits in any emittable phrase');
  }

  // Belt-and-braces: fixture output too, so a bug in the scan above shows up.
  let emitted = 0;
  for (const g of recommendable) {
    for (const p of buildSafeView(g, SPORT).phrases) if (/\d/.test(p)) emitted++;
  }
  if (emitted) fail('invariant', `${emitted} digit-bearing phrases emitted on fixture`);
}

// ── Test 3: tier ─────────────────────────────────────────────────────────────

console.log('\n3. Tier boundary');
{
  const TIER2 = [
    'h', 'a', 'period', 'homeLinescores', 'awayLinescores', 'resultType',
    'resultMargin', 'maxInnings', 'timelineCat', 'debug', 'confidence',
    'homeRushYds', 'awayRushYds', 'homePassYds', 'awayPassYds',
    'maxRushLeader', 'maxRecvLeader', 'factors',
  ];
  const allowed = new Set([...TIER1_FIELDS, 'cls', 'phrases']);
  // Some labels are identity-mapped ('Big rushing game' -> 'Big rushing game').
  // Those are whitelisted phrases that happen to equal their label, not leaks.
  // The condition is a label surfacing that is NOT an approved phrase.
  const approvedPhrases = new Set(Object.values(INSIGHT_MAP).filter(Boolean));

  let leaks = 0;
  for (const g of recommendable) {
    const view = buildSafeView(g, SPORT);
    const json = JSON.stringify(view);

    for (const k of Object.keys(view)) {
      if (!allowed.has(k)) { leaks++; fail('tier', `${g.id}: unexpected field "${k}"`); }
    }
    for (const k of TIER2) {
      if (k in view) { leaks++; fail('tier', `${g.id}: tier-2 field "${k}" present`); }
    }
    for (const f of g.confidence?.factors ?? []) {
      if (f.label && json.includes(f.label) && !approvedPhrases.has(f.label)) {
        leaks++; fail('tier', `${g.id}: raw factor label leaked: ${f.label}`);
      }
      if (f.points !== undefined && json.includes('"points"')) {
        leaks++; fail('tier', `${g.id}: points weight present`);
      }
    }
  }
  if (!leaks) console.log(`  PASS — ${recommendable.length} safe views, no tier-2 field or raw label`);
}

console.log(failures ? `\n${failures} failure(s)\n` : '\nAll tests passed\n');
process.exit(failures ? 1 : 0);
