# Why I built this

This turned out to be an incredibly interesting project that went well beyond an intellectual exercise into an actual feature set I could use.

My website spoilerfreescores.com solves the problem of people wanting to find a good game to watch in their limited downtime without seeing spoilers ahead of time. No one wants to blow 3 hours on a blowout game that just frustrates you.

The site is useful and gives the information, but I had not thought of adding an LLM to it. When I saw the assignment it seemed like a perfect fit, a chance to learn this while benefiting my application. The assignment required Llama, a coordination layer, chat and memory, which gave the feature its structure and let me jump right in.

# What I built

A chat agent that recommends college football games worth watching without telling you how they ended. It is live at sfs-agent.deanderson.workers.dev and inside the college football tab on my site. College football only, on purpose.

Llama 3.3 on Workers AI through AI Gateway. One Durable Object per visitor holds the conversation and preferences. D1 holds the game data. A Workflow pulls new games every six hours and strips the scores before anything is stored. Eleven tests, each with a sabotage run that proves it fails when the thing it guards breaks.

Code and prompt history are on GitHub. The README has the details.

# The decision everything hangs on

The bedrock rule was that it could not display the winner, loser, or score, or everything was invalidated. I toyed with different ways to limit the model but ultimately came to the conclusion that never passing the results to it was the safest way. No way for someone to reveal a secret if they don't know the secret in the first place.

That rule got sharper as I used it. Halfway through I asked whether we were being too cautious (build 251). The agent was refusing to say things the site already shows on every game. That question turned into three tiers, which is what the spec now claims and nothing more.

The hard guarantees are the score, the winner, and numeric descriptions of what happened in the game. I enforce those in three places: the stored data never contains them, the tools cannot request them, and an output scanner blocks numeric content the model invents.

On the site, the game category is visible immediately, while the commentary sits behind a Why Watch button. The agent uses the same idea, the user has to ask for more before it gives additional context.

A user can still infer things from permitted facts. A rank plus "one sided" suggests who won. The existing site shows the same information, total obfuscation was never the goal, empowering the user was. The user can pick the information they want and make their own inferences. Earlier versions of the spec claimed more than the code could deliver. Limit the spec, then stick to what it says.

# What went wrong

The worst one was silent for two days. The ingest Workflow fetched the games in one step and redacted them in another, and Workflows persist whatever a step returns. So every raw score was sitting in Cloudflare storage, readable with one command, the whole time every test was green. The scores never reached the model, but the spec explicitly said they could not leave the Worker and they had. The fix was merging the two steps into one so there was never a return value to persist. The better fix was the test that now checks the step boundary, because the first version of the harness could not see this class of bug at all.

Every streamed token arrived twice. Four wrong theories before we looked at the raw frames. Workers AI sends text in two fields per frame and the provider emits both. The same bug broke tool calls, which showed up as ten random errors per turn, and later digits, because numeric tokens arrive as numbers and a string check skipped them. I found that last one by asking what about a number (build 167).

The guard I added to stop repeated tool calls returned an empty list. That is the exact absence signal a test forbids, and it got past the test because the guard was in a file the harness does not import. Moved it into the tested module. Around the same time Claude called a passing probe a failure and I had to correct it (build 247), so the catching went both ways.

Six instructions about the shape of the first answer, six different deviations, until the answer was composed in code and the model only relayed it.

# What I would tell my engineers

Three big learnings came from this.

Don't ask the model to do what code can do. After six plus iterations trying to instruct the model what the output should look like, we hard coded it. No further failures. Learn what the model is good at and use code to enforce fuzzier areas.

A test written from what you imagine the data looks like will pass against broken code. When you move from those expectations to real sabotage you find all kinds of new failures.

Models will try to theorize solutions rapidly, and grounding those theories in instrumentation leads to quicker identification and resolution instead of guessing and iterating.

# What I cut and what is next

I debated adding Eval and Judge to the testing process but ultimately decided not to in the interest of time. These would improve things but don't immediately add to the initial delivery. A judge is another model reading the output, and it does not add to the guarantee, the structural tests do.

Adding additional sports also fell into V2. I want to get some time with the product and limit its exposure on the site to decide if I want to keep it before expanding.

The UI for the deployment is ugly but the bones are alive and good and I can iterate on the polish as it gets real world usage.

# How I worked

All code is available in GitHub as well as prompt history. Design was done in one chat session, a new session was created for implementation and decision making, and a third chat existed for infrastructure operations and some prompt creation that was excluded for brevity. All commit messages were intentionally written as a narrative to tell the story of the project.

The design transcript has a lot of me saying ok. The places I steered are easier to find in the build transcript: a check that we were still building on the Cloudflare Agents SDK (31), the product call to show a team's games when asked, including the ones to skip (259, 261, 267), and the off topic probes I found by typing what a real user types (277). Progressive disclosure was my idea and Claude corrected it into a fixed budget (design 19).
