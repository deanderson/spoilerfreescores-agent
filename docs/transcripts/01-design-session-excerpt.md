# Design session (excerpt)

_First 28 messages of the design conversation, ending where the v1 spec was finalized. The rest of this conversation was operational support (terminal, git, deploy help, prompt drafting) and is not included._

Conversation: Building a spoiler-free sports recommendation agent  
Started: 2026-09-14T15:58:43Z  
Messages included: 28

---

## 1. David  <sub>2026-09-14 15:58:44Z</sub>

I'm building an AI agent on Cloudflare Workers as a technical assignment, and it's also a real feature for a site I run.
The site: spoilerfreescores.com. It surfaces sports games worth watching without revealing outcomes. Currently it shows curated picks across about eleven sports with categories like "Must Watch" and a "Why watch?" button.
What I want to build: a chat agent embedded on the site. Users describe what they want — "I like high scoring, hate defensive slogs, I've got two hours tonight" — and it recommends games matching those preferences, remembers the preferences across the session, and never reveals outcomes.
The interesting constraint: the agent reasons over game data that includes final scores, but must never leak them. "An offensive shootout that stayed close throughout" is fine. "240 combined points" is not. I want proper guardrails on this, not just a system prompt asking nicely.
Required components (this is an assignment spec):

* LLM — Llama 3.3 on Workers AI
* Coordination — Workers, Workflows, or Durable Objects
* User input via chat
* Memory or state

Starting point: `npx create-cloudflare@latest --template cloudflare/agents-starter`
I'm an engineering manager, not a hands-on developer. I'll be running the commands and pasting back errors, so I need clear instructions with the reasoning behind design decisions — I need to be able to explain the architecture afterward.
Before we write code, I want to settle: the data model for a game, the precise definition of what counts as a spoiler, the preference dimensions users can filter on, and scope for v1.
Let's start with the data model. I'll describe what I have.

## 2. Claude  <sub>2026-09-14 15:59:23Z</sub>

[tool use omitted]

Good — I've got the existing context on the site (confidence engine, category tiers, the ESPN-derived fields, sport-specific thresholds), so you don't need to re-explain any of that. Describe the game record as it actually exists today: fields, types, where each one comes from.

One framing that will shape how you describe it, because it's the decision the whole guardrail rests on: the model should never receive raw outcome data at all. Not "sees it and is told not to say it" — never receives it. That means the record splits into two tiers, and the split happens before anything reaches Llama. Tier 1 is what the agent reasons over; tier 2 is scores, margins, results, and anything reconstructible from them, which stays server-side and is used only for filtering and ranking in code. Output scanning for stray numbers is a second layer, not the primary one.

So as you list fields, the useful annotation is: raw outcome, or derived signal?

