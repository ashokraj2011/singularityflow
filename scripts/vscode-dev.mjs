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
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod, copyFile, link, lstat, mkdtemp, mkdir, readdir, readFile, rename, rm, writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePlatformProcess } from '../src/platform-process.mjs';
import {
  exactGitRoot, reproducibleBuildEnvironment, verifiedPackagingProvenance, vscodeBuildIdentity
} from './reproducible-build.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extension = path.join(root, 'apps', 'vscode');
const cli = path.join(root, 'bin', 'singularity-flow.mjs');

/**
 * Node canonicalizes an executed module URL, while argv can retain an OS alias such as macOS's
 * `/var` -> `/private/var`. Compare filesystem identity so a release worktree below the aliased
 * temporary directory cannot silently be mistaken for an imported module.
 */
export function isExecutedVscodeDevModule(
  entry = process.argv[1],
  moduleFile = fileURLToPath(import.meta.url)
) {
  if (!entry || !moduleFile) return false;
  try {
    return realpathSync(entry) === realpathSync(moduleFile);
  } catch {
    return path.resolve(entry) === path.resolve(moduleFile);
  }
}
const VSCODE_GENERATED_FILES = new Set([
  'dist/extension.cjs',
  'dist/gateway-context-runtime.cjs',
  'dist/gateway-runtime.cjs',
  'dist/gateway-status-worker.cjs',
  'dist/help-runtime.cjs',
  'dist/lazy-panels-runtime.cjs',
  'dist/support-runtime.cjs',
  'dist/world-model-build.cjs'
]);

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
 * Runtime dependencies come from the exact production closure in package-lock.json below rather
 * than a hand-maintained package list, so the source checkout and installed VSIX load the same
 * engine graph.
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
export const PACKAGING_NPM_CLI_ENV = 'SINGULARITY_FLOW_PACKAGING_NPM_CLI';

/**
 * A packaging toolchain that is present in both the public registry and the company mirror.
 *
 * `@vscode/vsce` permits a floating `@azure/identity`. Identity 4.13.1 in turn permits newer MSAL
 * releases, and msal-node 5.5.0 hard-pins msal-common 16.12.0. A mirror that has synchronized only
 * through 16.11.3 then fails with ETARGET even though none of this repository's dependencies are at
 * fault. Node 5.1.0 and browser 5.5.0 are the compatible release pair: both require exactly common
 * 16.3.0. The same identity ranges now admit Azure core releases requiring Node 22, while this
 * product supports Node 20; the committed toolchain manifest pins the last compatible core graph.
 * The lock then binds the complete closure for public-registry and mirrored builds alike.
 */
const VSCE_TOOLCHAIN_DIRECTORY = path.join(root, 'toolchains', 'vsce');
const VSCE_TOOLCHAIN_MANIFEST = path.join(VSCE_TOOLCHAIN_DIRECTORY, 'package.json');
const VSCE_TOOLCHAIN_LOCK = path.join(VSCE_TOOLCHAIN_DIRECTORY, 'package-lock.json');
const VSCE_TOOLCHAIN_SEAL = '.singularity-flow-vsce-seal.json';

export function vsceToolManifest() {
  return JSON.parse(readFileSync(VSCE_TOOLCHAIN_MANIFEST, 'utf8'));
}

const vsceToolManifestSource = vsceToolManifest();
export const VSCE_TOOLCHAIN = Object.freeze({
  vsce: vsceToolManifestSource.dependencies['@vscode/vsce'],
  identity: vsceToolManifestSource.overrides['@azure/identity'],
  msalNode: vsceToolManifestSource.overrides['@azure/msal-node'],
  msalBrowser: vsceToolManifestSource.overrides['@azure/msal-browser'],
  msalCommon: vsceToolManifestSource.overrides['@azure/msal-common']
});

async function installedPackageVersion(directory, name) {
  const manifest = path.join(directory, 'node_modules', ...name.split('/'), 'package.json');
  return JSON.parse(await readFile(manifest, 'utf8')).version;
}

function platformAllowed(values, current) {
  if (!Array.isArray(values) || values.length === 0) return true;
  if (values.includes(`!${current}`)) return false;
  const positive = values.filter((value) => !value.startsWith('!'));
  return positive.length === 0 || positive.includes(current);
}

function lockedPhysicalPackages(lock) {
  return new Map(Object.entries(lock.packages ?? {}).filter(([relative, metadata]) => relative
    && metadata?.link !== true
    && metadata?.dev !== true
    && platformAllowed(metadata?.os, process.platform)
    && platformAllowed(metadata?.cpu, process.arch)));
}

