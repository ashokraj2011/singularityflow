/**
 * The Spec Studio (SPEC-SPA v1.3 §3, milestone S3): the specification library in one panel.
 *
 * Every read and write is a `spec author … --json` command, so the Studio is never the only way to
 * do anything and the engine's checks apply unchanged. `spec author status` is the one read for a
 * draft; a gap's impact, a revision and its coverage are read when a stage needs them. The panel
 * writes no Git and no repository file: prose and gap options reach `edit` and `gap` through a file
 * in a private temporary folder that is removed after the one command. Publishing and discarding ask
 * once on a review page; closing a gap is one choice plus a rationale. A split's plan reaches
 * `spec split --propose` through the same kind of file, and publishing it asks once (S5). Back and
 * Cancel write nothing.
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
import * as split from './spec-studio-split.ts';

export interface SpecStudioHooks {
  /** The repository the CLI runs in, so a cited file opens at its line. */
  root?: () => string | null;
  /** Private fallback for an unacknowledged save; removed only after the local engine confirms it. */
  memento?: Pick<vscode.Memento, 'get' | 'update'>;
  /** Refresh every view after something was written. */
  refresh?: () => Promise<unknown>;
  output?: { appendLine(line: string): void };
  /**
   * SF Guard's sign card, for a person step the CLI refused only for want of a terminal: true when it
   * took the refusal, which then types the same command into the person's own terminal (SPEC-PSS-v1 AC-014).
   */
  signRequired?: (error: unknown) => boolean;
}
type Client = Pick<SingularityFlowClient, 'run'> & Partial<Pick<SingularityFlowClient, 'forkForRepository'>>;

const operationId = (): string => `vsc-${randomUUID()}`;
const EMPTY: model.SpecStudioTarget = { specId: null, revision: null, clauses: null, step: null };
const textField = (message: InboundMessage, name: string): string => (typeof message[name] === 'string' ? (message[name] as string) : '');

export class SpecStudioPanel implements vscode.Disposable {
  private static current: SpecStudioPanel | null = null;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly panel: vscode.WebviewPanel;
  private readonly client: Client;
  private readonly ownerClient: Client;
  private readonly repositoryRoot: string | null;
  private hooks: SpecStudioHooks;
  private state: SpecStudioPageState;
  /** Set when a specification is (re)opened: the first read chooses its step. */
  private opening = true;
  private running = false;
  private disposed = false;
  private readonly edits = new Map<string, { text: string; sequence: number; title?: string; kind?: string | null }>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<boolean> | null = null;
  private saveAttempt: { key: string; operation: string } | null = null;
  private lastSyncAt = 0;
  private saveBlocked = false;
  private syncing = false;
  private reviewing = false;
  private readonly pendingSync = new Set<string>();
  private readonly syncFailures = new Set<string>();
  private refreshLibrary = false;
  private pendingCreation: { key: string; operationId: string } | null = null;
  /** #sflowSpecStudio, bound to the draft open here while models are allowed. */
  private tool: { spec: string; dispose(): void } | null = null;

