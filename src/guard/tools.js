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
export { RECOMMENDABLE_CLS, ALL_CLS } from './redaction.js';
import { RECOMMENDABLE_CLS as RECOMMENDABLE } from './redaction.js';

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

  // How many results to skip. The only way to answer "any others?" — without
  // it the same five come back and the model announces them as new.
  // Team path only; the generic path is fixed-size by design (§6.2).
  offset:          z.number().int().min(0).max(50).optional(),
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
    + 'If the result says more: true, there are further games for that team — '
    + 'call again with offset set past what you have already seen (offset 5, '
    + 'then 10) to get them. Never present the same games twice as if they were '
    + 'new. '
    + 'What comes back is a SELECTION, never an inventory. More games exist '
    + 'than are returned, always, and nothing in the result tells you how many '
    + 'or which. You cannot conclude from a game being absent that it does not '
    + 'exist, was excluded, or was not worth watching. '
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

/**
 * Display labels for the disclosure category, matching the wording on
 * spoilerfreescores.com.
 *
 * Mapped here rather than explained in the system prompt: the model was
 * flattening every game to "must watch", which makes the label carry no
 * information. The tool now hands it the finished word, so there is nothing
 * to get wrong — and it never sees the internal enum, so it cannot leak it
 * into prose either.
 */
export const CATEGORY_LABEL = {
  watchworthy: 'must watch',
  scorefest: 'scorefest',
  watchable: 'watchable',
  // The site's third label. Blowouts and defensive slogs are stored and
  // described, not hidden — they just never appear in a list the user did not
  // ask for by name.
  defensive: 'skip',
  blowout: 'skip',
};

