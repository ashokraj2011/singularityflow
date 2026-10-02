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
import test from 'node:test';
import { register } from 'node:module';

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

const { parseAgent, renderAgent } = await import('../apps/vscode/src/views/instruction-designer-model.ts');
const { parseAgentDependencies } = await import('../src/agents.mjs');

const SOURCE = '.github/agents/reviewer.agent.md';

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
