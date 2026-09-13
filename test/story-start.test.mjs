import assert from 'node:assert/strict';
import {
  mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';
import { loadDefinition } from '../src/config.mjs';
import { onboardRepository } from '../src/onboard.mjs';
import { manualStorySource, startStory } from '../src/story-start.mjs';
import {
  preflightInitialStoryDocuments, scavengeStoryDocumentCaptures,
  stageInitialStoryDocuments, storyDocumentCaptureStorePath
} from '../src/story-start-documents.mjs';
import { documentSetSha256 } from '../src/document-publication.mjs';
import {
  ensureConfigurationBranch, resolveStoryConfigurationAuthority
} from '../src/configuration-branch.mjs';

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SINGULARITY_FLOW_TEST_IDENTITY: 'Desktop Story Tester'
    }
  });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

async function repository({ configurationAuthority = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-desktop-story-'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Desktop Story Tester'], root);
  run('git', ['config', 'user.email', 'desktop-story@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# Desktop Story intake\n');
  run(process.execPath, [path.resolve('bin/singularity-flow.mjs'), 'init'], root);
  const definitionPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.git.publish = 'off';
  await writeFile(definitionPath, YAML.stringify(definition));
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize'], root);
  const remote = `${root}.git`;
  run('git', ['init', '--bare', '-b', 'main', remote], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-u', 'origin', 'main'], root);
  if (configurationAuthority) await ensureConfigurationBranch(remote);
  return root;
}

async function captureRepository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-document-capture-repository-'));
  run('git', ['init', '-b', 'main'], root);
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('Story document preflight refuses a path replacement between metadata check and open', async (t) => {
  const root = await captureRepository(t);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-document-race-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'brief.md');
  const replacement = path.join(directory, 'replacement.md');
  await writeFile(source, '# Approved evidence\n');
  await writeFile(replacement, '# Different bytes that must never be captured\n');
  await assert.rejects(
    () => preflightInitialStoryDocuments([{ files: [source] }], {
      repositoryRoot: root,
      beforeFileOpen: async () => { await rename(replacement, source); }
    }),
    (error) => error?.code === 'STORY_DOCUMENT_CHANGED'
  );
});

test('Story document preflight refuses a directory replacement during traversal', async (t) => {
  const root = await captureRepository(t);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-document-directory-race-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'approved');
  const replacement = path.join(directory, 'replacement');
  const moved = path.join(directory, 'moved-approved');
  await mkdir(source);
  await mkdir(replacement);
  await writeFile(path.join(source, 'brief.md'), '# Approved directory evidence\n');
  await writeFile(path.join(replacement, 'secret.md'), '# Unintended replacement bytes\n');
  let swapped = false;
  await assert.rejects(
    () => preflightInitialStoryDocuments([{ files: [source] }], {
      repositoryRoot: root,
      beforeDirectoryRead: async () => {
        if (swapped) return;
        swapped = true;
        await rename(source, moved);
        await rename(replacement, source);
      }
    }),
    (error) => error?.code === 'STORY_DOCUMENT_CHANGED'
  );
});

test('Story document preflight rejects embedded URL credentials before mutation', async () => {
  await assert.rejects(
    () => preflightInitialStoryDocuments([{
      url: 'https://reviewer:secret@example.com/private-requirements'
    }]),
    (error) => error?.code === 'STORY_DOCUMENT_URL_CREDENTIALS'
  );
  await assert.rejects(
    () => preflightInitialStoryDocuments([{
      url: 'https://example.com/private-requirements?token=secret#download'
    }]),
    (error) => error?.code === 'STORY_DOCUMENT_URL_CREDENTIALS'
  );
});

test('Story document preflight bounds aggregate files, bytes, depth, and private permissions', async (t) => {
  const root = await captureRepository(t);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-document-limits-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = path.join(directory, 'first.txt');
  const second = path.join(directory, 'second.txt');
  await writeFile(first, '1234');
  await writeFile(second, '5678');

  await assert.rejects(
    () => preflightInitialStoryDocuments([{ files: [first, second] }], {
      repositoryRoot: root,
      maxFiles: 1, maxTotalBytes: 100, maxDepth: 4
    }),
    (error) => error?.code === 'STORY_DOCUMENT_LIMIT_EXCEEDED'
      && error?.details?.limit === 'maxFiles'
  );
  await assert.rejects(
    () => preflightInitialStoryDocuments([{ files: [first, second] }], {
      repositoryRoot: root,
      maxFiles: 2, maxTotalBytes: 7, maxDepth: 4
    }),
    (error) => error?.code === 'STORY_DOCUMENT_LIMIT_EXCEEDED'
      && error?.details?.limit === 'maxTotalBytes'
  );

  const deep = path.join(directory, 'deep');
  await mkdir(path.join(deep, 'nested'), { recursive: true });
  await writeFile(path.join(deep, 'nested', 'evidence.md'), '# evidence\n');
  await assert.rejects(
    () => preflightInitialStoryDocuments([{ files: [deep] }], {
      repositoryRoot: root,
      maxFiles: 2, maxTotalBytes: 100, maxDepth: 1
    }),
    (error) => error?.code === 'STORY_DOCUMENT_LIMIT_EXCEEDED'
      && error?.details?.limit === 'maxDepth'
  );

  const capture = await preflightInitialStoryDocuments([{ files: [first] }], {
    repositoryRoot: root,
    maxFiles: 1, maxTotalBytes: 4, maxDepth: 0
  });
  t.after(() => capture.dispose());
  assert.equal(capture.evidence.length, 1);
  if (process.platform !== 'win32') {
    const capturedFile = capture.inputs[0].files[0];
    assert.equal((await stat(capturedFile)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(capturedFile))).mode & 0o777, 0o700);
    assert.equal((await stat(capture.captureDirectory)).mode & 0o777, 0o700);
  }
});

