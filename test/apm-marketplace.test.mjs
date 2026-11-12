import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { initApmMarketplace, marketplaceWorkflowText, packagedAgentText, publishApmPackage, remoteRepository } from '../src/apm-marketplace.mjs';
import { parseAgentDependencies } from '../src/agent-document-parser.mjs';

// APM A4 (2026-10-30): the organisation's marketplace as APM's monorepo-hybrid shape, and this
// repository's agents published to it as one package per pull request. The stand-in APM CLI writes
// what apm 0.35.0 wrote: `marketplace init` its scaffold (with an example package and an owner URL
// made from the owner's name), `pack` the Copilot index from the marketplace block.
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin/singularity-flow.mjs');
const yamlModule = createRequire(path.join(packageRoot, 'package.json')).resolve('yaml');
const FAKE_APM = `#!/usr/bin/env node
const fs = require('node:fs');
const YAML = require(${JSON.stringify(yamlModule)});
const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
if (args[0] === '--version') { console.log('Agent Package Manager (APM) CLI version ' + (process.env.FAKE_APM_VERSION || '0.35.0')); process.exit(0); }
if (args[0] === 'marketplace' && args[1] === 'init') {
  const name = option('--name');
  const owner = option('--owner');
  fs.writeFileSync('apm.yml', [
    'name: ' + name, 'version: 0.1.0', 'description: A short description of what this repo offers', 'marketplace:', '  owner:',
    '    name: ' + owner, '    url: https://git.example.test/' + owner, '', '  # Default tag pattern used to resolve version ranges for each package.',
    '  build:', '    tagPattern: "v{version}"', '', '  # Output targets (map form).', '  outputs:', '    codex: {}',
    '    # copilot: {}', '', '  packages:', '    - name: example-package', '      description: Human-readable description of the package',
    '      source: ' + owner + '/example-package', '      version: "^1.0.0"', ''
  ].join('\\n'));
  console.log("[+] Created apm.yml with 'marketplace:' block");
  process.exit(0);
}
if (args[0] === 'pack') {
  if (process.env.FAKE_APM_FAIL_PACK) { console.error('[x] Build failed'); process.exit(1); }
  const manifest = YAML.parse(fs.readFileSync('apm.yml', 'utf8'));
  const market = manifest.marketplace;
  const paths = { copilot: '.github/plugin/marketplace.json', codex: '.agents/plugins/marketplace.json' };
  for (const key of Object.keys(market.outputs || { codex: {} })) {
    const file = (market.outputs[key] && market.outputs[key].path) || paths[key];
    fs.mkdirSync(require('node:path').dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ name: manifest.name, owner: { name: market.owner.name },
      metadata: { description: manifest.description, version: manifest.version },
      plugins: (market.packages || []).map((entry) => ({ name: entry.name, description: entry.description, version: entry.version, source: entry.source })) }, null, 2) + '\\n');
  }
  // apm 0.35.0 reports what it built on stdout.
  console.log('[*] Built marketplace.json [copilot] (' + (market.packages || []).length + ' package(s))');
  process.exit(0);
}
process.exit(2);
`;

function run(command, args, cwd, env = process.env) {
  return spawnSync(command, args, { cwd, encoding: 'utf8', env });
}
const git = (root, ...args) => {
  const result = run('git', args, root);
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}\n${result.stderr}`);
  return result.stdout.trim();
};
const ok = (result) => { assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`); return result; };

const REVIEWER = [
  '---', 'name: reviewer', 'description: Reviews the change for defects', 'tools: [read, search]', 'metadata:', '  sflow-label: "Reviewer"',
  '  sflow-phases: "verification"', '---', '', '# Reviewer', '', 'Review the change carefully.', '', '## Attached skills', '',
  '| Skill | Phases | When to use it |', '| --- | --- | --- |', '| code-review | verification | When reading the diff |', ''
].join('\n');
const CODE_REVIEW = '---\nname: code-review\ndescription: Review a change for defects and missing tests.\n---\n\nRead the diff first.\n';

