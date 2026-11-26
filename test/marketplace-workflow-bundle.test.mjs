/**
 * A workflow an HTTPS index marketplace lists [owner, 2026-11-26]: `workflow import "market:<ID>/<ENTRY>"` fetches its bundle
 * through the hardened reader on the marketplace's own origins, checks the digest the index pins, keeps it in SFlow's
 * private folder and runs the existing import review; nothing is imported until the person confirms it. A generated source
 * whose agent is one of SFlow's own (read-only) workflows' is said so on the marketplace page, with its way on.
 * The index and its files are served from a fixture folder or a stub reader: nothing here uses a network.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { initializeDefinition } from '../src/config.mjs';
import { fetchMarketplaceWorkflowBundle } from '../src/marketplace-workflow-bundle.mjs';
import { exportWorkflowBundle } from '../src/workflow-transfer.mjs';
import { journeyRepository } from './helpers/route-follower.mjs';

const INDEX = 'https://catalog.example.org/sflow-marketplace.json';
const BUNDLE_URL = 'https://cdn.example.org/workflows/portable-feature.json';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** A real workflow bundle: feature, copied as portable-feature in a repository of its own, and exported. */
async function portableBundle(t) {
  const base = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'sflow-market-workflow-source-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  await initializeDefinition(base);
  const file = path.join(base, 'singularity/workflow.yml');
  const configuration = YAML.parse(await readFile(file, 'utf8'));
  configuration.workTypes['portable-feature'] = { ...structuredClone(configuration.workTypes.feature), label: 'Portable feature' };
  await writeFile(file, YAML.stringify(configuration));
  const out = path.join(base, 'portable-feature.workflow.json');
  await exportWorkflowBundle(base, ['portable-feature'], out);
  return readFile(out);
}

const indexBytes = (entries) => Buffer.from(JSON.stringify({ format: 'sflow-marketplace@1', name: 'Shared catalog', entries }));
const workflowEntry = (bytes, extra = {}) => ({ id: 'portable-feature', kind: 'workflow', version: '1.0.0', label: 'Portable feature', url: BUNDLE_URL, sha256: sha(bytes), ...extra });
const response = (bytes, { status = 200, location = null } = {}) => ({ ok: status >= 200 && status < 300, status,
  headers: { get: (name) => (name === 'location' ? location : null) }, arrayBuffer: async () => Buffer.from(bytes) });

test('the fetch route keeps exactly the pinned bundle, and refuses a digest mismatch, another origin, a size over its own, and anything but a bundle', async (t) => {
  const bundle = await portableBundle(t);
  const root = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'sflow-market-workflow-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  await writeFile(path.join(root, 'singularity/workflow.yml'), YAML.stringify({ marketplaces: {
    shared: { label: 'Shared', index: INDEX, allowedOrigins: ['https://cdn.example.org'] } } }));
  const env = { ...process.env, SINGULARITY_FLOW_WORKFLOW_BUILD_STATE: path.join(root, 'state', 'workflow-builds') };
  const kept = path.join(root, 'state', 'marketplace-workflows');
  const serve = (files) => async (url) => (Object.hasOwn(files, url) ? (typeof files[url] === 'function' ? files[url]() : response(files[url])) : response('missing', { status: 404 }));
  const fetchWith = (entries, files = {}) => fetchMarketplaceWorkflowBundle(root, 'market:shared/portable-feature', { env, fetchImpl: serve({ [INDEX]: indexBytes(entries), ...files }) });
  // Each refusal's way on is a whole command: what the marketplace lists now.
  const refusedWith = (code) => (error) => {
    assert.equal(error.code, code, error.message);
    assert.equal(error.details.nextAction.command, 'singularity-flow marketplace catalog --marketplace shared');
    assert.doesNotMatch(error.message, /[0-9a-f]{40}/u, 'no digest is shown');
    return true;
  };

  // The pinned bytes: kept exactly as served, one folder per digest, named after the entry.
  const fetched = await fetchWith([workflowEntry(bundle)], { [BUNDLE_URL]: bundle });
  assert.equal(fetched.file, path.join(kept, sha(bundle), 'portable-feature.workflow.json'));
  assert.deepEqual(await readFile(fetched.file), bundle);
  assert.deepEqual([fetched.reference, fetched.marketplace, fetched.entry], ['market:shared/portable-feature', { id: 'shared', label: 'Shared' },
    { id: 'portable-feature', label: 'Portable feature', version: '1.0.0' }]);
  // A redirect that stays on the marketplace's origins is followed; one off them is refused.
  const moved = 'https://cdn.example.org/v2/portable-feature.json';
  assert.equal((await fetchWith([workflowEntry(bundle)], { [BUNDLE_URL]: () => response('', { status: 302, location: moved }), [moved]: bundle })).file, fetched.file);
  await rm(kept, { recursive: true, force: true });
  await assert.rejects(fetchWith([workflowEntry(bundle)], { [BUNDLE_URL]: () => response('', { status: 302, location: 'https://elsewhere.example.net/b.json' }),
    'https://elsewhere.example.net/b.json': bundle }), refusedWith('MARKETPLACE_ORIGIN_REFUSED'));
  // Other bytes than the index pins: refused, nothing kept.
  await assert.rejects(fetchWith([workflowEntry(bundle)], { [BUNDLE_URL]: Buffer.concat([bundle, Buffer.from(' ')]) }), refusedWith('MARKETPLACE_CONTENT_MISMATCH'));
  // More bytes than the index says it has: refused before any digest.
  await assert.rejects(fetchWith([workflowEntry(bundle, { bytes: 64 })], { [BUNDLE_URL]: bundle }), (error) => refusedWith('MARKETPLACE_WORKFLOW_TOO_LARGE')(error)
    && /larger than 64 bytes, the size its index gives, so nothing was saved\./u.test(error.message));
  // Pinned, but not a workflow bundle: refused, and the file is not kept.
  const junk = Buffer.from(JSON.stringify({ kind: 'not-a-bundle' }));
  await assert.rejects(fetchWith([workflowEntry(junk)], { [BUNDLE_URL]: junk }), refusedWith('MARKETPLACE_WORKFLOW_INVALID'));
  assert.equal(existsSync(path.join(kept, sha(junk), 'portable-feature.workflow.json')), false);
  // Another kind of entry, or a marketplace that is a Git repository, is not a bundle to fetch.
  await assert.rejects(fetchWith([{ id: 'portable-feature', kind: 'skill', version: '1.0.0', url: 'https://cdn.example.org/a.md', sha256: 'a'.repeat(64) }]),
    refusedWith('IMPORT_KIND_INVALID'));
  assert.deepEqual(await readdir(kept).catch(() => []), [], 'nothing refused was kept');
});

