import path from 'node:path';
import { operationContext } from '../operation-context.mjs';
import { optionBoolean, SingularityFlowError } from '../util.mjs';
import { ASK_HINT, askSuggestions } from '../ask/navigation.mjs';
import { askIntent, askNeedsRepository } from '../ask/query.mjs';
import { askHistoryDisplay } from '../ask/history-display.mjs';

const SESSION_FLAGS = ['remember', 'resume', 'conversation', 'revision', 'select', 'evidence', 'forget', 'explain', 'portable'];
const VALUE_FLAGS = ['manifest-sha256', 'state-commit', 'work-id', 'question', 'cursor', 'conversation', 'revision', 'select', 'evidence'];
const OPTIONS = new Set(['json', 'for-agent', 'for-person', 'model', 'suggest', 'open-spec', 'timings', 'all', ...VALUE_FLAGS, ...SESSION_FLAGS]);
const invalid = (message, code = 'ASK_REQUEST_INVALID') => { throw new SingularityFlowError(message, { code }); };

export function validateAskCliRequest(positionals, options) {
  if (positionals[1] === 'provider' && positionals[2] === 'serve') {
    if (positionals.length !== 3 || typeof options.config !== 'string' || !options.config ||
        Object.keys(options).some(flag => !['config', 'json'].includes(flag))) {
      invalid('Use singularity-flow ask provider serve --config FILE from your own terminal.');
    }
    return { providerConfiguration: options.config, repository: false };
  }
  if (positionals[1] === 'file' && options.ref !== undefined) {
    const { ref, path: file } = options;
    if (positionals.length !== 2 || options['for-person'] !== true || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(ref ?? '') ||
        typeof file !== 'string' || file.length > 1000 || /[\x00-\x1f\x7f\\]/u.test(file) ||
        file.split('/').some(part => ['', '.', '..'].includes(part)) ||
        Object.keys(options).some(flag => !['ref', 'path', 'for-person', 'json', 'model', 'timings'].includes(flag))) {
      invalid('Open the file returned by a workspace search.');
    }
    return { file, ref, repository: true };
  }
  if (positionals[1] === 'chat' && options['query-stdin'] !== undefined) {
    if (positionals.length !== 2 || options['query-stdin'] !== true || options['for-person'] !== true ||
        Object.keys(options).some(flag => !['query-stdin', 'for-person', 'json', 'model', 'timings'].includes(flag))) {
      invalid('Open Chat in your browser workspace.', 'ASK_AUDIENCE_DENIED');
    }
    return { chat: true, repository: true };
  }
  for (const [flag, value] of Object.entries(options)) {
    if (!OPTIONS.has(flag) || Array.isArray(value)) invalid('Use one value for each supported Ask SFlow option. See singularity-flow ask --help.');
    const boolean = !VALUE_FLAGS.includes(flag);
    if (boolean && typeof value !== 'boolean') invalid('Use Ask SFlow switches without a value.');
  }
  if (options['for-agent'] !== undefined && options['for-person'] !== undefined) {
    invalid('Use the specification’s model-safe view in chat, or open it in your own viewer.', 'ASK_AUDIENCE_DENIED');
  }
  if (options.all !== undefined && (options.all !== true || options['for-person'] !== true)) {
    invalid('Use workspace search from your own Ask SFlow view.', 'ASK_AUDIENCE_DENIED');
  }
  const workspaceSearch = options.all === true;
  const question = options.question;
  if (question !== undefined && (typeof question !== 'string' || positionals.length > 1)) invalid('Provide one question.');
  const query = (question ?? positionals.slice(1).join(' ')).trim();
  const { 'open-spec': open, 'work-id': workId, 'state-commit': stateCommit, 'manifest-sha256': manifestSha256, suggest } = options;
  const cursor = options.cursor;
  if (SESSION_FLAGS.some(flag => options[flag] !== undefined)) {
    if (['remember', 'resume', 'forget', 'explain', 'portable'].some(flag => options[flag] === false)) {
      invalid('Use an explicit Ask action without a negated flag.');
    }
    if (suggest || open || cursor !== undefined || stateCommit !== undefined || manifestSha256 !== undefined) {
      invalid('Use a conversation action on its own.');
    }
    const choices = ['resume', 'select', 'evidence', 'forget', 'explain'].filter(flag => options[flag] !== undefined);
    if (choices.length > 1 || (choices.length && (query || workId || options.remember !== undefined))) invalid('Choose one Ask conversation action.');
    const sessionAction = choices[0] ?? 'query';
    const conversationId = options.conversation;
    const contextRevision = options.revision === undefined ? undefined : Number(options.revision);
    if ((conversationId !== undefined && (typeof conversationId !== 'string' || !/^askp?-[a-f0-9]{32}$/u.test(conversationId))) ||
        (options.revision !== undefined && (typeof options.revision !== 'string' || !/^[1-9][0-9]*$/u.test(options.revision)
          || !Number.isSafeInteger(contextRevision)))) invalid('Use the conversation ID and revision returned by Ask.');
    const portable = options.portable === true || conversationId?.startsWith('askp-') === true;
    if (portable && options['for-person'] !== true) invalid('Shared Ask conversations require your own viewer or terminal with --for-person.', 'ASK_AUDIENCE_DENIED');
    if (portable && conversationId && !conversationId.startsWith('askp-')) invalid('Use the shared conversation ID returned by Ask.');
    if ((sessionAction === 'query' && (!query || (!conversationId && options.remember !== true))) ||
        (conversationId && options.remember !== undefined)) invalid('Use --remember with a new question, or continue a saved conversation.');
    if (['forget', 'explain'].includes(sessionAction) && options['for-person'] !== true) {
      invalid('Use --for-person when requesting a Copilot explanation or deleting a local conversation.', 'ASK_AUDIENCE_DENIED');
    }
    const target = ['select', 'evidence'].includes(sessionAction) ? options[sessionAction] : undefined;
    if (target !== undefined && (typeof target !== 'string' || !/^(?:ev-[a-f0-9]{24}|choice-[1-3])$/u.test(target))) {
      invalid('Use an evidence or selection ID from the saved result.');
    }
    if (query.length > 2000 || (workId !== undefined && (typeof workId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(workId)))) {
      invalid('Enter a question of up to 2,000 characters and a valid work ID when needed.');
    }
    const request = { query: query || sessionAction, sessionAction, conversationId, contextRevision, target, workId };
    return { query: request.query, portable, workspaceSearch, session: Object.fromEntries(Object.entries(request).filter(([, value]) => value !== undefined)), repository: true };
  }
  if (cursor !== undefined) {
    if (typeof cursor !== 'string' || cursor.length > 3700 || query || open || suggest ||
        workId !== undefined || stateCommit !== undefined || manifestSha256 !== undefined) {
      invalid('Provide one Ask continuation without a new question or selection.');
    }
    return { query: 'continue', cursor, repository: true };
  }
  if (query.length > 2000) invalid('Keep Ask SFlow questions to 2,000 characters.');
  if (workId !== undefined && (typeof workId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(workId))) {
    invalid('Enter a Story or Initiative ID after --work-id.');
  }
  const intent = askIntent(query, workId);
  if (suggest && (open || workId !== undefined || stateCommit !== undefined || manifestSha256 !== undefined)) {
    invalid('Suggestions take only search text.');
  }
  if (open && (intent.kind !== 'spec' || workId !== undefined)) invalid('To open the artifact, enter a specification ID or SPEC-ID@N.');
  let pin = null;
  if (stateCommit !== undefined || manifestSha256 !== undefined) {
    if (!open || !intent.reference?.includes('@') ||
        typeof stateCommit !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(stateCommit)
        || typeof manifestSha256 !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(manifestSha256)) {
      invalid('Opening a recorded revision requires SPEC-ID@N, its state commit and its manifest digest.');
    }
    if (options['for-person'] !== true) invalid('Open a saved specification selection in your own viewer.', 'ASK_AUDIENCE_DENIED');
    pin = { stateCommit, manifestSha256 };
  }
  if (!suggest && workId !== undefined && !['work', 'story-spec', 'work-history'].includes(intent.kind)) invalid('--work-id applies to a work question.');
  if (workId !== undefined && intent.workId?.toLowerCase() !== workId.toLowerCase()) invalid('Name one work ID per Ask SFlow query.');
  return { query: query || (workId ? 'current work' : ''), workId, suggest, open, intent, pin, workspaceSearch, repository: !suggest && (workspaceSearch || askNeedsRepository(intent)) };
}

