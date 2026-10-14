/**
 * Turn a team's agent directory into one workflow bundle, then hand it to Workflow Studio's Import.
 *
 * Machine-local, like `workflow import-team` itself: inspecting reads the directory, Copilot (the
 * `/sf-import-team` skill) writes the one candidate record a session allows, and checking and
 * writing run the deterministic compiler. Nothing here changes a repository; the import happens
 * later through Workflow Studio and its review. Every value the page sends is checked against what
 * the CLI last returned, never trusted as a path or an argument.
 */

export interface TeamImportHost {
  run<T>(argv: string[]): Promise<T>;
  pickFolder(): Promise<string | null>;
  pickBundle(suggested: string): Promise<string | null>;
  /**
   * Open Copilot Chat with `query` typed in but not sent. `model-off` and `no-chat` open nothing:
   * SFlow's model features are turned off, or VS Code's AI features are (`chat.disableAIFeatures`).
   */
  openChat(query: string): Promise<'opened' | 'model-off' | 'no-chat'>;
  copy(text: string): Thenable<void> | Promise<void>;
  /** Open Workflow Studio and start its Import… with this bundle file. */
  openInStudio(file: string): Promise<void>;
  /**
   * The governed repository this window acts on (Workflow Studio's), offered as the import
   * destination: its root for the CLI and a name for people. Null with none open.
   */
  repository(): TeamImportRepository | null;
}

export interface TeamImportRepository { root: string; label: string }

export type TeamImportState = 'invalid' | 'unsupported' | 'needs-decision' | 'portable-ready' | 'ready-for-destination';
export const TEAM_IMPORT_STATES: readonly TeamImportState[] = ['invalid', 'unsupported', 'needs-decision', 'portable-ready', 'ready-for-destination'];

export interface TeamImportItem { path: string; format: string; id: string; role?: string; description?: string; problem?: string }
export interface TeamImportEntryCandidate { id: string; path: string; reasons: string[] }

export interface TeamImportInspection {
  resultType: 'team-import-inspection';
  source: { roots: { path: string }[] };
  capture: { counts: { files: number; interpreted: number; references: number; withheld: number; blocked: number; excluded: number } };
  items: TeamImportItem[];
  withheld: { path: string; screening: string }[];
  entry: { status: 'choose' | 'none' | 'selected'; selected: { id: string; path: string }[]; selectedBy: string | null; candidates: TeamImportEntryCandidate[] };
  session: { id: string; expiresAt: string } | null;
}

export interface TeamImportSessionSummary {
  id: string; updatedAt: string; expiresAt: string; source: string | null;
  entry: { id: string; path: string }[]; state: string; bundle: string | null; bundleSha256: string | null;
}

export interface TeamImportFinding { code: string; at: string; message: string; owner: string; severity?: string }
export interface TeamImportQuestion { id: string; question: string; choices: string[]; blocking?: boolean }

export interface TeamImportCompile {
  resultType: 'team-import-compile';
  session: { id: string };
  state: TeamImportState;
  bundleSha256: string | null;
  workflow: { id: string; label?: string; phases: { id: string; label?: string; agent?: string; code: boolean }[];
    decisions: { id: string; kind: string; after: string }[] } | null;
  dispositions: { sourceItem: string; disposition: string; kind: string; reason: string | null }[];
  destinationPolicy: { sourceItem: string; target: string; reason: string | null }[];
  questions: TeamImportQuestion[];
  answers: { id: string; question?: string; choice: string }[];
  findings: TeamImportFinding[];
  routeSimulation: { status: string };
  destination: { root: string; status: string } | null;
  repair: { attempt: number; limit: number; stop: boolean; unchanged: boolean };
  output: { path: string; bundleSha256: string; ready: boolean } | null;
  meaning: string;
}

export interface TeamImportView {
  directory: string | null;
  inspection: TeamImportInspection | null;
  /** The chosen entry, by captured path (an ID can name two files). */
  entry: string | null;
  /** The `/sf-import-team` command Convert prepared, shown so it can be copied anywhere. */
  command: string | null;
  sessions: TeamImportSessionSummary[];
  session: string | null;
  check: TeamImportCompile | null;
  written: { path: string; bundleSha256: string } | null;
  repository: TeamImportRepository | null;
  useDestination: boolean;
  busy: string | null;
  error: string | null;
  notice: string | null;
}