test('Story document capture scavenges a dead process lease without retaining source paths', async (t) => {
  const root = await captureRepository(t);
  const sourceDirectory = await mkdtemp(path.join(os.tmpdir(), 'sflow-dead-document-capture-'));
  t.after(() => rm(sourceDirectory, { recursive: true, force: true }));
  const source = path.join(sourceDirectory, 'private-brief.md');
  await writeFile(source, '# Exact private Story evidence\n');
  const moduleUrl = pathToFileURL(path.resolve('src/story-start-documents.mjs')).href;
  const child = spawnSync(process.execPath, [
    '--input-type=module', '--eval',
    `import { preflightInitialStoryDocuments } from ${JSON.stringify(moduleUrl)};
const capture = await preflightInitialStoryDocuments([{ files: [process.argv[2]] }], {
  repositoryRoot: process.argv[1]
});
process.stdout.write(JSON.stringify({ directory: capture.captureDirectory, file: capture.inputs[0].files[0] }));`,
    root, source
  ], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const abandoned = JSON.parse(child.stdout);
  const leaseBytes = await readFile(path.join(abandoned.directory, 'lease.json'), 'utf8');
  assert.equal(leaseBytes.includes(source), false, 'the cleanup lease must not retain the source path');
  assert.equal(
    abandoned.directory.startsWith(`${storyDocumentCaptureStorePath(root)}${path.sep}`),
    true
  );

  const result = await scavengeStoryDocumentCaptures(root);
  assert.deepEqual(result.removed, [path.basename(abandoned.directory)]);
  await assert.rejects(stat(abandoned.directory), (error) => error?.code === 'ENOENT');
});

test('Story document capture scavenger never follows an unleased direct-child symlink', async (t) => {
  const root = await captureRepository(t);
  const store = storyDocumentCaptureStorePath(root);
  await mkdir(store, { recursive: true, mode: 0o700 });
  const outside = await mkdtemp(path.join(os.tmpdir(), 'sflow-document-capture-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const sentinel = path.join(outside, 'must-remain.txt');
  await writeFile(sentinel, 'operator-owned bytes\n');
  const name = 'capture-11111111-1111-4111-8111-111111111111';
  await symlink(outside, path.join(store, name), 'dir');

  const result = await scavengeStoryDocumentCaptures(root, { staleAfterMs: 0 });
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.retained, [name]);
  assert.equal(await readFile(sentinel, 'utf8'), 'operator-owned bytes\n');
});

test('Story document publication refuses captured bytes replaced after preflight', async (t) => {
  const root = await repository();
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(`${root}.git`, { recursive: true, force: true })
  ]));
  const sourceDirectory = await mkdtemp(path.join(os.tmpdir(), 'sflow-captured-document-tamper-'));
  t.after(() => rm(sourceDirectory, { recursive: true, force: true }));
  const source = path.join(sourceDirectory, 'brief.md');
  await writeFile(source, '# Bound intake evidence\n');
  const capture = await preflightInitialStoryDocuments([{ files: [source] }], {
    repositoryRoot: root
  });
  t.after(() => capture.dispose());

  const created = await startStory(root, {
    id: 'WORK-CAPTURE-BINDING',
    source: manualStorySource('WORK-CAPTURE-BINDING', {
      title: 'Bind captured evidence',
      description: 'Reject any replacement after the intake snapshot.',
      acceptanceCriteria: 'Only the reviewed bytes can be staged.'
    }),
    workType: 'feature',
    baseBranch: 'main'
  });
  const capturedPath = capture.inputs[0].files[0];
  await writeFile(capturedPath, '# Replaced after preflight\n');
  const definition = await loadDefinition(root);

  await assert.rejects(
    () => stageInitialStoryDocuments(root, definition, created.workflow, {
      inputs: capture.inputs,
      requireFrozen: true
    }),
    (error) => error?.code === 'STORY_DOCUMENT_CHANGED'
  );
});

