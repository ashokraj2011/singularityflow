import { createHash } from 'node:crypto';

/**
 * Compact JSON a host can page: one top-level field per line, one field per line inside a
 * top-level object, and one element per line in a top-level list. A host that saves a long tool
 * result to a file shows it by lines, and one-line JSON could not be read there at all, so a skill
 * stopped with "next action unavailable". Its search tool also shortens a long line in the middle:
 * on the 5,600-character `clarification` line, `responseStagingPath` showed as `[+5565 chars]`
 * and a file name, and the author rebuilt a wrong path from the worktree and was refused. The
 * bytes stay compact (only line breaks are added) and JSON.parse and jq read it unchanged.
 */
export function agentJson(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return JSON.stringify(value);
  const fields = presentFields(value).map(([key, child]) => `${JSON.stringify(key)}:${pagedValue(child)}`);
  return fields.length ? `{\n${fields.join(',\n')}\n}` : '{}';
}

const presentFields = (value) => Object.entries(value)
  .filter(([, child]) => child !== undefined && typeof child !== 'function');

function pagedValue(child) {
  if (Array.isArray(child)) {
    return child.length ? `[\n${child.map((entry) => JSON.stringify(entry) ?? 'null').join(',\n')}\n]` : '[]';
  }
  if (!child || typeof child !== 'object' || typeof child.toJSON === 'function') return JSON.stringify(child);
  const fields = presentFields(child).map(([key, nested]) => `${JSON.stringify(key)}:${JSON.stringify(nested)}`);
  return fields.length ? `{\n${fields.join(',\n')}\n}` : '{}';
}

/** Agent output pages by line; everything else keeps the indented JSON people read. */
export function agentOrIndentedJson(forAgent, value) {
  return forAgent ? agentJson(value) : JSON.stringify(value, null, 2);
}

const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);
// An action's route fields that its own commandGuidance repeats word for word.
const ROUTE_MIRRORS = ['command', 'executable', 'argv', 'copyable', 'platformCommands', 'skill', 'copilotCommand', 'modelFreeCommand'];

/**
 * Native-host presentation only; do not alter persisted records, bindings or gate decisions.
 *
 * An action that carries its routes in `commandGuidance` keeps them there once: the same values
 * beside it are dropped. `act` already reads an action's routes from its commandGuidance first
 * (agent-output.mjs routes()), so it is unchanged; a value that differs is kept. `[OUT:REQ-022]`
 */
export function agentPacketPresentation(packet, platform = process.platform) {
  const visit = value => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== 'object') return value;
    const visited = Object.fromEntries(Object.entries(value).map(([key, child]) => {
      // Every current-platform command remains exact. Unknown hosts retain all alternatives.
      // Never collapse the platform map when no verified command exists for this host.
      if (key === 'platformCommands' && child && typeof child[platform] === 'string') {
        return [key, { [platform]: child[platform] }];
      }
      return [key, visit(child)];
    }));
    const guidance = visited.commandGuidance;
    if (guidance && typeof guidance === 'object' && !Array.isArray(guidance) && (guidance.command || guidance.copilotCommand)) {
      for (const key of ROUTE_MIRRORS) {
        if (Object.hasOwn(visited, key) && Object.hasOwn(guidance, key) && sameJson(visited[key], guidance[key])) delete visited[key];
      }
    }
    return visited;
  };
  return visit(packet);
}

/**
 * Control before material. A host may keep only the start and end of a long tool result, so every
 * field a skill must verify before acting (binding, status, authoring route, clarification
 * checkpoint, edit permissions, next action) comes first, and the bulky sections follow, with the
 * composed context last. Nothing is sliced; copies are replaced by where to read them
 * (phaseEntryPacketCompaction).
 */
const ENTRY_CONTROL_ORDER = ['contextBoundary', 'ready', 'workId', 'phase', 'phaseStatus', 'status',
  'authoringAllowed', 'codeAuthoringReady', 'authoring', 'clarification', 'mutationContract',
  'authoringProgress', 'taskCompletion', 'taskResume', 'outcomeReview', 'afterReview', 'applicationReviewRepair', 'scopeReview', 'contextAdmission', 'next', 'testEvidenceFrom', 'upstream'];

// Instructions the composed prompt renders word for word in its own sections.
const PROMPT_RENDERED_TEXTS = [['mutationContract', 'toolProtocol', 'paths'],
  ['mutationContract', 'toolProtocol', 'localVerification', 'guidance'],
  ['retainedExecutionEvidence', 'instruction'], ['evidenceConsistency', 'instruction']];
export const IN_CONTEXT_TEXT = 'Same text as in context.text.';

/**
 * The phase-entry agent view without its copies. `[OUT:REQ-021]` `[OUT:REQ-022]`
 *
 * An agent reads the whole entry each phase, about 66 KB, and much of the JSON beside the prompt
 * said things twice. Each copy becomes where to read it, never a summary:
 * - a recovery action identical to a `next` action, as `sameAs` (`act` reads `next`);
 * - recovery blockers that differ only by line, as one blocker with `lines`, and `details` values
 *   the blocker already states;
 * - the instructions context.text renders word for word, when context.text is there.
 * Agent presentation only: plain --json, recorded prompts and every check read the full packet.
 */
