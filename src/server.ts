import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { convertToModelMessages, pruneMessages, stepCountIs, streamText, tool } from "ai";

import { createScanTransform } from "./guard/scanner.js";
import { dedupeAIStream, createFrameWatcher } from "./ai-stream-fix.js";
import {
  repairToolInput,
  searchGamesInput,
  watchOptionsInput,
  savePreferenceInput,
  TOOL_DESCRIPTIONS,
  searchGames,
  toResult,
} from "./guard/tools.js";

// Re-exported so the Workflow class resolves from the Worker entry point.
// Without this, `wrangler deploy` fails with a class-not-found error that
// reads like a Workflows problem rather than a missing export.
export { IngestWorkflow } from "./ingest.js";

const SPORT = "ncaaf";

// Durable preferences (§7). Namespaced so it cannot collide with whatever
// AIChatAgent uses for message persistence — verify with a storage.list()
// before trusting this on a populated DO.
const PREFS_KEY = "sfs:prefs:v1";

// Per-sport runtime estimate. Volunteered, never filtered on — every NCAAF
// game lands in the same bucket, so it is metadata, not a dimension.
const RUNTIME_ESTIMATE = "about 3 to 3.5 hours, longer if it went to overtime";

type Prefs = Record<string, { value: string; liked: boolean }>;

