import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const {
  copilotExtensionsHtml, copilotExtensionsView, declaredFilePatterns, extensionFacts, languageFilePatterns, listedSkills, readLastCopilotChat
} = await import(new URL('../apps/vscode/src/views/copilot-extensions-model.ts', import.meta.url).href);

const skillFile = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`;
const listing = (...skills) => `<tools><available_skills>\n${skills.map(([name, description]) => `<skill>\n<name>${name}</name>\n<description>${description}</description>\n<location>plugin</location>\n</skill>`).join('\n')}\n</available_skills></tools>`;
const installed = (id, contributes, extra = {}, files = {}) => ({ id, builtin: Boolean(extra.builtin),
  packageJSON: { displayName: extra.displayName ?? id, version: '1.0.0', contributes, activationEvents: extra.activationEvents ?? [], extensionDependencies: extra.extensionDependencies },
  text: async (file) => files[file] ?? null });

const skills = (...names) => names.map(name => ({ path: `./skills/${name}/SKILL.md` }));
const skillFiles = (...names) => Object.fromEntries(names.map(name => [`./skills/${name}/SKILL.md`, skillFile(name, `What ${name} does.`)]));

const javaTool = installed('acme.java-helper', { languageModelTools: [{ name: 'java_run' }], chatSkills: skills('java-a', 'java-b'), chatAgents: [{}, {}], mcpServerDefinitionProviders: [{}] },
  { displayName: 'Java Helper', activationEvents: ['onLanguage:java', 'workspaceContains:pom.xml'] }, skillFiles('java-a', 'java-b'));

test('only extensions that add something to Copilot are listed, by what they declare', async () => {
  const facts = await extensionFacts([
    javaTool,
    installed('acme.theme', { themes: [{}] }),
    installed('github.copilot-chat', { languageModelTools: [{ name: 'runTests' }] }, { builtin: true }),
    installed('singularityflow.singularity-flow-vscode', { languageModelTools: [{ name: 'sflow_next' }] }),
    installed('vscode.search', { languageModelTools: [{ name: 'find' }] }, { builtin: true }),
    installed('acme.needs-java', {}, { extensionDependencies: ['ACME.java-helper'], displayName: 'Needs Java' })
  ]);
  assert.deepEqual(facts.map(fact => [fact.id, fact.kind]), [['acme.java-helper', 'extension'], ['github.copilot-chat', 'copilot'],
    ['singularityflow.singularity-flow-vscode', 'singularity-flow'], ['vscode.search', 'vs-code']]);
  const [java] = facts;
  assert.deepEqual(java.tools, ['java_run']);
  assert.deepEqual(java.skills.map(skill => skill.name), ['java-a', 'java-b']);
  assert.equal(java.agents, 2);
  assert.equal(java.mcpServers, 1);
  assert.deepEqual(java.dependedOnBy, ['Needs Java'], 'a person sees what else turning it off affects');
  assert.equal(java.skills[0].chars, listing(['java-a', 'What java-a does.']).match(/<skill>[\s\S]*<\/skill>/u)[0].length, 'an estimate has the size Copilot lists it at');
});

test('a folded description and a skill with no readable file still count', async () => {
  const [fact] = await extensionFacts([installed('acme.x', { chatSkills: [{ path: './skills/folded/SKILL.md' }, { path: './skills/missing/SKILL.md' }] }, {},
    { './skills/folded/SKILL.md': '---\nname: folded\ndescription: >-\n  A long\n  description.\n---\n' })]);
  assert.deepEqual(fact.skills.map(skill => skill.name), ['folded', 'missing']);
  assert.ok(fact.skills[0].chars > fact.skills[1].chars);
});

test('the files an extension works on come from its own activation events and declared languages', () => {
  const languages = languageFilePatterns([{ contributes: { languages: [{ id: 'java', extensions: ['.java'], filenames: ['Jenkinsfile'] }] } }, { contributes: { languages: [{ id: 'java', extensions: ['.jav'] }] } }, {}]);
  assert.deepEqual(languages.get('java'), ['**/*.java', '**/Jenkinsfile', '**/*.jav']);
  assert.deepEqual(declaredFilePatterns(['onLanguage:java', 'workspaceContains:pom.xml', 'onLanguage:unknown', 'onStartupFinished', 'workspaceContains:pom.xml'], languages),
    ['**/*.java', '**/Jenkinsfile', '**/*.jav', 'pom.xml']);
});

const chat = (...skillRows) => ({ at: '2026-11-04T05:30:00.000Z', sameWorkspace: true, firstCallTokens: 27_000, toolTokens: 13_000, toolCount: 150, skills: skillRows.map(([name, chars]) => ({ name, chars })) });
const finding = (looked, found = [], complete = true) => ({ looked, found, complete });

test('advice follows what was measured and what this workspace holds, and says why', async () => {
  const facts = await extensionFacts([javaTool,
    installed('acme.py-helper', { chatSkills: skills('py-a') }, { displayName: 'Python Helper' }, skillFiles('py-a')),
    installed('acme.ts-helper', { chatSkills: skills('ts-a') }, { displayName: 'TS Helper' }, skillFiles('ts-a')),
    installed('acme.slow-helper', { chatSkills: skills('slow-a') }, { displayName: 'Slow Helper' }, skillFiles('slow-a')),
    installed('acme.tools-only', { languageModelTools: [{ name: 'only_tool' }] }, { displayName: 'Tools Only' }),
    installed('github.copilot-chat', { chatSkills: skills('copilot-a') }, { builtin: true, displayName: 'Copilot' }, skillFiles('copilot-a'))]);
  const view = copilotExtensionsView(facts, chat(['java-a', 4_000], ['java-b', 2_000], ['py-a', 800], ['ts-a', 400], ['slow-a', 200], ['copilot-a', 100], ['my-own', 40]), new Map([
    ['acme.java-helper', finding(['**/*.java', 'pom.xml'])],
    ['acme.ts-helper', finding(['**/*.ts'], ['**/*.ts'])],
    ['acme.slow-helper', finding(['**/*.go'], [], false)]
  ]));
  const row = (id) => view.rows.find(entry => entry.id === id);
  assert.equal(row('acme.java-helper').advice, 'turn-off');
  assert.equal(row('acme.java-helper').skillTokens, 1_500, 'exact characters from the chat, at four per token');
  assert.match(row('acme.java-helper').why, /about 1,500 tokens to every call\. Nothing in this workspace matches.*\(\*\.java, pom\.xml\)/u);
  assert.equal(row('acme.ts-helper').advice, 'your-call');
  assert.match(row('acme.ts-helper').why, /This workspace has \*\.ts files/u);
  assert.equal(row('acme.py-helper').advice, 'your-call', 'a manifest that says nothing is never advice to turn it off');
  assert.equal(row('acme.slow-helper').advice, 'your-call', 'a search that did not finish found nothing, not an absence');
  assert.match(row('acme.slow-helper').why, /didn't finish/u);
  assert.equal(row('acme.tools-only').advice, 'leave-on', 'tools are counted, never priced');
  assert.equal(row('github.copilot-chat').advice, 'leave-on');
  assert.equal(row('github.copilot-chat').canOpen, false);
  assert.deepEqual(view.rows.map(entry => entry.advice), [...view.rows.map(entry => entry.advice)].sort((a, b) => ['turn-off', 'your-call', 'leave-on'].indexOf(a) - ['turn-off', 'your-call', 'leave-on'].indexOf(b)), 'what to act on comes first');
  assert.equal(view.savingTokens, 1_500, 'only what the page recommends counts as a saving');
  assert.equal(view.savingShare, 1_500 / 27_000);
  assert.deepEqual(view.otherSkills, [{ name: 'my-own', tokens: 10 }]);
});

test('a skill the last chat did not list costs nothing there; with no chat at all sizes are estimates', async () => {
  const facts = await extensionFacts([javaTool]);
  const notListed = copilotExtensionsView(facts, chat(['java-a', 400]), new Map()).rows[0];
  assert.deepEqual(notListed.skills, [{ name: 'java-a', tokens: 100 }]);
  const none = copilotExtensionsView(facts, null, new Map([['acme.java-helper', finding(['pom.xml'])]]));
  assert.equal(none.rows[0].measured, false);
  assert.ok(none.rows[0].skillTokens > 0);
  assert.equal(none.savingShare, null);
  assert.match(copilotExtensionsHtml(none), /estimates from each extension's manifest/u);
  assert.match(copilotExtensionsHtml(none), /\(estimate\)/u);
});

test('the page states each number, labels the advice and only offers VS Code\'s own page', async () => {
  const facts = await extensionFacts([javaTool, installed('github.copilot-chat', { languageModelTools: [{ name: 'runTests' }] }, { builtin: true, displayName: 'Copilot <b>' })]);
  const html = copilotExtensionsHtml(copilotExtensionsView(facts, chat(['java-a', 4_000], ['java-b', 2_000]), new Map([['acme.java-helper', finding(['pom.xml'])]])));
  assert.match(html, /<strong>27,000 tokens<\/strong>/u);
  assert.match(html, /13,000 for 150 tools/u);
  assert.match(html, /remove about 1,500 tokens from every call \(6% of this start\)/u);
  assert.match(html, /Turn off here/u);
  assert.match(html, /data-cx="open" data-id="acme\.java-helper"/u);
  assert.doesNotMatch(html, /data-id="github\.copilot-chat"/u, 'Copilot itself is never offered');
  assert.match(html, /Also adds 2 chat agents, 1 MCP server source\./u);
  assert.match(html, /Disable \(Workspace\)/u);
  assert.match(html, /Copilot &lt;b&gt;/u, 'manifest text is escaped');
  assert.doesNotMatch(copilotExtensionsHtml(copilotExtensionsView(facts, chat(['java-a', 4]), new Map([['acme.java-helper', finding(['pom.xml'], ['pom.xml'])]]))), /Turning off what's marked/u, 'no saving is claimed with nothing to turn off');
  assert.match(copilotExtensionsHtml(null, 'Could not read'), /role="alert">Could not read/u);
});

test('the last chat comes from Copilot\'s own log, from VS Code, preferring this window\'s folders', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'sflow-copilot-extensions-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const here = path.join(home, 'work', 'repo');
  const session = async (name, { client = 'vscode-agent-host', cwd = '/elsewhere', minutes, tokens = 20_000, withSystem = true, withUsage = true }) => {
    const directory = path.join(home, 'session-state', name);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'workspace.yaml'), `id: ${name}\ncwd: ${cwd}\nclient_name: ${client}\n`);
    const events = [JSON.stringify({ type: 'user.message', data: { content: 'session.usage_record is only a word here' } }),
      withSystem ? JSON.stringify({ type: 'system.message', data: { content: listing(['java-a', 'x'], ['py-a', 'yy']) } }) : '',
      'not json "session.usage_record"',
      withUsage ? JSON.stringify({ type: 'session.usage_record', data: { usage: { inputTokens: tokens, toolTokenCount: 13_305, availableToolCount: 154 } } }) : '',
      JSON.stringify({ type: 'session.usage_record', data: { usage: { inputTokens: 999_999 } } })].filter(Boolean);
    if (!withUsage) events.pop();
    await writeFile(path.join(directory, 'events.jsonl'), `${events.join('\n')}\n`);
    const when = new Date(Date.now() - minutes * 60_000);
    await utimes(path.join(directory, 'events.jsonl'), when, when);
  };
  assert.equal(await readLastCopilotChat(path.join(home, 'absent'), [here]), null, 'no log is no chat, not a failure');
  await session('cli-newest', { client: 'github/cli', cwd: here, minutes: 1 });
  await session('vscode-elsewhere', { cwd: '/elsewhere', minutes: 2, tokens: 11_111 });
  await session('vscode-no-call', { cwd: here, minutes: 3, withUsage: false });
  const other = await readLastCopilotChat(home, ['/no/such/folder']);
  assert.equal(other.firstCallTokens, 11_111, 'with none in this window, the newest VS Code chat anywhere');
  assert.equal(other.sameWorkspace, false);
  await session('vscode-here', { cwd: path.join(here, '.singularity-flow', 'story-worktrees', '.w-1'), minutes: 4, tokens: 27_747 });
  const chatHere = await readLastCopilotChat(home, [here]);
  assert.equal(chatHere.sameWorkspace, true);
  assert.equal(chatHere.firstCallTokens, 27_747, 'the first call, before any work; not a later one');
  assert.equal(chatHere.toolTokens, 13_305);
  assert.equal(chatHere.toolCount, 154);
  assert.deepEqual(chatHere.skills.map(skill => skill.name), ['java-a', 'py-a']);
});

test('listed skills are read only from the available skills block', () => {
  assert.deepEqual(listedSkills('<skill><name>outside</name></skill>'), []);
  assert.deepEqual(listedSkills(listing(['a', 'first'])).map(skill => skill.name), ['a']);
});

test('the page is one menu entry away and loads only when opened', async () => {
  const read = (file) => readFile(new URL(`../apps/vscode/${file}`, import.meta.url), 'utf8');
  const sidebar = await read('src/views/sidebar.ts');
  assert.match(sidebar, /'help-tools': \{ title: 'Help & diagnostics', ids: \[[^\]]*'copilot-extensions'/u);
  assert.match(sidebar, /'copilot-extensions': 'singularityFlow\.openCopilotExtensions'/u);
  assert.match(await read('src/lazy-panels-runtime.ts'), /CopilotExtensionsPanel/u);
  assert.ok(JSON.parse(await read('package.json')).contributes.commands.some(entry => entry.command === 'singularityFlow.openCopilotExtensions'));
  const extension = await read('src/extension.ts');
  assert.match(extension, /registerCommand\('singularityFlow\.openCopilotExtensions', \(\) => lazyPanels\(\)\.CopilotExtensionsPanel\.show\(\)\)/u);
  assert.doesNotMatch(extension, /from '\.\/views\/copilot-extensions/u, 'never in the activation bundle');
});
