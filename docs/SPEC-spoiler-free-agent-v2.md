# SPEC — spoiler-free agent, v2

Supersedes SPEC-spoiler-free-agent-v1.md. Section numbers are preserved where
the code references them; changed sections say what changed and why.

This version was written *after* building. Where v1 described intent, this
describes what the code does and what it actually guarantees. Several v1 claims
turned out to be unenforceable, and saying so plainly is more useful than a
spec that overpromises.

---

## 1. What this is

A chat agent for spoilerfreescores.com that recommends recent college football
games worth watching, without revealing how they turned out.

Standalone on workers.dev for v1. NCAAF only. Cloudflare Workers AI
(Llama 3.3 70B), Durable Objects, D1, Workflows, AI Gateway.

**Demo query** (replaces v1's "I've got two hours tonight", which cannot be
served — every NCAAF game is over three hours, so runtime is not a usable
filter in a single-sport build):

> "I want a nail-biter, ideally one that went to overtime."
> …later: "anything else like that?"

---

## 2. The guarantee

This is the part that matters, and v1 stated it too broadly.

### 2.1 Guaranteed — three enforcement layers

**The agent never reveals the final score and never says who won.**

Also never: a margin, a total, or any number describing what happened in a
game. Ranks and dates are permitted; they are pre-game facts.

### 2.2 Product judgement — prompt-shaped, not guaranteed

How much colour to give before the user asks, and when skip-class games
surface. These mirror the site: spoilerfreescores.com shows a category on every
game and puts colour commentary behind a **Why Watch** button. Chat has no
button, so *the user asking is the button*.

These behaviours are implemented in prompt text. They have no test that fails
when they drift, and under direct questioning they have drifted. They are
product quality, not safety.

### 2.3 Explicitly NOT guaranteed

**A user may still infer an outcome from permitted facts.** "Penn State was
ranked 16th" plus "it was lopsided" strongly suggests who won. Neither fact is
forbidden — the rank is pre-game, and the site publishes the lopsided label
itself — but together they are suggestive.

This is accepted. The thing people care about is the score and the winner, and
those are structurally prevented. A spec claiming to prevent inference from
public facts would be claiming something it cannot deliver.

v1's invariants 2 and 3 (no asymmetry, no outcome attribution) are **retired**.
They described judgements a model makes in prose, not properties code can
enforce, and no test ever covered them.

---

## 3. Data flow

### 3.1 Tiers

**Tier 1 — may reach the agent.** Teams, league, date, ranks, broadcast and
watch links, the disclosure category, closed-vocabulary quality tags, and
approved phrases.

**Tier 2 — never leaves the Worker.** Scores (`h`, `a`), period, linescores,
margins, totals, yardage, `confidence.score`, and `confidence.factors` with
their point weights.

Tier 2 is read at ingest to derive Tier 1 values and is never stored, never
returned from a Workflow step, and never present in any tool result.

> **Found in build:** the ingest Workflow originally fetched and redacted in two
> steps. Workflows persists step return values, so every raw score was written
> to durable Cloudflare-side storage and printed by `wrangler workflows
> instances describe`. Never reached the model, but it left the Worker. Fetch
> and redact are now ONE step for this reason.

### 3.2 The redaction layer

Ported from the site's `index.html` (`INSIGHT_MAP`, `formatDynamicLabel`,
`getInsightPhrases`) into `guard/redaction.js`. Whitelist by construction: a
factor with no mapping produces no phrase.

Divergences from the site live in `WORKER_OVERRIDES` and nowhere else. Four
entries, all removing digits the site's phrasing carried. v1 listed two; the
other two are tennis-only and invisible to an NCAAF fixture, which is why the
invariant test scans the emittable **vocabulary** rather than fixture output.

### 3.3 Tags

Derived from Tier 2, closed vocabulary only:

| Tag | Values |
|---|---|
| `competitiveness` | `nail_biter`, `close`, `competitive`, `lopsided` |
| `scoring` | `shootout`, `balanced` |
| `ranked` | `both`, `one`, `neither` |
| `overtime` | `true`, `false` |

`runtime_bucket` exists but is **cut from filters**: every NCAAF game lands in
`over_3h`, so it carries no information in a single-sport build. Runtime is
volunteered as metadata by `get_watch_options` instead.

> **Changed from v1:** `lopsided` is new. v1 let `competitive` absorb everything
> above a 7-point margin, which was safe only because blowouts were excluded at
> ingest. They no longer are (see §6), so a 40-point game would have been
> labelled competitive.

### 3.4 One definition of recommendable

v1 had two — a `cls` gate in §3.1 and numeric thresholds in §3.3 — and they
disagreed on 8 of 45 fixture games. Four fell below a `total <= 30` cut despite
being watchable; four had margins of 19–24, under the blowout cutoff but above
the competitiveness ceiling, leaving them recommendable and untaggable.

`cls` is the single gate. The numeric filter is gone.

---

## 4. What may be said

### 4.1 Permitted digits

Poll ranks (`#12`, `No. 3`, `ranked 7`, `3rd-ranked`), dates, years, clock
times, runtime estimates, and list enumerators at the start of a line.