function installedPhysicalPackages(directory) {
  const found = new Set();
  const visit = (nodeModules, relativeNodeModules) => {
    if (!existsSync(nodeModules)) return;
    for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
      if (entry.name === '.bin' || entry.name === '.package-lock.json') continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error(`Cached VSCE package entry is not an ordinary directory: ${relativeNodeModules}/${entry.name}.`);
      }
      if (entry.name.startsWith('@')) {
        for (const child of readdirSync(path.join(nodeModules, entry.name), { withFileTypes: true })) {
          const relative = `${relativeNodeModules}/${entry.name}/${child.name}`;
          if (!child.isDirectory() || child.isSymbolicLink()) {
            throw new Error(`Cached VSCE package entry is not an ordinary directory: ${relative}.`);
          }
          found.add(relative);
          visit(path.join(nodeModules, entry.name, child.name, 'node_modules'), `${relative}/node_modules`);
        }
        continue;
      }
      const relative = `${relativeNodeModules}/${entry.name}`;
      found.add(relative);
      visit(path.join(nodeModules, entry.name, 'node_modules'), `${relative}/node_modules`);
    }
  };
  visit(path.join(directory, 'node_modules'), 'node_modules');
  return found;
}

function verifyLockedVsceClosure(directory) {
  const manifestBytes = readFileSync(path.join(directory, 'package.json'));
  const lockBytes = readFileSync(path.join(directory, 'package-lock.json'));
  if (!manifestBytes.equals(readFileSync(VSCE_TOOLCHAIN_MANIFEST))
    || !lockBytes.equals(readFileSync(VSCE_TOOLCHAIN_LOCK))) {
    throw new Error('Cached VSCE manifest or lock differs from the committed install authority.');
  }
  const expected = lockedPhysicalPackages(JSON.parse(lockBytes));
  const actual = installedPhysicalPackages(directory);
  const missing = [...expected.keys()].filter((relative) => !actual.has(relative));
  const extra = [...actual].filter((relative) => !expected.has(relative));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`Cached VSCE physical closure differs from its lock (missing: ${missing.join(', ') || '-'}; extra: ${extra.join(', ') || '-'}).`);
  }
  for (const [relative, metadata] of expected) {
    const installed = JSON.parse(readFileSync(path.join(directory, relative, 'package.json'), 'utf8'));
    if (installed.version !== metadata.version) {
      throw new Error(`Locked VSCE closure expected ${relative}@${metadata.version}, installed ${installed.version}.`);
    }
  }
}

function vsceTreeDigest(directory) {
  const digest = createHash('sha256');
  const visit = (absolute, relative) => {
    const metadata = lstatSync(absolute);
    if (metadata.isSymbolicLink()) {
      throw new Error(`VSCE toolchain contains a symbolic link: ${relative}.`);
    }
    if (metadata.isDirectory()) {
      digest.update(`D\0${relative}\0`);
      const entries = readdirSync(absolute);
      entries.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
      for (const entry of entries) visit(path.join(absolute, entry), `${relative}/${entry}`);
      return;
    }
    if (!metadata.isFile()) throw new Error(`VSCE toolchain contains a special file: ${relative}.`);
    const bytes = readFileSync(absolute);
    digest.update(`F\0${relative}\0${metadata.mode & 0o777}\0${bytes.length}\0`);
    digest.update(bytes);
    digest.update('\0');
  };
  for (const entry of ['package.json', 'package-lock.json', 'node_modules']) {
    visit(path.join(directory, entry), entry);
  }
  return `sha256:${digest.digest('hex')}`;
}

async function sealVsceToolchain(directory) {
  verifyLockedVsceClosure(directory);
  const lockSha256 = `sha256:${createHash('sha256')
    .update(readFileSync(path.join(directory, 'package-lock.json'))).digest('hex')}`;
  await writeFile(path.join(directory, VSCE_TOOLCHAIN_SEAL), `${JSON.stringify({
    schemaVersion: 1,
    lockSha256,
    platform: process.platform,
    architecture: process.arch,
    nodeMajor: process.versions.node.split('.')[0],
    treeSha256: vsceTreeDigest(directory)
  }, null, 2)}\n`);
}

function verifyVsceToolchainSeal(directory) {
  verifyLockedVsceClosure(directory);
  const seal = JSON.parse(readFileSync(path.join(directory, VSCE_TOOLCHAIN_SEAL), 'utf8'));
  const expectedLock = `sha256:${createHash('sha256')
    .update(readFileSync(VSCE_TOOLCHAIN_LOCK)).digest('hex')}`;
  if (seal.schemaVersion !== 1 || seal.lockSha256 !== expectedLock
    || seal.platform !== process.platform || seal.architecture !== process.arch
    || seal.nodeMajor !== process.versions.node.split('.')[0]
    || seal.treeSha256 !== vsceTreeDigest(directory)) {
    throw new Error('Cached VSCE toolchain seal does not match its locked physical tree.');
  }
}

/**
 * Where cached VSCE toolchains live, and the env override tests use to relocate them.
 *
 * The machine state root rather than `os.tmpdir()`: macOS purges temp directories on its own
 * schedule, and a cache that silently evaporates turns "fast on the second install" back into a
 * five-minute lottery.
 */