test('real CLI: an index workflow is installed through its review, and a generated source an agent of SFlow\'s own workflows would fetch says why not', async (t) => {
  const bundle = await portableBundle(t);
  const served = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'sflow-market-workflow-served-')));
  t.after(() => rm(served, { recursive: true, force: true }));
  await mkdir(path.join(served, 'catalog.example.org', 'workflows'), { recursive: true });
  const url = 'https://catalog.example.org/workflows/portable-feature.json';
  await writeFile(path.join(served, 'catalog.example.org', 'workflows', 'portable-feature.json'), bundle);
  await writeFile(path.join(served, 'catalog.example.org', 'sflow-marketplace.json'), indexBytes([workflowEntry(bundle, { url }),
    { id: 'lint-report', kind: 'generated', version: '1.0.0', label: 'Lint report', urlTemplate: 'https://catalog.example.org/lint/{workId}.md', phase: 'implementation',
      target: 'artifacts/implementation/lint.md' }]));
  const story = await journeyRepository(t, { env: { SINGULARITY_FLOW_TEST_REMOTE_FIXTURES: served },
    configure: (configuration) => { configuration.marketplaces = { shared: { label: 'Shared', index: INDEX } }; } });
  const refusal = (args) => {
    const result = story.raw(args);
    assert.notEqual(result.status, 0, `${args.join(' ')}\n${result.stdout}`);
    return JSON.parse(result.stdout.slice(result.stdout.search(/^\s*\{/mu)));
  };

  // The page offers the workflow like any item: a preview and an install that reviews it.
  const catalog = JSON.parse(story.cli('marketplace', 'catalog', '--json'));
  const row = catalog.items.find((item) => item.key === 'market:shared/workflow/portable-feature');
  assert.deepEqual([row.status, row.importable, row.actions.install.command], ['not-installed', true,
    'singularity-flow workflow import "market:shared/portable-feature" --dry-run --propose']);
  // Its review: the bundle fetched, checked and kept where the import reads it; nothing changes.
  const before = await story.read('singularity/workflow.yml');
  // This repository's approval groups differ from the bundle's, so the review asks what happens to them, as for any bundle.
  const asking = JSON.parse(story.cli('workflow', 'import', 'market:shared/portable-feature', '--dry-run', '--json'));
  assert.equal(asking.status, 'blocked');
  assert.ok(asking.unresolved.length && asking.unresolved.every((item) => item.kind === 'approval-group'), JSON.stringify(asking.unresolved).slice(0, 400));
  const plan = JSON.parse(story.cli('workflow', 'import', 'market:shared/portable-feature', '--dry-run', '--resolve-all', 'suggested', '--json'));
  assert.deepEqual([plan.resultType, plan.status], ['workflow-import-plan', 'ready']);
  assert.deepEqual(await readFile(plan.bundlePath), bundle);
  assert.deepEqual(plan.marketplaceSource, { reference: 'market:shared/portable-feature', marketplace: { id: 'shared', label: 'Shared' },
    entry: { id: 'portable-feature', label: 'Portable feature', version: '1.0.0' } });
  assert.ok(plan.operations.add.some((entry) => entry.id === 'portable-feature'));
  assert.match(story.cli('workflow', 'import', 'market:shared/portable-feature', '--dry-run'), /^Workflow Portable feature 1\.0\.0 from marketplace Shared, checked against the bundle its index pins\.$/mu);
  assert.equal(await story.read('singularity/workflow.yml'), before, 'a review writes no configuration');
  // Never applied without the person's yes: the import says what it does, and its plan's first step is the whole command
  // that confirms it, with the short code a person types for it (/sf-confirm, `confirm <CODE>`), for a marketplace
  // reference (fetched and checked again) and for the bundle file alike; only that command imports it.
  const confirmStep = (named) => {
    const asked = refusal(['workflow', 'import', named, '--resolve-all', 'suggested', '--json']);
    const [first] = asked.remediationPlan.steps;
    assert.deepEqual([asked.error.code, first.label, first.argv], ['WORKFLOW_IMPORT_CONFIRMATION_REQUIRED', 'Import it as previewed',
      ['workflow', 'import', named, '--resolve-all', 'suggested', '--confirm', plan.planSha256]]);
    assert.match(first.copilotCommand, /^\/sf-confirm [0-9A-Z]{4}-[0-9A-Z]{4}$/u);
    return first.copilotCommand.slice('/sf-confirm '.length);
  };
  confirmStep(plan.bundlePath);
  const code = confirmStep('market:shared/portable-feature');
  const told = story.cli('workflow', 'import', 'market:shared/portable-feature', '--resolve-all', 'suggested', '--dry-run');
  assert.match(told, /^\s+- Shell: singularity-flow confirm [0-9A-Z]{4}-[0-9A-Z]{4}$/mu, 'the review names the same yes');
  assert.equal(await story.read('singularity/workflow.yml'), before);
  // So does a workflow copy waiting for its yes.
  const copy = refusal(['workflow', 'copy', 'feature', 'feature-team', '--label', 'Feature team', '--json']);
  assert.equal(copy.error.code, 'WORKFLOW_COPY_CONFIRMATION_REQUIRED');
  assert.match(copy.remediationPlan.steps[0].copilotCommand, /^\/sf-confirm [0-9A-Z]{4}-[0-9A-Z]{4}$/u);
  assert.deepEqual(copy.remediationPlan.steps[0].argv.slice(0, 6), ['workflow', 'copy', 'feature', 'feature-team', '--label', 'Feature team']);
  story.cli('confirm', code);
  assert.ok(YAML.parse(await story.read('singularity/workflow.yml')).workTypes['portable-feature'], 'imported once confirmed');
  const again = JSON.parse(story.cli('marketplace', 'catalog', '--kind', 'workflow', '--json')).items.find((item) => item.key === row.key);
  assert.match(again.statusWords, /^A workflow called portable-feature is here already: its import review asks whether to keep yours/u);

  // The generated source: implementation is drafted by an agent of SFlow's own workflows, which the engine keeps read-only.
  const lint = catalog.items.find((item) => item.key === 'market:shared/generated/lint-report');
  const [, agent, workflowLabel] = /^Agent (\S+) drafts step .+ in SFlow's own workflow (.+), which is read-only, so it cannot fetch this\. Duplicate \2 first, then add this source for the copy's own agent and step\.$/u.exec(lint.statusWords) ?? [];
  assert.ok(agent && workflowLabel, lint.statusWords);
  assert.deepEqual([lint.status, lint.importable, Object.keys(lint.actions)], ['not-installed', false, ['duplicate']]);
  // The prediction is the engine's own answer: adding it for that agent is refused as read-only.
  const tried = JSON.parse(story.raw(['import', 'add', 'market:shared/lint-report', '--as', 'generated', '--agent', agent, '--dry-run', '--json']).stdout);
  assert.equal(tried.valid, false);
  assert.ok(tried.problems.some((problem) => problem.code === 'SEEDED_WORKFLOW_READ_ONLY'), JSON.stringify(tried.problems));
  // Its way on is a whole command that works: the duplicate's preview.
  const [, source, target, label] = /^singularity-flow workflow duplicate (\S+) (\S+) --label "([^"]+)" --dry-run$/u.exec(lint.actions.duplicate.command) ?? [];
  assert.ok(source && target && label, lint.actions.duplicate.command);
  const duplicate = JSON.parse(story.cli('workflow', 'duplicate', source, target, '--label', label, '--dry-run', '--json'));
  assert.deepEqual([duplicate.resultType, duplicate.independent], ['workflow-copy-plan', true]);
  assert.ok(duplicate.renamed.some((item) => item.subject === `agent:${agent}`), 'the copy has an agent of its own');
});
