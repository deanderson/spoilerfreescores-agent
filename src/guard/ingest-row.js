/**
 * The ingest Workflow's step boundary.
 *
 * This is the only place a game crosses from Tier 2 to Tier 1, and it is the
 * shape of what `step.do()` RETURNS — which matters more than it looks.
 * Workflows persists step return values, and `wrangler workflows instances
 * describe` prints them. A Tier 2 field here is durably stored outside the
 * Worker and readable by anyone with account access, whether or not the model
 * ever sees it.
 *
 * It lived inline in ingest.ts for two days, where no test could reach it. In
 * that time the Workflow persisted every raw score of every game, because
 * fetch and redact were separate steps. Nothing failed.
 *
 * Extracted here for the same reason createCallCache was: anything that shapes
 * what crosses a boundary belongs where the harness can see it.
 */

/**
 * Fields that must never appear in a row. Not an exhaustive list of Tier 2 —
 * the row is built from an allowlist, so this is a second check on the names
 * most likely to be reintroduced by someone "just adding one field".
 */
export const FORBIDDEN_ROW_FIELDS = [
  'h', 'a', 'period', 'homeLinescores', 'awayLinescores',
  'resultType', 'resultMargin', 'maxInnings', 'timelineCat', 'debug',
  'confidence', 'factors', 'score', 'points', 'margin', 'total',
  'homeRushYds', 'awayRushYds', 'homePassYds', 'awayPassYds',
  'maxRushLeader', 'maxRecvLeader',
];

/**
 * Build the D1 row from a safe view and its derived tags.
 *
 * Every field is named explicitly. There is no spread of the source game and
 * no loop over its keys, so a new field appearing upstream cannot arrive here
 * by accident — it has to be added on purpose.
 *
 * @param {import('./redaction.js').SafeView} view
 * @param {object} tags
 * @param {string} sport
 */
export function toIngestRow(view, tags, sport) {
  return {
    id: view.id,
    sport,
    home: view.home,
    away: view.away,
    league: view.league ?? null,
    date: view.date ?? null,
    date_key: view.dateKey,
    ts: view.ts,
    status: view.status ?? null,
    home_rank: view.homeRank ?? null,
    away_rank: view.awayRank ?? null,
    broadcast: view.broadcast ?? null,
    watch_name: view.watch?.name ?? null,
    watch_url: view.watch?.url ?? null,
    collinsworth_warning: view.collinsworthWarning ? 1 : 0,
    cls: view.cls,
    competitiveness: tags.competitiveness,
    scoring: tags.scoring,
    overtime: tags.overtime ? 1 : 0,
    ranked: tags.ranked,
    runtime_bucket: tags.runtime_bucket,
    phrases: JSON.stringify(view.phrases),
    ingested_at: Date.now(),
  };
}

/**
 * What the redact step returns. Counts are safe — they say how many games were
 * fetched, not what happened in any of them.
 */
export function buildStepResult(rows, fetched) {
  return { rows, fetched };
}
