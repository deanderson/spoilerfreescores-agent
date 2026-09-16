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
import { searchGames, MIN_CORPUS, searchGamesInput, savePreferenceInput, repairToolInput, CATEGORY_LABEL, toResult, RECOMMENDABLE_CLS, createCallCache } from '../src/guard/tools.js';
import { createScanner, findViolation, createScanTransform, FLOOR_LINE, BLOCKED_LINE } from '../src/guard/scanner.js';
import { dedupeAIStream, rewriteFrame, createFrameWatcher } from '../src/ai-stream-fix.js';
import { toIngestRow, buildStepResult, FORBIDDEN_ROW_FIELDS } from '../src/guard/ingest-row.js';

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
  // Teams whose games are ALL non-recommendable. These are the ones a hard
  // filter would betray: before the corpus held every game they were absent
  // entirely, and now they are present but never surface unprompted.
  const recommendableTeams = new Set(
    corpus.filter(r => RECOMMENDABLE_CLS.includes(r.cls)).flatMap(r => [r.home, r.away]));
  const allTeams = [...new Set(games.flatMap(g => [g.home, g.away]).filter(Boolean))];
  const excluded = allTeams.filter(t => !recommendableTeams.has(t));

  // A named team returns THEIR games — the count varies with how many they
  // played, which reveals nothing about how any of them went. What must hold:
  // every team gets an answer (silence is what would betray a team whose games
  // were all blowouts) and nothing unrelated comes back.
  let silent = 0;
  let unrelated = 0;
  for (const team of allTeams) {
    const got = searchGames(corpus, { prefer_teams: [team] }).games;
    if (!got.length) {
      silent++;
      if (silent <= 3) fail('oracle', `"${team}" returned nothing — silence betrays the team`);
      continue;
    }
    for (const g of got) {
      if (g.home !== team && g.away !== team) {
        unrelated++;
        if (unrelated <= 3) {
          fail('oracle', `"${team}" returned an unrelated game: ${JSON.stringify(g.line)}`);
        }
      }
    }
  }
  if (!silent && !unrelated) {
    console.log(`  ${allTeams.length} teams probed (${excluded.length} with zero `
      + `recommendable games) — every team answered, nothing unrelated`);
  }
  if (excluded.length < 50) {
    fail('oracle', `only ${excluded.length} teams lack a recommendable game — `
      + `the probe has lost the case it exists to test`);
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
  // Team queries are deliberately NOT in this grid: naming a team switches to
  // the other search path, where size varies with how many games they played.
  // Size invariance is a property of the generic path.

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

  // 5c-quater. A search result carries the LINE and nothing that describes the
  //     game. No phrases, no qualities, no overtime flag. Three prompt attempts
  //     failed to stop the model using them on the first answer — it dropped
  //     the category, put a phrase in its place, and attached one game's phrase
  //     to another. Colour now lives behind get_game_detail, which is the
  //     site's Why Watch button.
  {
    const ALLOWED = ['id', 'home', 'away', 'league', 'date', 'category', 'line'];
    const DESCRIBING = ['phrases', 'qualities', 'competitiveness', 'scoring',
                        'overtime', 'ranked', 'cls', 'home_rank', 'away_rank'];

    for (const probe of [{}, { prefer_teams: ['Tigers'] }, { competitiveness: 'nail_biter' }]) {
      for (const g of searchGames(corpus, probe).games) {
        for (const k of Object.keys(g)) {
          if (!ALLOWED.includes(k)) {
            fail('oracle', `search result carries "${k}" — detail belongs behind get_game_detail`);
          }
        }
        for (const k of DESCRIBING) {
          if (k in g) fail('oracle', `search result describes the game via "${k}"`);
        }
        if (typeof g.line !== 'string' || !g.line.includes(g.category)) {
          fail('oracle', `line missing or omits the category: ${JSON.stringify(g.line)}`);
        }
        if (!g.line.startsWith(`${g.away} vs ${g.home}`)) {
          fail('oracle', `line does not lead with the matchup: ${JSON.stringify(g.line)}`);
        }
        if (findViolation(g.line)) {
          fail('oracle', `line contains a forbidden digit: ${JSON.stringify(g.line)}`);
        }
      }
    }

    // The full view still carries phrases — get_game_detail reads from it.
    const full = toResult(corpus.find(r => JSON.parse(r.phrases).length));
    if (!full.phrases.length) fail('oracle', 'the detail view lost its phrases');

    // The list block must contain every line, one per row, and nothing extra.
    for (const probe of [{}, { prefer_teams: ['Tigers'] }]) {
      const res = searchGames(corpus, probe);
      const rows_ = res.list.split('\n');
      if (rows_.length !== res.games.length) {
        fail('oracle', `list has ${rows_.length} rows for ${res.games.length} games`);
      }
      res.games.forEach((g, i) => {
        if (rows_[i] !== `- ${g.line}`) {
          fail('oracle', `list row ${i} does not match the line: ${JSON.stringify(rows_[i])}`);
        }
      });
      if (findViolation(res.list)) {
        fail('oracle', `list block contains a forbidden digit`);
      }
    }

    console.log('  search results carry the line only; list block matches, colour behind get_game_detail');
  }

  // 5c-sexies. Two search paths, with different guarantees.
  //
  //   NAMED TEAM — shows that team's games, best first, skip games included.
  //     Size varies with how many games they played, which says nothing about
  //     how any went. Ambiguous queries ("Tigers") just show more teams.
  //   NO TEAM — the §6.2 path: recommendable only, fixed size, no field
  //     capable of expressing absence. This is the one that must stay
  //     uninformative.
  {
    // Generic path: no skip games, ever.
    for (const p of [{}, { competitiveness: 'nail_biter' }, { overtime: true },
                     { recency: 'this_week' }, { competitiveness: 'lopsided' },
                     { competitiveness: 'lopsided', scoring: 'shootout' }]) {
      const res = searchGames(corpus, p);
      for (const g of res.games) {
        if (g.category === 'skip') {
          fail('oracle', `skip game surfaced for ${JSON.stringify(p)}: ${JSON.stringify(g.line)}`);
        }
      }
      if ('more' in res) fail('oracle', `generic result carries "more": ${JSON.stringify(p)}`);
      if (res.games.length !== EXPECT) {
        fail('oracle', `generic result size varied: ${res.games.length} for ${JSON.stringify(p)}`);
      }
    }

    // Named path: the team's own games come back, skip included and labelled.
    const skipOnly = corpus.filter(r => !RECOMMENDABLE_CLS.includes(r.cls));
    if (!skipOnly.length) fail('oracle', 'corpus holds no skip-class games to test');
    const target = skipOnly[0];
    const named = searchGames(corpus, { prefer_teams: [target.home] });
    if (!named.games.some(g => g.id === target.id)) {
      fail('oracle', `naming "${target.home}" did not surface their own game`);
    }
    const surfaced = named.games.find(g => g.id === target.id);
    if (surfaced && surfaced.category !== 'skip') {
      fail('oracle', `skip game surfaced as "${surfaced.category}"`);
    }

    // Best first. Checking the returned order alone is not enough: inverting
    // the sort returned five skip games, which is trivially non-increasing.
    // The top result must be the best category available among ALL matches.
    const rank = { 'scorefest': 4, 'must watch': 3, 'watchable': 2, 'skip': 1 };
    const clsRank = { scorefest: 4, watchworthy: 3, watchable: 2, defensive: 1, blowout: 1 };
    for (const q of ['Tigers', 'Texas', 'Bulldogs', target.home]) {
      const ql = q.toLowerCase();
      const hits = corpus.filter(r => [r.home, r.away].some(n => {
        const w = n.toLowerCase().split(/\s+/);
        const qq = ql.split(/\s+/);
        for (let i = 0; i + qq.length <= w.length; i++) {
          if (qq.every((x, j) => w[i + j] === x)) return true;
        }
        return false;
      }));
      if (!hits.length) continue;
      const bestAvailable = Math.max(...hits.map(r => clsRank[r.cls] ?? 0));

      const got = searchGames(corpus, { prefer_teams: [q] }).games;
      if (rank[got[0].category] !== bestAvailable) {
        fail('oracle', `"${q}" led with ${JSON.stringify(got[0].line)} but a better `
          + `category was available among its games`);
      }
      for (let i = 1; i < got.length; i++) {
        if (rank[got[i].category] > rank[got[i - 1].category]) {
          fail('oracle', `"${q}" returned a better game below a worse one: `
            + `${JSON.stringify(got[i - 1].line)} then ${JSON.stringify(got[i].line)}`);
        }
      }
    }

    // A name matching nothing falls back to the ordinary list — never empty,
    // and never a skip game the user did not ask for. "Owl" is a substring of
    // "Owls" but not a whole word in any team name, so it also separates
    // word matching from substring matching.
    for (const q of ['Owl', 'Nonexistent Team FC', 'Texa', 'EM Tigers']) {
      const res = searchGames(corpus, { prefer_teams: [q] });
      if (!res.games.length) fail('oracle', `"${q}" returned an empty list`);
      if (res.games.some(g => g.category === 'skip')) {
        fail('oracle', `unmatched query "${q}" surfaced a skip game`);
      }
      // The model must be able to tell a typo from a real result. Without this
      // it pages forever through an identical list — observed live with
      // "EM Tigers", which burned every step and produced no answer.
      if (!Array.isArray(res.unmatched) || !res.unmatched.length) {
        fail('oracle', `"${q}" matched nothing but did not report unmatched`);
      }
      if ('more' in res) {
        fail('oracle', `"${q}" reported more on a fallback result — invites paging`);
      }
      // Fallback results are ordinary recommendations, and must be the SAME
      // ones regardless of offset, or paging walks the corpus.
      const paged = searchGames(corpus, { prefer_teams: [q], offset: 10 });
      if (JSON.stringify(paged.games.map(g => g.id)) !== JSON.stringify(res.games.map(g => g.id))) {
        fail('oracle', `"${q}" fallback changed with offset — paging a non-result`);
      }
    }

    // A real team must NOT be reported as unmatched.
    for (const q of ['Temple Owls', 'Texas', 'Tigers']) {
      if ('unmatched' in searchGames(corpus, { prefer_teams: [q] })) {
        fail('oracle', `"${q}" matched real games but was reported unmatched`);
      }
    }

    // `more` must be honest: set when the cap truncated, clear when it did not.
    const wide = searchGames(corpus, { prefer_teams: ['Tigers'] });
    if (!wide.more) fail('oracle', '"Tigers" matched many teams but did not report more');
    const narrow = searchGames(corpus, { prefer_teams: [target.home] });
    if (narrow.games.length < 5 && narrow.more) {
      fail('oracle', `"${target.home}" returned ${narrow.games.length} games but reported more`);
    }

    // Pagination. Without it, "any others?" returns the same five and the
    // model announces them as new — observed live.
    {
      const seen = new Set();
      let offset = 0;
      let pages = 0;
      let more = true;
      while (more && pages < 10) {
        const res = searchGames(corpus, { prefer_teams: ['Texas'], offset });
        if (!res.games.length) { fail('oracle', `offset ${offset} returned nothing`); break; }
        for (const g of res.games) {
          if (seen.has(g.id)) {
            fail('oracle', `offset ${offset} repeated a game already shown: ${JSON.stringify(g.line)}`);
          }
          seen.add(g.id);
        }
        more = res.more;
        offset += res.games.length;
        pages++;
      }
      if (pages < 2) fail('oracle', 'pagination never advanced past the first page');
      if (more) fail('oracle', 'pagination never reported an end');

      // Past the end is EMPTY, not the last game again. Clamping an over-large
      // offset served a game the user had already seen: asking "any more?"
      // after the list was exhausted returned the final game a second time.
      for (const past of [offset, offset + 5, 500]) {
        const res = searchGames(corpus, { prefer_teams: ['Texas'], offset: past });
        if (res.games.length) {
          fail('oracle', `offset ${past} is past the end but returned `
            + `${res.games.length} game(s): ${JSON.stringify(res.games[0].line)}`);
        }
        if (res.more) fail('oracle', `offset ${past} past the end still reported more`);
      }

      // The walk must reach every game that team played.
      const total = corpus.filter(r =>
        [r.home, r.away].some(n => /\bTexas\b/i.test(n))).length;
      if (seen.size !== total) {
        fail('oracle', `pagination saw ${seen.size} of ${total} matching games`);
      }

      // The generic path ignores offset entirely. Checking size is not enough:
      // slicing at an offset still yields five games. The result must be
      // IDENTICAL, or offset becomes a way to walk the corpus on the path that
      // is supposed to be uninformative.
      const base = JSON.stringify(searchGames(corpus, {}).games.map(g => g.id));
      for (const off of [1, 5, 20]) {
        const got = JSON.stringify(searchGames(corpus, { offset: off }).games.map(g => g.id));
        if (got !== base) {
          fail('oracle', `offset ${off} changed the generic result — the fixed-size `
            + `path must ignore it`);
        }
      }
    }

    console.log('  named team shows all its games best-first, paginated; generic path unchanged');
  }

  // 5c-quinquies. A repeated identical tool call must replay the earlier
  //     result, NOT an empty one. The first implementation returned
  //     { games: [], repeated: true } — an empty array and two new keys in the
  //     one shape that must never express absence. Live probing caught it; the
  //     tests did not, because the guard lived outside the tested boundary.
  {
    const cache = createCallCache();
    const args = { competitiveness: 'nail_biter' };
    const first = cache.remember('search_games', args, searchGames(corpus, args));

    const again = cache.lookup('search_games', args);
    if (!again.hit) fail('oracle', 'repeated call was not recognised');
    if (JSON.stringify(again.value) !== JSON.stringify(first)) {
      fail('oracle', 'repeated call did not replay the identical result');
    }
    if (again.value.games.length !== first.games.length) {
      fail('oracle', `repeat changed result size: ${first.games.length} -> ${again.value.games.length}`);
    }
    for (const k of ['repeated', 'note', 'total', 'count', 'empty']) {
      if (k in again.value) fail('oracle', `repeat added an absence-capable key "${k}"`);
    }
    if (Object.keys(again.value).sort().join() !== 'games,list') {
      fail('oracle', `repeat changed the result shape: ${Object.keys(again.value).join()}`);
    }

    // Different arguments are a different call.
    if (cache.lookup('search_games', { competitiveness: 'close' }).hit) {
      fail('oracle', 'cache collided across different arguments');
    }
    console.log('  repeated tool calls replay the identical result, shape unchanged');
  }

  // 5d. The return shape must have no field capable of expressing absence.
  //     Checked structurally rather than by inspection, so a field added later
  //     to be helpful trips this.
  const FORBIDDEN = ['total', 'count', 'matched', 'relaxed', 'message', 'empty', 'note'];
  const sample = searchGames(corpus, {});
  const top = Object.keys(sample);
  for (const f of FORBIDDEN) {
    if (top.includes(f)) fail('oracle', `result carries "${f}" — the model can report absence`);
  }
  // `list` is the games already formatted — it carries nothing the games array
  // does not, so it cannot express absence. Anything else must not appear.
  if (top.sort().join() !== 'games,list') {
    fail('oracle', `result has keys ${JSON.stringify(top)}; expected games + list`);
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
    // Off-topic digits trip too. Correct — the scanner cannot tell football
    // numbers from any other kind, which is why the agent declines off-topic
    // requests rather than answering them badly.
    'Here are 10 Roman emperors:',
    'Nero ruled from 54 AD.',
    'The first 3 prime numbers are 2, 3, 5.',
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

  // A trip must not strand a partial sentence on screen. Emitting token by
  // token left fragments like "Ner" or "Here are" when the scanner fired,
  // which reads as a crash rather than a refusal.
  {
    const cases = [
      'Here are 10 Roman emperors: Augustus, Nero.',
      'Nero ruled the empire. He came to power in 54 AD.',
      'It was close. They won by 3.',
    ];
    for (const text of cases) {
      const s = createScanner();
      let out = '';
      let violation = null;
      for (const ch of text) {
        const r = s.push(ch);
        out += r.emit;
        if (r.violation) { violation = r.violation; break; }
      }
      if (!violation) { const f = s.flush(); out += f.emit; violation = f.violation; }

      if (!violation) { fail('scanner', `expected a trip: ${JSON.stringify(text)}`); continue; }
      // Whatever was released must end at a sentence boundary — never mid-word.
      const trimmed = out.replace(/\s+$/, '');
      if (trimmed && !/[.!?]$/.test(trimmed)) {
        fail('scanner', `trip stranded a partial sentence: ${JSON.stringify(out)}`);
      }
    }
    console.log('  a trip strands no partial sentence');
  }

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
    if (!r.text.includes(BLOCKED_LINE)) fail('transform', 'blocked line not emitted');
    // A scanner trip is a safety stop, not the disclosure floor. Using the
    // floor line implies a spoiler is being withheld — wrong, and confusing
    // when the blocked digit had nothing to do with football.
    if (r.text.includes(FLOOR_LINE)) {
      fail('transform', 'a scanner trip used the disclosure floor line');
    }
    // The cut sentence and the floor line must not run together.
    if (!r.text.includes(`\n\n${BLOCKED_LINE}`)) {
      fail('transform', `floor line not separated from the truncated sentence: ${JSON.stringify(r.text.slice(-70))}`);
    }
    if (!r.stopped) fail('transform', 'stopStream not called on violation');
    if (r.violations.length && !/\d/.test(r.text) && r.stopped) {
      console.log(`  violation: stopped, no digits emitted, blocked line sent`);
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
    const after = r.text.slice(r.text.indexOf(BLOCKED_LINE) + BLOCKED_LINE.length);
    if (!r.text.includes(BLOCKED_LINE)) fail('transform', 'blocked line missing on trip');
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
    // Observed live: the model sent offset: "5" and the call was rejected,
    // exactly as it had sent overtime: "true".
    ['numeric string offset',  '{"offset": "5"}',                              { offset: 5 }],
    ['zero offset',            '{"offset": "0"}',                              { offset: 0 }],
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
    // A fractional or spelled-out offset is not the same value re-encoded.
    ['fractional offset',     '{"offset": "5.5"}'],
    ['spelled offset',        '{"offset": "five"}'],
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

// ── Test 11: Workflow step boundary (§3.1, §8.3) ─────────────────────────────
// Workflows PERSISTS step return values, and `wrangler workflows instances
// describe` prints them. A Tier 2 field here is durably stored outside the
// Worker whether or not the model ever sees it.
//
// This is the gap that let every raw score persist for two days without any
// test failing. The row builder lived inline in ingest.ts, where nothing could
// reach it.

console.log('\n11. Workflow step boundary (§3.1)');
{
  const rows = [];
  let checked = 0;

  for (const g of games) {
    const view = buildSafeView(g, SPORT);
    if (!view) continue;
    const tags = deriveTags(g, SPORT);
    if (!tags) continue;

    const row = toIngestRow(view, tags, SPORT);
    rows.push(row);
    checked++;

    for (const f of FORBIDDEN_ROW_FIELDS) {
      if (f in row) fail('step', `row carries forbidden field "${f}" (game ${g.id})`);
    }

    // The actual scores must not appear anywhere a score could hide. Fields
    // that legitimately carry numbers — the date, the timestamp, the game id,
    // poll ranks — are excluded, or "Sep 12" collides with a 12-point score
    // and the check becomes noise.
    const json = JSON.stringify(row);
    const scannable = { ...row };
    for (const k of ['id', 'date', 'date_key', 'ts', 'ingested_at',
                     'home_rank', 'away_rank', 'watch_url']) {
      delete scannable[k];
    }
    const scanJson = JSON.stringify(scannable);
    for (const [label, value] of [['home score', g.h], ['away score', g.a]]) {
      if (typeof value !== 'number' || value < 10) continue;
      if (new RegExp(`\\b${value}\\b`).test(scanJson)) {
        fail('step', `${label} ${value} appears in the row for game ${g.id}: ${scanJson.slice(0, 160)}`);
      }
    }
    // The margin is the other number worth checking: it is what the tags are
    // derived from, and the most likely thing to be "helpfully" carried over.
    if (typeof g.h === 'number' && typeof g.a === 'number') {
      const margin = Math.abs(g.h - g.a);
      if (margin >= 10 && new RegExp(`\\b${margin}\\b`).test(scanJson)) {
        fail('step', `margin ${margin} appears in the row for game ${g.id}`);
      }
    }

    // Factor labels carry point weights and raw descriptions.
    for (const f of g.confidence?.factors ?? []) {
      if (f.label && json.includes(f.label) && !JSON.parse(row.phrases).includes(f.label)) {
        fail('step', `raw factor label "${f.label}" leaked into the row for ${g.id}`);
      }
    }
  }

  if (!checked) fail('step', 'no rows were built — the test exercised nothing');

  // The step RESULT, not just a row: this is the object Workflows persists.
  const result = buildStepResult(rows, games.length);
  const resultJson = JSON.stringify(result);
  if (Object.keys(result).sort().join() !== 'fetched,rows') {
    fail('step', `step result has unexpected keys: ${Object.keys(result).join()}`);
  }
  for (const f of FORBIDDEN_ROW_FIELDS) {
    if (new RegExp(`"${f}"\\s*:`).test(resultJson)) {
      fail('step', `step result carries forbidden field "${f}"`);
    }
  }
  if (typeof result.fetched !== 'number') {
    fail('step', 'step result does not report how many games were fetched');
  }

  console.log(`  ${checked} rows built, step result carries only rows + count`);
}

console.log(failures ? `\n${failures} failure(s)\n` : '\nAll tests passed\n');
process.exit(failures ? 1 : 0);
