import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import YAML from 'yaml';

import { apmProjectStatus } from '../src/apm-project.mjs';

const { apmView, packageSpec, shellArgument } = await import('../apps/vscode/src/views/apm-packages-model.ts');
const { apmPackagesHtml, APM_PACKAGES_SCRIPT } = await import('../apps/vscode/src/views/apm-packages-page.ts');

// APM A7 (2026-10-30): the Agent Packages panel reads `apm status --json`. The status below is built
// by the engine itself from a repository with an installed package, a binding that applies, one that
// waits, and an agent SFlow cannot read, so the page and the CLI can never disagree about the shape.
const sha = (text) => createHash('sha256').update(text).digest('hex');
const git = (root, ...args) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
};

async function status(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-apm-panel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    '.github/agents/reviewer.agent.md': '---\nname: reviewer\ndescription: Reviews <b>the</b> change\n---\nReview it.\n',
    '.github/agents/planner.agent.md': '---\nname: planner\n---\nPlan it.\n'
  };
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.join(root, path.dirname(file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  await writeFile(path.join(root, 'singularity/workflow.yml'), 'apm:\n  agents:\n    reviewer:\n      defaultFor: [verification]\n    ghost:\n      defaultFor: [design]\n');
  await writeFile(path.join(root, 'apm.yml'), 'name: consumer\nversion: 1.0.0\ndependencies:\n  apm:\n    - reviewer@team-catalog\n');
  await writeFile(path.join(root, 'apm.lock.yaml'), YAML.stringify({
    lockfile_version: '1', apm_version: '0.35.0',
    dependencies: [{ repo_url: 'acme/team-catalog', virtual_path: 'plugins/reviewer', resolved_commit: 'a'.repeat(40), version: '1.0.1',
      discovered_via: 'team-catalog', marketplace_plugin_name: 'reviewer',
      deployed_files: Object.keys(files), deployed_file_hashes: Object.fromEntries(Object.entries(files).map(([file, text]) => [file, `sha256:${sha(text)}`])) }]
  }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=Packager', '-c', 'user.email=packager@example.com', 'commit', '-q', '-m', 'init');
  return apmProjectStatus(root, { cliVersion: () => null });
}

test('the panel reads apm status as the engine writes it: packages, bindings that apply or wait, agents SFlow cannot use', async (t) => {
  const raw = await status(t);
  const view = apmView(raw);
  assert.ok(view, 'the engine\'s own result is read');
  assert.equal(view.state, 'intact');
  assert.deepEqual(view.packages.map(({ label, version, commit }) => [label, version, commit]), [['reviewer@team-catalog', '1.0.1', 'a'.repeat(40)]]);
  assert.deepEqual(view.bindings.map(({ agent, active }) => [agent, active]), [['reviewer', true], ['ghost', false]]);
  assert.equal(view.unusable[0].name, 'planner');
  assert.equal(apmView({ schemaVersion: 2, resultType: 'command-result', data: raw })?.state, 'intact', 'a wrapped result is read too');
  assert.equal(apmView({ resultType: 'sflow-apm-install' }), null);

  const html = apmPackagesHtml(view, null);
  assert.match(html, /Every deployed file matches apm\.lock\.yaml and is committed\./u);
  assert.match(html, /<strong>reviewer@team-catalog<\/strong> <span class="meta">1\.0\.1 @ aaaaaaaaaaaa<\/span>/u);
  assert.match(html, /<strong>reviewer<\/strong> drafts verification\./u);
  assert.match(html, /<strong>ghost<\/strong> would draft design, but APM did not deploy \.github\/agents\/ghost\.agent\.md\.\s*<p class="meta">Until then each step keeps its workflow's own agent; nothing is blocked\./u);
  assert.match(html, /Agents SFlow cannot use[\s\S]*planner[\s\S]*requires a non-empty description/u);
  for (const action of ['refresh', 'install', 'update', 'studio', 'open-manifest', 'open-lock']) assert.match(html, new RegExp(`data-apm="${action}"`, 'u'));
  assert.doesNotMatch(html, /<b>the<\/b>/u, 'text from the files is escaped');
  assert.match(html, /No APM CLI on this machine; installing and updating need it, reading does not\./u);
  assert.match(APM_PACKAGES_SCRIPT, /postMessage\(\{ type: 'action', action: target\.dataset\.apm \}\)/u);

  const absent = apmPackagesHtml(apmView({ ...raw, state: 'absent', manifest: null, lock: null, packages: [], findings: [], agents: { bindings: {}, unusable: [] } }), null);
  assert.match(absent, /This repository has no APM project yet/u);
  assert.match(absent, /data-apm="install"/u);
  assert.doesNotMatch(absent, /data-apm="update"|data-apm="open-lock"/u, 'nothing to update or open without packages');
  assert.match(apmPackagesHtml(null, 'The APM files could not be read: boom <x>'), /class="notice error" role="status">The APM files could not be read: boom &lt;x&gt;/u);
});

test('a package typed into the panel is one argument, never an option or two words', () => {
  assert.equal(packageSpec(' reviewer@team-catalog '), 'reviewer@team-catalog');
  assert.equal(packageSpec('--force'), null);
  assert.equal(packageSpec('two words'), null);
  assert.equal(packageSpec(''), null);
  assert.equal(shellArgument('acme/review-pack#v1.2.0'), 'acme/review-pack#v1.2.0');
  assert.equal(shellArgument("../it's here"), "'../it'\\''s here'");
});