export const VSCE_TOOLCHAIN_ROOT_ENV = 'SINGULARITY_FLOW_VSCE_TOOLCHAIN_ROOT';
export const VSCE_TOOLCHAIN_REFRESH_ENV = 'SINGULARITY_FLOW_REFRESH_VSCE_TOOLCHAIN';

function vsceToolchainRoot() {
  const explicit = String(process.env[VSCE_TOOLCHAIN_ROOT_ENV] ?? '').trim();
  if (explicit) return path.resolve(explicit);
  return path.join(os.homedir(), '.singularity-flow', 'toolchains', 'vsce');
}

/**
 * The lock digest binds the complete package graph and every tarball integrity. Registry remains a
 * trust boundary; Node major and host platform/architecture remain physical-tree boundaries.
 */
export function vsceToolchainKey() {
  const registry = String(
    process.env.NPM_CONFIG_REGISTRY ?? process.env.npm_config_registry ?? 'https://registry.npmjs.org/'
  ).trim();
  const lockDigest = createHash('sha256').update(readFileSync(VSCE_TOOLCHAIN_LOCK)).digest('hex');
  const seed = JSON.stringify({
    lockDigest,
    registry,
    nodeMajor: process.versions.node.split('.')[0],
    platform: process.platform,
    architecture: process.arch
  });
  return createHash('sha256').update(seed).digest('hex').slice(0, 12);
}

/**
 * Verify a toolchain tree and return its vsce entry point.
 *
 * This is the same check a fresh install always ran; pointing it at a cached tree is what makes
 * the cache safe to trust. A partial or tampered tree fails here and is rebuilt, so a cache hit
 * proves exactly what a cold install proves.
 */
async function verifiedVsceEntry(directory) {
  verifyVsceToolchainSeal(directory);
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
  return path.join(directory, 'node_modules', '@vscode', 'vsce', relativeEntry);
}

function processMayBeAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process may belong to another user; it is not proof of death.
    return error?.code !== 'ESRCH';
  }
}

/** Sweep only abandoned install work; immutable final generations may be in use elsewhere. */
async function sweepAbandonedVsceWork(rootDir) {
  const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.includes('.staging-')) {
      /**
       * Sweep only staging whose owner is gone. The first draft removed every staging directory it
       * saw, and the concurrency test failed with `ENOENT: uv_cwd` inside the stub npm — the
       * winner's prune had deleted the *loser's live working directory* mid-install. "A staging
       * directory is a crashed install" is only true when the pid in its name is dead.
       */
      const owner = Number(entry.name.match(/\.staging-(\d+)-/)?.[1]);
      if (!Number.isSafeInteger(owner) || owner <= 0 || !processMayBeAlive(owner)) {
        await rm(path.join(rootDir, entry.name), { recursive: true, force: true });
      }
      continue;
    }
    if (entry.isFile() && entry.name.includes('.publish-owner-')) {
      const owner = Number(entry.name.match(/\.publish-owner-(\d+)-/)?.[1]);
      if (!Number.isSafeInteger(owner) || owner <= 0 || !processMayBeAlive(owner)) {
        await rm(path.join(rootDir, entry.name), { force: true });
      }
    }
  }
}

const VSCE_PUBLISH_LOCK_TIMEOUT_MS = 60_000;

/**
 * Claim one content digest before publishing it.
 *
 * Node has no portable rename-if-absent operation for directories: POSIX rename can replace an
 * existing empty directory. A hard link from a fully-written unique owner file is the
 * cross-platform no-clobber arbiter; unlike opening and then filling a lock, it has no interval in
 * which another process can mistake a live but empty lock for abandoned state. A dead owner's lock
 * is renamed aside before removal, so two recovery attempts cannot both believe they acquired it.
 * Live, malformed, or permission-inaccessible owners are never disturbed.
 */
