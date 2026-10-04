import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('JSON refusals use stdout exactly once and retain a failing process exit', () => {
  const entry = new URL('../src/cli-failure.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { reportCliFailure } from ${JSON.stringify(entry)};
     await reportCliFailure(Object.assign(new Error('example refusal'), {code:'EXAMPLE_REFUSAL'}), ['start','--json']);`
  ], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).error.code, 'EXAMPLE_REFUSAL');
});

test('human refusals keep stderr and the optional structured side channel', () => {
  const entry = new URL('../src/cli-failure.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { reportCliFailure } from ${JSON.stringify(entry)};
     await reportCliFailure(new Error('example refusal'), ['start']);`
  ], { encoding: 'utf8', env: { ...process.env, SINGULARITY_FLOW_REFUSAL_ENVELOPE: 'stderr-v1' } });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /structured refusal v1/);
});

test('late JSON refusals discard review prose; successful output is preserved byte for byte', () => {
  const boundary = new URL('../src/cli-json-output.mjs', import.meta.url).href;
  const failure = new URL('../src/cli-failure.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { withCliJsonOutput } from ${JSON.stringify(boundary)};
    import { reportCliFailure } from ${JSON.stringify(failure)};
    await withCliJsonOutput(true, async () => {
      console.log('review shown before the gate'); process.stdout.write('partial');
      throw Object.assign(new Error('late gate'), { code: 'LATE_GATE' });
    }).catch(error => reportCliFailure(error, ['approve', '--json']));
  `], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).error.code, 'LATE_GATE');
  assert.doesNotMatch(result.stdout, /review shown|partial/);
  const success = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { withCliJsonOutput } from ${JSON.stringify(boundary)};
    await withCliJsonOutput(true, async () => { process.stdout.write('{"ok":'); console.log('true}'); });
  `], { encoding: 'utf8' });
  assert.equal(success.status, 0);
  assert.equal(success.stdout, '{"ok":true}\n');
});
