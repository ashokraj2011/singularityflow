/**
 * Build the VS Code extension and open it in a real editor window.
 *
 * Two ways to run an extension: the development host, which loads it from source with no install
 * and reloads on rebuild, and a packaged .vsix, which installs it like any other extension. This
 * script does the first by default because it is what you want while looking at the thing, and the
 * second on request.
 *
 *   node scripts/vscode-dev.mjs                     build, make a demo Epic, open it
 *   node scripts/vscode-dev.mjs --repo /path/to/x   build and open an existing Flow repository
 *   node scripts/vscode-dev.mjs --demo-only         make the demo repository and print its path
 *   node scripts/vscode-dev.mjs --github            drive remote sandbox repositories
 *                                                   (--host plus owner from --owner or environment)
 *   node scripts/vscode-dev.mjs --clean-github      delete the branches --github created
 *   node scripts/vscode-dev.mjs --package           build a .vsix for installing properly
 *   node scripts/vscode-dev.mjs --editor cursor     use Cursor instead of VS Code
 *
 * The development host resolves the CLI through apps/vscode/../../bin/singularity-flow.mjs, so it
 * drives *this* checkout's engine — which is the point while developing, and the thing to remember
 * when a result disagrees with a globally installed CLI.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extension = path.join(root, 'apps', 'vscode');
const cli = path.join(root, 'bin', 'singularity-flow.mjs');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : null;
};

/** Local demo repositories have no origin, so both lifecycle definitions must stay local-only. */
export function configureLocalDemoWorkflow(source) {
  return source
    .replace(/^  publish: required$/m, '  publish: off')
    .replace(/grounding: \w+/, 'grounding: off');
}

/** Editor binaries, in the order they are tried. Both are VS Code forks and take the same flags. */
const EDITORS = {
  code: [
    '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
    '/usr/local/bin/code',
    '/usr/bin/code',
    'C:/Program Files/Microsoft VS Code/bin/code.cmd'
  ],
  cursor: [
    '/Applications/Cursor.app/Contents/Resources/app/bin/cursor',
    '/usr/local/bin/cursor'
  ]
};

function findEditor(preferred) {
  const order = preferred ? [preferred] : ['code', 'cursor'];
  for (const name of order) {
    for (const candidate of EDITORS[name] ?? []) if (existsSync(candidate)) return { name, binary: candidate };
    // Fall back to whatever is on PATH under that name.
    const probe = spawnSync(name, ['--version'], { encoding: 'utf8' });
    if (probe.status === 0) return { name, binary: name };
  }
  return null;
}

function step(message) { console.log(`\n\u2022 ${message}`); }

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/**
 * Run the CLI inside the demo repository.
 *
 * The SINGULARITY_FLOW_TEST_* variables answer the prompts a person would answer interactively.
 * They belong here and nowhere else: this function exists to fabricate a repository worth looking
 * at, not to demonstrate how the product should be driven.
 */
function flow(args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SINGULARITY_FLOW_TEST_IDENTITY: 'Demo Owner',
      SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature' }),
      SINGULARITY_FLOW_TEST_INITIATIVE_SELECTION: JSON.stringify({ profile: 'epic-planning' })
    }
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`singularity-flow ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

const confirm = (expected, args, cwd) => spawnSync(process.execPath, [cli, ...args], {
  cwd,
  encoding: 'utf8',
  env: {
    ...process.env,
    NODE_ENV: 'test',
    SINGULARITY_FLOW_TEST_IDENTITY: 'Demo Owner',
    SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature' }),
    SINGULARITY_FLOW_TEST_INITIATIVE_CONFIRM: expected
  }
});

/**
 * Whose sandbox repositories to use.
 *
 * Taken from --owner, then SFLOW_SANDBOX_OWNER, then whoever `gh` is logged in as. Deliberately not
 * hard-coded: the deterministic check forbids personal or public sample repository references.
 */
function sandboxOwner() {
  const explicit = value('owner') ?? process.env.SFLOW_SANDBOX_OWNER;
  if (explicit) return explicit;
  const probe = spawnSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8' });
  const login = probe.status === 0 ? probe.stdout.trim() : '';
  if (!login) {
    throw new Error('Could not tell whose sandbox repositories to use. Pass --owner <account>, '
      + 'set SFLOW_SANDBOX_OWNER, or authenticate with `gh auth login`.');
  }
  return login;
}

function sandboxHost() {
  const host = value('host') ?? process.env.SFLOW_SANDBOX_HOST ?? process.env.GH_HOST;
  if (!host) {
    throw new Error('Pass --host <git-host> or set SFLOW_SANDBOX_HOST/GH_HOST before using remote sandboxes.');
  }
  if (!/^[a-z0-9.-]+$/i.test(host)) throw new Error(`Invalid sandbox Git host: ${host}`);
  return host;
}

const sandboxUrl = (repo) => `https://${sandboxHost()}/${sandboxOwner()}/${repo}.git`;

