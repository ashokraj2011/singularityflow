import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPlugin, uninstallPlugin } from '../src/plugin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = path.join(root, 'plugin');

test('plugin manifest publishes collision-safe skills, a workflow agent, and the Documents extension', async () => {
  const manifest = JSON.parse(await readFile(path.join(pluginRoot, 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'singularity-flow');
  assert.equal(manifest.skills, 'skills/');
  assert.equal(manifest.agents, 'agents/');
  assert.equal(manifest.mcpServers, undefined);
  assert.equal(manifest.extensions, 'extensions/');
  assert.equal(manifest.hooks, 'hooks.json');
});

test('plugin hooks initialize a session persona and guard mutating tools', async () => {
  const manifest = JSON.parse(await readFile(path.join(pluginRoot, 'plugin.json'), 'utf8'));
  const hooks = JSON.parse(await readFile(path.join(pluginRoot, manifest.hooks), 'utf8'));
  assert.equal(hooks.version, 1);
  assert.deepEqual(Object.keys(hooks.hooks), ['sessionStart', 'preToolUse']);
  assert.equal(hooks.hooks.sessionStart[0].type, 'command');
  assert.equal(hooks.hooks.sessionStart[0].command, 'singularity-flow hook session-start');
  assert.equal(hooks.hooks.sessionStart[0].timeoutSec, 10);
  assert.equal(hooks.hooks.sessionStart[1].type, 'prompt');
  assert.equal(hooks.hooks.sessionStart[1].prompt, '/sflow-session');
  assert.equal(hooks.hooks.preToolUse[0].command, 'singularity-flow hook persona-guard');
  assert.match(hooks.hooks.preToolUse[0].matcher, /bash/);
});

test('session skill selects synchronized work-item state before persona binding', async () => {
  const content = await readFile(path.join(pluginRoot, 'skills', 'sflow-session', 'SKILL.md'), 'utf8');
  assert.match(content, /session candidates --json/);
  assert.match(content, /session attach <WORK-ID>/);
  assert.match(content, /work ID or Jira ID/i);
  assert.match(content, /Only after `workItemSelectionRequired` is false may persona selection begin/);
  assert.match(content, /Never create, merge, rebase, reset, force-checkout, stash, or discard work/);
});

test('inbox skill presents remote pending approvals before an explicit reviewer decision', async () => {
  const content = await readFile(path.join(pluginRoot, 'skills', 'sflow-inbox', 'SKILL.md'), 'utf8');
  assert.match(content, /singularity-flow inbox --json/);
  assert.match(content, /ask_user/);
  assert.match(content, /session attach <WORK-ID>/);
  assert.match(content, /phase show <PHASE> --json/);
  assert.match(content, /never decide or approve automatically/i);
  assert.match(content, /disable-model-invocation:\s*true/);
});

test('bundled workflow agent self-activates and ships inert dependency tables', async () => {
  const content = await readFile(path.join(pluginRoot, 'agents', 'sflow-workflow.agent.md'), 'utf8');
  assert.match(content, /name:\s*sflow-workflow/);
  assert.match(content, /singularity-flow agents sync sflow-workflow/);
  assert.match(content, /tools:.*ask_user.*write_bash/);
  assert.match(content, /YAML-derived options with `ask_user`/);
  assert.match(content, /choices begin start <WORK-ID> --json/);
  assert.match(content, /choices answer/);
  assert.match(content, /--selection-receipt/);
  assert.match(content, /choices begin approve <WORK-ID> --fetch --json/);
  assert.match(content, /never `--yes`/);
  assert.match(content, /Never infer or preselect/);
  assert.match(content, /Out of sequence[\s\S]*stop immediately/);
  assert.match(content, /## Remote skills[\s\S]*## Remote artifact templates[\s\S]*## Remote generated artifacts/);
  assert.doesNotMatch(content, /\|\s*[^-|\s][^|]*\|\s*https:\/\//);
});

test('official marketplace publishes the versioned plugin from the repository plugin directory', async () => {
  const marketplace = JSON.parse(await readFile(path.join(root, '.github/plugin/marketplace.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(pluginRoot, 'plugin.json'), 'utf8'));
  const entry = marketplace.plugins.find((item) => item.name === 'singularity-flow');
  assert.equal(marketplace.name, 'singularity-flow');
  assert.equal(marketplace.metadata.version, manifest.version);
  assert.equal(entry.version, manifest.version);
  assert.equal(entry.source, './plugin');
});

test('every skill has valid matching frontmatter', async () => {
  const skillRoot = path.join(pluginRoot, 'skills');
  const entries = (await readdir(skillRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  assert.ok(entries.length >= 10);
  for (const entry of entries) {
    const content = await readFile(path.join(skillRoot, entry.name, 'SKILL.md'), 'utf8');
    const name = content.match(/^---\n[\s\S]*?^name:\s*([^\n]+)$/m)?.[1]?.trim();
    const description = content.match(/^---\n[\s\S]*?^description:\s*([^\n]+)$/m)?.[1]?.trim();
    assert.equal(name, entry.name, `${entry.name} name mismatch`);
    assert.match(name, /^sflow-/, `${entry.name} must use the collision-safe sflow- prefix`);
    assert.ok(description, `${entry.name} missing description`);
    assert.match(name, /^[a-z0-9-]+$/);
  }
});

test('approval skill is explicitly user-invoked', async () => {
  const content = await readFile(path.join(pluginRoot, 'skills', 'sflow-approve', 'SKILL.md'), 'utf8');
  assert.match(content, /disable-model-invocation:\s*true/);
  assert.match(content, /singularity-flow approve <WORK-ID> --fetch/);
  assert.match(content, /singularity-flow phase show <phase>/);
  assert.match(content, /Never ask for approval based only on a filename or summary/);
  assert.match(content, /choices begin approve <WORK-ID> --fetch --json/);
  assert.match(content, /phase-confirmation <TYPED-PHASE>/);
  assert.match(content, /approve <WORK-ID> --fetch --selection-receipt <TOKEN>/);
  assert.match(content, /Never add `--yes`/);
  assert.match(content, /consumes the receipt exactly once/i);
});

test('submit skill presents generated documents before approval', async () => {
  const content = await readFile(path.join(pluginRoot, 'skills', 'sflow-submit', 'SKILL.md'), 'utf8');
  assert.match(content, /every generated current-phase document/);
  assert.match(content, /singularity-flow phase show <phase>/);
  assert.match(content, /show them before offering approval or rejection/);
});

test('help skill is read-only and delegates to the workflow guide', async () => {
  const content = await readFile(path.join(pluginRoot, 'skills', 'sflow-help', 'SKILL.md'), 'utf8');
  assert.match(content, /singularity-flow help <topic>/);
  assert.match(content, /singularity-flow guide <WORK-ID>/);
  assert.match(content, /HELP\.md.*canonical product manual/);
  assert.match(content, /Do not generate, submit, approve, reject, upload, commit, or push anything/);
});

test('about skill explains the brand and remains read-only', async () => {
  const content = await readFile(path.join(pluginRoot, 'skills', 'sflow-about', 'SKILL.md'), 'utf8');
  assert.match(content, /disable-model-invocation:\s*true/);
  assert.match(content, /Singularity Flow.*product.*Singularity.*brand/s);
  assert.match(content, /Copilot uses `\/sflow-<action>`/);
  assert.match(content, /Do not initialize a repository.*commit, or push/s);
});

test('report skill is read-only and preserves unavailable usage disclosure', async () => {
  const content = await readFile(path.join(pluginRoot, 'skills', 'sflow-report', 'SKILL.md'), 'utf8');
  assert.match(content, /singularity-flow report <arguments>/);
  assert.match(content, /partial.*unavailable/);
  assert.match(content, /committed .*telemetry\//i);
  assert.match(content, /provider cost captured by Copilot OTel/i);
  assert.match(content, /Do not change workflow state/);
  assert.match(content, /disable-model-invocation:\s*true/);
});

test('nextsteps skill delegates to the read-only deterministic action planner', async () => {
  const content = await readFile(path.join(pluginRoot, 'skills', 'sflow-nextsteps', 'SKILL.md'), 'utf8');
  assert.match(content, /singularity-flow nextsteps <arguments>/);
  assert.match(content, /NOW.*THEN.*ALTERNATIVE/s);
  assert.match(content, /Keep this operation read-only/);
});

test('next skill executes one action and preserves explicit approval controls', async () => {
  const content = await readFile(path.join(pluginRoot, 'skills', 'sflow-next', 'SKILL.md'), 'utf8');
  assert.match(content, /singularity-flow next --task/);
  assert.match(content, /interactive persona selection and explicit phase confirmation/);
  assert.match(content, /Every recorded approval must produce its own commit and push/);
  assert.match(content, /Do not automatically submit a generation you just published/);
  assert.match(content, /ask_user/);
  assert.match(content, /write_bash/);
});

test('generation skills display published documents instead of reducing them to summaries', async () => {
  for (const name of ['sflow-design', 'sflow-implement', 'sflow-next', 'sflow-phase', 'sflow-release', 'sflow-requirements', 'sflow-review', 'sflow-verify']) {
    const content = await readFile(path.join(pluginRoot, 'skills', name, 'SKILL.md'), 'utf8');
    assert.match(content, /published text document in full/i, `${name} must display published document content`);
    assert.match(content, /never replace (?:it|the published document) with a summary/i, `${name} must prohibit summary-only publication output`);
    assert.match(content, /phase show .*--json/i, `${name} must load a deterministic document payload`);
    assert.match(content, /visible assistant response/i, `${name} must render outside tool output`);
    assert.match(content, /Shell\/tool block.*does not (?:count|satisfy)/i, `${name} must reject collapsed Shell output as review`);
    assert.match(content, /shown above/i, `${name} must explicitly prohibit the misleading shown-above response`);
  }
});

test('generation skills preserve sanitized work-item telemetry with each publication', async () => {
  for (const name of ['sflow-next', 'sflow-phase']) {
    const content = await readFile(path.join(pluginRoot, 'skills', name, 'SKILL.md'), 'utf8');
    assert.match(content, /telemetry\/<phase>-gen<N>\.json/i, `${name} must require the committed telemetry summary`);
    assert.match(content, /without raw traces or conversation identifiers|sanitized/i, `${name} must exclude raw Copilot traces`);
    assert.match(content, /resolved model.*token\/cost status/i, `${name} must report captured model and cost`);
  }
});

test('submission and approval reproduce exact artifacts outside collapsible Shell output', async () => {
  for (const name of ['sflow-submit', 'sflow-approve']) {
    const content = await readFile(path.join(pluginRoot, 'skills', name, 'SKILL.md'), 'utf8');
    assert.match(content, /phase show <phase> --json/i, `${name} must load artifact content as JSON`);
    assert.match(content, /visible assistant response/i, `${name} must put artifacts in the response`);
    assert.match(content, /--- BEGIN <path> ---[\s\S]*--- END <path> ---/i, `${name} must delimit exact artifact bodies`);
    assert.match(content, /Shell\/tool block[\s\S]*does not satisfy artifact review/i, `${name} must not rely on collapsed command output`);
    assert.match(content, /Never say .*shown above/i, `${name} must prohibit false visibility claims`);
  }
});

test('interactive lifecycle skills bridge Copilot choices to the CLI picker without bypass flags', async () => {
  for (const name of ['sflow-start', 'sflow-resume', 'sflow-approve', 'sflow-reject', 'sflow-persona']) {
    const content = await readFile(path.join(pluginRoot, 'skills', name, 'SKILL.md'), 'utf8');
    assert.match(content, /ask_user/, `${name} must use Copilot interactive questions`);
    assert.match(content, /write_bash/, `${name} must answer the same interactive CLI process`);
    assert.match(content, /Never (?:infer|select)|never choose/iu, `${name} must prohibit model-selected defaults`);
    assert.match(content, /unavailable or disabled/, `${name} must fail safely when interactive questions are unavailable`);
  }
  const start = await readFile(path.join(pluginRoot, 'skills', 'sflow-start', 'SKILL.md'), 'utf8');
  assert.match(start, /Choose workflow template/);
  assert.match(start, /Choose persona/);
  assert.match(start, /Never pass `--type` or `--persona`/);
});

test('start skill falls back to a one-time receipt when Copilot has no persistent stdin bridge', async () => {
  const content = await readFile(path.join(pluginRoot, 'skills', 'sflow-start', 'SKILL.md'), 'utf8');
  assert.match(content, /choices begin start <WORK-ID> --json/);
  assert.match(content, /choices answer <TOKEN>/);
  assert.match(content, /--selection-receipt <TOKEN>/);
  assert.match(content, /15 minutes/);
  assert.match(content, /consumes the receipt exactly once/i);
  assert.match(content, /Never infer/);
});

test('persona skill persists only the local work-item session', async () => {
  const content = await readFile(path.join(pluginRoot, 'skills', 'sflow-persona', 'SKILL.md'), 'utf8');
  assert.match(content, /singularity-flow persona <WORK-ID>/);
  assert.match(content, /\.git\/singularity-flow\/session\.json/);
  assert.match(content, /does not commit or push/);
  assert.match(content, /disable-model-invocation:\s*true/);
});

test('inputs skill previews and renders approved phase dataflow', async () => {
  const content = await readFile(path.join(pluginRoot, 'skills', 'sflow-inputs', 'SKILL.md'), 'utf8');
  assert.match(content, /singularity-flow inputs <phase> --dry-run/);
  assert.match(content, /managed input block/);
});

test('initiative Copilot skills expose orchestration without persona authority shortcuts', async () => {
  const names = [
    'sflow-initiative-start',
    'sflow-initiative-next',
    'sflow-initiative-status',
    'sflow-initiative-checklist',
    'sflow-initiative-documents',
    'sflow-initiative-evidence',
    'sflow-initiative-materialize',
    'sflow-initiative-approve'
  ];
  for (const name of names) {
    const content = await readFile(path.join(pluginRoot, 'skills', name, 'SKILL.md'), 'utf8');
    assert.match(content, /GitHub Copilot|Copilot/, `${name} must target Copilot`);
    assert.match(content, /singularity-flow initiative/, `${name} must use the initiative CLI`);
    assert.doesNotMatch(content, /\bCodex\b/, `${name} must not describe a Codex integration`);
  }
  const start = await readFile(path.join(pluginRoot, 'skills', 'sflow-initiative-start', 'SKILL.md'), 'utf8');
  assert.match(start, /initiative choices begin start <INIT-ID> --json/);
  assert.match(start, /ask_user/);
  assert.match(start, /Never infer/);
  const approve = await readFile(path.join(pluginRoot, 'skills', 'sflow-initiative-approve', 'SKILL.md'), 'utf8');
  assert.match(approve, /configured-local/);
  assert.match(approve, /does not grant approval authority/);
  assert.match(approve, /Every approval creates and pushes its own commit/);
  const documents = await readFile(path.join(pluginRoot, 'skills', 'sflow-initiative-documents', 'SKILL.md'), 'utf8');
  assert.match(documents, /reproduce every generated text document in full/);
  assert.match(documents, /Shell\/tool block is collapsible/);
});

test('plugin install replaces direct and marketplace copies before installing one marketplace copy', () => {
  const calls = [];
  const execute = (command, args, options) => {
    calls.push({ command, args, options });
    const isMarketplaceAdd = args.join(' ') === 'plugin marketplace add ashokraj2011/singularityflow';
    return { status: isMarketplaceAdd ? 1 : 0, stdout: '', stderr: '' };
  };

  installPlugin({ execute, exists: () => true, developmentSource: undefined });

  assert.deepEqual(calls.map((call) => call.args), [
    ['plugin', 'uninstall', 'singularity-flow'],
    ['plugin', 'uninstall', 'singularity-flow@singularity-flow'],
    ['plugin', 'marketplace', 'add', 'ashokraj2011/singularityflow'],
    ['plugin', 'marketplace', 'update', 'singularity-flow'],
    ['plugin', 'install', 'singularity-flow@singularity-flow']
  ]);
  assert.equal(calls.at(-1).options.stdio, 'inherit');
});

test('plugin uninstall removes both known Copilot identities', () => {
  const calls = [];
  uninstallPlugin({
    exists: () => true,
    execute: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: '', stderr: '' };
    }
  });
  assert.deepEqual(calls.map((call) => call.args), [
    ['plugin', 'uninstall', 'singularity-flow'],
    ['plugin', 'uninstall', 'singularity-flow@singularity-flow']
  ]);
});
