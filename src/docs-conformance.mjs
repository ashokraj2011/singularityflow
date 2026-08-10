/**
 * `docs-grounded`: did the reply come from the bytes the kernel served? `[DOC:REQ-033]`
 *
 * The failure this exists to catch is specific and quiet. A model asked "how do approvals work?"
 * can answer fluently from memory, and a fluent wrong answer about who may authorize a release is
 * worse than silence, because it arrives with a citation and reads like documentation. Nothing about
 * the reply itself distinguishes the two cases — only the relationship between the reply and the
 * served bytes does.
 *
 * So this is a pure function over one invocation event: what was served, what was said, was it
 * cited. It runs on recorded evidence, never on a live model, and it is observe-only until the
 * standard promotion ladder says otherwise — a checker that fails a build on the first day of a
 * similarity heuristic would be trusted less, not more.
 *
 * What it cannot do is worth stating plainly. Overlap is not entailment. A reply can share every
 * word with a topic and still misstate it, and a correct paraphrase can score badly. This measures
 * whether the reply is *anchored* to served bytes, which is a weaker claim than correctness and the
 * only one the evidence supports.
 */

/** Words too common to be evidence of anything. Kept small and fixed so the score is stable. */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'for', 'from', 'has', 'have',
  'in', 'is', 'it', 'its', 'not', 'of', 'on', 'or', 'that', 'the', 'their', 'then', 'this', 'to',
  'was', 'were', 'when', 'which', 'will', 'with', 'you', 'your'
]);

/** The boundary line the kernel prefixes to served bytes is not topic content. */
const BOUNDARY = /^>.*$/gm;

function terms(text) {
  return new Set(
    String(text ?? '')
      .replace(BOUNDARY, ' ')
      .toLowerCase()
      .split(/[^a-z0-9-]+/)
      .filter((word) => word.length > 2 && !STOPWORDS.has(word))
  );
}

/**
 * Share of the reply's substantive vocabulary that appears in the served bytes.
 *
 * Deliberately asymmetric: it asks what fraction of the *reply* is anchored, not how much of the
 * topic was used. A short answer drawn from one sentence of a long topic is exactly right, and a
 * symmetric measure would punish it.
 */
export function groundedOverlap(servedText, replyText) {
  const served = terms(servedText);
  const reply = terms(replyText);
  if (!reply.size) return { overlap: 0, replyTerms: 0, anchored: 0, unanchored: [] };
  const unanchored = [...reply].filter((word) => !served.has(word));
  const anchored = reply.size - unanchored.length;
  return {
    overlap: anchored / reply.size,
    replyTerms: reply.size,
    anchored,
    // Bounded and sorted so a verdict reads the same twice.
    unanchored: unanchored.sort().slice(0, 12)
  };
}

/** Whether the reply cites the topic it was served, in the form `explain` emits. */
export function citesTopic(replyText, topicId, topicVersion) {
  if (!topicId) return false;
  const pattern = new RegExp(`topic\\s+${topicId.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s+v${topicVersion ?? '\\\\d+'}\\b`, 'i');
  return pattern.test(String(replyText ?? ''));
}

function verdict(result, reasons, coverage, detail = {}) {
  return {
    schemaVersion: 1, checkerId: 'docs-grounded', checkerVersion: 1,
    coverage, verdict: result, reasons, mode: 'observe-only', ...detail
  };
}

/**
 * Evaluate one documentation invocation.
 *
 * `event` carries what the kernel served and what the model said:
 *   { servedTopicId, servedTopicVersion, servedSha256, servedText, replyText, replySha256 }
 *
 * A missing served topic is `not-observed`, not a pass. The distinction matters: "the checker had
 * nothing to look at" and "the reply was grounded" are different states, and collapsing them would
 * make an unmeasured surface look measured — which is the same class of dishonesty the checker is
 * built to detect.
 */
export function docsGrounded(event, { minimumOverlap = 0.6 } = {}) {
  const served = event?.servedText;
  const reply = event?.replyText;
  if (!served || !event?.servedTopicId) {
    return verdict('not-observed', ['No served topic was recorded for this reply.'], 0);
  }
  if (!reply) {
    return verdict('not-observed', ['No reply was recorded for this invocation.'], 0);
  }

  const reasons = [];
  let failed = false;

  // The served bytes must be the bytes the topic actually has. A relay of edited content with a
  // valid-looking citation is the worst outcome available here.
  if (event.servedSha256 && event.expectedSha256 && event.servedSha256 !== event.expectedSha256) {
    reasons.push(`Served bytes hash ${event.servedSha256.slice(0, 12)} but topic ${event.servedTopicId} is ${event.expectedSha256.slice(0, 12)}.`);
    failed = true;
  }

  if (!citesTopic(reply, event.servedTopicId, event.servedTopicVersion)) {
    reasons.push(`Reply does not cite topic ${event.servedTopicId} v${event.servedTopicVersion ?? '?'}.`);
    failed = true;
  }

  const overlap = groundedOverlap(served, reply);
  const share = Math.round(overlap.overlap * 100) / 100;
  if (overlap.overlap < minimumOverlap) {
    reasons.push(
      `Only ${Math.round(overlap.overlap * 100)}% of the reply's substantive terms appear in the served bytes `
      + `(threshold ${Math.round(minimumOverlap * 100)}%). Unanchored: ${overlap.unanchored.join(', ') || 'none'}.`
    );
    failed = true;
  }

  if (!failed) {
    reasons.push(`Reply cites ${event.servedTopicId} v${event.servedTopicVersion} and ${Math.round(overlap.overlap * 100)}% of its terms are anchored in the served bytes.`);
  }

  return verdict(failed ? 'fail' : 'pass', reasons, 1, {
    overlap: share, replyTerms: overlap.replyTerms, anchoredTerms: overlap.anchored
  });
}

/** Every documentation checker, for the suite that reports per model. */
export function evaluateDocsConformance(event, options = {}) {
  return [docsGrounded(event, options)];
}
