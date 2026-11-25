import { createHash, randomUUID } from 'node:crypto';
import { conversationStore } from './conversation-store.mjs';
import { linkedSpecifications, readEvidence, referencesFor } from './evidence.mjs';
import { askIntent } from './query.mjs';
import { readAsk } from './read.mjs';
import { askTimeWindow } from './time-window.mjs';
import { withholdForModel } from '../spec-library/share-check.mjs';
import { SingularityFlowError } from '../util.mjs';

const MAX_READS = 24;
const saveError = (code, message) => new SingularityFlowError(message, { code });
const invalid = message => saveError('ASK_CONVERSATION_REQUEST_INVALID', message);
const lost = () => saveError('ASK_SELECTION_UNAVAILABLE', 'Choose an item from the saved answer or ask a new question.');
const ordinal = value => /^\d+$/u.test(value) ? Number(value) : ['first', 'second', 'third', 'fourth', 'fifth'].indexOf(value) + 1;

// Only typed filters, immutable references, positions and counters reach the store.
function retainedResult(value, history, queryKind) {
  const refs = referencesFor(value);
  const choices = value.choices?.map(({ id, kind }, index) => ({ id, kind, key: 'choice-' + (index + 1) }))
    ?? value.candidates?.map(({ id }, index) => ({ id, kind: 'help', key: 'choice-' + (index + 1) })) ?? [];
  return { id: value.resultSetId, refs, history, pending: choices.length ? { kind: queryKind, choices } : null };
}

function meta(record) {
  return {
    id: record.id, revision: record.revision, resultSetId: record.result.id, selectedId: record.selected?.id ?? null,
    private: true, portability: 'local', hasMore: Boolean(record.result.history?.next),
    canExplain: record.result.refs.length > 0 && !record.explanationUsed && record.reads < MAX_READS,
    reads: { used: record.reads, limit: MAX_READS },
    ...(record.taskAdmissionId ? { taskAdmissionId: record.taskAdmissionId } : {})
  };
}

function present(value, record) {
  value.capability = 'ask-r3';
  value.conversation = meta(record);
  value.resultSetId = record.result.id ?? value.resultSetId;
  // R3 uses the durable page checkpoint. The R2 token remains available on stateless requests.
  delete value.continuation;
  const { refs, pending } = record.result;
  value.links = refs.map(({ id }) => id);
  if (pending) {
    for (const item of [...(value.choices ?? []), ...(value.candidates ?? [])]) {
      const choice = pending.choices.find(entry => entry.id === item.id && (!item.kind || entry.kind === item.kind));
      if (choice) item.selection = choice.key;
    }
  }
  return value;
}

const answer = (kind, data = {}) => ({ kind, answeredBy: 'deterministic', status: 'resolved', items: [], diagnostics: [], ...data });
const diagnostic = (code, message, category = 'unavailable') => ({ code, message, category });

async function lookup(scope, query, options = {}) {
  let history = null;
  const value = await readAsk({ ...scope, arguments: { query, ...(options.workId ? { workId: options.workId } : {}) },
    historyReplay: options.replay, internal: true, captureHistory: plan => { history = plan; } });
  return { value, result: retainedResult(value, history, askIntent(query, options.workId).kind) };
}

function choiceQuestion(choice, pending) {
  if (choice.kind === 'help') return choice.id;
  return pending.kind === 'story-spec' ? 'spec used for story ' + choice.id : choice.kind + ' ' + choice.id;
}

function findLink(record, id) {
  const link = record.result.refs.find(item => item.id === id) ?? (record.selected?.id === id ? record.selected : null);
  if (!link) throw lost();
  return link;
}

function checkBudget(record) {
  if (record.reads >= MAX_READS) throw saveError('ASK_CONVERSATION_READ_LIMIT', 'This question reached its saved read limit. Submit a new question to continue.');
}