async function workspace(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-apm-marketplace-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const tools = path.join(base, 'bin');
  await mkdir(tools);
  await writeFile(path.join(tools, 'apm'), FAKE_APM);
  await chmod(path.join(tools, 'apm'), 0o755);
  const env = {
    ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Packager', PATH: `${tools}${path.delimiter}${process.env.PATH}`
  };
  const repository = async (name, { remote = true } = {}) => {
    const root = path.join(base, name);
    if (remote) run('git', ['init', '-q', '--bare', path.join(base, `${name}.git`)], base);
    run('git', ['init', '-q', '-b', 'main', root], base);
    for (const [key, value] of [['user.name', 'Packager'], ['user.email', 'packager@example.com']]) git(root, 'config', key, value);
    if (remote) git(root, 'remote', 'add', 'origin', path.join(base, `${name}.git`));
    await writeFile(path.join(root, 'README.md'), `# ${name}\n`);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'init');
    return root;
  };
  const apm = (cwd, args, extra = {}) => run(path.join(tools, 'apm'), args, cwd, { ...env, ...extra }).status;
  const flow = (cwd, args, extra = {}) => run(process.execPath, [bin, ...args], cwd, { ...env, ...extra });
  return { base, env, repository, apm, flow };
}

/** An SFlow repository whose own agent `reviewer` attaches the skill `code-review`. */
async function source(space) {
  const root = await space.repository('app');
  git(root, 'push', '-q', '-u', 'origin', 'main');
  ok(space.flow(root, ['init']));
  await writeFile(path.join(root, '.github/agents/reviewer.agent.md'), REVIEWER);
  await mkdir(path.join(root, 'singularity/skill-library/code-review'), { recursive: true });
  await writeFile(path.join(root, 'singularity/skill-library/code-review/SKILL.md'), CODE_REVIEW);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'reviewer agent');
  git(root, 'push', '-q');
  return root;
}

const injected = (space, extra = {}) => ({ apm: (cwd, args) => space.apm(cwd, args, extra), cliVersion: () => '0.35.0' });

async function marketplace(space) {
  const root = await space.repository('catalog', { remote: false });
  git(root, 'remote', 'add', 'origin', 'https://git.example.test/acme/team-catalog.git');
  const result = await initApmMarketplace(root, { name: 'team-catalog', owner: 'Platform Team', description: 'Approved agents for our teams', ...injected(space) });
  git(root, 'switch', '-q', 'main');
  git(root, 'merge', '-q', '--ff-only', result.branch);
  return { root, result };
}

