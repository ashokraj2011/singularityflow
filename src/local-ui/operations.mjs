/**
 * Browser transport adapter, not another engine. Closed inputs become canonical CLI operations.
 * Sync/global CLI owners execute in bounded children, never in the HTTP host. Eligible reads use
 * the existing private read worker. Child creation here is transport isolation, not code execution.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { readWithWorker, invalidateReadWorkers, disposeReadWorkers } from '../read-worker-client.mjs';
import { cliPath } from './private-state.mjs';
import { MAX_REPLY, UiError, insist, record, text, identifier } from './contracts.mjs';

export { disposeReadWorkers };
const reads = {
  about: () => ['about'],
  'workspace.list': () => ['workspace', 'list'],
  'story.list': () => ['workspace', 'stories'],
  'repository.read': () => ['snapshot', '--include', 'repository'],
  'story.read': input => ['snapshot', ...(input.workId ? [`--work-id=${identifier(input.workId, 'Story ID')}`] : [])],
  'spec.list': () => ['spec', 'author', 'list', '--local', '--for-person'],
  'spec.read': input => ['spec', 'author', 'status', identifier(input.specId, 'Specification ID'), '--quick', '--for-person',
    ...(input.operationId ? [`--operation-id=${identifier(input.operationId, 'Save operation ID')}`] : [])],
  'spec.show': input => ['spec', 'author', 'show', identifier(input.specId, 'Specification ID'), '--local', '--for-person'],
  'spec.check': input => ['spec', 'author', 'check', identifier(input.specId, 'Specification ID'), '--for-person'],
  'spec.history': input => ['spec', 'author', 'history', identifier(input.specId, 'Specification ID'), '--for-person'],
  'spec.sources': input => ['spec', 'author', 'sources', identifier(input.specId, 'Specification ID'), '--for-person'],
  'spec.source.read': input => ['spec', 'author', 'sources', identifier(input.specId, 'Specification ID'), `--source=${identifier(input.sourceId, 'Source ID')}`, '--for-person'],
  'spec.gaps': input => ['spec', 'author', 'gaps', identifier(input.specId, 'Specification ID'), '--for-person'],
  'workflow.list': () => ['workflow', 'list'],
  'agent.list': () => ['agents', 'list'],
  'skill.list': () => ['skill', 'list'],
  'instruction.list': () => ['instruction', 'list'],
  'code.changes': () => ['explain', 'code', '--code-map=changes'],
  'code.repository': input => ['explain', 'code', '--code-map=repository',
    ...(input.scope == null ? [] : [`--path=${text(input.scope, 'Repository path', 1000)}`])],
  'decision.list': input => ['decisions', ...(input.workId ? [identifier(input.workId, 'Story ID')] : [])],
  'app.plan': () => ['app', 'plan'],
  'app.status': () => ['app', 'status'],
  'tests.plan': () => ['tests', 'plan'],
  'tests.summary': () => ['tests', 'summary']
};
const fields = {
  'story.read': ['workId'], 'decision.list': ['workId'],
  'code.repository': ['scope'],
  ...Object.fromEntries(['read', 'show', 'check', 'history', 'sources', 'gaps'].map(name => [`spec.${name}`, ['specId']])),
  'spec.read': ['specId', 'operationId'],
  'spec.create': ['title', 'intent', 'kind'], 'spec.save': ['specId', 'sequence', 'content', 'title', 'kind'],
  'spec.fork': ['specId', 'content'],
  'spec.source.read': ['specId', 'sourceId'], 'spec.source.add': ['specId', 'name', 'data', 'restore'],
  'spec.source.link': ['specId', 'url']
};
const writes = new Set(['spec.create', 'spec.save', 'spec.fork', 'spec.source.add', 'spec.source.link']);
export function operationShape(operation, input) {
  insist(Object.hasOwn(reads, operation) || writes.has(operation),
    'UI_OPERATION_UNSUPPORTED', 'This operation is not available in the browser. Use its existing SFlow surface.');
  record(input, fields[operation] ?? []);
  // Validation runs before admission, including every read operand.
  if (Object.hasOwn(reads, operation)) reads[operation](input);
  if (operation === 'spec.create') {
    text(input.title, 'Title', 240); text(input.intent, 'Idea', 20000, true);
    insist(['business', 'technical'].includes(input.kind), 'UI_REQUEST_INVALID', 'Choose a business or technical specification.');
  }
  if (operation === 'spec.save') {
    identifier(input.specId, 'Specification ID');
    insist(Number.isSafeInteger(input.sequence) && input.sequence >= 1, 'UI_REQUEST_INVALID', 'A draft sequence is required.');
    text(input.content, 'Specification', 1024 * 1024); text(input.title, 'Title', 240, true);
    insist(input.kind == null || ['business', 'technical'].includes(input.kind), 'UI_REQUEST_INVALID', 'Unknown specification kind.');
  }
  if (operation === 'spec.fork') { identifier(input.specId, 'Specification ID'); text(input.content, 'Specification', 256 * 1024); }
  if (operation === 'spec.source.add') {
    identifier(input.specId, 'Specification ID'); text(input.name, 'File name', 240); text(input.data, 'File bytes', 7 * 1024 * 1024);
    insist(path.basename(input.name) === input.name && !/[\\/\x00-\x1f]/u.test(input.name) && !['.', '..'].includes(input.name), 'UI_REQUEST_INVALID', 'Use the file name without directories.');
    const bytes = Buffer.from(input.data, 'base64');
    insist(bytes.length <= 5 * 1024 * 1024 && bytes.toString('base64') === input.data,
      'UI_UPLOAD_INVALID', 'Choose a correctly encoded file up to 5 MiB.');
    if (input.restore) identifier(input.restore, 'Original source ID');
  }
  if (operation === 'spec.source.link') {
    identifier(input.specId, 'Specification ID'); text(input.url, 'Source URL', 2048);
    let link = null;
    try { link = new URL(input.url); } catch { /* refused below */ }
    insist(['http:', 'https:'].includes(link?.protocol), 'UI_REQUEST_INVALID', 'Use a complete http or https link.');
  }
  return { mutation: writes.has(operation), machine: ['about', 'workspace.list', 'story.list'].includes(operation) };
}