test('Story start refuses document storage excluded by Git ignore policy', async (t) => {
  const root = await repository();
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(`${root}.git`, { recursive: true, force: true })
  ]));
  await writeFile(path.join(root, '.gitignore'), 'singularity/work-items/*/inputs/\n');
  run('git', ['add', '.gitignore'], root);
  run('git', ['commit', '-m', 'ignore Story document inputs'], root);
  run('git', ['push', 'origin', 'main'], root);
  const sourceDirectory = await mkdtemp(path.join(os.tmpdir(), 'sflow-ignored-document-'));
  t.after(() => rm(sourceDirectory, { recursive: true, force: true }));
  const source = path.join(sourceDirectory, 'reviewed-evidence.md');
  await writeFile(source, 'must not be omitted from the governed commit\n');

  await assert.rejects(
    () => startStory(root, {
      id: 'WORK-IGNORED-DOCUMENT',
      source: manualStorySource('WORK-IGNORED-DOCUMENT', {
        title: 'Do not omit intake evidence',
        description: 'Fail before a commit can claim a Git-ignored supporting document.',
        acceptanceCriteria: 'The opening commit contains every manifest document.'
      }),
      workType: 'feature',
      baseBranch: 'main',
      files: [source]
    }),
    (error) => error?.code === 'STORY_DOCUMENT_GIT_IGNORED'
  );
  assert.equal(run('git', ['branch', '--show-current'], root).stdout.trim(), 'main');
  assert.equal(run('git', ['branch', '--list', 'WORK-IGNORED-DOCUMENT'], root).stdout.trim(), '');
});

test('Story start sanitizes a .git source name and commits the evidence blob', async (t) => {
  const root = await repository();
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(`${root}.git`, { recursive: true, force: true })
  ]));
  const sourceDirectory = await mkdtemp(path.join(os.tmpdir(), 'sflow-dot-git-document-'));
  t.after(() => rm(sourceDirectory, { recursive: true, force: true }));
  const source = path.join(sourceDirectory, '.git');
  const bytes = 'a source name must never make Git silently omit governed evidence\n';
  await writeFile(source, bytes);

  const created = await startStory(root, {
    id: 'WORK-DOT-GIT-DOCUMENT',
    source: manualStorySource('WORK-DOT-GIT-DOCUMENT', {
      title: 'Track every intake blob',
      description: 'Sanitize Git-reserved source names without losing provenance.',
      acceptanceCriteria: 'The evidence blob is present in the opening commit.'
    }),
    workType: 'feature',
    baseBranch: 'main',
    files: [source]
  });

  assert.equal(created.documents.length, 1);
  assert.match(created.documents[0].path, /\/document-git$/u);
  assert.equal(created.documents[0].sourceName, '.git');
  assert.equal(await readFile(path.join(root, created.documents[0].path), 'utf8'), bytes);
  assert.equal(
    run('git', ['cat-file', '-e', `HEAD:${created.documents[0].path}`], root).status,
    0,
    'the opening commit contains the exact manifest blob'
  );
});

test('FOS:AC-016 onboarding and Story intake avoid discovery, composition, AST and model launchers', async () => {
  const root = await repository({ configurationAuthority: true });
  const sourceDirectory = await mkdtemp(path.join(os.tmpdir(), 'sflow-desktop-story-source-'));
  const sourceFile = path.join(sourceDirectory, 'brief.md');
  await writeFile(sourceFile, '# Brief\nPinned desktop evidence.\n');
  const source = manualStorySource('WORK-901', {
    title: 'Add customer export',
    user: 'Operations analyst',
    description: 'Exports are assembled manually.',
    desiredOutcome: 'Create an auditable export.',
    inScope: 'Filtered records\nCSV download',
    outOfScope: 'Scheduled delivery',
    acceptanceCriteria: 'Authorized users can export\nUnauthorized users are denied',
    parentEpicId: 'EPIC-42'
  });
  const forbiddenLaunches = [];
  const gitShadowObservations = [];
  const forbiddenLauncher = async (name) => { forbiddenLaunches.push(name); };
  const forbiddenDependencies = {
    organizationEnumerator: () => forbiddenLauncher('organization-discovery'),
    sourceScanner: () => forbiddenLauncher('source-scan'),
    worldModelComposer: () => forbiddenLauncher('world-model-compose'),
    modelInvoker: () => forbiddenLauncher('model-invocation')
  };
  const attached = await onboardRepository(root, {
    remote: 'origin',
    ...forbiddenDependencies
  });
  assert.equal(attached.status, 'attached');
  let astWarmLaunch = null;
  const created = await startStory(root, {
    id: 'WORK-901',
    source,
    workType: 'feature',
    agent: 'product-owner',
    baseBranch: 'main',
    files: [sourceFile],
    urls: ['https://example.com/export-reference'],
    ...forbiddenDependencies,
    gitReadMode: 'shadow',
    onGitShadowComparison(value) { gitShadowObservations.push(value); },
    astWarmLauncher: (repositoryRoot, workId) => {
      astWarmLaunch = { repositoryRoot, workId };
      return { pid: 1234 };
    }
  });

  assert.equal(created.resumed, false);
  assert.equal(created.workId, 'WORK-901');
  assert.equal(created.documents.length, 2);
  assert.equal(created.astWarm.status, 'available-on-request');
  assert.equal(created.astWarm.blocking, false);
  assert.equal(created.astWarm.launched, false);
  assert.equal(astWarmLaunch, null);
  assert.deepEqual(forbiddenLaunches, []);
  assert.equal(gitShadowObservations.length, 1);
  assert.equal(gitShadowObservations[0].operation, 'story-start.repository-preflight');
  assert.equal(gitShadowObservations[0].outcome, 'equivalent');
  const status = JSON.parse(run(process.execPath, [
    path.resolve('bin/singularity-flow.mjs'), 'status', '--git-shadow', '--json'
  ], root).stdout);
  assert.equal(status.workItem.id, 'WORK-901');
  assert.deepEqual(status.gitShadow, {
    mode: 'shadow', authoritativePath: 'reference', comparisons: 1,
    equivalent: 1, semanticMismatch: 0, candidateError: 0, valuesRecorded: false
  });
  assert.equal(created.astWarm.command, 'singularity-flow wm ast build --all');
  const workRoot = path.join(root, 'singularity/work-items/WORK-901');
  const workflow = JSON.parse(await readFile(path.join(workRoot, 'workflow.json'), 'utf8'));
  assert.equal(workflow.workItem.source.type, 'manual');
  assert.equal(workflow.lineage.epicId, 'EPIC-42');
  const story = await readFile(path.join(workRoot, 'USER-STORY.md'), 'utf8');
  assert.match(story, /Operations analyst/);
  assert.match(story, /Authorized users can export/);
  const documents = JSON.parse(await readFile(path.join(workRoot, 'documents.json'), 'utf8'));
  assert.deepEqual(documents.documents.map((item) => item.type), ['file', 'url']);
  const log = run('git', ['log', '--format=%s'], root).stdout;
  assert.match(log, /\[WORK-901\]\[init\] start feature workflow/);
  assert.equal((log.match(/\[WORK-901\]\[documents\]\[upload\]/g) ?? []).length, 0,
    'initial evidence is part of the opening governed transaction, not a second commit');
  const opening = workflow.publicationProjections.find((entry) => entry.event?.type === 'binding');
  assert.equal(opening.event.payload.operation, 'supporting-document-upload');
  assert.deepEqual(opening.event.payload.documentIds, ['DOC-001', 'DOC-002']);
  assert.equal(opening.event.payload.documentSetSchemaVersion, 1);
  assert.equal(opening.event.payload.documentSetSha256, documentSetSha256(documents.documents));

  // Resume is governed by the Story's immutable pin. A newer checkout policy can reject the old
  // ID and the authority can be offline without changing what this already-created Story means.
  run('git', ['switch', 'main'], root);
  const currentDefinitionPath = path.join(root, 'singularity/workflow.yml');
  const currentDefinition = YAML.parse(await readFile(currentDefinitionPath, 'utf8'));
  currentDefinition.idPattern = '^NEW-[0-9]+$';
  await writeFile(currentDefinitionPath, YAML.stringify(currentDefinition));
  run('git', ['add', 'singularity/workflow.yml'], root);
  run('git', ['commit', '-m', 'Change policy for future Stories'], root);
  run('git', ['remote', 'set-url', 'origin', path.join(root, 'offline-authority.git')], root);
  const resumed = await startStory(root, {
    id: 'WORK-901',
    agent: 'developer'
  });
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.workflow.workItem.workType, 'feature');
});

