import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { addUserAgentFolder, userAgentArgv, userAgentPreviewText } from '../apps/vscode/src/user-agent-folder.ts';

const preview = (overrides = {}) => ({
  name: 'orchestrator', label: 'Orchestrator', main: 'orchestrator.agent.md', output: 'code', step: 'orchestrator', workflow: 'orchestrator',
  folder: 'team-agents', files: [{ path: 'orchestrator.agent.md', bytes: 300 }, { path: 'skills/review/SKILL.md', bytes: 90 }],
  leftOut: [{ path: '.env', reason: 'named like a secret, key or environment file; never read' }], notUsed: ['tools'],
  problems: [], planSha256: `sha256:${'a'.repeat(64)}`, confirmCommand: 'singularity-flow call add …', ...overrides
});

/** A host that answers from a script and records what it was asked and what it ran. */
function host(script) {
  const seen = { runs: [], confirms: [], picks: [], inputs: [], infos: [], errors: [], reviewed: [], studio: 0 };
  return {
    seen,
    pickFolder: async () => script.folder ?? null,
    run: async (argv) => { seen.runs.push(argv); return script.run(argv, seen.runs.length); },
    confirm: async (message, detail, buttons) => { seen.confirms.push({ message, detail, buttons }); return script.confirm?.shift(); },
    pick: async (title, items) => { seen.picks.push({ title, items }); return script.pick?.shift(); },
    input: async (prompt, value, validate) => { seen.inputs.push({ prompt, value, invalid: validate('Not A Name') }); return script.input?.shift(); },
    info: async (message, buttons) => { seen.infos.push({ message, buttons }); return script.info?.shift(); },
    error: async (message) => { seen.errors.push(message); },
    reviewAndActivate: async (branch) => { seen.reviewed.push(branch); },
    openStudio: async () => { seen.studio += 1; }
  };
}

const refusal = (code, message, details = {}) => Object.assign(new Error(message), { result: { error: { code, message, details } } });

test('the confirmation shows every copied and left-out file, and proposes exactly the previewed plan', async () => {
  const text = userAgentPreviewText(preview());
  assert.equal(text.message, 'Add Orchestrator (orchestrator) from the team-agents folder?');
  assert.match(text.detail, /Copied unchanged to singularity\/user-defined\/orchestrator\/: 2 files\./u);
  assert.match(text.detail, /• skills\/review\/SKILL\.md \(90 bytes\)/u);
  assert.match(text.detail, /Left out: 1 file\.\n {2}• \.env: named like a secret/u);
  assert.match(text.detail, /Not used from orchestrator\.agent\.md: tools/u);
  assert.match(text.detail, /nothing is active until it is activated/u);

  const fake = host({ folder: '/work/team-agents', confirm: ['Propose It'], info: ['Review and Activate…'],
    run: (argv) => (argv.includes('--confirm') ? { data: { branch: 'sflow/config-change/workflow/studio-orchestrator-1' } } : { data: preview() }) });
  assert.equal(await addUserAgentFolder(fake), 'reviewed');
  assert.deepEqual(fake.seen.runs, [
    ['call', 'add', '/work/team-agents', '--json'],
    ['call', 'add', '/work/team-agents', '--confirm', `sha256:${'a'.repeat(64)}`, '--json']
  ]);
  assert.deepEqual(fake.seen.reviewed, ['sflow/config-change/workflow/studio-orchestrator-1']);
  assert.match(fake.seen.infos[0].message, /proposed for review as sflow\/config-change\/workflow\/studio-orchestrator-1\. Once it is activated, start a Story with it from Start Work \(Your agents\)/u);
});

test('several agent files ask which one is main, a taken name asks for another, and choices carry into the plan', async () => {
  const fake = host({
    folder: '/work/pack', pick: ['agents/lead.md'], input: ['orchestrator-agent'], confirm: ['Make It a Document Step', 'Propose It'], info: [undefined],
    run: (argv, call) => {
      if (call === 1) throw refusal('USER_AGENT_MAIN_AMBIGUOUS', 'The folder has 2 agent files.', { candidates: ['agents/lead.md', 'agents/helper.md'] });
      if (call === 2) return { data: preview({ problems: ["An agent called 'orchestrator' already exists; add the folder under another name with --name."] }) };
      if (argv.includes('--confirm')) return { data: { branch: 'sflow/config-change/x' } };
      return { data: preview({ name: 'orchestrator-agent', output: argv.includes('document') ? 'document' : 'code' }) };
    }
  });
  assert.equal(await addUserAgentFolder(fake), 'proposed');
  assert.deepEqual(fake.seen.picks[0].items, ['agents/lead.md', 'agents/helper.md']);
  assert.equal(fake.seen.inputs[0].invalid, 'Use lowercase words joined by hyphens.');
  assert.deepEqual(fake.seen.runs.at(-1), ['call', 'add', '/work/pack', '--name', 'orchestrator-agent', '--main', 'agents/lead.md', '--output', 'document',
    '--confirm', `sha256:${'a'.repeat(64)}`, '--json']);
  assert.deepEqual(fake.seen.reviewed, [], 'nothing is activated unless the person chooses to review it');
});