const isString = (value: unknown): value is string => typeof value === 'string';
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function teamImportInspection(value: unknown): TeamImportInspection {
  const result = value as TeamImportInspection;
  const entry = result?.entry;
  if (!record(result) || result.resultType !== 'team-import-inspection' || !Array.isArray(result.source?.roots)
    || !result.source.roots.every(root => isString(root?.path)) || !record(result.capture?.counts)
    || !Array.isArray(result.items) || result.items.some(item => !isString(item?.path) || !isString(item.id) || !isString(item.format))
    || !Array.isArray(result.withheld) || result.withheld.some(item => !isString(item?.path) || !isString(item.screening))
    || !record(entry) || !['choose', 'none', 'selected'].includes(entry.status) || !Array.isArray(entry.selected)
    || !Array.isArray(entry.candidates) || entry.candidates.some(candidate => !isString(candidate?.id) || !isString(candidate.path) || !strings(candidate.reasons))
    || (result.session !== null && !isString(result.session?.id))) {
    throw new Error('The CLI returned no readable inspection. Reinstall the matching SFlow build and inspect again.');
  }
  return result;
}

export function teamImportSessions(value: unknown): TeamImportSessionSummary[] {
  const result = value as { resultType?: unknown; sessions?: unknown };
  if (!record(result) || result.resultType !== 'team-import-status' || !Array.isArray(result.sessions)
    || result.sessions.some(session => !record(session) || !isString(session.id) || !isString(session.state)
      || !isString(session.updatedAt) || !Array.isArray(session.entry))) {
    throw new Error('The CLI returned no readable list of team import sessions.');
  }
  return result.sessions as TeamImportSessionSummary[];
}

export function teamImportCompile(value: unknown, session: string): TeamImportCompile {
  const result = value as TeamImportCompile;
  if (!record(result) || result.resultType !== 'team-import-compile' || result.session?.id !== session
    || !TEAM_IMPORT_STATES.includes(result.state) || !Array.isArray(result.findings)
    || result.findings.some(finding => !isString(finding?.code) || !isString(finding.message))
    || !Array.isArray(result.questions) || result.questions.some(question => !isString(question?.id)
      || !isString(question.question) || !strings(question.choices))
    || !Array.isArray(result.answers) || !Array.isArray(result.dispositions) || !Array.isArray(result.destinationPolicy)
    || !record(result.repair) || !record(result.routeSimulation)) {
    throw new Error('The CLI returned no readable check result for this session.');
  }
  return result;
}

export function teamImportReady(check: TeamImportCompile | null): boolean {
  return check?.state === 'portable-ready' || check?.state === 'ready-for-destination';
}

/** One shell-safe argument for the prompt Copilot Chat is given. */
function argument(value: string): string {
  return /^[A-Za-z0-9_./:@~+=-]+$/.test(value) ? value : `"${value.replace(/(["\\$`])/g, '\\$1')}"`;
}

export class TeamImportJourney {
  view: TeamImportView = {
    directory: null, inspection: null, entry: null, command: null, sessions: [], session: null, check: null, written: null,
    repository: null, useDestination: false, busy: null, error: null, notice: null
  };
  private revision = 0;
  private disposed = false;
  /** Whether the person chose the session; until then the newest one for the directory is shown. */
  private sessionChosen = false;
  private readonly host: TeamImportHost;
  private readonly render: () => void;

  constructor(host: TeamImportHost, render: () => void) {
    this.host = host;
    this.render = render;
  }

  dispose(): void { this.disposed = true; this.revision++; }

  private current(revision: number): boolean { return !this.disposed && revision === this.revision; }

  private begin(busy: string): number {
    this.view.busy = busy;
    this.view.error = null;
    this.view.notice = null;
    this.render();
    return ++this.revision;
  }

  private finish(revision: number): void {
    if (!this.current(revision)) return;
    this.view.busy = null;
    this.render();
  }

