/**
 * Which tiers' reasoning effort and Auto routing profile reach Copilot is configurable.
 * `[ADP:REQ-021]`
 *
 * `sendParameters` in `singularity/modelTiers.yml` is `none`, `all` or a list of tasks. A mapping that
 * says nothing sends nothing, as before, and keeps its revision; the packaged map sends only the
 * summarize tier's. Asserted on the argv the provider process received and on the receipt.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { invokeModel } from '../src/model-runner.mjs';
import { withOperationContext } from '../src/operation-context.mjs';
import {
  MODEL_TIERS_PATH, normalizeModelTiers, summarizingRoute, tierLadder, tierMappingRevision
} from '../src/model-tiers.mjs';
import { copilotModelParameterArguments } from '../src/model-providers/copilot-cli.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TIERS = `modelTiers:
  relay: { model: auto }
  reason: { model: strong-model, params: { effort: high } }
  summarize: { model: auto, params: { autoTier: efficiency, effort: low, temperature: 0 } }
  clarify: relay
  code: reason
  analyze: reason
`;

async function repository(mapping) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-tier-params-'));
  spawnSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: root });
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  if (mapping != null) await writeFile(path.join(root, MODEL_TIERS_PATH), mapping);
  await writeFile(path.join(root, 'fake-provider.mjs'),
    `import fs from 'node:fs';\n`
    + `fs.writeFileSync(${JSON.stringify(path.join(root, 'provider-argv.json'))}, JSON.stringify(process.argv.slice(2)));\n`
    + 'process.stdout.write("ok");\n');
  return root;
}

function run(root, overrides = {}) {
  const request = {
    provider: 'copilot-cli',
    providerConfig: { executable: process.execPath, promptTransport: 'attachment', arguments: [path.join(root, 'fake-provider.mjs')] },
    cwd: root, allowedRoots: [root], auditRoot: root, channel: 'test', prompt: { text: 'test' },
    tools: { mode: 'none', names: [] }, limits: { timeoutMs: 10_000, outputBytes: 1024 }, ...overrides
  };
  return withOperationContext(
    { operation: { id: 'model.test', modelPolicy: 'required' }, modelMode: { enabled: true }, root, command: 'test' },
    () => invokeModel(request)
  );
}

const argv = async (root) => JSON.parse(await readFile(path.join(root, 'provider-argv.json'), 'utf8'));
const flag = (args, name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);

async function receipts(root) {
  const directory = path.join(root, '.git', 'singularity-flow', 'model-invocations');
  const names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  return Promise.all(names.map(async (name) => JSON.parse(await readFile(path.join(directory, name), 'utf8'))));
}

test('a mapping that does not say sends nothing and keeps the revision it always had', () => {
  const mapping = normalizeModelTiers(YAML.parse(TIERS));
  assert.equal(mapping.sendParameters, 'none');
  assert.equal(tierLadder(mapping, 'summarize').sentParams, null);
  assert.equal(mapping.revision, tierMappingRevision(mapping.tiers), 'existing Story pins still match');
  const listed = normalizeModelTiers(YAML.parse(`sendParameters: [summarize]\n${TIERS}`));
  assert.notEqual(listed.revision, mapping.revision, 'what is sent is part of the policy');
});

test('a list sends only the tiers it names, matched by task or by the tier a task aliases', () => {
  const listed = normalizeModelTiers(YAML.parse(`sendParameters: [summarize]\n${TIERS}`));
  assert.deepEqual(tierLadder(listed, 'summarize').sentParams, { effort: 'low', autoTier: 'efficiency' },
    'temperature is recorded but never sent');
  assert.equal(tierLadder(listed, 'code').sentParams, null);
  const byAlias = normalizeModelTiers(YAML.parse(`sendParameters: [reason]\n${TIERS}`));
  assert.deepEqual(tierLadder(byAlias, 'code').sentParams, { effort: 'high' }, 'code aliases reason');
  const all = normalizeModelTiers(YAML.parse(`sendParameters: all\n${TIERS}`));
  assert.deepEqual(tierLadder(all, 'analyze').sentParams, { effort: 'high' });
  assert.equal(tierLadder(all, 'relay').sentParams, null, 'a tier with no sendable params sends nothing');
});

test('the setting and the sendable params are validated', () => {
  for (const [yaml, pattern] of [
    [`sendParameters: [nope]\n${TIERS}`, /nope/u],
    [`sendParameters: [summarize, summarize]\n${TIERS}`, /repeats a task/u],
    [`sendParameters: sometimes\n${TIERS}`, /all, none or a list of tasks/u],
    [TIERS.replace('effort: low', 'effort: huge'), /params\.effort must be one of none, minimal, low/u],
    [TIERS.replace('autoTier: efficiency', 'autoTier: "Fast; rm"'), /params\.autoTier must be an Auto routing profile/u]
  ]) assert.throws(() => normalizeModelTiers(YAML.parse(yaml)), pattern);
});

test('Copilot receives effort always and the Auto profile only for auto', () => {
  assert.deepEqual(copilotModelParameterArguments({ effort: 'low', autoTier: 'efficiency' }, 'auto'),
    ['--reasoning-effort', 'low', '--auto-tier', 'efficiency']);
  assert.deepEqual(copilotModelParameterArguments({ effort: 'high', autoTier: 'efficiency' }, 'strong-model'),
    ['--reasoning-effort', 'high']);
  assert.deepEqual(copilotModelParameterArguments(null, 'auto'), []);
});

test('the provider is asked with the sent params, and the receipt records them', async () => {
  const root = await repository(`sendParameters: [summarize]\n${TIERS}`);
  await run(root, { task: 'summarize' });
  let args = await argv(root);
  assert.equal(flag(args, '--model'), 'auto');
  assert.equal(flag(args, '--reasoning-effort'), 'low');
  assert.equal(flag(args, '--auto-tier'), 'efficiency');
  await run(root, { task: 'code' });
  args = await argv(root);
  assert.equal(flag(args, '--model'), 'strong-model');
  assert.equal(args.includes('--reasoning-effort'), false, 'code keeps Copilot\'s default effort');
  const [first, second] = (await receipts(root)).sort((a, b) => String(a.routing.task).localeCompare(String(b.routing.task)));
  assert.equal(first.routing.task, 'code');
  assert.equal(first.routing.sentParameters, null);
  assert.match(first.routing.paramsDigest, /^[0-9a-f]{16}$/u, 'unsent params are still recorded');
  assert.equal(second.routing.task, 'summarize');
  assert.deepEqual(second.routing.sentParameters, { effort: 'low', autoTier: 'efficiency' });
});

test('all sends every tier, none sends nothing', async () => {
  const all = await repository(`sendParameters: all\n${TIERS}`);
  await run(all, { task: 'analyze' });
  assert.equal(flag(await argv(all), '--reasoning-effort'), 'high');
  const none = await repository(`sendParameters: none\n${TIERS}`);
  await run(none, { task: 'summarize' });
  const args = await argv(none);
  assert.equal(args.includes('--reasoning-effort'), false);
  assert.equal(args.includes('--auto-tier'), false);
});

test('a provider configuration cannot set effort or the Auto profile behind the mapping', async () => {
  const root = await repository(`sendParameters: [summarize]\n${TIERS}`);
  for (const option of ['--reasoning-effort', '--auto-tier']) {
    await assert.rejects(run(root, {
      task: 'summarize',
      providerConfig: {
        executable: process.execPath, promptTransport: 'attachment',
        arguments: [path.join(root, 'fake-provider.mjs'), option, 'low']
      }
    }), (error) => error.code === 'MODEL_REQUEST_INVALID' && error.message.includes(option));
  }
});

test('summarizing calls route by the summarize task only when a mapping exists and no model was chosen', async () => {
  const mapped = await repository(TIERS);
  assert.deepEqual(await summarizingRoute(mapped), { task: 'summarize' });
  assert.deepEqual(await summarizingRoute(mapped, 'chosen-model'), { model: 'chosen-model' });
  assert.deepEqual(await summarizingRoute(await repository(null)), { model: null });
});

test('the packaged mapping sends only the summarize tier, at efficiency and low effort', async () => {
  const packaged = normalizeModelTiers(YAML.parse(await readFile(path.join(packageRoot, 'templates', 'modelTiers.yml'), 'utf8')));
  assert.deepEqual(packaged.sendParameters, ['summarize']);
  assert.deepEqual(tierLadder(packaged, 'summarize').sentParams, { autoTier: 'efficiency', effort: 'low' });
  for (const task of ['relay', 'clarify', 'reason', 'code', 'analyze']) {
    assert.equal(tierLadder(packaged, task).sentParams, null, task);
  }
});

test('VS Code: the Model routing tab marks the params sent to Copilot and says which tiers send', async () => {
  const views = path.join(packageRoot, 'apps', 'vscode', 'src', 'views');
  const { configurationCenterView } = await import(path.join(views, 'configuration-center-model.ts'));
  const { configurationCenterHtml } = await import(path.join(views, 'configuration-center-page.ts'));
  const snapshot = {
    identities: { git: { name: 'Casey Dev', email: 'casey@example.com', login: 'caseydev' }, github: 'caseydev' },
    configurationSource: { editor: 'effective', effective: null, candidate: null },
    modelRouting: {
      configured: true, error: null, path: MODEL_TIERS_PATH, revision: 'a'.repeat(64), sendParameters: ['summarize'],
      tasks: [
        { task: 'summarize', model: 'auto', fallback: [], aliasOf: null, params: { effort: 'low', temperature: 0 }, sentParams: { effort: 'low' }, phases: [] },
        { task: 'code', model: 'auto', fallback: [], aliasOf: 'reason', params: { effort: 'high' }, sentParams: null, phases: [] }
      ]
    }
  };
  const html = configurationCenterHtml(configurationCenterView(snapshot, { name: 'Casey', role: 'architect' }), 'models', null, null, null, []);
  assert.match(html, /<code>effort=low<\/code> <span class="pill">sent<\/span>/u);
  assert.doesNotMatch(html, /<code>temperature=0<\/code> <span class="pill">sent/u);
  assert.doesNotMatch(html, /<code>effort=high<\/code> <span class="pill">sent/u);
  assert.match(html, /Sent to Copilot: the effort and Auto profile of <code>summarize<\/code>/u);
});
