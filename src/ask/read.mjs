import { createHash } from 'node:crypto';
import { validateArguments } from '../gateway/argument-schemas.mjs';
import { noEffects, repositoryReference, sflowResult } from '../gateway/result.mjs';
import { askSuggestions } from './navigation.mjs';
import { askIntent } from './query.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const finding = (code, message, category = 'unavailable') => ({ code, message, category });

function ownerFinding(error) {
  const code = error.code ?? 'ASK_SOURCE_UNAVAILABLE';
  const categories = {
    SPEC_LIBRARY_NOT_FOUND: 'absent',
    SPEC_LIBRARY_NOT_REVIEWED: 'not-reviewed',
    SPEC_LIBRARY_REVISION_INVALID: 'invalid',
    SPEC_REFERENCE_INVALID: 'invalid',
    SPEC_ID_INVALID: 'invalid',
    SPEC_SHARE_DENIED: 'access-restricted',
    ASK_REQUEST_INVALID: 'clarification',
    ASK_TIME_WINDOW_INVALID: 'clarification'
  };
  return finding(code, error.message ?? 'The source could not be read.', categories[code]);
}

function specificationResult(read) {
  return {
    reference: read.specId + '@' + read.revision,
    title: read.manifest.title,
    reviewState: read.manifest.reviewState,
    stateCommit: read.commit,
    manifestSha256: read.manifestSha256,
    contentSha256: read.manifest.files['spec.md']
  };
}

async function currentWork(root, context, intent) {
  const [{ workRecords }, { executeGitQuery }, { libraryConfig }] = await Promise.all([
    import('../gateway/work-records.mjs'), import('../git-query.mjs'), import('../spec-library/library.mjs')
  ]);
  const selected = intent.workId ?? context.workId ?? context.storyId ?? null;
  const reference = selected ?? context.branch ?? executeGitQuery(root, 'repository.branch');
  if (!reference) return { work: null, matches: [], diagnostics: [
    finding('ASK_WORK_CONTEXT_REQUIRED', 'Select a Story checkout or ask for a Story by ID.', 'absent')
  ] };
  const kind = intent.workKind ?? (selected && !intent.workId ? context.workKind : null);
  const definition = await libraryConfig(root);
  const records = await workRecords(root, {
    definition, actor: context.actor, includeCompleted: true,
    repositoryId: context.repositoryId,
    selection: { reference, kind, branchOnly: !selected }
  });
  if (records.items.length > 1) return { work: null, matches: records.items.slice(0, 3).map(({ id, kind }) => ({ id, kind })), diagnostics: [
    finding('ASK_SCOPE_AMBIGUOUS', 'More than one work record matches. Choose a Story or an Initiative.', 'conflict')
  ] };
  if (records.items.length) return { work: records.items[0], matches: [], diagnostics: [] };
  return { work: null, matches: [], diagnostics: records.unreadable.length
    ? [finding(records.unreadable[0].code, records.unreadable[0].reason)]
    : [finding('ASK_NOT_FOUND', selected ? 'No matching work record was found in this checkout.'
      : 'No current Story or Initiative was found on this checkout. Open a Story or enter its ID.', 'absent')] };
}

function workResult(record) {
  const { id, kind, title, branch, phase, phaseLabel, status, workStatus, generation, blockers, repositoryId, recordPath, recordCommit } = record;
  return { id, kind, title, branch, phase, phaseLabel, status, workStatus, generation, blockers, repositoryId, recordPath, recordCommit };
}

async function reviewedHelp(query) {
  const { resolveHelp } = await import('../help-service.mjs');
  const resolved = await resolveHelp(query, { maxBytes: 1100 });
  if (resolved.status !== 'resolved') {
    return { candidates: resolved.candidates.slice(0, 3).map(({ id, title }) => ({ id, title })) };
  }
  return { help: {
    id: resolved.topic.id, title: resolved.topic.title, handle: resolved.handle,
    citation: resolved.citation, text: resolved.served.text, truncated: resolved.served.truncated
  } };
}

