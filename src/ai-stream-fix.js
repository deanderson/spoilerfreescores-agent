/**
 * Workers AI duplicate-text workaround.
 *
 * The binding's SSE frames carry the same text in TWO places:
 *
 *   {"choices":[{"delta":{"content":" are some games"}}], "response":" are some games", ...}
 *
 * workers-ai-provider 3.3.1 reads both and emits a text-delta for each, so
 * every fragment reaches the AI SDK twice and the assembled message is
 * doubled ("HereHere are are some some").
 *
 * Fixed upstream in provider 4.x, which requires ai@7 — too large a change to
 * make mid-build. This strips the legacy `response` field from each frame
 * before the provider parses it, leaving the OpenAI-compatible
 * `choices[].delta.content` as the single source of text.
 *
 * Plain JS, no Cloudflare imports, so it is testable under node.
 *
 * REMOVE when upgrading to workers-ai-provider 4.x.
 */

/**
 * Wrap a Workers AI SSE stream, removing the duplicated `response` field.
 * Frames that are not JSON, or that carry no duplicate, pass through unchanged.
 */
export function dedupeAIStream(stream, { onFrame, onEnd } = {}) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';

  return stream.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });

        // SSE frames are separated by a blank line. Keep the last partial
        // frame in the buffer — splitting mid-frame would corrupt the JSON.
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';

        for (const frame of parts) {
          onFrame?.(frame);
          controller.enqueue(encoder.encode(rewriteFrame(frame) + '\n\n'));
        }
      },

      flush(controller) {
        buffer += decoder.decode();
        if (buffer) {
          onFrame?.(buffer);
          controller.enqueue(encoder.encode(rewriteFrame(buffer)));
        }
        // Fires even when the stream ends early, so a truncated response is
        // distinguishable from a complete one — which is the whole question
        // when a tool call reports being interrupted.
        onEnd?.();
      },
    }),
  );
}

/**
 * A carrier holds text if it is a string OR a number. Numbers matter: a token
 * that is entirely digits can be serialised unquoted, and treating that as
 * "no text here" is what let digit fragments through the strip.
 */
export function isTextual(v) {
  return typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
}

export function rewriteFrame(frame) {
  if (!frame.startsWith('data: ')) return frame;

  const payload = frame.slice(6);
  if (payload.trim() === '[DONE]') return frame;

  let obj;
  try {
    obj = JSON.parse(payload);
  } catch {
    return frame; // not JSON — leave it alone
  }

  // Type note: a purely numeric token can arrive as a JSON NUMBER
  // ("response":12) rather than a string. A typeof === 'string' test skips
  // those, the provider coerces them back to text, and the fragment is emitted
  // twice — which is why words stopped doubling but digits did not.
  // Text-bearing means string OR number, in both carriers.
  let changed = false;

  // Text: same fragment in choices[].delta.content and the legacy `response`.
  const deltaText = obj?.choices?.[0]?.delta?.content;
  if (isTextual(deltaText) && isTextual(obj.response)) {
    delete obj.response;
    changed = true;
  }

  // Tool calls: same duplication, and far more damaging. Each argument
  // fragment arrives twice, so the assembled JSON interleaves into
  //   {"recency": "{"recency": "thisthis_week"}_week"}
  // which fails to parse and the model retries until the step limit.
  //
  // Only strips when BOTH carriers are present, so a frame that uses just one
  // is untouched.
  const deltaCalls = obj?.choices?.[0]?.delta?.tool_calls;
  if (
    Array.isArray(obj.tool_calls) && obj.tool_calls.length &&
    Array.isArray(deltaCalls) && deltaCalls.length
  ) {
    delete obj.tool_calls;
    changed = true;
  }

  return changed ? 'data: ' + JSON.stringify(obj) : frame;
}

/**
 * Frame watcher for `dedupeAIStream`.
 *
 * Logging every frame is ~200 lines per turn and buries what matters, so this
 * reports only the frames that carry structure — tool calls, finish reasons,
 * anything unparseable — plus a one-line summary at the end.
 *
 * The summary is the useful part when chasing interrupted turns: a stream that
 * ends without a finish_reason ended early, and that is visible here and
 * nowhere else.
 */
