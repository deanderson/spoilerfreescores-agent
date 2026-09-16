/**
 * Redaction layer — ported from spoilerfreescores index.html (~L1565-1857).
 *
 * Runs in the Worker, BEFORE the LLM, instead of in the browser after the full
 * payload has already shipped. Same guarantee, moved from render-time to
 * data-time.
 *
 * No Cloudflare dependency. Plain module, Node-testable.
 *
 * DIVERGENCE FROM SITE: every difference lives in WORKER_OVERRIDES below and
 * nowhere else. The differential test reads that table. If you change behaviour
 * without adding a row there, the test fails — which is the point.
 */

// ── Site source, verbatim ────────────────────────────────────────────────────
// Copied unchanged from index.html. Do not edit in place; use WORKER_OVERRIDES.

const SITE_INSIGHT_MAP = {
  // SPOILERS — suppress entirely (engine still uses them; UI doesn't show)
  '⚡ Late drama': null,   // softly hints at when drama happened — borderline; suppress to be safe

  // COMEBACK SCALE — safe to show, doesn't reveal winner
  '⚡ Huge rally': 'Massive rally',
  '⚡ Close game after big lead': 'Close game after big lead',

  // DRAMA SIGNALS
  '⚡ Overtime': 'Went to overtime',
  '⚡ Exciting overtime': 'Exciting overtime finish',
  '⚡ Back & forth': 'Back-and-forth game',
  '⚡ Last over finish': 'Came down to the last over',
  '⚡ Close chase': 'Tense run chase',
  '⚡ High scoring': 'Lots of runs scored',
  '⚡ 9-darter on night': 'A nine-darter happened',
  'Red card': 'A player was sent off',
  '⚡ Late goal': 'Decided by a late goal',
  '⚡ 90th min goal': 'Decided in injury time',
  '⚡ Penalty shootout': null,  // spoiler — reveals game was tied after 90min
  '⭐ Standout 40+ pt game': 'A player went off (40+ pts)',
  '⭐ Standout 30+ pt game': 'Standout individual performance',
  '⭐ Bench scorer 20+': 'A bench player put up big numbers',

  // CLOSENESS SIGNALS
  'Deciding leg': 'Went to a deciding leg',
  'Close match': 'Closely contested',
  'Competitive': 'Stayed competitive',
  'Tied/OT': 'Went the distance',
  'Draw': 'Ended level',
  '5-set epic': 'A 5-set marathon',
  '3-set match': 'Went to 3 sets',
  'Tiebreak + close sets': 'Tiebreak in close sets',
  'Tiebreak(s)': 'Decided in a tiebreak',

  // LOPSIDED SIGNALS
  'Lopsided': 'One-sided result',
  'Large margin': 'Wide margin',
  'Blowout margin': 'Blowout',
  'Blowout': 'Blowout',
  'Comfortable win': 'Comfortable winner',
  'Straight sets': 'Straight sets',
  'Bagel set': 'Included a 6-0 set',
  'Whitewash': 'A clean sweep',

  // SCORING ENVIRONMENT
  'Very low scoring': 'Low-scoring affair',
  'Low scoring': 'Low-scoring affair',
  'Both 100+ avg': 'Elite shooting from both',
  'One 100+ avg': 'One player at elite level',
  'Both sub-90 avg': 'Off night for both players',
  'Big rushing game': 'Big rushing game',
  'Lots of passing yards': 'Lots of passing yards',
  'Huge game on the ground': 'Huge game on the ground',
  'Big receiving day': 'Big receiving day',
  'Lots of sacks': 'Lots of sacks',

  // HISTORIC RECORDS
  '🏆 Historic scoring game': 'Historically high scoring',
  '⚡ Close game after huge lead': 'Close game after huge lead',
  '🏆 Triple overtime thriller': 'Triple overtime thriller',
  'Marathon extra innings': null,  // handled dynamically below

  // ROUND CONTEXT
  'Quarter-final': 'Quarter-final stakes',
  'Semi-final': 'Semi-final stakes',
  'Final': 'Tournament final',

  // CS2 SERIES SHAPE
  'Went full distance (Bo3)': null,
  'Went full distance (Bo5)': null,
  'Competitive series': 'Competitive series',
  'Series not competitive': null,
  'Single map result': null,
  'S-tier event': null,
  'A-tier event': null,
  'B-tier event': null,

  // CS2 REDDIT MAP SIGNALS
  '2 close maps': 'Both maps were closely contested',
  '3 close maps': 'All maps were tightly contested',
  '1 close map': 'One map went down to the wire',
  '1 map went OT': 'A map went to overtime',
  '2 maps went OT': 'Two maps went to overtime',
  '3 maps went OT': 'All three maps went to overtime',
  'Community interest': null,
  'High community excitement': null,
};