export class ChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;

  // Resumes an interrupted stream after a disconnect. Was briefly disabled
  // while chasing "tool call was interrupted" errors; those turned out to be
  // the frame duplication, so this is back on.
  chatRecovery = true;

  // MCP is removed, not disabled. An MCP server is an uncontrolled tool
  // surface: it can return arbitrary content straight into the model's
  // context, which defeats the point of building three enforcement layers
  // around what the model is allowed to see. Nothing in the spec needs it.

  private async loadPrefs(): Promise<Prefs> {
    return (await this.ctx.storage.get<Prefs>(PREFS_KEY)) ?? {};
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    // The Workers AI binding sends each fragment twice per SSE frame — once in
    // choices[].delta.content and once in the legacy `response` field — and
    // provider 3.3.1 emits a text-delta for both. Strip the duplicate before
    // the provider parses it. See src/ai-stream-fix.js.
    const env = this.env;
    const ai = new Proxy(this.env.AI, {
      get(target, prop, receiver) {
        if (prop !== "run") return Reflect.get(target, prop, receiver);
        return async (model: string, inputs: any, options?: any) => {
          const result = await (target as any).run(model, inputs, options);
          if (!(inputs?.stream && result instanceof ReadableStream)) return result;

          // Frame watching is gated on a var so it can be turned on against a
          // live turn without a code change. It reports structure only —
          // tool calls, finish reasons, and whether the stream ended early.
          const watch = (env as any)?.DEBUG_FRAMES === "1"
            ? createFrameWatcher()
            : undefined;
          return dedupeAIStream(result, watch);
        };
      },
    });

    const workersai = createWorkersAI({
      binding: ai,
      gateway: { id: "sfs-agent" },
    });

    // One tool failure should end the turn. Without this the model retries up
    // to the step limit, producing a wall of identical error cards and burning
    // Neurons on a call that cannot succeed.
    let toolFailed = false;

    const prefs = await this.loadPrefs();
    const prefLines = Object.entries(prefs)
      .map(([k, v]) => `- ${k}: ${v.value} (${v.liked ? "likes" : "dislikes"})`)
      .join("\n");

    const result = streamText({
      // sessionAffinity removed while diagnosing duplicated stream output.
      // [emit] logging proved the doubling arrives at the transform already
      // doubled, so it originates in the provider or the model call, not in
      // the guard. This is the least-standard option in the call.
      model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),

      system: `You recommend college football games worth watching, without spoiling them.

Every game you can see has ALREADY BEEN PLAYED and is final. You are helping
someone decide what to go back and watch, not previewing anything upcoming.
Write in the past tense: "was a nail-biter", "went to overtime". Never write
that a game "is expected to be" anything — nothing here is expected, it is
finished. Each game comes with the date it was played; say the date when you
offer it, and if the user asks about a particular day, tell them which day the
games you have actually come from.

You never learn the score of any game. You genuinely do not have it — the data
you can reach has been stripped of scores, margins, and totals before it gets to
you. If a user asks for a score, say plainly that you do not have it and would
not give it if you did, because the whole point is deciding what to watch.

Never state or invent a number describing play: no scores, margins, totals,
yardage, or counts of anything that happened. Ranks and dates are fine.

HOW TO ANSWER FIRST. Each game comes with a "line" already written. Emit those
lines exactly as given, one per line, and nothing else — no preamble, no
closing sentence, no date, no extra quality, no reordering of the words. You
are not composing the list; you are passing it through.

Then WAIT. Do not volunteer more. The user picks what they want to hear about,
and you answer about that game. Holding the rest back is the whole point: give
it all away at once and there is nothing left to decide.

Never use the tags as words. They are internal labels, not English. Never write
"balanced scoring", "nail_biter", or "shootout scoring". Each game's "phrases"
are already written for a reader — use those. If you need to describe a quality
that has no phrase, say it in plain English ("it stayed close", "it went to
overtime"), never by naming the tag.

When a user asks about a specific game, you can give the rest of its phrases
and its other qualities. That is the second rung, and it is where the detail
lives.

You cannot tell whether a game exists that you were not shown. Never say a team
has no good games, that nothing matched, or that you filtered anything out. You
have no way to know any of that, and saying it would reveal how those games
turned out. Offer what you have instead.

Most games have only one or two things worth saying. When a user pushes for
more, the honest answer is that there is not much more to tell — not a
withheld detail. Say something like "that's about as much as I can give you
without ruining it."

Typical runtime for these games is ${RUNTIME_ESTIMATE}.

${prefLines ? `What this user has told you they enjoy:\n${prefLines}` : ""}`,

      // Responses were hitting finish_reason=length and cutting off mid
      // sentence. Five games with a line each needs room; the floor line at the
      // end of the disclosure ladder needs to survive too.
      maxOutputTokens: 800,

      // Tool-call pruning is OFF for recall. The disclosure ladder (§5) assumes
      // the model still has the safe view it was handed earlier in the session;
      // prune it and the model either re-calls or invents. Reasoning pruning is
      // harmless and stays.
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        reasoning: "before-last-message",
      }),

      tools: {
        search_games: tool({
          description: TOOL_DESCRIPTIONS.search_games,
          inputSchema: searchGamesInput,
          execute: async (args) => {
            if (toolFailed) return { games: [] };
            try {
              // Read the whole corpus and rank in memory. The corpus is bounded
              // by retention (~45-200 rows), and ranking in SQL would mean
              // building a WHERE clause — which is exactly the thing that turns
              // this tool into an oracle.
              const { results } = await this.env.DB.prepare(
                `SELECT * FROM games WHERE sport = ?`
              ).bind(SPORT).all();

              // One line per turn, not per token. Tells you which call actually
              // reached execute() — with retries in play, the tool card in the
              // UI does not.
              console.log(
                `[search_games] rows=${results?.length ?? 'none'} args=${JSON.stringify(args)}` +
                ` gatewayLog=${(this.env.AI as any)?.aiGatewayLogId ?? 'none'}`,
              );

              return searchGames(results as any[], args);
            } catch (err) {
              // The SDK reports execute failures to the model as a generic
              // "An error occurred", so the real cause has to be logged here or
              // it is invisible in wrangler tail.
              toolFailed = true;
              console.error('[search_games] FAILED', {
                message: (err as Error)?.message,
                stack: (err as Error)?.stack,
                hasDB: !!this.env.DB,
                args,
              });
              throw err;
            }
          },
        }),

        get_watch_options: tool({
          description: TOOL_DESCRIPTIONS.get_watch_options,
          inputSchema: watchOptionsInput,
          execute: async ({ id }) => {
            const row = await this.env.DB.prepare(
              `SELECT id, home, away, league, date, broadcast, watch_name, watch_url,
                      collinsworth_warning, overtime
                 FROM games WHERE id = ? AND sport = ?`
            ).bind(id, SPORT).first();

            if (!row) return { watch: null, runtime: RUNTIME_ESTIMATE };

            return {
              watch: {
                broadcast: (row as any).broadcast ?? null,
                provider: (row as any).watch_name ?? null,
                url: (row as any).watch_url ?? null,
              },
              runtime: RUNTIME_ESTIMATE,
            };
          },
        }),

        save_preference: tool({
          description: TOOL_DESCRIPTIONS.save_preference,
          inputSchema: savePreferenceInput,
          execute: async ({ key, value, liked }) => {
            const prefs = await this.loadPrefs();
            prefs[key] = { value, liked };
            await this.ctx.storage.put(PREFS_KEY, prefs);
            return { saved: key };
          },
        }),
      },

      // Layer 3 (§8.1). Runs on typed parts before protocol encoding, so it
      // never touches the wire format. The transform itself lives in guard/ so
      // it can be tested under plain node.
      experimental_transform: ({ stopStream }) =>
        createScanTransform({
          stopStream,
          onViolation: (v: string) =>
            console.warn(`[scanner] blocked hallucinated number: ${v}`),
          // `as any`: streamText binds the transform's generic to this exact
          // tool set, and the scanner is deliberately generic — it only ever
          // inspects text-delta parts and passes everything else through
          // untouched, so it cannot be typed against a specific ToolSet
          // without lying about what it handles.
        }) as any,

      // A rejected tool call is otherwise invisible: the model sees a generic
      // error card and execute() never runs, so neither a try/catch in the tool
      // nor onError sees it. Returning null declines to repair — this only
      // makes the failure legible.
      experimental_repairToolCall: async ({ toolCall, error }) => {
        const call = toolCall as any;
        const schema =
          call?.toolName === 'search_games' ? searchGamesInput :
          call?.toolName === 'save_preference' ? savePreferenceInput :
          call?.toolName === 'get_watch_options' ? watchOptionsInput : null;

        const repaired = schema ? repairToolInput(schema, call?.input) : null;

        console.error('[repair] tool call rejected', {
          toolName: call?.toolName,
          input: call?.input,
          repaired: repaired ? JSON.stringify(repaired) : null,
          errorName: (error as any)?.name,
        });

        // Repairs are type-only (see repairToolInput). An out-of-vocabulary
        // enum is NOT repaired — it stays rejected, because accepting it would
        // mean the schema no longer closes the vocabulary.
        if (!repaired) return null;

        // Cast back to the call's own type: the SDK models tool calls as a
        // union discriminated on `dynamic`, and spreading widens it in a way
        // the union will not accept. Only `input` changes.
        return { ...call, input: JSON.stringify(repaired) } as typeof toolCall;
      },

      // Errors above execute() — invalid tool input, unknown tool, provider
      // failures — never reach the tool body, so a try/catch inside execute
      // cannot see them. This is the only place they surface.
      onError: ({ error }) => {
        const e = error as any;
        console.error('[streamText] ERROR', {
          name: e?.name,
          message: e?.message,
          toolName: e?.toolName,
          toolInput: e?.toolInput ?? e?.input,
          cause: String(e?.cause ?? ''),
        });
      },

      stopWhen: stepCountIs(10),
      abortSignal: options?.abortSignal,
    });

    return result.toUIMessageStreamResponse();
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
