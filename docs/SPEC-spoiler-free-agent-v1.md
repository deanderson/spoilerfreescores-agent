# Spoiler-Free Game Recommender — v1 Design Spec

Design settled in a prior session. This document is the build brief.

---

## 1. Context

**Product.** spoilerfreescores.com surfaces sports games worth watching without
revealing outcomes. The existing site shows curated picks across ~11 sports with
category tiers (Must Watch / Watchable) and a "Why watch?" reveal.

**This build.** A chat agent. The user describes what they want in natural
language — *"I like high scoring, hate defensive slogs, I've got two hours
tonight"* — and the agent recommends completed games matching those preferences,
remembers preferences across the session, and never reveals outcomes.

**Core constraint.** The agent reasons over game data derived from final scores
but must never leak them. *"An offensive shootout that stayed close throughout"*
is fine. *"104 combined points"* is not.

**Assignment requirements** (all four must be demonstrably present):

| Requirement | Satisfied by |
|---|---|
| LLM | Llama 3.3 70B Instruct on Workers AI |
| Workflow / coordination | Durable Objects (`agents` SDK) + Workflows |
| User input via chat | `agents-starter` chat UI |
| Memory or state | Per-session DO storage |

Prompt history is submitted and graded. Write prompts that declare constraints
and specify verification, not "make it work."

### 1.1 Current state — infrastructure already set up

- Project scaffolded from `cloudflare/agents-starter` at `~/projects/sfs-agent`
  on the dev box (`workerbee`). Node 22 (via nvm), npm 10.9.8.
- Repo: `github.com/deanderson/spoilerfreescores-agent`, initial commit pushed
  to `main`.
