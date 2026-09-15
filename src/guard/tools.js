/**
 * Tool schemas — the second enforcement layer (§8.1).
 *
 * Design rule, same as the D1 schema: if a field could carry a score, a count,
 * or a statement about absence, it does not exist. Nothing here is enforced by
 * the system prompt. A jailbroken model calling these tools with hostile
 * arguments still cannot obtain a number describing play, and still cannot
 * learn that a set is empty at team granularity.
 */

import { z } from 'zod';
import { TAG_VOCAB } from './tags.js';

const RESULT_LIMIT = 5;

// Result-set size is uninformative only while the corpus exceeds the limit.
// Below it, "how many came back" starts tracking the query. Enforced at ingest
// (see MIN_CORPUS in ingest.ts), asserted here so the two cannot drift apart.
export const MIN_CORPUS = RESULT_LIMIT;

// ── Schemas ──────────────────────────────────────────────────────────────────

// Zod, not raw JSON Schema: the AI SDK (ai@6) takes `inputSchema` as a zod
// schema. z.enum gives the same closed vocabulary the JSON enum did, and
// .strict() the same additionalProperties:false. Notation changed, guarantee
// did not.
//
// These live here rather than in server.ts so the closed vocabulary is
// testable under plain node, alongside the resolvers it constrains.

export const searchGamesInput = z.object({
  // Closed enums only. A free-text field here would let the model pass a
  // threshold ("margin under 5") and turn the tool into a binary search.
  competitiveness: z.enum(TAG_VOCAB.competitiveness).optional(),
  scoring:         z.enum(TAG_VOCAB.scoring).optional(),
  overtime:        z.boolean().optional(),
  ranked:          z.enum(TAG_VOCAB.ranked).optional(),
  recency:         z.enum(['latest_slate', 'this_week']).optional(),

  // Teams and leagues BOOST ordering. They never exclude. This is the
  // structural fix for §6.1: a hard team filter that returns nothing tells the
  // user their team's games were blowouts. A boost cannot, because the tool
  // returns the same number of games either way.
  prefer_teams:    z.array(z.string()).max(4).optional(),
  prefer_leagues:  z.array(z.string()).max(4).optional(),
}).strict();

export const watchOptionsInput = z.object({
  id: z.string(),
}).strict();

export const savePreferenceInput = z.object({
  // Closed key vocabulary. Free-text keys let the model record dimensions the
  // filter cannot act on, so the §7 durable/per-query split fails silently.
  key: z.enum(['competitiveness', 'scoring', 'overtime', 'ranked', 'teams', 'leagues']),
  value: z.string(),
  liked: z.boolean(),
}).strict();

export const TOOL_DESCRIPTIONS = {
  search_games:
    'Find completed games worth watching. Returns games with their qualities. '
    + 'Each returned game carries its own tags — read them to describe what you '
    + 'are offering. There is no count and no total; do not infer one. '
    + 'Pass ONLY what the user actually asked for. Do not invent teams, '
    + 'leagues, or preferences they did not mention — call with no arguments '
    + 'if they gave no constraints. Every argument is a hint for ranking, not '
    + 'a filter, so guessing does not narrow anything; it just reorders results '
    + 'around something the user never said.',
  get_watch_options:
    'Where and how to watch a specific game, plus an estimated runtime. '
    + 'Does not return anything about what happened in the game.',
  save_preference:
    'Record a DURABLE preference the user expressed about what they enjoy. '
    + 'Do not use for constraints scoped to this request ("tonight", "this '
    + 'weekend") — those are not preferences and must not persist.',
};

// ── Return shapes ────────────────────────────────────────────────────────────
//
// No `total`, no `matched`, no `count`, no `relaxed` flag, no `message` field.
// The model cannot report a number it was never given, and cannot announce that
// a filter was widened. It sees only games and their tags, and describes what
// it actually has in front of it.

export function toResult(row) {
  return {
    id: row.id,
    home: row.home,
    away: row.away,
    league: row.league,
    date: row.date,
    home_rank: row.home_rank ?? undefined,
    away_rank: row.away_rank ?? undefined,
    category: row.cls,
    qualities: {
      competitiveness: row.competitiveness,
      scoring: row.scoring,
      overtime: !!row.overtime,
      ranked: row.ranked,
    },
    phrases: JSON.parse(row.phrases),
  };
}

// ── search_games ─────────────────────────────────────────────────────────────

