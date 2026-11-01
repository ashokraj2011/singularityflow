/**
 * The Spec Studio (SPEC-SPA v1.3 §3, milestone S3): the specification library in one panel.
 *
 * Every read and write is a `spec author … --json` command, so the Studio is never the only way to
 * do anything and the engine's checks apply unchanged. `spec author status` is the one read for a
 * draft; a gap's impact, a revision and its coverage are read when a stage needs them. The panel
 * writes no Git and no repository file: prose and gap options reach `edit` and `gap` through a file
 * in a private temporary folder that is removed after the one command. Publishing and discarding ask
 * once on a review page; closing a gap is one choice plus a rationale. Back and Cancel write nothing.
 * Copilot (S4) stages proposals and assisted findings through `spec author propose`, from chat or the
 * #sflowSpecStudio tool bound to the open draft; only the person's clicks here accept, reject or settle.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import type { SingularityFlowClient } from '../cli/client.ts';
import { contentSecurityPolicy, navigationTarget, nonce, page } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { booleanField, enumField, integerField, registerMessageRouter, stringField, type InboundMessage } from './messages.ts';
import { collectReviewConfirmation } from './review-confirmation.ts';
import * as model from './spec-studio-model.ts';
import { specStudioHtml, SPEC_STUDIO_SCRIPT, SPEC_STUDIO_STYLE, type SpecStudioPageState } from './spec-studio-page.ts';

export interface SpecStudioHooks {
  /** The repository the CLI runs in, so a cited file opens at its line. */
  root?: () => string | null;
  /** Refresh every view after something was written. */
  refresh?: () => Promise<unknown>;
  output?: { appendLine(line: string): void };
}
type Client = Pick<SingularityFlowClient, 'run'>;

const operationId = (): string => `vsc-${randomUUID()}`;
const EMPTY: model.SpecStudioTarget = { specId: null, revision: null, clauses: null, step: null };
const textField = (message: InboundMessage, name: string): string => (typeof message[name] === 'string' ? (message[name] as string) : '');

/** The step the engine's own "next" names, so the Studio opens where the work is. */
function stepFor(status: model.SpecStatus): { step: model.SpecStudioStep; gap: string | null } {
  const open = model.gapPipeline(status.gaps).find((gap) => gap.status === 'open');
  if (open) return { step: 'gaps', gap: open.id };
  return { step: status.reviewReady ? 'publish' : 'check', gap: null };
}

export class SpecStudioPanel implements vscode.Disposable {
  private static current: SpecStudioPanel | null = null;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly panel: vscode.WebviewPanel;
  private readonly client: Client;
  private hooks: SpecStudioHooks;
  private state: SpecStudioPageState;
  /** Set when a specification is (re)opened: the first read chooses its step. */
  private opening = true;
  private running = false;
  private disposed = false;
  /** #sflowSpecStudio, bound to the draft open here while models are allowed. */
  private tool: { spec: string; dispose(): void } | null = null;

  private constructor(panel: vscode.WebviewPanel, client: Client, target: model.SpecStudioTarget, hooks: SpecStudioHooks) {
    this.panel = panel;
    this.client = client;
    this.hooks = hooks;
    this.state = this.fresh(target);
    panel.webview.onDidReceiveMessage((raw: unknown) => {
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      void this.router.route(raw);
    }, null, this.subscriptions);
    panel.onDidDispose(() => this.dispose(), null, this.subscriptions);
  }

