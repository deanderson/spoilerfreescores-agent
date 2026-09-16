/**
 * Output scanner — the third enforcement layer (§8.1).
 *
 * Layers 1 and 2 mean no true score ever reaches the model. This layer exists
 * only for HALLUCINATED numbers, which are spoiler-shaped to a user who has no
 * way to know they are wrong.
 *
 * Pure. No SDK types, no Cloudflare imports — the transform in server.ts wires
 * it to the stream, and nothing in here knows that a stream exists.
 *
 * Known gap, stated rather than papered over: this scans DIGITS. It does not
 * catch "thirty-eight to fourteen". The model has never seen a score, so
 * inventing one in words rather than digits would be an odd failure, but
 * "unlikely" is the honest word for it, not "handled".
 */

// Digits that invariant 1 permits (§4.1): pre-game only.
const PERMITTED = [
  /#\d{1,3}\b/g,                                            // #12 — poll rank
  /\bNo\.\s?\d{1,3}\b/gi,                                   // No. 12
  // Rank stated in prose. The safe view carries home_rank/away_rank and §4.1
  // permits ranks, but the model writes them as words ("ranked 7", "the
  // 3rd-ranked Buckeyes") rather than "#7", and those were being blocked.
  // Narrow on purpose: a score never follows the word "rank".
  /\brank(?:ed|ing)?\s*#?\s*\d{1,3}(?:st|nd|rd|th)?\b/gi,
  /\b\d{1,3}(?:st|nd|rd|th)?[- ]ranked\b/gi,
  /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}\b/gi,
  /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g,                    // 9/12
  /\b(?:20)\d{2}\b/g,                                       // year
  /\b\d{1,2}(?:\.\d)?\s*(?:-|–|to)?\s*\d{0,2}(?:\.\d)?\s*(?:hours?|hrs?|h|minutes?|mins?)\b/gi,
  /\b\d{1,2}(?::\d{2})\s*(?:am|pm)?\b/gi,                   // clock time

  // Enumerators. Not a digit describing play — a model recommending several
  // games reaches for a numbered list constantly, and without this the scanner
  // aborts most useful responses. Deliberately narrow: a small integer only at
  // the start of a line followed by '. ' or ') ', or wrapped in parentheses.
  // A score cannot occupy that position, and any digit elsewhere on the line
  // is still judged normally.
  /^[ \t]*\d{1,2}[.)](?=\s)/gm,                             // "1. " / "2) "
  /\(\d{1,2}\)/g,                                           // "(1)"
];

// Held back so a number split across deltas ("3" then "8") is never emitted
// before it can be judged, and so a permitted pattern is complete before the
// settled text is scanned. Must exceed the longest PERMITTED match.
const TAIL = 32;

/** Said when a game genuinely has nothing more to tell. */
export const FLOOR_LINE =
  "That's as much as I can give you without ruining it.";

/**
 * Said when the scanner stops a response mid-flight.
 *
 * Distinct from FLOOR_LINE on purpose. A trip is not the disclosure floor — it
 * is a safety stop, and it fires on ANY unpermitted digit, including ones with
 * nothing to do with football. Answering "list 10 roman emperors" with "that's
 * as much as I can give you without ruining it" implies a spoiler is being
 * withheld, which is both false and confusing.
 */
export const BLOCKED_LINE =
  "Sorry — I had to stop there. I only talk about which games are worth "
  + "watching, and I keep numbers out of it.";

/**
 * @param text  full text seen so far — permitted patterns are matched against
 *              ALL of it, so a pattern still being written ("about 3" on its
 *              way to "about 3 to 3.5 hours") is not judged half-finished.
 * @param limit only report violations before this offset. The caller passes
 *              the settled boundary; everything after it may still grow.
 * @returns the offending fragment, or null when clean.
 */
/** Replace every permitted pattern with same-length blanks, preserving offsets. */
export function maskPermitted(text) {
  let masked = text;
  for (const re of PERMITTED) {
    masked = masked.replace(re, (m) => ' '.repeat(m.length));
  }
  return masked;
}

export function findViolation(text, limit = text.length) {
  const masked = maskPermitted(text);
  const m = /\d[\d,.]*/.exec(masked.slice(0, limit));
  return m ? text.slice(m.index, m.index + m[0].length) : null;
}

/**
 * Streaming scanner.
 *
 *   const s = createScanner();
 *   const { emit, violation } = s.push(delta);   // emit may be ''
 *   const { emit, violation } = s.flush();       // release the tail
 *
 * Violations are detected on SETTLED text only — text far enough from the end
 * that a permitted pattern around it must already be complete. Scanning the
 * unsettled tail would trip on "3" before " hours" arrived.
 */
