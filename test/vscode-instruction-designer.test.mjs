/**
 * The agent designer, driven the way VS Code drives it.
 *
 * The host renders the page, the page's own script builds the save message from the rendered form,
 * and the host turns that message into the bytes it asks the CLI to save. A test that stops at
 * renderAgent(parseAgent(text)) never meets the shapes the page and the host give a draft, which
 * is where an untouched save stopped being byte-identical. `vscode` is replaced by a stub, as in
 * vscode-inbox-refresh.test.mjs, so the real panel class handles the messages.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

let createdPanel = null;
globalThis.__sfInstructionDesignerTestVscode = {
  ViewColumn: { Active: 1 },
  Uri: { joinPath: () => ({}) },
  window: {
    createWebviewPanel: () => {
      let receive = () => {};
      let disposed = () => {};
      createdPanel = {
        visible: true,
        webview: {
          html: '', cspSource: 'vscode-resource:',
          onDidReceiveMessage(listener) { receive = listener; return { dispose() {} }; }
        },
        post: (message) => receive(message),
        onDidDispose(listener) { disposed = listener; return { dispose() {} }; },
        reveal() {},
        dispose() { disposed(); }
      };
      return createdPanel;
    }
  }
};

const vscodeShim = 'data:text/javascript,' + encodeURIComponent(`
  export const ViewColumn = globalThis.__sfInstructionDesignerTestVscode.ViewColumn;
  export const Uri = globalThis.__sfInstructionDesignerTestVscode.Uri;
  export const window = globalThis.__sfInstructionDesignerTestVscode.window;
`);
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'vscode') return { url: ${JSON.stringify(vscodeShim)}, shortCircuit: true };
    return nextResolve(specifier, context);
  }
`));

const { InstructionDesignerPanel } = await import('../apps/vscode/src/views/instruction-designer.ts');
const { INSTRUCTION_DESIGNER_SCRIPT } = await import('../apps/vscode/src/views/instruction-designer-page.ts');
const { parseAgent, renderAgent } = await import('../apps/vscode/src/views/instruction-designer-model.ts');
const { agentStatus, lockAgent, parseAgentDependencies } = await import('../src/agents.mjs');

const SOURCE = '.github/agents/reviewer.agent.md';
const settle = () => new Promise((resolve) => setImmediate(resolve));
const decode = (text) => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * Click a button on the page the host rendered and return the message the page's own script posts.
 * Controls read the way a browser presents them: an input's value loses its line breaks, a textarea
 * drops one leading newline, and a select reports its selected option. `values` and `checked`
 * stand in for what a person typed or ticked.
 */
function click(html, button, { values = {}, checked = {} } = {}) {
  const markup = html.replace(/<script\b[\s\S]*?<\/script>/g, '');
  const has = (tag, name) => new RegExp(`\\s${name}(?=[\\s>=]|$)`).test(tag);
  const attribute = (tag, name) => {
    const found = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
    return found ? decode(found[1]) : null;
  };
  const control = (scope, name) => {
    const input = [...scope.matchAll(/<input\b[^>]*>/g)].map(([tag]) => tag).find((tag) => has(tag, name));
    if (input) return { value: (attribute(input, 'value') ?? '').replace(/[\r\n]/g, ''), checked: has(input, 'checked') };
    const area = [...scope.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)].find(([, tag]) => has(tag, name));
    if (area) return { value: decode(area[2]).replace(/^\n/, '') };
    const select = [...scope.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)].find(([, tag]) => has(tag, name));
    if (!select) return null;
    const options = [...select[2].matchAll(/<option\b([^>]*)>/g)].map(([, tag]) => tag);
    const chosen = options.find((tag) => has(tag, 'selected')) ?? options[0];
    return { value: chosen ? attribute(chosen, 'value') ?? '' : '' };
  };
  let listener = null;
  const messages = [];
  const document = {
    addEventListener(name, handler) { if (name === 'click') listener = handler; },
    querySelector(selector) {
      const name = /^\[([a-z-]+)\]$/.exec(selector)?.[1];
      const found = !name ? null : Object.hasOwn(values, name) ? { value: values[name] } : control(markup, name);
      return found && { ...found, addEventListener() {} };
    },
    querySelectorAll(selector) {
      const kind = /^\[data-remote-row="([a-z]+)"\]$/.exec(selector)?.[1];
      if (kind) {
        return [...markup.matchAll(new RegExp(`<div class="remote-row" data-remote-row="${kind}">([\\s\\S]*?)</div>`, 'g'))]
          .map(([, row]) => ({ querySelector: (inner) => control(row, inner.slice(1, -1)) }));
      }
      const name = /^input\[name="([^"]+)"\]:checked$/.exec(selector)?.[1];
      if (!name) return [];
      if (Object.hasOwn(checked, name)) return checked[name].map((value) => ({ value }));
      return [...markup.matchAll(/<input\b[^>]*>/g)].map(([tag]) => tag)
        .filter((tag) => attribute(tag, 'name') === name && has(tag, 'checked'))
        .map((tag) => ({ value: attribute(tag, 'value') }));
    }
  };
  new Function('window', 'document', INSTRUCTION_DESIGNER_SCRIPT)(
    { __sfVscode: { postMessage(message) { messages.push(message); } } }, document);
  listener({ target: { closest: () => ({ dataset: button }) } });
  return messages[0];
}

