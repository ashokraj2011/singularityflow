import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { initializeDefinition } from '../src/config.mjs';
import { registerEpicSource, verifyEpicSources } from '../src/epic-sources.mjs';
import { verifyEpicTraceability } from '../src/epic-traceability.mjs';
import { createInitiative, loadInitiative, saveInitiative } from '../src/initiative-state.mjs';
import { run } from '../src/util.mjs';

process.env.NODE_ENV = 'test';
process.env.SINGULARITY_FLOW_TEST_IDENTITY = 'Epic Product Owner';

function response(bytes, { method = 'GET', etag = '"version-1"', mime = 'text/markdown' } = {}) {
  const body = Buffer.from(bytes);
  return {
    ok: true,
    status: method === 'HEAD' ? 204 : 200,
    headers: {
      get(name) {
        if (name.toLowerCase() === 'content-length') return String(body.length);
        if (name.toLowerCase() === 'content-type') return mime;
        if (name.toLowerCase() === 'etag') return etag;
        return null;
      }
    },
    async arrayBuffer() {
      return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
    }
  };
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-epic-sources-'));
  run('git', ['init', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Epic Product Owner'], { cwd: root });
  run('git', ['config', 'user.email', 'epic.owner@example.com'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# Epic source fixture\n');
  await initializeDefinition(root);
  const portfolioPath = path.join(root, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(portfolioPath, 'utf8'));
  portfolio.approvalAuthorities['product-approvers'].members = [{
    name: 'Epic Product Owner',
    email: 'epic.owner@example.com'
  }];
  portfolio.repositories.mobile = {
    url: root,
    defaultBranch: 'main',
    branchCompletionPolicy: 'pr',
    requiredChecks: ['build']
  };
  portfolio.storage = {
    defaultProvider: 'reference',
    maxBytes: 1024 * 1024,
    allowedMimeTypes: ['text/markdown'],
    providers: {
      reference: {
        type: 'https-reference',
        maxBytes: 1024 * 1024,
        allowedMimeTypes: ['text/markdown']
      }
    }
  };
  await writeFile(portfolioPath, YAML.stringify(portfolio));
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-m', 'Initialize Epic planning'], { cwd: root });
  run('git', ['switch', '-c', 'MOB-100'], { cwd: root });
  await createInitiative(root, {
    id: 'MOB-100',
    title: 'Mobile sign-in',
    profile: 'epic-planning',
    source: { type: 'jira', id: '10000', key: 'MOB-100' },
    persona: 'product-owner'
  });
  return root;
}

test('Epic sources pin remote bytes outside Git and detect record or content tampering', async () => {
  const root = await repository();
  let current = Buffer.from('# Approved discovery\n\nSection 2: Sign-in requirements.\n');
  const fetchImpl = async (_url, init = {}) => response(current, { method: init.method ?? 'GET' });
  const registered = await registerEpicSource(root, {
    initiativeId: 'MOB-100',
    providerId: 'reference',
    url: 'https://documents.example.com/mobile-sign-in.md',
    label: 'Approved discovery',
    mimeType: 'text/markdown',
    runtime: { fetchImpl }
  });
  assert.match(registered.record.sourceId, /^SRC-[A-F0-9]{12}$/);
  assert.equal(registered.manifest.sources.length, 1);
  assert.equal(
    run('git', ['status', '--short'], { cwd: root }).stdout.includes('Approved discovery'),
    false,
    'source bytes must not be written into the Git work tree'
  );

  const verified = await verifyEpicSources(root, 'MOB-100', {
    materialize: true,
    runtime: { fetchImpl }
  });
  assert.equal(verified.valid, true);
  assert.equal(verified.results[0].status, 'verified');
  assert.match(verified.results[0].cachePath, /^\.git\/singularity-flow\/epic-sources\//);
  assert.equal(await readFile(path.join(root, verified.results[0].cachePath), 'utf8'), current.toString());

  current = Buffer.from('# Changed after intake\n');
  const changed = await verifyEpicSources(root, 'MOB-100', {
    materialize: true,
    runtime: { fetchImpl }
  });
  assert.equal(changed.valid, false);
  assert.equal(changed.results[0].status, 'hash-mismatch');

  const recordPath = path.join(root, registered.manifest.sources[0].recordPath);
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  record.name = 'silently changed';
  await writeFile(recordPath, JSON.stringify(record, null, 2));
  const tampered = await verifyEpicSources(root, 'MOB-100', {
    materialize: true,
    runtime: { fetchImpl }
  });
  assert.equal(tampered.results[0].status, 'record-tampered');
});

test('Epic traceability requires pinned source locators and complete REQ/AC Story allocation', async () => {
  const root = await repository();
  const content = Buffer.from('# Approved discovery\n\nSection 2: Sign-in requirements.\n');
  const fetchImpl = async (_url, init = {}) => response(content, { method: init.method ?? 'GET' });
  const registered = await registerEpicSource(root, {
    initiativeId: 'MOB-100',
    providerId: 'reference',
    url: 'https://documents.example.com/mobile-sign-in.md',
    label: 'Approved discovery',
    mimeType: 'text/markdown',
    runtime: { fetchImpl }
  });
  const loaded = await loadInitiative(root, 'MOB-100');
  const initiative = loaded.initiative;
  const traceOutput = initiative.phases['epic-requirements'].outputs['requirements-traceability'];
  const tracePath = path.join(root, 'singularity/initiatives/MOB-100', traceOutput.path);
  await mkdir(path.dirname(tracePath), { recursive: true });
  await writeFile(tracePath, YAML.stringify({
    version: 1,
    epicId: 'MOB-100',
    requirements: [{
      id: 'REQ-001',
      statement: 'Support secure sign-in',
      sources: [{ sourceId: registered.record.sourceId, section: 'Section 2' }]
    }],
    acceptanceCriteria: [{
      id: 'AC-001',
      statement: 'A valid user signs in',
      requirements: ['REQ-001'],
      sources: [{ sourceId: registered.record.sourceId, section: 'Section 2' }]
    }]
  }));
  traceOutput.generation = 1;
  const planOutput = initiative.phases['epic-plan'].outputs['story-plan'];
  planOutput.generation = 1;
  await writeFile(path.join(root, 'singularity/initiatives/MOB-100/breakdown.yml'), YAML.stringify({
    version: 2,
    initiativeId: 'MOB-100',
    epics: [{
      planId: 'EPIC-001',
      jiraKey: 'MOB-100',
      title: 'Mobile sign-in',
      stories: [{
        planId: 'STORY-001',
        workId: 'STORY-001',
        title: 'Build sign-in screen',
        requirements: ['REQ-001'],
        acceptanceCriteria: ['AC-001'],
        repository: 'mobile',
        blocking: true
      }]
    }]
  }));
  await saveInitiative(root, loaded.portfolio, initiative);

  const valid = await verifyEpicTraceability(root, loaded.portfolio, initiative);
  assert.deepEqual(valid.errors, []);
  assert.match(valid.passes.join('\n'), /1 requirements and 1 acceptance criteria/);
  assert.match(valid.passes.join('\n'), /1 Stories trace to 1\/1 acceptance criteria/);

  const invalid = YAML.parse(await readFile(tracePath, 'utf8'));
  invalid.acceptanceCriteria[0].sources = [registered.record.sourceId];
  await writeFile(tracePath, YAML.stringify(invalid));
  const failed = await verifyEpicTraceability(root, loaded.portfolio, initiative);
  assert.match(failed.errors.join('\n'), /source ID plus page, frame, or section locator/);
});