- `wrangler.jsonc` already has both bindings wired:
  - `ai: { binding: "AI" }`
  - `d1_databases: [{ binding: "DB", database_name: "sfs-agent-db",
    database_id: "eff9b5a2-ba95-442e-a525-5b8eb377b694" }]`
  - `durable_objects` bound to `ChatAgent` (the starter's DO class).
- `src/server.ts` model string already changed from the starter's default to
  `@cf/meta/llama-3.3-70b-instruct-fp8-fast` — confirmed present in the file.
- AI Gateway created in the dashboard (name: `sfs-agent`) — **not yet wired
  into `server.ts`**; the `createWorkersAI({ binding: this.env.AI })` call
  currently bypasses it. Wiring it is part of build step 3/4, not done.
- Cloudflare account is Free tier. Workers AI free allocation is 10,000
  Neurons/day shared across all models — large models burn this fast. Upgrade
  to Paid ($5/mo) if adversarial-testing volume in step 4 hits the ceiling.
- `worker-configuration.d.ts` is the live generated types file (this Wrangler
  version renamed it from the older `env.d.ts` — that file was deleted to
  avoid two stale copies of the same interface).
- `~/ncaaf-fixture.json` on workerbee: raw `get-scores.js?sport=ncaaf` output,
  218 games, all confidence classes represented. This is the fixture for the
  step 1 differential/invariant tests — upload it alongside this spec.
- The redaction source (`INSIGHT_MAP`, `formatDynamicLabel`,
  `getInsightPhrases`) lives in the site's `index.html`, not yet extracted
  into this repo — upload `index.html` alongside this spec so step 1 can pull
  the real ~250-line block rather than reconstructing it from this
  document's summary.
- The starter's `server.ts` currently has extra scope beyond this spec — MCP
  server tools, `calculate`, `getUserTimezone`, `scheduleTask` /
  `getScheduledTasks` / `cancelScheduledTask`. None of this is used; stripping
  it is part of build step 3, not done yet.

---

## 2. Existing data source

Games come from an existing Netlify function, `get-scores.js`. Do not modify it.
The agent consumes its output and redacts downstream.

### 2.1 Payload shape (real, verified)

```
id, home, away, h, a, date, dateKey, time, league, status, ts, period
optional:   broadcast, geoBroadcasts, collinsworthWarning,
            homeRank, awayRank, homeLinescores, awayLinescores
per-sport:  timelineCat, lateGoal, ninetyGoal, resultType, resultMargin,
            maxInnings, homeRushYds, awayRushYds, homePassYds, awayPassYds,
            maxRushLeader, maxRecvLeader, debug{avg1, avg2, round, nineDart}
confidence: { score: 0-100, cls, factors: [{label, points}] }
watch:      { name, url }
```

`cls` ∈ `scorefest` | `watchworthy` | `watchable` | `defensive` | `blowout`

Confirmed against the live fixture: `scorefest` never fires (0 of 218 games) —
consistent with the gated-scorefest fix that's built but not yet deployed
(§thresholds-and-api-learnings). The agent must not depend on `scorefest`
existing; a high-scoring recommendation comes from the `scoring` tag (§3.3),
not from `cls`.

### 2.2 The `factors` field is the primary leak

145 `factors.push` sites. 48 interpolate a raw number into the label. Confirmed
patterns include:

```
${diff} pt margin      ${total} pts        ${total} goals      ${total} runs
${lc} lead changes     Won by ${n} runs    Won by ${n} wkts    Comfortable win
Extra innings (${g.period})
```

Every one of the 145 also carries an invertible `points` weight.

**`factors` never crosses the boundary.** It is not sanitized, filtered, or
parsed — it is dropped. See §3.2.

---

## 3. Data model

### 3.1 Tier split

**Tier 2 — never leaves the Worker. Never enters an LLM context window.**

```
h, a, period, homeLinescores, awayLinescores, resultType, resultMargin,
maxInnings, timelineCat, debug.*, confidence.score, confidence.factors,
homeRushYds, awayRushYds, homePassYds, awayPassYds, maxRushLeader, maxRecvLeader
```

**Tier 1 — the agent's view.**

```
id, home, away, league, date, dateKey, ts, status,
homeRank, awayRank, broadcast, collinsworthWarning, watch,
cls  (only: scorefest | watchworthy | watchable)
+ derived tags (§3.2)
```

`defensive` and `blowout` games are excluded at ingest. They are not
recommendable, and both values describe an outcome.

### 3.2 Disclosure phrases — port the existing layer

**The redaction layer already exists.** `index.html` contains `INSIGHT_MAP`,
`formatDynamicLabel`, and `getInsightPhrases` (~250 lines) — a curated,
spoiler-reviewed label vocabulary that already converts numeric factor labels
into phrases with sport-aware thresholds, and caps output at three phrases per
game.

It is already whitelist-by-construction. Unmapped labels fall through to
`formatDynamicLabel`, which returns `null` on every unmatched path, and
`getInsightPhrases` drops falsy values. A new factor added to `get-scores.js`
cannot render. This is the exact property the agent needs.

**Do not reimplement it. Port it.** Lift the three functions into the Worker so
they run *before* the LLM rather than in the browser after the full payload has
already been delivered. The build moves the guarantee from render-time to
data-time.

Two entries must be changed in the Worker's copy (they violate invariant 1;
leave the site untouched):

| Label | Site phrase | Worker phrase |
|---|---|---|
| `⭐ Standout 40+ pt game` | `A player went off (40+ pts)` | `A player went off` |
| `Bagel set` | `Included a 6-0 set` | `Included a shutout set` |

### 3.3 Filter tags — closed enum

Disclosure phrases are prose; the preference filter needs structured values.
Derived separately in the Workflow from Tier 2 fields, using a fixed enum.

**NCAAF tag derivation** (thresholds taken from the existing `ncaaf` branch of
`computeConfidence`, verified against a 45-game FBS sample):

| Tag | Values | Derived from |
|---|---|---|
| `competitiveness` | `nail_biter` \| `close` \| `competitive` | `diff` ≤3 / ≤7 / ≤14 |
| `scoring` | `shootout` \| `balanced` | `total` ≥65 / 31–64 |
| `overtime` | bool | `period` > 4 |
| `ranked` | `both` \| `one` \| `neither` | `homeRank`, `awayRank` |
| `ground_game` | bool | `max(homeRushYds, awayRushYds)` ≥200 |
| `passing_volume` | bool | `max(homePassYds, awayPassYds)` ≥300 |
| `standout_rusher` | bool | `maxRushLeader` ≥150 |
| `standout_receiver` | bool | `maxRecvLeader` ≥120 |

