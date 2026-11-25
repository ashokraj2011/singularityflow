import { conversationStore } from './conversation-store.mjs';
import { readEvidence } from './evidence.mjs';
import { normalizeLedgerConfig } from '../ledger-config.mjs';
import { recordSha256 } from '../records.mjs';
import { resolveSlices, sliceClauseId } from '../spec-library/slice.mjs';
import { SingularityFlowError } from '../util.mjs';

const audience = 'person';
export const askConversationId = /^ask-[a-f0-9]{32}$/u;
export const evidenceId = /^ev-[a-f0-9]{24}$/u;
const digest = value => 'sha256:' + recordSha256(value);
const fail = (code, message) => new SingularityFlowError(message, { code });
const missing = () => fail('ASK_TASK_EVIDENCE_UNAVAILABLE', 'Open the selected evidence in this Ask conversation before preparing a task.');

/** The caller submits an explicit person action. Only Ask's saved handles can supply sources. */
export async function readTaskSelection(root, { conversationId, revision, target, evidence = [], clauses = [] }) {
  const store = await conversationStore({ root, context: {}, audience });
  const conversation = await store.read(conversationId, revision);
  const selected = target ?? conversation.selected?.id;
  const handles = [...new Set([selected, ...evidence])];
  if (!selected || handles.length > 8) throw missing();
  const links = handles.map(id => {
    const link = conversation.result.refs.find(item => item.id === id)
      ?? (conversation.selected?.id === id ? conversation.selected : null);
    if (!link) throw missing();
    return link;
  });
  if (clauses.length && links[0].ref.kind !== 'spec') {
    throw fail('TASK_SPEC_CLAUSE_WITHOUT_SPEC', 'Choose a reviewed specification before selecting clauses.');
  }
  return { conversation, store, links, clauses };
}

export async function taskSources(root, evidenceRoot, definition, sources) {
  const { specification, evidence } = sources;
  const slices = specification ? await resolveSlices(root, definition, [specification.reference +
    (specification.clauseIds.length ? '=' + specification.clauseIds.join(',') : '')], { taskPin: specification }) : [];
  for (const entry of evidence) {
    if (entry.locatorSha256 !== digest(entry.ref)) throw missing();
    if (specification && entry.id === evidence[0].id) continue;
    await readEvidence(evidenceRoot, entry, { audience, detail: false });
  }
  return slices;
}

export async function prepareTaskSources(root, definition, { links, clauses }) {
  const primary = links[0].ref;
  const { remote, branch } = normalizeLedgerConfig(definition.ledger ?? {});
  const evidence = links.map(({ id, ref }) => ({ id, ref, locatorSha256: digest(ref) }));
  let specification = null;
  if (primary.kind === 'spec') {
    const { reference, stateCommit, contentSha256, manifestSha256 } = primary;
    specification = { providerId: 'sflow-spec-library', revisionKind: 'published-revision',
      library: { remote, branch }, reference, stateCommit, contentSha256, manifestSha256, clauseIds: clauses };
  }
  const [slice] = await taskSources(root, root, definition, { specification, evidence });
  if (slice) specification.clauseIds = slice.clauses.map(sliceClauseId);
  return { specification, evidence };
}