test('Story opening refuses and rolls back a manifest or blob changed after state write', async (t) => {
  const root = await repository({ configurationAuthority: true });
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(`${root}.git`, { recursive: true, force: true })
  ]));
  const sourceDirectory = await mkdtemp(path.join(os.tmpdir(), 'sflow-document-publication-race-'));
  t.after(() => rm(sourceDirectory, { recursive: true, force: true }));
  const sourceFile = path.join(sourceDirectory, 'reviewed.md');
  await writeFile(sourceFile, '# Reviewed evidence\nThe opening commit must contain these bytes.\n');
  const beforeHead = run('git', ['rev-parse', 'HEAD'], root).stdout.trim();

  for (const [mode, expectedCode] of [
    ['blob', 'DOCUMENT_SET_BLOB_MISMATCH'],
    ['manifest', 'DOCUMENT_SET_MANIFEST_MISMATCH']
  ]) {
    const id = `WORK-DOCUMENT-${mode.toUpperCase()}-RACE`;
    await assert.rejects(
      () => startStory(root, {
        id,
        source: manualStorySource(id, {
          title: 'Bind the document publication tree',
          description: 'Refuse a destination replacement after the manifest is finalized.',
          acceptanceCriteria: 'Manifest identity and committed blob identity are coherent.'
        }),
        workType: 'feature',
        baseBranch: 'main',
        files: [sourceFile],
        publicationFault: async (stage, { envelope }) => {
          if (stage !== 'after-state-write') return;
          assert.match(envelope.payload.documentSetSha256, /^sha256:[a-f0-9]{64}$/u);
          const manifestFile = path.join(root, `singularity/work-items/${id}/documents.json`);
          const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
          if (mode === 'blob') {
            await writeFile(path.join(root, manifest.documents[0].path), 'replacement bytes from a watcher\n');
          } else {
            manifest.documents[0].label = 'replacement manifest identity';
            await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
          }
        }
      }),
      (error) => {
        assert.equal(error?.code, expectedCode, error?.stack);
        return true;
      }
    );

    assert.equal(run('git', ['branch', '--show-current'], root).stdout.trim(), 'main');
    assert.equal(run('git', ['rev-parse', 'HEAD'], root).stdout.trim(), beforeHead);
    assert.equal(run('git', ['branch', '--list', id], root).stdout.trim(), '');
    await assert.rejects(
      readFile(path.join(root, `singularity/work-items/${id}/documents.json`)),
      /ENOENT/
    );
  }
});

