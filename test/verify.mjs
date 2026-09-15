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
} from '../src/guard/redaction.js';
import { deriveTags, TAG_VOCAB } from '../src/guard/tags.js';
import { searchGames, MIN_CORPUS, searchGamesInput, savePreferenceInput, repairToolInput, CATEGORY_LABEL, toResult, RECOMMENDABLE_CLS } from '../src/guard/tools.js';
import { createScanner, findViolation, createScanTransform, FLOOR_LINE } from '../src/guard/scanner.js';
import { dedupeAIStream, rewriteFrame, createFrameWatcher } from '../src/ai-stream-fix.js';

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

// ── Test 5: oracle resistance ────────────────────────────────────────────────
// §6.1. This is the test that fails if someone turns prefer_teams back into a
// WHERE clause. The property is not "empty results are handled nicely" — it is
// that result-set size carries no information about the query at all.
//
// A prompt instruction cannot achieve this. If the tool can return fewer games
// for one team than another, the user learns something about that team's games
// no matter what the model is told to say.

console.log('\n5. Oracle resistance (team boost, §6.1)');
{
  const corpus = [];
  for (const g of games) {
    const view = buildSafeView(g, SPORT);
    if (!view) continue;
    const tags = deriveTags(g, SPORT);
    if (!tags) continue;
    corpus.push({
      id: view.id, home: view.home, away: view.away, league: view.league,
      date: view.date, ts: view.ts,
      home_rank: view.homeRank ?? null, away_rank: view.awayRank ?? null,
      cls: view.cls, ...tags, overtime: tags.overtime ? 1 : 0,
      phrases: JSON.stringify(view.phrases),
    });
  }

  // 5a. The corpus must clear the floor, or nothing below is meaningful.
  if (corpus.length < MIN_CORPUS) {
    fail('oracle', `corpus ${corpus.length} below MIN_CORPUS ${MIN_CORPUS} — `
      + `result size starts tracking the query; the rest of this test is void`);
  }
  const EXPECT = Math.min(5, corpus.length); // RESULT_LIMIT, asserted by observation below

  // 5b. Every team in the RAW feed — including teams whose games were all
  //     excluded at ingest — must produce an identically sized result.
  //     Those excluded teams are the whole point: they are the ones a hard
  //     filter would betray.
  const inCorpus = new Set(corpus.flatMap(r => [r.home, r.away]));
  const allTeams = [...new Set(games.flatMap(g => [g.home, g.away]).filter(Boolean))];
  const excluded = allTeams.filter(t => !inCorpus.has(t));

  const sizes = new Map();
  for (const team of allTeams) {
    const n = searchGames(corpus, { prefer_teams: [team] }).games.length;
    if (!sizes.has(n)) sizes.set(n, []);
    sizes.get(n).push(team);
  }
  if (sizes.size === 1 && sizes.has(EXPECT)) {
    console.log(`  ${allTeams.length} teams probed (${excluded.length} with zero `
      + `recommendable games) — all return ${EXPECT}`);
  } else {
    for (const [n, teams] of sizes) {
      if (n !== EXPECT) {
        fail('oracle', `${teams.length} team(s) return ${n} results, not ${EXPECT} `
          + `— e.g. ${JSON.stringify(teams.slice(0, 3))}. prefer_teams is excluding.`);
      }
    }
  }

  // 5c. Same property across every enum value, including combinations that
  //     match nothing. A filter that excludes shows up here even if teams
  //     were left alone.
  // Full cartesian product. Single-dimension probes are useless here: every
  // enum value has at least 5 games behind it, so a hard filter still fills
  // RESULT_LIMIT and the test passes. Only combinations empty out.
  const probes = [];
  for (const c of [undefined, ...TAG_VOCAB.competitiveness])
    for (const sc of [undefined, ...TAG_VOCAB.scoring])
      for (const ot of [undefined, true, false])
        for (const rk of [undefined, ...TAG_VOCAB.ranked])
          for (const rc of [undefined, 'latest_slate', 'this_week']) {
            const p = {};
            if (c) p.competitiveness = c;
            if (sc) p.scoring = sc;
            if (ot !== undefined) p.overtime = ot;
            if (rk) p.ranked = rk;
            if (rc) p.recency = rc;
            probes.push(p);
          }
  // Plus the same grid narrowed to teams with nothing recommendable.
  for (const p of probes.slice(0, 24)) probes.push({ ...p, prefer_teams: excluded.slice(0, 2) });

  let varied = 0;
  const seenSizes = new Map();
  for (const p of probes) {
    const n = searchGames(corpus, p).games.length;
    if (n !== EXPECT) {
      varied++;
      if (!seenSizes.has(n)) seenSizes.set(n, p);
    }
  }
  if (varied) {
    for (const [n, p] of seenSizes) {
      fail('oracle', `${varied} probe(s) returned a size other than ${EXPECT}; `
        + `e.g. ${n} for ${JSON.stringify(p)} — a filter is excluding`);
      break;
    }
  } else {
    console.log(`  ${probes.length} enum-combination probes — all return ${EXPECT}`);
  }

  // 5c-bis. The sweep above cannot catch a filter on a single dimension: every
  //     enum value has 7-20 games behind it, so excluding on one still fills
  //     RESULT_LIMIT. Detection needs a corpus at the floor, where any
  //     exclusion at all shows up. Tags are spread so that no single value
  //     covers 5 games.
  const minimal = ['nail_biter', 'close', 'competitive', 'nail_biter', 'close']
    .map((comp, i) => ({
      id: `m${i}`, home: `Home ${i}`, away: `Away ${i}`, league: 'FBS', date: 'd',
      ts: Date.now() - i * 86_400_000, home_rank: null, away_rank: null,
      cls: i === 0 ? 'watchworthy' : 'watchable',
      competitiveness: comp,
      scoring: i % 2 ? 'shootout' : 'balanced',
      overtime: i % 3 === 0 ? 1 : 0,
      ranked: ['neither', 'one', 'both'][i % 3],
      runtime_bucket: 'over_3h', phrases: '[]',
    }));

  let minVaried = 0;
  for (const p of probes) {
    const n = searchGames(minimal, p).games.length;
    if (n !== minimal.length) {
      minVaried++;
      if (minVaried === 1) {
        fail('oracle', `at-floor corpus: probe returned ${n} of ${minimal.length} for `
          + `${JSON.stringify(p)} — a filter is excluding`);
      }
    }
  }
  if (!minVaried) {
    console.log(`  same ${probes.length} probes against a ${minimal.length}-game corpus `
      + `(at MIN_CORPUS) — all return ${minimal.length}`);
  }

  // 5c-ter. Category must reach the model as the display word, never the
  //     internal enum. Mapped in code because the model flattened every game
  //     to "must watch" when asked to do the mapping itself, and because an
  //     enum it never sees is an enum it cannot leak into prose.
  {
    const labels = new Set(Object.values(CATEGORY_LABEL));
    const seen = new Set();
    for (const g of searchGames(corpus, {}).games) {
      seen.add(g.category);
      if (!labels.has(g.category)) {
        fail('oracle', `category "${g.category}" is not a display label`);
      }
    }
    // Every recommendable class must have a label, or a game would surface
    // with a raw enum the moment that class appears in the corpus.
    for (const cls of RECOMMENDABLE_CLS) {
      if (!CATEGORY_LABEL[cls]) fail('oracle', `no display label for class "${cls}"`);
      const mapped = toResult({ ...corpus[0], cls }).category;
      if (mapped !== CATEGORY_LABEL[cls]) {
        fail('oracle', `class "${cls}" mapped to ${JSON.stringify(mapped)}`);
      }
    }
    console.log(`  categories surface as display labels (${[...seen].join(', ')})`);
  }

  // 5c-quater. The first-turn line is composed in code, not by the model.
  //     Three prompt attempts produced three different shapes, so the guard
  //     now hands over a finished string.
  {
    for (const g of searchGames(corpus, {}).games) {
      if (typeof g.line !== 'string' || !g.line.length) {
        fail('oracle', `game ${g.id} has no preformatted line`);
        continue;
      }
      if (!g.line.includes(g.category)) {
        fail('oracle', `line omits the category: ${JSON.stringify(g.line)}`);
      }
      if (!g.line.startsWith(`${g.away} vs ${g.home}`)) {
        fail('oracle', `line does not lead with the matchup: ${JSON.stringify(g.line)}`);
      }
      // The line must use one of the game's OWN phrases — not necessarily the
      // top-weighted one. Choosing across the whole result set avoids five
      // lines that all read "Down to the wire", but it must never invent or
      // borrow a phrase from another game.
      if (g.phrases.length && !g.phrases.some(p => g.line.includes(p))) {
        fail('oracle', `line uses no phrase belonging to this game: ${JSON.stringify(g.line)}`);
      }
      // The line is shown to a user: it must obey invariant 1 like any other
      // emitted text.
      if (findViolation(g.line)) {
        fail('oracle', `line contains a forbidden digit: ${JSON.stringify(g.line)}`);
      }
    }
    // A game with no phrases still needs a usable line.
    const bare = searchGames([{ ...corpus[0], phrases: '[]' }], {}).games[0];
    if (!bare.line || !bare.line.includes(bare.category)) {
      fail('oracle', `phraseless game produced no usable line: ${JSON.stringify(bare.line)}`);
    }

    // Phrase repetition across the list should be minimised — that is the
    // whole reason choice happens at set level.
    const lines = searchGames(corpus, {}).games.map(g => g.line);
    const tails = lines.map(l => l.split('—')[1] ?? '');
    const dupes = tails.length - new Set(tails).size;
    if (dupes > 2) {
      fail('oracle', `${dupes} duplicate phrase(s) across ${tails.length} lines — set-level choice is not working`);
    }
    // A game with nothing unique left must fall back to its OWN top phrase,
    // never to a phrase another game used. Synthetic, because in the fixture
    // the borrowed phrase happens to belong to the game anyway — so the
    // fixture cannot distinguish the two behaviours.
    {
      const mk = (id, phrases) => ({
        ...corpus[0], id, home: `H${id}`, away: `A${id}`,
        ts: Date.now() - id * 1000, phrases: JSON.stringify(phrases),
      });
      const synth = [mk(1, ['Alpha']), mk(2, ['Beta']), mk(3, ['Beta'])];
      for (const g of searchGames(synth, {}).games) {
        const own = JSON.parse(synth.find(r => r.id === g.id).phrases);
        if (!own.some(p => g.line.includes(p))) {
          fail('oracle', `line borrowed a phrase this game does not have: ${JSON.stringify(g.line)}`);
        }
      }
    }

    console.log(`  first-turn lines composed in code, ${dupes} repeated phrase(s) across ${lines.length}`);
  }

  // 5d. The return shape must have no field capable of expressing absence.
  //     Checked structurally rather than by inspection, so a field added later
  //     to be helpful trips this.
  const FORBIDDEN = ['total', 'count', 'matched', 'relaxed', 'message', 'empty', 'note'];
  const sample = searchGames(corpus, { prefer_teams: excluded.slice(0, 1) });
  const top = Object.keys(sample);
  for (const f of FORBIDDEN) {
    if (top.includes(f)) fail('oracle', `result carries "${f}" — the model can report absence`);
  }
  if (top.length !== 1 || top[0] !== 'games') {
    fail('oracle', `result has keys ${JSON.stringify(top)}; expected only ["games"]`);
  }

  // 5e. Recency must anchor to the corpus, not the clock.
  //
  //     The fixture cannot test this. The sort already tie-breaks on ts
  //     descending, so an unapplied recency boost still yields newest-first,
  //     and the latest slate holds 6 watchworthy games which fill the top 5 on
  //     tier alone. Corpus-anchored and clock-relative produce identical
  //     output on real data. Two earlier versions of this check — one on size,
  //     one on content — both passed against a clock-relative implementation.
  //
  //     So: synthetic corpus built to discriminate. One OLD watchworthy game
  //     against five NEWER watchable ones. The recency boost (5) outranks the
  //     category tier (2), so an anchored implementation puts the new games on
  //     top; a clock-relative one applies no boost at all and tier wins.
  const base = Date.now() - 40 * 86_400_000;
  const synth = [
    { id: 'old', home: 'Old A', away: 'Old B', league: 'FBS', date: 'old',
      ts: base, home_rank: null, away_rank: null, cls: 'watchworthy',
      competitiveness: 'close', scoring: 'balanced', overtime: 0, ranked: 'neither',
      runtime_bucket: 'over_3h', phrases: '[]' },
    ...Array.from({ length: 5 }, (_, i) => ({
      id: `new${i}`, home: `New ${i}`, away: `Opp ${i}`, league: 'FBS', date: 'new',
      ts: base + 30 * 86_400_000 + i, home_rank: null, away_rank: null, cls: 'watchable',
      competitiveness: 'close', scoring: 'balanced', overtime: 0, ranked: 'neither',
      runtime_bucket: 'over_3h', phrases: '[]' })),
  ];
  const synthTop = searchGames(synth, { recency: 'latest_slate' }).games[0];
  if (synthTop.id === 'old') {
    fail('oracle', 'recency is clock-relative: an older watchworthy game outranks the '
      + 'latest slate, so the boost never applied');
  } else {
    console.log('  recency anchored to corpus — latest slate outranks an older '
      + 'watchworthy game');
  }
}