  /** Sessions from any surface (this panel, Copilot, the shell), newest first. */
  async load(): Promise<void> {
    if (this.view.busy) return;
    const revision = this.begin('Reading team import sessions…');
    await this.readSessions(revision);
    this.finish(revision);
  }

  private async readSessions(revision: number): Promise<void> {
    this.view.repository = this.host.repository();
    if (!this.view.repository) this.view.useDestination = false;
    try {
      const sessions = teamImportSessions(await this.host.run<unknown>(['workflow', 'import-team', 'status', '--json']));
      if (!this.current(revision)) return;
      // Inspect opens a session whenever one agent is the plausible entry, so an older session still
      // waiting for its candidate is superseded by any newer one for the same directory.
      const newestFor = new Set<string>();
      this.view.sessions = sessions.filter(session => {
        const key = session.source ?? session.id;
        const newest = !newestFor.has(key);
        newestFor.add(key);
        return newest || session.state !== 'awaiting-candidate';
      });
      if (this.view.session && !this.view.sessions.some(session => session.id === this.view.session)) {
        this.view.session = null;
        this.view.check = null;
        this.view.written = null;
      }
      // The newest session for the inspected directory that has a candidate, else the newest: a
      // re-inspect opens an empty session, which must not hide the conversion already made.
      if (!this.sessionChosen && this.view.directory) {
        const forDirectory = this.view.sessions.filter(session => session.source === this.view.directory);
        const newest = (forDirectory.find(session => session.state !== 'awaiting-candidate') ?? forDirectory[0])?.id ?? null;
        if (newest !== this.view.session) { this.view.session = newest; this.view.check = null; this.view.written = null; }
      }
    } catch (error) {
      if (this.current(revision)) this.view.error = message(error);
    }
  }

  async pick(): Promise<void> {
    if (this.view.busy) return;
    const directory = await this.host.pickFolder();
    if (!directory || this.disposed) return;
    this.view.directory = directory;
    this.view.inspection = null;
    this.view.entry = null;
    this.view.command = null;
    this.sessionChosen = false;
    await this.inspect();
  }

  async inspect(): Promise<void> {
    if (this.view.busy || !this.view.directory) return;
    const directory = this.view.directory;
    const revision = this.begin(`Inspecting ${directory}…`);
    try {
      const inspection = teamImportInspection(await this.host.run<unknown>(['workflow', 'import-team', 'inspect', directory, '--json']));
      if (!this.current(revision)) return;
      this.view.inspection = inspection;
      const only = inspection.entry.status === 'selected' ? inspection.entry.selected[0]?.path ?? null : null;
      const first = inspection.entry.candidates[0]?.path ?? null;
      if (!this.view.entry || !inspection.items.some(item => item.path === this.view.entry)) this.view.entry = only ?? first;
      this.view.command = null;
      await this.readSessions(revision);
    } catch (error) {
      if (this.current(revision)) { this.view.inspection = null; this.view.error = message(error); }
    }
    this.finish(revision);
  }

  chooseEntry(path: string): void {
    if (this.view.busy || !this.view.inspection?.items.some(item => item.path === path)) return;
    this.view.entry = path;
    this.view.command = null;
    this.render();
  }

  setDestination(on: boolean): void {
    if (this.view.busy) return;
    this.view.repository = this.host.repository();
    this.view.useDestination = on && Boolean(this.view.repository);
    this.view.check = null;
    this.render();
  }

  /** What `--entry` names: the captured ID when it is unique, else the captured path. */
  private entryArgument(): string | null {
    const items = this.view.inspection?.items ?? [];
    const item = items.find(entry => entry.path === this.view.entry);
    if (!item) return null;
    return items.filter(entry => entry.id === item.id).length === 1 ? item.id : item.path;
  }

