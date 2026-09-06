import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  machineSelectionRevision, MAX_MACHINE_SELECTION_BYTES
} from '../apps/vscode/src/machine-selection-revision.ts';

test('machine selection revision detects only byte changes and represents absence exactly', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-machine-selection-'));
  const file = path.join(root, 'active-workspace.json');
  try {
    assert.equal(await machineSelectionRevision(file), null);
    await writeFile(file, '{"workspaceId":"one"}\n', 'utf8');
    const first = await machineSelectionRevision(file);
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(await machineSelectionRevision(file), first);
    await writeFile(file, '{"workspaceId":"two"}\n', 'utf8');
    assert.notEqual(await machineSelectionRevision(file), first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('machine selection revision fails open to the CLI for unsafe records', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-machine-selection-unsafe-'));
  const file = path.join(root, 'active-workspace.json');
  try {
    await writeFile(file, Buffer.alloc(MAX_MACHINE_SELECTION_BYTES + 1));
    assert.equal(await machineSelectionRevision(file), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