/** The real panel over a snapshot holding these agents; every save it asks for is recorded. */
async function openDesigner(t, agents, { reply = async () => null } = {}) {
  const saves = [];
  const snapshot = {
    definition: { phases: { design: { label: 'Design' }, implementation: { label: 'Implementation' } } },
    agents: agents.map(([id, content]) => ({ id, path: `.github/agents/${id}.agent.md`, content, editable: true, scope: 'repository' }))
  };
  const store = { current: { snapshot }, onDidChange: () => ({ dispose() {} }), acquireSlices: async () => ({ dispose() {} }) };
  await InstructionDesignerPanel.show({ extensionUri: {} }, store, async (message) => {
    if (message.type === 'save') saves.push(message);
    return reply(message);
  });
  const panel = createdPanel;
  t.after(() => panel.dispose());
  const send = async (message) => {
    panel.post(message);
    for (let tick = 0; tick < 5; tick += 1) await settle();
  };
  return {
    saves, send,
    html: () => panel.webview.html,
    save: (edits) => send(click(panel.webview.html, { saveAgent: '1' }, edits))
  };
}

/** A temporary repository holding one agent, as `agents lock` and `agents status` read it. */
async function repositoryWithAgent(content) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-designer-'));
  await mkdir(path.join(root, '.github/agents'), { recursive: true });
  await mkdir(path.join(root, '.git/singularity-flow'), { recursive: true });
  await writeFile(path.join(root, SOURCE), content);
  return root;
}

const REMOTE_AGENT = `---
name: reviewer
description: |
  Reviews designs against the evidence
  the phase approved.
tools: [read, search]
metadata:
  sflow-label: "Reviewer"
  sflow-phases: "design"
---

# Reviewer

Use evidence.

## Remote skills

| ID | URL | Phases | Optional | Max bytes |
|---|---|---|---|---|
| guide | https://example.test/guide.md | design | true | 1024 |
| checklist | https://example.test/checklist.md | - | false |  |

## Remote artifact templates

| ID | URL | Phases | Optional | Max bytes |
|---|---|---|---|---|
| design-template | https://example.test/template.md | design | false | - |

## Remote generated artifacts

| ID | URL template | Phase | Target | Optional | Max bytes |
|---|---|---|---|---|---|
| design-export | https://example.test/{workId}/design.md | design | artifacts/design/external-review.md | true | 2048 |

## Final instruction

Stop for human review.
`;