/**
 * Last point in `text` (at or before `limit`) where a sentence ends.
 *
 * Emitting at token granularity leaves a fragment on screen when the scanner
 * trips — "Ner", "Here are", "I'm not capable of producing a" — which reads as
 * a crash. Emitting whole sentences means a trip discards the sentence in
 * flight instead of stranding half of it.
 */
function lastSentenceEnd(text, limit) {
  for (let i = Math.min(limit, text.length) - 1; i >= 0; i--) {
    const c = text[i];
    if (c === '\n') return i + 1;
    if (c === '.' || c === '!' || c === '?') {
      const next = text[i + 1];
      if (next === undefined || next === ' ' || next === '\n') return i + 1;
    }
  }
  return 0;
}

export function createScanner() {
  let full = '';
  let emitted = 0;
  let tripped = false;

  return {
    push(delta) {
      if (tripped) return { emit: '', violation: null };
      full += delta;

      const settledEnd = Math.max(0, full.length - TAIL);

      const violation = findViolation(full, settledEnd);
      if (violation) {
        tripped = true;
        // The violation alone has never been enough to diagnose a false
        // positive: what matters is the accumulated text, where the settled
        // boundary sat, and what the mask left behind.
        return {
          emit: '',
          violation,
          context: {
            where: 'push',
            settledEnd,
            fullLen: full.length,
            full,
            masked: maskPermitted(full),
          },
        };
      }

      // Only release complete sentences. Anything after the last boundary is
      // still in flight and is discarded if the scanner trips.
      const releaseTo = Math.max(emitted, lastSentenceEnd(full, settledEnd));
      const emit = full.slice(emitted, releaseTo);
      emitted = releaseTo;
      return { emit, violation: null };
    },

    flush() {
      if (tripped) return { emit: '', violation: null };
      const violation = findViolation(full);
      if (violation) {
        tripped = true;
        return {
          emit: '',
          violation,
          context: { where: 'flush', settledEnd: full.length, fullLen: full.length, full, masked: maskPermitted(full) },
        };
      }
      const emit = full.slice(emitted);
      emitted = full.length;
      return { emit, violation: null };
    },

    get tripped() { return tripped; },
  };
}

/**
 * TransformStream over AI SDK text parts, for `experimental_transform`.
 *
 * Lives here rather than inline in server.ts so it is testable under plain
 * node — TransformStream is a web standard, and nothing below imports an SDK
 * type. An inline transform is an untested transform.
 *
 * On a violation: drop the delta, emit one fixed line, close the text part,
 * stop generation. A scanner that flags without acting is theatre, and the
 * truncated generation is the evidence trail in AI Gateway.
 */
export function createScanTransform({ stopStream, onViolation, onEmit, onContext } = {}) {
  const scanners = new Map();
  let fired = false;

  const trip = (controller, id, violation) => {
    fired = true;
    onViolation?.(violation);
    // Paragraph break, not a space: the sentence in flight was cut mid-clause,
    // so running the floor line straight on produced
    // "...with the Longhorns ranked That's as much as I can give you".
    controller.enqueue({ type: 'text-delta', id, text: `\n\n${BLOCKED_LINE}` });
    controller.enqueue({ type: 'text-end', id });
    stopStream?.();
  };

  return new TransformStream({
    transform(part, controller) {
      if (fired) return;

      if (part.type === 'text-delta') {
        let scanner = scanners.get(part.id);
        if (!scanner) { scanner = createScanner(); scanners.set(part.id, scanner); }

        const { emit, violation, context } = scanner.push(part.text);
        if (violation && context) onContext?.(context);
        if (emit) {
          onEmit?.(emit);
          // Fresh part rather than { ...part }: the incoming part may carry a
          // `delta` field alongside `text`, and spreading would keep the
          // original chunk there while only `text` was scrubbed.
          controller.enqueue({ type: 'text-delta', id: part.id, text: emit });
        }
        if (violation) trip(controller, part.id, violation);
        return;
      }

      if (part.type === 'text-end') {
        const scanner = scanners.get(part.id);
        if (scanner) {
          const { emit, violation, context } = scanner.flush();
          if (violation && context) onContext?.(context);
          if (emit) {
            onEmit?.(emit);
            controller.enqueue({ type: 'text-delta', id: part.id, text: emit });
          }
          if (violation) return trip(controller, part.id, violation);
        }
      }

      controller.enqueue(part);
    },
  });
}