export function toResult(row) {
  const phrases = JSON.parse(row.phrases);
  const category = CATEGORY_LABEL[row.cls] ?? row.cls;

  return {

    id: row.id,
    home: row.home,
    away: row.away,
    league: row.league,
    date: row.date,
    home_rank: row.home_rank ?? undefined,
    away_rank: row.away_rank ?? undefined,
    category,
    qualities: {
      competitiveness: row.competitiveness,
      scoring: row.scoring,
      overtime: !!row.overtime,
      ranked: row.ranked,
    },
    phrases,
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
  // Non-recommendable games are in the corpus but never surface unprompted.
  // They become visible only when the user names the team, which is the same
  // bargain the site strikes: every game is labelled, but you go looking for
  // the bad ones.
  // A named team shows EVERYTHING that team played — skip games included,
  // labelled as skip. The site labels every game, and silence about a user's
  // own team is worse than the label.
  //
  // Two earlier gates both failed on real data and are gone:
  //   - substring: "Texas" matched Texas Southern, Texas Tech, East Texas A&M.
  //   - trailing words: "Longhorns" is unique but "Tigers" is shared by eleven
  //     teams, "Owls" and "Bulldogs" likewise.
  // Ambiguity no longer needs resolving: an ambiguous query just shows more
  // teams' games, best first, which is a reasonable answer to a vague question.
  //
  // Matching is on whole words so "Texas" does not match "Texans": the query's
  // words must appear as a contiguous run in the team's name.
  const wanted = (args.prefer_teams ?? []).map(t => t.toLowerCase().trim()).filter(Boolean);

  const refersTo = (team, query) => {
    const t = team.toLowerCase().split(/\s+/);
    const q = query.split(/\s+/);
    for (let i = 0; i + q.length <= t.length; i++) {
      if (q.every((w, j) => t[i + j] === w)) return true;
    }
    return false;
  };
  const namesTeam = (row) =>
    wanted.some(q => refersTo(row.home, q) || refersTo(row.away, q));

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
      const needle = t.toLowerCase().trim();
      if (row.home.toLowerCase().includes(needle) || row.away.toLowerCase().includes(needle)) {
        score += 12;
      }
    }
    for (const l of args.prefer_leagues ?? []) {
      if (row.league?.toLowerCase() === l.toLowerCase()) score += 3;
    }

    // Tie-break on category then recency so ordering is stable and does not
    // encode anything about the query.
    // Full ordering, not just the top two classes. Before skip games entered
    // the corpus, `watchable` and everything else tied at 0 and fell through to
    // date — so a named team's blowouts outranked their watchable game.
    const tier =
      row.cls === 'scorefest'   ? 4 :
      row.cls === 'watchworthy' ? 3 :
      row.cls === 'watchable'   ? 2 :
      row.cls === 'defensive'   ? 1 : 0;
    return { row, score, tier };
  });

  scored.sort((a, b) =>
    b.score - a.score || b.tier - a.tier || b.row.ts - a.row.ts);

  // Two paths.
  //
  // NAMED TEAM: show that team's games, best first, skip games included. Size
  // varies with how many games they played — which says nothing about how any
  // of them went, so it carries no spoiler. `more` tells the model the list was
  // capped, so it can say so instead of implying the list is complete.
  //
  // NO TEAM: the §6.2 path. Recommendable games only, always the same number,
  // and no field capable of expressing absence. This is the one that has to
  // stay uninformative: a generic query returning nothing for a team is what
  // would reveal that their games were blowouts.
  if (wanted.length) {
    const matched = scored.filter(s => namesTeam(s.row));
    // A name that matches nothing — a typo, a team that did not play, a
    // misheard mascot — must not produce an empty list. An empty result is
    // exactly the absence signal §6.2 exists to prevent, and it reads as "your
    // team had nothing" when it means "I did not recognise that". Fall through
    // to the ordinary recommendations instead.
    if (!matched.length) {
      return {
        games: withLines(scored
          .filter(s => RECOMMENDABLE.includes(s.row.cls))
          .slice(0, RESULT_LIMIT)
          .map(s => toResult(s.row))),
      };
    }
    const offset = Math.min(args.offset ?? 0, Math.max(0, matched.length - 1));
    const page = matched.slice(offset, offset + RESULT_LIMIT);
    return {
      games: withLines(page.map(s => toResult(s.row))),
      more: matched.length > offset + page.length,
    };
  }

  const games = scored
    .filter(s => RECOMMENDABLE.includes(s.row.cls))
    .slice(0, RESULT_LIMIT)
    .map(s => toResult(s.row));

  return { games: withLines(games) };

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

  // Numeric string -> number. The model sends offset: "5" and the call is
  // rejected, exactly as it sent overtime: "true". Only clean integers: "5.5"
  // and "five" are not the same value in a different encoding.
  for (const key of ['offset']) {
    const v = fixed[key];
    if (typeof v === 'string' && /^\d+$/.test(v.trim())) fixed[key] = Number(v.trim());
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

// ── Repeat-call cache ────────────────────────────────────────────────────────

/**
 * Per-request memo for tool calls.
 *
 * A model asked to "output the raw tool result as JSON" will call the same tool
 * with the same arguments until the step limit, learning nothing each time.
 *
 * The first attempt at this returned `{ games: [], repeated: true }` — which
 * put an EMPTY ARRAY and two new fields into the one return shape that must
 * never express absence (§6.1). The model could then say "nothing matched".
 * A repeated call now replays the identical earlier result: same games, same
 * shape, no new keys, nothing learned and nothing leaked.
 *
 * Lives here rather than in server.ts because the shape guarantee is testable
 * and the server is not.
 */
/**
 * Preformatted first-turn line: matchup and category ONLY.
 *
 * Mirrors the site. spoilerfreescores.com shows the category in the open and
 * puts the colour commentary ("went to overtime", "down to the wire") behind a
 * Why Watch button — the reader chooses to reveal it. Chat has no button, so
 * the ASK is the consent. Leading with a phrase made the agent more revealing
 * than the site it is built on.
 *
 * `phrases` still travels in the payload for the second rung.
 */
function withLines(games) {
  for (const g of games) {
    g.line = `${g.away} vs ${g.home} — ${g.category}.`;
  }
  return games;
}

export function createCallCache() {
  const seen = new Map();
  return {
    /** @returns {{hit: boolean, value: any}} */
    lookup(toolName, args) {
      const key = `${toolName}:${JSON.stringify(args ?? null)}`;
      return seen.has(key)
        ? { hit: true, value: seen.get(key) }
        : { hit: false, value: undefined };
    },
    remember(toolName, args, value) {
      seen.set(`${toolName}:${JSON.stringify(args ?? null)}`, value);
      return value;
    },
    get size() { return seen.size; },
  };
}
