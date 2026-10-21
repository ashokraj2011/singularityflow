import assert from 'node:assert/strict';
import test from 'node:test';
import { creationConfiguration, creationConfigurationOwner, withCreationContext } from '../src/creation-context.mjs';

const authority = { remote: 'https://example.invalid/repository', branch: 'sflow/config', commit: 'a'.repeat(40) };
const options = { env: { PATH: '/fixture' }, captureAuthoringBytes: false };
const snapshot = () => ({ assets: [{ contents: Buffer.from('approved') }], valid: true });
const verify = value => assert.equal(value.valid, true);

test('one creation shares only the exact successful capture and closes ownership after failures', async () => {
  let calls = 0, frame;
  const load = async () => { calls++; return snapshot(); };
  await withCreationContext(async () => {
    frame = creationConfigurationOwner();
    const [first, second] = await Promise.all([0, 1].map(() => creationConfiguration(authority, options, load, verify)));
    assert.equal(first, second);
    await withCreationContext(() => creationConfiguration(authority, options, load, verify));
    assert.equal(calls, 1);
    await creationConfiguration({ ...authority, commit: 'b'.repeat(40) }, options, load, verify);
    await creationConfiguration(authority, { ...options, captureAuthoringBytes: true }, load, verify);
    await creationConfiguration(authority, { ...options, env: { PATH: '/other' } }, load, verify);
    assert.equal(calls, 4);
    first.valid = false;
    await assert.rejects(creationConfiguration(authority, options, load, verify));
  });
  assert.equal(frame.active, false);
  assert.equal(frame.configurations.size, 0);
  await creationConfiguration(authority, options, load, verify);
  assert.equal(calls, 5, 'no cross-invocation permission or snapshot cache');
});

test('failed capture retries honestly and parallel requests have independent cleanup', async () => {
  let calls = 0, cleaned = 0;
  await Promise.all([0, 1].map(() => withCreationContext(async () => {
    creationConfigurationOwner(async () => { cleaned++; }).directories.add('owned');
    await assert.rejects(creationConfiguration(authority, options, async () => { throw new Error('network deadline'); }, verify), /network deadline/);
    await creationConfiguration(authority, options, async () => { calls++; return snapshot(); }, verify);
  })));
  assert.equal(calls, 2); assert.equal(cleaned, 2);
});
