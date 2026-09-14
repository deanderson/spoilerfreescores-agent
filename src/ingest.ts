import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { buildSafeView } from './guard/redaction.js';
import { deriveTags } from './guard/tags.js';
import { MIN_CORPUS } from './guard/tools.js';

const SPORT = 'ncaaf';
const RETENTION_DAYS = 28;
const SOURCE = 'https://spoilerfreescores.com/.netlify/functions/get-scores?sport=ncaaf';

/**
 * Ingest Workflow — spec §8.
 *
 * Boundary crossing happens in step 2 and nowhere else. Everything after it
 * operates on safe views; the raw payload is not returned from the workflow,
 * not logged, and not passed to any later step in a form that retains scores.
 *
 * Scheduled via `schedules` on the binding in wrangler.jsonc — no separate
 * Worker with a scheduled handler.
 */
export class IngestWorkflow extends WorkflowEntrypoint<Env> {
  async run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
    const runId = event.instanceId ?? crypto.randomUUID();
    const startedAt = Date.now();

    // 1. Fetch. Raw payload — full of Tier 2. Stays inside this step.
    const raw = await step.do(
      'fetch get-scores',
      { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '2 minutes' },
      async () => {
        const res = await fetch(SOURCE, { headers: { 'user-agent': 'sfs-agent-ingest' } });
        if (!res.ok) throw new Error(`get-scores ${res.status}`);
        return await res.json();
      },
    );

    // 2. Redact. THE boundary. Input has scores; output cannot.
    //
    // Note this runs in-step rather than being split across steps: step
    // results are persisted by Workflows, so returning the raw payload from
    // step 1 and redacting in step 2 would durably store every score. Fetch
    // and redact are one step for that reason, not for convenience.
    const { rows, fetched } = await step.do('redact and derive tags', async () => {
      const games = (raw as any)?.[SPORT]?.recent ?? [];
      const out = [];
      for (const g of games) {
        const view = buildSafeView(g, SPORT);       // cls gate + approved phrases
        if (!view) continue;
        const tags = deriveTags(g, SPORT);          // reads Tier 2, returns enums
        if (!tags) continue;
        out.push({
          id: view.id,
          sport: SPORT,
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
        });
      }
      return { rows: out, fetched: games.length };
    });

    // 3. Write. Upsert, so a failed run leaves the last good set in place
    // rather than emptying the table — an empty table and genuine scarcity
    // look identical to the agent, and §6.1 forbids it from distinguishing.
    const written = await step.do(
      'write safe views to D1',
      { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' } },
      async () => {
        if (!rows.length) return 0;
        const cols = Object.keys(rows[0]);
        const sql =
          `INSERT INTO games (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')}) ` +
          `ON CONFLICT(id) DO UPDATE SET ${cols.filter(c => c !== 'id').map(c => `${c}=excluded.${c}`).join(',')}`;
        const stmt = this.env.DB.prepare(sql);
        await this.env.DB.batch(rows.map(r => stmt.bind(...cols.map(c => (r as any)[c]))));
        return rows.length;
      },
    );

    // 4. Prune. The source blob only spans ~8 days, so games fall out of
    // get-scores while staying here. Keeping them is deliberate — they are
    // final, they will never change, and inventory scarcity is the binding
    // constraint on this agent. But unbounded growth makes "this week" a lie,
    // so cap it.
    //
    // The prune is floor-aware: it will not take the corpus below MIN_CORPUS.
    // Early in a season, retention loses to the oracle guarantee.
    const pruned = await step.do('prune beyond retention', async () => {
      const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
      const { results } = await this.env.DB.prepare(
        `SELECT COUNT(*) AS keep FROM games WHERE sport = ? AND ts >= ?`,
      ).bind(SPORT, cutoff).all();
      if ((results[0] as any).keep < MIN_CORPUS) return 0;

      const res = await this.env.DB.prepare(
        `DELETE FROM games WHERE sport = ? AND ts < ?`,
      ).bind(SPORT, cutoff).run();
      return res.meta.changes ?? 0;
    });

    // 5. Corpus floor. search_games returns a fixed number of games so that
    // result-set size carries no information about the query (§6.1). That only
    // holds while the corpus exceeds the limit. Below it, the agent becomes an
    // oracle no matter what the tool schema says — so the run fails loudly
    // rather than leaving a corpus that cannot be served safely.
    const corpus = await step.do('assert corpus floor', async () => {
      const { results } = await this.env.DB.prepare(
        `SELECT COUNT(*) AS n FROM games WHERE sport = ?`,
      ).bind(SPORT).all();
      const n = (results[0] as any).n as number;
      if (n < MIN_CORPUS) {
        throw new Error(
          `corpus floor breached: ${n} games, need ${MIN_CORPUS}. `
          + `search_games cannot return a fixed-size result set below this, so `
          + `result count would start tracking the query. Do not serve.`,
        );
      }
      return n;
    });

    await step.do('log run', async () => {
      await this.env.DB.prepare(
        `INSERT INTO ingest_runs (run_id, sport, started_at, fetched, recommendable, written, pruned, corpus_size)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(runId, SPORT, startedAt, fetched, rows.length, written, pruned, corpus).run();
    });

    return { fetched, written, pruned, corpus };
  }
}
