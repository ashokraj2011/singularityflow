import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { operationCatalog, resolveOperation, validateOperationRegistry } from '../src/command-registry.mjs';
import { evaluateExternalCommandForModelMode, normalizeExternalCommand } from '../src/external-command-policy.mjs';
import { importManualArtifact, inspectInPlaceArtifact, normalizeAuthorshipOptions } from '../src/manual-authorship.mjs';
import { invokeModel } from '../src/model-runner.mjs';
import { withOperationContext } from '../src/operation-context.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = path.join(root, 'bin', 'singularity-flow.mjs');

test('every public operation has an explicit model policy and valid fallback', () => {
  assert.equal(validateOperationRegistry(), true);
  const catalog = operationCatalog();
  assert.ok(catalog.length > 80);
  assert.ok(catalog.every((entry) => ['never', 'optional', 'required'].includes(entry.modelPolicy)));
  assert.equal(resolveOperation({ requestedCommand: 'status', positionals: ['status'] }).modelPolicy, 'never');
  assert.equal(resolveOperation({ requestedCommand: 'wm', positionals: ['wm', 'light'] }).modelPolicy, 'never');
  assert.equal(resolveOperation({ requestedCommand: 'wm', positionals: ['wm', 'availability'] }).modelPolicy, 'never');
  assert.equal(resolveOperation({ requestedCommand: 'wm', positionals: ['wm', 'status'] }).modelPolicy, 'never');
  assert.equal(resolveOperation({ requestedCommand: 'wm', positionals: ['wm', 'build'] }).modelPolicy, 'required');
  const ensure = resolveOperation({ requestedCommand: 'wm', positionals: ['wm', 'ensure'] });
  assert.equal(ensure.modelPolicy, 'optional');
  assert.equal(ensure.fallback.operationId, 'wm.light');
  const next = resolveOperation({ requestedCommand: 'next', positionals: ['next'] });
  assert.equal(next.modelPolicy, 'optional');
  assert.equal(next.fallback.operationId, 'next.model-free');
  // Still refused before a handler loads, which is the property this file cares about; the message
  // is now the reader's problem rather than the registry's invariant.
  assert.throws(() => resolveOperation({ requestedCommand: 'wm', positionals: ['wm', 'surprise'] }), /'wm' has no subcommand 'surprise'/);
});

test('model-disabled required operations fail before loading their handler and name the fallback', () => {
  const result = spawnSync(process.execPath, [executable, '--no-model', 'wm', 'build'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires a model/);
  assert.match(result.stderr, /singularity-flow wm light/);
});

test('a never-model parent operation forbids nested model invocation', async () => {
  await assert.rejects(() => withOperationContext({
    operation: { id: 'test.never', modelPolicy: 'never' },
    modelMode: { enabled: true }, root, command: 'test'
  }, () => invokeModel({ cwd: root, prompt: { text: 'must not execute' } })), /forbids model execution/);
});

test('external commands are classified and model-disabled behavior is deterministic', () => {
  assert.deepEqual(normalizeExternalCommand({ id: 'lint', argv: ['npm', 'run', 'lint'], modelPolicy: 'never' }), {
    id: 'lint', argv: ['npm', 'run', 'lint'], command: null, modelPolicy: 'never', requirement: 'required', timeoutMs: null
  });
  assert.equal(normalizeExternalCommand({
    id: 'browser', argv: ['npm', 'test'], modelPolicy: 'never', timeoutMs: 60_000
  }).timeoutMs, 60_000);
  assert.throws(() => normalizeExternalCommand({
    id: 'browser', argv: ['npm', 'test'], modelPolicy: 'never', timeoutMs: 10
  }), /timeoutMs/);
  assert.equal(evaluateExternalCommandForModelMode('opaque command', { modelEnabled: false }).action, 'skip');
  assert.equal(evaluateExternalCommandForModelMode('opaque command', { modelEnabled: false, unknownStrictness: 'block' }).action, 'block');
  assert.equal(evaluateExternalCommandForModelMode({ id: 'review', command: 'review-tool', modelPolicy: 'required' }, { modelEnabled: false }).action, 'block');
  assert.equal(normalizeExternalCommand({ id: 'hint', argv: ['hint'], requirement: 'advisory' }).requirement, 'advisory');
  assert.throws(() => normalizeExternalCommand({ id: 'bad', argv: ['bad'], requirement: 'optional' }), /requirement/);
});

test('manual artifact import preserves binary bytes, strips managed text metadata, and rejects symlinks', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-manual-'));
  const source = path.join(directory, 'source.md');
  const target = path.join(directory, 'target.md');
  await writeFile(source, '<!-- singularity-flow:metadata\nold\n-->\n# Decision\n\nApproved.\n');
  const imported = await importManualArtifact({
    sourcePath: source, targetPath: target,
    contract: { minimumBytes: 10, allowedExtensions: ['.md'], allowedMediaTypes: ['text/markdown'], validation: { requiredHeadings: ['Decision'] } }
  });
  assert.equal(imported.kind, 'import');
  assert.equal(await readFile(target, 'utf8'), '# Decision\n\nApproved.\n');

  const binarySource = path.join(directory, 'proof.png');
  const binaryTarget = path.join(directory, 'proof-copy.png');
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10]);
  await writeFile(binarySource, bytes);
  await importManualArtifact({ sourcePath: binarySource, targetPath: binaryTarget, contract: { allowedExtensions: ['.png'], allowedMediaTypes: ['image/png'] } });
  assert.deepEqual(await readFile(binaryTarget), bytes);
  assert.equal((await inspectInPlaceArtifact(binaryTarget, { allowedMediaTypes: ['image/png'] })).bytes, bytes.length);

  const link = path.join(directory, 'linked.md');
  await symlink(source, link);
  await assert.rejects(() => importManualArtifact({ sourcePath: link, targetPath: target, contract: {} }), /symbolic link/);
  assert.throws(() => normalizeAuthorshipOptions({ producer: 'human', channel: 'kernel-model' }), /incompatible/);
});