Everything else containing a digit is blocked by the output scanner.

### 4.2 Named exceptions

**Overtime** may be stated. It bounds the result (the game was tied at
regulation) but it is the single most useful thing to know about whether a game
is worth watching, and the site publishes it.

**Category** may be stated — `must watch`, `watchable`, `scorefest`, `skip`.
The site shows it on every game by default.

### 4.3 Open ruling

Tennis set counts (`5-set epic`, `3-set match`) are **suppressed** pending a
decision. Set count bounds the result the way overtime does, so it wants an
explicit ruling rather than a quiet rewording. Blocks a second sport; nothing
else.

---

## 5. Disclosure ladder

**Turn one:** matchup and category. Nothing else. The line is composed in code
(`searchGames`), not by the model.

**On request about a specific game:** its phrases and qualities.

**When phrases run out:** say so plainly. Most games have one or two things
worth saying; 14 of 45 recommendable games carry a single phrase.

> **Changed from v1:** v1 had the agent receive everything and reveal
> progressively. In practice it revealed everything on turn one. Three prompt
> attempts at a line format produced three different shapes — the model dropped
> the category, inlined the date, added preambles. The line is now composed in
> code and the model passes it through.

---

## 6. Search behaviour

### 6.1 Two search paths

`search_games` behaves differently depending on whether a team was named, and
the guarantees differ with it.

**No team named — the uninformative path.** Recommendable games only, always
the same number, and no field capable of expressing absence: no `total`, no
`count`, no `matched`, no `relaxed` flag, no `message`. Every quality enum is a
ranking hint, never a filter.

This is the path that has to stay uninformative. A generic query returning
nothing for a team is what would reveal that their games were blowouts.

Verified: 540 enum combinations, plus the same grid against a corpus at
`MIN_CORPUS`, all return the same count.

**A team named — the team path.** Every game that team played, best category
first, skip games included and labelled. Size varies with how many games they
played, which says nothing about how any of them went. `more: true` when the
cap truncated the list, so the agent can say so rather than implying the list
is complete.

> **Changed from v1 and from the first build.** v1 made `prefer_teams` a pure
> boost so result size never varied. That was the right fix while skip games
> were hidden — a hard filter returning nothing would have betrayed the team.
> Once every game is stored and labelled (§6.3), the betrayal is impossible and
> a boost stops being useful: a user asking about Temple wants Temple's games,
> not five other teams'.

**Matching is on whole words**, so "Texas" does not match "Texans". An
ambiguous query simply matches more teams — "Tigers" shows several programmes,
best first — which is a reasonable answer to a vague question.

> **Two rejected gates**, both of which failed on real data:
> - *substring*: "Texas" matched Texas Southern, Texas Tech, East Texas A&M and
>   North Texas, surfacing four other teams' blowouts to someone asking about
>   the Longhorns.
> - *ambiguity gating*: unlocking skip games only for queries naming exactly one
>   team. "Longhorns" is unique, but "Tigers" is shared by eleven programmes,
>   and "Bulldogs", "Wildcats" and "Owls" likewise — so the common case
>   silently unlocked nothing.

**A query matching nothing falls back to the ordinary list.** A typo or an
unrecognised name must not produce an empty result: that is the absence signal
§6.2 exists to prevent, and it reads as "your team had nothing" when it means
"I did not recognise that".

### 6.2 The result set expresses no absence

On the generic path, no field can carry a count or a miss. The model cannot
report a number it was never given.

> **Found in build:** a repeat-call guard returned `{ games: [], repeated: true }`
> — an empty array and two new keys in exactly this shape. Repeated calls now
> replay the identical earlier result.

### 6.3 Skip games are stored, and surface when the team is named

Every game is ingested and labelled, including blowouts and defensive slogs.
They never appear on the generic path, but a user asking about their own team
gets an answer.

> **Changed from v1:** v1 excluded them at ingest, so the agent had nothing to
> say about a team whose games were all one-sided. The site labels every game
> including the ones it says to skip; silence was worse than the label.

### 6.4 Recency is corpus-relative

`latest_slate` and `this_week`, measured against the newest game in the corpus,
not the clock. NCAAF is weekly: on a Wednesday, a clock-relative window returns
nothing.

`today` is removed. It was empty six days out of seven, and answering "anything
from today?" with Saturday's games asserts something false about a date.

---

## 7. Memory

Durable preferences (`save_preference`, closed key vocabulary) persist in DO
storage. Per-query constraints — "tonight", "keep it short" — must not.

Preferences survive a conversation reset by design: messages live in the DO's
SQLite, preferences in its key-value storage.

**Untested.** This is the one area the adversarial pass has not reached.

---

## 8. Enforcement

### 8.1 Three layers

**Layer 1 — data.** Scores are removed before storage. D1 has no column that
can hold one; a leak requires an `ALTER TABLE`, not a bug.

**Layer 2 — schema.** Tool inputs are closed zod enums. A numeric threshold, a
raw score field, or an invented preference key is rejected before `execute`
runs. Type-only repair is applied (`"true"` → `true`); vocabulary is never
coerced.

