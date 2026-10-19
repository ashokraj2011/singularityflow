/** Real CLI review pipeline in disposable repositories. No model, application tests or remote. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
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
if (![samples, history, attachments].every(Number.isSafeInteger) || samples < 1 || samples > 10
    || history < 0 || history > 1000 || attachments < 0 || attachments > 64) throw new Error('Invalid benchmark dimensions.');
const rows = [];
for (let sample = 0; sample < samples; sample++) {
  const cleanups = [];
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-review-benchmark-'));
  const { root, phaseId } = await publishedSpecificationStory({ after: fn => cleanups.push(fn) }, { humanAnswers: true });
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_BUNDLE: runtime === 'source' ? 'off' : 'on',
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
  const git = args => {
    const answer = spawnSync('git', args, { cwd: root, env, encoding: 'utf8', timeout: 120000 });
    assert.equal(answer.status, 0, answer.stderr);
    return answer.stdout.trim();
  };
  function invoke(action, args) {
    const start = performance.now();
    const answer = spawnSync(process.execPath, [path.join(engine, 'bin/singularity-flow.mjs'), ...args, '--json', '--timings'], {
      cwd: root, env, encoding: 'utf8', timeout: 180000, maxBuffer: 40 * 1024 * 1024
    });
    const ms = performance.now() - start;
    assert.equal(answer.status, 0, `${action}: ${answer.stderr}\n${answer.stdout}`);
    const counter = name => Number(answer.stderr.match(new RegExp(`(?:^|\\s)${name.replaceAll('.', '\\.')}=([0-9.]+)`))?.[1] ?? 0);
    rows.push({ sample, action, ms: Math.round(ms), gitSpawns: counter('git.spawns'), gitRequests: counter('git.requests'),
      snapshotHits: counter('source-review.snapshot-hits'), inputLoads: counter('source-review.input-loads'),
      provenanceHits: counter('source-review.provenance-hits'), freshBindings: counter('source-review.fresh-bindings') });
    return completeAgentResult(answer.stdout);
  }
  try {
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
    invoke('context-warm', ['review-source', 'context', phaseId, '--for-agent']);
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
    const retained = invoke('retain', ['review-source', 'submit', phaseId, '--report-file', packet.stagingPath]);
    assert.ok(retained.reportSha256);
    invoke('status-cold', ['review-source', 'status', phaseId]);
    invoke('status-warm', ['review-source', 'status', phaseId]);
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await rm(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
  }
}
const result = { platform: process.platform, node: process.version, engine, runtime, samples, history, attachments,
  scope: 'Fresh Node CLI processes; cold = first review context/status on a disposable published Story; warm = immediate repeat with private Git fact storage. OS caches are not flushed. Excludes model reasoning, application tests and network push.', rows };
if (option('output')) await writeFile(path.resolve(option('output')), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
