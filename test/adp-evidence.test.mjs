/**
 * Routing leaves a receipt. `[ADP:REQ-040]` `[ADP:REQ-032]` `[ADP:BEH-001]`
 *
 * Routing by task is only worth doing if you can afterwards ask which model actually did which kind
 * of work — that is the question the whole specification exists to make answerable. So every
 * invocation records the task it was asked for, the mapping revision that answered, the model that
 * resolved, and the parameters that went with it.
 *
 * Driven through the real chokepoint against a real provider process rather than asserted about the
 * source, because "the field is written" and "the field is written with the right value" are
 * different claims and only one of them is useful.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { invokeModel } from '../src/model-runner.mjs';
import { withOperationContext } from '../src/operation-context.mjs';
import { MODEL_TIERS_PATH } from '../src/model-tiers.mjs';

const MAPPING = `modelTiers:
  relay: { model: cheap-model, fallback: [backup-model] }
  reason: { model: strong-model, fallback: [cheap-model], params: { effort: high } }
  clarify: relay
  summarize: relay
  code: reason
  analyze: reason
`;

async function repository({ mapping = MAPPING } = {}) {
  // A real repository, because the audit store lives under `.git` and the mapping is resolved as a
  // repository-relative path — a bare temp directory passes neither.
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-adp-'));
  spawnSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: root });
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  if (mapping !== null) await writeFile(path.join(root, MODEL_TIERS_PATH), mapping);
  // A stand-in provider binary. It has to be a script rather than `node -e`, because the adapter
  // appends its cwd, attachment, bootstrap prompt, and policy flags and node would parse them as
  // runtime options before the fixture ran.
  // It also records the argv it was handed. Asserting on what the caller *meant* and never on what
  // the provider was *asked* is how a routed invocation came to resolve a model, put it in the
  // receipt, and then run the provider with no model at all — see `the routed model is the model
  // the provider is asked for` below.
  await writeFile(path.join(root, 'fake-provider.mjs'),
    `import fs from 'node:fs';\n`
    + `fs.writeFileSync(${JSON.stringify(JSON.stringify(path.join(root, 'provider-argv.json')))}`
    + `.slice(1, -1), JSON.stringify(process.argv.slice(2)));\n`
    + 'process.stdout.write("ok");\n');
  return root;
}

function request(root, overrides = {}) {
  return {
    provider: 'copilot-cli',
    providerConfig: { executable: process.execPath, arguments: [path.join(root, 'fake-provider.mjs')] },
    cwd: root, allowedRoots: [root], auditRoot: root, channel: 'test', prompt: { text: 'test' },
    tools: { mode: 'none', names: [] }, limits: { timeoutMs: 10_000, outputBytes: 1024 }, ...overrides
  };
}

function run(root, overrides) {
  return withOperationContext(
    { operation: { id: 'model.test', modelPolicy: 'required' }, modelMode: { enabled: true }, root, command: 'test' },
    () => invokeModel(request(root, overrides))
  );
}

/** What the provider process was actually asked to run. */
async function providerArgv(root) {
  return JSON.parse(await readFile(path.join(root, 'provider-argv.json'), 'utf8'));
}

async function auditRecords(root) {
  const directory = path.join(root, '.git', 'singularity-flow', 'model-invocations');
  const names = await readdir(directory).catch(() => []);
  return Promise.all(names.filter((name) => name.endsWith('.json'))
    .map(async (name) => JSON.parse(await readFile(path.join(directory, name), 'utf8'))));
}

test('generation-records-resolved-model', async () => {
  /**
   * `[ADP:AC-004]`. A caller names a task and never a model; the receipt names the model.
   *
   * `available` is recorded even though nothing fell back, so a reader can tell "the preferred model
   * ran" from "the preferred model was the only option" — those look identical if you only record
   * what was used.
   */
  const root = await repository();
  const result = await run(root, { task: 'reason' });

  assert.equal(result.model, 'strong-model', 'the caller was told a model other than the one that ran');
  assert.equal(result.invocation.model, 'strong-model');
  assert.equal(result.routing.task, 'reason');
  assert.equal(result.routing.resolvedModel, 'strong-model');
  assert.deepEqual(result.routing.available, ['strong-model', 'cheap-model']);
  assert.deepEqual(result.routing.fallbackHops, []);
  assert.match(result.routing.mappingRevision, /^[0-9a-f]{64}$/);
  assert.match(result.routing.paramsDigest, /^[0-9a-f]{16}$/, 'the params that shaped the run were not digested');

  const [record] = await auditRecords(root);
  assert.equal(record.model, 'strong-model', 'the persisted record does not name the model that ran');
  assert.equal(record.routing.task, 'reason');
  assert.equal(record.routing.mappingRevision, result.routing.mappingRevision);
});

