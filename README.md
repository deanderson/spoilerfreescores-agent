# sfs-agent

A chat agent for [spoilerfreescores.com](https://spoilerfreescores.com) that
recommends recent college football games worth watching, without revealing how
they turned out.

**Live:** [sfs-agent.deanderson.workers.dev](https://sfs-agent.deanderson.workers.dev)
· embedded on the college football tab at
[spoilerfreescores.com](https://spoilerfreescores.com)

NCAAF only. Cloudflare Workers AI (Llama 3.3 70B), Durable Objects, D1,
Workflows, AI Gateway.

## The guarantee

**It never reveals the final score and never says who won.** Also never a
margin, a total, or any number describing what happened. Ranks and dates are
permitted — they are pre-game facts.

Three enforcement layers: scores are stripped before storage and D1 has no
column that can hold one; tool inputs are closed enums, so a numeric threshold
is rejected before the tool runs; a streaming scanner blocks any unpermitted
digit in the output.

What is **not** guaranteed: that a reader cannot infer an outcome from
permitted facts. "Ranked 16th" plus "lopsided" is suggestive. That is accepted
— the site publishes both.

Everything else — how much colour to give before being asked, when skip games
surface — is product judgement implemented in the system prompt. It has no test
and it drifts. See [the spec](docs/SPEC-spoiler-free-agent-v2.md) §2.

## Running it

```bash
npm install
npm run check        # 11 tests + tsc
```

The tests need no Cloudflare account. `guard/` is plain JS with no Cloudflare
imports, which is the point: the spoiler guard is verifiable without a deploy.

To deploy you need a Workers **Paid** plan (scheduled Workflows require it), a
D1 database, and an AI Gateway named `sfs-agent`:

```bash
wrangler d1 create sfs-agent-db                          # id goes in wrangler.jsonc
wrangler d1 execute sfs-agent-db --remote --file=schema.sql
npm run deploy                                           # vite build + deploy
npx wrangler workflows trigger sfs-ingest                # first corpus
```

Ingest then runs every six hours on its own. Check it with
`npx wrangler workflows instances list sfs-ingest`.

`npm run deploy`, not `wrangler deploy` — the bare command skips the vite
build and ships a stale UI.

Set rate limits on the AI Gateway before exposing the URL — it spends Neurons
per request. If you embed it, set `Content-Security-Policy: frame-ancestors`
in `public/_headers`.

`npm run snapshot` refreshes the site snapshot that test 1 compares against;
the differential test reports UNVERIFIED once it is more than 14 days old.

`DEBUG_FRAMES=1` as a deploy var turns on per-frame logging of the Workers AI
stream. Off by default.

## Layout

```
src/guard/        no Cloudflare imports, fully tested
  redaction.js      ported from the site: raw factors -> approved phrases
  tags.js           raw scores -> closed-vocabulary tags
  tools.js          tool schemas, search, ranking, line composition
  scanner.js        output scanner and its stream transform
  ingest-row.js     the Workflow step boundary
src/
  server.ts         the Durable Object, tools, system prompt
  ingest.ts         the ingest Workflow
  ai-stream-fix.js  workers-ai-provider 3.3.1 duplicates every fragment
  app.tsx           chat UI
test/verify.mjs   the harness
schema.sql        D1
```

Anything that shapes what crosses a boundary lives in `guard/`. Twice in this
build a guard was written in `server.ts` instead and immediately reintroduced
the thing it was meant to prevent.

## Tests

`npm run check`. Every test has a sabotage run behind it proving it fails when
the thing it guards breaks.

1. **Differential** — the ported redaction layer still matches the live site
2. **Invariant** — no digits in the emittable vocabulary, not just fixture output
3. **Tier boundary** — no Tier 2 field or raw factor label in a safe view
4. **Override coverage** — the four declared divergences from the site, synthetic
5. **Oracle resistance** — result size carries no information about the query
6. **Schema closure** — hostile tool inputs rejected
7. **Output scanner** — violations caught, clean lines passed, split deltas
8. **Scan transform** — stream wiring, stopStream, no stranded fragment
9. **Stream dedupe** — text, tool calls and numeric carriers de-duplicated
10. **Tool input repair** — type repairs applied, vocabulary repairs refused
11. **Step boundary** — no score, margin or raw label in a persisted step result

## Deferred

- **An eval engine.** The harness covers everything enforced in code and
  nothing that is prompt-shaped, which is the largest untested surface. Spec
  §10.2.
- **Tennis set counts.** Suppressed pending a ruling on whether set count is a
  named exception like overtime. Blocks a second sport.
- **Phrase repetition.** 9 of 18 close games carry one phrase and it is the
  same phrase for all nine. Selection cannot fix repetition that is real.
- **Category spread.** An unfiltered list is usually five "must watch", so the
  label carries no information on turn one.

## Docs

- [Spec v2](docs/SPEC-spoiler-free-agent-v2.md) — what the code does and what
  it actually guarantees, written after building
- [Spec v1](docs/SPEC-spoiler-free-agent-v1.md) — what was believed before
  building; the diff is most of the story
- [Writeup](docs/WRITEUP.md)
- [Transcripts](docs/transcripts/) — the build conversations