// Loaded with the first canonical run only: the HTTP host and its reads never import diagnostics.
let redaction = null;
const redactor = async () => (redaction ??= import('../git-remote-diagnostics.mjs')).then(module => module.redactDiagnosticText);
/** Every string in a canonical answer kept for the browser or a receipt, with credential material removed. */
function redactedValue(value, redact, depth = 0) {
  if (typeof value === 'string') return redact(value, { multiline: true });
  if (!value || typeof value !== 'object' || depth > 12) return value;
  if (Array.isArray(value)) return value.map(item => redactedValue(item, redact, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactedValue(item, redact, depth + 1)]));
}

/**
 * No shell, repository executable, model invocation, or caller-provided argv. The explicit context comes
 * first and every browser value is one `--name=value` word, so no value can end the options (`--`) or
 * name another root. Diagnostics, original errors and progress are redacted before anyone keeps them.
 */
export async function runCanonical(root, args, { signal, timeoutMs = 300_000, onProgress = () => {}, environment = process.env, machine = false, personAskExplanation = false } = {}) {
  const started = performance.now();
  const redact = await redactor();
  const argv = [...(machine ? [] : [`--context-root=${root}`]), ...args];
  return new Promise((resolve, reject) => {
    let bytes = 0, stdout = '', stderr = '', deadline = false, tooLarge = false, settled = false;
    const askExplanation = personAskExplanation && args[0] === 'ask' && args.includes('--explain') && args.includes('--for-person');
    const env = { ...environment, ELECTRON_RUN_AS_NODE: '1', ...(askExplanation ? {} : { SINGULARITY_FLOW_NO_MODEL: '1' }) };
    if (machine) delete env.SINGULARITY_FLOW_SURFACE_CONTEXT;
    else env.SINGULARITY_FLOW_SURFACE_CONTEXT = JSON.stringify({ schemaVersion: 1, repositoryPath: root }); // schema-transient: canonical process selector
    const child = spawn(process.execPath, [cliPath, ...argv, '--json', ...(askExplanation ? [] : ['--no-model'])], {
      cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env
    });
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
    const abort = () => { child.kill(); };
    const timer = setTimeout(() => { deadline = true; child.kill(); }, timeoutMs);
    timer.unref?.();
    const collect = stream => chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_REPLY) { tooLarge = true; child.kill(); return; }
      if (stream === 'stdout') stdout += chunk.toString();
      else { stderr += chunk.toString(); onProgress({ stage: 'operation', message: redact(chunk.toString().slice(-2048), { multiline: true }) }); }
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'));
    child.once('error', error => finish(new UiError(error.code ?? 'UI_PROCESS_START_FAILED', redact(error.message), { stage: 'canonical-cli', cause: redact(error.message) }, 502)));
    child.once('close', (exitCode, termSignal) => {
      let result = null;
      if (stdout.trim()) try { result = JSON.parse(stdout); } catch { /* Preserve the exact non-JSON diagnostic below. */ }
      const kept = { exitCode, signal: termSignal, original: redactedValue(result, redact), stderr: redact(stderr, { multiline: true }),
        stdout: result ? null : redact(stdout, { multiline: true }) };
      if (deadline || tooLarge || signal?.aborted) return finish(new UiError(deadline ? 'UI_OPERATION_TIMEOUT' : tooLarge ? 'UI_REPLY_TOO_LARGE' : 'UI_WAIT_CANCELLED',
        deadline ? 'The SFlow operation exceeded its deadline. Its effect must be inspected before retrying a write.'
          : tooLarge ? 'The SFlow response exceeded the browser limit.' : 'The wait ended; inspect the original operation before retrying a write.',
        { stage: 'canonical-cli', timeoutMs, ...kept }, 504));
      if (exitCode !== 0 || result?.error || result?.resultType === 'sflow-refusal-plan') {
        const original = result?.error;
        const error = new UiError(original?.code ?? 'UI_OPERATION_FAILED', redact(original?.message || stderr.trim() || 'SFlow refused the operation.', { multiline: true }),
          { stage: 'canonical-cli', ...kept }, 422);
        // Only SFlow's own JSON answer says what happened. A child killed by a signal, with no exit code or
        // without a JSON reply may have written before it stopped: a write's outcome is then unknown.
        if (termSignal != null || exitCode == null || result == null) error.outcomeUnknown = true;
        return finish(error);
      }
      if (result == null) return finish(new UiError('UI_RESULT_INVALID', 'SFlow did not return a JSON result.', { stdout: kept.stdout, stderr: kept.stderr, exitCode }, 502));
      finish(null, { value: result, transport: 'canonical-cli', durationMs: performance.now() - started, ...(stderr ? { diagnostics: kept.stderr } : {}) });
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export async function executeOperation({ operation, input, root, invocationId, directory, signal, onProgress, environment = process.env }) {
  const shape = operationShape(operation, input);
  let args = reads[operation]?.(input), temporary = null;
  try {
    // Each browser value is one `--name=value` word: a title of `--` or `--context-root=…` stays a title.
    if (operation === 'spec.create') args = ['spec', 'author', 'new', `--title=${input.title}`, `--kind=${input.kind}`,
      ...(input.intent ? [`--intent=${input.intent}`] : []), `--operation-id=lws-${invocationId}`, '--for-person'];
    if (['spec.save', 'spec.fork'].includes(operation)) {
      // Bytes never enter a shell or Git; the existing draft owner imports this private staged file.
      temporary = await mkdtemp(path.join(directory, 'save-'));
      const file = path.join(temporary, 'wording.md');
      await writeFile(file, input.content, { mode: 0o600 });
      args = ['spec', 'author', operation === 'spec.fork' ? 'fork' : 'edit', input.specId,
        ...(operation === 'spec.save' ? [`--expected-seq=${input.sequence}`] : []), `--file=${file}`,
        `--operation-id=lws-${invocationId}`, '--for-person', ...(input.title ? [`--title=${input.title}`] : []), ...(input.kind ? [`--kind=${input.kind}`] : [])];
    }
    if (operation === 'spec.source.add') {
      temporary = await mkdtemp(path.join(directory, 'upload-'));
      const file = path.join(temporary, input.name);
      await writeFile(file, Buffer.from(input.data, 'base64'), { mode: 0o600 });
      args = ['spec', 'author', 'source', input.specId, `--file=${file}`, `--operation-id=lws-${invocationId}`, '--for-person',
        ...(input.restore ? [`--restore=${input.restore}`] : [])];
    }
    if (operation === 'spec.source.link') args = ['spec', 'author', 'source', input.specId, `--url=${input.url}`, `--operation-id=lws-${invocationId}`, '--for-person'];
    if (!shape.mutation && !shape.machine) {
      const warm = await readWithWorker({ executable: process.execPath, cli: cliPath, repository: root, args: [...args, '--json'], signal, env: { ...environment, SINGULARITY_FLOW_NO_MODEL: '1' } });
      if (warm) return { value: warm.value, transport: 'read-worker', durationMs: warm.durationMs };
    }
    if (shape.mutation) invalidateReadWorkers(root);
    return await runCanonical(root, args, { signal, onProgress, environment, machine: shape.machine });
  } finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
}