function renderText(data, audience) {
  if (data.kind === 'search-file' && data.file) return data.file.text;
  if (data.kind === 'chat') return data.answer ?? data.diagnostic?.message ?? ASK_HINT;
  if (data.kind === 'workspace-search') {
    return data.results.map(result => result.title + ' · ' + (result.subtitle ?? result.type)).join('\n') || 'No matching results.';
  }
  if (data.kind === 'forgotten') return 'Saved Ask conversation removed.';
  const lines = [];
  if (data.effectiveScope?.repositoryId) lines.push('Repository: ' + data.effectiveScope.repositoryId);
  if (data.work) {
    const work = data.work;
    lines.push(work.id + ' — ' + work.title);
    lines.push([work.phaseLabel, work.status ?? work.workStatus].filter(Boolean).join(' · '));
    if (work.blockers.length) lines.push('Blockers', ...work.blockers.map(value => '- ' + value.replaceAll('-', ' ')));
  }
  for (const item of data.specifications ?? []) {
    lines.push(item.reference + ' — ' + item.title + ' (' + item.reviewState + ')');
    if (!data.conversation) lines.push('Read: singularity-flow ask ' + item.reference + ' --open-spec --for-person --state-commit=' + item.stateCommit + ' --manifest-sha256=' + item.manifestSha256);
  }
  if (data.help) lines.push(data.help.text, data.help.citation,
    ...(data.help.truncated ? ['Full topic: singularity-flow show ' + data.help.handle] : []));
  for (const item of data.items ?? []) lines.push(item.label + ' — ' + item.detail);
  for (const option of data.choices ?? []) {
    if (!option.selection) lines.push('Choose: ' + option.kind + ' ' + option.id);
  }
  const related = data.candidates?.filter(item => !item.selection);
  if (!data.help && related?.length) lines.push('Related help: ' + related.map(item => item.id).join(', '));
  const display = askHistoryDisplay(data);
  if (display) {
    lines.push(display.title, ...display.summary, ...display.rows.map(row => '- ' + row.label + ' · ' + row.detail));
    if (display.patch?.text) lines.push(display.patch.text);
    else if (display.patch?.status === 'binary') lines.push('Binary files have no text patch.');
  }
  if (data.continuation) {
    const route = 'singularity-flow ask --cursor=' + data.continuation.cursor + (audience === 'person' ? ' --for-person' : '');
    lines.push((data.continuation.behavior === 'retry' ? 'Retry this page' : 'Read the next page') + ' · ' + route);
  }
  if (data.evidence) {
    const evidence = data.evidence;
    lines.push(evidence.title, [evidence.locator, evidence.revision].filter(Boolean).join(' · '));
    if (evidence.content) lines.push(evidence.content);
    else if (evidence.details) lines.push(...Object.entries(evidence.details).filter(([, value]) => value != null)
      .map(([key, value]) => key + ' · ' + value));
  }
  if (data.explanation) {
    lines.push(data.explanation.status === 'copilot-assisted' ? 'Copilot-organized explanation' : 'Explanation from recorded evidence',
      ...data.explanation.statements.map(item => '- ' + item.text + ' [' + item.evidenceId + ']'));
  }
  if (data.conversation) {
    const { id, revision, hasMore, selectedId } = data.conversation;
    const route = 'singularity-flow ask --conversation=' + id + ' --revision=' + revision + (audience === 'person' ? ' --for-person' : '');
    const links = data.links ?? [];
    lines.push((data.conversation.portability === 'shared-provider' ? 'Private conversation · Available across devices · ' : 'Private conversation · ') + id + ' · revision ' + revision);
    for (const [index, link] of links.entries()) {
      const row = data.savedResults?.[index];
      const label = row?.title ?? (row?.availability === 'local-only' ? 'Available on the original device' : row ? 'Unavailable here' : '');
      lines.push('Evidence ' + (index + 1) + (label ? ' · ' + label : '') + (row && row.availability !== 'available' ? '' : ' · ' + route + ' --evidence=' + link));
    }
    if (selectedId && !links.includes(selectedId)) lines.push('Selected evidence · ' + route + ' --evidence=' + selectedId);
    for (const item of [...(data.choices ?? []), ...(data.candidates ?? [])]) {
      if (item.selection) lines.push('Choose ' + (item.kind ? item.kind + ' ' : '') + item.id + ' · ' + route + ' --select=' + item.selection);
    }
    if (hasMore) lines.push('Next page · ' + route + ' "next page"');
    if (data.conversation.taskAdmissionId) {
      lines.push((data.task?.workId ? 'Task ' + data.task.workId : 'Saved task handoff') + ' · singularity-flow work handoff ' +
        data.conversation.taskAdmissionId + ' --for-person');
    }
  }
  if (data.currentConversation?.conversationId) {
    lines.push('Resume latest · singularity-flow ask --resume --conversation=' + data.currentConversation.conversationId +
      (audience === 'person' ? ' --for-person' : ''));
  }
  if (data.task?.workId && !data.task.id) lines.push('Task ' + data.task.workId + ' · ' + (data.task.workStatus ?? data.task.status));
  for (const diagnostic of data.diagnostics ?? []) lines.push(diagnostic.message);
  return lines.filter(Boolean).join('\n') || ASK_HINT + '.';
}

