import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { convertToModelMessages, pruneMessages, stepCountIs, streamText, tool } from "ai";
import type { TextStreamPart, ToolSet } from "ai";

import { createScanTransform } from "./guard/scanner.js";
import {
  searchGamesInput,
  watchOptionsInput,
  savePreferenceInput,
  TOOL_DESCRIPTIONS,
  searchGames,
  toResult,
} from "./guard/tools.js";

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
  chatRecovery = true;

  // MCP is removed, not disabled. An MCP server is an uncontrolled tool
  // surface: it can return arbitrary content straight into the model's
  // context, which defeats the point of building three enforcement layers
  // around what the model is allowed to see. Nothing in the spec needs it.

  private async loadPrefs(): Promise<Prefs> {
    return (await this.ctx.storage.get<Prefs>(PREFS_KEY)) ?? {};
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workersai = createWorkersAI({
      binding: this.env.AI,
      gateway: { id: "sfs-agent" },
    });

    const prefs = await this.loadPrefs();
    const prefLines = Object.entries(prefs)
      .map(([k, v]) => `- ${k}: ${v.value} (${v.liked ? "likes" : "dislikes"})`)
      .join("\n");

    const result = streamText({
      model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        sessionAffinity: this.sessionAffinity,
      }),

      system: `You recommend college football games worth watching, without spoiling them.

You never learn the score of any game. You genuinely do not have it — the data
you can reach has been stripped of scores, margins, and totals before it gets to
you. If a user asks for a score, say plainly that you do not have it and would
not give it if you did, because the whole point is deciding what to watch.

Never state or invent a number describing play: no scores, margins, totals,
yardage, or counts of anything that happened. Ranks and dates are fine.

Describe a game using the phrases and qualities the tools give you, and nothing
beyond them. If a game came back tagged "competitive" and the user asked for a
nail-biter, say so — offer what you have rather than pretending it matches.

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
            // Read the whole corpus and rank in memory. The corpus is bounded
            // by retention (~45-200 rows), and ranking in SQL would mean
            // building a WHERE clause — which is exactly the thing that turns
            // this tool into an oracle.
            const { results } = await this.env.DB.prepare(
              `SELECT * FROM games WHERE sport = ?`
            ).bind(SPORT).all();

            return searchGames(results as any[], args);
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
          onViolation: (v) => console.warn(`[scanner] blocked hallucinated number: ${v}`),
        }) as unknown as TransformStream<TextStreamPart<ToolSet>, TextStreamPart<ToolSet>>,

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