test('desktop Story intake freezes documents before mutation and a retry cannot duplicate them', async (t) => {
  const root = await repository({ configurationAuthority: true });
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(`${root}.git`, { recursive: true, force: true })
  ]));
  const sourceDirectory = await mkdtemp(path.join(os.tmpdir(), 'sflow-desktop-story-preflight-'));
  t.after(() => rm(sourceDirectory, { recursive: true, force: true }));
  const sourceFile = path.join(sourceDirectory, 'brief.md');
  const source = manualStorySource('WORK-DOC-PREFLIGHT', {
    title: 'Capture intake evidence',
    description: 'The Story must not exist without its requested evidence.',
    acceptanceCriteria: 'The evidence is committed exactly once.'
  });
  const originalHead = run('git', ['rev-parse', 'HEAD'], root).stdout.trim();

  await assert.rejects(
    () => startStory(root, {
      id: 'WORK-DOC-PREFLIGHT', source, workType: 'feature', baseBranch: 'main',
      urls: ['file:///tmp/not-a-governed-url']
    }),
    /Document URL must use http:\/\/ or https:\/\//
  );
  assert.equal(run('git', ['branch', '--show-current'], root).stdout.trim(), 'main');
  assert.equal(run('git', ['rev-parse', 'HEAD'], root).stdout.trim(), originalHead);

  await assert.rejects(
    () => startStory(root, {
      id: 'WORK-DOC-PREFLIGHT', source, workType: 'feature', baseBranch: 'main', files: [sourceFile]
    }),
    /Document path is not a regular file or directory/
  );
  assert.equal(run('git', ['branch', '--show-current'], root).stdout.trim(), 'main');
  assert.equal(run('git', ['rev-parse', 'HEAD'], root).stdout.trim(), originalHead);
  assert.equal(run('git', ['branch', '--list', 'WORK-DOC-PREFLIGHT'], root).stdout.trim(), '');
  await assert.rejects(
    readFile(path.join(root, 'singularity/work-items/WORK-DOC-PREFLIGHT/workflow.json')),
    /ENOENT/
  );

  const capturedBytes = '# Evidence\nThe bytes captured before Story publication.\n';
  // This endpoint is deliberately unreachable. Story intake records URL references but must never
  // fetch them during either preflight pass.
  const referenceUrl = 'https://127.0.0.1:1/reference';
  await writeFile(sourceFile, capturedBytes);
  const created = await startStory(root, {
    id: 'WORK-DOC-PREFLIGHT', source, workType: 'feature', baseBranch: 'main',
    files: [sourceFile], urls: [referenceUrl],
    afterPublicationPreflight: async () => {
      await writeFile(sourceFile, '# Mutated after preflight\nThese bytes must not enter the Story.\n');
    }
  });
  assert.equal(created.documents.length, 2);
  assert.equal(await readFile(path.join(root, created.documents[0].path), 'utf8'), capturedBytes);
  assert.equal(created.documents[1].url, referenceUrl);
  await rm(sourceFile);
  const resumed = await startStory(root, {
    id: 'WORK-DOC-PREFLIGHT', source, workType: 'feature', baseBranch: 'main',
    files: [sourceFile], urls: [referenceUrl]
  });
  assert.equal(resumed.resumed, true, 'an already durable Story resumes without rereading old inputs');
  const manifest = JSON.parse(await readFile(
    path.join(root, 'singularity/work-items/WORK-DOC-PREFLIGHT/documents.json'), 'utf8'
  ));
  assert.equal(manifest.documents.length, 2);
  assert.equal(manifest.documents[1].url, referenceUrl,
    'the explicit URL survives the corrected retry and is not silently skipped');
  const log = run('git', ['log', '--format=%s'], root).stdout;
  assert.equal((log.match(/\[WORK-DOC-PREFLIGHT\]\[documents\]\[upload\]/g) ?? []).length, 0);
  assert.equal((log.match(/\[WORK-DOC-PREFLIGHT\]\[init\] start feature workflow/g) ?? []).length, 1);
});

test('Story authority resolution refuses a configured remote whose URL cannot be read', async (t) => {
  const root = await repository();
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(`${root}.git`, { recursive: true, force: true })
  ]));
  run('git', ['config', '--unset-all', 'remote.origin.url'], root);
  await assert.rejects(
    () => resolveStoryConfigurationAuthority(root, 'origin'),
    (error) => {
      assert.equal(error?.code, 'STORY_CONFIGURATION_AUTHORITY_UNAVAILABLE');
      assert.match(error.message, /no readable fetch URL/);
      return true;
    }
  );
  await assert.rejects(
    () => startStory(root, {
      id: 'WORK-UNREADABLE-REMOTE',
      source: manualStorySource('WORK-UNREADABLE-REMOTE', { title: 'Do not fall through' }),
      workType: 'feature'
    }),
    (error) => error?.code === 'STORY_CONFIGURATION_AUTHORITY_UNAVAILABLE'
  );
  assert.equal(run('git', ['branch', '--list', 'WORK-UNREADABLE-REMOTE'], root).stdout.trim(), '');
});