async function acquireVscePublishLock(rootDir, generationName) {
  const lockPath = path.join(rootDir, `${generationName}.publish-lock`);
  const token = randomUUID();
  const ownerName = `${generationName}.publish-owner-${process.pid}-${token}`;
  const ownerPath = path.join(rootDir, ownerName);
  await writeFile(ownerPath, `${JSON.stringify({
    pid: process.pid, token, ownerName, createdAt: Date.now()
  })}\n`, { flag: 'wx', mode: 0o600 });
  const deadline = Date.now() + VSCE_PUBLISH_LOCK_TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      try {
        await link(ownerPath, lockPath);
        return async () => {
          try {
            const owner = JSON.parse(await readFile(lockPath, 'utf8'));
            if (owner.token === token) await rm(lockPath, { force: true });
          } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
          } finally {
            await rm(ownerPath, { force: true });
          }
        };
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }

      let owner = null;
      try {
        owner = JSON.parse(await readFile(lockPath, 'utf8'));
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        // A malformed lock cannot safely be distinguished from a live writer; fail closed below.
      }
      const pid = Number(owner?.pid);
      const validOwner = Number.isSafeInteger(pid) && pid > 0
        && typeof owner?.token === 'string' && typeof owner?.ownerName === 'string';
      if (validOwner && !processMayBeAlive(pid)) {
        const abandoned = `${lockPath}.abandoned-${randomUUID()}`;
        try {
          await rename(lockPath, abandoned);
          await rm(abandoned, { force: true });
          if (path.basename(owner.ownerName) === owner.ownerName) {
            await rm(path.join(rootDir, owner.ownerName), { force: true });
          }
          continue;
        } catch (error) {
          if (error?.code === 'ENOENT') continue;
          throw error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting to publish the VSCE toolchain generation ${generationName}.`);
  } catch (error) {
    await rm(ownerPath, { force: true });
    throw error;
  }
}

async function verifiedVsceGeneration(rootDir, key) {
  const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const immutableName = new RegExp(`^${key}-[0-9a-f]{64}(?:-recovery-[0-9a-f-]{36})?$`);
  const names = entries.filter((entry) => entry.isDirectory()
    && immutableName.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  for (const name of names) {
    const directory = path.join(rootDir, name);
    try {
      return { directory, entry: await verifiedVsceEntry(directory) };
    } catch {
      // Immutable corrupt generations are ignored, never moved out from under a possible reader.
    }
  }
  return null;
}

async function verifiedVsceGenerationForDigest(rootDir, key, treeDigest) {
  const base = `${key}-${treeDigest}`;
  const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const names = entries.filter((entry) => entry.isDirectory()
    && (entry.name === base || entry.name.startsWith(`${base}-recovery-`)))
    .map((entry) => entry.name)
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  for (const name of names) {
    const directory = path.join(rootDir, name);
    try {
      const entry = await verifiedVsceEntry(directory);
      const seal = JSON.parse(await readFile(path.join(directory, VSCE_TOOLCHAIN_SEAL), 'utf8'));
      if (seal.treeSha256 === `sha256:${treeDigest}`) return { directory, entry };
    } catch {
      // Preserve corrupt generations for possible readers, and look for a healthy recovery.
    }
  }
  return null;
}

/**
 * Resolve the pinned VSCE toolchain once per lock, registry, Node major, and host platform.
 *
 * The previous version installed into a fresh `mkdtemp` directory on every run and deleted it
 * afterwards — 292 registry fetches and about five minutes per install, to re-create a tree whose
 * exact content the pin verification had already approved last time. That was most of the wall
 * time of `./install.sh --skip-tests`. The pinning goal (no npx drift, registry-honoring, never
 * touching this repository's lockfile) is kept; only the re-download is gone.
 *
 * Concurrency: installs land in a per-pid staging directory, then claim their full tree digest
 * before publication. The loser of a race finds the winner's verified tree and uses it.
 */
export async function resolveVsce({ refresh = undefined } = {}) {
  const wantRefresh = refresh ?? (flag('refresh-vsce-toolchain')
    || String(process.env[VSCE_TOOLCHAIN_REFRESH_ENV] ?? '') === '1');
  const rootDir = vsceToolchainRoot();
  const key = vsceToolchainKey();

  await mkdir(rootDir, { recursive: true });
  await chmod(rootDir, 0o700);
  await sweepAbandonedVsceWork(rootDir);

  if (!wantRefresh) {
    const generation = await verifiedVsceGeneration(rootDir, key);
    if (generation != null) return { ...generation, cached: true };
  }

  const staging = await mkdtemp(path.join(rootDir, `${key}.staging-${process.pid}-`));
  try {
    await Promise.all([
      copyFile(VSCE_TOOLCHAIN_MANIFEST, path.join(staging, 'package.json')),
      copyFile(VSCE_TOOLCHAIN_LOCK, path.join(staging, 'package-lock.json'))
    ]);
    const npm = 'npm';
    const launch = resolvePlatformProcess(npm, [
      'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline',
      '--include=peer', '--include=optional', '--omit=dev'
    ]);
    // --prefer-offline: a cold cache key still reuses npm's content cache for tarballs it has.
    const install = spawnSync(launch.executable, launch.arguments, {
      cwd: staging, stdio: 'inherit', ...launch.spawnOptions
    });
    if (install.status !== 0) {
      throw new Error(`npm could not install the pinned VSCE toolchain${install.error ? `: ${install.error.message}` : ''}`);
    }
    // VSCE is invoked by its direct JavaScript entry. npm's command shims are unnecessary links,
    // and hidden install locks are npm-version-specific metadata rather than executable closure.
    await pruneNpmInstallMetadata(path.join(staging, 'node_modules'));
    await sealVsceToolchain(staging);
    await verifiedVsceEntry(staging);
    const seal = JSON.parse(await readFile(path.join(staging, VSCE_TOOLCHAIN_SEAL), 'utf8'));
    const treeDigest = String(seal.treeSha256).replace(/^sha256:/, '');
    if (!/^[0-9a-f]{64}$/.test(treeDigest)) {
      throw new Error('VSCE toolchain seal has an invalid tree digest.');
    }
    const generationName = `${key}-${treeDigest}`;
    const releasePublishLock = await acquireVscePublishLock(rootDir, generationName);
    try {
      const winner = await verifiedVsceGenerationForDigest(rootDir, key, treeDigest);
      if (winner != null) {
        await rm(staging, { recursive: true, force: true });
        return { ...winner, cached: !wantRefresh };
      }
      let directory = path.join(rootDir, generationName);
      if (existsSync(directory)) {
        // The content name is occupied but unverified. Never replace a path a caller may be using.
        directory = path.join(rootDir, `${generationName}-recovery-${randomUUID()}`);
      }
      await rename(staging, directory);
      return { directory, entry: await verifiedVsceEntry(directory), cached: false };
    } finally {
      await releasePublishLock();
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

function gitPayloadRecords(rootDir) {
  const listed = spawnSync('git', ['ls-files', '--stage', '-z', '--', ...CLI_PAYLOAD], {
    cwd: rootDir,
    encoding: 'buffer'
  });
  if (listed.error || listed.status !== 0) {
    const detail = String(listed.stderr || listed.error?.message || '').trim();
    throw new Error(`Could not enumerate tracked CLI payload${detail ? `: ${detail}` : '.'}`);
  }
  const records = [];
  for (const raw of listed.stdout.toString('utf8').split('\0')) {
    if (!raw) continue;
    const tab = raw.indexOf('\t');
    const header = raw.slice(0, tab).split(' ');
    const relative = raw.slice(tab + 1);
    if (tab < 0 || header.length !== 3 || header[2] !== '0'
      || !['100644', '100755'].includes(header[0])
      || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(header[1])) {
      throw new Error(`CLI payload must contain only ordinary stage-zero Git files: ${relative}.`);
    }
    if (relative.includes('\n') || relative.includes('\r') || path.isAbsolute(relative)
      || relative.split('/').includes('..')) {
      throw new Error(`Unsafe tracked CLI payload path: ${JSON.stringify(relative)}.`);
    }
    records.push({ mode: header[0], oid: header[1], relative });
  }
  return records;
}

function indexPayloadBlobs(rootDir, records) {
  const input = Buffer.from(records.map(({ oid }) => `${oid}\n`).join(''));
  const result = spawnSync('git', ['cat-file', '--batch'], {
    cwd: rootDir,
    input,
    encoding: 'buffer',
    maxBuffer: 256 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || '').trim();
    throw new Error(`Could not read exact Git blobs for the CLI payload${detail ? `: ${detail}` : '.'}`);
  }
  let offset = 0;
  return records.map((record) => {
    const newline = result.stdout.indexOf(0x0a, offset);
    if (newline < 0) throw new Error(`Git omitted blob metadata for ${record.relative}.`);
    const header = result.stdout.subarray(offset, newline).toString('utf8').split(' ');
    const size = Number(header[2]);
    if (header[1] !== 'blob' || !Number.isSafeInteger(size) || size < 0) {
      throw new Error(`Tracked CLI payload is not a Git blob: ${record.relative}.`);
    }
    const start = newline + 1;
    const end = start + size;
    if (end >= result.stdout.length || result.stdout[end] !== 0x0a) {
      throw new Error(`Git returned a truncated blob for ${record.relative}.`);
    }
    offset = end + 1;
    return { ...record, bytes: result.stdout.subarray(start, end) };
  });
}

async function writePayloadFile(destination, bytes, mode) {
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
  await chmod(destination, mode === '100755' ? 0o755 : 0o644);
}

async function copyRegularTree(source, destination) {
  const metadata = await lstat(source);
  if (metadata.isSymbolicLink()) {
    throw new Error(`Packaging refuses symbolic links: ${source}`);
  }
  if (metadata.isDirectory()) {
    await mkdir(destination, { recursive: true });
    const entries = await readdir(source, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      await copyRegularTree(path.join(source, entry.name), path.join(destination, entry.name));
    }
    return;
  }
  if (!metadata.isFile()) throw new Error(`Packaging accepts only ordinary files: ${source}`);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

async function stageTrackedPayload({ rootDir, staged, environment }) {
  const records = gitPayloadRecords(rootDir);
  const provenance = verifiedPackagingProvenance(rootDir, environment);
  const identity = provenance == null ? vscodeBuildIdentity(rootDir, environment) : null;
  if (provenance != null || identity?.local === false) {
    for (const { relative, mode, bytes } of indexPayloadBlobs(rootDir, records)) {
      await writePayloadFile(path.join(staged, relative), bytes, mode);
    }
    if (provenance != null) {
      const stamped = records.find(({ relative }) => relative === provenance.stampedBuildInfo);
      if (stamped == null) throw new Error('Stamped build provenance is not a tracked CLI payload file.');
      await mkdir(path.dirname(path.join(staged, stamped.relative)), { recursive: true });
      await copyFile(path.join(rootDir, stamped.relative), path.join(staged, stamped.relative));
      await chmod(path.join(staged, stamped.relative), stamped.mode === '100755' ? 0o755 : 0o644);
      const stagedDigest = `sha256:${createHash('sha256')
        .update(await readFile(path.join(staged, stamped.relative))).digest('hex')}`;
      if (stagedDigest !== provenance.stampedBuildInfoSha256) {
        throw new Error('Staged build provenance bytes changed while the CLI payload was copied.');
      }
      verifiedPackagingProvenance(rootDir, environment);
    } else if (vscodeBuildIdentity(rootDir, environment).local) {
      throw new Error('Clean CLI source changed while its exact Git blobs were staged.');
    }
    return true;
  }
  // Dirty developer builds may package tracked edits, but ignored and untracked files never enter
  // the archive. Release builds take the exact index-blob path above.
  for (const { relative, mode } of records) {
    const source = path.join(rootDir, relative);
    const metadata = await lstat(source);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Tracked CLI payload must be an ordinary working-tree file: ${relative}.`);
    }
    await mkdir(path.dirname(path.join(staged, relative)), { recursive: true });
    await copyFile(source, path.join(staged, relative));
    await chmod(path.join(staged, relative), mode === '100755' ? 0o755 : 0o644);
  }
  return false;
}