// ── Declared divergences ─────────────────────────────────────────────────────
// Every row is an invariant-1 violation in the site's vocabulary (a digit
// describing play). The site is left untouched; the Worker's copy is corrected.
//
// Site emits 4 digit-bearing phrases, not the 2 the spec listed. The two extra
// are tennis-only, so an NCAAF-only invariant test over fixture OUTPUT can
// never surface them. Hence the vocabulary-level test in verify.mjs.

export const WORKER_OVERRIDES = {
  '⭐ Standout 40+ pt game': 'A player went off',
  'Bagel set': 'Included a shutout set',

  // Tennis, out of v1 scope. Set count bounds the result the same way overtime
  // does — it wants a §4.3 named-exception ruling, not a quiet rewording.
  // Suppressed until that ruling exists. Safe default, reversible in one line.
  '5-set epic': null,
  '3-set match': null,
};

export const INSIGHT_MAP = { ...SITE_INSIGHT_MAP, ...WORKER_OVERRIDES };

// ── Dynamic labels — verbatim from site ──────────────────────────────────────

export function formatDynamicLabel(label, sport) {
  let m = label.match(/^(\d+)\s+(goals|pts|runs)$/);
  if (m) {
    const num = parseInt(m[1], 10);
    const unit = m[2];

    if (unit === 'goals') {
      if (sport === 'nhl' || sport === 'hockey') {
        if (num >= 8) return 'Goals galore';
        if (num >= 6) return 'High-scoring game';
        return null;
      }
      if (num >= 7) return 'Goals galore';
      if (num >= 5) return 'High-scoring game';
      return null;
    }

    if (unit === 'pts') {
      if (sport === 'wnba') {
        if (num >= 190) return 'They could not stop scoring';
        if (num >= 175) return 'Plenty of offense';
        return null;
      }
      if (sport === 'nba') {
        if (num >= 240) return 'They could not stop scoring';
        if (num >= 220) return 'Plenty of offense';
        return null;
      }
      if (sport === 'nfl') {
        if (num >= 60) return 'They could not stop scoring';
        if (num >= 50) return 'High-scoring game';
        return null;
      }
      if (sport === 'ncaaf') {
        if (num >= 80) return 'They could not stop scoring';
        if (num >= 65) return 'High-scoring game';
        return null;
      }
      return num >= 50 ? 'High-scoring game' : null;
    }

    if (unit === 'runs') {
      if (num >= 18) return 'Lots of runs scored';
      if (num >= 12) return 'Plenty of offense';
      return null;
    }
  }

  m = label.match(/^(\d+)\s+(goal|pt|run)\s+margin$/);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2];

    if (unit === 'goal') {
      if (n === 1) return 'Down to the wire';
      if (n === 2) return 'Competitive finish';
      return null;
    }

    if (unit === 'run') {
      if (n === 1) return 'Down to the wire';
      if (n === 2) return 'Competitive finish';
      return null;
    }

    if (unit === 'pt') {
      if (sport === 'nba' || sport === 'wnba') {
        if (n <= 3) return 'Down to the wire';
        if (n <= 5) return 'Close finish';
        if (n <= 10) return 'Came down to the closing minutes';
        return null;
      }
      if (sport === 'nfl') {
        if (n <= 3) return 'Down to the wire';
        if (n <= 7) return 'Came down to the closing minutes';
        return null;
      }
      if (sport === 'ncaaf') {
        if (n <= 3) return 'Down to the wire';
        if (n <= 7) return 'Came down to the closing minutes';
        if (n <= 14) return 'Stayed within reach';
        return null;
      }
      if (n <= 7) return 'Close finish';
      return null;
    }
  }

  m = label.match(/^Won by (\d+) (wkts|runs)$/);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2];
    if (unit === 'wkts') {
      if (n <= 2) return 'Down to the wire';
      if (n <= 4) return 'Close finish';
      return 'Comfortable margin';
    }
    if (unit === 'runs') {
      if (n <= 10) return 'Down to the wire';
      if (n <= 20) return 'Close finish';
      return 'Comfortable margin';
    }
    return null;
  }

  m = label.match(/^(\d+) lead changes$/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 15) return 'Wildly competitive';
    if (n >= 8) return 'Back and forth all game';
    if (n >= 5) return 'Multiple lead changes';
    return null;
  }

  m = label.match(/^(\d+) run innings$/);
  if (m) return 'A big innings total';

  m = label.match(/^Extra innings \((\d+)\)$/);
  if (m) {
    const innings = parseInt(m[1], 10);
    if (innings >= 13) return '🏆 Marathon extra innings';
    if (innings >= 12) return 'Marathon extra innings';
    return 'Went to extra innings';
  }
  m = label.match(/^Marathon extra innings \((\d+)\)$/);
  if (m) return '🏆 Marathon extra innings';

  m = label.match(/^(\d+) red cards$/);
  if (m) return parseInt(m[1], 10) >= 3 ? 'Multiple players sent off' : 'Two players sent off';

  if (label === 'Tie' || label === 'Tied/OT') return 'Down to the wire';
  if (label === 'Draw') return null;

  if (/^#\d+ vs #\d+$/.test(label)) return 'A ranked matchup';
  if (/^#\d+ ranked$/.test(label)) return 'One team is ranked';

  return null;
}

// ── Phrase selection — verbatim from site ────────────────────────────────────

export function getInsightPhrases(factors, sport) {
  if (!Array.isArray(factors) || factors.length === 0) return [];

  const ranked = [...factors].sort((a, b) =>
    Math.abs(b.points || 0) - Math.abs(a.points || 0)
  );

  const lcFactor = factors.find(f => f.label?.match(/^(\d+) lead changes$/));
  const leadChanges = lcFactor ? parseInt(lcFactor.label, 10) : 0;
  const hasComeback = factors.some(f => f.label?.includes('Close game after'));
  const hasRealBackAndForth = leadChanges >= 3 || hasComeback;

  const phrases = [];
  const seen = new Set();
  for (const f of ranked) {
    let phrase = null;
    if (Object.prototype.hasOwnProperty.call(INSIGHT_MAP, f.label)) {
      phrase = INSIGHT_MAP[f.label];
    } else {
      phrase = formatDynamicLabel(f.label, sport);
    }
    if (phrase && (phrase === 'Down to the wire' || phrase === 'Close finish' || phrase === 'Competitive finish')
        && (sport === 'wnba' || sport === 'nba') && !hasRealBackAndForth) {
      phrase = null;
    }
    if (!phrase) continue;
    if (seen.has(phrase)) continue;
    seen.add(phrase);
    phrases.push(phrase);
    if (phrases.length >= 3) break;
  }

  return phrases;
}

// ── Tier boundary ────────────────────────────────────────────────────────────
// Allowlist, not denylist. A new field in get-scores.js output cannot reach the
// safe view by default — the same property that makes the phrase layer safe.

export const TIER1_FIELDS = [
  'id', 'home', 'away', 'league', 'date', 'dateKey', 'ts', 'status',
  'homeRank', 'awayRank', 'broadcast', 'collinsworthWarning', 'watch',
];

/**
 * Classes the agent offers unprompted. Everything else is still INGESTED and
 * still describable — the site labels every game, including ones it tells you
 * to skip, so a user asking about their team gets an answer rather than
 * silence. These are only the ones that surface in an unfiltered list.
 */
export const RECOMMENDABLE_CLS = ['scorefest', 'watchworthy', 'watchable'];

/** Every class that may be stored. */
export const ALL_CLS = [...RECOMMENDABLE_CLS, 'defensive', 'blowout'];

/**
 * The full safe view. Declared explicitly because the Tier 1 fields are copied
 * in a loop, so TypeScript can only infer the two properties assigned by name
 * and every caller sees a half-typed object.
 *
 * This is also the authoritative list of what may cross the boundary — if a
 * field is not here, it does not reach the agent.
 *
 * @typedef {Object} SafeView
 * @property {string}  id
 * @property {string}  home
 * @property {string}  away
 * @property {string}  [league]
 * @property {string}  [date]
 * @property {string}  dateKey
 * @property {number}  ts
 * @property {string}  [status]
 * @property {number}  [homeRank]
 * @property {number}  [awayRank]
 * @property {string}  [broadcast]
 * @property {{name?: string, url?: string}} [watch]
 * @property {boolean} [collinsworthWarning]
 * @property {string}  cls
 * @property {string[]} phrases
 */

/**
 * Build the safe view. Returns null for games that must not be recommended.
 * `factors` is read here and dropped here; it never appears in the return value.
 *
 * @returns {SafeView|null}
 */
export function buildSafeView(game, sport) {
  const cls = game?.confidence?.cls;
  if (!cls) return null;

  const view = {};
  for (const k of TIER1_FIELDS) {
    if (game[k] !== undefined) view[k] = game[k];
  }
  view.cls = cls;
  view.phrases = getInsightPhrases(game.confidence.factors, sport);
  return view;
}