async function restore(scope, record) {
  const { refs, history, pending } = record.result;
  if (history) {
    const verified = await lookup(scope, 'saved history', { replay: { ...history, next: history.start } });
    if (JSON.stringify(refs.map(link => link.id)) === JSON.stringify(verified.result.refs.map(link => link.id))) return verified.value;
    return answer('resume', { status: 'unavailable', diagnostics: [
      diagnostic('ASK_SAVED_RESULTS_CHANGED', 'The saved results could not be verified in their original order. Choose a saved evidence link or start a new search.')
    ] });
  }
  if (pending) {
    return answer('resume', { status: 'clarification',
      choices: pending.choices.filter(choice => choice.kind !== 'help').map(({ id, kind }) => ({ id, kind })),
      candidates: pending.choices.filter(choice => choice.kind === 'help').map(({ id }) => ({ id, title: id })),
      diagnostics: [diagnostic('ASK_CHOICE_REQUIRED', 'Choose one of the saved options to continue.', 'clarification')]
    });
  }
  const data = answer('resume');
  for (const [index, link] of refs.entries()) {
    const ref = link.ref;
    try {
      if (ref.kind === 'work') {
        const refreshed = await readAsk({ ...scope, internal: true, arguments: { query: ref.workKind + ' ' + ref.workId } });
        if (refreshed.work?.id !== ref.workId || refreshed.work.kind !== ref.workKind) throw lost();
        data.work = refreshed.work;
        if (data.work.recordCommit === ref.commit && data.work.recordPath === ref.path && data.work.recordSha256 === ref.sha256) {
          data.work.evidenceId = link.id;
        }
        data.observedAt = refreshed.observedAt;
      } else {
        const evidence = await readEvidence(scope.root, link, { audience: scope.audience, detail: false });
        if (evidence.specification) (data.specifications ??= []).push({ ...evidence.specification, evidenceId: link.id });
        if (evidence.help) data.help = { ...evidence.help, evidenceId: link.id };
      }
    } catch (error) {
      data.diagnostics.push(diagnostic(error.code ?? 'ASK_EVIDENCE_UNAVAILABLE', 'Saved result ' + (index + 1) + ' is unavailable.'));
    }
  }
  if (data.diagnostics.length) data.status = data.work || data.specifications?.length || data.help ? 'partial' : 'unavailable';
  if (!refs.length) data.diagnostics.push(diagnostic('ASK_NO_SAVED_SOURCE', 'Enter a question to continue this conversation.'));
  return data;
}