test('an aliased task records the tier it borrowed', async () => {
  // `code` aliases `reason`, so it resolves to the same model and says so. Without `aliasOf` the
  // scorecard cannot tell a task that was measured from one that inherited someone else's answer.
  const root = await repository();
  const result = await run(root, { task: 'code' });
  assert.equal(result.routing.resolvedModel, 'strong-model');
  assert.equal(result.routing.aliasOf, 'reason', 'an aliased task did not disclose whose tier it used');
});

test('the routed model is the model the provider is asked for', async () => {
  /**
   * `[ADP:REQ-032]`. The receipt is written from the routing decision, so it agrees with itself
   * whatever the provider was told — which is exactly how this shipped: a task-routed invocation
   * resolved `strong-model`, recorded `strong-model`, returned `strong-model`, and invoked the
   * provider with no `--model` at all. The provider used its own default, and every surface built
   * to answer "which model did this work" answered with a model nobody requested.
   *
   * So this asserts on the argv the provider received, which is the only place the two claims can
   * be seen to disagree.
   */
  const root = await repository();
  await run(root, { task: 'reason' });
  const argv = await providerArgv(root);
  assert.ok(argv.includes('--model'), 'a routed invocation asked the provider for no model at all');
  assert.equal(argv[argv.indexOf('--model') + 1], 'strong-model',
    'the provider was asked for a model other than the one the receipt records');
});

test('a caller-named model still reaches the provider unchanged', async () => {
  // The path that always worked, kept honest beside the one that did not.
  const root = await repository();
  await run(root, { model: 'named-model' });
  const argv = await providerArgv(root);
  assert.equal(argv[argv.indexOf('--model') + 1], 'named-model');
});

test('a request may route by task or name a model, never both', async () => {
  /**
   * `[ADP:CON-001]` at the request boundary. A caller naming both is expressing a routing opinion,
   * and the mapping becomes advisory the moment one caller is allowed to overrule it.
   */
  const root = await repository();
  await assert.rejects(() => run(root, { task: 'reason', model: 'something-else' }),
    (error) => {
      assert.equal(error.code, 'MODEL_REQUEST_INVALID');
      assert.match(error.message, /names both task 'reason' and model/);
      return true;
    });
});

test('routing by task without a mapping refuses rather than guessing', async () => {
  // Failing closed matters more here than convenience: silently falling back to the provider's
  // default model would be an unrouted invocation wearing a routed one's receipt.
  const root = await repository({ mapping: null });
  await assert.rejects(() => run(root, { task: 'reason' }),
    (error) => error.code === 'MODEL_TIER_MISSING' && /is not present/.test(error.message));
});

test('a caller that names its own model is unchanged, and says so', async () => {
  /**
   * The whole change is additive. Every existing call site names a model directly and must behave
   * exactly as before — and `routing: null` is how a reader tells unrouted work from routed rather
   * than having to infer it from a missing field.
   */
  const root = await repository();
  const result = await run(root, { model: 'hand-picked-model' });
  assert.equal(result.model, 'hand-picked-model');
  assert.equal(result.routing, null, 'an unrouted invocation claimed a routing decision it never made');
  const [record] = await auditRecords(root);
  assert.equal(record.routing, null);
  assert.equal(record.model, 'hand-picked-model');
});

test('an unknown task is refused at the request boundary', async () => {
  const root = await repository();
  await assert.rejects(() => run(root, { task: 'telepathy' }),
    (error) => error.code === 'MODEL_TASK_UNKNOWN' && /The task enum is closed/.test(error.message));
});
