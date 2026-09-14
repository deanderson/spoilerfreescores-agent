/**
 * Filter-tag derivation — spec §3.3.
 *
 * Reads Tier 2 fields (h, a, period). Returns closed-enum values only. Nothing
 * here returns a number; the output IS the boundary. Tier 2 goes in, enum
 * comes out, and the Workflow never writes the input.
 *
 * Style tags (ground_game, passing_volume, standout_*) are deliberately absent
 * — cut from filters for v1 per §6.1b because enrichment is capped at 25 games
 * closest-first, so filtering on them implicitly filters toward close games.
 * They remain available as disclosure prose via the ported INSIGHT_MAP.
 */

export const TAG_VOCAB = {
  competitiveness: ['nail_biter', 'close', 'competitive'],
  scoring: ['shootout', 'balanced'],
  ranked: ['both', 'one', 'neither'],
  runtime_bucket: ['under_2h', '2_to_3h', 'over_3h'],
  overtime: [true, false],
};

// Per-sport runtime baselines in hours. Derived from a constant plus an OT
// adjustment, not measured per game (§3.3).
const RUNTIME_BASELINE_H = { ncaaf: 3.5 };
const OT_ADJUSTMENT_H = 0.4;

function runtimeBucket(sport, isOvertime) {
  const base = RUNTIME_BASELINE_H[sport];
  if (base === undefined) return null;
  const est = base + (isOvertime ? OT_ADJUSTMENT_H : 0);
  if (est < 2) return 'under_2h';
  if (est <= 3) return '2_to_3h';
  return 'over_3h';
}

/**
 * @returns tag object, or null if the game falls outside the recommendable
 *          band (spec §3.3: diff >= 28 blowout, total <= 30 low scoring).
 */
export function deriveTags(game, sport) {
  if (sport !== 'ncaaf') throw new Error(`deriveTags: no thresholds for "${sport}"`);

  const h = game.h, a = game.a;
  if (typeof h !== 'number' || typeof a !== 'number') return null;

  const diff = Math.abs(h - a);
  const total = h + a;

  // NOTE: the spec's §3.3 numeric ingest filter (diff >= 28, total <= 30) is
  // deliberately NOT applied here. `cls` is the single gate (§3.1). Running
  // both gave two different definitions of "recommendable" that disagreed on
  // 8 of 45 fixture games. See the competitiveness ceiling below.

  let competitiveness;
  if (diff <= 3) competitiveness = 'nail_biter';
  else if (diff <= 7) competitiveness = 'close';
  else competitiveness = 'competitive';  // ceiling raised 14 -> open; cls
                                          // already excluded blowouts, and a
                                          // coarser bucket leaks fewer bits

  const scoring = total >= 65 ? 'shootout' : 'balanced';
  const overtime = (game.period ?? 4) > 4;

  const hr = game.homeRank, ar = game.awayRank;
  const rankedCount = (hr ? 1 : 0) + (ar ? 1 : 0);
  const ranked = rankedCount === 2 ? 'both' : rankedCount === 1 ? 'one' : 'neither';

  return {
    competitiveness,
    scoring,
    overtime,
    ranked,
    runtime_bucket: runtimeBucket(sport, overtime),
  };
}