Note: the four style tags already use `Math.max(home, away)` upstream, so they
are team-agnostic by construction and satisfy invariant 2 without extra work.

Excluded by ingest filter: `diff` ≥28 (blowout), `total` ≤30 (low scoring).

`runtime_bucket` is derived from a per-sport constant plus an OT adjustment, not
measured per game. NCAAF baseline ~3.5h.

---

## 4. Spoiler policy

**Premise.** Zero outcome disclosure is impossible — "Must Watch" already rules
out a blowout. The product is a deliberate, bounded leak. The policy specifies
how much and of what kind.

### 4.1 Invariants

A statement is a spoiler if it violates **any one**:

1. **No quantities.** No number describing play: scores, margins, totals, event
   counts, point weights. Permitted numbers are pre-game only — poll rank, date,
   runtime estimate.
2. **No asymmetry.** No fact attributed to one side. *"A huge rushing game"*
   passes; *"Alcorn State had a huge rushing game"* fails.
3. **No outcome attribution.** Never who won, led, came back, or was eliminated.

### 4.2 Composition test

Invariants are per-statement; leaks are cumulative. **No set of facts released in
a session may narrow to a single reconstructable result.** Applied to the whole
safe view at build time, per sport. Cricket needs specific scrutiny — its result
vocabulary is structurally narrow and few tags may bound the margin tightly.

### 4.3 Named exception

**Category tier and overtime status are disclosed.** Both reveal outcome shape.
Both are the reason to watch, and overtime is load-bearing for runtime
filtering. Stated as a bounded exception rather than an oversight.

Open decision carried forward: penalty shootout was previously rejected as
spoiler-revealing while overtime ships. Structurally these are the same
disclosure. Recommended resolution is to allow both under invariant 3. Whichever
way it goes, the policy must state it explicitly.

### 4.4 Test against a real record

Source card: *Alcorn State vs Arkansas-Pine Bluff, Sep 12, FCS.*

| Item | Verdict |
|---|---|
| `104 pts` | FAIL — invariant 1 |
| `2 pt margin` | FAIL — invariant 1 |
| `+30`, `+18` point weights | FAIL — invariant 1 |
| `Won by 7 wkts` | FAIL — invariants 1 and 3 |
| `⚡ Overtime` | PASS — §4.3 exception |
| `Big rushing game` | PASS |
| `Must Watch` | PASS — §4.3 exception |

---

## 5. Disclosure ladder

Progressive disclosure governs **ordering, not ceiling**. A fixed budget of
disclosable facts per game, identical whether the user asks once or thirty times.

The budget already exists: `getInsightPhrases` caps at three phrases, ranked by
absolute point contribution. The port inherits both the cap and the ranking
unchanged — checked against the NCAAF fixture, only 3 of 45 recommendable games
have more than three factors, so the cap is rarely binding and not worth
parameterizing.

**The real constraint is data, not budget.** Across the 45 recommendable games,
31 have one or two factors total (excluding the recency bonus). For most games
there is nothing left to disclose after the second rung — the honest response
to a follow-up is "that's about all there is," not a withheld fact. Design and
test the floor response as the common case, not an edge case.

**Architectural consequence:** the safe view is computed once per game at
retrieval, with the composition test applied to the whole set. The agent
receives all of it on the first tool call and reveals it progressively.
Follow-ups trigger no new retrieval and no richer view. There is no tool that
returns more, so there is no escalation path to exploit. Worst case under a
successful jailbreak is the entire safe set at once — which is safe by
definition. The failure mode is bounded.

| Stage | Disclosed |
|---|---|
| Volunteered | category, teams, league, date, runtime estimate |
| On "why?" | all mapped phrases at once (typically 1–3, ranked) |
| On follow-up | nothing new for most games (~70% of the fixture); the floor line, in character |
| Floor | same line, reused |

The floor response is in-character, not a guardrail message: *"That's as much as
I can give you without ruining it."*

---

## 6. Preference dimensions

**Rule: the filter vocabulary must be a subset of the disclosure vocabulary.**
If the agent wouldn't say it, the user can't filter on it.