/**
 * The three remote sandbox repositories, used with --github.
 *
 * Real remotes make this a true end-to-end run: materialization clones each one, branches from its
 * default branch, and pushes. The Story identifiers are deliberately unmistakable so the branches
 * this creates are obviously the demo's, and so a re-run lands on the same branches rather than
 * accumulating new ones.
 */
const SANDBOX = {
  'sandbox-api': {
    repo: 'sflow-sandbox-api',
    story: 'SFLOW-DEMO-API',
    title: 'Payment intent endpoint for stored credentials',
    description: 'As a returning shopper, I want my stored card charged in one call, so that checkout is a single tap.',
    specification: 'Adds POST /payment-intents accepting a stored-credential token, idempotent by request key.',
    requirements: ['REQ-001', 'REQ-002'],
    acceptanceCriteria: ['AC-001', 'AC-002'],
    dependsOn: []
  },
  'sandbox-web-write': {
    repo: 'sflow-sandbox-web-write',
    story: 'SFLOW-DEMO-WRITE',
    title: 'One-tap purchase sheet',
    description: 'As a returning shopper, I want a single-tap purchase sheet, so that I do not re-enter details.',
    specification: 'Replaces the confirmation step with a one-tap sheet when a stored card is present.',
    requirements: ['REQ-001'],
    acceptanceCriteria: ['AC-001'],
    dependsOn: ['SFLOW-DEMO-API']
  },
  'sandbox-web-read': {
    repo: 'sflow-sandbox-web-read',
    story: 'SFLOW-DEMO-READ',
    title: 'Order confirmation view',
    description: 'As a returning shopper, I want the confirmation to show what was charged, so that I can trust the tap.',
    specification: 'Renders the payment intent result, including the acquirer decision.',
    requirements: ['REQ-002'],
    acceptanceCriteria: ['AC-002'],
    dependsOn: ['SFLOW-DEMO-API']
  }
};

/** Delete the branches the demo creates, so a sandbox can be returned to its prior state. */
async function cleanSandbox() {
  for (const [id, entry] of Object.entries(SANDBOX)) {
    const url = sandboxUrl(entry.repo);
    const existing = spawnSync('git', ['ls-remote', '--heads', url, entry.story], { encoding: 'utf8' });
    if (!existing.stdout.trim()) { console.log(`  ${id}: no ${entry.story} branch`); continue; }
    const deleted = spawnSync('git', ['push', url, '--delete', entry.story], { encoding: 'utf8' });
    console.log(`  ${id}: ${deleted.status === 0 ? `deleted ${entry.story}` : `could not delete ${entry.story} — ${deleted.stderr.trim()}`}`);
  }
}

/**
 * A repository with an Epic driven all the way to materialized Story branches, so every view has
 * something in it: a pinned source, approved artifacts, a Story plan across repositories with real
 * dependencies, and a seeded Story branch in each.
 *
 * The lead repository is always local. It holds the Epic's governed state, and writing that into a
 * code repository — even a sandbox — would leave it there permanently.
 */
