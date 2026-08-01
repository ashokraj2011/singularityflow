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
      SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ persona: 'product-owner' }),
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
    SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ persona: 'product-owner' }),
    SINGULARITY_FLOW_TEST_INITIATIVE_CONFIRM: expected
  }
});

/**
 * A repository with an Epic driven all the way to materialized Story branches, so every view has
 * something in it: a pinned source, approved artifacts, a Story plan across two repositories with a
 * real dependency, and two seeded Story branches.
 */
async function demoRepository() {
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
  const api = await child('api');
  const mobile = await child('mobile');

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
    `  api: { url: "${api}", defaultBranch: main, required: true }`,
    `  mobile: { url: "${mobile}", defaultBranch: main, required: true }`
  ].join('\n'));
  await writeFile(portfolioPath, portfolio);

  const workflowPath = path.join(lead, 'singularity/workflow.yml');
  await writeFile(workflowPath, (await readFile(workflowPath, 'utf8')).replace(/grounding: \w+/, 'grounding: off'));
  git(['add', '.'], lead);
  git(['commit', '-m', 'Configure repositories and approvers'], lead);

  step('Starting the Epic');
  flow(['epic', 'start', '--local', '--title', 'One-tap checkout',
    '--description', 'Reduce checkout to a single tap for returning shoppers',
    '--goal', 'Lift checkout completion from 71% to 80%',
    '--persona', 'product-owner'], lead);

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
    '      - planId: STORY-001',
    '        title: "Payment intent endpoint for stored credentials"',
    '        description: "As a returning shopper, I want my stored card charged in one call, so that checkout is a single tap."',
    '        specification: "Adds POST /payment-intents accepting a stored-credential token, idempotent by request key."',
    '        repository: api', '        requirements: [REQ-001, REQ-002]',
    '        acceptanceCriteria: [AC-001, AC-002]', '        blocking: true',
    '        suggestedWorkType: feature', '        dependsOn: []', '',
    '      - planId: STORY-002', '        title: "One-tap purchase sheet"',
    '        description: "As a returning shopper, I want a single-tap purchase sheet, so that I do not re-enter details."',
    '        specification: "Replaces the confirmation step with a one-tap sheet when a stored card is present."',
    '        repository: mobile', '        requirements: [REQ-001]',
    '        acceptanceCriteria: [AC-001]', '        blocking: true',
    '        suggestedWorkType: feature', '        dependsOn:',
    '          - story: STORY-001', '            requiredPhase: implementation-spec', ''
  ].join('\n');
  await writeFile(path.join(planning, 'story-plan.yml'), plan);
  // The executable form. Only the planning-promotion path normally writes this; the demo writes it
  // directly because it has no Copilot session to promote from.
  await writeFile(path.join(lead, 'singularity/initiatives', epic, 'breakdown.yml'), plan);

  const { createHash } = await import('node:crypto');
  const specs = [
    ['STORY-001', '# STORY-001 — Payment intent endpoint\n\n## Requirements\n- REQ-001\n- REQ-002\n\n## Acceptance criteria\n- AC-001\n- AC-002\n\n## Specification\nAdds `POST /payment-intents` accepting a stored-credential token, idempotent by request key.\n'],
    ['STORY-002', '# STORY-002 — One-tap purchase sheet\n\n## Requirements\n- REQ-001\n\n## Acceptance criteria\n- AC-001\n\n## Specification\nReplaces the confirmation step with a one-tap sheet when a stored card is present.\n']
  ];
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
 * desktop app uses for its extraResources. Without this an installed extension finds no engine and
 * the first thing a new user meets is a settings path to fill in, which is a poor greeting for a tool
 * whose entire value is that it runs commands for you.
 *
 * `yaml` comes along because it is the engine's one dependency; `npm run check` asserts there is
 * exactly one, so this list does not quietly grow.
 */
const CLI_PAYLOAD = ['bin', 'src', 'templates', 'plugin', 'schemas', 'package.json'];

async function stageCli() {
  const staged = path.join(extension, 'cli');
  await rm(staged, { recursive: true, force: true });
  await mkdir(staged, { recursive: true });
  for (const entry of CLI_PAYLOAD) {
    await cp(path.join(root, entry), path.join(staged, entry), { recursive: true });
  }
  await cp(path.join(root, 'node_modules', 'yaml'), path.join(staged, 'node_modules', 'yaml'), { recursive: true });
  return staged;
}

async function packageExtension() {
  step('Staging the CLI inside the extension');
  const staged = await stageCli();
  try {
    step('Packaging a .vsix');
    // vsce is not a dependency of this repository; npx fetches it on demand.
    const pack = spawnSync('npx', ['--yes', '@vscode/vsce', 'package',
      '--no-dependencies', '--allow-missing-repository'], { cwd: extension, stdio: 'inherit' });
    if (pack.status !== 0) {
      console.error('\nPackaging needs @vscode/vsce, which npx fetches, so it needs network access.');
      console.error('Without it, use the development host instead: node scripts/vscode-dev.mjs');
      process.exitCode = 1;
      return;
    }
  } finally {
    // Staged only for the package; leaving it would shadow the repository CLI during development.
    await rm(staged, { recursive: true, force: true });
  }

  const vsix = path.join(extension, 'singularity-flow-vscode-0.9.0.vsix');
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
    step('Creating a demo repository (this drives a real Epic to materialized Story branches)');
    ({ repository: target, epic } = await demoRepository());
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

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exitCode = 1;
});