export async function run(_argv, { positionals, options }) {
  const request = validateAskCliRequest(positionals, options);
  if (request.providerConfiguration) {
    const { serveAskProvider } = await import('../ask/shared-provider-server.mjs');
    const service = await serveAskProvider(path.resolve(request.providerConfiguration));
    const close = () => { void service.close(); };
    process.once('SIGTERM', close);
    process.once('SIGINT', close);
    try {
      const ready = { resultType: 'sflow-ask-provider', status: 'ready', name: service.name, port: service.port, tls: service.tls };
      console.log(optionBoolean(options, 'json') ? JSON.stringify(ready) : 'Ask provider ' + ready.name + ' listening on port ' + ready.port + '.');
      await service.done;
    } finally {
      process.removeListener('SIGTERM', close);
      process.removeListener('SIGINT', close);
    }
    return;
  }
  const root = operationContext()?.root ?? null;
  const audience = options['for-person'] === true ? 'person' : 'model';
  let value;
  if (request.chat) {
    const { readChatInput, answerChat } = await import('../ask/chat.mjs');
    value = await answerChat(root, await readChatInput());
  } else if (request.file) {
    const { openWorkspaceSearchFile } = await import('../ask/workspace-search.mjs');
    value = await openWorkspaceSearchFile(root, request.ref, request.file);
  } else if (request.suggest || !request.query) {
    const items = askSuggestions(request.query).map(({ id, label, detail, topic }) => ({ id, label, detail, topic }));
    value = { kind: 'suggestions', status: items.length ? 'resolved' : 'empty', items };
  } else if (request.session) {
    const { askConversation } = await import('../ask/conversation.mjs');
    const { validateArguments } = await import('../gateway/argument-schemas.mjs');
    value = await askConversation({ root, audience, portable: request.portable, workspaceSearch: request.workspaceSearch, allowModel: request.session.sessionAction === 'explain',
      arguments: validateArguments('ask-query-v1', request.session) });
  } else if (request.open) {
    if (!root) invalid('Open the checkout containing this published specification.', 'ASK_REPOSITORY_REQUIRED');
    const { openAskSpecification } = await import('../ask/read.mjs');
    const artifact = await openAskSpecification(root, request.intent.reference, { pin: request.pin, audience });
    if (!optionBoolean(options, 'json')) return process.stdout.write(artifact.content);
    value = { kind: 'artifact', status: 'resolved', artifact };
  } else {
    const { readAsk } = await import('../ask/read.mjs');
    value = await readAsk({ root, audience, arguments: {
      query: request.query, ...(request.workId ? { workId: request.workId } : {}), ...(request.cursor ? { cursor: request.cursor } : {})
    } });
    if (request.workspaceSearch) {
      const { workspaceSearchFallback } = await import('../ask/workspace-search.mjs');
      value = await workspaceSearchFallback(root, request.query, value) ?? value;
    }
  }
  if (optionBoolean(options, 'json')) console.log(JSON.stringify({ schemaVersion: 1, resultType: 'sflow-ask', ...value })); // schema-transient: ASK response
  else console.log(renderText(value, audience));
}