// ── Test 6: schema closure ───────────────────────────────────────────────────
// The tool schema is the second enforcement layer (§8.1). It is only a layer if
// it actually rejects. These are the arguments a jailbroken model would try:
// a numeric threshold, a raw field name, an invented preference key.

console.log('\n6. Schema closure (§8.1 layer 2)');
{
  const mustReject = [
    ['numeric margin threshold',  searchGamesInput, { margin_under: 5 }],
    ['raw score field',           searchGamesInput, { h: 38, a: 14 }],
    ['factors passthrough',       searchGamesInput, { factors: true }],
    ['out-of-vocab enum',         searchGamesInput, { competitiveness: 'blowout' }],
    ['enum as free text',         searchGamesInput, { scoring: '65+' }],
    ['limit override',            searchGamesInput, { limit: 500 }],
    ['unbounded team list',       searchGamesInput, { prefer_teams: Array(50).fill('x') }],
    ['invented preference key',   savePreferenceInput, { key: 'margin', value: '3', liked: true }],
    ['preference without liked',  savePreferenceInput, { key: 'scoring', value: 'shootout' }],
  ];

  let leaked = 0;
  for (const [name, schema, input] of mustReject) {
    if (schema.safeParse(input).success) {
      leaked++;
      fail('schema', `accepted ${name}: ${JSON.stringify(input)}`);
    }
  }
  if (!leaked) console.log(`  ${mustReject.length} hostile inputs, all rejected`);

  const mustAccept = [
    [searchGamesInput, {}],
    [searchGamesInput, { competitiveness: 'nail_biter', overtime: true }],
    [searchGamesInput, { prefer_teams: ['Temple Owls'], recency: 'latest_slate' }],
    [savePreferenceInput, { key: 'teams', value: 'Texas Longhorns', liked: false }],
  ];
  for (const [schema, input] of mustAccept) {
    const r = schema.safeParse(input);
    if (!r.success) fail('schema', `rejected a valid input: ${JSON.stringify(input)}`);
  }

  // The enums must track TAG_VOCAB rather than being a second copy that drifts.
  for (const v of TAG_VOCAB.competitiveness) {
    if (!searchGamesInput.safeParse({ competitiveness: v }).success) {
      fail('schema', `TAG_VOCAB has "${v}" but the tool schema rejects it — vocabularies drifted`);
    }
  }
  console.log(`  ${mustAccept.length} valid inputs accepted, enums match TAG_VOCAB`);
}

