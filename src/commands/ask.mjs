import { operationContext } from '../operation-context.mjs';
import { optionBoolean, SingularityFlowError } from '../util.mjs';
import { ASK_HINT, askSuggestions } from '../ask/navigation.mjs';
import { askIntent } from '../ask/query.mjs';

const OPTIONS = new Set(['json', 'for-agent', 'for-person', 'model', 'suggest', 'open-spec', 'manifest-sha256', 'state-commit', 'work-id', 'question', 'timings']);
const invalid = (message, code = 'ASK_REQUEST_INVALID') => { throw new SingularityFlowError(message, { code }); };

export function validateAskCliRequest(positionals, options) {
  for (const [flag, value] of Object.entries(options)) {
    if (!OPTIONS.has(flag) || Array.isArray(value)) invalid('Use one value for each supported Ask SFlow option. See singularity-flow ask --help.');
    const boolean = !['manifest-sha256', 'state-commit', 'work-id', 'question'].includes(flag);
    if (boolean && typeof value !== 'boolean') invalid('Use Ask SFlow switches without a value.');
  }
  if (options['for-agent'] !== undefined && options['for-person'] !== undefined) {
    invalid('Use the specification’s model-safe view in chat, or open it in your own viewer.', 'ASK_AUDIENCE_DENIED');
  }
  const question = options.question;
  if (question !== undefined && (typeof question !== 'string' || positionals.length > 1)) invalid('Provide one question.');
  const query = (question ?? positionals.slice(1).join(' ')).trim();
  const { 'open-spec': open, 'work-id': workId, 'state-commit': stateCommit, 'manifest-sha256': manifestSha256, suggest } = options;
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
  if (!suggest && workId !== undefined && !['work', 'story-spec'].includes(intent.kind)) invalid('--work-id applies to a work question.');
  if (workId !== undefined && intent.workId?.toLowerCase() !== workId.toLowerCase()) invalid('Name one work ID per Ask SFlow query.');
  return { query: query || (workId ? 'current work' : ''), workId, suggest, open, intent, pin, repository: !suggest && ['work', 'story-spec', 'spec'].includes(intent.kind) };
}

function renderText(data) {
  const lines = [];
  if (data.effectiveScope?.repositoryId) lines.push('Repository: ' + data.effectiveScope.repositoryId);
  if (data.work) {
    const work = data.work;
    lines.push(work.id + ' — ' + work.title);
    lines.push([work.phaseLabel, work.status ?? work.workStatus].filter(Boolean).join(' · '));
    if (work.blockers.length) lines.push('Blockers', ...work.blockers.map(value => '- ' + value.replaceAll('-', ' ')));
  }
  for (const item of data.specifications ?? []) {
    lines.push(item.reference + ' — ' + item.title + ' (' + item.reviewState + ')',
      'Read: singularity-flow ask ' + item.reference + ' --open-spec --for-person --state-commit=' + item.stateCommit + ' --manifest-sha256=' + item.manifestSha256);
  }
  if (data.help) lines.push(data.help.text, data.help.citation,
    ...(data.help.truncated ? ['Full topic: singularity-flow show ' + data.help.handle] : []));
  for (const item of data.items ?? []) lines.push(item.label + ' — ' + item.detail);
  for (const option of data.choices ?? []) lines.push('Choose: ' + option.kind + ' ' + option.id);
  if (!data.help && data.candidates?.length) lines.push('Related help: ' + data.candidates.map(item => item.id).join(', '));
  for (const diagnostic of data.diagnostics ?? []) lines.push(diagnostic.message);
  return lines.filter(Boolean).join('\n') || ASK_HINT + '.';
}

export async function run(_argv, { positionals, options }) {
  const request = validateAskCliRequest(positionals, options);
  const root = operationContext()?.root ?? null;
  const audience = options['for-person'] === true ? 'person' : 'model';
  let value;
  if (request.suggest || !request.query) {
    const items = askSuggestions(request.query).map(({ id, label, detail, topic }) => ({ id, label, detail, topic }));
    value = { kind: 'suggestions', status: items.length ? 'resolved' : 'empty', items };
  } else if (request.open) {
    if (!root) invalid('Open the checkout containing this published specification.', 'ASK_REPOSITORY_REQUIRED');
    const { openAskSpecification } = await import('../ask/read.mjs');
    const artifact = await openAskSpecification(root, request.intent.reference, { pin: request.pin, audience });
    if (!optionBoolean(options, 'json')) return process.stdout.write(artifact.content);
    value = { kind: 'artifact', status: 'resolved', artifact };
  } else {
    const { readAsk } = await import('../ask/read.mjs');
    value = await readAsk({ root, audience, arguments: {
      query: request.query, ...(request.workId ? { workId: request.workId } : {})
    } });
  }
  if (optionBoolean(options, 'json')) console.log(JSON.stringify({ schemaVersion: 1, resultType: 'sflow-ask', ...value })); // schema-transient: ASK response
  else console.log(renderText(value));
}
