import { createHash } from 'node:crypto';

/** Native-host presentation only; do not alter persisted records, bindings or gate decisions. */
export function agentPacketPresentation(packet, platform = process.platform) {
  const visit = value => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => {
      // Every current-platform command remains exact. Unknown hosts retain all alternatives.
      // Never collapse the platform map when no verified command exists for this host.
      if (key === 'platformCommands' && child && typeof child[platform] === 'string') {
        return [key, { [platform]: child[platform] }];
      }
      return [key, visit(child)];
    }));
  };
  return visit(packet);
}

export function phaseEntryAgentPresentation(packet) {
  if (packet.paused) return packet;
  return { agentGuide: {
    readOrder: [...(packet.contextBoundary ? ['contextBoundary'] : []), 'ready', 'phase', 'authoring', 'contextAdmission', 'recovery', 'intent',
      'recovery.testExecution', 'clarification', 'references', 'context.text', 'next'],
    testExecutionPath: 'recovery.testExecution',
    platform: process.platform,
    instruction: 'Read authority fields together once, without key enumeration. Reuse context.text; changed bindings need fresh checks. Never reuse approval consent.'
  }, ...agentPacketPresentation(packet) };
}

const MANAGED_METADATA = /^<!-- singularity-flow:(?:initiative-)?metadata\n[\s\S]*?\n-->\n?/u;
const MANAGED_INPUTS = /<!-- singularity-flow:inputs:start -->[\s\S]*?<!-- singularity-flow:inputs:end -->/gu;

/**
 * The agent view of a phase review: every authored byte, with engine-written blocks as references.
 *
 * Most of a published artifact is engine-written: the provenance metadata block and the managed copy
 * of approved upstream inputs (in one live run, 5.6–10 KB against 1.4–4 KB of authored text). An
 * agent re-read them on every review and re-printed them into chat. Each becomes one marker line with
 * its kind, size and SHA-256, also listed in `managedBlocks`; the document keeps its full-file size
 * and SHA-256, the display binding is computed from the full content, and `documents view` returns the
 * full text. Plain `--json` output is unchanged.
 */
export function phaseReviewAgentPresentation(review, platform = process.platform) {
  const documents = (review.documents ?? []).map((document) => {
    if (typeof document.content !== 'string') return document;
    const managedBlocks = [];
    const marker = (kind, text) => {
      const bytes = Buffer.byteLength(text);
      const sha256 = createHash('sha256').update(text).digest('hex');
      managedBlocks.push({ kind, bytes, sha256 });
      return `<!-- singularity-flow:${kind} block, ${bytes} bytes, sha256:${sha256}; engine-written. Full text: singularity-flow documents view ${document.id} -->`;
    };
    const content = document.content
      .replace(MANAGED_METADATA, (text) => `${marker('metadata', text)}\n`)
      .replace(MANAGED_INPUTS, (text) => marker('inputs', text));
    return managedBlocks.length ? { ...document, content, contentForm: 'authored-with-managed-references', managedBlocks } : document;
  });
  return agentPacketPresentation({ ...review, documents }, platform);
}