Any filter is an oracle. Enough yes/no questions reconstruct a number — a
user-supplied threshold like "margin under 5" allows a binary search in four
queries without the agent emitting a digit. All dimensions are coarse buckets.
Natural language maps onto the enum; the user never sets a threshold.

| Dimension | Values |
|---|---|
| sport / league | free (pre-game) |
| team | free (pre-game) |
| scoring | `shootout` \| `balanced` |
| competitiveness | `nail_biter` \| `close` \| `competitive` |
| drama | `comeback`, `back_and_forth`, `late_drama`, `overtime` (bools) |
| runtime | `under_2h` \| `2_to_3h` \| `over_3h` |
| recency | `today` \| `last_3_days` \| `this_week` |
| availability | from existing `watch` provider mapping |

Style tags (ground game, passing volume, standout performances) are cut from
filters for v1 — see §6.1b. They remain available as disclosure prose only.

### 6.1 Empty results are an oracle

If a user asks for close Lakers games and the agent reports none, that reveals
their games were blowouts — a spoiler by absence, violating no invariant. **The
agent must never confirm absence at team or game granularity.** It redirects to
what it does have without characterizing what it doesn't.

This is not a hypothetical: on the NCAAF fixture, only 45 of 218 games are
recommendable (blowout + defensive excluded — see §6.1a). Ordinary preference
combinations will empty out routinely, not just under adversarial probing.

### 6.1a `defensive` is a confidence-engine label, not a scoring description

