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
  /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}\b/gi,
  /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g,                    // 9/12
  /\b(?:20)\d{2}\b/g,                                       // year
  /\b\d{1,2}(?:\.\d)?\s*(?:-|–|to)?\s*\d{0,2}(?:\.\d)?\s*(?:hours?|hrs?|h|minutes?|mins?)\b/gi,
  /\b\d{1,2}(?::\d{2})\s*(?:am|pm)?\b/gi,                   // clock time
];

// Held back so a number split across deltas ("3" then "8") is never emitted
// before it can be judged, and so a permitted pattern is complete before the
// settled text is scanned. Must exceed the longest PERMITTED match.
const TAIL = 32;

export const FLOOR_LINE =
  "That's as much as I can give you without ruining it.";

/**
 * @param text  full text seen so far — permitted patterns are matched against
 *              ALL of it, so a pattern still being written ("about 3" on its
 *              way to "about 3 to 3.5 hours") is not judged half-finished.
 * @param limit only report violations before this offset. The caller passes
 *              the settled boundary; everything after it may still grow.
 * @returns the offending fragment, or null when clean.
 */
export function findViolation(text, limit = text.length) {
  // Mask with same-length runs so offsets survive and `limit` stays meaningful.
  let masked = text;
  for (const re of PERMITTED) {
    masked = masked.replace(re, (m) => ' '.repeat(m.length));
  }
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
        return { emit: '', violation };
      }

      const emit = full.slice(emitted, settledEnd);
      emitted = settledEnd;
      return { emit, violation: null };
    },

    flush() {
      if (tripped) return { emit: '', violation: null };
      const violation = findViolation(full);
      if (violation) {
        tripped = true;
        return { emit: '', violation };
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
export function createScanTransform({ stopStream, onViolation } = {}) {
  const scanners = new Map();
  let fired = false;

  const trip = (controller, id, violation) => {
    fired = true;
    onViolation?.(violation);
    controller.enqueue({ type: 'text-delta', id, text: ` ${FLOOR_LINE}` });
    controller.enqueue({ type: 'text-end', id });
    stopStream?.();
  };

  return new TransformStream({
    transform(part, controller) {
      if (fired) return;

      if (part.type === 'text-delta') {
        let scanner = scanners.get(part.id);
        if (!scanner) { scanner = createScanner(); scanners.set(part.id, scanner); }

        const { emit, violation } = scanner.push(part.text);
        if (emit) controller.enqueue({ ...part, text: emit });
        if (violation) trip(controller, part.id, violation);
        return;
      }

      if (part.type === 'text-end') {
        const scanner = scanners.get(part.id);
        if (scanner) {
          const { emit, violation } = scanner.flush();
          if (emit) controller.enqueue({ type: 'text-delta', id: part.id, text: emit });
          if (violation) return trip(controller, part.id, violation);
        }
      }

      controller.enqueue(part);
    },
  });
}