  private constructor(panel: vscode.WebviewPanel, client: Client, target: model.SpecStudioTarget, hooks: SpecStudioHooks) {
    this.panel = panel;
    this.ownerClient = client;
    this.repositoryRoot = hooks.root?.() ?? null;
    this.client = this.repositoryRoot && client.forkForRepository ? client.forkForRepository(this.repositoryRoot) : client;
    this.hooks = { ...hooks, root: () => this.repositoryRoot };
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
    if (existing && existing.ownerClient === client && existing.repositoryRoot === (hooks.root?.() ?? null)) {
      existing.hooks = { ...hooks, root: () => existing.repositoryRoot };
      existing.panel.reveal(vscode.ViewColumn.Active);
      void existing.guard(() => { if (target !== undefined) existing.retarget(model.specStudioTarget(target)); return existing.load(); });
      return existing;
    }
    existing?.panel.dispose();
    const panel = vscode.window.createWebviewPanel('singularityFlow.specStudio', 'Spec Studio', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true });
    SpecStudioPanel.current = new SpecStudioPanel(panel, client, model.specStudioTarget(target), hooks);
    SpecStudioPanel.current.render();
    void SpecStudioPanel.current.guard(() => SpecStudioPanel.current!.load(), false);
    return SpecStudioPanel.current;
  }

  private fresh(target: model.SpecStudioTarget): SpecStudioPageState {
    return { target, step: target.step ?? (target.revision || target.clauses ? 'attach' : 'elicit'), library: this.state?.library ?? null,
      status: null, revision: null, coverage: null, split: null, splitDraft: null, selectedGap: null, impact: null, notice: null, error: null, busy: null, copilot: null };
  }

  private retarget(target: model.SpecStudioTarget): void {
    this.state = this.fresh(target);
    this.opening = !target.step;
  }

  /** The messages this page speaks. Each one either reads, or runs exactly one `spec author` write. */
  private router = registerMessageRouter('singularityFlow.specStudio', {
    'spec.refresh': () => this.guard(() => { this.refreshLibrary = true; return this.load(); }),
    'spec.home': () => this.guard(() => { this.retarget(EMPTY); return this.load(); }),
    'spec.open': (message) => this.guard(() => {
      this.retarget(model.specStudioTarget({ specId: stringField(message, 'spec'), revision: integerField(message, 'revision') }));
      return this.load();
    }),
    'spec.step': (message) => this.guard(() => this.step(enumField(message, 'step', model.STEP_IDS))),
    'spec.back': () => this.guard(() => this.back()),
    'spec.cancel': () => this.guard(async () => {
      if (this.state.step === 'draft' && this.state.target.specId) { this.edits.delete(this.state.target.specId); await this.hooks.memento?.update(this.recoveryKey(this.state.target.specId), undefined); }
      this.state.notice = this.state.step === 'draft' ? 'Unsaved edits discarded. The saved draft is unchanged.' : 'Nothing was saved; the draft is unchanged.';
      this.state.error = null; this.saveBlocked = false; await this.read(); this.render();
    }, false),
    'spec.editing': (message) => this.rememberEdit(message),
    'spec.copyEdits': () => this.copy(this.state.target.specId ? this.edits.get(this.state.target.specId)?.text ?? null : null),
    'spec.gap': (message) => this.guard(() => this.selectGap(stringField(message, 'gap'))),
    'spec.new': (message) => this.guard(() => this.create(message)),
    'spec.creating': (message) => {
      if (this.state.target.specId) return;
      this.state.creation = { title: textField(message, 'title'), intent: textField(message, 'intent'),
        areas: Array.isArray(message.areas) ? message.areas.filter((entry): entry is string => typeof entry === 'string') : [] };
    },
    'spec.revise': () => this.guard(() => this.revise()),
    'spec.save': (message) => { this.rememberEdit({ ...message, spec: this.state.status?.specId }); return this.guard(async () => { await this.flushEdits(); this.render(); }, false); },
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
    'spec.askCopilot': () => this.guard(() => this.askCopilot()),
    'spec.ask': (message) => this.guard(() => this.askCopilot(textField(message, 'request'), textField(message, 'selection'))),
    'spec.sync': () => this.guard(async () => { void this.sync(); }),
    'spec.history': () => this.guard(() => this.history()),
    'spec.version': (message) => this.guard(() => this.history(integerField(message, 'revision') ?? undefined)),
    'spec.restoreVersion': (message) => this.guard(() => this.restoreVersion(integerField(message, 'revision'))),
    'spec.addFiles': () => this.guard(() => this.addSources('file')),
    'spec.addLink': () => this.guard(() => this.addSources('url')),
    'spec.chooseCode': () => this.guard(() => this.addSources('code')),
    'spec.addSpecification': () => this.guard(() => this.addSources('specification')),
    'spec.viewSource': (message) => this.guard(() => this.viewSource(stringField(message, 'item'), integerField(message, 'line') ?? undefined, integerField(message, 'column') ?? undefined)),
    'spec.removeSource': (message) => this.guard(async () => { const spec = this.state.status?.specId, source = stringField(message, 'item'); if (!spec || !source) return; await this.write('Removing this source reference…', ['spec', 'author', 'source', spec, '--remove', source, '--operation-id', operationId(), '--json'], () => 'Removed from this draft. Existing versions and local originals were preserved.'); this.state.sourceViews = undefined; this.render(); }),
    'spec.restoreSource': (message) => this.guard(() => this.addSources('file', stringField(message, 'item') ?? undefined)),
    'spec.insertLink': () => this.insertLink(),
    'spec.shared': () => this.guard(() => this.compareShared()),
    'spec.resumeShared': () => this.guard(() => this.resumeShared()),
    'spec.fork': () => this.guard(() => this.keepLocalCopy(), false),
    'spec.derive': () => this.guard(() => this.derive()),
    'spec.createStory': (message) => this.guard(() => this.createStory(message)),
    'spec.publish': (message) => this.guard(() => this.publish(enumField(message, 'state', ['reviewed', 'draft'] as const))),
    'spec.discard': () => this.guard(() => this.discard()),
    'spec.attachRevision': (message) => this.guard(async () => { await this.readRevision(integerField(message, 'revision'), true); this.render(); }),
    'spec.coverage': () => this.guard(() => this.readCoverage()),
    'spec.splitPropose': (message) => this.guard(() => this.proposeSplit(message)),
    'spec.splitPublish': () => this.guard(() => this.publishSplit()),
    'spec.copy': (message) => this.copy(stringField(message, 'text')),
    'spec.openCitation': (message) => this.openCitation(stringField(message, 'path'), integerField(message, 'line'))
  });

  /** One operation at a time: a click while one runs does nothing. */
  private async guard(action: () => Promise<unknown>, save = true): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    try { if (!save || await this.flushEdits()) await action(); } catch (error) { this.state.error = model.refusalFrom(error); this.render(); } finally { this.running = false; if (this.edits.size && !this.disposed && !this.saveBlocked) this.scheduleSave(); }
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
    const previous = this.state.status;
    const [library, status] = await Promise.all([
      this.client.run(model.libraryArgv(this.refreshLibrary)).then(model.libraryFrom, (error: unknown) => {
        if (!specId) this.state.error = model.refusalFrom(error);
        return this.state.library;
      }),
      specId ? this.client.run(model.statusArgv(specId, ['check', 'publish'].includes(this.state.step))).then(model.statusFrom, (error: unknown) => {
        // No draft on this clone is an ordinary state: the Studio shows the published revision instead.
        if (model.refusalCode(error) !== 'SPEC_DRAFT_MISSING') this.state.error = model.refusalFrom(error);
        return null;
      }) : Promise.resolve(null)
    ]);
    this.refreshLibrary = false;
    this.state.library = library;
    this.state.status = status;
    // Publishing, adding a source or staging a proposal can advance metadata while the person
    // types. Rebase only when every editable field on disk is unchanged; real text conflicts
    // still use the stale-save recovery route.
    const pending = specId ? this.edits.get(specId) : null;
    if (pending && previous && status && previous.specId === status.specId && pending.sequence === previous.sequence
        && previous.spec === status.spec && previous.title === status.title && previous.kind === status.kind) pending.sequence = status.sequence;
    if (status && !this.edits.has(status.specId)) {
      const recovered = this.hooks.memento?.get<{ text: string; sequence: number; title?: string; kind?: string | null }>(this.recoveryKey(status.specId));
      if (recovered && recovered.text !== status.spec) { this.edits.set(status.specId, recovered); this.saveBlocked = true; this.state.error = { message: 'Writing from an unconfirmed save was recovered on this laptop. Compare it with the saved version or keep it as another draft.', next: null }; }
    }
    this.bindTool(status?.specId ?? null);
    if (!specId) return;
    if (!status && library?.shared?.some(item => item.specId === specId) && !this.state.target.revision) { await this.compareShared(); return; }
    if (this.opening && status && !this.state.target.revision && !this.state.target.clauses) {
      this.state.step = 'draft';
      if (status.sharedDraft?.localSequence !== status.sequence) this.scheduleSync();
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
    const before = this.state.revision ? `${this.state.revision.specId}@${this.state.revision.revision}` : null;
    try {
      this.state.revision = model.revisionFrom(await this.client.run(model.showArgv(specId, revision)));
      if (this.state.coverage?.revision !== this.state.revision?.revision) this.state.coverage = null;
    } catch (error) {
      this.state.revision = null;
      if (asked) this.state.error = model.refusalFrom(error);
    }
    // A refused plan belongs to the revision it was written for.
    if ((this.state.revision ? `${this.state.revision.specId}@${this.state.revision.revision}` : null) !== before) this.state.splitDraft = null;
    await this.readSplit();
  }

  /** The shown revision's splits and the plan proposed for it on this clone; a draft revision has none. */
  private async readSplit(): Promise<void> {
    const revision = this.state.revision;
    this.state.split = null;
    if (!revision || revision.manifest.reviewState !== 'reviewed') return;
    try { this.state.split = split.splitFrom(await this.client.run(split.splitArgv(revision.specId, revision.revision))); }
    catch (error) { this.state.error = model.refusalFrom(error); }
  }

  /** Check the person's plan and keep it on this clone (`spec split … --propose`); nothing is published. */
  private async proposeSplit(message: InboundMessage): Promise<void> {
    const revision = this.state.revision;
    if (!revision) return;
    const plan = split.splitPlanRequest(message, model.specClauses(revision.spec, revision.specId).map((clause) => clause.id));
    this.state.splitDraft = plan;
    const proposed = await this.withFile('split-plan.json', split.planFileText(plan), (file) => this.write(`Checking the split of ${revision.specId}@${revision.revision}…`,
      split.splitProposeArgv(revision.specId, revision.revision, file), () => 'Proposed the split on this clone; nothing is published yet. Publishing asks once.'));
    if (proposed) { this.state.splitDraft = null; this.render(); }
  }

  /** Publishing a split is the person's own step: one confirmation that names it. */
  private async publishSplit(): Promise<void> {
    const view = this.state.split;
    const proposal = view?.proposal;
    if (!view || !proposal || proposal.findings.length || proposal.stale) return;
    if (!await collectReviewConfirmation(split.splitConfirmation(view, proposal))) {
      this.state.notice = 'Nothing was published.'; this.state.error = null;
      return this.render();
    }
    await this.write(`Publishing the split of ${view.specId}@${view.revision}…`, split.splitPublishArgv(view.specId, view.revision), (result) => {
      const published = result as { split?: number; replayed?: boolean; children?: Array<{ specId?: string }> };
      const children = (published.children ?? []).map((child) => child.specId).filter(Boolean);
      return `${published.replayed ? 'Already published' : 'Published'} split ${published.split ?? ''} of ${view.specId}@${view.revision}. No Story was started${children.length ? `; ${children.join(', ')} drafted on this clone` : ''}.`;
    });
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
    if (['check', 'publish'].includes(step) && this.state.status) {
      const checked = model.statusFrom(await this.client.run(model.statusArgv(this.state.status.specId, true)));
      if (checked) this.state.status = checked;
    }
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
        this.scheduleSync();
      } catch (error) {
        if (this.hooks.signRequired?.(error)) {
          this.state.error = null;
          this.state.notice = 'SF Guard: this step takes your Touch ID in your own terminal. Its card is open; nothing was written yet.';
        } else {
          this.state.error = model.refusalFrom(error);
          this.state.notice = null;
        }
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
    const title = textField(message, 'title').trim() || textField(message, 'intent').trim().split(/\r?\n/u)[0]?.slice(0, 120) || 'Untitled specification';
    const intent = textField(message, 'intent').trim();
    const areas = Array.isArray(message.areas) ? message.areas.filter((entry): entry is string => typeof entry === 'string') : [];
    this.state.creation = { title, intent, areas };
    if (specId && !model.validSpecId(specId)) { this.state.error = { message: 'This specification ID is invalid. Start a new draft without an ID to generate one automatically.', next: null }; return this.render(); }
    if (!title) { this.state.error = { message: 'A new specification needs its title.', next: null }; return this.render(); }
    const key = JSON.stringify({ specId, title, intent, areas });
    if (this.pendingCreation?.key !== key) this.pendingCreation = { key, operationId: operationId() };
    await this.write('Creating your specification…', model.newArgv(specId || null, { title, intent, areas }, this.pendingCreation.operationId), (result) => {
      const created = (result as { specId?: unknown }).specId;
      if (!model.validSpecId(created)) throw new Error('The CLI did not return a valid specification ID. Retry this creation to recover its result.');
      this.retarget({ ...EMPTY, specId: created, step: 'draft' });
      this.pendingCreation = null;
      return 'Draft created. Write here or ask Copilot to help.';
    });
    this.scheduleSync();
    if (message.mode === 'copilot' && this.state.status) await this.askCopilot('Help me turn this idea into a clear first draft.');
    this.render();
  }

  private rememberEdit(message: InboundMessage): void {
    const status = this.state.status;
    if (!status || message.spec !== status.specId || typeof message.text !== 'string'
      || typeof message.sequence !== 'number' || !Number.isInteger(message.sequence) || message.sequence < 1) return;
    const title = typeof message.title === 'string' ? message.title.trim() || 'Untitled specification' : status.title;
    const kind = typeof message.kind === 'string' ? message.kind || null : status.kind;
    if (message.text === status.spec && message.sequence === status.sequence && title === status.title && kind === status.kind) this.edits.delete(status.specId);
    else this.edits.set(status.specId, { text: message.text, sequence: message.sequence, title, kind });
    this.state.saveState = this.edits.has(status.specId) ? 'Changes waiting to save' : 'Saved on this laptop';
    if (!this.saveBlocked) this.scheduleSave();
  }

  private setting<T>(key: string, fallback: T): T { return vscode.workspace.getConfiguration('singularityFlow').get<T>('specStudio.' + key, fallback); }
  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (!this.disposed) this.saveTimer = setTimeout(() => { this.saveTimer = null; if (!this.running || this.reviewing) void this.flushEdits(); else this.scheduleSave(); }, Math.max(100, this.setting('autosaveMs', 750)));
  }
  private recoveryKey(spec: string): string { return 'specStudio.unsaved:' + (this.hooks.root?.() ?? '') + ':' + spec; }
  private post(message: Record<string, unknown>): void {
    if (!this.disposed) void this.panel.webview.postMessage?.(message);
  }
  /** One local write per idle batch. Never reread the remote/library or run quality checks here. */
  private async flushEdits(): Promise<boolean> {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (this.saving) { if (!await this.saving) return false; }
    const status = this.state.status;
    const edit = status ? this.edits.get(status.specId) : null;
    if (!status || !edit) return true;
    const captured = { ...edit };
    const key = JSON.stringify({ specId: status.specId, ...captured });
    if (this.saveAttempt?.key !== key) this.saveAttempt = { key, operation: operationId() };
    const op = this.saveAttempt.operation;
    this.state.saveState = 'Saving on this laptop…';
    const work = async (): Promise<boolean> => {
      try {
        const result = await this.withFile('spec.md', captured.text, file => this.client.run(model.editArgv(status.specId, file, captured.sequence, op, captured))) as { sequence?: number };
        if (!Number.isSafeInteger(result.sequence)) throw Error('The save did not return a confirmed local version. Retry the same save.');
        const sequence = result.sequence!;
        const latest = this.edits.get(status.specId);
        status.spec = captured.text; status.sequence = sequence; status.title = captured.title ?? status.title; status.kind = captured.kind; status.qualityChecked = false; status.reviewReady = false;
        if (latest && JSON.stringify(latest) === JSON.stringify(captured)) this.edits.delete(status.specId);
        else if (latest?.sequence === captured.sequence) latest.sequence = sequence;
        await this.hooks.memento?.update(this.recoveryKey(status.specId), undefined);
        this.saveAttempt = null; this.saveBlocked = false; this.state.error = null; this.state.saveState = 'Saved on this laptop';
        this.post({ type: 'spec.saved', sequence, dirty: this.edits.has(status.specId) });
        this.scheduleSync();
        return true;
      } catch (error) {
        await this.hooks.memento?.update(this.recoveryKey(status.specId), this.edits.get(status.specId) ?? captured);
        this.saveBlocked = true; this.state.error = model.refusalFrom(error); this.state.saveState = 'Could not save';
        this.post({ type: 'spec.saveFailed', message: this.state.error.message });
        this.render();
        this.hooks.output?.appendLine('Spec Studio save: ' + this.state.error.message);
        return false;
      }
    };
    this.saving = work();
    const ok = await this.saving;
    this.saving = null;
    if (ok && this.edits.has(status.specId)) return this.flushEdits();
    return ok;
  }
  private scheduleSync(): void {
    if (this.state.status) this.pendingSync.add(this.state.status.specId);
    this.planSync();
  }
  private planSync(): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    if (this.disposed || this.saveBlocked || !this.setting('automaticSync', true)) return;
    const next = [...this.pendingSync].find(spec => !this.syncFailures.has(spec));
    if (!next) return;
    const delay = Math.max(this.setting('syncQuietMs', 10000), this.lastSyncAt + Math.max(1000, this.setting('syncMinIntervalMs', 30000)) - Date.now());
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      if (!this.running) void this.flushEdits().then(ok => { if (ok) void this.sync(true, next); });
      else this.planSync();
    }, delay);
  }
  private async sync(automatic = false, selected?: string): Promise<void> {
    const spec = selected ?? this.state.status?.specId;
    if (!spec || this.syncing) return;
    const status = this.state.status?.specId === spec ? this.state.status : null;
    const sequence = status?.sequence;
    this.syncing = true; this.pendingSync.delete(spec);
    if (!automatic) this.syncFailures.delete(spec);
    this.lastSyncAt = Date.now();
    if (status) this.post({ type: 'spec.syncState', text: 'Syncing saved writing…' });
    try {
      const result = await this.client.run(['spec', 'author', 'sync', spec, ...(automatic ? ['--automatic', '--min-interval-ms', String(this.setting('syncMinIntervalMs', 30000))] : []), '--json']) as { status: string; retryAfterMs?: number };
      if (result.status === 'deferred') {
        this.pendingSync.add(spec);
        if (this.state.status === status) this.post({ type: 'spec.syncState', text: 'Saved on this laptop · sync queued' });
        return;
      }
      this.syncFailures.delete(spec);
      if (status && this.state.status === status) {
        const newer = this.edits.has(spec) || sequence !== status.sequence;
        this.state.syncState = newer ? 'Newer writing awaits sync' : 'Synced';
        this.post({ type: 'spec.syncState', text: this.edits.has(spec) ? 'Saving latest writing…' : newer ? 'Saved locally · sync queued' : 'Synced' });
        if (newer) this.pendingSync.add(spec);
      }
    } catch (error) {
      this.pendingSync.add(spec); this.syncFailures.add(spec);
      this.hooks.output?.appendLine('Spec Studio sharing ' + spec + ': ' + model.refusalFrom(error).message);
      if (status && this.state.status === status) {
        this.state.syncState = 'Saved on this laptop · sharing needs attention'; this.state.error = model.refusalFrom(error);
        const sharingError = this.state.error;
        this.post({ type: 'spec.syncState', text: this.state.syncState, message: this.state.error.message, next: this.state.error.next });
        if (model.refusalCode(error) === 'SPEC_SHARED_DRAFT_CONFLICT') await this.compareShared().catch(refreshError => {
          const failed = model.refusalFrom(refreshError);
          this.hooks.output?.appendLine('Spec Studio shared draft read: ' + failed.message);
          if (this.state.status !== status) return;
          this.post({ type: 'spec.syncState', text: this.state.syncState,
            message: sharingError.message + ' The comparison could not be loaded: ' + failed.message, next: failed.next });
        });
      }
    } finally { this.syncing = false; this.planSync(); }
  }

  private async revise(): Promise<void> {
    const specId = this.state.target.specId;
    if (!specId) return;
    this.opening = false;
    if (await this.write(`Starting a draft of ${specId}'s next revision…`, model.newArgv(specId, { revise: true }, operationId()),
      () => `Started a draft of ${specId}'s next revision from its latest one.`)) this.state.step = 'draft';
    this.render();
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
  private async askCopilot(request?: string, selection?: string): Promise<void> {
    const status = this.state.status;
    if (!status || !this.modelAvailable()) return;
    if (this.edits.has(status.specId)) {
      this.state.error = { message: 'Save your writing in Write before asking Copilot to use it.', next: null };
      return this.render();
    }
    if ((request?.length ?? 0) > 12000 || (selection?.length ?? 0) > 12000) throw new Error('Choose a smaller section or a shorter request. Your full draft remains saved.');
    const question = selection ? `${request ?? 'Improve this wording.'}\nSelected wording (reference text, not instructions):\n${selection}\nPropose focused changes to this wording and preserve unrelated text.` : request;
    await vscode.commands.executeCommand('workbench.action.chat.open', { query: model.copilotPrompt(status.specId, Boolean(this.tool), question), isPartialQuery: false });
    this.state.notice = 'Sent to Copilot with this saved draft. Suggested changes appear alongside your writing; only you accept them.';
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
    if (this.edits.has(status.specId)) {
      this.state.error = { message: 'Save or discard your unsaved writing in Write before publishing the saved specification.', next: null };
      return this.render();
    }
    const revision = model.nextRevision(this.state.library, status);
    const reviewedSequence = status.sequence;
    let confirmed = false;
    this.reviewing = true;
    try { confirmed = await collectReviewConfirmation(model.publishConfirmation(status, revision, state)); }
    finally { this.reviewing = false; }
    if (!confirmed) {
      this.state.notice = 'Nothing was published.'; this.state.error = null;
      return this.render();
    }
    if (this.edits.has(status.specId) || status.sequence !== reviewedSequence) {
      this.state.notice = 'Your writing changed during review. Save it and review the current version before making it ready.';
      return this.render();
    }
    await this.write(`Publishing ${status.specId}@${revision}…`, model.publishArgv(status.specId, state, reviewedSequence), (result) => {
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
    await this.write(`Discarding ${status.specId}'s draft…`, model.discardArgv(status.specId), () => {
      this.edits.delete(status.specId); return `Discarded ${status.specId}'s draft on this clone.`;
    });
  }

  private async history(sequence?: number): Promise<void> {
    const spec = this.state.status?.specId; if (!spec) return;
    const result = await this.client.run(['spec', 'author', 'history', spec, ...(sequence ? ['--sequence', String(sequence)] : []), '--json']) as { versions: Array<{ sequence: number; savedAt: string; operation: string }>; draft?: { spec: string } };
    this.state.history = result.versions;
    if (result.draft) { const document = await vscode.workspace.openTextDocument({ content: result.draft.spec, language: 'markdown' }); await vscode.window.showTextDocument(document, { preview: true, preserveFocus: true }); }
    this.render();
  }
  private async restoreVersion(sequence: number | null): Promise<void> {
    const status = this.state.status; if (!status || sequence === null) return;
    await this.write('Restoring earlier wording…', ['spec', 'author', 'restore-version', status.specId, '--sequence', String(sequence), '--expected-seq', String(status.sequence), '--operation-id', operationId(), '--json'], () => 'Earlier wording restored. Later versions and decisions remain in history.');
  }
  private async addSources(type: 'file' | 'url' | 'code' | 'specification', restore?: string): Promise<void> {
    const spec = this.state.status?.specId; if (!spec) return;
    let args: string[] = [];
    if (type === 'specification') {
      const choices = (this.state.library?.specs ?? []).filter(item => item.latest.reviewState === 'reviewed').map(item => ({ label: item.latest.title, description: item.specId + '@' + item.latest.revision, reference: item.specId + '@' + item.latest.revision }));
      if (!choices.length) { this.state.notice = 'No reviewed specifications are available yet. Make a version ready, or refresh the library.'; return this.render(); }
      const chosen = await vscode.window.showQuickPick(choices, { title: 'Use a specification as a reference', placeHolder: 'Choose a reviewed version', ignoreFocusOut: true });
      if (!chosen) return; args = ['--specification', chosen.reference];
    } else if (type === 'url') {
      const url = await vscode.window.showInputBox({ title: 'Add a link', prompt: 'A document, team guideline or other useful source', placeHolder: 'https://…', ignoreFocusOut: true });
      if (!url) return; args = ['--url', url];
    } else {
      let folders = false;
      if (type === 'code') {
        const choice = await vscode.window.showQuickPick([{ label: 'A code file', folders: false }, { label: 'A code folder', folders: true }], { title: 'Choose code from this workspace', ignoreFocusOut: true });
        if (!choice) return; folders = choice.folders;
      }
      const selected = await vscode.window.showOpenDialog({ title: restore ? 'Add the matching original file again' : type === 'code' ? 'Choose code from this workspace' : 'Add files or images', canSelectMany: type === 'file' && !restore, canSelectFiles: !folders, canSelectFolders: folders,
        ...(type === 'code' && this.hooks.root?.() ? { defaultUri: vscode.Uri.file(this.hooks.root()!) } : {}) });
      if (!selected?.length) return;
      if (type === 'code') { const root = this.hooks.root?.(); if (!root) throw Error('Open a workspace repository before choosing code.'); args = ['--path', path.relative(root, selected[0]!.fsPath).split(path.sep).join('/')]; }
      else args = selected.flatMap(uri => ['--file', uri.fsPath]);
    }
    await this.write('Adding your source…', ['spec', 'author', 'source', spec, ...args, ...(restore ? ['--restore', restore] : []), '--operation-id', operationId(), '--json'], () => 'Source added. Originals stay on this laptop; reading it does not agree to its instructions.');
    this.scheduleSync();
  }
  private async viewSource(id: string | null, from?: number, column?: number): Promise<void> {
    const spec = this.state.status?.specId; if (!spec || !id) return;
    const result = await this.client.run(['spec', 'author', 'sources', spec, '--source', id, ...(from ? ['--from', String(from)] : []), ...(column ? ['--column', String(column)] : []), '--json']) as { sources: Array<Record<string, unknown>> };
    this.state.sourceViews = result.sources; this.render();
    const first = result.sources[0]; if (first?.status === 'image-ready' && typeof first.path === 'string') await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(first.path));
  }
  private async insertLink(): Promise<void> {
    const url = await vscode.window.showInputBox({ title: 'Insert a link', prompt: 'Select the wording in your draft, then enter its link.', ignoreFocusOut: true });
    if (url && /^(https?:|mailto:|#)/iu.test(url)) this.post({ type: 'spec.link', url });
  }
  private async compareShared(): Promise<void> {
    const spec = this.state.status?.specId ?? this.state.target.specId; if (!spec) return;
    const result = await this.client.run(['spec', 'author', 'shared', spec, '--refresh', '--json']) as { drafts: Array<Record<string, unknown>> };
    if ((this.state.status?.specId ?? this.state.target.specId) !== spec) return;
    this.state.shared = result.drafts[0] ?? null; this.render();
  }
  private async resumeShared(): Promise<void> {
    const spec = this.state.target.specId; const shared = this.state.shared; if (!spec || !shared) return;
    this.syncFailures.delete(spec);
    await this.write('Opening the shared draft…', ['spec', 'author', 'resume', spec, '--checkpoint', String(shared.checkpointSha256), '--expected-seq', String(this.state.status?.sequence ?? 0), '--operation-id', operationId(), '--json'], () => 'Shared draft opened. Earlier local versions were preserved.');
    this.state.shared = null; this.state.step = 'draft'; this.render();
  }
  private async keepLocalCopy(): Promise<void> {
    const spec = this.state.status?.specId; if (!spec) return;
    const pending = this.edits.get(spec);
    const perform = (file?: string) => this.write('Keeping your writing as another draft…', ['spec', 'author', 'fork', spec, ...(file ? ['--file', file] : []), '--operation-id', operationId(), '--json'], result => {
      const id = (result as { specId: string }).specId; this.edits.delete(spec); this.saveBlocked = false;
      void this.hooks.memento?.update(this.recoveryKey(spec), undefined);
      this.retarget({ ...EMPTY, specId: id, step: 'draft' }); return 'Your writing is kept as a separate draft.';
    });
    if (pending) await this.withFile('spec.md', pending.text, file => perform(file)); else await perform();
  }
  private async derive(): Promise<void> {
    const revision = this.state.revision;
    if (!revision || revision.manifest.reviewState !== 'reviewed') { this.state.step = 'attach'; await this.readRevision(null, false); if (!this.state.revision || this.state.revision.manifest.reviewState !== 'reviewed') { this.state.notice = 'Make a reviewed version ready before working out its technical details.'; return this.render(); } }
    const source = this.state.revision!;
    await this.write('Starting the technical details…', ['spec', 'author', 'derive', source.specId + '@' + source.revision, '--operation-id', operationId(), '--json'], result => { this.retarget({ ...EMPTY, specId: (result as { specId: string }).specId, step: 'draft' }); return 'Technical draft started from the exact reviewed requirements. The business specification is unchanged.'; });
  }
  private async createStory(message: InboundMessage): Promise<void> {
    const revision = this.state.revision; if (!revision || revision.manifest.reviewState !== 'reviewed') return;
    const option = textField(message, 'option');
    const reference = '--spec ' + revision.specId + '@' + revision.revision;
    if (option !== reference && !option.startsWith(reference + '=')) return;
    await vscode.commands.executeCommand('singularityFlow.startWork', { shape: 'story', source: 'manual', summary: String(revision.manifest.title ?? ''), repositoryPath: this.hooks.root?.(), specifications: [option.slice(7)] });
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
    this.state.workingDraft = this.state.target.specId ? this.edits.get(this.state.target.specId) : undefined;
    const token = nonce();
    const name = this.state.status?.title ?? this.state.revision?.manifest.title ?? this.state.target.specId;
    const title = name ? `Spec Studio · ${name}` : 'Spec Studio';
    this.panel.title = title;
    this.panel.webview.html = page(title, specStudioHtml(this.state), contentSecurityPolicy(this.panel.webview, token), token,
      `${SPEC_STUDIO_SCRIPT}${split.SPEC_STUDIO_SPLIT_SCRIPT}`, { styles: `${SPEC_STUDIO_STYLE}${split.SPEC_STUDIO_SPLIT_STYLE}` });
  }

  dispose(): void {
    this.disposed = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (this.syncTimer) clearTimeout(this.syncTimer);
    void this.flushEdits().finally(() => this.edits.clear());
    this.tool?.dispose();
    this.tool = null;
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    if (SpecStudioPanel.current === this) SpecStudioPanel.current = null;
  }
}