Confirmed against the fixture: a 38–14 game (52 combined points) classified
`defensive` with `score: 0` and empty factors — it fell outside every NCAAF
scoring bucket, not because it was low-scoring. `defensive` means "scored
poorly on the confidence engine," full stop. The agent must never state or
imply this classification in prose (e.g. never "I filtered out the defensive
games") — doing so would assert something false about specific excluded games.
§6.1's redirect-without-characterizing rule already covers this; this is the
concrete case that makes it necessary rather than precautionary.

### 6.1b Style tags dropped from filter dimensions for v1

Enrichment (rushing/passing/leader yardage) is capped at 25 games per run and
prioritized closest-game-first. Confirmed on the fixture: games with style
fields present are concentrated among the closest games. Filtering on
`ground_game` or `passing_volume` would therefore implicitly filter toward
close games — a correlation the agent must not present as an independent
preference. Style tags remain in the disclosure vocabulary (prose only, via the
ported `INSIGHT_MAP`) but are cut from §6's filter dimension table for v1.

### 6.2 Query interpretation

The site is replay-first. *"I've got two hours tonight"* means available viewing
time, not a broadcast window. The agent interprets time references as duration
budget and says so when it answers.

Note: almost no football game fits under 2h. For many runtime-constrained
queries the honest answer is a different sport, not a shorter game.

---

## 7. Memory model

Two distinct stores. Conflating them is the common failure.

- **Durable preferences** — persist across the session in the DO. *"I hate
  defensive games," "I follow the NBA."*
- **Per-query constraints** — turn-scoped, do not accumulate. *"tonight,"
  "this weekend."*

A user saying *"actually make it short tonight"* must not write a permanent
preference.

**Demo target:** a preference stated in turn 1 changes recommendations in turn 6
with no restatement.

---

## 8. Architecture

```
Workflow (scheduled)
  └─ fetch get-scores output
  └─ drop factors, drop tier-2 fields
  └─ derive closed-vocabulary tags
  └─ apply composition test per game
  └─ write safe views → D1

Durable Object (one per session)
  └─ conversation history
  └─ durable preferences
  └─ Llama 3.3 tool-calling loop
       ├─ search_games(preferences) → safe views only
       ├─ get_game_detail(id)       → safe view only
       └─ save_preference(k, v)
  └─ output scanner → user

AI Gateway wraps all inference (logging, replay evidence)
```

### 8.1 Three enforcement layers

1. **Data** — Workflow strips outcomes before storage. The model never receives
   them.
2. **Tool** — tool schemas have no field capable of carrying a score. No tool
   returns a raw game row.
3. **Output** — scan responses for numeric patterns before they reach the user.

Layer 3 is not redundant: a *hallucinated* score is still spoiler-shaped to a
user who doesn't know it's wrong.

### 8.2 Why this survives a jailbreak question

The agent genuinely decides what to call and how to interpret results, but
cannot reach forbidden data — there is no path from any tool to a score. Swap in
a weaker model and safety is unchanged. The guarantee is structural, not
behavioural.

---

## 9. v1 scope

**In:** chat UI (minimally restyled); one DO per session; Llama 3.3 tool-calling
loop; three tools; ingest Workflow; D1 of safe views; three-layer guardrail with
output scanner; AI Gateway logging; **NCAAF only**.

**Out:** multi-sport; Vectorize; voice; auth; cross-session persistence;
upcoming-game prediction; live embedding on the site.

**One sport.** The guardrail is sport-agnostic by construction — a second sport
proves nothing. Tag *derivation* is per-sport, and re-deriving thresholds is
where time would vanish. NCAAF is in season, freshly calibrated, and verified.
State in the writeup that the tag layer is per-sport and the rest is generic.

**No prediction.** Upcoming games have no outcome, so they exercise none of the
guardrail. They also need season-level team data the payload doesn't carry, and
Llama 3.3 has no current-season knowledge — asked to assess a matchup it will
produce confident invented analysis. The guardrail prevents leaking true facts;
it does nothing against stated false ones.

**Not embedded.** Deploy standalone on `workers.dev`. Embedding adds production
deploy risk, CORS, and styling work that nothing in the assignment grades.

---

## 10. Build sequence

Guardrail first, so the interesting part isn't what gets rushed.

1. **Port the redaction layer** — lift `INSIGHT_MAP`, `formatDynamicLabel`,
   `getInsightPhrases` out of `index.html` into a plain module. No Cloudflare
   dependency. Verified by Node harness against the NCAAF fixture, using the
   established extract-and-compare pattern:
   - **Differential test** — original vs ported, same fixture, assert identical
     phrase output game-for-game. A clean diff proves the port didn't drift.
   - **Invariant test** — ported output alone contains no digits except
     permitted pre-game values (§4.1).
   - **Tier test** — no Tier 2 field and no raw `factors` entry appears in any
     safe view.
2. **D1 + Workflow** — schema, then wrap step 1. If Workflows fights, a Cron
   Trigger satisfies the same spec bullet and loses nothing graded.
3. **Agent + tools** — DO, tool schemas, Llama 3.3 loop.
4. **Output scanner** — numeric pattern scan, plus adversarial test set.
5. **UI** — restyle `agents-starter`.

Highest-risk item is the Workflow — the only piece touching existing
infrastructure, and likely the least familiar. Hence step 1 being independently
testable.

---

## 11. Working agreements

Carried from existing practice on this project:

- **Curl before code.** Every threshold verified against real pulled data, never
  guessed.
- **Blast radius declared** before editing shared code and before claiming done.
- **String-existence checks ≠ behavioural correctness.** Features have
  previously appeared to work while doing nothing. Explicit behavioural
  verification required.
- **Spoiler safety is non-negotiable.** Push back immediately on anything that
  reveals outcome.
- **Verify SDK specifics against live docs** rather than assumed API shape — the
  `agents` SDK moves fast.

---

## 12. Open items

1. ~~Penalty shootout vs overtime consistency~~ — **already decided in code.**
   `INSIGHT_MAP` sets `'⚡ Penalty shootout': null` with reasoning ("reveals
   game was tied after 90min"), and `'⚡ Late drama': null` as borderline, while
   `'⚡ Overtime'` ships. A documented decision, not an oversight. The agent
   inherits it via the port. Worth stating in the writeup as a deliberate
   asymmetry: OT is retained because it's load-bearing for runtime filtering.
2. Composition test per sport, cricket first (§4.2).
3. Runtime constants per sport, plus OT adjustment — not yet derived.
4. Confirm the composition test against the fixture's actual phrase
   distribution (§5) — 38 of 45 recommendable games collapse to one of two
   closeness phrases; check this isn't itself a triangulation risk across a
   session (e.g. combined with team + date, does "down to the wire" narrow the
   margin enough to matter under §4.2).