// ── Test 7: output scanner ───────────────────────────────────────────────────
// §8.1 layer 3, adversarial set per §10.4. Catches HALLUCINATED numbers — the
// only kind that can reach the model, since layers 1-2 keep real ones out.
//
// Both directions matter. A scanner that trips on a poll rank aborts a clean
// generation, and the pressure to fix that is to weaken it.

console.log('\n7. Output scanner (§8.1 layer 3)');
{
  const mustTrip = [
    'The final was 38-14.',
    'It ended 38 to 14.',
    'They won by 3.',
    'A 2 point margin, decided late.',
    'Combined 104 points.',
    'The margin was under 7.',
    'Texas put up 45.',
    'It went to 2 overtimes.',
    'Rushing total was 212 yards.',
    'Score: 21-20',
    // A list marker must not launder a digit elsewhere on the line.
    '1. McNeese won 38-14',
    'Here are picks:\n1. Texas by 3',
    '2. The margin was 7',
    // A mid-sentence "N. " must not read as a list marker — the enumerator
    // pattern has to stay anchored to line start.
    'They won by 3. It stayed close throughout.',
    // Line-start digits only count as enumerators with a delimiter and at
    // most two digits.
    'Totals:\n38 points on the night',
    'Totals:\n212. rushing yards',
    // "rank" must not launder a digit elsewhere in the sentence.
    'A ranked matchup that ended 21-20.',
    'The 3rd-ranked team won by 7.',
    // Rank is at most 3 digits. A longer run after "ranked" is not a rank.
    'They were ranked 2120 in total yards.',
  ];
  const mustPass = [
    'A nail-biter between #12 Texas and Oklahoma.',
    'No. 3 Oregon played a back-and-forth game.',
    'Both teams are ranked — a good one on Sep 12.',
    'It ran about 3 to 3.5 hours.',
    "That's as much as I can give you without ruining it.",
    'Down to the wire, and it went to overtime.',
    'Kickoff was 7:30 pm.',
    'A ranked matchup from the 2026 season.',
    // Ranks in prose. The safe view carries home_rank/away_rank and §4.1
    // permits ranks, but the model writes "ranked 7", not "#7". Found live:
    // this blocked a correct answer mid-sentence.
    'It was a ranked matchup, with the Longhorns ranked 7.',
    'The 3rd-ranked Buckeyes were involved.',
    'Ranked 12 against ranking 4.',
    // Enumerators. The model reaches for a numbered list whenever it offers
    // more than one game; without these the scanner aborted most useful
    // responses. Found live, not by review.
    'Here are some games:\n1. McNeese vs Tarleton State\n2. Troy vs Sam Houston',
    '1. First game\n2) Second game',
    'A few picks: (1) McNeese, (2) Troy',
  ];

  let wrong = 0;
  for (const t of mustTrip) {
    if (!findViolation(t)) { wrong++; fail('scanner', `missed a violation: ${JSON.stringify(t)}`); }
  }
  for (const t of mustPass) {
    const v = findViolation(t);
    if (v) { wrong++; fail('scanner', `false positive on ${JSON.stringify(t)} (matched "${v}")`); }
  }
  if (!wrong) console.log(`  ${mustTrip.length} violations caught, ${mustPass.length} clean lines passed`);

  // Split deltas: the reason the scanner holds a tail. Emitting per-delta
  // without one lets "3" + "8" through before either is judged.
  const splits = [
    ['The final was ', '3', '8', '-', '1', '4', '.'],
    ['They ', 'won ', 'by ', 'th', 'ree', ' po', 'ints', ' — 7', ' exactly.'],
    ['A close one between #', '1', '2', ' Texas and Oklahoma, down to the wire.'],
  ];
  const expectTrip = [true, true, false];

  for (let i = 0; i < splits.length; i++) {
    const s = createScanner();
    let out = '';
    let violation = null;
    for (const d of splits[i]) {
      const r = s.push(d);
      out += r.emit;
      if (r.violation) { violation = r.violation; break; }
    }
    if (!violation) { const r = s.flush(); out += r.emit; violation = r.violation; }

    // Keep pushing after a trip: a scanner that forgets it tripped will start
    // emitting again.
    if (violation) {
      const post = s.push(' The margin was 3 and the total was 52.').emit + s.flush().emit;
      if (post) fail('scanner', `emitted after tripping: ${JSON.stringify(post)}`);
    }

    if (expectTrip[i] && !violation) {
      fail('scanner', `split delta not caught: ${JSON.stringify(splits[i].join(''))}`);
    } else if (!expectTrip[i] && violation) {
      fail('scanner', `split delta false positive ("${violation}"): ${JSON.stringify(splits[i].join(''))}`);
    } else if (violation && /\d/.test(out)) {
      // The point of the tail: nothing containing the offending digits may
      // already have been emitted when the trip fires.
      fail('scanner', `emitted digits before tripping: ${JSON.stringify(out)}`);
    }
  }
  console.log(`  ${splits.length} split-delta streams handled, no digits emitted before a trip`);

  // A clean stream must emit its full text, tail included.
  const clean = 'A back-and-forth game between #8 Texas and Oklahoma on Sep 12.';
  const s2 = createScanner();
  let got = '';
  for (const ch of clean) got += s2.push(ch).emit;
  got += s2.flush().emit;
  if (got !== clean) fail('scanner', `clean stream altered:\n        want: ${JSON.stringify(clean)}\n        got:  ${JSON.stringify(got)}`);
  else console.log('  clean stream passes through byte-identical');
}