export function createFrameWatcher(log = console.log) {
  let frames = 0;
  let textFrames = 0;
  let chars = 0;
  let finishReason = null;
  let toolCalls = 0;
  let unparseable = 0;
  let sawDone = false;
  // Frame shapes the dedupe does NOT currently handle. Single digits are still
  // doubling ("11." for "1."), so some frame carries text the strip misses.
  // Full carrier breakdown for text frames. Counting only the anomalies left
  // me unable to say what the NORMAL frame looks like, which is what decides
  // whether the strip applies at all.
  let bothEqual = 0;     // delta === response  -> strip applies
  let mismatch = 0;      // both present, differ -> strip assumption wrong
  let responseOnly = 0;  // response only        -> strip skips it
  let deltaOnly = 0;     // delta only           -> nothing to strip
  let emptyResponse = 0; // response present but "" — still stripped
  let multiChoice = 0;   // >1 choice; the strip only inspects choices[0]
  let numericCarrier = 0; // text arrived as a JSON number, not a string
  let bothCarriers = 0;
  // A single stream should carry ONE completion id. Two or more means separate
  // completions are interleaving, which would explain tokens arriving out of
  // order ("12" spliced into the middle of "games").
  const ids = new Map();

  return {
    onFrame(frame) {
      frames++;
      if (!frame.startsWith('data: ')) return;
      const payload = frame.slice(6).trim();
      if (payload === '[DONE]') { sawDone = true; return; }

      let o;
      try { o = JSON.parse(payload); } catch { unparseable++; log(`[frame] UNPARSEABLE ${payload.slice(0, 120)}`); return; }

      if (o?.id) ids.set(o.id, (ids.get(o.id) ?? 0) + 1);

      const choice = o?.choices?.[0];
      const text = choice?.delta?.content;
      if (isTextual(text) && String(text).length) { textFrames++; chars += String(text).length; }

      // Digits arrive out of position. Log index AND id so ordering and
      // stream-identity are both visible.
      // Previously suspected duplication ("Sep 12" -> "Sep 1212") with bothCarriers=0 and
      // responseOnly=0, so it is NOT the two-carrier duplication. Log every
      // frame whose delta carries a digit, with its index, so consecutive
      // duplicate frames are distinguishable from within-frame duplication.
      if (isTextual(text) && /\d/.test(String(text))) {
        // Full payload AND the rewritten frame: "12" arrives once here but
        // reaches the scanner as "1212", so the duplication happens between
        // this point and the AI SDK. Whether `response` is present on this
        // frame, and whether the rewrite removed it, decides where.
        log(`[frame] DIGIT #${frames} id=${o?.id?.slice(-12)} delta=${JSON.stringify(text)}`);
        log(`[frame] DIGIT raw=${payload}`);
        log(`[frame] DIGIT out=${rewriteFrame(frame)}`);
      }

      // Presence must be defined EXACTLY as rewriteFrame defines it, or the
      // counters describe something other than what the code does. Both use
      // `typeof === 'string'`, so an empty-string response counts as present
      // and IS stripped — reporting it as "absent" would have been misleading.
      const resp = o?.response;
      const hasResp = isTextual(resp);
      const hasText = isTextual(text);
      if (hasResp && String(resp).length === 0) emptyResponse++;
      if (typeof resp === 'number' || typeof text === 'number') {
        numericCarrier++;
        log(`[frame] NUMERIC CARRIER delta=${JSON.stringify(text)} (${typeof text}) `
          + `response=${JSON.stringify(resp)} (${typeof resp})`);
      }
      if (Array.isArray(o?.choices) && o.choices.length > 1) multiChoice++;

      if (hasResp && hasText) {
        if (String(resp) === String(text)) bothEqual++;
        else {
          mismatch++;
          log(`[frame] MISMATCH delta=${JSON.stringify(text)} response=${JSON.stringify(resp)}`);
        }
      } else if (hasResp) {
        responseOnly++;
        log(`[frame] RESPONSE-ONLY ${JSON.stringify(resp)} :: ${payload.slice(0, 200)}`);
      } else if (hasText) {
        deltaOnly++;
      }

      const topCalls = o?.tool_calls;
      const deltaCalls = choice?.delta?.tool_calls;
      const anyCalls =
        (Array.isArray(topCalls) && topCalls.length) ||
        (Array.isArray(deltaCalls) && deltaCalls.length);
      if (anyCalls) {
        toolCalls += (topCalls?.length ?? 0) + (deltaCalls?.length ?? 0);
        if (Array.isArray(topCalls) && topCalls.length &&
            Array.isArray(deltaCalls) && deltaCalls.length) {
          bothCarriers++;
        }
        // Full payload: which carrier holds the fragments decides the fix, and
        // guessing that wrong is what produced the interleaved JSON.
        log(`[frame] tool_calls RAW ${payload.slice(0, 400)}`);
      }

      if (choice?.finish_reason) {
        finishReason = choice.finish_reason;
        log(`[frame] finish_reason=${finishReason}`);
      }

      if (o?.error) log(`[frame] ERROR ${JSON.stringify(o.error).slice(0, 300)}`);
    },

    onEnd() {
      log(
        `[frame] END frames=${frames} text=${textFrames} chars=${chars} ` +
        `ids=${ids.size}${ids.size > 1 ? ' <-- MULTIPLE COMPLETIONS INTERLEAVED' : ''} ` +
        `tool_calls=${toolCalls} bothCarriers=${bothCarriers} ` +
        `bothEqual=${bothEqual} deltaOnly=${deltaOnly} emptyResp=${emptyResponse} ` +
        `multiChoice=${multiChoice} numericCarrier=${numericCarrier} ` +
        `responseOnly=${responseOnly} mismatch=${mismatch} ` +
        `finish=${finishReason ?? 'NONE'} ` +
        `done=${sawDone} unparseable=${unparseable}` +
        (finishReason === null || !sawDone ? '  <-- STREAM ENDED EARLY' : ''),
      );
    },
  };
}