**Layer 3 — output.** A streaming scanner blocks digits that are not permitted,
stops generation, and emits a fixed line. It exists only for *hallucinated*
numbers, since layers 1 and 2 mean no real one is ever in context.

### 8.2 What the layers do not cover

The system prompt. Tone, pacing, when to volunteer, how to answer a question
about the tool — all prompt-shaped, all drift under pressure, none tested.

Everything in §2.2 lives here.

### 8.3 Known gap

Nothing asserts that a Workflow step return value is free of Tier 2 fields.
That is the gap that let §3.1 be violated for two days without any test failing.

---

## 9. Deployment

Standalone on `workers.dev`. Embedding into spoilerfreescores.com for NCAAF is
a separate decision, after the assignment.

Ingest is triggered manually — scheduled Workflows require a paid plan, and
these games are final, so on-demand loses nothing.

---

## 10. Verification

`npm run check` = `verify.mjs` + `tsc --noEmit`. Ten tests, each with a control
run proving it fails when the thing it guards breaks.

1. Differential — ported layer vs live site
2. Invariant — no digits in the emittable vocabulary
3. Tier boundary — no Tier 2 field in a safe view
4. Override coverage — synthetic; the fixture exercises none
5. Oracle resistance — teams, enum combinations, at-floor corpus, line
   composition, skip-game gating, repeat cache
6. Schema closure — hostile inputs rejected
7. Output scanner — violations caught, clean lines passed, split deltas
8. Scan transform — stream wiring, stopStream, post-trip suppression
9. Workers AI stream dedupe — text, tool calls, numeric carriers
10. Tool input repair — type repairs applied, vocabulary repairs refused

### 10.1 Working agreement, revised

Verify against live data and live docs, not memory. **Test against the
vocabulary, not the fixture** — a fixture-driven test passes on the data you
have and fails on the data you get. Every guard test needs a sabotage run; six
times in this build a test passed against deliberately broken code because the
fixture did not exercise the right dimension.

**Anything that shapes a tool result belongs in `guard/`**, where the harness
can see it. The one guard placed in `server.ts` immediately reintroduced the
thing §6.2 exists to prevent.

---

## 10.2 Deferred: an eval engine

The harness covers everything enforced in code. It covers **nothing** in §2.2 —
tone, pacing, when to volunteer, whether an off-topic request is declined,
whether the ladder holds across turns. Those are prompt-shaped, and every
regression in them so far was found by hand.

That is the largest untested surface in the build, and it is the surface most
likely to drift, because a prompt edit anywhere can change behaviour everywhere.
Examples already observed: the category disappeared from the first-turn line
after an unrelated prompt edit; the "selection, not an inventory" framing held
when asked directly and failed two turns earlier in the same session; a hand
session found the scanner truncating ordinary conversation, which no structural
test would ever surface.

**Shape.** A fixed set of scripted conversations run against the deployed agent,
with assertions on the transcript rather than on a return value:

| Class | Assertion |
|---|---|
| Structural | no score, no winner, no unpermitted digit — should never fail, and duplicates what the guard already enforces |
| Format | turn one is matchup + category only; no phrase before it is asked for |
| Ladder | detail appears on request; the floor line ends a turn and nothing follows it |
| Scope | off-topic requests are declined, not attempted |
| Honesty | no invented tool criteria; no false claim about why a score is unavailable; no contradiction across turns |
| Memory (§7) | a durable preference survives unrelated turns; a per-query constraint does not persist |

**Cost.** Each run is real inference — roughly a full conversation per case, so
a suite of twenty is a meaningful share of a day's Neurons. That is the reason
it is deferred rather than built: it needs the paid plan to be practical, and it
should be written once the prompt has stopped moving.

**Grading.** Most assertions are mechanical (regex over the transcript, presence
or absence of a phrase). The judgement-shaped ones — "did it decline cleanly",
"did it answer the question asked" — need either a rubric a second model grades,
or human review. Start mechanical; only add model grading if the mechanical
assertions prove too blunt.

**Do not** let an eval suite replace the sabotage discipline. Evals catch drift
in behaviour; controls catch tests that no longer test anything. Six times in
this build a test passed against deliberately broken code — an eval suite would
have had the same blind spots.

---

## 11. Known limits

- **Phrase repetition is real, not a bug.** 9 of 18 `close` games carry one
  phrase and it is the same phrase for all nine. Selection cannot fix
  repetition that is genuine.
- **Every game in an unfiltered list shows as "must watch"** — ranking
  tie-breaks on category and eight watchworthy games fill the top five. Correct,
  but the label carries no information on turn one.
- **The model invents tool arguments** — unprompted `prefer_leagues: ["NFL"]`,
  `prefer_teams: ["Alabama"]`. Harmless, since arguments only rank, but it
  persists despite an explicit instruction.
- **`workers-ai-provider` 3.3.1 duplicates every stream fragment.** Worked
  around in `src/ai-stream-fix.js`; fixed upstream in 4.x, which needs `ai@7`.
- **Memory (§7) is unverified.**
- **UI is the unmodified starter**, which renders full tool JSON including ids
  and raw enums. Safe views, so not a leak, but internals are visible.