async function demoRepository({ github = false } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-demo-'));
  const child = async (name) => {
    const work = path.join(base, name);
    await mkdir(work);
    git(['init', '-b', 'main', work], base);
    git(['config', 'user.name', 'Demo Owner'], work);
    git(['config', 'user.email', 'demo.owner@example.com'], work);
    await writeFile(path.join(work, 'README.md'), `# ${name}\n`);
    git(['add', '.'], work);
    git(['commit', '-m', 'init'], work);
    const bare = path.join(base, `${name}.git`);
    await mkdir(bare);
    git(['init', '-b', 'main', '--bare', bare], base);
    git(['push', bare, 'main'], work);
    return bare;
  };
  // Either fabricated locally, or the real sandbox remotes. Same shape either way: an id, a URL,
  // and one Story that lands in it.
  const repositories = github
    ? Object.fromEntries(Object.entries(SANDBOX).map(([id, entry]) => [id, { ...entry, url: sandboxUrl(entry.repo) }]))
    : {
      // The local URL must come AFTER the spread, or SANDBOX's GitHub URL overwrites it and the
      // "local" demo silently pushes Story branches to the real repositories. It did exactly that.
      'sandbox-api': { ...SANDBOX['sandbox-api'], url: await child('api') },
      'sandbox-web-write': { ...SANDBOX['sandbox-web-write'], url: await child('web-write') },
      'sandbox-web-read': { ...SANDBOX['sandbox-web-read'], url: await child('web-read') }
    };

  const lead = path.join(base, 'checkout-platform');
  await mkdir(lead);
  git(['init', '-b', 'main', lead], base);
  git(['config', 'user.name', 'Demo Owner'], lead);
  git(['config', 'user.email', 'demo.owner@example.com'], lead);
  await writeFile(path.join(lead, 'README.md'), '# Checkout platform\n');
  flow(['init'], lead);

  const portfolioPath = path.join(lead, 'singularity/portfolio.yml');
  let portfolio = await readFile(portfolioPath, 'utf8');
  // Text edits rather than a YAML round trip, which reformats the commentary this file exists for.
  portfolio = portfolio.replace(/^(approvalAuthorities:\n)/m, '$1');
  portfolio = portfolio.replace(/members: \[\]/g, 'members: [{ name: Demo Owner, email: demo.owner@example.com }]');
  // The demo has no remote to publish to, and pushing is not what it is demonstrating.
  portfolio = portfolio.replace(/^  publish: \w+$/m, '  publish: off');
  portfolio = portfolio.replace(/^repositories:.*$/m, [
    'repositories:',
    ...Object.entries(repositories).map(([id, entry]) =>
      `  ${id}: { url: "${entry.url}", defaultBranch: main, required: true }`)
  ].join('\n'));
  await writeFile(portfolioPath, portfolio);

  const workflowPath = path.join(lead, 'singularity/workflow.yml');
  await writeFile(workflowPath, configureLocalDemoWorkflow(await readFile(workflowPath, 'utf8')));
  git(['add', '.'], lead);
  git(['commit', '-m', 'Configure repositories and approvers'], lead);

  step('Starting the Epic');
  flow(['epic', 'start', '--local', '--title', 'One-tap checkout',
    '--description', 'Reduce checkout to a single tap for returning shoppers',
    '--goal', 'Lift checkout completion from 71% to 80%'], lead);

  const epic = git(['branch', '--show-current'], lead);

  step('Pinning a source');
  const brief = path.join(base, 'brief.md');
  await writeFile(brief, [
    '# One-tap checkout brief', '',
    'Checkout completion is 71% against a target of 80%. The dominant drop-off is the',
    'confirmation step after payment details are entered.', '',
    '## Requirements',
    '- REQ-001 A returning shopper with a stored card can complete a purchase in one tap.',
    '- REQ-002 The one-tap path is offered only where the acquirer permits stored-credential reuse.', ''
  ].join('\n'));
  flow(['epic', 'sources', 'add', '--provider', 'local', '--file', brief], lead);
  flow(['epic', 'sources', 'verify', '--materialize'], lead, { allowFailure: true });

  const sourceId = /SRC-[0-9A-F]+/.exec(flow(['epic', 'sources', 'list'], lead).stdout)?.[0] ?? 'SRC-UNKNOWN';
  const artifacts = path.join(lead, 'singularity/initiatives', epic, 'artifacts');

  step('Intake');
  flow(['initiative', 'phase'], lead);
  flow(['initiative', 'phase', 'publish', 'epic-intake'], lead);
  confirm('epic-intake:phase', ['initiative', 'approve', 'phase', '--acknowledge-self-approval'], lead);

  step('Requirements');
  flow(['initiative', 'phase'], lead);
  const requirements = path.join(artifacts, 'epic-requirements');
  await writeFile(path.join(requirements, 'traceability.yml'), [
    'version: 1', `epicId: "${epic}"`, '',
    'requirements:',
    '  - id: REQ-001',
    '    statement: "A returning shopper with a stored card can complete a purchase in one tap."',
    '    priority: Must', '    sources:', `      - sourceId: ${sourceId}`, '        locator: "§Requirements REQ-001"',
    '  - id: REQ-002',
    '    statement: "One-tap is offered only where the acquirer permits stored-credential reuse."',
    '    priority: Must', '    sources:', `      - sourceId: ${sourceId}`, '        locator: "§Requirements REQ-002"', '',
    'acceptanceCriteria:',
    '  - id: AC-001', '    requirements: [REQ-001]', '    sources:',
    `      - sourceId: ${sourceId}`, '        locator: "§Requirements REQ-001"',
    '  - id: AC-002', '    requirements: [REQ-002]', '    sources:',
    `      - sourceId: ${sourceId}`, '        locator: "§Requirements REQ-002"', ''
  ].join('\n'));
  await writeFile(path.join(requirements, 'requirements.md'),
    `${await readFile(path.join(requirements, 'requirements.md'), 'utf8')}
## Requirements

| ID | Statement | Priority |
|---|---|---|
| REQ-001 | A returning shopper with a stored card can complete a purchase in one tap. | Must |
| REQ-002 | One-tap is offered only where the acquirer permits stored-credential reuse. | Must |

## Acceptance criteria

| ID | Requirement | Criterion |
|---|---|---|
| AC-001 | REQ-001 | A stored-card shopper completes checkout with a single tap. |
| AC-002 | REQ-002 | The one-tap path is hidden where the acquirer forbids reuse. |

## Decisions to revisit

| Decision | Why it may need revisiting |
|---|---|
| Launch to 5% of traffic first | The ramp depends on the fraud rate we observe |

## Still unknown

| Open question | What would resolve it |
|---|---|
| Whether the acquirer permits stored-credential reuse | Written confirmation from the acquirer |
`);
  await writeFile(path.join(requirements, 'impact-analysis.yml'), [
    'version: 1', `epicId: "${epic}"`, 'repositories:',
    '  api:', '    changeType: modify', '    requirements: [REQ-001, REQ-002]',
    '    components:', '      - path: src/payments', '        responsibility: Payment intent creation',
    '  mobile:', '    changeType: modify', '    requirements: [REQ-001]',
    '    components:', '      - path: src/checkout', '        responsibility: One-tap purchase sheet', ''
  ].join('\n'));
  flow(['initiative', 'phase', 'publish', 'epic-requirements'], lead);
  confirm('epic-requirements:phase', ['initiative', 'approve', 'phase', '--acknowledge-self-approval'], lead);

  step('Planning');
  flow(['initiative', 'phase'], lead);
  const planning = path.join(artifacts, 'epic-planning');
  const plan = [
    'version: 2', `initiativeId: "${epic}"`, '', 'epics:',
    '  - planId: EPIC-001', '    title: "One-tap checkout"',
    '    description: "Reduce checkout to a single tap for returning shoppers."',
    '    acceptanceCriteria: [AC-001, AC-002]', '', '    stories:',
    ...Object.entries(repositories).flatMap(([id, entry]) => [
      `      - planId: ${entry.story}`,
      `        title: "${entry.title}"`,
      `        description: "${entry.description}"`,
      `        specification: "${entry.specification}"`,
      `        repository: ${id}`,
      `        requirements: [${entry.requirements.join(', ')}]`,
      `        acceptanceCriteria: [${entry.acceptanceCriteria.join(', ')}]`,
      '        blocking: true',
      '        suggestedWorkType: feature',
      ...(entry.dependsOn.length
        ? ['        dependsOn:', ...entry.dependsOn.flatMap((dependency) => [
          `          - story: ${dependency}`, '            requiredPhase: implementation-spec'])]
        : ['        dependsOn: []']),
      ''
    ])
  ].join('\n');
  await writeFile(path.join(planning, 'story-plan.yml'), plan);
  // The executable form. Only the planning-promotion path normally writes this; the demo writes it
  // directly because it has no Copilot session to promote from.
  await writeFile(path.join(lead, 'singularity/initiatives', epic, 'breakdown.yml'), plan);

  const { createHash } = await import('node:crypto');
  const specs = Object.values(repositories).map((entry) => [entry.story,
    `# ${entry.story} — ${entry.title}\n\n## Requirements\n${entry.requirements.map((r) => `- ${r}`).join('\n')}\n\n`
    + `## Acceptance criteria\n${entry.acceptanceCriteria.map((a) => `- ${a}`).join('\n')}\n\n`
    + `## Specification\n${entry.specification}\n`]);
  const index = ['version: 1', `epicId: "${epic}"`, 'stories:'];
  for (const [id, body] of specs) {
    const file = path.join(planning, 'stories', id, 'story-spec.md');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
    index.push(`  - planId: ${id}`, `    path: stories/${id}/story-spec.md`,
      `    sha256: "${createHash('sha256').update(body).digest('hex')}"`,
      `    bytes: ${Buffer.byteLength(body)}`);
  }
  await writeFile(path.join(planning, 'story-spec-index.yml'), `${index.join('\n')}\n`);
  flow(['initiative', 'phase', 'publish', 'epic-planning'], lead);
  confirm('epic-planning:phase', ['initiative', 'approve', 'phase', '--acknowledge-self-approval'], lead);

  step('Materializing Story branches');
  flow(['initiative', 'materialize', '--confirm', epic], lead);

  return { repository: lead, epic };
}