test('a folder named like one of your agents offers to replace its folder under the same name', async () => {
  const taken = "A user-defined agent called 'orchestrator' already exists; replace its folder with --replace, or add this one under another name with --name.";
  const fake = host({
    folder: '/work/team-agents', confirm: ['Replace Its Folder', 'Propose It'], info: [undefined],
    run: (argv) => (argv.includes('--confirm') ? { data: { branch: 'sflow/config-change/r' } }
      : argv.includes('--replace') ? { data: preview({ replace: true }) } : { data: preview({ problems: [taken, "A step called 'orchestrator' already exists."] }) })
  });
  assert.equal(await addUserAgentFolder(fake), 'proposed');
  assert.deepEqual(fake.seen.confirms[0].buttons, ['Replace Its Folder', 'Use Another Name…']);
  assert.match(fake.seen.confirms[1].message, /^Replace the folder of Orchestrator \(orchestrator\) with the team-agents folder\?/u);
  assert.match(fake.seen.confirms[1].detail, /its step and workflow stay, and running Stories keep the folder they started with/u);
  assert.deepEqual(fake.seen.confirms[1].buttons, ['Propose It'], 'a replaced folder keeps its name and what its step makes');
  assert.deepEqual(fake.seen.runs.at(-1), ['call', 'add', '/work/team-agents', '--replace', '--confirm', `sha256:${'a'.repeat(64)}`, '--json']);
});

test('/sf-call runs its step through the code or document skill, never a relay', async () => {
  const skill = await readFile(new URL('../plugin/skills/sflow-call/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /Delegate once to `\/sf-code`[\s\S]*delegates once to `\/sf-phase` instead\. That canonical skill\s+runs the step itself/u);
  assert.doesNotMatch(skill, /\/sf-next/u, '/sf-next stops at code steps and only names /sf-code');
  const registry = await readFile(new URL('../plugin/skills/registry.yml', import.meta.url), 'utf8');
  assert.match(registry, /sflow-call: \{ class: delegation, executionBoundary: machine, delegatesTo: sflow-code \}/u);
});

test('cancelling anywhere proposes nothing, and a refusal is shown, not retried', async () => {
  assert.equal(await addUserAgentFolder(host({ folder: null, run: () => assert.fail('no folder, no command') })), 'cancelled');
  const dismissed = host({ folder: '/work/pack', confirm: [undefined], run: () => ({ data: preview() }) });
  assert.equal(await addUserAgentFolder(dismissed), 'cancelled');
  assert.equal(dismissed.seen.runs.length, 1, 'only the preview ran');
  const refused = host({ folder: '/work/pack', run: () => { throw refusal('USER_AGENT_FOLDER_TOO_LARGE', 'The folder holds more than 192 KiB of text.'); } });
  assert.equal(await addUserAgentFolder(refused), 'refused');
  assert.deepEqual(refused.seen.errors, ['The folder holds more than 192 KiB of text.']);
  assert.deepEqual(userAgentArgv('/f', {}, null), ['call', 'add', '/f', '--json']);
});

test('Start Work lists user-defined agents under Your agents, apart from the workflows', async () => {
  const { EMPTY_INTAKE_FORM, INTAKE_SCRIPT, intakeHtml } = await import('../apps/vscode/src/views/intake-form.ts');
  const workflow = (id, label, extra = {}) => ({ id, label, description: '', phases: [id], ...extra });
  const form = (storyWorkflows) => ({ ...EMPTY_INTAKE_FORM, shape: 'story', id: 'new-story', title: 'New Story', storyWorkflows, availableStoryWorkflows: [] });
  const html = intakeHtml(form([workflow('feature', 'Feature'), workflow('orchestrator', 'Orchestrator', { userDefinedAgent: true })]));
  assert.match(html, /<div data-workflow-agents><h3>Your agents<\/h3>/u);
  assert.match(html, /<article data-workflow-choice="orchestrator" data-workflow-agent data-workflow-search-text=/u);
  assert.match(html, /<article data-workflow-choice="feature" data-workflow-search-text=/u, 'a workflow is not an agent');
  assert.match(INTAKE_SCRIPT, /agents && row\.hasAttribute\('data-workflow-agent'\) \? agents : others/u, 'unstarred agent rows move to Your agents');
  assert.doesNotMatch(intakeHtml(form([workflow('feature', 'Feature')])), /Your agents/u, 'no group without an agent');
});

test('the command is contributed and Workflow Studio offers it beside Import and Build', async () => {
  const manifest = JSON.parse(await readFile(new URL('../apps/vscode/package.json', import.meta.url), 'utf8'));
  assert.ok(manifest.contributes.commands.some((entry) => entry.command === 'singularityFlow.addUserAgent' && /Add Your Own Agent Folder/u.test(entry.title)));
  const page = await readFile(new URL('../apps/vscode/src/views/workflow-studio-page.ts', import.meta.url), 'utf8');
  assert.match(page, /button\('Add your own agent…', function \(\) \{ post\(\{ type: 'studio\.addUserAgent' \}\); \}/u);
  const studio = await readFile(new URL('../apps/vscode/src/views/workflow-studio.ts', import.meta.url), 'utf8');
  assert.match(studio, /'studio\.addUserAgent': \(\) => this\.actions\.addUserAgent\?\.\(\)/u);
});