test('an indented remote table is replaced by the designer save, not left ahead of it', () => {
  // Markdown and the CLI both accept indented table rows and headings. The designer used to strip
  // only column-0 rows from the instructions, so a save kept the original table in the body and
  // appended the edited one: the CLI read the first table, and the edit was silently ignored.
  const original = '---\nname: reviewer\ndescription: Review documents.\ntools: [read]\n---\n\n'
    + '# Reviewer\n\nUse evidence.\n\n'
    + '## Remote skills\n\n  | ID | URL | Phases | Optional | Max bytes |\n  |---|---|---|---|---|\n'
    + '  | guide | https://example.test/guide.md | - | true | 1024 |\n\n'
    + '  ## Remote artifact templates\n\n  | ID | URL | Phases | Optional | Max bytes |\n  |---|---|---|---|---|\n'
    + '  | design-template | https://example.test/template.md | design | false | - |\n\n'
    + 'Stop for human review.\n';
  const before = parseAgentDependencies(original, { source: SOURCE });
  assert.deepEqual(before.dependencies.map((entry) => entry.url),
    ['https://example.test/guide.md', 'https://example.test/template.md']);

  const draft = parseAgent(original, 'reviewer');
  assert.equal(draft.body, '# Reviewer\n\nUse evidence.\n\nStop for human review.',
    'the tables are edited as rows, so none of them stays in the instruction text');
  assert.deepEqual(draft.remoteSkills.map((entry) => entry.url), ['https://example.test/guide.md']);
  assert.deepEqual(draft.remoteTemplates.map((entry) => entry.id), ['design-template']);

  draft.remoteSkills[0].url = 'https://example.test/guide-v2.md';
  const rendered = renderAgent(draft, original);
  assert.equal((rendered.match(/## Remote skills/g) ?? []).length, 1);
  assert.equal((rendered.match(/## Remote artifact templates/g) ?? []).length, 1);
  const after = parseAgentDependencies(rendered, { source: SOURCE });
  assert.deepEqual(after.skills.map((entry) => entry.url), ['https://example.test/guide-v2.md'],
    'the CLI reads the URL the designer saved');
  assert.deepEqual(after.templates.map(({ id, url, phases, optional, maxBytes }) => ({ id, url, phases, optional, maxBytes })),
    before.templates.map(({ id, url, phases, optional, maxBytes }) => ({ id, url, phases, optional, maxBytes })));
  assert.match(after.prompt, /^# Reviewer\n\nUse evidence\.\n\nStop for human review\.\n\n## Remote skills/);
});

test('an untouched designer save keeps an agent with remote resources byte-identical, so its lock stays current', async (t) => {
  // The page builds remote rows key by key and shows an empty max-bytes cell as '-'; the input holding
  // the description cannot keep the line breaks of a block scalar, and the host trims it. None of
  // that is an edit, so the save must hand the CLI the file's own bytes.
  const designer = await openDesigner(t, [['reviewer', REMOTE_AGENT]]);
  await designer.save();
  assert.equal(designer.saves.length, 1);
  assert.equal(designer.saves[0].content, REMOTE_AGENT, 'nothing was edited, so nothing may change');

  // The lock is keyed to the file's hash: one changed byte reports the agent stale and asks for a
  // fresh `agents lock --update` review of resources nobody changed.
  const root = await repositoryWithAgent(REMOTE_AGENT);
  const fetchImpl = async () => ({ ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => Buffer.from('# Guidance\n') });
  await lockAgent(root, 'reviewer', { accepted: true, fetchImpl });
  await writeFile(path.join(root, SOURCE), designer.saves[0].content);
  const [status] = await agentStatus(root, 'reviewer');
  assert.equal(status.sourceChanged, false);
  assert.notEqual(status.status, 'stale');

  // Editing only the description leaves the instructions and every table where the author put them.
  await designer.save({ values: { 'data-agent-description': 'Reviews designs carefully.' } });
  const body = (text) => text.slice(text.indexOf('\n---\n') + 5);
  assert.equal(body(designer.saves[1].content), body(REMOTE_AGENT));
  const edited = parseAgentDependencies(designer.saves[1].content, { source: SOURCE });
  const original = parseAgentDependencies(REMOTE_AGENT, { source: SOURCE });
  assert.equal(edited.description, 'Reviews designs carefully.');
  assert.deepEqual(edited.dependencies, original.dependencies);
  assert.equal(edited.prompt, original.prompt);
});

test('a designer edit rewrites only the frontmatter lines it changed', async (t) => {
  // Packaged agents write unpadded flow lists and quoted metadata. Re-serialising the frontmatter
  // for one edit used to pad every flow list (`tools: [ read ]`), drop the quotes of the edited
  // value and turn an edited flow tool list into a block list.
  const flow = '---\nname: reviewer\ndescription: |\n  Reviews designs.\nmodel: [auto]\ntools: [read, search]\nmetadata:\n'
    + '  sflow-label: "Reviewer"\n  sflow-phases: "design"\n---\n\n# Reviewer\n\nUse evidence.\n';
  const block = '---\nname: block-reviewer\ndescription: Reviews blocks.\ntools:\n  - read\n  - search\nmetadata:\n'
    + "  sflow-label: 'Block reviewer'\n---\n\n# Block reviewer\n\nUse evidence.\n";
  const designer = await openDesigner(t, [['reviewer', flow], ['block-reviewer', block]]);

  await designer.send({ type: 'select', path: '.github/agents/reviewer.agent.md' });
  await designer.save({ values: { 'data-agent-description': 'Reviews designs carefully.' } });
  const described = flow.replace('description: |\n  Reviews designs.\n', 'description: Reviews designs carefully.\n');
  assert.equal(designer.saves.at(-1).content, described);
  await designer.save({ values: { 'data-agent-label': 'Design reviewer' } });
  const labelled = described.replace('sflow-label: "Reviewer"', 'sflow-label: "Design reviewer"');
  assert.equal(designer.saves.at(-1).content, labelled);
  await designer.save({ checked: { 'agent-tools': ['read', 'search', 'edit'] } });
  assert.equal(designer.saves.at(-1).content, labelled.replace('tools: [read, search]', 'tools: [read, search, edit]'));

  await designer.send({ type: 'select', path: '.github/agents/block-reviewer.agent.md' });
  await designer.save({ checked: { 'agent-tools': ['read', 'search', 'edit'] } });
  const tooled = block.replace('  - search\n', '  - search\n  - edit\n');
  assert.equal(designer.saves.at(-1).content, tooled);
  await designer.save({ values: { 'data-agent-label': 'Block lead' } });
  assert.equal(designer.saves.at(-1).content, tooled.replace("sflow-label: 'Block reviewer'", "sflow-label: 'Block lead'"));
  for (const save of designer.saves) assert.doesNotThrow(() => parseAgentDependencies(save.content, { source: save.path }));
});

test('a new agent created in the designer gets the block frontmatter packaged agents use', async (t) => {
  // A new agent has no file to keep the style of. Starting from YAML '{}' made the whole frontmatter
  // one flow mapping on a single line.
  const designer = await openDesigner(t, [['reviewer', REMOTE_AGENT]]);
  await designer.send({ type: 'new' });
  await designer.save({
    values: {
      'data-agent-id': 'security-reviewer', 'data-agent-label': 'Security reviewer',
      'data-agent-description': 'Reviews changes: threats first',
      'data-agent-body': '# Security reviewer\n\nName the threat before the fix.'
    },
    checked: { 'agent-phases': ['design'], 'agent-defaults': ['design'] }
  });
  const created = '---\nname: security-reviewer\ndescription: "Reviews changes: threats first"\ntools: [read, search]\n'
    + 'metadata:\n  sflow-label: "Security reviewer"\n  sflow-phases: "design"\n  sflow-default-for: "design"\n'
    + '  sflow-world-model-views: ""\n---\n\n# Security reviewer\n\nName the threat before the fix.\n';
  assert.equal(designer.saves[0].path, '.github/agents/security-reviewer.agent.md');
  assert.equal(designer.saves[0].content, created);
  const parsed = parseAgentDependencies(created, { source: designer.saves[0].path });
  assert.deepEqual(
    { id: parsed.id, label: parsed.label, description: parsed.description, phases: parsed.phases, defaultFor: parsed.defaultFor, tools: parsed.tools },
    { id: 'security-reviewer', label: 'Security reviewer', description: 'Reviews changes: threats first', phases: ['design'], defaultFor: ['design'], tools: ['read', 'search'] }
  );

  // Its next save edits that file like any other agent.
  await designer.save({ values: { 'data-agent-label': 'Security lead' } });
  assert.equal(designer.saves[1].content, created.replace('sflow-label: "Security reviewer"', 'sflow-label: "Security lead"'));
});

test('an agent whose metadata key has no value is edited like one with empty metadata', async (t) => {
  // The CLI reads `metadata:` with no value as no metadata. Writing a label, phase, default or view
  // into it threw "Expected YAML collection at metadata", and the save silently did nothing.
  const bare = '---\nname: bare-reviewer\ndescription: Reviews.\ntools: [read]\nmetadata:\n---\n\n# Bare reviewer\n\nUse evidence.\n';
  assert.equal(parseAgentDependencies(bare, { source: '.github/agents/bare-reviewer.agent.md' }).label, 'bare-reviewer');
  const designer = await openDesigner(t, [['bare-reviewer', bare]]);
  await designer.save({ values: { 'data-agent-label': 'Bare lead' }, checked: { 'agent-phases': ['design'] } });
  assert.equal(designer.saves.length, 1, 'the save reaches the CLI');
  assert.equal(designer.saves[0].content,
    bare.replace('metadata:\n', 'metadata:\n  sflow-label: "Bare lead"\n  sflow-phases: "design"\n'));
  const saved = parseAgentDependencies(designer.saves[0].content, { source: designer.saves[0].path });
  assert.deepEqual({ label: saved.label, phases: saved.phases }, { label: 'Bare lead', phases: ['design'] });

  const draft = { ...parseAgent(bare, 'bare-reviewer'), defaultFor: ['design'], phases: ['design'], worldModelViews: ['architecture'] };
  const rendered = parseAgentDependencies(renderAgent(draft, bare), { source: designer.saves[0].path });
  assert.deepEqual({ defaultFor: rendered.defaultFor, worldModelViews: rendered.worldModelViews }, { defaultFor: ['design'], worldModelViews: ['architecture'] });
});

test('a designer message that fails is reported on the page instead of vanishing', async (t) => {
  // The panel dropped the promise of every message it handled. A failure was an unhandled
  // rejection: the button did nothing and the page said nothing.
  const rejections = [];
  const record = (error) => rejections.push(error);
  process.on('unhandledRejection', record);
  t.after(() => process.off('unhandledRejection', record));
  const designer = await openDesigner(t, [['reviewer', REMOTE_AGENT]], {
    reply: async () => { throw new Error('The save could not be started.'); }
  });
  await designer.save({ values: { 'data-agent-description': 'Reviews designs carefully.' } });
  assert.equal(designer.saves.length, 1);
  assert.match(designer.html(), /<div class="blockers"><strong>Fix before saving<\/strong><ul><li>The save could not be started\.<\/li>/);
  assert.deepEqual(rejections, []);
});
