import { createHash } from 'node:crypto';

/**
 * Compact JSON a host can page: one top-level field per line, and one element per line in a
 * top-level list. A host that saves a long tool result to a file shows it by lines, and one-line
 * JSON could not be read there at all, so a skill stopped with "next action unavailable". The bytes
 * stay compact (only line breaks are added) and JSON.parse and jq read it unchanged.
 */
export function agentJson(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return JSON.stringify(value);
  const fields = Object.entries(value).filter(([, child]) => child !== undefined && typeof child !== 'function')
    .map(([key, child]) => Array.isArray(child) && child.length
      ? `${JSON.stringify(key)}:[\n${child.map((entry) => JSON.stringify(entry) ?? 'null').join(',\n')}\n]`
      : `${JSON.stringify(key)}:${JSON.stringify(child)}`);
  return fields.length ? `{\n${fields.join(',\n')}\n}` : '{}';
}

/** Agent output pages by line; everything else keeps the indented JSON people read. */
export function agentOrIndentedJson(forAgent, value) {
  return forAgent ? agentJson(value) : JSON.stringify(value, null, 2);
}

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

/**
 * Control before material. A host may keep only the start and end of a long tool result, so every
 * field a skill must verify before acting (binding, status, authoring route, clarification
 * checkpoint, edit permissions, next action) comes first, and the bulky sections follow, with the
 * composed context last. Nothing is sliced or removed; only the order changes.
 */
const ENTRY_CONTROL_ORDER = ['contextBoundary', 'ready', 'workId', 'phase', 'phaseStatus', 'status',
  'authoringAllowed', 'codeAuthoringReady', 'authoring', 'clarification', 'mutationContract',
  'authoringProgress', 'contextAdmission', 'next', 'testEvidenceFrom', 'upstream'];

export function phaseEntryAgentPresentation(packet) {
  if (packet.paused) return packet;
  const projected = agentPacketPresentation(packet);
  // Keep the complete small checkpoint ahead of the rest of the clarification record.
  if (projected.clarification) projected.clarification = {
    checkpoint: projected.clarification.checkpoint,
    ...Object.fromEntries(Object.entries(projected.clarification).filter(([key]) => key !== 'checkpoint'))
  };
  const control = ENTRY_CONTROL_ORDER.filter((key) => Object.hasOwn(projected, key));
  const material = Object.keys(projected).filter((key) => !control.includes(key) && key !== 'context');
  return { agentGuide: {
    readOrder: [...control, 'recovery', 'intent', 'recovery.testExecution', 'retainedExecutionEvidence', 'references', 'context.text'],
    testExecutionPath: 'recovery.testExecution',
    retainedExecutionEvidencePath: 'retainedExecutionEvidence',
    contextFilePath: 'context.file.path',
    platform: process.platform,
    instruction: 'Read authority fields together once, without key enumeration; they come first and are complete, one top-level field per line. status clarification-required is this skill\'s own next step: compose and ask the unanswered questions in this turn. Never relay the skill you are running as a next action; do that step. Binding ready is not source-edit permission: use mutationContract and codeAuthoringReady before edits. authoringProgress describes the remaining draft milestone, not completed code or permission to publish. Read clarification.checkpoint before interpreting authoringAllowed. Use retainedExecutionEvidence for governed outcomes; recovery.testExecution describes this phase\'s runner, not absence of upstream execution. Reconcile stale narrative and IDE discovery separately; command success is not criterion acceptance. Never truncate control instructions with arbitrary string/byte slices. If a tool cuts context.text, read context.file.path (the same composed prompt, verified by context.file.sha256, without the presentation-only reply personalization) in bounded portions, or complete named sections from the same saved packet; do not recompose or infer absent instructions, and never author from partial context. Reuse context.text; changed bindings need fresh checks. Never reuse approval consent.'
  },
  ...Object.fromEntries([...control, ...material].map((key) => [key, projected[key]])),
  ...(Object.hasOwn(projected, 'context') ? { context: projected.context } : {}) };
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