test('desktop resume fails closed when the immutable Story pin is missing or corrupt', async (t) => {
  const root = await repository({ configurationAuthority: true });
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(`${root}.git`, { recursive: true, force: true })
  ]));
  for (const mode of ['missing', 'corrupt']) {
    const id = `WORK-PIN-${mode.toUpperCase()}`;
    await startStory(root, {
      id,
      source: manualStorySource(id, { title: `Pinned Story ${mode}` }),
      workType: 'feature',
      baseBranch: 'main'
    });
    const pin = path.join(root, 'singularity/configuration-source.json');
    if (mode === 'missing') await rm(pin);
    else await writeFile(pin, '{corrupt pin\n');
    run('git', ['add', '-A'], root);
    run('git', ['commit', '-m', `${mode} immutable Story pin`], root);
    run('git', ['switch', 'main'], root);
    await assert.rejects(
      () => startStory(root, { id }),
      (error) => {
        assert.equal(error?.code, 'STORY_CONFIGURATION_PIN_INVALID', error?.stack);
        return true;
      }
    );
    assert.equal(run('git', ['branch', '--show-current'], root).stdout.trim(), 'main',
      'a refused resume restores the stable checkout');
  }
});

test('desktop Story intake never substitutes a local workflow for an unreadable authority', async (t) => {
  const root = await repository();
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(`${root}.git`, { recursive: true, force: true })
  ]));
  run('git', ['remote', 'set-url', 'origin', path.join(path.dirname(root), 'missing-authority.git')], root);
  const beforeHead = run('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const beforeStatus = run('git', ['status', '--porcelain=v1'], root).stdout;

  await assert.rejects(
    () => startStory(root, {
      id: 'WORK-OFFLINE-AUTHORITY',
      source: manualStorySource('WORK-OFFLINE-AUTHORITY', { title: 'Refuse stale policy' }),
      workType: 'chore',
      baseBranch: 'main'
    }),
    /Cannot reach Story configuration authority/
  );
  assert.equal(run('git', ['rev-parse', 'HEAD'], root).stdout.trim(), beforeHead);
  assert.equal(run('git', ['status', '--porcelain=v1'], root).stdout, beforeStatus);
  assert.equal(run('git', ['branch', '--list', 'WORK-OFFLINE-AUTHORITY'], root).stdout.trim(), '');
});

test('Story start refuses a remote retarget after its push authority is captured', async () => {
  const root = await repository();
  const definitionPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.git.publish = 'required';
  await writeFile(definitionPath, YAML.stringify(definition));
  run('git', ['add', 'singularity/workflow.yml'], root);
  run('git', ['commit', '-m', 'Require Story publication'], root);
  run('git', ['push', 'origin', 'main'], root);
  const originalRemote = run('git', ['remote', 'get-url', '--push', 'origin'], root).stdout.trim();
  const alternate = `${root}-alternate.git`;
  run('git', ['init', '--bare', '-b', 'main', alternate], root);
  const originalHead = run('git', ['rev-parse', 'HEAD'], root).stdout.trim();

  await assert.rejects(
    () => startStory(root, {
      id: 'WORK-AUTHORITY-RACE',
      source: manualStorySource('WORK-AUTHORITY-RACE', { title: 'Authority race' }),
      workType: 'feature',
      baseBranch: 'main',
      afterPublicationAuthorityCapture: () => {
        run('git', ['remote', 'set-url', 'origin', alternate], root);
      }
    }),
    (error) => error?.code === 'PUBLICATION_REMOTE_AUTHORITY_CHANGED'
  );
  assert.equal(run('git', ['branch', '--show-current'], root).stdout.trim(), 'main');
  assert.equal(run('git', ['rev-parse', 'HEAD'], root).stdout.trim(), originalHead);
  for (const authority of [originalRemote, alternate]) {
    assert.notEqual(spawnSync('git', [
      '--git-dir', authority, 'show-ref', '--verify', '--quiet',
      'refs/heads/WORK-AUTHORITY-RACE'
    ]).status, 0);
  }
});

test('Story intake pins refreshed remote configuration and world-model files from a named corporate remote', async () => {
  const source = await repository();
  const initialDefinitionPath = path.join(source, 'singularity/workflow.yml');
  const initialDefinition = YAML.parse(await readFile(initialDefinitionPath, 'utf8'));
  initialDefinition.git.remote = 'company';
  await writeFile(initialDefinitionPath, YAML.stringify(initialDefinition));
  run('git', ['add', 'singularity/workflow.yml'], source);
  run('git', ['commit', '-m', 'Configure corporate remote'], source);

  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-desktop-story-remote-'));
  const remote = path.join(base, 'company.git');
  const clone = path.join(base, 'clone');
  run('git', ['clone', '--bare', source, remote], base);
  run('git', ['clone', remote, clone], base);
  run('git', ['remote', 'rename', 'origin', 'company'], clone);
  run('git', ['config', 'user.name', 'Desktop Story Tester'], clone);
  run('git', ['config', 'user.email', 'desktop-story@example.com'], clone);

  // Another contributor publishes both a newer phase profile and the repository model. The local
  // clone intentionally keeps its main branch behind.
  const refreshed = YAML.parse(await readFile(initialDefinitionPath, 'utf8'));
  refreshed.workTypes.chore.label = 'Remote governed chore';
  await writeFile(initialDefinitionPath, YAML.stringify(refreshed));
  await mkdir(path.join(source, 'singularity/world-model'), { recursive: true });
  await writeFile(path.join(source, 'singularity/world-model/manifest.json'), '{"schema_version":"2.0","marker":"remote"}\n');
  run('git', ['add', 'singularity/workflow.yml', 'singularity/world-model/manifest.json'], source);
  run('git', ['commit', '-m', 'Publish refreshed configuration and world model'], source);
  run('git', ['push', remote, 'main'], source);

  const started = await startStory(clone, {
    id: 'WORK-REMOTE-1',
    source: manualStorySource('WORK-REMOTE-1', { title: 'Use refreshed governance' }),
    workType: 'chore',
    baseBranch: 'main'
  });
  assert.equal(started.workflow.workItem.workTypeLabel, 'Remote governed chore');
  assert.match(await readFile(path.join(clone, 'singularity/world-model/manifest.json'), 'utf8'), /"marker":"remote"/);
});