function gitIndexFile(rootDir, relative) {
  const result = spawnSync('git', ['show', `:${relative}`], { cwd: rootDir, encoding: null });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || '').trim();
    throw new Error(`Could not read exact Git index file ${relative}${detail ? `: ${detail}` : '.'}`);
  }
  return result.stdout;
}

async function pruneNpmInstallMetadata(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.name === '.bin' || entry.name === '.package-lock.json') {
      await rm(target, { recursive: true, force: true });
    } else if (entry.isDirectory()) {
      await pruneNpmInstallMetadata(target);
    }
  }
}

function verifiedPackagingNpmCli(rootDir, environment) {
  const explicit = String(environment[PACKAGING_NPM_CLI_ENV] ?? '').trim();
  if (!explicit) return null;
  if (verifiedPackagingProvenance(rootDir, environment) == null) {
    throw new Error(`${PACKAGING_NPM_CLI_ENV} requires complete verified packaging provenance.`);
  }
  const entry = path.resolve(explicit);
  const relative = path.relative(path.resolve(rootDir), entry);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`)
    && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error(`${PACKAGING_NPM_CLI_ENV} must point outside the packaging checkout.`);
  }
  const metadata = lstatSync(entry);
  if (!metadata.isFile() || metadata.isSymbolicLink()
    || path.basename(entry) !== 'npm-cli.js' || path.basename(path.dirname(entry)) !== 'bin') {
    throw new Error(`${PACKAGING_NPM_CLI_ENV} must name an ordinary npm bin/npm-cli.js file.`);
  }
  const packageRoot = path.dirname(path.dirname(entry));
  if (path.basename(packageRoot) !== 'npm' || path.basename(path.dirname(packageRoot)) !== 'node_modules') {
    throw new Error(`${PACKAGING_NPM_CLI_ENV} must come from a private node_modules/npm package.`);
  }
  const installedManifest = path.join(packageRoot, 'package.json');
  const installedMetadata = lstatSync(installedManifest);
  if (!installedMetadata.isFile() || installedMetadata.isSymbolicLink()) {
    throw new Error(`${PACKAGING_NPM_CLI_ENV} npm package manifest must be an ordinary file.`);
  }
  const expectedManifest = JSON.parse(readFileSync(
    path.join(rootDir, 'toolchains', 'npm-pack', 'package.json'), 'utf8'
  ));
  const installed = JSON.parse(readFileSync(installedManifest, 'utf8'));
  const expectedVersion = expectedManifest.dependencies?.npm;
  if (installed.name !== 'npm' || installed.version !== expectedVersion
    || !/^\d+\.\d+\.\d+$/.test(String(expectedVersion ?? ''))) {
    throw new Error(`Pinned packaging npm expected npm@${expectedVersion}, found ${installed.name}@${installed.version}.`);
  }
  return Object.freeze({
    entry,
    sha256: createHash('sha256').update(readFileSync(entry)).digest('hex')
  });
}

async function installLockedProductionClosure({ rootDir, staged, exact, environment }) {
  const lockBytes = exact
    ? gitIndexFile(rootDir, 'package-lock.json')
    : await readFile(path.join(rootDir, 'package-lock.json'));
  await writeFile(path.join(staged, 'package-lock.json'), lockBytes);
  try {
    const npmArguments = [
      'ci', '--workspaces=false', '--ignore-scripts', '--no-audit', '--no-fund',
      '--omit=dev', '--omit=peer', '--include=optional', '--prefer-offline'
    ];
    const pinnedNpm = verifiedPackagingNpmCli(rootDir, environment);
    const launch = pinnedNpm == null
      ? resolvePlatformProcess('npm', npmArguments)
      : { executable: process.execPath, arguments: [pinnedNpm.entry, ...npmArguments] };
    const installed = spawnSync(launch.executable, launch.arguments, {
      cwd: staged,
      encoding: 'utf8',
      env: { ...process.env, ...environment },
      ...launch.spawnOptions
    });
    if (pinnedNpm != null && createHash('sha256').update(readFileSync(pinnedNpm.entry)).digest('hex')
      !== pinnedNpm.sha256) {
      throw new Error('Pinned packaging npm CLI changed while materializing the production closure.');
    }
    if (installed.error || installed.status !== 0) {
      const detail = `${installed.stdout ?? ''}${installed.stderr ?? ''}`.trim();
      throw new Error(`npm could not materialize the locked CLI production closure${detail ? `:\n${detail}` : '.'}`);
    }
    // npm's command shims and hidden install lock differ by operating system/npm version and are
    // not runtime module inputs. Remove them wherever npm placed them before VSCE enumerates files.
    await pruneNpmInstallMetadata(path.join(staged, 'node_modules'));
  } finally {
    await rm(path.join(staged, 'package-lock.json'), { force: true });
  }
}

export async function stageCli({
  rootDir = root,
  extensionDir = extension,
  environment = process.env
} = {}) {
  const staged = path.join(extensionDir, 'cli');
  await rm(staged, { recursive: true, force: true });
  try {
    await mkdir(staged, { recursive: true });
    let exact = false;
    if (exactGitRoot(rootDir) != null) {
      exact = await stageTrackedPayload({ rootDir, staged, environment });
    } else {
      // Published/Git-less source exports have no index to materialize. Keep this compatibility
      // path bounded to the declared payload and refuse links that could escape it.
      for (const entry of CLI_PAYLOAD) {
        await copyRegularTree(path.join(rootDir, entry), path.join(staged, entry));
      }
    }
    // Re-materialize from lock integrity rather than trusting mutable/ignored repository
    // node_modules bytes. The preceding full npm ci primes the configured registry/cache, so this
    // bounded production-only install is normally local and closes an otherwise unverifiable leak.
    await installLockedProductionClosure({ rootDir, staged, exact, environment });
    return staged;
  } catch (error) {
    await rm(staged, { recursive: true, force: true });
    throw error;
  }
}

/** Reject checkout conversions that would make VSCE read host-specific text bytes. */
export function assertPortablePackageCheckout(rootDir = root) {
  if (exactGitRoot(rootDir) == null) return;
  const result = spawnSync('git', [
    'ls-files', '--eol', '--', ...CLI_PAYLOAD, 'apps/vscode'
  ], { cwd: rootDir, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || '').trim();
    throw new Error(`Could not validate package checkout line endings${detail ? `: ${detail}` : '.'}`);
  }
  const unsafe = result.stdout.split(/\r?\n/).filter((line) => /(?:^|\s)[iw]\/(?:crlf|mixed)(?:\s|$)/.test(line));
  if (unsafe.length > 0) {
    throw new Error([
      'Package inputs contain CRLF or mixed Git/worktree bytes; use a fresh LF-normalized checkout.',
      ...unsafe.map((line) => `  ${line}`)
    ].join('\n'));
  }
}

export function vscodePackagingEnvironment({
  rootDir = root,
  environment = process.env,
  now = Date.now
} = {}) {
  assertPortablePackageCheckout(rootDir);
  const reproducible = reproducibleBuildEnvironment(rootDir, environment, { now });
  const sourceSeconds = Number(reproducible.SOURCE_DATE_EPOCH);
  // ZIP's DOS timestamp has no representation before 1980 or after 2107. Reject instead of
  // allowing yazl/platform coercion to produce a different archive or a late opaque failure.
  if (sourceSeconds < 315532800 || sourceSeconds >= 4354819200) {
    throw new Error('VSIX SOURCE_DATE_EPOCH must resolve to a UTC instant from 1980 through 2107.');
  }
  return {
    ...reproducible,
    // Pinned VSCE passes SOURCE_DATE_EPOCH to yazl, whose DOS timestamp encoder uses local-time
    // getters. Fixing the subprocess timezone is therefore part of the artifact hash contract.
    TZ: 'Etc/UTC',
    CI: '1'
  };
}

export function vscePackageArguments(entry, { rootDir = root } = {}) {
  return [
    '--require', path.join(rootDir, 'scripts', 'vsce-reproducible-preload.cjs'),
    entry, 'package', '--no-dependencies', '--allow-missing-repository'
  ];
}

/** Ensure VSCE cannot discover ignored, stale, or linked files outside the two owned build trees. */
export async function assertVscePackageInputs({
  entry,
  rootDir = root,
  extensionDir = extension,
  environment = process.env
}) {
  if (exactGitRoot(rootDir) == null) {
    throw new Error('VSIX packaging requires the exact Git repository root.');
  }
  const trackedResult = spawnSync('git', ['ls-files', '-z', '--', 'apps/vscode'], {
    cwd: rootDir,
    encoding: 'buffer'
  });
  if (trackedResult.error || trackedResult.status !== 0) {
    throw new Error('Could not enumerate tracked VS Code package inputs.');
  }
  const tracked = new Set(trackedResult.stdout.toString('utf8').split('\0').filter(Boolean)
    .map((relative) => relative.slice('apps/vscode/'.length)));
  const listed = spawnSync(process.execPath, [
    '--require', path.join(rootDir, 'scripts', 'vsce-reproducible-preload.cjs'),
    entry, 'ls', '--no-dependencies'
  ], { cwd: extensionDir, encoding: 'utf8', env: environment, maxBuffer: 32 * 1024 * 1024 });
  if (listed.error || listed.status !== 0) {
    const detail = `${listed.stdout ?? ''}${listed.stderr ?? ''}`.trim();
    throw new Error(`VSCE could not enumerate package inputs${detail ? `:\n${detail}` : '.'}`);
  }
  const files = listed.stdout.split(/\r?\n/).filter(Boolean);
  for (const relative of files) {
    if (path.isAbsolute(relative) || relative.split('/').includes('..')) {
      throw new Error(`VSCE selected an unsafe package path: ${relative}.`);
    }
    const metadata = await lstat(path.join(extensionDir, ...relative.split('/')));
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`VSCE package input must be an ordinary file: ${relative}.`);
    }
    if (relative.startsWith('cli/')) continue;
    if (relative.startsWith('dist/')) {
      if (VSCODE_GENERATED_FILES.has(relative)) continue;
      throw new Error(`VSCE selected an unexpected generated file: ${relative}.`);
    }
    if (!tracked.has(relative)) {
      throw new Error(`VSCE selected an ignored or untracked package input: ${relative}.`);
    }
  }
  return files;
}

async function packageExtension(packagingEnvironment = vscodePackagingEnvironment()) {
  step('Staging the CLI inside the extension');
  const staged = await stageCli({ environment: packagingEnvironment });
  let vsce = null;
  try {
    step('Resolving the pinned VSCE toolchain');
    try {
      vsce = await resolveVsce();
      console.log(vsce.cached
        ? `  Reusing the verified toolchain cache at ${vsce.directory}.`
        : `  Installed and cached the toolchain at ${vsce.directory}.`);
    } catch (error) {
      console.error(`\nPackaging could not resolve the Artifactory-compatible VSCE toolchain: ${error.message}`);
      console.error('Check that the configured npm registry contains the pinned versions, then retry.');
      process.exitCode = 1;
      return;
    }
    step('Packaging a .vsix');
    await assertVscePackageInputs({ entry: vsce.entry, environment: packagingEnvironment });
    // CI=1 suppresses vsce's own "is there a newer vsce" registry probe — the pin table is the
    // authority on which vsce runs here, so the probe is a network round-trip that can only slow
    // an install down or contradict a decision already made.
    const pack = spawnSync(process.execPath, vscePackageArguments(vsce.entry), {
      cwd: extension, stdio: 'inherit', env: packagingEnvironment
    });
    if (pack.status !== 0) {
      console.error('\nPackaging could not run the pinned @vscode/vsce toolchain.');
      console.error('Without it, use the development host instead: node scripts/vscode-dev.mjs');
      process.exitCode = 1;
      return;
    }
  } finally {
    // Staged only for the package; leaving it would shadow the repository CLI during development.
    // The vsce toolchain, by contrast, is deliberately NOT removed any more: it is a verified,
    // content-addressed cache, and deleting it here is what made every install re-download it.
    await rm(staged, { recursive: true, force: true });
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

  const packagingEnvironment = flag('package') ? vscodePackagingEnvironment() : process.env;
  if (flag('package')) await rm(path.join(extension, 'dist'), { recursive: true, force: true });
  step('Building the extension');
  const build = spawnSync(process.execPath, [path.join(extension, 'esbuild.mjs')], {
    cwd: extension, stdio: 'inherit', env: packagingEnvironment
  });
  if (build.status !== 0) throw new Error('The extension bundle failed to build.');

  if (flag('package')) {
    await packageExtension(packagingEnvironment);
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

if (isExecutedVscodeDevModule()) {
  main().catch((error) => {
    console.error(`\n${error.message}`);
    process.exitCode = 1;
  });
}