// Recency is measured against the NEWEST GAME IN THE CORPUS, not against the
// clock. NCAAF is weekly: on a Wednesday, "recent" means last Saturday, and a
// clock-relative window would make every value resolve to nothing.
//
// `today` was removed deliberately. It was empty six days out of seven, and a
// model answering "anything from today?" with Saturday's games is asserting
// something false about a specific date — the same class of harm as §6.1a.
const RECENCY_DAYS = { latest_slate: 2, this_week: 7 };

/**
 * Enum filters are soft: they rank, they do not exclude. The tool returns
 * RESULT_LIMIT games whenever that many exist in the corpus at all, so the
 * size of the result set carries no information about the query.
 *
 * The user still gets an honest answer, because each game's tags travel with
 * it — the model can see it is offering a `competitive` game to someone who
 * asked for a `nail_biter` and can say so. That is a statement about what it
 * HAS, not about what is missing.
 */
export function searchGames(rows, args = {}) {
  const newest = rows.length ? Math.max(...rows.map(r => r.ts)) : 0;

  const scored = rows.map(row => {
    let score = 0;

    if (args.competitiveness) score += row.competitiveness === args.competitiveness ? 10 : 0;
    if (args.scoring)         score += row.scoring === args.scoring ? 8 : 0;
    if (args.overtime !== undefined) score += !!row.overtime === args.overtime ? 6 : 0;
    if (args.ranked)          score += row.ranked === args.ranked ? 4 : 0;

    if (args.recency) {
      const ageDays = (newest - row.ts) / 86_400_000;
      score += ageDays <= RECENCY_DAYS[args.recency] ? 5 : 0;
    }

    for (const t of args.prefer_teams ?? []) {
      const needle = t.toLowerCase();
      if (row.home.toLowerCase().includes(needle) || row.away.toLowerCase().includes(needle)) {
        score += 12;
      }
    }
    for (const l of args.prefer_leagues ?? []) {
      if (row.league?.toLowerCase() === l.toLowerCase()) score += 3;
    }

    // Tie-break on category then recency so ordering is stable and does not
    // encode anything about the query.
    const tier = row.cls === 'scorefest' ? 2 : row.cls === 'watchworthy' ? 1 : 0;
    return { row, score, tier };
  });

  scored.sort((a, b) =>
    b.score - a.score || b.tier - a.tier || b.row.ts - a.row.ts);

  return { games: scored.slice(0, RESULT_LIMIT).map(s => toResult(s.row)) };
}

// ── Tool input repair ────────────────────────────────────────────────────────

/**
 * Narrow repair for tool arguments the model gets *typed* wrong.
 *
 * Llama sends `{"overtime": "true"}` — the string, where the schema wants a
 * boolean. The call is rejected, the model retries, and the user watches error
 * cards until one attempt happens to be well typed.
 *
 * This ONLY fixes types. It never coerces a value into the enum vocabulary:
 * an out-of-vocabulary `competitiveness` stays rejected, because accepting it
 * would mean layer 2 no longer closes the vocabulary (§8.1). The distinction
 * matters — "true" and true are the same value in two encodings, whereas
 * "blowout" and "competitive" are different claims.
 *
 * @returns repaired arguments object, or null when nothing safe can be done.
 */
export function repairToolInput(schema, rawInput) {
  let obj;
  if (typeof rawInput === 'string') {
    try { obj = JSON.parse(rawInput); } catch { return null; }
  } else if (rawInput && typeof rawInput === 'object') {
    obj = { ...rawInput };
  } else {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  const fixed = { ...obj };

  // String -> boolean, for exactly the two literals. "yes"/"1" are NOT
  // accepted: they are guesses about intent, not a different encoding of the
  // same value.
  for (const key of ['overtime']) {
    const v = fixed[key];
    if (v === 'true') fixed[key] = true;
    else if (v === 'false') fixed[key] = false;
  }

  // A single string where an array is expected is an encoding difference too.
  for (const key of ['prefer_teams', 'prefer_leagues']) {
    if (typeof fixed[key] === 'string') fixed[key] = [fixed[key]];
  }

  // Drop keys the schema does not know, so one fabricated key does not sink an
  // otherwise valid call. But if NOTHING known survives, refuse: turning
  // {"margin_under": 5} into {} would let a numeric-threshold probe quietly
  // succeed as an unfiltered search, and layer 2 would no longer visibly
  // reject out-of-vocabulary input.
  const known = new Set(Object.keys(schema.shape ?? {}));
  const hadKeys = Object.keys(fixed).length > 0;
  for (const key of Object.keys(fixed)) {
    if (!known.has(key)) delete fixed[key];
  }
  if (hadKeys && Object.keys(fixed).length === 0) return null;

  const result = schema.safeParse(fixed);
  return result.success ? result.data : null;
}