// ── Test 8: scan transform ───────────────────────────────────────────────────
// The transform is what actually runs in production. Testing findViolation
// alone leaves the wiring — tail flushing, stopStream, part ordering — unproven.

console.log('\n8. Scan transform (stream wiring)');
{
  async function run(parts) {
    let stopped = false;
    const seen = [];
    const t = createScanTransform({
      stopStream: () => { stopped = true; },
      onViolation: (v) => seen.push(v),
    });
    const out = [];
    const writer = t.writable.getWriter();
    const reader = t.readable.getReader();
    const pump = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        out.push(value);
      }
    })();
    for (const p of parts) await writer.write(p);
    await writer.close();
    await pump;
    const text = out.filter(p => p.type === 'text-delta').map(p => p.text).join('');
    return { out, text, stopped, violations: seen };
  }

  const deltas = (id, chunks) => [
    { type: 'text-start', id },
    ...chunks.map(text => ({ type: 'text-delta', id, text })),
    { type: 'text-end', id },
  ];

  // Clean stream: passes through whole, nothing stopped, start/end preserved.
  {
    const src = 'A back-and-forth game between #8 Texas and Oklahoma on Sep 12. '
      + 'It ran about 3 to 3.5 hours, kickoff 7:30 pm in the 2026 season.';
    const r = await run(deltas('t1', src.match(/.{1,7}/g)));
    if (r.text !== src) fail('transform', `clean text altered: ${JSON.stringify(r.text)}`);
    if (r.stopped) fail('transform', 'stopStream called on a clean stream');
    if (r.out[0]?.type !== 'text-start') fail('transform', 'text-start dropped');
    if (r.out.at(-1)?.type !== 'text-end') fail('transform', 'text-end dropped');
    if (!r.stopped && r.text === src) console.log('  clean stream: intact, not stopped');
  }

  // Violation mid-stream. Must be longer than TAIL, or the settled window is
  // empty for the whole message and only flush() ever trips — which leaves the
  // delta path untested.
  {
    const long = 'It was a back-and-forth game that stayed close throughout, and the final ';
    const r = await run(deltas('t2', [long, 'score was ', '3', '8', '-14.']));
    if (!r.violations.length) fail('transform', 'violation not reported');
    if (/\d/.test(r.text)) fail('transform', `emitted digits: ${JSON.stringify(r.text)}`);
    if (!r.text.includes(FLOOR_LINE)) fail('transform', 'floor line not emitted');
    // The cut sentence and the floor line must not run together.
    if (!r.text.includes(`\n\n${FLOOR_LINE}`)) {
      fail('transform', `floor line not separated from the truncated sentence: ${JSON.stringify(r.text.slice(-70))}`);
    }
    if (!r.stopped) fail('transform', 'stopStream not called on violation');
    if (r.violations.length && !/\d/.test(r.text) && r.stopped) {
      console.log(`  violation: stopped, no digits emitted, floor line sent`);
    }
  }

  // Parts after a trip must not leak through.
  {
    const r = await run([
      ...deltas('t3', ['They won by ', '3', '.']),
      { type: 'text-delta', id: 't3', text: ' The margin was 3 points.' },
      // A NEW part id: the scanner instance for t3 cannot suppress this, so
      // only the transform's own fired flag stops it.
      // CLEAN text under a NEW part id: the t3 scanner cannot suppress it and
      // it holds no digits, so only the transform's own fired flag stops it.
      ...deltas('t3b', ['It also stayed close down the stretch.']),
    ]);
    if (/\d/.test(r.text)) fail('transform', `leaked after trip: ${JSON.stringify(r.text)}`);
    const after = r.text.slice(r.text.indexOf(FLOOR_LINE) + FLOOR_LINE.length);
    if (!r.text.includes(FLOOR_LINE)) fail('transform', 'floor line missing on trip');
    else if (after.trim()) fail('transform', `emitted text after the floor line: ${JSON.stringify(after)}`);
    else console.log('  post-trip parts suppressed');
  }

  // Non-text parts pass through untouched.
  {
    const r = await run([
      { type: 'tool-input-start', id: 'x', toolName: 'search_games' },
      ...deltas('t4', ['Down to the wire.']),
    ]);
    if (!r.out.some(p => p.type === 'tool-input-start')) fail('transform', 'tool part dropped');
    else console.log('  non-text parts pass through');
  }
}