test('desktop new Story uses current authority instead of an older Story workflow remote', async (t) => {
  const root = await repository({ configurationAuthority: true });
  const authorityRemote = `${root}.git`;
  const publisher = await mkdtemp(path.join(os.tmpdir(), 'sflow-desktop-current-authority-'));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(authorityRemote, { recursive: true, force: true }),
    rm(publisher, { recursive: true, force: true })
  ]));
  run('git', ['clone', '-q', '-b', 'sflow/config', authorityRemote, publisher], root);
  run('git', ['config', 'user.name', 'Configuration Publisher'], publisher);
  run('git', ['config', 'user.email', 'publisher@example.com'], publisher);
  const workflowFile = path.join(publisher, 'singularity/workflow.yml');
  const oldDefinition = YAML.parse(await readFile(workflowFile, 'utf8'));
  oldDefinition.git.remote = 'obsolete';
  oldDefinition.git.publish = 'off';
  oldDefinition.approvalSecurity.autoEnrollNewIdentities = false;
  await writeFile(workflowFile, YAML.stringify(oldDefinition));
  run('git', ['add', 'singularity/workflow.yml'], publisher);
  run('git', ['commit', '-qm', 'publish old Story destination'], publisher);
  run('git', ['push', '-q', 'origin', 'sflow/config'], publisher);
  run('git', ['remote', 'add', 'obsolete', authorityRemote], root);

  const oldStory = await startStory(root, {
    id: 'WORK-OLD-REMOTE',
    source: manualStorySource('WORK-OLD-REMOTE', { title: 'Pin the old destination' }),
    workType: 'feature',
    baseBranch: 'main'
  });
  assert.equal(oldStory.base.remote, 'obsolete');

  const currentDefinition = YAML.parse(await readFile(workflowFile, 'utf8'));
  currentDefinition.git.remote = 'company';
  await writeFile(workflowFile, YAML.stringify(currentDefinition));
  run('git', ['add', 'singularity/workflow.yml'], publisher);
  run('git', ['commit', '-qm', 'publish current Story destination'], publisher);
  run('git', ['push', '-q', 'origin', 'sflow/config'], publisher);
  const currentAuthorityCommit = run('git', ['rev-parse', 'HEAD'], publisher).stdout.trim();
  run('git', ['remote', 'add', 'company', authorityRemote], root);
  run('git', ['remote', 'remove', 'obsolete'], root);
  run('git', ['remote', 'remove', 'origin'], root);

  const currentStory = await startStory(root, {
    id: 'WORK-CURRENT-REMOTE',
    source: manualStorySource('WORK-CURRENT-REMOTE', { title: 'Use current authority' }),
    workType: 'feature',
    baseBranch: 'main'
  });
  assert.equal(currentStory.resumed, false);
  assert.equal(currentStory.base.remote, 'company');
  assert.equal(currentStory.workflow.resolution.configurationSource.commit,
    currentAuthorityCommit);
});

test('POC Story intake requires and durably pins the authorized browser origin', async () => {
  const root = await repository({ configurationAuthority: true });
  const source = manualStorySource('POC-901', { title: 'Generate staging regression coverage' });

  await assert.rejects(() => startStory(root, {
    id: 'POC-901', source, workType: 'poc-workflow', baseBranch: 'main'
  }), /POC target URL is required/);

  const created = await startStory(root, {
    id: 'POC-901', source, workType: 'poc-workflow', baseBranch: 'main',
    targetUrl: 'https://staging.example.test/application/start'
  });
  assert.equal(created.resumed, false);
  assert.equal(created.workflow.workItem.source.targetOrigin, 'https://staging.example.test');
  assert.deepEqual(created.workflow.mcpAuthorizations.playwright.origins, ['https://staging.example.test']);

  const resumed = await startStory(root, {
    id: 'POC-901', source: manualStorySource('POC-901', { title: 'Existing POC' }),
    workType: 'poc-workflow'
  });
  assert.equal(resumed.resumed, true);
  assert.deepEqual(resumed.workflow.mcpAuthorizations.playwright.origins, ['https://staging.example.test']);
});