  async convert(): Promise<void> {
    if (this.view.busy) return;
    const entry = this.entryArgument();
    if (!this.view.directory || !entry) { this.view.error = 'Inspect a team directory and choose its entry agent first.'; this.render(); return; }
    const destination = this.view.useDestination && this.view.repository ? ` --destination ${argument(this.view.repository.root)}` : '';
    this.view.command = `/sf-import-team ${argument(this.view.directory)} --entry ${argument(entry)}${destination}`;
    this.view.error = null;
    try {
      const opened = await this.host.openChat(this.view.command);
      this.view.notice = opened === 'opened'
        ? 'Copilot Chat has the command below. Send it there; Copilot asks you any questions. When it has written the candidate, refresh the sessions to check it here.'
        : opened === 'model-off'
          ? 'Model features are turned off (singularityFlow.modelMode is "disabled"), so Copilot Chat was not opened. Copy the command below into an agent with the SFlow skills.'
          : 'AI features are turned off in this VS Code (chat.disableAIFeatures), so Copilot Chat was not opened. Copy the command below into an agent with the SFlow skills.';
    } catch (error) {
      this.view.notice = null;
      this.view.error = `Copilot Chat could not be opened: ${message(error)}. Copy the command below instead.`;
    }
    this.render();
  }

  async copyCommand(): Promise<void> {
    if (!this.view.command) return;
    await this.host.copy(this.view.command);
    this.view.notice = 'Copied the command.';
    this.render();
  }

  async refreshSessions(): Promise<void> {
    return this.load();
  }

  selectSession(id: string): void {
    if (this.view.busy || !this.view.sessions.some(session => session.id === id)) return;
    if (this.view.session !== id) { this.view.check = null; this.view.written = null; }
    this.view.session = id;
    this.sessionChosen = true;
    this.render();
  }

  private compileArgs(tail: string[]): string[] {
    const destination = this.view.useDestination && this.view.repository ? ['--destination', this.view.repository.root] : [];
    return ['workflow', 'import-team', 'compile', '--session', this.view.session!, ...destination, ...tail, '--json'];
  }

  async check(answer: string[] = []): Promise<void> {
    if (this.view.busy || !this.view.session) return;
    const session = this.view.session;
    // Checking a session chooses it: a refresh never swaps the result for another session.
    this.sessionChosen = true;
    const revision = this.begin('Checking the conversion…');
    try {
      const check = teamImportCompile(await this.host.run<unknown>(this.compileArgs(['--dry-run', ...answer])), session);
      if (!this.current(revision)) return;
      this.view.check = check;
      await this.readSessions(revision);
    } catch (error) {
      if (this.current(revision)) this.view.error = message(error);
    }
    this.finish(revision);
  }

  /** Only a question the last check asked, with one of the choices it offered. */
  async answer(question: string, choice: string): Promise<void> {
    const asked = this.view.check?.questions.find(entry => entry.id === question);
    if (!asked || !asked.choices.includes(choice)) return;
    await this.check(['--answer', `${question}=${choice}`]);
  }

  async write(): Promise<void> {
    if (this.view.busy || !this.view.session || !teamImportReady(this.view.check)) return;
    const session = this.view.session;
    const source = this.view.sessions.find(entry => entry.id === session)?.source ?? this.view.directory;
    const name = `${this.view.check!.workflow?.id ?? 'team-workflow'}.sflow-workflows.json`;
    // Beside the team directory, never inside it: the CLI refuses a bundle in the source.
    const suggested = source ? `${source.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '')}/${name}` : name;
    const target = await this.host.pickBundle(suggested);
    if (!target || this.disposed) return;
    const revision = this.begin('Writing the workflow bundle…');
    try {
      const result = teamImportCompile(await this.host.run<unknown>(this.compileArgs(['--out', target])), session);
      if (!this.current(revision)) return;
      this.view.check = result;
      if (!result.output || !isString(result.output.path) || result.output.ready !== true) {
        throw new Error('The CLI did not confirm a ready bundle file; nothing is offered for import.');
      }
      this.view.written = { path: result.output.path, bundleSha256: result.output.bundleSha256 };
      await this.readSessions(revision);
    } catch (error) {
      if (this.current(revision)) this.view.error = message(error);
    }
    this.finish(revision);
  }

  async openInStudio(): Promise<void> {
    if (this.view.busy || !this.view.written) return;
    this.view.repository = this.host.repository();
    if (!this.view.repository) {
      this.view.error = 'Open the governed repository you want to import into, then open Workflow Studio from here again.';
      this.render();
      return;
    }
    try { await this.host.openInStudio(this.view.written.path); }
    catch (error) { this.view.error = message(error); this.render(); }
  }
}