/**
 * The engine, staged inside the extension so a packaged install is self-contained.
 *
 * resolveCli already looks for `<extensionPath>/cli/bin/singularity-flow.mjs` — the same layout the
 * packaged distribution uses for its bundled runtime. Without this an installed extension finds no engine and
 * the first thing a new user meets is a settings path to fill in, which is a poor greeting for a tool
 * whose entire value is that it runs commands for you.
 *
 * `yaml` comes along because it is the engine's one dependency; `npm run check` asserts there is
 * exactly one, so this list does not quietly grow.
 */
/**
 * `docs` is here because the topic *bodies* live in `docs/topics/` and are read at runtime —
 * `src/docs-manifest.json` is an index of ids, titles and hashes, and carries no prose.
 *
 * Omitting it produced the worst possible shape of failure: the manifest staged, so the Help view
 * listed all 32 topics and looked healthy, and every single one failed on click with a raw ENOENT.
 * A missing index would at least have shown an empty list. 128 KB against a 6.3 MB payload.
 */
export const CLI_PAYLOAD = ['bin', 'src', 'docs', 'templates', 'plugin', 'schemas', 'package.json', 'HELP.md', 'LICENSE'];

/**
 * A packaging toolchain that is present in both the public registry and the company mirror.
 *
 * `@vscode/vsce` permits a floating `@azure/identity`. Identity 4.13.1 in turn permits newer MSAL
 * releases, and msal-node 5.5.0 hard-pins msal-common 16.12.0. A mirror that has synchronized only
 * through 16.11.3 then fails with ETARGET even though none of this repository's dependencies are at
 * fault. Node 5.1.0 and browser 5.5.0 are the compatible release pair: both require exactly common
 * 16.3.0. Keep all four versions explicit so a public-registry build and a mirrored build resolve
 * the same compatible MSAL graph.
 */