export function phaseEntryPacketCompaction(packet) {
  const compact = { ...packet };
  const recovery = packet.recovery;
  if (recovery && typeof recovery === 'object' && !Array.isArray(recovery)) {
    const next = Array.isArray(packet.next) ? packet.next : [];
    compact.recovery = { ...recovery,
      ...(Array.isArray(recovery.actions) ? { actions: recovery.actions.map((action) => {
        const index = next.findIndex((entry) => sameJson(entry, action));
        return index < 0 ? action : { ...(action?.id ? { id: action.id } : {}), sameAs: `next[${index}]` };
      }) } : {}),
      ...(Array.isArray(recovery.blockers) ? { blockers: blockerGroups(recovery.blockers) } : {}) };
  }
  const text = typeof packet.context?.text === 'string' ? packet.context.text : '';
  for (const trail of text ? PROMPT_RENDERED_TEXTS : []) {
    const value = trail.reduce((node, key) => (node && typeof node === 'object' ? node[key] : undefined), compact);
    if (typeof value !== 'string' || Buffer.byteLength(value) < 200 || !text.includes(value)) continue;
    // Copy only the objects on the way, so the caller's packet is never changed.
    let node = compact;
    for (const key of trail.slice(0, -1)) node = node[key] = { ...node[key] };
    node[trail.at(-1)] = IN_CONTEXT_TEXT;
  }
  return compact;
}

/** Blockers that differ only by line, once with every line; `details` keeps only what is new. */
function blockerGroups(blockers) {
  const groups = [];
  const byShape = new Map();
  for (const blocker of blockers) {
    if (!blocker || typeof blocker !== 'object' || Array.isArray(blocker)) { groups.push(blocker); continue; }
    const { details, ...own } = blocker;
    const extra = details && typeof details === 'object' && !Array.isArray(details)
      ? Object.fromEntries(Object.entries(details).filter(([key, value]) => !sameJson(own[key], value))) : details;
    const entry = { ...own, ...(extra !== undefined && !(extra && typeof extra === 'object' && !Object.keys(extra).length) ? { details: extra } : {}) };
    if (!Object.hasOwn(entry, 'line')) { groups.push(entry); continue; }
    const { line, ...shape } = entry;
    const key = JSON.stringify(shape);
    const group = byShape.get(key);
    if (group) { group.lines.push(line); continue; }
    const created = { ...entry, lines: [line] };
    byShape.set(key, created);
    groups.push(created);
  }
  return groups.map((entry) => {
    if (!entry?.lines) return entry;
    const { lines, ...rest } = entry;
    return lines.length === 1 ? rest : { ...Object.fromEntries(Object.entries(rest).filter(([key]) => key !== 'line')), lines };
  });
}

export function phaseEntryAgentPresentation(packet) {
  if (packet.paused) return packet;
  const projected = phaseEntryPacketCompaction(agentPacketPresentation(packet));
  // Keep the complete small checkpoint ahead of the rest of the clarification record.
  if (projected.clarification) projected.clarification = {
    checkpoint: projected.clarification.checkpoint,
    ...Object.fromEntries(Object.entries(projected.clarification).filter(([key]) => key !== 'checkpoint'))
  };
  const control = ENTRY_CONTROL_ORDER.filter((key) => Object.hasOwn(projected, key));
  const material = Object.keys(projected).filter((key) => !control.includes(key) && key !== 'context');
  return { agentGuide: {
    readOrder: [...control, 'recovery', 'intent', 'recovery.testExecution', 'retainedExecutionEvidence',
      ...(Object.hasOwn(projected, 'evidenceConsistency') ? ['evidenceConsistency'] : []),
      ...(Object.hasOwn(projected, 'recordedVisualReviews') ? ['recordedVisualReviews'] : []), 'references', 'context.text'],
    testExecutionPath: 'recovery.testExecution',
    retainedExecutionEvidencePath: 'retainedExecutionEvidence',
    ...(Object.hasOwn(projected, 'evidenceConsistency') ? { evidenceConsistencyPath: 'evidenceConsistency' } : {}),
    contextFilePath: 'context.file.path',
    platform: process.platform,
    instruction: 'Read authority fields together once, without key enumeration; they come first and are complete, one field per line two levels deep. status clarification-required is this skill\'s own next step: compose and ask the unanswered questions in this turn. Never relay the skill you are running as a next action; do that step. Binding ready is not source-edit permission: use mutationContract and codeAuthoringReady before edits. authoringProgress describes the remaining draft milestone, not completed code or permission to publish. Read clarification.checkpoint before interpreting authoringAllowed. Use retainedExecutionEvidence for governed outcomes; recovery.testExecution describes this phase\'s runner, not absence of upstream execution. Reconcile stale narrative and IDE discovery separately; command success is not criterion acceptance. Never truncate control instructions with arbitrary string/byte slices. If a tool cuts context.text, read context.file.path (the same composed prompt, verified by context.file.sha256, without the presentation-only reply personalization) in bounded portions, or complete named sections from the same saved packet; do not recompose or infer absent instructions, and never author from partial context. Reuse context.text; changed bindings need fresh checks. Never reuse approval consent.'
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
