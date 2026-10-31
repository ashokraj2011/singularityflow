/**
 * The instruction designer, driven the way VS Code drives it.
 *
 * The host renders the page, the page's own script builds the message from the rendered form, and
 * the host turns that message into what it asks the CLI or Workflow Studio to do. Agents are only
 * shown here: creating or changing one opens Workflow Studio at it (agent route A3), so no agent
 * bytes are rendered or saved by this panel. `vscode` is replaced by a stub, as in
 * vscode-inbox-refresh.test.mjs, so the real panel class handles the messages.
 */
import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import YAML from 'yaml';

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
const { agentSummary, instructionCatalog, renderAgentMappings, validateAgentMappingsDraft } =
  await import('../apps/vscode/src/views/instruction-designer-model.ts');
const { validateAgentMappings } = await import('../src/agents.mjs');

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
    // As a browser answers: the first element in document order with the attribute, of the named
    // tag when there is one. A button carrying the same attribute ahead of the field answers first.
    querySelector(selector) {
      const [, tag = '', name] = /^([a-z]*)\[([a-z-]+)\]$/.exec(selector) ?? [];
      if (!name) return null;
      const first = [...markup.matchAll(/<([a-z]+)\b([^>]*)>/g)].find(([, element, attributes]) => (!tag || element === tag) && has(` ${attributes}`, name));
      if (!first) return null;
      if (!['input', 'textarea', 'select'].includes(first[1])) return { value: attribute(first[0], 'value') ?? '', addEventListener() {} };
      const found = Object.hasOwn(values, name) ? { value: values[name] } : control(markup, name);
      return found && { ...found, addEventListener() {} };
    },
    querySelectorAll(selector) {
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

/** The real panel over a snapshot holding these agents; every message it sends the host is recorded. */
async function openDesigner(t, agents, { reply = async () => null, packaged = [] } = {}) {
  const saves = [];
  const messages = [];
  const snapshot = {
    definition: { phases: { design: { label: 'Design' }, implementation: { label: 'Implementation' } } },
    agents: agents.map(([id, content]) => ({ id, path: `.github/agents/${id}.agent.md`, content, editable: !packaged.includes(id), scope: packaged.includes(id) ? 'packaged' : 'repository' }))
  };
  const store = { current: { snapshot }, onDidChange: () => ({ dispose() {} }), acquireSlices: async () => ({ dispose() {} }) };
  await InstructionDesignerPanel.show({ extensionUri: {} }, store, async (message) => {
    messages.push(message);
    if (message.type === 'save') saves.push(message);
    return reply(message);
  });
  const panel = createdPanel;
  t.after(() => panel.dispose());
  const send = async (message) => {
    panel.post(message);
    for (let tick = 0; tick < 5; tick += 1) await settle();
  };
  return { saves, messages, send, html: () => panel.webview.html, click: (button, edits) => send(click(panel.webview.html, button, edits)) };
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

test('the mapping designer and CLI agree on parenthesized display names and safety bounds', () => {
  const agentId = 'feature-development-no-jira';
  for (const copilotAgent of ['Feature Development Agent (No Jira)', 'Architect (QA)_v2.0',
    `A${'x'.repeat(125)}()`]) {
    const rows = [{ copilotAgent, agentId }];
    assert.deepEqual(validateAgentMappingsDraft(rows, [agentId]), []);
    const rendered = renderAgentMappings(rows);
    assert.deepEqual(validateAgentMappings(YAML.parse(rendered), { agentIds: [agentId] }), {
      version: 1, mappings: { [copilotAgent]: agentId }
    });
  }
  for (const copilotAgent of ['', ' Leading', 'Trailing ', 'bad/agent', 'bad\\agent',
    'bad\nagent', 'bad\tagent', 'bad\u0000agent', 'bad\u007fagent', 'A'.repeat(129)]) {
    assert.match(validateAgentMappingsDraft([{ copilotAgent, agentId }], [agentId]).join(' '), /invalid/);
  }
  const copilotAgent = 'Feature Development Agent (No Jira)';
  assert.match(validateAgentMappingsDraft([
    { copilotAgent, agentId }, { copilotAgent, agentId }
  ], [agentId]).join(' '), /more than once/);
  assert.match(validateAgentMappingsDraft([
    { copilotAgent, agentId: 'missing' }
  ], [agentId]).join(' '), /not available/);
});

test('saving a parenthesized native agent mapping in the designer preserves its name', async (t) => {
  const name = 'Feature Development Agent (No Jira)';
  const id = 'feature-development-no-jira';
  const content = REMOTE_AGENT.replace('name: reviewer', `name: ${name}`);
  const designer = await openDesigner(t, [[id, content]]);
  await designer.send({ type: 'save-mappings', rows: [{ copilotAgent: name, agentId: id }] });
  assert.equal(designer.saves.length, 1);
  assert.equal(designer.saves[0].path, 'singularity/agent-mappings.yml');
  assert.deepEqual(validateAgentMappings(YAML.parse(designer.saves[0].content), { agentIds: [id] }), {
    version: 1, mappings: { [name]: id }
  });
});

test('the agent tab shows an agent read only and opens Workflow Studio at it to change it', async (t) => {
  const designer = await openDesigner(t, [['reviewer', REMOTE_AGENT], ['architect', '---\nname: architect\ndescription: Designs.\n---\n\n# Architect\n']], { packaged: ['architect'] });
  await designer.send({ type: 'select', path: '.github/agents/reviewer.agent.md' });
  const html = designer.html();
  assert.match(html, /<h1>Reviewer<\/h1><p class="muted">Reviews designs against the evidence the phase approved\.<\/p>/u, 'a block description reads as one line');
  assert.match(html, /data-open-studio-agent="reviewer"[^>]*>[\s\S]*?Edit in Workflow Studio<\/button>/u);
  assert.match(html, /<strong>May draft<\/strong> design/u);
  assert.match(html, /View the agent file[\s\S]*\| guide \| https:\/\/example\.test\/guide\.md/u, 'the file is shown as it is, remote tables included');
  assert.doesNotMatch(html, /data-save-agent|data-agent-body|data-agent-label|data-copy-agent|data-add-remote/u, 'there is no agent form to save');

  await designer.click({ openStudioAgent: 'reviewer' });
  assert.deepEqual(designer.messages.at(-1), { type: 'open-studio', agent: 'reviewer' });
  await designer.send({ type: 'new' });
  assert.deepEqual(designer.messages.at(-1), { type: 'open-studio', agent: null }, 'a new agent is made in Workflow Studio too');
  await designer.send({ type: 'open-studio', agent: 'not-listed' });
  assert.equal(designer.messages.length, 2, 'only a listed agent is opened');
  assert.deepEqual(designer.saves, [], 'nothing is saved from the agent tab');

  await designer.send({ type: 'select', path: '.github/agents/architect.agent.md' });
  assert.match(designer.html(), /Agent · comes with Singularity Flow[\s\S]*Duplicate it there to make an editable copy\.[\s\S]*Open in Workflow Studio/u);
  assert.deepEqual(agentSummary(REMOTE_AGENT, 'reviewer'), { label: 'Reviewer', description: 'Reviews designs against the evidence the phase approved.', phases: ['design'] });
  assert.deepEqual(agentSummary('no frontmatter', 'plain'), { label: 'plain', description: '', phases: [] });
});

test('an open the host refuses is reported on the agent tab', async (t) => {
  const designer = await openDesigner(t, [['reviewer', REMOTE_AGENT]], { reply: async (message) => message.type === 'open-studio' ? 'Workflow Studio needs a repository.' : null });
  await designer.send({ type: 'open-studio', agent: 'reviewer' });
  assert.match(designer.html(), /<li>Workflow Studio needs a repository\.<\/li>/u);
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
  await designer.send({ type: 'tab', tab: 'prompts' });
  await designer.send({ type: 'new' });
  await designer.click({ savePrompt: '1' }, { values: { 'data-prompt-id': 'review-notes', 'data-prompt-body': '# Notes' } });
  assert.equal(designer.saves.length, 1);
  assert.match(designer.html(), /<div class="blockers"><strong>Fix before saving<\/strong><ul><li>The save could not be started\.<\/li>/);
  assert.deepEqual(rejections, []);
});

test('the retired World Model builder prompt source is not listed as a prompt use', () => {
  const catalog = instructionCatalog({
    definition: {
      planning: { promptSource: 'singularity/prompts/planning.md' },
      worldModel: { promptSource: 'singularity/prompts/worldmodel-builder.md' }
    },
    prompts: [
      { path: 'singularity/prompts/planning.md', name: 'planning.md', content: '# Planning' },
      { path: 'singularity/prompts/worldmodel-builder.md', name: 'worldmodel-builder.md', content: '# Builder' }
    ]
  });
  assert.deepEqual(catalog.promptUsage, { 'singularity/prompts/planning.md': ['Copilot planning'] });
  assert.equal(catalog.prompts.find((prompt) => prompt.path.endsWith('worldmodel-builder.md')).description,
    'Reusable repository instruction');
});