/** Exact owner reads are the only Ask operations that use a repository. */
export async function readAsk({ root = null, context = {}, arguments: proposed, audience = 'model' }) {
  const { query, workId, cursor } = validateArguments('ask-query-v1', proposed);
  const intent = cursor ? { kind: 'continuation' } : askIntent(query, workId);
  const effectiveScope = { workspaceId: context.workspace?.id ?? null, repositoryId: context.repositoryId ?? repositoryReference(root) };
  const data = {
    capability: 'ask-r1', answeredBy: 'deterministic', effectiveScope,
    status: 'resolved', kind: intent.kind, items: [], diagnostics: []
  };
  try {
    if (cursor && (query !== 'continue' || workId)) {
      data.diagnostics = [finding('ASK_REQUEST_INVALID', 'Continue the previous results or submit a new question.', 'clarification')];
    } else if (workId && ['work-history', 'work', 'story-spec'].includes(intent.kind) &&
        intent.workId?.toLowerCase() !== workId.toLowerCase()) {
      data.diagnostics = [finding('ASK_REQUEST_INVALID', 'Name one work ID per Ask SFlow query.', 'clarification')];
    } else if (intent.kind === 'clarification') {
      data.diagnostics = [finding('ASK_REQUEST_INVALID', intent.message, 'clarification')];
    } else if (intent.kind === 'discovery') {
      data.items = askSuggestions(query).map(({ id, label, detail, topic }) => ({ id, label, detail, topic }));
      // A destination name is navigation. A question can also use the reviewed help owner.
      if (!data.items.some(({ id, label }) => [id, label.toLowerCase()].includes(query.trim().toLowerCase()))) {
        Object.assign(data, await reviewedHelp(query));
      }
      if (data.help) data.answeredBy = 'reviewed-help';
      if (!data.help && !data.items.length) data.status = data.candidates?.length ? 'clarification' : 'empty';
    } else if (intent.kind === 'unsupported') {
      const help = {
        'change-basis': 'Git committer-date history is available. Ask for commits from YYYY-MM-DD to YYYY-MM-DD on a branch. Authored, integrated, merged PR and deployed activity require their own evidence.',
        'knowledge-time': 'Retained history can show the recorded state as of a date. It cannot establish what was known at that time.',
        task: 'Ask SFlow answers questions. Use Start a Task to request new work.'
      };
      data.diagnostics = [finding('ASK_PREDICATE_UNSUPPORTED', help[intent.feature], 'unsupported')];
    } else if (!root) {
      data.diagnostics = [finding('ASK_REPOSITORY_REQUIRED', 'Open the checkout whose work or specification you want to read.')];
    } else if (['continuation', 'commits', 'comparison', 'work-history'].includes(intent.kind)) {
      const { readAskHistory } = await import('./history.mjs');
      Object.assign(data, await readAskHistory({ root, context, audience, intent, cursor }));
    } else if (intent.kind === 'spec') {
      const { readPublishedSpecification } = await import('../spec-library/library.mjs');
      data.specifications = [specificationResult(await readPublishedSpecification(root, intent.reference))];
    } else {
      const { work, matches, diagnostics } = await currentWork(root, { ...context, ...effectiveScope }, intent);
      data.diagnostics = diagnostics;
      if (matches.length) data.choices = matches;
      if (work) {
        data.work = workResult(work);
        data.observedAt = new Date().toISOString();
        if (intent.kind === 'story-spec') {
          if (!work.specification.length) {
            data.diagnostics.push(finding('ASK_SPEC_PIN_ABSENT', 'This Story has no published specification attached.', 'absent'));
          } else {
            const { readPublishedSpecification } = await import('../spec-library/library.mjs');
            data.specifications = [];
            for (const pin of work.specification.slice(0, 8)) {
              try { data.specifications.push(specificationResult(await readPublishedSpecification(root, pin.reference, { pin }))); }
              catch (error) { data.diagnostics.push(ownerFinding(error)); }
            }
            if (work.specification.length > 8) data.diagnostics.push(finding('ASK_BUDGET_EXHAUSTED', 'Open a specification by ID to inspect attachments beyond the first eight.'));
          }
        }
      }
    }
  } catch (error) {
    data.diagnostics.push(ownerFinding(error));
  }
  if (!data.coverage && data.diagnostics.length) {
    const category = data.diagnostics[0].category;
    data.status = data.choices?.length || category === 'clarification' ? 'clarification'
      : data.work || data.specifications?.length ? 'partial' : category === 'absent' ? 'empty' : 'unavailable';
  }
  data.resultSetId = 'ask-' + hash([
    query, effectiveScope, data.items, data.work, data.specifications, data.help?.handle, data.history, data.comparison
  ]).slice(0, 32);
  if (audience !== 'person') {
    const { withholdForModel } = await import('../spec-library/share-check.mjs');
    return withholdForModel(data).value;
  }
  return data;
}

/** The existing Copilot gateway reads the same data through its closed tool resolver. */
export async function askGatewayRead(request) {
  const data = await readAsk({ ...request, audience: 'model' });
  return sflowResult({
    kind: 'read',
    operation: { id: 'ask.lookup', classification: 'read' },
    subject: request.subject,
    outcome: { status: 'succeeded', messageId: 'gateway.read', slots: {} },
    effects: noEffects(),
    restState: 'informational',
    data
  });
}

/** A fresh owner read for an exact reference. Person and model projections are kept distinct. */
export async function openAskSpecification(root, reference, { pin = null, audience = 'model' } = {}) {
  const { readPublishedSpecification } = await import('../spec-library/library.mjs');
  const read = await readPublishedSpecification(root, reference, { pin });
  const value = { ...specificationResult(read), content: read.spec };
  if (audience === 'person') return value;
  const { withholdForModel } = await import('../spec-library/share-check.mjs');
  return withholdForModel(value).value;
}