// ── Test 9: AI stream dedupe ─────────────────────────────────────────────────
// The Workers AI binding sends each fragment twice per SSE frame. Frame shapes
// below are copied from a live /debug/raw capture, not invented.

console.log('\n9. Workers AI stream dedupe');
{
  const FRAMES = [
    'data: {"choices":[{"delta":{"content":"","role":"assistant"}}],"response":"","usage":{"prompt_tokens":45}}',
    'data: {"choices":[{"delta":{"content":"Here"}}],"response":"Here","tool_calls":[]}',
    'data: {"choices":[{"delta":{"content":" are some games"}}],"response":" are some games"}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}],"tool_calls":[]}',
    'data: {"response":"","usage":{"completion_tokens":8}}',
    'data: [DONE]',
  ].join('\n\n');

  async function run(chunkSize) {
    const enc = new TextEncoder();
    const chunks = [];
    for (let i = 0; i < FRAMES.length; i += chunkSize) {
      chunks.push(enc.encode(FRAMES.slice(i, i + chunkSize)));
    }
    const src = new ReadableStream({
      start(c) { chunks.forEach(x => c.enqueue(x)); c.close(); },
    });
    return await new Response(dedupeAIStream(src)).text();
  }

  // Frame reassembly must survive arbitrary chunk boundaries — the duplicate
  // field can straddle two network chunks.
  for (const size of [7, 37, 200, 5000]) {
    const out = await run(size);
    let text = '', stillDuplicated = 0, done = false;
    for (const f of out.split('\n\n')) {
      if (!f.startsWith('data: ')) continue;
      const p = f.slice(6).trim();
      if (p === '[DONE]') { done = true; continue; }
      let o;
      try { o = JSON.parse(p); } catch { fail('dedupe', `chunk ${size}: emitted invalid JSON: ${p.slice(0,60)}`); continue; }
      const d = o?.choices?.[0]?.delta?.content;
      if (typeof d === 'string' && typeof o.response === 'string') stillDuplicated++;
      if (d) text += d;
    }
    if (stillDuplicated) fail('dedupe', `chunk ${size}: ${stillDuplicated} frame(s) still carry both fields`);
    if (text !== 'Here are some games') fail('dedupe', `chunk ${size}: text is ${JSON.stringify(text)}`);
    if (!done) fail('dedupe', `chunk ${size}: [DONE] frame lost`);
  }
  console.log('  4 chunk sizes — duplicate field removed, text intact, [DONE] preserved');

  // The usage-only tail frame has no delta; it must not be altered.
  const tail = 'data: {"response":"","usage":{"completion_tokens":8}}';
  if (rewriteFrame(tail) !== tail) fail('dedupe', 'usage-only tail frame was modified');

  // Non-JSON and comment frames pass through untouched.
  for (const f of ['data: [DONE]', ': keep-alive', 'data: not json at all']) {
    if (rewriteFrame(f) !== f) fail('dedupe', `frame altered when it should not be: ${f}`);
  }
  console.log('  tail, [DONE], keep-alive and non-JSON frames untouched');

  // Numeric carriers. A token that is entirely digits can arrive as a JSON
  // number rather than a string. A typeof === 'string' test skips those, the
  // provider coerces them back to text, and the fragment is emitted twice —
  // which is why words stopped doubling but "Sep 12" became "Sep 1212".
  {
    const numResp = 'data: ' + JSON.stringify({ choices: [{ delta: { content: '12' } }], response: 12 });
    const o1 = JSON.parse(rewriteFrame(numResp).slice(6));
    if ('response' in o1) fail('dedupe', 'numeric response not stripped');

    const numBoth = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 12 } }], response: 12 });
    const o2 = JSON.parse(rewriteFrame(numBoth).slice(6));
    if ('response' in o2) fail('dedupe', 'numeric response not stripped when delta is numeric too');
    if (o2?.choices?.[0]?.delta?.content !== 12) fail('dedupe', 'numeric delta lost');

    // Still must not strip when only one carrier is present.
    const respOnlyNum = 'data: ' + JSON.stringify({ response: 12 });
    if (rewriteFrame(respOnlyNum) !== respOnlyNum) fail('dedupe', 'single numeric carrier was modified');

    // Booleans and objects are not text and must not be treated as carriers.
    const boolResp = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'x' } }], response: true });
    if (rewriteFrame(boolResp) !== boolResp) fail('dedupe', 'non-textual response was stripped');

    console.log('  numeric carriers stripped, single-carrier and non-textual frames untouched');
  }

  // Tool-call duplication. Same root cause as the text doubling, but the
  // consequence is worse: fragments interleave into unparseable JSON and the
  // model retries to the step limit. Shapes from a live capture.
  {
    const frag = '{"recency": "';
    const both = 'data: ' + JSON.stringify({
      choices: [{ delta: { tool_calls: [{ function: { arguments: frag } }] } }],
      tool_calls: [{ arguments: frag }],
    });
    const out = JSON.parse(rewriteFrame(both).slice(6));
    if ('tool_calls' in out) fail('dedupe', 'duplicate top-level tool_calls not stripped');
    if (!out?.choices?.[0]?.delta?.tool_calls?.length) fail('dedupe', 'delta tool_calls lost');

    // A frame using only one carrier must be left alone — stripping it would
    // drop the tool call entirely.
    const topOnly = 'data: ' + JSON.stringify({ tool_calls: [{ arguments: frag }] });
    if (rewriteFrame(topOnly) !== topOnly) fail('dedupe', 'single-carrier tool_calls frame was modified');

    const deltaOnly = 'data: ' + JSON.stringify({
      choices: [{ delta: { tool_calls: [{ function: { arguments: frag } }] } }],
    });
    if (rewriteFrame(deltaOnly) !== deltaOnly) fail('dedupe', 'delta-only tool_calls frame was modified');

    console.log('  duplicate tool_calls stripped, single-carrier frames untouched');
  }

  // Frame watcher: the point is distinguishing a complete stream from one that
  // ended early, which is the open question on the interrupted tool calls.
  {
    const lines = [];
    const enc = new TextEncoder();
    const mk = (t) => new ReadableStream({ start(c) { c.enqueue(enc.encode(t)); c.close(); } });

    await new Response(dedupeAIStream(mk(FRAMES), createFrameWatcher(l => lines.push(l)))).text();
    const complete = lines.find(l => l.includes('END'));
    if (!complete || complete.includes('ENDED EARLY')) {
      fail('dedupe', `complete stream reported as truncated: ${complete}`);
    }

    const cut = [];
    const truncated = FRAMES.split('\n\n').slice(0, 2).join('\n\n');
    await new Response(dedupeAIStream(mk(truncated), createFrameWatcher(l => cut.push(l)))).text();
    const early = cut.find(l => l.includes('END'));
    if (!early || !early.includes('ENDED EARLY')) {
      fail('dedupe', `truncated stream not flagged: ${early}`);
    }
    if (complete && !complete.includes('ENDED EARLY') && early?.includes('ENDED EARLY')) {
      console.log('  frame watcher distinguishes complete from truncated streams');
    }
  }
}

