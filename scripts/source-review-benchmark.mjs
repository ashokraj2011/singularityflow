/** Real CLI review pipeline in disposable repositories. No model, application tests or remote. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishedSpecificationStory, reviewReport } from '../test/helpers/source-review-fixture.mjs';
import { completeAgentResult } from '../src/agent-output.mjs';
import { bundledCliUrl } from '../src/bundled-cli.mjs';

const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const engine = path.resolve(option('engine') ?? fileURLToPath(new URL('..', import.meta.url)));
const runtime = option('runtime') ?? 'source';
if (!['source', 'bundle'].includes(runtime)) throw new Error('Runtime must be source or bundle.');
const samples = Number(option('samples') ?? 3);
const history = Number(option('history') ?? 100);
const attachments = Number(option('attachments') ?? 16);
const publicationTemperature = option('publication-temperature') ?? null;
if (publicationTemperature !== null && !['cold', 'warm'].includes(publicationTemperature)) throw new Error('Publication temperature must be cold or warm.');
if (publicationTemperature && runtime !== 'bundle') throw new Error('Publication temperature measurements require the installed bundle runtime.');
if (![samples, history, attachments].every(Number.isSafeInteger) || samples < 1 || samples > 10
    || history < 0 || history > 1000 || attachments < 0 || attachments > 64) throw new Error('Invalid benchmark dimensions.');
const rows = [];
for (let sample = 0; sample < samples; sample++) {
  const cleanups = [];
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-review-benchmark-'));
  try {
  const { root, phaseId } = await publishedSpecificationStory({ after: fn => cleanups.push(fn) }, { humanAnswers: true });
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_BUNDLE: runtime === 'source' ? 'off' : 'on',
    NODE_COMPILE_CACHE: path.join(directory, 'compile-cache'),
    SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1', SINGULARITY_FLOW_GIT_FACT_STORE: path.join(directory, 'git-facts'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(directory, 'workspaces.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(directory, 'active.json'),
    SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(directory, 'mode.json') };
  delete env.SINGULARITY_FLOW_NO_MODEL;
  delete env.SINGULARITY_FLOW_BUNDLE_DIR;
  if (runtime === 'bundle') {
    env.SINGULARITY_FLOW_BUNDLE_DIR = path.join(engine, 'bundle');
    assert.ok(bundledCliUrl(engine, env), 'Build the engine bundle first; never silently measure a source fallback.');
  }
  // Preparing a valid report must not warm the first publication's code or Git fact cache.
  const setupEnv = publicationTemperature === 'cold' ? { ...env,
    NODE_COMPILE_CACHE: path.join(directory, 'setup-compile-cache'),
    SINGULARITY_FLOW_GIT_FACT_STORE: path.join(directory, 'setup-git-facts') } : env;
  const git = args => {
    const answer = spawnSync('git', args, { cwd: root, env, encoding: 'utf8', timeout: 120000 });
    assert.equal(answer.status, 0, answer.stderr);
    return answer.stdout.trim();
  };
  function invoke(action, args, { environment = setupEnv, measured = !publicationTemperature } = {}) {
    const start = performance.now();
    const answer = spawnSync(process.execPath, [path.join(engine, 'bin/singularity-flow.mjs'), ...args,
      ...(action === 'runtime-prewarm' ? [] : ['--json', '--timings'])], {
      cwd: root, env: environment, encoding: 'utf8', timeout: 180000, maxBuffer: 40 * 1024 * 1024
    });
    const ms = performance.now() - start;
    assert.equal(answer.status, 0, `${action}: ${answer.stderr}\n${answer.stdout}`);
    const counter = name => Number(answer.stderr.match(new RegExp(`(?:^|\\s)${name.replaceAll('.', '\\.')}=([0-9.]+)(?=\\s|$)`))?.[1] ?? 0);
    const timingLine = answer.stderr.split('\n').find(line => line.startsWith('[sflow timing]')) ?? '';
    const timings = Object.fromEntries([...timingLine.matchAll(/(?:^|[\s:])([a-z][a-z0-9.-]*)=([0-9.]+)ms\b/gu)]
      .map(([, name, value]) => [name, Number(value)]));
    const gitCommands = Object.fromEntries([...timingLine.matchAll(/\bgit\.local\.command\.([a-z-]+)=([0-9]+)/gu)]
      .map(([, name, value]) => [name, Number(value)]));
    const gitServiceMs = Object.fromEntries([...timingLine.matchAll(/\bgit\.local\.service-ms\.([a-z-]+)=([0-9]+)/gu)]
      .map(([, name, value]) => [name, Number(value)]));
    if (measured) rows.push({ sample, action, ms: Math.round(ms), gitSpawns: counter('git.spawns'), gitRequests: counter('git.requests'),
      snapshotHits: counter('source-review.snapshot-hits'), inputLoads: counter('source-review.input-loads'),
      provenanceHits: counter('source-review.provenance-hits'), freshBindings: counter('source-review.fresh-bindings'),
      definitionLoads: counter('configuration.definition-load'), sourceReads: counter('configuration.source-read'),
      templateChecks: counter('configuration.template-checks'), immutableReadHits: counter('publication.immutable-read-hits'),
      ...(publicationTemperature ? { publicationTemperature } : {}), timings, gitCommands, gitServiceMs });
    return completeAgentResult(answer.stdout);
  }
    const base = 'singularity/work-items/REVIEW-1';
    const documents = [];
    await mkdir(path.join(root, base, 'inputs'), { recursive: true });
    for (let index = 0; index < attachments; index++) {
      const text = `Persist a saved draft.\nSupporting detail ${index}.\n`;
      const relative = `${base}/inputs/notes-${index}.md`;
      await writeFile(path.join(root, relative), text);
      documents.push({ id: `DOC-${String(index + 1).padStart(3, '0')}`, type: 'file', status: 'active',
        path: relative, mimeType: 'text/markdown', sha256: createHash('sha256').update(text).digest('hex') });
    }
    await writeFile(path.join(root, base, 'documents.json'), JSON.stringify({ schemaVersion: 2, workId: 'REVIEW-1', documents }));
    git(['add', '.']); git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'Synthetic review attachments']);
    for (let index = 0; index < history; index++) git(['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', `Synthetic history ${index}`]);
    const before = git(['rev-parse', 'HEAD']);
    const packet = invoke('context-cold', ['review-source', 'context', phaseId, '--for-agent']);
    if (!publicationTemperature) invoke('context-warm', ['review-source', 'context', phaseId, '--for-agent']);
    const report = reviewReport(packet);
    report.clarificationsReviewed = packet.clarifications.map(record => record.id);
    for (const source of packet.sources.filter(entry => entry.id !== 'story')) {
      report.rows.push({ id: `source-${source.id}`, sourceId: source.id, line: 1, quote: 'Persist a saved draft.',
        outcome: 'covered', scenarioId: 'S1', clauseIds: ['REVIEW-1:REQ-001'] });
    }
    const staged = invoke('stage', ['review-source', 'stage', phaseId, '--report-json', JSON.stringify(report)]);
    assert.equal(staged.retentionReady, true);
    const checked = invoke('check', ['review-source', 'check', phaseId, '--report-file', packet.stagingPath]);
    assert.equal(checked.retentionReady, true, JSON.stringify(checked));
    assert.equal(git(['rev-parse', 'HEAD']), before, 'context/check cannot mutate the Story');
    if (publicationTemperature === 'cold') {
      assert.equal(existsSync(env.NODE_COMPILE_CACHE), false, 'first publication compile cache must be empty');
      assert.equal(existsSync(env.SINGULARITY_FLOW_GIT_FACT_STORE), false, 'first publication Git fact cache must be empty');
    } else if (publicationTemperature === 'warm' && runtime === 'bundle') {
      const prepared = invoke('runtime-prewarm', ['--warm-runtime'], { environment: env, measured: false });
      assert.equal(prepared.prepared, true, 'warm publication must actually prepare installed definitions');
    }
    const retained = invoke('retain', ['review-source', 'submit', phaseId, '--report-file', packet.stagingPath], { environment: env, measured: true });
    assert.ok(retained.reportSha256);
    const status = invoke('status-cold', ['review-source', 'status', phaseId], { environment: env, measured: !publicationTemperature });
    assert.equal(status.reportSha256, retained.reportSha256);
    assert.notEqual(git(['rev-parse', 'HEAD']), before, 'the measured publication must create a real lifecycle commit');
    if (!publicationTemperature) invoke('status-warm', ['review-source', 'status', phaseId]);
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await rm(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
}
const result = { platform: process.platform, node: process.version, engine, runtime, samples, history, attachments, publicationTemperature,
  scope: publicationTemperature
    ? 'Measured retention only: cold uses empty compile/Git caches separate from report setup; warm uses real review reads and explicit installed-definition preparation. OS caches are not flushed. Excludes setup, model, shell transport, application tests and network push.'
    : 'Fresh Node CLI processes and an isolated V8 compile cache per sample; cold = first review context on a disposable published Story; warm = immediate repeat with private Git fact storage and compiled code. Status follows retention. OS caches are not flushed. Excludes model reasoning, application tests and network push.', rows };
if (option('output')) await writeFile(path.resolve(option('output')), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