Two things worth including that might not be in the current record — game duration (you'll need it for "two hours tonight," and OT flags are a mild spoiler), and whether your existing spoiler-safe labels are stored or computed at render time.

## 3. David  <sub>2026-09-14 16:00:50Z</sub>

this is for a job application and this is thheir assignment, they want ai usage.  they want prompt hsitory, let's do all our design work before so i can cleanly submit prompts on a new set and not sound like an idiiot

## 4. Claude  <sub>2026-09-14 16:01:12Z</sub>

That plan works. The output of this session should be a short spec doc — data model, spoiler definition, preference dimensions, v1 scope — that becomes the opening prompt of the clean build session. Design decisions settled, so the build prompts read as execution rather than flailing.

One caveat worth weighing: reviewers who ask for prompt history usually want to see how you think, including corrections and dead ends. A history with no visible iteration can read as either very good or slightly staged. Cheap fix — open the clean session by stating that the design was settled separately and pasting the spec. That's honest and it makes the polish look deliberate.

Now, the data model. Rather than describing it from memory, paste a real game record — actual JSON from `get-scores.js` output, or the relevant field-mapping block. Consistent with curl-before-code: I'd rather classify fields that exist than fields we think exist.

## 5. David  <sub>2026-09-14 16:02:06Z</sub>

and we want to use agentic cloudflare ai as much as possible

## 6. Claude  <sub>2026-09-14 16:03:00Z</sub>

[tool use omitted]

Verified the thing that matters for the design: Llama 3.1 onward supports function calling out of the box on Workers AI, without needing a tool-use-specific fine-tune, and Cloudflare also ships embedded function calling plus an `ai-utils` package that orchestrates the back-and-forth and can auto-generate tool schemas. So a real tool-calling agent loop on Llama 3.3 is viable, not a stretch.

Here's the stack I'd argue for, mapped to their spec:

- **Durable Objects via the `agents` SDK** — the starter's `Agent` class *is* a DO. One instance per session gives you coordination and memory in a single primitive, with built-in storage for preferences. Covers two spec bullets at once.
- **Workers AI, Llama 3.3 70B Instruct** — the LLM bullet, running a genuine tool-calling loop rather than one-shot completion.
- **Workflows** — for the periodic ingest: pull from your existing `get-scores` output, compute derived signals, write the redacted index. Durable and retryable, and it's where tier-2 data gets stripped.
- **D1** — stores the redacted index so the search tool filters in SQL rather than the model filtering in prose.
- **AI Gateway** — logs every request and response.

The design decision that makes "agentic" compatible with your constraint: the model gets tools, but the tools are the redaction boundary. `search_games(...)` takes preference parameters and returns safe views only. There is no tool that returns a raw game row, so there's no path to a score even under adversarial prompting. The agent is genuinely deciding what to call and how to interpret results — it just cannot reach the forbidden data. That's the answer when an interviewer asks "what if the user jailbreaks it."

Three enforcement layers, worth naming explicitly: data (Workflow strips outcomes before storage), tool (schemas have no field capable of carrying a score), output (scan responses for numeric patterns before they reach the user). Layer three matters more than it first appears — a hallucinated score is still spoiler-shaped to a user who doesn't know it's wrong.

Two pushbacks. Skip Vectorize for v1; your filter dimensions are categorical, and semantic search adds a dependency without improving results. And don't add Cloudflare products for completeness — reviewers can tell the difference between a stack that's justified and one that's padded. Five well-argued components beat nine.

AI Gateway is the underrated one for your situation: it gives you a log of every exchange, which is how you *demonstrate* the guardrail rather than assert it. Run a few hundred adversarial turns, show zero leaks.

Still need that real game record before the data model can be settled.

## 7. David  <sub>2026-09-14 16:03:14Z</sub>

We plan to fast track candidates who complete an assignment to build a type of [AI-powered application](https://agents.cloudflare.com/) on Cloudflare. An AI-powered application should include the following components:

* LLM (recommend using Llama 3.3 on Workers AI), or an external LLM of your choice
* Workflow / coordination (recommend using Workflows, Workers or Durable Objects)
* User input via chat or voice (recommend using Pages or Realtime)
* Memory or state

Find additional documentation [here](https://developers.cloudflare.com/agents/).
Note: AI-assisted coding is encouraged, but you have to submit prompt history.

## 8. Claude  <sub>2026-09-14 16:03:42Z</sub>

Worth correcting something: the spec is looser than you described it to me. Every technology is a recommendation — including the LLM, where "an external LLM of your choice" is explicitly allowed. Only the four component *categories* are fixed, and memory/state doesn't even name a suggested technology.

That said, I'd still take the recommended path. The assignment links to their agents platform docs twice; using Workers AI, Durable Objects, and their chat starter demonstrates engagement with the thing they're hiring for. Reaching for GPT-5 or Claude would comply on paper and read as avoidance.

There's also an argument that turns the weaker model into the strongest part of your submission. Llama 3.3 70B follows instructions less reliably than a frontier model — which is precisely why the guardrail can't be a system prompt. You get to say: the spoiler constraint holds regardless of model quality, because the model never receives the data and the tools have no field capable of carrying it. Swap in a worse model and safety is unchanged. That's a much better answer than "I used a smarter model and it behaved."

The prompt-history requirement cuts differently than you assumed, too. They're not checking that you used AI — it's encouraged. They're reading *how* you direct it. That makes the prompts themselves a graded artifact. A history full of "make it work" and "fix this error" reads poorly even if the output is clean. A history where you declare constraints, specify verification, and push back on a proposal reads as engineering judgment. Your actual working style — blast-radius declarations, curl-before-code, behavioral verification over string checks — is the thing worth making visible. Write the build prompts the way you run your sessions.

One adjustment to the plan: we'll verify current agents SDK specifics against the live docs during the build rather than baking today's assumptions into the spec, since the SDK moves fast.

Now — the game record. Paste it and we'll settle the data model.

## 9. David  <sub>2026-09-14 16:04:29Z</sub>

Alcorn State Braves vs Arkansas-Pine Bluff Golden Lions
Sat, Sep 12 · FCS
⭐ Top Pick
👀 Must Watch
👁 Why watch?
Score: 100/100 ██████████ → watchworthy
2 pt margin+30
104 pts+18
⚡ Overtime+30
Big rushing game+8
Lots of passing yards+6
Big receiving day+6
Last 3 days

## 10. Claude  <sub>2026-09-14 16:05:26Z</sub>

That card is useful precisely because it's leaking. Three hard spoilers sit in it: `2 pt margin` is the final margin, `104 pts` is the combined total — structurally identical to your own forbidden example — and `⚡ Overtime` reveals the game was tied at the end of regulation.

On the site that's defensible, because it's nested behind Why watch? and the user opted in. Chat has no equivalent gate. There's no click between the agent deciding to mention something and the user reading it, so every field the model can see is a field it can emit. The reveal hierarchy your UI depends on doesn't survive the surface change.

Applying the tier split to these exact fields:

**Tier 2 — never leaves the Worker.** Final scores, margin, combined total, winner, and — less obviously — the individual point weights. `+30`, `+18`, `+8` are invertible. Anyone who knows your published thresholds can work backward from a weight to the bracket that produced it. The weights are a numeric encoding of the outcome, so the agent gets tags with no arithmetic attached.

**Tier 1 — the agent's view.** Game ID, teams, league, date, freshness, `category: must_watch`, `topPick: true`, and the factors re-expressed as enums and tags: closeness as `nail_biter`, scoring as `high`, plus style tags for the ground game, passing volume, and receiving. Same information the user came for, none of it reconstructible.

The aggregate `100/100` I'd keep. It's an editorial judgment, not an outcome — it says this is worth your time, not what happened. Bucket it to `very_high` anyway so the model isn't handling numbers at all, which makes the output-layer numeric scan much cleaner to enforce.

Two leak vectors worth deciding now:

**Player-level tags.** You have `topScorer` and `benchStandout` from WNBA, and individual-standout tags on NFL. "Star performer: [named player]" plus their team is close to announcing the winner — huge individual games correlate strongly with wins. Either strip names and keep the tag team-agnostic, or drop player detail from the agent's view entirely.

**Overtime.** Genuinely borderline. It reveals a tied regulation, but closeness is the product you're selling, so it's not a spoiler by your own definition. It also can't be dropped — it's the largest single driver of how long a game runs, and you need that for the two-hours case. Keep it as a qualitative tag.

Which raises the gap: duration isn't in this record. I'd resist adding a measured per-game field. A per-sport typical-length constant plus an overtime adjustment gets you accurate enough to filter on, with no new data pipeline.

Worth noting for scope: almost no football game fits in two hours. If duration is a headline dimension, the honest answer for a lot of queries is a different sport, not a shorter game.

Now the JSON — the actual object `get-scores.js` emits for this game. I want to classify fields that exist rather than fields the card implies.

## 11. David  <sub>2026-09-14 16:05:30Z</sub>

that is under debug, not exposed

## 12. Claude  <sub>2026-09-14 16:05:43Z</sub>

Understood — my read of the production surface was wrong, and the site isn't exposing those fields.

What that tells me is more useful than the correction costs, though: the redaction today is a rendering decision. Scores, margins, and weights live in the payload, and the template withholds them. That works because a template is a fixed choke point — a field that isn't in the markup can't reach the user no matter what.

A Worker passing data to an LLM has no equivalent. There's no template deciding what renders; there's a model generating free text over whatever's in its context. So the withholding has to move down a layer, from render-time to data-time. That's the same conclusion as before, but the reasoning is now about porting a guarantee across surfaces rather than fixing a leak.

The tier classification stands — the debug view was a useful field inventory precisely because it shows everything the payload carries.

So: the JSON `get-scores.js` emits for that game, debug fields included.

## 13. David  <sub>2026-09-14 16:06:23Z</sub>

Attached: get-scores.js



## 14. Claude  <sub>2026-09-14 16:07:44Z</sub>

[tool use omitted]

Got the real shape. The record is `normalizeEvents` output plus per-sport enrichment plus a `confidence` object:

```
id, home, away, h, a, date, dateKey, time, league, status, ts, period
+ optional: broadcast, geoBroadcasts, collinsworthWarning,
            homeRank, awayRank, homeLinescores, awayLinescores
+ per-sport: timelineCat, lateGoal, ninetyGoal, resultType,
             resultMargin, maxInnings, debug{avg1, avg2, round, nineDart}
+ confidence: { score, cls, factors: [{label, points}] }
+ watch: { name, url }
```

The important finding is that `factors` is the single worst field in the payload, and it's the one that looks safest. 145 push sites, 48 of which interpolate a raw number directly into the label. The distinct patterns include `${diff} pt margin`, `${total} pts`, `${total} goals`, `${total} runs`, `${lc} lead changes`, `Extra innings (${g.period})`, and two that state the result outright: `Won by ${g.resultMargin} runs` and `Won by ${g.resultMargin} wkts`. There's also a bare `Comfortable win`. On top of that, all 145 carry a `points` weight, and every weight is invertible against your published thresholds.

So the tier split on actual fields:

| Tier 2 — never leaves the Worker | Tier 1 — agent's view |
|---|---|
| `h`, `a`, `period`, `homeLinescores`, `awayLinescores`, `resultType`, `resultMargin`, `maxInnings`, `timelineCat`, `debug.*`, `confidence.factors`, `confidence.score` | `id`, `home`, `away`, `league`, `date`, `dateKey`, `ts`, `status`, `homeRank`, `awayRank`, `broadcast`, `collinsworthWarning`, `watch` |

`cls` sits in the middle. `watchworthy`, `scorefest`, and `watchable` are safe — they're recommendations. `blowout` and `defensive` are outcome descriptions, but they never need to reach the agent because those games aren't recommendable anyway. Filter them out server-side and pass `cls` through only for the three good tiers.

The recommendation that follows: **don't sanitize `factors` — don't pass it at all.** Have the Workflow derive its own tag vocabulary from the tier-2 fields, using a closed enum defined in the Worker. So instead of parsing `"104 pts"` back into a category, the Worker looks at `h + a` against your NCAAF thresholds and emits `scoring: "high"`. Same thresholds, same logic, but the output vocabulary is fixed in advance.

That flips the guarantee from blacklist to whitelist. Filtering `factors` means every new factor you add to `get-scores.js` is a potential leak you have to remember to sanitize. Deriving a closed tag set means a new production factor simply doesn't appear in the agent's view until you explicitly add a tag for it. Failure mode is a missing signal, not a spoiler. That's also the version that survives the interview question about maintenance.

It has the added benefit of leaving `get-scores.js` untouched — no blast radius on production, and the redaction layer lives inside the submitted Cloudflare code where reviewers can actually read it.

One scope question this surfaces: upcoming games have no outcome to protect, so they're spoiler-free by construction. Worth deciding whether v1 recommends only completed games, which is where the hard constraint lives, or both.

Next design question is the spoiler definition itself. I'd argue it needs to be a written rule that classifies any new field, rather than a list of banned items — otherwise it can't settle cases like the overtime flag.

## 15. David  <sub>2026-09-14 16:08:39Z</sub>

the site only reccomends completed games, upcoming games are informational only, although i guess we could say these are two very good offenses so shoudl be high scoring may wnt to watch it

## 16. Claude  <sub>2026-09-14 16:09:04Z</sub>

Keep it out of v1, but the instinct is worth writing down as roadmap.

Two reasons it doesn't belong in this build. First, it's a different capability — curation reports what happened, prediction estimates what will. Prediction needs team-level season data you don't currently carry; upcoming games come out of `normalizeEvents` with `h` and `a` at zero and no stats attached. That's a new data source, not a new field.

Second, and more relevant to the assignment: an upcoming game has no outcome, so it exercises none of the guardrail. You'd be adding scope that doesn't demonstrate the hard part.

There's also a failure mode specific to your model choice. Llama 3.3's training data has no idea how these offenses are performing this season, so asked to assess an upcoming matchup it will produce confident, fluent, invented analysis. A reviewer poking at that finds hallucinated team form in an app whose entire premise is trustworthiness about game information. The guardrail protects against leaking true facts; it does nothing against stated false ones.

Naming this as a deliberate exclusion in the writeup is worth more than building it. "Prediction is a separate problem requiring season-level data and a model with current knowledge; v1 scopes to curation of completed games" reads as judgment.

One thing your example query exposes, though. "I've got two hours tonight" is ambiguous in a way that matters for the preference dimensions — it could mean *I want to watch a two-hour replay this evening*, or *what's on live tonight*. Your site is replay-first, so I assume the former, but the phrasing is the kind of thing users will actually type, and the agent needs a defined behavior for it. If it's replay-only, the agent should interpret "tonight" as available time rather than a broadcast window, and probably say so when it answers.

Confirm that read and I'll take the spoiler definition next.

## 17. David  <sub>2026-09-14 16:09:48Z</sub>

confirmed

## 18. Claude  <sub>2026-09-14 16:10:46Z</sub>

Here's the definition I'd argue for. It has to do real work — classify fields we haven't thought of yet — so it's a rule plus a test, not a list.

**Start from an honest premise:** you can't ship zero outcome information. "Must Watch" already leaks — it tells the user the game was competitive, which rules out a blowout. Your product *is* a deliberate, bounded leak of outcome information. So the definition can't be "reveals nothing about the result." It has to specify how much, and of what kind.

**Three invariants.** A statement is a spoiler if it violates any one:

1. **No quantities.** No number describing play — scores, margins, totals, counts of events, point weights. Numbers are the bright line because they convert a class into a specific result. Permitted numbers are pre-game only: poll rank, date, duration estimate.
2. **No asymmetry.** No fact attributed to one side. "A huge rushing game" passes; "Alcorn State had a huge rushing game" fails, because dominant individual performances correlate with winning. This is the invariant that kills the player-name problem.
3. **No outcome attribution.** Never who won, led, came back, or was eliminated.

**Plus a composition test**, because the invariants are per-statement and leaks are cumulative: no set of facts released in a session may narrow to a single reconstructable result. Three safe tags about the same game can triangulate a score even though none of them individually contains one.

**Plus a named exception**, stated deliberately rather than by accident: category tier and overtime status *are* disclosed. Both technically reveal outcome shape. Both are the reason to watch, and overtime is load-bearing for duration filtering. Naming it as a bounded exception is stronger than pretending it isn't a leak.

Now, this definition catches an inconsistency in what you've already shipped. Overtime is displayed, but you rejected a penalty shootout label as spoiler-revealing. Structurally those are the same thing — both fix the game state at a known timestamp. A shootout is arguably the *safer* of the two, since it tells you less about the preceding 120 minutes than an OT flag tells you about a basketball game's final seconds.

I'd resolve it toward allowing both, under invariant 3 — neither names a winner, and both are strong watch signals. But it's your call, and whichever way you go the rule needs to say so explicitly, because "I allowed one and banned the other" is exactly the question a reviewer asks when they're probing whether you have a real policy or a set of ad-hoc decisions.

Testing it against the NCAAF card: `104 pts` fails 1. `2 pt margin` fails 1. `+30` fails 1. `Won by 7 wkts` fails 1 and 3. `⚡ Overtime` passes under the exception. `Big rushing game` passes. `Must Watch` passes under the exception.

Preference dimensions next — and they should be derived from these invariants rather than picked freely, since every dimension you expose is a query surface a user can probe.

## 19. David  <sub>2026-09-14 16:11:57Z</sub>

since it's a conversation we can start least spoilery and ramp up as queried

## 20. Claude  <sub>2026-09-14 16:12:30Z</sub>

Right instinct, and it mirrors the Why watch? button — the chat surface keeps the product's existing interaction model. But it needs one correction or it becomes the attack.

If disclosure ramps in response to being asked, then asking repeatedly is the exploit. "Tell me more" thirty times walks the agent up its own ladder, and the composition test guarantees that enough safe facts eventually triangulate a result. A ramp driven by user persistence is a jailbreak staircase with a handrail.

The fix is that the ramp governs **ordering, not ceiling**. There's a fixed budget of disclosable facts per game, identical whether the user asks once or thirty times. Progressive disclosure decides what comes out first; it never decides how much exists.

That turns into a clean architectural property. The safe view is computed once per game, at retrieval, with the composition test applied to the whole set. The agent receives all of it on the first tool call and reveals it progressively. Follow-up questions trigger no new retrieval and no richer view — there is no tool that returns more, so there's no escalation path in the system to exploit. Worst case under a successful jailbreak, the user gets the entire safe set at once, which is by definition safe. The failure mode is bounded rather than unbounded.

Concretely:

- **Volunteered** — category, teams, league, date, runtime estimate
- **On "why?"** — one or two shape tags: scoring profile, competitiveness
- **On follow-up** — the remainder: drama markers, overtime, team-agnostic standout tags
- **Floor** — nothing further; the agent says it's hit the limit

Make that refusal an in-character line rather than a guardrail message. "That's as much as I can give you without ruining it" is on-brand, and it reinforces the promise instead of exposing the machinery.

Two things to nail down when we build the safe view. The composition test needs checking per sport — cricket worries me more than football, since its result vocabulary is structurally narrow and a couple of tags may bound the margin tightly. And "standout performance" tags have to stay unattributed under invariant 2, which may mean dropping them entirely for sports where only one side realistically produces them.

Preference dimensions next. Every dimension is a query surface, so the list should come out of the invariants rather than from what's convenient to filter on.

## 21. David  <sub>2026-09-14 16:13:29Z</sub>

ok

## 22. Claude  <sub>2026-09-14 16:14:02Z</sub>

Deriving them from the invariants gives you one rule that does most of the work: **the filter vocabulary must be a subset of the disclosure vocabulary.** If the agent wouldn't say it, you can't filter on it.

The reason is that any filter is an oracle. A filter is a yes/no question about a game, and enough yes/no questions reconstruct a number. Let someone filter on "margin under 5" and they can binary-search the margin in four queries without the agent ever emitting a digit. So every dimension has to be coarse — buckets the agent would volunteer anyway, never a threshold the user supplies.

That yields:

- **Sport / league** — free, pre-game
- **Team** — free, pre-game
- **Scoring profile** — high / balanced. Low-scoring games are `defensive` and already excluded
- **Competitiveness** — nail-biter / competitive. Blowouts are excluded, so this is genuinely two-way
- **Drama markers** — comeback, back-and-forth, late drama, overtime. Booleans, all within the disclosure budget
- **Runtime** — under 2h / 2–3h / 3h+, from a per-sport constant plus OT adjustment
- **Recency** — today / last few days / this week, from `ts`
- **Availability** — from the existing `watch` provider mapping
- **Style** — sport-specific, team-agnostic: ground game, passing volume, and so on

Natural language maps onto the enum; the user never sets a threshold. "I hate defensive slogs" becomes `scoring: high, competitiveness: nail_biter`, not a number.

Two hazards worth designing around now.

**Empty results are an oracle.** If someone asks for close Lakers games and the agent says none matched, that reveals their games were blowouts — a spoiler delivered by absence, with no statement that violates any invariant. The agent must never confirm absence at team or game granularity. It redirects instead: offers what it does have, without characterizing what it doesn't.

**Team filter plus narrow criteria is the sharpest tool a user has.** One team, one date, plus drama filters can isolate a single game and then probe it. Mitigation is the fixed per-game budget already in place — isolation gets them the safe set, which is all they'd get anyway.

For the memory requirement, split state in two. **Durable preferences** persist across the session in the DO — dislikes defensive games, follows the NBA, has about two hours. **Per-query constraints** are turn-scoped and don't accumulate — tonight, this weekend. Conflating them is the common failure: a user says "actually make it short tonight" and a naive agent writes that to long-term preferences and applies it forever.

That's also a clean demo. Show a preference stated in turn one changing recommendations in turn six, with no restatement, and the memory bullet is unambiguously satisfied.

Scope for v1 next, which is the last design item before the spec doc.

## 23. David  <sub>2026-09-14 16:14:50Z</sub>

sounds good

## 24. Claude  <sub>2026-09-14 16:15:08Z</sub>

Scope, argued from what the assignment actually grades. Four component bullets, plus a prompt history read as evidence of judgment. Everything that doesn't serve those is cost.

**In:**

- Chat UI from `agents-starter`, minimally restyled to match the site
- One Durable Object per session — coordination and memory in one primitive
- Llama 3.3 70B on Workers AI, tool-calling loop
- Three tools: `search_games`, `get_game_detail`, `save_preference`
- Workflow for periodic ingest, building the redacted index from your `get-scores` output
- D1 holding safe views only
- The three-layer guardrail, with the output scanner
- AI Gateway logging
- One sport at launch

**Out:** multi-sport at launch, Vectorize, voice, auth, cross-session persistence, upcoming-game prediction, embedding it live on the site.

Two of those need defending.

**One sport.** The guardrail is sport-agnostic by construction, so a second sport proves nothing the first didn't. But the *tag derivation* is per-sport — you'd be re-deriving thresholds for each one, which is where your time would vanish. NCAAF is the pick: it's live right now, you just calibrated it against real data, and the card you pasted shows the derivation already works. Say in the writeup that the tag layer is per-sport and the rest is generic. That reads better than eleven shallow sports.

**Not embedding it.** Tempting, since it's a real feature. But embedding means production deploy risk, CORS, styling, and your one-deploy-per-session rule colliding with an assignment deadline. Submit it standalone on `workers.dev`; embed after you hear back. Nothing about the assignment requires it to be live on the site.

The riskiest item is the ingest Workflow — it's the only piece touching your existing infrastructure, and Workflows is likely the least familiar thing in the stack. Build the redaction as a plain function first, testable in isolation with fixture data, then wrap it in the Workflow. If Workflows fights you, a Cron Trigger satisfies the same spec bullet and you lose nothing that gets graded.

Sequence: redaction function and its tests, then D1 and the Workflow, then the agent and tools, then the output scanner, then the UI. Guardrail first means the interesting part isn't what gets rushed at the end.

That's all four design questions settled. Next step is the spec doc — data model with the tier split, the three invariants plus composition test and exception, disclosure ladder, preference enums, and this scope. That becomes your opening prompt in the clean session.

Worth flagging one thing about that session: keep this conversation. If they ask how the design was reached, "the design was settled in a prior session, here's the transcript" is a better answer than silence, and the pushback in here — the shootout inconsistency, the ramp-as-jailbreak correction — is the part that shows judgment.

Say the word and I'll write the spec.

## 25. David  <sub>2026-09-14 16:15:46Z</sub>

should we start a new chat to scope the spec where my prompts aren't just me saying ok

## 26. Claude  <sub>2026-09-14 16:16:13Z</sub>

Start a new chat for the build, yes — but for the reason we already agreed on, a clean execution transcript, not because this one needs re-performing.

Don't re-run this conversation. Two reasons.

Your prompts here are better than you're crediting. You corrected me twice on substance — the debug view isn't exposed, and the assignment recommends rather than requires the stack. You contributed the progressive disclosure idea, which I then had to amend rather than invent. You set the sequence at the top and held it. Terse agreement from someone who has already demonstrated they'll push back when I'm wrong reads as a decision, not passivity. "ok" after analysis you agree with is what efficient review looks like.

And re-running it means submitting prompts you didn't actually think of. If someone asks in an interview why you separated durable preferences from per-query constraints, you want to be recalling your own reasoning, not reconstructing a script.

You've raised sounding-like-an-idiot three times now. The work here is solid — the design has a defensible guardrail, a written policy, and scoped-out items with stated rationale. Let it stand on that.

I'll write the spec here, where the field analysis is loaded, and it becomes your opening prompt in the new chat.

## 27. David  <sub>2026-09-14 16:16:30Z</sub>

ok

## 28. Claude  <sub>2026-09-14 16:18:11Z</sub>

[tool use omitted]

Pulled the real NCAAF branch so the spec cites your actual calibrated thresholds rather than my guesses. Worth noting what that shows: the rushing, passing, and leader tags all use `Math.max(home, away)`, so they're already team-agnostic — invariant 2 is satisfied by construction, no work needed.

[tool use omitted]

Paste this whole thing as the opening message of the new chat, then start at build step 1.

Two things to know about it. The NCAAF thresholds in §3.2 are lifted directly from your `computeConfidence` branch rather than invented, so the tag derivation should match your existing categorizations without recalibration — worth verifying against a few real games anyway. And §12 carries four unresolved items forward; the shootout-versus-overtime one needs a decision before the policy is final, since it's the inconsistency a reviewer is most likely to find.
