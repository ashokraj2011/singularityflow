import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sha256 } from '../src/world-model/canonicalize.mjs';
import {
  PROJECTION_INPUT_RECORDS, assertProjectionRefusalInputBindings,
  requestedProjectionInputRecords, verifyProjectionInputRecords
} from '../src/world-model/projections/inputs.mjs';
import {
  createArchitectureCapabilitySnapshot, createArchitectureConfigurationSnapshot
} from '../src/world-model/projections/calm/projection.mjs';
import { createCalmToolchainLock } from '../src/world-model/projections/calm/validator.mjs';
import {
  resolveCurrentArchitectureProjectionSnapshots
} from '../src/world-model/projections/calm/authority.mjs';

async function fixture() {
  const records = {
    capabilitySnapshot: createArchitectureCapabilitySnapshot({ capabilities: {
      app: { kind: 'delivery', architecture: { nodeType: 'webclient' } }
    } }),
    configurationSnapshot: createArchitectureConfigurationSnapshot({}),
    toolchainLock: (await createCalmToolchainLock()).lock
  };
  const request = Object.fromEntries(PROJECTION_INPUT_RECORDS.map((input) => [
    input.digest, records[input.field][input.hash]
  ]));
  return { records, request };
}

test('optional setup and runtime failures retain precisely their sealed inputs, including partial setup', async () => {
  const { records, request } = await fixture();
  for (let mask = 0; mask < 8; mask += 1) {
    const partialRequest = {};
    const partialRecords = {};
    const selected = PROJECTION_INPUT_RECORDS.filter((_input, index) => (mask & (1 << index)) !== 0);
    for (const input of PROJECTION_INPUT_RECORDS) {
      const present = selected.includes(input);
      partialRequest[input.digest] = present ? request[input.digest] : null;
      partialRecords[input.field] = present ? records[input.field] : null;
    }
    assert.deepEqual(requestedProjectionInputRecords(partialRequest), selected);
    const verified = verifyProjectionInputRecords(partialRequest, partialRecords);
    for (const input of PROJECTION_INPUT_RECORDS) {
      assert.deepEqual(verified[input.field], partialRecords[input.field]);
    }
    if (mask !== 7) assert.throws(
      () => verifyProjectionInputRecords(partialRequest, partialRecords, { requireComplete: true }),
      (error) => error.code === 'WMB_PUBLICATION_PARTIAL'
    );
  }
  assert.deepEqual(verifyProjectionInputRecords(request, records, { requireComplete: true }), records);
});

test('bound records cannot disappear and absent setup inputs cannot acquire undeclared bytes', async () => {
  const { records, request } = await fixture();
  for (const input of PROJECTION_INPUT_RECORDS) {
    assert.throws(() => verifyProjectionInputRecords(request, {
      ...records, [input.field]: null
    }), (error) => error.code === 'WMB_PUBLICATION_PARTIAL' && error.details.field === input.digest);
    assert.throws(() => verifyProjectionInputRecords({
      ...request, [input.digest]: null
    }, records), (error) => error.code === 'WMB_PUBLICATION_PARTIAL' && error.details.field === input.digest);
    assert.throws(() => verifyProjectionInputRecords({
      ...request, [input.digest]: sha256('another attempt')
    }, records), (error) => error.code === 'WMB_PUBLICATION_PARTIAL' && error.details.field === input.digest);
    assert.throws(() => requestedProjectionInputRecords({
      ...request, [input.digest]: 'not-a-hash'
    }));
  }
});

test('a refusal must preserve all source, scope, ledger and projection input identities exactly', async () => {
  const { request } = await fixture();
  const context = {
    request, sourceSnapshot: { sourceManifestSha256: sha256('source') },
    scopeManifest: { scopeSha256: sha256('scope') }, factLedger: { ledgerSha256: sha256('facts') }
  };
  const preserved = {
    ...request, sourceManifestSha256: context.sourceSnapshot.sourceManifestSha256,
    scopeSha256: context.scopeManifest.scopeSha256, factLedgerSha256: context.factLedger.ledgerSha256
  };
  assert.doesNotThrow(() => assertProjectionRefusalInputBindings({ preserved }, context));
  for (const field of Object.keys(preserved)) {
    assert.throws(() => assertProjectionRefusalInputBindings({ preserved: {
      ...preserved, [field]: sha256('another build')
    } }, context), (error) => error.code === 'WMB_PUBLICATION_PARTIAL' && error.details.field === field);
  }
});

test('authority revalidation reads only the snapshots actually bound during partial setup', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-calm-input-authority-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'singularity'));
  const source = 'mode: governed\n';
  await writeFile(path.join(root, 'singularity', 'workflow.yml'), source);
  const configurationOnly = await resolveCurrentArchitectureProjectionSnapshots(root, {
    mode: 'governed'
  }, { capability: false });
  assert.equal(configurationOnly.capabilitySnapshot, null);
  assert.deepEqual(configurationOnly.configurationSnapshot, createArchitectureConfigurationSnapshot({
    mode: 'governed'
  }, { sourceSha256: sha256({ utf8: source }) }));
  await rm(path.join(root, 'singularity', 'workflow.yml'));
  assert.deepEqual(await resolveCurrentArchitectureProjectionSnapshots(root, null, {
    capability: false, configuration: false
  }), { capabilitySnapshot: null, configurationSnapshot: null });
});
