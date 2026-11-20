/**
 * The VS Code host for the route follower [hardening C, "walk the VS Code path"]: what VS Code's chat really gets back from
 * SFlow's page tools, walked on a real Story. The pages are the extension's own code (the Decide card, the convergence
 * decisions, the sign-off review and the approval page's focus) bundled against a `vscode` stub; the client runs the real CLI
 * on the journey's isolated Story (route-follower.mjs journeyRepository, under run-iso's isolation); the tools are the
 * extension's own table (apps/vscode/src/lm-decision-tools.ts); and a scripted person answers on each page.
 *
 * Before this, a journey turned /sf-approve and /sf-decide into a terminal `approve --yes` and never called a VS Code tool,
 * so the approval page loop of 2026-11-20 could not be seen: the tool, the skill text the chat follows after it, and the
 * card's `remaining` each passed their own test.
 *
 *   loadVscodeHost()          the stub and the bundled pages, once per test process
 *   vscodeHost(story, opts)   one window on one Story: `callTool(name, input)`, what the person did on each page, and
 *                             the window's Story (`windowStory`), which the approval page shows
 *   engineClient(story)       the extension's client running the real CLI in the Story's checkout
 */
import { readFileSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STUB = '__sflowVscodeJourneyHost';

/** The `vscode` stub every bundled page talks to; `globalThis[STUB].current` is the window it acts for. */
function installStub() {
  if (globalThis[STUB]) return globalThis[STUB];
  const host = () => globalThis[STUB].current;
  const api = {
    current: null,
    ViewColumn: { Active: 1, Beside: 2 },
    Uri: { file: (fsPath) => ({ fsPath }), joinPath: () => ({}), parse: (value) => ({ value }) },
    commands: {
      executeCommand: async (id, ...args) => host()?.command(id, ...args),
      getCommands: async () => []
    },
    env: { clipboard: { writeText: async () => undefined }, openExternal: async () => true },
    workspace: { workspaceFolders: [{ uri: { fsPath: os.tmpdir() } }], getConfiguration: () => ({ get: (_key, fallback) => fallback }), textDocuments: [] },
    window: {
      createWebviewPanel: (viewType, title) => host().panel(viewType, title),
      createTerminal: (options) => host().terminal(options),
      showQuickPick: async (items, options) => host().quickPick(items, options),
      showInputBox: async (options) => host().inputBox(options),
      showOpenDialog: async () => undefined,
      showInformationMessage: async (message) => { host()?.said.push(message); return undefined; },
      showWarningMessage: async (message) => { host()?.said.push(message); return undefined; },
      showErrorMessage: async (message) => { host()?.said.push(message); return undefined; },
      setStatusBarMessage: () => ({ dispose() {} })
    }
  };
  globalThis[STUB] = api;
  const shim = 'data:text/javascript,' + encodeURIComponent(`
    const api = globalThis.${STUB};
    export const ViewColumn = api.ViewColumn, Uri = api.Uri, commands = api.commands, env = api.env, workspace = api.workspace, window = api.window;
  `);
  register('data:text/javascript,' + encodeURIComponent(`
    export async function resolve(specifier, context, nextResolve) {
      if (specifier === 'vscode') return { url: ${JSON.stringify(shim)}, shortCircuit: true };
      return nextResolve(specifier, context);
    }
  `));
  return api;
}

let loaded = null;
/**
 * The extension's pages, bundled with `vscode` left to the stub (their module graph holds a class Node's type stripping
 * cannot load), and the tools' table, which needs no bundling.
 */
export function loadVscodeHost() {
  loaded ??= (async () => {
    installStub();
    const out = await mkdtemp(path.join(os.tmpdir(), 'sflow-vscode-host-'));
    const views = path.join(REPOSITORY, 'apps/vscode/src/views');
    // Only the folder made here goes, when the test process ends.
    process.once('exit', () => rmSync(out, { recursive: true, force: true }));
    await build({ entryPoints: ['decide-card', 'adjudication', 'approvals', 'decision-list'].map((name) => path.join(views, `${name}.ts`)), bundle: true, platform: 'node',
      format: 'esm', external: ['vscode'], outdir: out, outExtension: { '.js': '.mjs' }, logLevel: 'silent' });
    const load = (name) => import(pathToFileURL(path.join(out, `${name}.mjs`)).href);
    const [decide, adjudication, approvals, decisionList] = await Promise.all([load('decide-card'), load('adjudication'), load('approvals'), load('decision-list')]);
    const tools = await import(pathToFileURL(path.join(REPOSITORY, 'apps/vscode/src/lm-decision-tools.ts')).href);
    const manifest = JSON.parse(readFileSync(path.join(REPOSITORY, 'apps/vscode/package.json'), 'utf8'));
    return { out, decide, adjudication, approvals, decisionList, tools, manifest };
  })();
  return loaded;
}

const json = (ran) => { const start = ran.stdout.search(/^\s*\{/mu); return start < 0 ? null : JSON.parse(ran.stdout.slice(start)); };

/** The extension's client, running the real CLI in the Story's checkout; a refusal arrives as CliError does, with its result. */
export function engineClient(story) {
  const runs = [];
  const client = {
    runs, repository: story.root, lists: [],
    invalidateReads() {},
    forkForRepository: () => client,
    run: async (argv) => {
      runs.push(argv);
      const ran = story.raw(argv);
      let value = null;
      try { value = json(ran); } catch { value = null; }
      if (ran.status !== 0) throw Object.assign(new Error(value?.error?.message ?? `exit ${ran.status}: ${ran.stderr.slice(-300)}`), { result: value });
      if (argv[0] === 'decisions' && argv.length >= 2 && !argv.includes('record')) client.lists.push(value?.data ?? value);
      return value;
    },
    runText: async (argv) => story.raw(argv).stdout
  };
  return client;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

/**
 * One VS Code window on the Story: the tools VS Code's chat calls, the pages they open and the person on them.
 *
 * `person` answers each page: `decide({ packet, versionOpening })` returns 'recommended', 'cancel', 'version-yes' or
 * 'version-no' (default: 'recommended', or 'version-yes' when only the version is asked); `witness()` returns 'yes', 'no'
 * or 'unsure'; `adjudicate({ list })` returns 'recommended' or 'cancel'.
 * `windowStory` is the Story this window shows (the approval page's); it defaults to the journey's own.
 */
export async function vscodeHost(story, { person = {}, windowStory = undefined, client = engineClient(story) } = {}) {
  const pages = await loadVscodeHost();
  const acted = new Set();
  const host = {
    story, client, pages, said: [], panels: [], terminals: [], executed: [], calls: [], person,
    windowStory: windowStory === undefined ? null : windowStory,
    /** The approval page's focus each time it was opened, with what it showed. */
    approvals: [],
    get shows() { return host.windowStory ?? story.workId; },
    panel(viewType, title) {
      let receive = () => {};
      let disposed = () => {};
      const panel = {
        viewType, title, visible: true,
        webview: { html: '', cspSource: 'vscode-resource:', onDidReceiveMessage(listener) { receive = listener; return { dispose() {} }; } },
        post: (message) => receive(message),
        onDidDispose(listener) { disposed = listener; return { dispose() {} }; },
        onDidChangeViewState() { return { dispose() {} }; },
        reveal() { panel.revealed = (panel.revealed ?? 0) + 1; }, dispose() { if (!panel.visible) return; panel.visible = false; disposed(); }
      };
      host.panels.push(panel);
      return panel;
    },
    terminal(options) { const terminal = { options, sent: [], show() {}, sendText(text) { terminal.sent.push(text); } }; host.terminals.push(terminal); return terminal; },
    // The sign-off review's quick picks: which sign-off (the first), then the one question's answer.
    quickPick: async (items, options) => {
      const list = await items;
      if (list.some((item) => 'choice' in item)) return list[0];
      const answer = host.person.witness?.({ items: list, options }) ?? 'yes';
      return answer === null ? undefined : list.find((item) => item.answer === answer);
    },
    inputBox: async (options) => host.person.note?.(options) ?? (options?.title === 'What is wrong with it?' ? 'The screen does not show the value it should.' : ''),
    async command(id, ...args) {
      host.executed.push([id, ...args]);
      // The approval page on this window: it shows the window's Story, and says so when it was opened for another.
      if (id === 'singularityFlow.openApprovals') {
        const focus = pages.approvals.approvalFocusOf(args[0]);
        const approvals = { initiativeId: host.shows, actor: null, pending: [], obstacles: [], empty: null };
        const shown = pages.approvals.approvalFocusShown(approvals, focus);
        const html = pages.approvals.approvalsBodyHtml(approvals, null, focus);
        host.approvals.push({ focus, shown, html });
        return { focusShown: () => shown };
      }
      if (id === 'singularityFlow.decide') return pages.decide.reviewDecisions(client, args[0] ?? { workId: story.workId }, async () => undefined, { askedInChat: args[0] !== undefined });
      if (id === 'singularityFlow.adjudicate') return pages.adjudication.reviewAdjudications(client, args[0] ?? { workId: story.workId }, async () => undefined, { askedInChat: args[0] !== undefined });
      if (id === 'singularityFlow.reviewWitness') return pages.decisionList.reviewWitness(client, args[0] ?? { workId: story.workId }, async () => undefined);
      return undefined;
    },
    /**
     * A tool call as VS Code's chat makes it, through the extension's own table, while the person acts on the page it
     * opens. Returns the tool's JSON answer, as the chat reads it.
     */
    async callTool(name, input) {
      globalThis[STUB].current = host;
      let answer;
      let done = false;
      const pending = pages.tools.decisionToolAnswer(name, input, (command, ...args) => host.command(command, ...args))
        .then((value) => { answer = value; done = true; return value; });
      // The person on whichever page is open (this call's, or one opened before it that the call waits for), until the tool
      // answers.
      for (let waited = 0; !done && waited < 240_000; waited += 10) {
        await host.act();
        await tick();
      }
      if (!done) throw new Error(`${name} did not answer: the person had no page left to act on (${host.panels.filter((panel) => panel.visible).map((panel) => panel.viewType).join(', ') || 'none open'})`);
      await pending;
      host.calls.push({ name, input, answer });
      return answer;
    },
    /** The person's move on each open page they have not acted on yet. */
    async act() {
      for (const panel of host.panels) {
        if (!panel.visible || acted.has(panel)) continue;
        if (panel.viewType === 'singularityFlow.decide' && panel.webview.html) { acted.add(panel); await host.onDecideCard(panel); }
        if (panel.viewType === 'singularityFlow.adjudicate' && panel.webview.html) { acted.add(panel); await host.onAdjudication(panel); }
        if (panel.viewType === 'singularityFlow.reviewConfirmation') { acted.add(panel); panel.post({ type: 'confirmation.accept', acknowledged: true }); }
      }
    },
    /** The person on the Decide card: answers its open rows as `person.decide` says, or closes it. */
    async onDecideCard(panel) {
      const packet = client.lists.at(-1) ?? null;
      const opening = packet?.versionOpening ?? null;
      const choice = host.person.decide?.({ packet, versionOpening: opening, panel }) ?? (opening && !(packet?.items ?? []).some((item) => item.kind !== 'approval') ? 'version-yes' : 'recommended');
      if (choice === 'cancel') return panel.post({ type: 'decide.cancel' });
      if (choice === 'version-yes' || choice === 'version-no') return panel.post({ type: 'decide.version', answer: choice === 'version-yes' ? 'yes' : 'no', digest: opening?.digest });
      const rows = (packet?.items ?? []).filter((item) => item.kind !== 'approval' && item.decidedBy?.allowed && !item.settled).flatMap((item) => {
        const option = item.options?.find((entry) => entry.id === item.recommended?.option) ?? item.options?.find((entry) => entry.decidedBy?.allowed !== false && entry.available !== false);
        return option ? [{ item: item.id, option: option.id, reason: 'The person chose this on the Decide card.', title: item.title }] : [];
      });
      if (!rows.length) return panel.post({ type: 'decide.cancel' });
      panel.post({ type: 'decide.review', rows });
    },
    /** The person on the convergence decisions page: closes it unless `person.adjudicate` answers. */
    async onAdjudication(panel) {
      const choice = host.person.adjudicate?.({ panel }) ?? 'cancel';
      if (choice === 'cancel') panel.post({ type: 'adjudicate.cancel' });
    }
  };
  globalThis[STUB].current = host;
  return host;
}