function followUp(record, request) {
  if (request.sessionAction === 'select') return { action: 'select', id: request.target };
  if (request.sessionAction !== 'query') return { action: request.sessionAction, id: request.target };
  const text = request.query.toLowerCase().trim().replace(/[?.!]+$/u, '');
  const pos = /^(?:show |open )?(?:the )?(first|second|third|fourth|fifth|\d+)(?: result)?$/u.exec(text);
  if (pos) return { action: 'select', id: record.result.pending?.choices[ordinal(pos[1]) - 1]?.key ?? record.result.refs[ordinal(pos[1]) - 1]?.id };
  const related = /^(?:open|show) (?:the )?spec(?:ification)? (?:behind|for) (?:the )?(this work|that result|(?:first|second|third|fourth|fifth|\d+) (?:result|change))$/u.exec(text);
  if (related) {
    const position = ordinal(related[1].split(' ')[0]);
    return { action: 'linked-spec', id: position ? record.result.refs[position - 1]?.id : record.selected?.id };
  }
  if (/^(?:open |show )?(?:that|the|this) (?:spec|specification)$/u.test(text)) {
    const specs = record.result.refs.filter(item => item.ref.kind === 'spec');
    return { action: 'select', id: record.selected?.ref.kind === 'spec' ? record.selected.id : specs.length === 1 ? specs[0].id : null };
  }
  if (/^(?:show )?(?:those changes|these results|the same results)$/u.test(text)) return { action: 'resume' };
  if (/^(?:next page|more results)$/u.test(text)) return { action: 'next' };
  if (/^(?:also include|include) (?:the )?previous week$/u.test(text)) return { action: 'previous-week' };
  if (/^(?:what is )?(?:its|that work's) (?:status now|current status)$/u.test(text)) {
    const ref = record.selected?.ref;
    if (ref?.kind === 'work' || ref?.kind === 'event') return { action: 'query', query: ref.workKind + ' ' + ref.workId };
    throw lost();
  }
  if (/^(?:use|open|show) (?:the )?(?:newest|latest) (?:published )?(?:spec|specification|revision)$/u.test(text)) {
    const ref = record.selected?.ref;
    if (ref?.kind === 'spec') return { action: 'query', query: ref.reference.split('@')[0] };
    throw lost();
  }
  return { action: 'query', query: request.query, workId: request.workId };
}

function earlierWeek(history) {
  const { window, start } = history ?? {};
  if (!window?.startInclusive || !start) throw saveError('ASK_HISTORY_FILTER_UNAVAILABLE', 'Open a dated history result before extending its period.');
  const prior = new Date(Date.parse(window.startDate) - 7 * 86_400_000).toISOString().slice(0, 10);
  const expanded = askTimeWindow({ startDate: prior, endDate: window.endDate, timeZone: window.timeZone });
  expanded.anchorInstant = window.anchorInstant;
  const next = start.revision ? { revision: start.revision, offset: 0, retrieved: 0, shallow: start.shallow }
    : { snapshot: start.snapshot, namespace: start.namespace };
  return { intent: history.intent, next, window: expanded };
}

function validateSessionRequest(request, audience) {
  const { sessionAction: action, conversationId: id, contextRevision: rev, target, cursor, workId } = request;
  if (!['query', 'resume', 'select', 'evidence', 'forget', 'explain'].includes(action) || cursor ||
      (action !== 'query' && (workId || request.query !== action)) || (!!target !== ['evidence', 'select'].includes(action))) throw invalid('Choose one Ask conversation operation.');
  if ((id && !/^ask-[a-f0-9]{32}$/u.test(id)) || (!id && rev != null) ||
      (id && rev == null && action !== 'resume') || (!id && !['query', 'resume'].includes(action))) {
    throw invalid('Use the conversation ID and revision returned by Ask.');
  }
  if (action === 'forget' && audience !== 'person') throw invalid('Forget saved conversations from your own SFlow session.');
}

export async function askConversation({ root, context = {}, audience = 'model', arguments: request, allowModel = false }) {
  const scope = { root, context, audience };
  const requestId = randomUUID();
  const finish = value => {
    const response = { requestId, ...value };
    return audience === 'person' ? response : withholdForModel(response).value;
  };
  let record;
  try {
    validateSessionRequest(request, audience);
    const store = await conversationStore(scope);
    const { sessionAction, conversationId, contextRevision } = request;
    if (!conversationId && sessionAction === 'query') {
      const { value, result } = await lookup(scope, request.query, { workId: request.workId });
      record = await store.create({ result, reads: 1, explanationUsed: false, selected: result.refs.length === 1 ? result.refs[0] : null });
      return finish(present(value, record));
    }
    record = await store.read(conversationId, contextRevision);
    const { action, id, query, workId } = followUp(record, request);
    if (action === 'resume') {
      const restored = await restore(scope, record);
      if (audience === 'person' && record.taskAdmissionId) {
        const { inspectTaskAdmission } = await import('../task-admission.mjs');
        try {
          const task = await inspectTaskAdmission(root, record.taskAdmissionId);
          restored.task = { id: task.id, status: task.status, workId: task.workId };
        } catch (error) {
          restored.diagnostics.push(diagnostic(error.code ?? 'TASK_ADMISSION_UNAVAILABLE', 'The saved task handoff could not be inspected.'));
        }
      }
      await store.read(record.id, record.revision);
      return finish(present(restored, record));
    }
    if (action === 'forget') {
      await store.forget(record.id, record.revision);
      return finish(answer('forgotten'));
    }
    if (action === 'explain') {
      const { explainSavedResult } = await import('./explanation.mjs');
      return finish(await explainSavedResult(scope, record, store, { allowModel, restore, present }));
    }
    if (action !== 'query') checkBudget(record);
    const choice = action === 'select' ? record.result.pending?.choices.find(item => item.key === id) : null;
    if ((action === 'select' && !choice) || action === 'evidence') {
      const link = findLink(record, id);
      const evidence = await readEvidence(root, link, { audience, detail: action === 'evidence' || link.ref.kind === 'spec' });
      record = await store.update(record.id, record.revision, { selected: link, reads: record.reads + 1 });
      return finish(present(answer('evidence', { evidence }), record));
    }
    if (action === 'linked-spec') {
      const link = findLink(record, id);
      const value = answer('story-spec', { specifications: await linkedSpecifications(root, link, audience) });
      const result = retainedResult(value, null, 'story-spec');
      if (result.refs.length === 1) {
        const selected = result.refs[0];
        const evidence = await readEvidence(root, selected, { audience });
        record = await store.update(record.id, record.revision, { reads: record.reads + 1, selected });
        return finish(present(answer('evidence', { evidence }), record));
      }
      result.id = 'ask-' + createHash('sha256').update(JSON.stringify(result.refs)).digest('hex').slice(0, 32);
      record = await store.update(record.id, record.revision, { result, reads: record.reads + 1, selected: null });
      return finish(present(value, record));
    }
    let replay = null;
    if (action === 'next') {
      const history = record.result.history;
      if (!history?.next) throw saveError('ASK_NO_NEXT_PAGE', 'This saved result has no further page.');
      replay = history;
    } else if (action === 'previous-week') replay = earlierWeek(record.result.history);
    const next = await lookup(scope, choice ? choiceQuestion(choice, record.result.pending) : query ?? 'saved history', { replay, workId });
    if (replay && next.value.status === 'unavailable') return finish(present(next.value, record));
    const fields = { result: next.result, reads: replay ? record.reads + 1 : 1,
      explanationUsed: replay ? record.explanationUsed : false,
      selected: replay ? record.selected : next.result.refs.length === 1 ? next.result.refs[0] : null };
    record = await store.update(record.id, record.revision, fields);
    return finish(present(next.value, record));
  } catch (error) {
    const conflict = error.code === 'ASK_CONVERSATION_CONFLICT';
    const value = answer('conversation', { status: conflict ? 'conflict' : 'unavailable',
      diagnostics: [diagnostic(error.code ?? 'ASK_CONVERSATION_UNAVAILABLE',
        error.code?.startsWith('ASK_') ? error.message : 'The saved source could not be reauthorized.', conflict ? 'conflict' : 'unavailable')],
      ...(conflict ? { currentConversation: error.details } : {}) });
    if (record && !conflict) value.conversation = meta(record);
    return finish(value);
  }
}
