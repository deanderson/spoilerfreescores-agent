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
import { createHash } from 'node:crypto';
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

// ── Snapshot freshness ───────────────────────────────────────────────────────
// The differential test is only meaningful against the CURRENT site layer. A
// stale snapshot doesn't fail it — it makes it pass while comparing the port to
// a frozen past. So freshness is checked before test 1 runs, and test 1 reports
// UNVERIFIED rather than PASS when it can't be trusted.

const MAX_AGE_DAYS = 14;
let snapshotOK = true;

{
  const head = html.slice(0, 400);
  const fetched = head.match(/^fetched: (\S+)$/m)?.[1];
  const declaredSha = head.match(/^block-sha256: (\S+)$/m)?.[1];

  if (!fetched || !declaredSha) {
    snapshotOK = false;
    fail('snapshot', 'no generated header — run scripts/refresh-snapshot.sh');
  } else {
    // The header must describe the file it sits in. A mismatch means someone
    // edited one without the other, which is exactly what the header exists to
    // make impossible to do silently.
    const actualSha = createHash('sha256').update(block).digest('hex');
    if (actualSha !== declaredSha) {
      snapshotOK = false;
      fail('snapshot', `header does not match file contents — hand-edited?\n`
        + `        header: ${declaredSha}\n        actual: ${actualSha}`);
    }

    const ageDays = (Date.now() - Date.parse(fetched)) / 86_400_000;
    if (!Number.isFinite(ageDays)) {
      snapshotOK = false;
      fail('snapshot', `unparseable fetched date: ${fetched}`);
    } else if (ageDays > MAX_AGE_DAYS) {
      snapshotOK = false;
      fail('snapshot', `snapshot is ${ageDays.toFixed(0)} days old (limit ${MAX_AGE_DAYS}) `
        + `— run scripts/refresh-snapshot.sh`);
    } else if (snapshotOK) {
      console.log(`Snapshot: ${ageDays.toFixed(1)} days old, block sha ${declaredSha.slice(0, 16)}`);
    }
  }
}

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
  if (drifted === 0) {
    console.log(snapshotOK
      ? '  PASS — no undeclared drift'
      : '  UNVERIFIED — no drift vs the snapshot, but the snapshot is not trustworthy');
  }
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

// ── Test 4: override coverage ────────────────────────────────────────────────
// The NCAAF fixture exercises none of the four overridden labels, so tests 1-3
// pass whether or not the override table works. Synthetic factors close that.
//
// The failure this is really aimed at: a key that doesn't match anything in the
// site map. That override silently does nothing, the differential test still
// reports a clean diff, and the digit ships.

console.log('\n4. Override coverage (synthetic)');
{
  const entries = Object.entries(WORKER_OVERRIDES);
  console.log(`  ${entries.length} declared overrides`);

  for (const [label, expected] of entries) {
    const before_failures = failures;
    const factors = [{ label, points: 10 }];
    // Sport is irrelevant to these labels: the only sport-dependent branch in
    // getInsightPhrases is the wnba/nba lead-change suppression, which applies
    // to three closeness phrases, none of them overridden.
    const sport = 'ncaaf';

    // 4a. The key must be reachable in the site's map, or the override is a
    //     no-op against a label that never existed.
    if (!Object.prototype.hasOwnProperty.call(site.INSIGHT_MAP, label)) {
      fail('override', `key not present in site INSIGHT_MAP — no-op override: ${JSON.stringify(label)}`);
      continue;
    }

    // 4b. The site must actually emit something here. If it emits nothing, the
    //     override is unnecessary and the table is carrying dead weight.
    const before = site.getInsightPhrases(factors, sport);
    if (before.length === 0) {
      fail('override', `site emits nothing for ${JSON.stringify(label)} — override is dead weight`);
      continue;
    }

    // 4c. The port must emit exactly what the table declares.
    const after = getInsightPhrases(factors, sport);
    const want = expected === null ? [] : [expected];
    if (JSON.stringify(after) !== JSON.stringify(want)) {
      fail('override', `${JSON.stringify(label)}\n        want: ${JSON.stringify(want)}\n        got:  ${JSON.stringify(after)}`);
      continue;
    }

    // 4d. The override must have changed something. Identical output means the
    //     row is inert.
    if (JSON.stringify(before) === JSON.stringify(after)) {
      fail('override', `${JSON.stringify(label)} produces identical output — inert override`);
      continue;
    }

    // 4e. Every override exists to remove a digit. Confirm the site had one and
    //     the port does not.
    const siteHadDigit = before.some(p => /\d/.test(p));
    const portHasDigit = after.some(p => /\d/.test(p));
    if (!siteHadDigit) fail('override', `${JSON.stringify(label)}: site phrase had no digit — why is this overridden?`);
    if (portHasDigit) fail('override', `${JSON.stringify(label)}: port phrase still contains a digit`);

    const mark = failures === before_failures ? 'OK  ' : '    ';
    console.log(`  ${mark}${JSON.stringify(label)}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  }
}

console.log(failures ? `\n${failures} failure(s)\n` : '\nAll tests passed\n');
process.exit(failures ? 1 : 0);