  /** Open the one Studio, at `target` (`{ specId, revision, clauses, step }` or `'SPEC-ID@N'`), or the library. */
  static show(client: Client, target?: unknown, hooks: SpecStudioHooks = {}): SpecStudioPanel {
    const existing = SpecStudioPanel.current;
    if (existing && existing.client === client) {
      existing.hooks = hooks;
      if (target !== undefined) existing.retarget(model.specStudioTarget(target));
      existing.panel.reveal(vscode.ViewColumn.Active);
      void existing.guard(() => existing.load());
      return existing;
    }
    existing?.panel.dispose();
    const panel = vscode.window.createWebviewPanel('singularityFlow.specStudio', 'Spec Studio', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true });
    SpecStudioPanel.current = new SpecStudioPanel(panel, client, model.specStudioTarget(target), hooks);
    void SpecStudioPanel.current.load();
    return SpecStudioPanel.current;
  }

  private fresh(target: model.SpecStudioTarget): SpecStudioPageState {
    return { target, step: target.step ?? (target.revision || target.clauses ? 'attach' : 'elicit'), library: this.state?.library ?? null,
      status: null, revision: null, coverage: null, selectedGap: null, impact: null, notice: null, error: null, busy: null, copilot: null };
  }

  private retarget(target: model.SpecStudioTarget): void {
    this.state = this.fresh(target);
    this.opening = !target.step;
  }

  /** The messages this page speaks. Each one either reads, or runs exactly one `spec author` write. */
  private router = registerMessageRouter('singularityFlow.specStudio', {
    'spec.refresh': () => this.guard(() => this.load()),
    'spec.home': () => this.guard(() => { this.retarget(EMPTY); return this.load(); }),
    'spec.open': (message) => this.guard(() => {
      this.retarget(model.specStudioTarget({ specId: stringField(message, 'spec'), revision: integerField(message, 'revision') }));
      return this.load();
    }),
    'spec.step': (message) => this.guard(() => this.step(enumField(message, 'step', model.STEP_IDS))),
    'spec.back': () => this.guard(() => this.back()),
    'spec.cancel': () => this.guard(async () => { this.state.notice = 'Nothing was saved; the draft is unchanged.'; this.state.error = null; this.render(); }),
    'spec.gap': (message) => this.guard(() => this.selectGap(stringField(message, 'gap'))),
    'spec.new': (message) => this.guard(() => this.create(message)),
    'spec.revise': () => this.guard(() => this.revise()),
    'spec.save': (message) => this.guard(() => this.save(message)),
    'spec.research': (message) => this.guard(() => this.draftWrite('Collecting research from the code…', (specId) => model.researchArgv(specId, {
      paths: Array.isArray(message.paths) ? message.paths.filter((entry): entry is string => typeof entry === 'string') : [], refresh: booleanField(message, 'refresh')
    }, operationId()), (result) => `Research: ${(result as { items?: unknown[] }).items?.length ?? 0} item(s).`)),
    'spec.fact': (message) => this.guard(() => this.draftWrite('Adding the fact…',
      (specId) => model.factArgv(specId, textField(message, 'fact').trim(), textField(message, 'source').trim(), operationId()), () => 'The fact was added to research.')),
    'spec.removeResearch': (message) => this.guard(() => this.draftWrite('Removing the research item…',
      (specId) => model.removeResearchArgv(specId, stringField(message, 'item') ?? '', operationId()), () => `${stringField(message, 'item')} was removed from research.`)),
    'spec.openGap': (message) => this.guard(() => this.openGap(message)),
    'spec.decide': (message) => this.guard(() => this.decide(stringField(message, 'gap'), { option: stringField(message, 'option') ?? '' }, textField(message, 'reason'))),
    'spec.defer': (message) => this.guard(() => this.decide(stringField(message, 'gap'), { defer: true, owner: textField(message, 'owner').trim() }, textField(message, 'reason'))),
    'spec.reopen': (message) => this.guard(() => this.decide(stringField(message, 'gap'), { reopen: true }, textField(message, 'reason'))),
    'spec.settle': (message) => this.guard(() => this.settle(message)),
    'spec.settleFindings': (message) => this.guard(() => this.settleFindings(message)),
    'spec.proposals': (message) => this.guard(() => this.takeProposals(message)),
    'spec.acceptEdited': (message) => this.guard(() => this.acceptEdited(stringField(message, 'proposal'), textField(message, 'text'))),
    'spec.askCopilot': () => this.askCopilot(),
    'spec.publish': (message) => this.guard(() => this.publish(enumField(message, 'state', ['reviewed', 'draft'] as const))),
    'spec.discard': () => this.guard(() => this.discard()),
    'spec.attachRevision': (message) => this.guard(async () => { await this.readRevision(integerField(message, 'revision'), true); this.render(); }),
    'spec.coverage': () => this.guard(() => this.readCoverage()),
    'spec.copy': (message) => this.copy(stringField(message, 'text')),
    'spec.openCitation': (message) => this.openCitation(stringField(message, 'path'), integerField(message, 'line'))
  });

  /** One operation at a time: a click while one runs does nothing. */
  private async guard(action: () => Promise<unknown>): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    try { await action(); } finally { this.running = false; }
  }

  private log(argv: string[]): void {
    this.hooks.output?.appendLine(`\n$ singularity-flow ${argv.join(' ')}`);
  }

  private async busy(label: string, action: () => Promise<void>): Promise<void> {
    this.state.busy = label; this.render();
    try { await action(); } finally { this.state.busy = null; this.render(); }
  }

  /** Read the library, then the open specification's draft (or its revision when it has none). */
  private async load(): Promise<void> {
    await this.busy('Reading the specification library…', () => this.read());
  }

  private async read(): Promise<void> {
    const specId = this.state.target.specId;
    const [library, status] = await Promise.all([
      this.client.run(model.libraryArgv()).then(model.libraryFrom, (error: unknown) => {
        if (!specId) this.state.error = model.refusalFrom(error);
        return this.state.library;
      }),
      specId ? this.client.run(model.statusArgv(specId)).then(model.statusFrom, (error: unknown) => {
        // No draft on this clone is an ordinary state: the Studio shows the published revision instead.
        if (model.refusalCode(error) !== 'SPEC_DRAFT_MISSING') this.state.error = model.refusalFrom(error);
        return null;
      }) : Promise.resolve(null)
    ]);
    this.state.library = library;
    this.state.status = status;
    this.bindTool(status?.specId ?? null);
    if (!specId) return;
    if (this.opening && status && !this.state.target.revision && !this.state.target.clauses) {
      const chosen = stepFor(status);
      this.state.step = chosen.step;
      this.state.selectedGap = chosen.gap;
    }
    this.opening = false;
    if (this.state.selectedGap && !status?.gaps.some((gap) => gap.id === this.state.selectedGap)) this.state.selectedGap = null;
    if (!status || this.state.step === 'attach') await this.readRevision(this.state.target.revision ?? this.state.revision?.revision ?? null, false);
    const gap = status?.gaps.find((entry) => entry.id === this.state.selectedGap);
    if (this.state.step === 'gaps' && gap?.status === 'open') await this.readImpact(gap.id);
  }

  /** A revision by number, or the highest reviewed one; a missing one is said only when asked for. */
  private async readRevision(revision: number | null, asked: boolean): Promise<void> {
    const specId = this.state.target.specId;
    if (!specId) return;
    try {
      this.state.revision = model.revisionFrom(await this.client.run(model.showArgv(specId, revision)));
      if (this.state.coverage?.revision !== this.state.revision?.revision) this.state.coverage = null;
    } catch (error) {
      this.state.revision = null;
      if (asked) this.state.error = model.refusalFrom(error);
    }
  }

  private async readImpact(gapId: string): Promise<void> {
    const specId = this.state.target.specId;
    if (!specId) return;
    this.state.busy = `Reading ${gapId}'s impact from the code…`; this.render();
    try { this.state.impact = model.impactFrom(await this.client.run(model.gapImpactArgv(specId, gapId)), gapId); }
    catch (error) { this.state.impact = null; this.state.error = model.refusalFrom(error); }
  }

  private async readCoverage(): Promise<void> {
    const revision = this.state.revision;
    if (!revision) return;
    await this.busy(`Reading the coverage of ${revision.specId}@${revision.revision}…`, async () => {
      try { this.state.coverage = model.coverageFrom(await this.client.run(model.coverageArgv(revision.specId, revision.revision))); this.state.error = null; }
      catch (error) { this.state.error = model.refusalFrom(error); }
    });
  }

  private async step(step: model.SpecStudioStep | null): Promise<void> {
    if (!step) return;
    this.state.step = step;
    this.state.notice = null;
    if (step === 'attach' && !this.state.revision) {
      await this.busy('Reading the revision…', () => this.readRevision(this.state.target.revision ?? null, false));
      return;
    }
    if (step === 'gaps' && this.state.selectedGap && !this.state.impact) {
      await this.busy('Reading the gap…', () => this.readImpact(this.state.selectedGap!));
      return;
    }
    this.render();
  }

  /** Back one step; from the first step, back to the library. Nothing is written. */
  private async back(): Promise<void> {
    this.state.notice = null; this.state.error = null;
    if (this.state.step === 'gaps' && this.state.selectedGap) { this.state.selectedGap = null; this.state.impact = null; return this.render(); }
    const index = model.STEP_IDS.indexOf(this.state.step);
    if (index <= 0) { this.retarget(EMPTY); return this.load(); }
    return this.step(model.STEP_IDS[index - 1]!);
  }

  private async selectGap(gapId: string | null): Promise<void> {
    if (!gapId || !this.state.status?.gaps.some((gap) => gap.id === gapId)) return;
    this.state.step = 'gaps';
    this.state.selectedGap = gapId;
    this.state.impact = null;
    this.state.notice = null;
    const gap = this.state.status.gaps.find((entry) => entry.id === gapId)!;
    if (gap.status !== 'open') return this.render();
    await this.busy('Reading the gap…', () => this.readImpact(gapId));
  }

  /** Run one write, then read everything again: what the page shows is always the engine's answer. */
  private async write(label: string, argv: string[], done: (result: unknown) => string): Promise<boolean> {
    let written = false;
    await this.busy(label, async () => {
      this.log(argv);
      try {
        const result = await this.client.run(argv);
        this.state.notice = done(result);
        this.state.error = null;
        written = true;
        this.hooks.output?.appendLine(`  ${this.state.notice}`);
        await this.hooks.refresh?.().catch(() => undefined);
      } catch (error) {
        this.state.error = model.refusalFrom(error);
        this.state.notice = null;
      }
      await this.read();
    });
    return written;
  }

  private draftWrite(label: string, argv: (specId: string) => string[], done: (result: unknown) => string): Promise<boolean> {
    const specId = this.state.status?.specId;
    return specId ? this.write(label, argv(specId), done) : Promise.resolve(false);
  }

  /** A file the one command reads, in a private folder removed after it. */
  private async withFile<T>(name: string, contents: string, action: (file: string) => Promise<T>): Promise<T> {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-spec-studio-'));
    try {
      const file = path.join(directory, name);
      await writeFile(file, contents, { mode: 0o600, flag: 'wx' });
      return await action(file);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async create(message: InboundMessage): Promise<void> {
    const specId = textField(message, 'specId').trim();
    const title = textField(message, 'title').trim();
    const areas = Array.isArray(message.areas) ? message.areas.filter((entry): entry is string => typeof entry === 'string') : [];
    if (!model.validSpecId(specId)) { this.state.error = { message: `'${specId}' is not a specification ID. Use SPEC- followed by uppercase letters, digits and single hyphens, for example SPEC-CHK-004.`, next: null }; return this.render(); }
    if (!title) { this.state.error = { message: 'A new specification needs its title.', next: null }; return this.render(); }
    this.retarget({ ...EMPTY, specId });
    await this.write(`Starting ${specId}'s draft…`, model.newArgv(specId, { title, areas }, operationId()), () => `Started ${specId}'s draft from the library template.`);
    this.state.step = 'draft';
    this.render();
  }

  private async revise(): Promise<void> {
    const specId = this.state.target.specId;
    if (!specId) return;
    this.opening = false;
    if (await this.write(`Starting a draft of ${specId}'s next revision…`, model.newArgv(specId, { revise: true }, operationId()),
      () => `Started a draft of ${specId}'s next revision from its latest one.`)) this.state.step = 'draft';
    this.render();
  }

  private async save(message: InboundMessage): Promise<void> {
    const status = this.state.status;
    const sequence = typeof message.sequence === 'number' && Number.isInteger(message.sequence) ? message.sequence : null;
    if (!status || sequence === null || typeof message.text !== 'string') return;
    const text = message.text;
    await this.withFile('spec.md', text, (file) => this.write(`Saving snapshot ${sequence + 1}…`, model.editArgv(status.specId, file, sequence, operationId()),
      (result) => `Saved snapshot ${(result as { sequence?: number }).sequence ?? sequence + 1}.`));
  }

  private async openGap(message: InboundMessage): Promise<void> {
    const status = this.state.status;
    if (!status) return;
    const { request, errors } = model.gapRequest(message, status);
    if (!request) { this.state.error = { message: errors.join(' '), next: null }; return this.render(); }
    const argv = (file: string | null) => model.gapArgv(status.specId, request, file, operationId());
    const done = (result: unknown) => `Opened ${(result as { gap?: string }).gap ?? 'the gap'}.`;
    const opened = request.options.length
      ? await this.withFile('options.json', `${JSON.stringify(request.options.map(({ wording, changesCode }) => ({ wording, changesCode })))}\n`, (file) => this.write('Opening the gap…', argv(file), done))
      : await this.write('Opening the gap…', argv(null), done);
    const gap = opened ? model.gapPipeline(this.state.status?.gaps ?? []).filter((entry) => entry.status === 'open').at(-1) : null;
    if (gap) await this.selectGap(gap.id);
  }

  private async decide(gapId: string | null, decision: model.GapDecision, reason: string): Promise<void> {
    const status = this.state.status;
    if (!status || !gapId) return;
    if (!reason.trim()) { this.state.error = { message: `Deciding ${gapId} needs your rationale.`, next: null }; return this.render(); }
    if ('defer' in decision && !decision.owner) { this.state.error = { message: `Deferring ${gapId} needs its owner.`, next: null }; return this.render(); }
    const words = 'option' in decision ? `closed with ${decision.option}` : 'defer' in decision ? `deferred to ${decision.owner}` : 'reopened';
    await this.write(`Recording ${gapId}…`, model.decideArgv(status.specId, gapId, decision, reason.trim(), operationId()),
      () => `${gapId} is ${words} and signed with your Git identity.${'reopen' in decision ? '' : ' State its outcome under "Decisions and open questions" before publishing.'}`);
    this.state.impact = null;
    const gap = this.state.status?.gaps.find((entry) => entry.id === gapId);
    if (gap?.status === 'open') await this.busy('Reading the gap…', () => this.readImpact(gapId));
  }

  private async settle(message: InboundMessage): Promise<void> {
    const status = this.state.status;
    if (!status) return;
    const { decisions, reason, errors } = model.settleRequest(message, status);
    if (errors.length) { this.state.error = { message: errors.join(' '), next: null }; return this.render(); }
    await this.write('Recording the checklist decisions…', model.settleArgv(status.specId, decisions, reason, operationId()),
      () => `Recorded ${Object.keys(decisions).length} checklist decision(s).`);
  }

  private modelAvailable(): boolean {
    return vscode.workspace.getConfiguration('singularityFlow').get<string>('modelMode', 'auto') !== 'disabled'
      && !vscode.workspace.getConfiguration('chat').get<boolean>('disableAIFeatures', false);
  }

  /** Bind #sflowSpecStudio to the draft shown, or release it when there is none or models are off. */
  private bindTool(specId: string | null): void {
    const available = this.modelAvailable();
    if (this.tool && (this.tool.spec !== specId || !available)) { this.tool.dispose(); this.tool = null; }
    if (specId && available && !this.tool) {
      try {
        const runtime = require(path.join(__dirname, 'workflow-intent-runtime.cjs')) as typeof import('../workflow-intent-runtime.ts');
        const attached = runtime.attachSpecStudioTool(specId, {
          run: (args) => this.client.run(args),
          propose: (payload) => this.withFile('proposal.json', `${JSON.stringify(payload)}\n`, (file) => this.client.run(model.proposeArgv(specId, file))),
          recorded: () => { if (this.state.status?.specId === specId) void this.guard(() => this.load()); }
        });
        this.tool = attached.available ? { spec: specId, dispose: () => attached.dispose() } : null;
      } catch { this.tool = null; }
    }
    this.state.copilot = specId ? { available, tool: Boolean(this.tool) } : null;
  }

  /** Copilot Chat with /sf-spec-author for this draft; what it proposes appears in the Copilot tab. */
  private async askCopilot(): Promise<void> {
    const status = this.state.status;
    if (!status || !this.modelAvailable()) return;
    await vscode.commands.executeCommand('workbench.action.chat.open', { query: model.copilotPrompt(status.specId, Boolean(this.tool)), isPartialQuery: true });
    this.state.notice = 'Copilot Chat is open for this draft. Its proposals appear in the Copilot tab; only you accept them.';
    this.render();
  }

  /** Accept or reject the proposals the person ticked: one command, signed with their Git identity. */
  private async takeProposals(message: InboundMessage): Promise<void> {
    const status = this.state.status;
    if (!status) return;
    const chosen = model.proposalSelection(message, status);
    const decision = enumField(message, 'decision', ['accept', 'reject'] as const);
    const reason = textField(message, 'reason').trim();
    if (!chosen.length || !decision) { this.state.error = { message: 'Tick at least one proposal first.', next: null }; return this.render(); }
    if (decision === 'reject' && !reason) { this.state.error = { message: 'Rejecting a proposal needs your reason.', next: null }; return this.render(); }
    await this.write(`${decision === 'accept' ? 'Accepting' : 'Rejecting'} ${chosen.join(', ')}…`,
      decision === 'accept' ? model.acceptArgv(status.specId, chosen, null, operationId()) : model.rejectArgv(status.specId, chosen, reason, operationId()),
      () => (decision === 'accept' ? `Accepted ${chosen.join(', ')} into the draft.` : `Rejected ${chosen.join(', ')}; the draft is unchanged.`));
  }

  /** An edit proposed against older prose, accepted with the person's own merge of it. */
  private async acceptEdited(proposal: string | null, text: string): Promise<void> {
    const status = this.state.status;
    if (!status || !proposal || !status.proposals.some((entry) => entry.id === proposal && entry.kind === 'edit')) return;
    if (!text.trim()) { this.state.error = { message: `Accepting ${proposal} with your text needs the text.`, next: null }; return this.render(); }
    await this.withFile('spec.md', text, (file) => this.write(`Accepting ${proposal} with your text…`, model.acceptArgv(status.specId, [proposal], file, operationId()),
      () => `Accepted ${proposal} with your text.`));
  }

  private async settleFindings(message: InboundMessage): Promise<void> {
    const status = this.state.status;
    if (!status) return;
    const { outcomes, reason, errors } = model.findingsRequest(message, status);
    if (errors.length) { this.state.error = { message: errors.join(' '), next: null }; return this.render(); }
    await this.write('Settling the assisted findings…', model.settleFindingsArgv(status.specId, outcomes, reason, operationId()),
      () => `Settled ${Object.keys(outcomes).join(', ')}.`);
  }

  private async publish(state: 'reviewed' | 'draft' | null): Promise<void> {
    const status = this.state.status;
    if (!status || !state) return;
    const revision = model.nextRevision(this.state.library, status);
    if (!await collectReviewConfirmation(model.publishConfirmation(status, revision, state))) {
      this.state.notice = 'Nothing was published.'; this.state.error = null;
      return this.render();
    }
    await this.write(`Publishing ${status.specId}@${revision}…`, model.publishArgv(status.specId, state), (result) => {
      const published = result as { revision?: number; reviewState?: string; unchanged?: boolean };
      return published.unchanged ? `Nothing changed since ${status.specId}@${published.revision}; no new revision was published.`
        : `Published ${status.specId}@${published.revision ?? revision} (${published.reviewState ?? state}) to the state branch.`;
    });
  }

  private async discard(): Promise<void> {
    const status = this.state.status;
    if (!status) return;
    if (!await collectReviewConfirmation(model.discardConfirmation(status))) {
      this.state.notice = 'Nothing was discarded.'; this.state.error = null;
      return this.render();
    }
    await this.write(`Discarding ${status.specId}'s draft…`, model.discardArgv(status.specId), () => `Discarded ${status.specId}'s draft on this clone.`);
  }

  private async copy(text: string | null): Promise<void> {
    if (!text) return;
    await vscode.env.clipboard.writeText(text);
    void vscode.window.setStatusBarMessage('$(clippy) Copied.', 3_000);
  }

  /** A cited span, opened at its first line; only a path inside the repository. */
  private async openCitation(file: string | null, line: number | null): Promise<void> {
    const root = this.hooks.root?.();
    if (!root || !file || path.isAbsolute(file) || file.split(/[\\/]/u).includes('..')) return;
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, file)));
    const at = Math.max(0, (line ?? 1) - 1);
    await vscode.window.showTextDocument(document, { preview: true, selection: new vscode.Range(at, 0, at, 0) });
  }

  private render(): void {
    if (this.disposed) return;
    const token = nonce();
    const title = this.state.target.specId ? `Spec Studio · ${this.state.target.specId}` : 'Spec Studio';
    this.panel.title = title;
    this.panel.webview.html = page(title, specStudioHtml(this.state), contentSecurityPolicy(this.panel.webview, token), token,
      SPEC_STUDIO_SCRIPT, { styles: SPEC_STUDIO_STYLE });
  }

  dispose(): void {
    this.disposed = true;
    this.tool?.dispose();
    this.tool = null;
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    if (SpecStudioPanel.current === this) SpecStudioPanel.current = null;
  }
}
