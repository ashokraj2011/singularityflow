import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { initializeDefinition } from '../src/config.mjs';
import { detachEpicSource, jiraSnapshotSource, listEpicSources, pinJiraEpicAttachments, registerEpicSource, storageAdapter, verifyEpicSources } from '../src/epic-sources.mjs';
import {
  adoptEpicStory, completeEpicIntake, completeEpicPublication, prepareEpicStorySpecifications, splitEpicStory,
  updateEpicStory, verifyEpicPlanningPackage
} from '../src/epic-lifecycle.mjs';
import { verifyEpicTraceability } from '../src/epic-traceability.mjs';
import { deriveInitiativeReport, initiativeNextActions } from '../src/initiative-report.mjs';
import { createInitiative, loadInitiative, saveInitiative } from '../src/initiative-state.mjs';
import { run } from '../src/util.mjs';

process.env.NODE_ENV = 'test';
process.env.SINGULARITY_FLOW_TEST_IDENTITY = 'Epic Product Owner';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function flow(root, args, { allowFailure = false } = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SINGULARITY_FLOW_TEST_IDENTITY: 'Epic Product Owner',
      SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ agent: 'product-owner' })
    }
  });
  if (!allowFailure && result.status !== 0) throw new Error(`${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

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
  portfolio.git.publish = 'off';
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
    agent: 'product-owner'
  });
  return root;
}

test('Artifactory bearer credentials never leave the configured repository scope', async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    return response('# governed source\n', { method: init.method ?? 'GET' });
  };
  const adapter = storageAdapter('corporate', {
    type: 'artifactory',
    baseUrl: 'https://artifacts.example.test/artifactory',
    repository: 'releases'
  }, { token: 'do-not-leak', fetchImpl });

  await assert.rejects(
    () => adapter.get({ url: 'https://attacker.example/collect' }, { maxBytes: 1024 }),
    (error) => error.code === 'STORAGE_REFERENCE_OUTSIDE_PROVIDER'
  );
  await assert.rejects(
    () => adapter.head({ url: 'https://artifacts.example.test/api/security/users' }),
    (error) => error.code === 'STORAGE_REFERENCE_OUTSIDE_PROVIDER'
  );
  await assert.rejects(
    () => adapter.get({ objectId: '../../api/system/configuration' }, { maxBytes: 1024 }),
    (error) => error.code === 'STORAGE_REFERENCE_OUTSIDE_PROVIDER'
  );
  assert.equal(requests.length, 0, 'out-of-scope references are rejected before credentials or network are used');

  const result = await adapter.get({ objectId: 'releases/team/spec.md' }, { maxBytes: 1024 });
  assert.equal(result.bytes.toString(), '# governed source\n');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://artifacts.example.test/artifactory/releases/team/spec.md');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer do-not-leak');
});

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

test('Jira Epic snapshot is available as a pinned source without uploaded documents', async () => {
  const root = await repository();
  const { initiative } = await loadInitiative(root, 'MOB-100');
  const source = jiraSnapshotSource(initiative);
  assert.match(source.sourceId, /^SRC-[A-F0-9]{12}$/);
  assert.equal(source.provider, 'jira-snapshot');
  assert.match(source.content, /"key": "MOB-100"/);
  const actions = await initiativeNextActions(root, 'MOB-100');
  assert.equal(actions[0].action, 'prepare');
});

test('an unstarted Planning phase does not make the Epic desktop report fail', async () => {
  const root = await repository();
  const { portfolio, initiative } = await loadInitiative(root, 'MOB-100');
  const verification = await verifyEpicPlanningPackage(root, portfolio, initiative);
  assert.equal(verification.valid, false);
  assert.match(verification.errors.join('\n'), /Story specification index does not exist/);

  const report = await deriveInitiativeReport(root, 'MOB-100');
  const planning = report.phases.find((phase) => phase.id === 'epic-planning');
  assert.equal(planning.status, 'not_started');
  assert.equal(planning.publishedOutputs, 0);
});

test('Epic intake advances without a repository world model and defers grounding to Story intake', async () => {
  const root = await repository();
  const before = await loadInitiative(root, 'MOB-100');
  assert.equal(before.initiative.currentPhase, 'epic-intake');
  assert.equal(before.initiative.resolution.worldModelTiming, 'story-intake');
  assert.equal(before.initiative.resolution.worldModelGrounding, 'off');

  const completed = await completeEpicIntake(root, 'MOB-100', { agent: 'product-owner' });
  assert.equal(completed.advanced, true);
  assert.equal(completed.initiative.currentPhase, 'epic-requirements');
  assert.equal(completed.initiative.phases['epic-intake'].status, 'approved');
  assert.equal(completed.initiative.phases['epic-requirements'].status, 'in_progress');
  assert.match(
    completed.initiative.history.at(-1).detail,
    /repository grounding is deferred to Story intake/i
  );
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
  const planOutput = initiative.phases['epic-planning'].outputs['story-plan'];
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

test('editable Planning Stories refresh their governed specifications and reopen the exact package', async () => {
  const root = await repository();
  const loaded = await loadInitiative(root, 'MOB-100');
  loaded.initiative.currentPhase = 'epic-planning';
  loaded.initiative.phases['epic-intake'].status = 'approved';
  loaded.initiative.phases['epic-requirements'].status = 'approved';
  loaded.initiative.phases['epic-planning'].status = 'approved';
  loaded.initiative.phases['epic-publish'].status = 'in_progress';
  const breakdown = {
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
        description: 'Create the sign-in interaction.',
        requirements: ['REQ-001'],
        acceptanceCriteria: ['AC-001'],
        repository: 'mobile',
        suggestedWorkType: 'feature',
        dependsOn: [],
        blocking: true,
        specification: '## Contract\n\nRender the approved sign-in states and validation behavior.'
      }]
    }]
  };
  const breakdownText = YAML.stringify(breakdown);
  await writeFile(path.join(root, 'singularity/initiatives/MOB-100/breakdown.yml'), breakdownText);
  await mkdir(path.join(root, 'singularity/initiatives/MOB-100/artifacts/epic-planning'), { recursive: true });
  await writeFile(
    path.join(root, 'singularity/initiatives/MOB-100/artifacts/epic-planning/story-plan.yml'),
    breakdownText
  );
  await saveInitiative(root, loaded.portfolio, loaded.initiative);
  await prepareEpicStorySpecifications(root, 'MOB-100');
  const before = await verifyEpicPlanningPackage(root, loaded.portfolio, loaded.initiative);
  assert.equal(before.valid, true);

  const updated = await updateEpicStory(root, 'MOB-100', 'STORY-001', {
    title: 'Build accessible sign-in screen',
    specification: '## Contract\n\nRender accessible sign-in states, validation, and keyboard behavior.'
  });
  assert.equal(updated.story.title, 'Build accessible sign-in screen');
  assert.equal(updated.initiative.currentPhase, 'epic-planning');
  assert.equal(updated.initiative.phases['epic-planning'].status, 'in_progress');
  assert.equal(updated.initiative.phases['epic-publish'].status, 'not_started');
  const specification = await readFile(
    path.join(root, 'singularity/initiatives/MOB-100/artifacts/epic-planning/stories/STORY-001/story-spec.md'),
    'utf8'
  );
  assert.match(specification, /accessible sign-in states/);
  const after = await verifyEpicPlanningPackage(root, updated.portfolio, updated.initiative);
  assert.equal(after.valid, true);
  assert.notEqual(after.packageSha256, before.packageSha256);

  const split = await splitEpicStory(root, 'MOB-100', 'STORY-001', {
    title: 'Build the sign-in error states',
    specification: '## Contract\n\nImplement validation and recovery states.'
  });
  assert.equal(split.story.planId, 'STORY-002');
  assert.equal(split.story.jiraKey, null);
  const adopted = await adoptEpicStory(root, 'MOB-100', {
    id: '10042',
    key: 'MOB-321',
    title: 'Existing audit Story',
    description: 'Record sign-in security events.',
    parent: null,
    subtasks: [{ id: '10043', key: 'MOB-322', title: 'Add audit schema' }]
  }, {
    repository: 'mobile',
    requirements: ['REQ-001'],
    acceptanceCriteria: ['AC-001']
  });
  assert.equal(adopted.story.planId, 'STORY-003');
  assert.equal(adopted.story.workId, 'MOB-321');
  assert.equal(adopted.story.parentMode, 'external');
  assert.equal(adopted.story.metadata.originalParent, 'unlinked');
  assert.equal(adopted.story.tasks[0].jiraKey, 'MOB-322');
});

test('CLI manages Story metadata and Jira task drafts one field at a time', async () => {
  const root = await repository();
  const loaded = await loadInitiative(root, 'MOB-100');
  loaded.initiative.currentPhase = 'epic-planning';
  loaded.initiative.phases['epic-intake'].status = 'approved';
  loaded.initiative.phases['epic-requirements'].status = 'approved';
  loaded.initiative.phases['epic-planning'].status = 'in_progress';
  const breakdown = {
    version: 2,
    initiativeId: 'MOB-100',
    epics: [{
      planId: 'EPIC-001',
      jiraKey: 'MOB-100',
      title: 'Mobile sign-in',
      stories: [{
        planId: 'STORY-001',
        workId: 'STORY-001',
        title: 'Build sign-in',
        description: 'Build the sign-in flow.',
        specification: '## Contract\n\nImplement the approved sign-in behavior.',
        requirements: ['REQ-001'],
        acceptanceCriteria: ['AC-001'],
        repository: 'mobile',
        suggestedWorkType: 'feature',
        dependsOn: [],
        blocking: true,
        metadata: {},
        tasks: []
      }]
    }]
  };
  const text = YAML.stringify(breakdown);
  await writeFile(path.join(root, 'singularity/initiatives/MOB-100/breakdown.yml'), text);
  await mkdir(path.join(root, 'singularity/initiatives/MOB-100/artifacts/epic-planning'), { recursive: true });
  await writeFile(path.join(root, 'singularity/initiatives/MOB-100/artifacts/epic-planning/story-plan.yml'), text);
  await saveInitiative(root, loaded.portfolio, loaded.initiative);
  await prepareEpicStorySpecifications(root, 'MOB-100');

  flow(root, ['epic', 'stories', 'metadata', 'STORY-001', 'set', 'component', 'authentication']);
  const metadata = JSON.parse(flow(root, ['epic', 'stories', 'metadata', 'STORY-001', 'list', '--json']).stdout);
  assert.deepEqual(metadata, { component: 'authentication' });

  flow(root, ['epic', 'stories', 'tasks', 'STORY-001', 'add', '--title', 'Add integration tests', '--acceptance-criteria', 'AC-001']);
  let tasks = JSON.parse(flow(root, ['epic', 'stories', 'tasks', 'STORY-001', 'list', '--json']).stdout);
  assert.equal(tasks[0].id, 'TASK-001');
  assert.equal(tasks[0].title, 'Add integration tests');
  flow(root, ['epic', 'stories', 'tasks', 'STORY-001', 'update', 'TASK-001', '--description', 'Cover the canonical sign-in contract.']);
  tasks = JSON.parse(flow(root, ['epic', 'stories', 'tasks', 'STORY-001', 'list', '--json']).stdout);
  assert.match(tasks[0].description, /canonical sign-in contract/);
  flow(root, ['epic', 'stories', 'tasks', 'STORY-001', 'remove', 'TASK-001']);
  assert.deepEqual(JSON.parse(flow(root, ['epic', 'stories', 'tasks', 'STORY-001', 'list', '--json']).stdout), []);
  flow(root, ['epic', 'stories', 'metadata', 'STORY-001', 'remove', 'component']);
  assert.deepEqual(JSON.parse(flow(root, ['epic', 'stories', 'metadata', 'STORY-001', 'list', '--json']).stdout), {});
});

test('Jira Epic attachments are pinned as governed sources at start', async () => {
  const root = await repository();
  const bodies = {
    'https://jira.example.com/attachment/1': Buffer.from('# Operator specification\n'),
    'https://jira.example.com/attachment/2': Buffer.from('# Pricing examples\n')
  };
  const fetchImpl = async (url, init = {}) => response(bodies[String(url)] ?? Buffer.from(''), { method: init.method ?? 'GET' });

  const result = await pinJiraEpicAttachments(root, 'MOB-100', {
    providerId: 'reference',
    runtime: { fetchImpl },
    attachments: [
      { id: '1', filename: 'operator-spec.md', mimeType: 'text/markdown', url: 'https://jira.example.com/attachment/1' },
      { id: '2', filename: 'pricing.md', mimeType: 'text/markdown', url: 'https://jira.example.com/attachment/2' },
      // No URL: nothing to fetch, so nothing can be hashed and it is not evidence.
      { id: '3', filename: 'orphan.md', mimeType: 'text/markdown' }
    ]
  });

  assert.equal(result.pinned.length, 2);
  assert.equal(result.skipped.length, 0, 'an attachment with no URL is not considered, not failed');
  // Each pinned attachment carries a content hash — that is what makes it citable evidence rather
  // than a filename someone mentioned.
  for (const entry of result.pinned) {
    assert.match(entry.sourceId, /^SRC-[A-F0-9]{12}$/);
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
  }
  const { manifest } = await listEpicSources(root, 'MOB-100');
  assert.deepEqual(manifest.sources.map((entry) => entry.name).sort(), ['operator-spec.md', 'pricing.md']);
});

test('successful Jira and Git Story receipts complete the planning lifecycle automatically', async () => {
  const root = await repository();
  const loaded = await loadInitiative(root, 'MOB-100');
  await writeFile(path.join(root, 'singularity/initiatives/MOB-100/breakdown.yml'), YAML.stringify({
    version: 2,
    initiativeId: 'MOB-100',
    epics: [{
      planId: 'EPIC-001',
      jiraKey: 'MOB-100',
      title: 'Mobile sign-in',
      stories: [{
        planId: 'STORY-001',
        workId: 'MOB-123',
        jiraKey: 'MOB-123',
        title: 'Build sign-in',
        repository: 'mobile',
        requirements: ['REQ-001'],
        acceptanceCriteria: ['AC-001'],
        tasks: [{ id: 'TASK-001', title: 'Implement UI', jiraKey: 'MOB-124' }]
      }]
    }]
  }));
  loaded.initiative.currentPhase = 'epic-publish';
  loaded.initiative.phases['epic-planning'].status = 'approved';
  loaded.initiative.phases['epic-planning'].generation = 1;
  loaded.initiative.phases['epic-publish'].status = 'in_progress';
  loaded.initiative.materialization = {
    status: 'complete',
    attempts: [{
      status: 'complete',
      completedAt: '2026-07-26T10:00:00.000Z',
      stories: [{ storyId: 'STORY-001', commit: 'a'.repeat(40) }]
    }]
  };
  await saveInitiative(root, loaded.portfolio, loaded.initiative);
  const completed = await completeEpicPublication(root, 'MOB-100');
  assert.equal(completed.completed, true);
  assert.equal(completed.initiative.status, 'complete');
  assert.equal(completed.initiative.currentPhase, null);
  assert.equal(completed.initiative.phases['epic-publish'].status, 'approved');
  const report = await readFile(
    path.join(root, 'singularity/initiatives/MOB-100/artifacts/epic-publish/materialization-report.md'),
    'utf8'
  );
  assert.match(report, /planning workflow is complete/i);
  assert.match(report, /MOB-123/);
});

test('a failing attachment is reported without losing the Epic', async () => {
  const root = await repository();
  // Pinning happens during Epic start. A provider error there must never destroy the Epic the user
  // just created — it is reported so they can pin by hand.
  const fetchImpl = async () => { throw new Error('provider unavailable'); };
  const result = await pinJiraEpicAttachments(root, 'MOB-100', {
    providerId: 'reference',
    runtime: { fetchImpl },
    attachments: [{ id: '1', filename: 'spec.md', mimeType: 'text/markdown', url: 'https://jira.example.com/attachment/1' }]
  });
  assert.deepEqual(result.pinned, []);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /provider unavailable/);
});

test('a source whose name has spaces is pinned, not rejected', async () => {
  // safeSegment demanded a portable filename of the user's own file, so "Auth V2 PRD.md" — an
  // entirely ordinary name — failed outright. The storage key is normalised instead, and the record
  // keeps the real title, which is what the sources rail and a citation display.
  const root = await repository();
  const bytes = Buffer.from('# Spec\n');
  const fetchImpl = async (_url, init = {}) => response(bytes, { method: init.method ?? 'GET' });
  const registered = await registerEpicSource(root, {
    initiativeId: 'MOB-100',
    providerId: 'reference',
    url: 'https://documents.example.com/auth.md',
    remoteRef: { objectId: 'auth-v2', filename: 'Auth V2 PRD.md' },
    mimeType: 'text/markdown',
    runtime: { fetchImpl }
  });
  assert.equal(registered.record.name, 'Auth V2 PRD.md');
  assert.match(registered.record.filename, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  assert.ok(!registered.record.filename.includes(' '), 'the storage key must stay portable');
});

test('Epic source detachment is audited, hidden by default, and reopens its dependency cone', async () => {
  const root = await repository();
  const content = Buffer.from('# Governed product brief\n');
  const fetchImpl = async (_url, init = {}) => response(content, { method: init.method ?? 'GET' });
  const registered = await registerEpicSource(root, {
    initiativeId: 'MOB-100', providerId: 'reference',
    url: 'https://documents.example.com/product-brief.md', label: 'Product brief',
    mimeType: 'text/markdown', runtime: { fetchImpl }
  });
  const loaded = await loadInitiative(root, 'MOB-100');
  const contextDirectory = path.join(root, 'singularity/initiatives/MOB-100/context');
  await mkdir(contextDirectory, { recursive: true });
  await writeFile(path.join(contextDirectory, 'requirements-gen1.json'), `${JSON.stringify({
    phase: 'epic-requirements', sources: [{ sourceId: registered.record.sourceId, sha256: registered.record.sha256 }]
  }, null, 2)}\n`);
  const detached = await detachEpicSource(root, loaded.portfolio, loaded.initiative, {
    sourceId: registered.record.sourceId, reason: 'Product brief was withdrawn', agent: 'product-owner'
  });
  assert.equal(detached.reopenedPhase, 'epic-requirements');
  assert.match(detached.decision.sha256, /^[a-f0-9]{64}$/);
  assert.equal((await listEpicSources(root, 'MOB-100')).manifest.sources.length, 0);
  const historical = (await listEpicSources(root, 'MOB-100', { includeDetached: true })).manifest.sources;
  assert.equal(historical.length, 1);
  assert.equal(historical[0].status, 'detached');
  assert.equal(historical[0].detachReason, 'Product brief was withdrawn');
  const stale = JSON.parse(await readFile(path.join(contextDirectory, 'requirements-gen1.json'), 'utf8'));
  assert.equal(stale.stale, true);
  assert.match(stale.staleReason, new RegExp(registered.record.sourceId));
});

test('Epic source detach CLI publishes one exact decision and supports active or historical listing', async () => {
  const root = await repository();
  const attached = JSON.parse(flow(root, [
    'epic', 'sources', 'note', '--epic', 'MOB-100', '--text', 'Approved intake note', '--label', 'Intake note', '--json'
  ]).stdout);
  const detached = JSON.parse(flow(root, [
    'epic', 'sources', 'detach', attached.record.sourceId, '--epic', 'MOB-100',
    '--reason', 'Note replaced by signed brief', '--yes', '--json'
  ]).stdout);
  assert.equal(detached.source.status, 'detached');
  assert.match(detached.publication.sha, /^[a-f0-9]{40}$/);
  assert.deepEqual(JSON.parse(flow(root, ['epic', 'sources', 'list', '--epic', 'MOB-100', '--json']).stdout).sources, []);
  const historical = JSON.parse(flow(root, ['epic', 'sources', 'list', '--epic', 'MOB-100', '--all', '--json']).stdout);
  assert.equal(historical.sources[0].detachReason, 'Note replaced by signed brief');
  assert.match(run('git', ['log', '--format=%s'], { cwd: root }).stdout, /\[MOB-100\]\[epic:evidence:detach\]/);
});