// ── Test 10: tool input repair ───────────────────────────────────────────────
// Llama sends {"overtime": "true"} — the string — and the call is rejected,
// so the user watches error cards until an attempt happens to be well typed.
// Repair fixes ENCODING only. It must never coerce a value into the enum
// vocabulary, or layer 2 stops closing it.

console.log('\n10. Tool input repair (§8.1 layer 2)');
{
  const repairs = [
    ['string boolean',        '{"overtime": "true"}',                          { overtime: true }],
    ['string false',          '{"overtime": "false"}',                         { overtime: false }],
    ['scalar for array',      '{"prefer_teams": "Texas"}',                     { prefer_teams: ['Texas'] }],
    ['mixed valid + typo',    '{"competitiveness": "nail_biter", "overtime": "true"}',
                              { competitiveness: 'nail_biter', overtime: true }],
    ['drops unknown key',     '{"margin_under": 5, "overtime": "true"}',       { overtime: true }],
  ];
  for (const [name, input, want] of repairs) {
    const got = repairToolInput(searchGamesInput, input);
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      fail('repair', `${name}: want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    }
  }

  // MUST NOT repair. Each of these would widen what the model can express.
  const mustNotRepair = [
    ['out-of-vocab enum',     '{"competitiveness": "blowout"}'],
    ['numeric threshold',     '{"margin_under": 5}'],
    ['truthy guess',          '{"overtime": "yes"}'],
    ['truthy number',         '{"overtime": 1}'],
    ['raw score field',       '{"h": 38, "a": 14}'],
    ['not json',              'not json'],
    ['array input',           '[1,2,3]'],
  ];
  for (const [name, input] of mustNotRepair) {
    const got = repairToolInput(searchGamesInput, input);
    if (got !== null) fail('repair', `${name}: repaired when it should not have: ${JSON.stringify(got)}`);
  }

  // A repaired call must still satisfy the schema it was repaired against.
  for (const [, input] of repairs) {
    const got = repairToolInput(searchGamesInput, input);
    if (got && !searchGamesInput.safeParse(got).success) {
      fail('repair', `repair produced schema-invalid output: ${JSON.stringify(got)}`);
    }
  }

  console.log(`  ${repairs.length} type repairs applied, ${mustNotRepair.length} refused`);
}

console.log(failures ? `\n${failures} failure(s)\n` : '\nAll tests passed\n');
process.exit(failures ? 1 : 0);