export const VSCE_TOOLCHAIN = Object.freeze({
  vsce: '3.9.2',
  identity: '4.13.1',
  msalNode: '5.1.0',
  msalBrowser: '5.5.0',
  msalCommon: '16.3.0'
});

export function vsceToolManifest() {
  return {
    private: true,
    dependencies: { '@vscode/vsce': VSCE_TOOLCHAIN.vsce },
    overrides: {
      '@azure/identity': VSCE_TOOLCHAIN.identity,
      '@azure/msal-node': VSCE_TOOLCHAIN.msalNode,
      '@azure/msal-browser': VSCE_TOOLCHAIN.msalBrowser,
      '@azure/msal-common': VSCE_TOOLCHAIN.msalCommon
    }
  };
}

async function installedPackageVersion(directory, name) {
  const manifest = path.join(directory, 'node_modules', ...name.split('/'), 'package.json');
  return JSON.parse(await readFile(manifest, 'utf8')).version;
}

/**
 * Install VSCE in a disposable directory instead of asking npx for today's dependency graph.
 *
 * The scratch install honors the caller's npm configuration, including an Artifactory registry,
 * and is removed after packaging. It never changes this repository's package.json or lockfile.
 */
export async function resolveVsce({ tempRoot = os.tmpdir() } = {}) {
  const directory = await mkdtemp(path.join(tempRoot, 'sflow-vsce-'));
  try {
    await writeFile(path.join(directory, 'package.json'), `${JSON.stringify(vsceToolManifest(), null, 2)}\n`);
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const install = spawnSync(npm, [
      'install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'
    ], { cwd: directory, stdio: 'inherit' });
    if (install.status !== 0) {
      throw new Error(`npm could not install the pinned VSCE toolchain${install.error ? `: ${install.error.message}` : ''}`);
    }

    const expected = new Map([
      ['@vscode/vsce', VSCE_TOOLCHAIN.vsce],
      ['@azure/identity', VSCE_TOOLCHAIN.identity],
      ['@azure/msal-node', VSCE_TOOLCHAIN.msalNode],
      ['@azure/msal-browser', VSCE_TOOLCHAIN.msalBrowser],
      ['@azure/msal-common', VSCE_TOOLCHAIN.msalCommon]
    ]);
    for (const [name, version] of expected) {
      const actual = await installedPackageVersion(directory, name);
      if (actual !== version) throw new Error(`Pinned VSCE toolchain expected ${name}@${version}, installed ${actual}.`);
    }

    const packageJson = JSON.parse(await readFile(
      path.join(directory, 'node_modules', '@vscode', 'vsce', 'package.json'), 'utf8'
    ));
    const relativeEntry = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.vsce;
    if (!relativeEntry) throw new Error('Installed @vscode/vsce package does not declare its vsce executable.');
    return { directory, entry: path.join(directory, 'node_modules', '@vscode', 'vsce', relativeEntry) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function stageCli({ rootDir = root, extensionDir = extension } = {}) {
  const staged = path.join(extensionDir, 'cli');
  await rm(staged, { recursive: true, force: true });
  await mkdir(staged, { recursive: true });
  for (const entry of CLI_PAYLOAD) {
    await cp(path.join(rootDir, entry), path.join(staged, entry), { recursive: true });
  }
  await cp(path.join(rootDir, 'node_modules', 'yaml'), path.join(staged, 'node_modules', 'yaml'), { recursive: true });
  return staged;
}

async function packageExtension() {
  step('Staging the CLI inside the extension');
  const staged = await stageCli();
  let vsce = null;
  try {
    step('Resolving the pinned VSCE toolchain');
    try {
      vsce = await resolveVsce();
    } catch (error) {
      console.error(`\nPackaging could not resolve the Artifactory-compatible VSCE toolchain: ${error.message}`);
      console.error('Check that the configured npm registry contains the pinned versions, then retry.');
      process.exitCode = 1;
      return;
    }
    step('Packaging a .vsix');
    const pack = spawnSync(process.execPath, [vsce.entry, 'package',
      '--no-dependencies', '--allow-missing-repository'], { cwd: extension, stdio: 'inherit' });
    if (pack.status !== 0) {
      console.error('\nPackaging could not run the pinned @vscode/vsce toolchain.');
      console.error('Without it, use the development host instead: node scripts/vscode-dev.mjs');
      process.exitCode = 1;
      return;
    }
  } finally {
    // Staged only for the package; leaving it would shadow the repository CLI during development.
    await rm(staged, { recursive: true, force: true });
    if (vsce) await rm(vsce.directory, { recursive: true, force: true });
  }

  // Read, not hardcoded. This said `singularity-flow-vscode-0.9.0.vsix` literally, so the first
  // version bump would have printed an install command for a file that does not exist.
  const { name, version } = JSON.parse(await readFile(path.join(extension, 'package.json'), 'utf8'));
  const vsix = path.join(extension, `${name}-${version}.vsix`);
  console.log([
    '',
    'Install or re-install it with:',
    `  code --install-extension ${vsix} --force`,
    '',
    '--force is what makes it a re-install: without it VS Code skips a version it already has,',
    'and the version does not change between builds. Reload the window afterwards.',
    '',
    'The engine ships inside the package, so there is nothing to configure.',
    ''
  ].join('\n'));
}

async function main() {
  if (flag('clean-github')) {
    step('Deleting the demo branches from the remote sandboxes');
    await cleanSandbox();
    return;
  }

  step('Building the extension');
  const build = spawnSync(process.execPath, [path.join(extension, 'esbuild.mjs')], {
    cwd: extension, stdio: 'inherit'
  });
  if (build.status !== 0) throw new Error('The extension bundle failed to build.');

  if (flag('package')) {
    await packageExtension();
    return;
  }

  let target = value('repo');
  let epic = null;
  if (!target) {
    const github = flag('github');
    if (github) {
      console.log([
        '',
        'Using the remote sandbox repositories. Materialization will push one branch to each:',
        ...Object.entries(SANDBOX).map(([id, entry]) => `  ${entry.story}  →  ${sandboxUrl(entry.repo)}`),
        'Remove them afterwards with: node scripts/vscode-dev.mjs --clean-github',
        ''
      ].join('\n'));
    }
    step(`Creating a demo repository against ${github ? 'the remote sandboxes' : 'local repositories'}`);
    ({ repository: target, epic } = await demoRepository({ github }));
  }

  console.log(`\nRepository: ${target}${epic ? `\nEpic:       ${epic}` : ''}`);
  if (flag('demo-only')) return;

  const editor = findEditor(value('editor'));
  if (!editor) {
    console.error('\nNo VS Code or Cursor binary was found. Open the folder yourself and run:');
    console.error(`  code --extensionDevelopmentPath=${extension} ${target}`);
    process.exitCode = 1;
    return;
  }

  step(`Opening ${editor.name}`);
  // Detached: the editor outlives this script, which is what you want from a launcher.
  const child = spawn(editor.binary, [`--extensionDevelopmentPath=${extension}`, target, '--new-window'], {
    detached: true, stdio: 'ignore'
  });
  child.unref();

  console.log([
    '',
    'The Singularity Flow view is in the activity bar on the left.',
    '',
    '  Lifecycle tree     phases, artifacts, packs, and Stories by repository',
    '  Journey            the map icon in the view title bar',
    '  Reconciliation     the compare icon beside it',
    '',
    'Approving an artifact asks you to type its exact confirmation string, exactly as the',
    'terminal does. The extension drives this checkout\'s CLI, not a globally installed one.',
    ''
  ].join('\n'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`\n${error.message}`);
    process.exitCode = 1;
  });
}