test('marketplace init commits APM\'s marketplace, set to compile the Copilot index, with the pinned CLI and its gates', async (t) => {
  const space = await workspace(t);
  const root = await space.repository('catalog', { remote: false });
  git(root, 'remote', 'add', 'origin', 'https://git.example.test/acme/team-catalog.git');
  const preview = await initApmMarketplace(root, { name: 'team-catalog', owner: 'Platform Team', dryRun: true, ...injected(space) });
  assert.deepEqual(preview.files, ['apm.yml', '.github/plugin/marketplace.json', '.github/workflows/apm-marketplace.yml']);
  assert.equal(git(root, 'status', '--porcelain'), '', 'a preview writes nothing');

  const result = await initApmMarketplace(root, { name: 'team-catalog', owner: 'Platform Team', ...injected(space) });
  assert.equal(result.branch, 'apm/marketplace-init');
  assert.equal(git(root, 'branch', '--show-current'), 'apm/marketplace-init');
  assert.deepEqual(git(root, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(),
    ['.github/plugin/marketplace.json', '.github/workflows/apm-marketplace.yml', 'apm.yml']);
  const manifest = YAML.parse(await readFile(path.join(root, 'apm.yml'), 'utf8'));
  assert.equal(manifest.description, 'Agents and skills Platform Team approves.', 'never APM\'s placeholder');
  assert.deepEqual(manifest.marketplace.outputs, { copilot: {} });
  assert.deepEqual(manifest.marketplace.packages, [], 'APM\'s example package is not ours');
  assert.deepEqual(manifest.marketplace.owner, { name: 'Platform Team' }, 'an owner URL APM made from a name with spaces goes');
  assert.equal(manifest['x-sflow']['apm-cli'], '0.35.0');
  assert.equal(JSON.parse(await readFile(path.join(root, '.github/plugin/marketplace.json'), 'utf8')).name, 'team-catalog');
  const workflow = await readFile(path.join(root, '.github/workflows/apm-marketplace.yml'), 'utf8');
  assert.equal(workflow, marketplaceWorkflowText({ apmVersion: '0.35.0', branch: 'main' }));
  assert.match(workflow, /microsoft\/apm-action@[0-9a-f]{40} # v1\.10\.0/u);
  assert.match(workflow, /apm-version: '0\.35\.0'/u);
  for (const gate of ['apm pack --check-clean --offline', 'apm marketplace check --offline', 'apm audit --file']) assert.ok(workflow.includes(gate), gate);
  assert.deepEqual(result.nextActions.map((entry) => entry.command), [
    'git push -u origin apm/marketplace-init', 'gh pr create --fill', 'apm marketplace add git.example.test/acme/team-catalog --name team-catalog'
  ]);
  await assert.rejects(initApmMarketplace(root, { name: 'team-catalog', owner: 'Platform Team', ...injected(space) }), { code: 'APM_MARKETPLACE_EXISTS' });
});

test('publish writes this repository\'s agent and its skills as a package and its entry, committed in the marketplace only', async (t) => {
  const space = await workspace(t);
  const app = await source(space);
  const { root: catalog } = await marketplace(space);
  const before = git(app, 'rev-parse', 'HEAD');

  const preview = await publishApmPackage(app, { agents: ['reviewer'], marketplace: '../catalog', dryRun: true, ...injected(space) });
  assert.deepEqual(preview.files.map((file) => file.path), [
    'plugins/reviewer/.apm/agents/reviewer.agent.md', 'plugins/reviewer/.apm/skills/code-review/SKILL.md', 'plugins/reviewer/apm.yml'
  ]);
  assert.equal(git(catalog, 'status', '--porcelain'), '');

  const result = await publishApmPackage(app, { agents: ['reviewer'], marketplace: '../catalog', ...injected(space) });
  assert.equal(result.version, '1.0.0');
  assert.equal(result.branch, 'apm/publish-reviewer-1.0.0');
  assert.deepEqual(result.stepsKeptHere, [{ agent: 'reviewer', steps: ['verification'] }]);
  assert.equal(git(catalog, 'branch', '--show-current'), 'apm/publish-reviewer-1.0.0');
  assert.deepEqual(git(catalog, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), [
    '.github/plugin/marketplace.json', 'apm.yml', 'plugins/reviewer/.apm/agents/reviewer.agent.md',
    'plugins/reviewer/.apm/skills/code-review/SKILL.md', 'plugins/reviewer/apm.yml'
  ]);
  assert.equal(git(app, 'rev-parse', 'HEAD'), before, 'the source repository is not changed');
  assert.equal(git(app, 'status', '--porcelain'), '');

  const agent = await readFile(path.join(catalog, 'plugins/reviewer/.apm/agents/reviewer.agent.md'), 'utf8');
  assert.equal(agent, ['---', 'name: reviewer', 'description: Reviews the change for defects', 'tools: [read, search]', 'metadata:',
    '  sflow-label: "Reviewer"', '---', '', '# Reviewer', '', 'Review the change carefully.', ''].join('\n'),
  'the steps chosen here and the skill table go; every other line is as written');
  assert.equal(await readFile(path.join(catalog, 'plugins/reviewer/.apm/skills/code-review/SKILL.md'), 'utf8'), CODE_REVIEW);
  const packageManifest = YAML.parse(await readFile(path.join(catalog, 'plugins/reviewer/apm.yml'), 'utf8'));
  assert.deepEqual(packageManifest, {
    name: 'reviewer', version: '1.0.0', description: 'Reviews the change for defects',
    'x-sflow': { 'published-from': { commit: before, agents: ['reviewer'], skills: ['code-review'] } }
  });
  const manifestText = await readFile(path.join(catalog, 'apm.yml'), 'utf8');
  assert.match(manifestText, /\n {2}packages:\n {4}- name: reviewer\n {6}source: \.\/plugins\/reviewer\n/u, 'a block entry, like APM\'s own');
  const index = JSON.parse(await readFile(path.join(catalog, '.github/plugin/marketplace.json'), 'utf8'));
  assert.deepEqual(index.plugins, [{ name: 'reviewer', description: 'Reviews the change for defects', version: '1.0.0', source: './plugins/reviewer' }]);
  assert.equal(git(catalog, 'for-each-ref', '--format=%(refname)', 'refs/remotes'), '', 'nothing is pushed');
});

test('a later publish is the next version, the same files publish nothing, and an earlier version is refused', async (t) => {
  const space = await workspace(t);
  const app = await source(space);
  const { root: catalog } = await marketplace(space);
  await publishApmPackage(app, { agents: ['reviewer'], marketplace: '../catalog', ...injected(space) });
  git(catalog, 'switch', '-q', 'main');
  git(catalog, 'merge', '-q', '--ff-only', 'apm/publish-reviewer-1.0.0');

  const same = await publishApmPackage(app, { agents: ['reviewer'], marketplace: '../catalog', ...injected(space) });
  assert.equal(same.unchanged, true);
  assert.equal(same.committed, false);

  await writeFile(path.join(app, '.github/agents/reviewer.agent.md'), REVIEWER.replace('carefully.', 'carefully, test by test.'));
  await assert.rejects(publishApmPackage(app, { agents: ['reviewer'], marketplace: '../catalog', ...injected(space) }),
    (error) => error.code === 'APM_PUBLISH_UNCOMMITTED' && /reviewer\.agent\.md/u.test(error.message));
  git(app, 'commit', '-q', '-am', 'reviewer reads test by test');
  await assert.rejects(publishApmPackage(app, { agents: ['reviewer'], marketplace: '../catalog', version: '1.0.0', ...injected(space) }),
    { code: 'APM_VERSION_NOT_LATER' });
  // A marketplace may compile more indexes than Copilot's; each one apm pack writes is committed.
  const catalogManifest = path.join(catalog, 'apm.yml');
  await writeFile(catalogManifest, (await readFile(catalogManifest, 'utf8')).replace('    copilot: {}\n', '    copilot: {}\n    codex: {}\n'));
  git(catalog, 'commit', '-q', '-am', 'compile the codex index too');
  const next = await publishApmPackage(app, { agents: ['reviewer'], marketplace: '../catalog', ...injected(space) });
  assert.deepEqual(next.indexed, ['.agents/plugins/marketplace.json', '.github/plugin/marketplace.json']);
  assert.equal(git(catalog, 'status', '--porcelain'), '');
  assert.equal(next.version, '1.0.1');
  assert.equal(next.previousVersion, '1.0.0');
  assert.match(await readFile(path.join(catalog, 'plugins/reviewer/.apm/agents/reviewer.agent.md'), 'utf8'), /test by test/u);
  const manifest = YAML.parse(await readFile(path.join(catalog, 'apm.yml'), 'utf8'));
  assert.deepEqual(manifest.marketplace.packages.map((entry) => [entry.name, entry.version]), [['reviewer', '1.0.1']], 'the entry is updated, not added twice');

  // A folder SFlow did not publish is the marketplace's own.
  await mkdir(path.join(catalog, 'plugins/handmade'), { recursive: true });
  await writeFile(path.join(catalog, 'plugins/handmade/apm.yml'), 'name: handmade\nversion: 2.0.0\ndescription: Written by hand\n');
  git(catalog, 'add', '-A');
  git(catalog, 'commit', '-q', '-m', 'handmade package');
  await assert.rejects(publishApmPackage(app, { agents: ['reviewer'], packageName: 'handmade', marketplace: '../catalog', ...injected(space) }),
    { code: 'APM_PUBLISH_NOT_OURS' });
});

test('publish refuses what would not work or should not travel, before anything is written', async (t) => {
  const space = await workspace(t);
  const app = await source(space);
  const { root: catalog } = await marketplace(space);
  const refused = (options, code) => assert.rejects(publishApmPackage(app, { marketplace: '../catalog', ...injected(space), ...options }), { code });

  await refused({ agents: ['ghost'] }, 'APM_PUBLISH_AGENT_UNKNOWN');
  await refused({ agents: ['reviewer', 'qa'] }, 'APM_PUBLISH_INVALID');
  await refused({ agents: ['reviewer'], marketplace: '../app' }, 'APM_MARKETPLACE_MISSING');
  await refused({ agents: ['reviewer'], marketplace: '../nowhere' }, 'APM_MARKETPLACE_MISSING');
  await refused({ agents: ['reviewer'], version: 'v2' }, 'APM_VERSION_INVALID');
  await assert.rejects(publishApmPackage(app, { agents: ['reviewer'], marketplace: '../catalog', apm: (cwd, args) => space.apm(cwd, args), cliVersion: () => '0.36.0' }),
    { code: 'APM_CLI_VERSION_MISMATCH' });

  // A skill that uses SFlow instructions, and a secret, never leave the repository.
  await mkdir(path.join(app, 'singularity/skill-library/house-style'), { recursive: true });
  await writeFile(path.join(app, 'singularity/skill-library/house-style/SKILL.md'),
    '---\nname: house-style\ndescription: Our house style.\nmetadata:\n  sflow-instructions: [naming]\n---\n\nFollow the naming rules.\n');
  git(app, 'add', '-A');
  git(app, 'commit', '-q', '-m', 'house style');
  await refused({ agents: ['reviewer'], skills: ['house-style'] }, 'APM_PUBLISH_UNSUPPORTED');
  await writeFile(path.join(app, '.github/agents/reviewer.agent.md'), REVIEWER.replace('carefully.', `carefully. Use token ghp_${'a1B2'.repeat(9)}.`));
  git(app, 'commit', '-q', '-am', 'oops');
  await assert.rejects(publishApmPackage(app, { agents: ['reviewer'], marketplace: '../catalog', ...injected(space) }),
    (error) => error.code === 'APM_PUBLISH_SECRET' && /reviewer\.agent\.md:\d+ \(GitHub token\)/u.test(error.message) && !error.message.includes('a1B2a1B2'));
  git(app, 'reset', '-q', '--hard', 'HEAD~1');

  // apm pack failing commits nothing.
  await assert.rejects(publishApmPackage(app, { agents: ['reviewer'], marketplace: '../catalog', ...injected(space, { FAKE_APM_FAIL_PACK: '1' }) }),
    { code: 'APM_PACK_FAILED' });
  assert.equal(git(catalog, 'log', '--format=%s', '-1'), 'Start the team-catalog APM marketplace');
});

test('the packaged agent keeps every line but this repository\'s step choices, and refuses one it cannot cut cleanly', async () => {
  const agentFrom = (text) => ({ ...parseAgentDependencies(text, { source: '.github/agents/writer.agent.md' }), text });
  const plain = '---\nname: writer\ndescription: Writes\ntools:\n- read\n---\n\nWrite.\n';
  assert.equal(await packagedAgentText(agentFrom(plain)), plain, 'nothing to cut: byte for byte');
  const onlySteps = '---\nname: writer\ndescription: Writes\nmetadata:\n  sflow-phases: "design"\n  sflow-default-for: "design"\n---\n\nWrite.\n';
  assert.equal(await packagedAgentText(agentFrom(onlySteps)), '---\nname: writer\ndescription: Writes\n---\n\nWrite.\n');
  const folded = '---\nname: writer\ndescription: Writes\nmetadata:\n  sflow-label: Writer\n  sflow-phases: >-\n    design\n---\n\nWrite.\n';
  await assert.rejects(packagedAgentText(agentFrom(folded)), { code: 'APM_PUBLISH_UNSUPPORTED' });
});

test('the shell commands print the change and its next steps, and a marketplace URL never carries credentials', async (t) => {
  const space = await workspace(t);
  const app = await source(space);
  const catalog = await space.repository('catalog', { remote: false });
  const init = ok(space.flow(catalog, ['apm', 'marketplace', 'init', '--name', 'team-catalog', '--owner', 'acme']));
  assert.match(init.stdout, /Committed on apm\/marketplace-init \(new, from main\): the team-catalog APM marketplace/u);
  assert.match(init.stdout, /apm marketplace add <owner>\/<repository> --name team-catalog/u);
  const published = ok(space.flow(app, ['apm', 'publish', 'reviewer', '--marketplace', '../catalog']));
  assert.match(published.stdout, /Published reviewer 1\.0\.0 \(new\) to team-catalog: agent reviewer; skill code-review\./u);
  assert.match(published.stdout, /reviewer's steps here \(verification\) stay in this repository/u);
  assert.match(published.stdout, /git -C \.\.\/catalog push -u origin apm\/marketplace-init/u, 'the apm/ branch already checked out is kept');
  const json = JSON.parse(ok(space.flow(app, ['apm', 'publish', 'reviewer', '--marketplace', '../catalog', '--json'])).stdout);
  assert.equal(json.resultType, 'sflow-apm-publish');
  assert.equal(json.unchanged, true);
  // APM's own output goes to stderr, so a --json result that ran APM still reads (the VS Code panel parses it).
  const other = await space.repository('other-catalog', { remote: false });
  const initJson = ok(space.flow(other, ['apm', 'marketplace', 'init', '--name', 'other-catalog', '--owner', 'acme', '--json']));
  assert.equal(JSON.parse(initJson.stdout).name, 'other-catalog', initJson.stdout);
  assert.match(initJson.stderr, /Built marketplace\.json/u);
  const packedJson = ok(space.flow(app, ['apm', 'publish', 'reviewer', '--marketplace', '../other-catalog', '--json']));
  assert.deepEqual([JSON.parse(packedJson.stdout).committed, JSON.parse(packedJson.stdout).marketplace], [true, 'other-catalog'], packedJson.stdout);

  assert.equal(remoteRepository('https://someone:secret@git.example.test/acme/app.git'), 'git.example.test/acme/app');
  assert.equal(remoteRepository('git@git.example.test:acme/app.git'), 'git.example.test/acme/app');
  assert.equal(remoteRepository('ssh://git@gitea.example.com:2222/org/app'), 'gitea.example.com/org/app');
  assert.equal(remoteRepository('/srv/git/app.git'), null);
  assert.equal(remoteRepository(null), null);
});