test('desktop Story intake publishes every capability repository and returns a recoverable result', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-desktop-capability-story-'));
  const workspaceRoot = path.join(base, 'workspace');
  const repositoriesRoot = path.join(workspaceRoot, 'repos');
  await mkdir(repositoriesRoot, { recursive: true });
  const createRepository = async (id, { governed = false } = {}) => {
    const source = path.join(repositoriesRoot, id);
    const remote = path.join(base, `${id}.git`);
    await mkdir(source, { recursive: true });
    run('git', ['init', '-b', 'main'], source);
    run('git', ['config', 'user.name', 'Desktop Story Tester'], source);
    run('git', ['config', 'user.email', 'desktop-story@example.com'], source);
    await writeFile(path.join(source, 'README.md'), `# ${id}\n`);
    if (governed) run(process.execPath, [path.resolve('bin/singularity-flow.mjs'), 'init'], source);
    run('git', ['add', '.'], source);
    run('git', ['commit', '-m', 'initial'], source);
    run('git', ['init', '--bare', '-b', 'main', remote], source);
    run('git', ['remote', 'add', 'origin', remote], source);
    run('git', ['push', '-u', 'origin', 'main'], source);
    return { id, source, remote };
  };
  const lead = await createRepository('lead', { governed: true });
  const sibling = await createRepository('sibling');
  await writeFile(path.join(lead.source, 'singularity/capabilities.yml'), YAML.stringify({
    version: 1,
    capabilities: {
      payments: {
        name: 'Payments', kind: 'delivery', parent: null,
        repositories: ['lead', 'sibling'], leadRepository: 'lead', policy: {}
      }
    }
  }));
  const portfolioPath = path.join(lead.source, 'singularity/portfolio.yml');
  const portfolio = YAML.parse(await readFile(portfolioPath, 'utf8'));
  portfolio.repositories = {
    lead: { url: lead.remote, defaultBranch: 'main', required: true },
    sibling: { url: sibling.remote, defaultBranch: 'main', required: true }
  };
  await writeFile(portfolioPath, YAML.stringify(portfolio));
  run('git', ['add', 'singularity/capabilities.yml', 'singularity/portfolio.yml'], lead.source);
  run('git', ['commit', '-m', 'map payments capability'], lead.source);
  run('git', ['push', 'origin', 'main'], lead.source);

  await writeFile(path.join(workspaceRoot, 'workspace.json'), `${JSON.stringify({
    version: 1,
    id: 'local--payments',
    name: 'Payments workspace',
    anchor: { provider: 'workspace', siteId: 'local', key: 'payments', title: 'Payments workspace' },
    leadRepository: 'lead',
    repositories: {
      lead: { id: 'lead', url: lead.remote, defaultBranch: 'main', required: true, path: 'repos/lead', capabilities: ['payments'], clone: { mode: 'full', sparseCone: [], fallback: 'refuse' } },
      sibling: { id: 'sibling', url: sibling.remote, defaultBranch: 'main', required: true, path: 'repos/sibling', capabilities: ['payments'], clone: { mode: 'full', sparseCone: [], fallback: 'refuse' } }
    },
    capabilities: ['payments'],
    directories: { repositories: 'repos', documents: 'documents', logs: 'logs', jiraCache: 'cache/jira' },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  }, null, 2)}\n`);
  const selection = path.join(base, 'active-workspace.json');
  const registry = path.join(base, 'workspaces.json');
  await writeFile(registry, '{"schemaVersion":1,"workspaces":[]}\n');
  await writeFile(selection, `${JSON.stringify({
    schemaVersion: 1, workspaceId: 'local--payments', workspaceName: 'Payments workspace',
    workspacePath: workspaceRoot, anchorKey: 'payments', repositoryId: 'lead',
    repositoryPath: lead.source, repositoryState: 'ready', branch: 'main',
    capabilities: ['payments'], repositoryCapabilities: ['payments'], selectedAt: new Date().toISOString()
  })}\n`);
  const previousSelection = process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE;
  const previousRegistry = process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY;
  process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE = selection;
  process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = registry;
  try {
    const started = await startStory(lead.source, {
      id: 'WORK-CAP-1',
      source: manualStorySource('WORK-CAP-1', { title: 'Coordinate capability change' }),
      workType: 'feature', baseBranch: 'main', capabilityId: 'payments'
    });
    assert.deepEqual(started.capabilityPublication.pending, []);
    assert.deepEqual(started.capabilityPublication.published.map((entry) => entry.repository), ['sibling']);
    assert.match(run('git', ['ls-remote', sibling.remote, 'refs/heads/WORK-CAP-1'], sibling.source).stdout, /refs\/heads\/WORK-CAP-1/);
  } finally {
    if (previousSelection == null) delete process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE;
    else process.env.SINGULARITY_FLOW_ACTIVE_WORKSPACE = previousSelection;
    if (previousRegistry == null) delete process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY;
    else process.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY = previousRegistry;
  }
});

test('manual Story source requires only a Work ID and title while normalizing optional lists', () => {
  const source = manualStorySource('LOCAL-2', {
    title: 'Small local Story',
    constraints: 'One\n\nTwo',
    acceptanceCriteria: ''
  });
  assert.equal(source.id, 'LOCAL-2');
  assert.deepEqual(source.constraints, ['One', 'Two']);
  assert.deepEqual(source.acceptanceCriteria, []);
  assert.throws(() => manualStorySource('LOCAL-3', {}), /Story title/);
});
