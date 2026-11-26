import { showCompactWarningMessage, showCompactInformationMessage } from "../compact-message.ts";
/**
 * Workflow Studio: create and change workflows, their steps, the agent that drafts each step and
 * the people who sign it off, then check and publish everything as one governed change.
 *
 * The page keeps the draft; this host only reads the model (`workflow studio --json`), asks the
 * engine to check a change set (`--dry-run`), and publishes it after a person confirms. For the
 * Library it also asks the engine to preview an import, browse a trusted marketplace and check
 * imported sources; each is an engine read, and adding is just another change in the set. The engine
 * remains the authority: it validates the whole candidate configuration and writes through a review
 * proposal (or a local authority's working tree). The extension never writes configuration itself.
 */
import * as vscode from 'vscode';
import type { SingularityFlowClient } from '../cli/client.ts';
import { formatCliArgsForDisplay } from '../cli/runner.ts';
import { contentSecurityPolicy, navigationTarget, nonce, page, reviewBranchName } from './webview.ts';
import { navigateTo } from './navigate.ts';
import { createTerminalIn } from '../terminal-start.ts';
import { collectReviewConfirmation } from './review-confirmation.ts';
import { booleanField, enumField, integerField, registerMessageRouter, stringField, type InboundMessage } from './messages.ts';
import { liveWorkflows, refusalOf, workflowArchiveArgs } from './workflow-delete-page.ts';
import { chooseNewDefault, WorkflowDeletePanel, type WorkflowRetireOutcome } from './workflow-delete-panel.ts';
import { INTEGRATION_SECRET_NAME, type IntegrationSecretSource } from '../credentials.ts';
import {
  BUILD_ID, BUILD_PROPOSAL_ID, BUILD_QUESTION_ID, PROPOSAL_BRANCH, SAVED_DRAFT_ID, STUDIO_FOCUS_VIEWS, buildChatQuery, buildIntentsArgs, buildsForRepository, studioBuildArgs, STUDIO_MODEL_ARGS, STUDIO_PREVIEW_ARGS, WORKFLOW_STUDIO_SCRIPT, studioCheckArgs, localProposalUploads, proposalSummaries,
  studioPublishArgs, workflowStudioBody, type LocalProposalUpload, type StudioAuthority, type StudioFocusView
} from './workflow-studio-page.ts';
import * as os from 'node:os';
import * as path from 'node:path';
import { realpathSync, watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { StudioModelLike } from './workflow-builder-tool.ts';

export { STUDIO_FOCUS_VIEWS, proposalSummaries, type StudioFocusView };


interface StudioModel { authority?: StudioAuthority; base?: unknown; [key: string]: unknown }
interface StudioPlan { valid: boolean; changed: boolean; summary: string[]; problems: Array<{ message: string }>; warnings: Array<{ message: string; code?: string }>; files: Array<{ path: string }> }
interface StudioApplyResult extends StudioPlan { reviewRequired?: boolean; branch?: string | null; authorityMode?: string; written?: string[] }

const MAX_CHANGE_SET_BYTES = 1024 * 1024;
const IMPORT_KINDS = new Set(['skill', 'template', 'agent', 'mcp-server']);
const SERVER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_REFERENCE_LENGTH = 2048;
const TARGET_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const ACTION_TRIGGERS = new Set(['submitted', 'approved', 'rejected']);
const ACTION_SENDS = new Set(['event', 'summary', 'artifact']);
const MAX_SECRET_NAMES = 64;
const WORKFLOW_SELECTOR = /^(?:story|initiative):[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_EXPORT_WORKFLOWS = 200;
const STUDIO_WORKFLOW_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** `MARKETPLACE/AGENT`, as `workflow from-agent` takes it, and one `--answer STEP=INTENT`. */
const MARKETPLACE_AGENT = /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9][a-z0-9._-]{0,99}$/;
const AGENT_STAGE_ANSWER = { step: /^[a-z0-9]+(?:-[a-z0-9]+)*$/, intent: /^[a-z]{1,32}$/ };
/** A branch or tag name as Git allows it, never an option. */
const MARKETPLACE_REF = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/;

/** The look checks of SFlow's text checks (OMK §7) a person ticked "I looked at these lines" for, as `--looked`; anything else is dropped. */
const LOOK_CHECKS = new Set(['hidden-markup', 'encoded-payload', 'data-upload', 'destructive-command']);
function lookedFlags(raw: unknown): string[] {
  const looked = Array.isArray(raw) ? [...new Set(raw.filter((entry): entry is string => typeof entry === 'string' && LOOK_CHECKS.has(entry)))].sort() : [];
  return looked.length ? ['--looked', looked.join(',')] : [];
}

/** The person's answers to what a stage is for, as `--answer` flags; anything else is dropped. */
function agentStageAnswers(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return Object.entries(raw as Record<string, unknown>).slice(0, 30)
    .filter(([step, intent]) => AGENT_STAGE_ANSWER.step.test(step) && step.length <= 120 && typeof intent === 'string' && AGENT_STAGE_ANSWER.intent.test(intent))
    .flatMap(([step, intent]) => ['--answer', `${step}=${intent as string}`]);
}

/** A workflow build as `workflow build status|start|add|... --json` returns it; the page reads the rest. */
interface StudioBuildView { build: { id: string; updatedAt: string; [key: string]: unknown }; proposalPath?: string; [key: string]: unknown }
/** The build open in the Build view: the watch on its record, and the chat tool bound to it. */
interface OpenBuild { id: string; updatedAt: string | null; watcher: FSWatcher | null; timer: ReturnType<typeof setTimeout> | null; busy: number; checks: number; tool: { dispose(): void } | null }

function realPath(value: string): string {
  try { return realpathSync.native(value); } catch { return path.resolve(value); }
}

/** Where integration secrets are kept on this machine. The page only ever learns whether each is set. */
export interface IntegrationSecretStore {
  status(names: readonly string[]): Promise<Record<string, IntegrationSecretSource>>;
  store(name: string, value: string): Promise<void>;
  clear(name: string): Promise<void>;
  /** Whether Jira is connected for Singularity Flow on this machine: stored in VS Code, set in the environment, or not. */
  jiraStatus(): Promise<IntegrationSecretSource>;
}


/** What a build changes in the workflow it starts from (workflow build check `changes`). */
interface BuildChanges {
  label: string; inPlace?: boolean; none?: boolean; renamed?: { from: string; to: string };
  added?: Array<{ label: string; position: number }>; removed?: Array<{ label: string; goes: string[] }>;
  moved?: Array<{ label: string; position: number }>; changed?: Array<{ label: string; what: string[] }>;
  decisions?: { added?: Array<{ after: string; label: string }>; removed?: Array<{ after: string; label: string }> };
}

/** Every change a finished build makes, one line each, for the one confirmation that finishes and activates it. */
export function buildChangeLines(check: { build: { label: string }; changes?: BuildChanges | null; draft?: { workflow?: { phases?: string[] } } }): string[] {
  const changes = check.changes;
  if (!changes) return [`New workflow ${check.build.label}: ${check.draft?.workflow?.phases?.length ?? 0} steps.`];
  const lines = [changes.inPlace ? `Changes to ${changes.label}:` : `New workflow ${check.build.label}, a copy of ${changes.label}:`];
  if (changes.renamed) lines.push(`• Renamed from ${changes.renamed.from} to ${changes.renamed.to}`);
  for (const step of changes.added ?? []) lines.push(`• Adds ${step.label} as step ${step.position}`);
  for (const step of changes.removed ?? []) lines.push(`• Removes ${step.label}${step.goes.length ? `; with it go ${step.goes.join(', ')}` : ''}`);
  for (const step of changes.moved ?? []) lines.push(`• Moves ${step.label} to step ${step.position}`);
  for (const step of changes.changed ?? []) lines.push(`• Changes ${step.label}: ${step.what.join(', ')}`);
  for (const decision of changes.decisions?.added ?? []) lines.push(`• Adds the decision after ${decision.after}: ${decision.label}`);
  for (const decision of changes.decisions?.removed ?? []) lines.push(`• Removes the decision after ${decision.after}: ${decision.label}`);
  if (lines.length === 1) lines.push('• Nothing else');
  return lines;
}

/** The changes in one line, for the short form of the confirmation; the full list is behind its details. */
export function buildChangeSummary(check: { build: { label: string }; changes?: BuildChanges | null; draft?: { workflow?: { phases?: string[] } } }): string {
  const changes = check.changes;
  if (!changes) return `A new workflow with ${check.draft?.workflow?.phases?.length ?? 0} steps. New Stories can use it at once; nothing else changes.`;
  const count = (list: unknown[] | undefined, one: string, many: string) => (list?.length ? `${list.length} ${list.length === 1 ? one : many}` : null);
  const parts = [count(changes.added, 'step added', 'steps added'), count(changes.removed, 'step removed', 'steps removed'), count(changes.moved, 'step moved', 'steps moved'),
    count(changes.changed, 'step changed', 'steps changed'), count(changes.decisions?.added, 'decision added', 'decisions added'),
    count(changes.decisions?.removed, 'decision removed', 'decisions removed'), changes.renamed ? 'renamed' : null].filter(Boolean);
  return `${parts.join(', ') || 'No change'}. New Stories use it at once; Stories already running keep theirs.`;
}

export interface WorkflowStudioActions {
  /** Re-read repository state after a publish, so the rest of the extension sees it. */
  refresh(): Promise<void>;
  /**
   * Review a configuration proposal's exact diff and approve it after the person confirms, with the
   * separate acknowledgement an unprotected configuration branch needs. Returns why it stopped, if it did.
   */
  reviewProposal(branch: string): Promise<string | null | void>;
  /** Withdraw one's own proposal, or reject another's with a reason (`configuration reject`). Returns why it stopped, if it did. */
  rejectProposal?(branch: string): Promise<string | null | void>;
  /**
   * Approve a proposal the person just made on the page that made it: one acknowledgement that says
   * whether it is a self-approval, then the signed `configuration approve`. Server policy still applies;
   * when it refuses, or the repository needs another person, the proposal waits.
   */
  activateProposal?(branch: string): Promise<{ activated: boolean; message: string }>;
  /** Export the chosen workflows (`story:<id>`, `initiative:<id>`) and their dependencies as one bundle. */
  exportWorkflows?(selectors: readonly string[]): Promise<string | null>;
  /**
   * Import a workflow bundle: preview the plan, then propose it after the person confirms. `source`
   * is a bundle the team-import panel wrote; without it the person chooses a file.
   */
  importWorkflows?(source?: string): Promise<StudioChangeOutcome>;
  /** Open the team-import panel, which turns a team's agent directory into a bundle to import. */
  importTeam?(): Thenable<unknown> | Promise<unknown>;
  /** Add a person's own agent folder as a user-defined agent (call add). */
  addUserAgent?(): Thenable<unknown> | Promise<unknown>;
  duplicateWorkflow?(selector: string): Promise<StudioChangeOutcome>;
  /** Open a repository file in an editor: the governed workflow or portfolio file, or a template. */
  openFile?(relative: string, line?: number): Promise<void>;
  /** The operating-system keychain, through VS Code, for the secrets integration targets name. */
  integrationSecrets?: IntegrationSecretStore;
  /**
   * Where unpublished changes wait while Workflow Studio is closed (VS Code workspace storage). The
   * page offers them back on reopen, but only against the configuration they were made on.
   */
  draftStore?: { get(): unknown; set(value: StudioSavedDraft | undefined): PromiseLike<void> };
}

/** What a governed change made outside the change set (an import) came to. */
export interface StudioChangeOutcome {
  outcome: 'cancelled' | 'proposed' | 'written' | 'unchanged' | 'failed';
  branch?: string;
  error: string | null;
  /** False while a proposed change is saved on this computer and its upload has not finished. */
  uploaded?: boolean;
}

/**
 * Unpublished Studio changes kept across closing the panel: schema 2 holds edits against `base`
 * [SCF:REQ-013]; schema 1 was a full copy, kept by earlier builds.
 */
export interface StudioSavedDraft { schema: 1 | 2; base: string; savedAt: string; draft: string }

/** One agent to open the Agents view at, as the Instruction Designer's agent tab asks: its form, or a new one. */
export type StudioAgentFocus = { agent: string } | { newAgent: true };
const STUDIO_AGENT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * What All skills and the Marketplace open Studio at: the Library's import preview of one marketplace skill, into the
 * skill master (an update when the library has it), or of an index marketplace's agent, template or MCP server; the
 * Library's entries of one trusted marketplace (Browse, where a generated source is set up), or its Read its newest
 * commit (to trust a newer commit, reviewed); an index's workflow, its bundle fetched and checked by the engine and
 * opened in Import… (marketWorkflowImport); the Skill master searched
 * for one skill, or asking to delete it; a marketplace agent's conversion review (to make its workflow, or its update);
 * the Library's Remove of one import; or a workflow's Archive or Restore. Each is Studio's own route, checked here; the
 * change is published from Studio as a reviewed proposal.
 */
export type StudioSkillFocus = { preview: { reference?: unknown; replace?: unknown; as?: unknown } } | { skill: string; remove?: boolean }
  | { agentWorkflow: { target?: unknown; update?: unknown } } | { removeImport: unknown } | { retire: { action?: unknown; selector?: unknown } }
  | { browse: unknown } | { marketplaceRead: unknown } | { marketWorkflow: unknown };
const MARKET_SKILL_REFERENCE = /^market:[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*(?:@[0-9A-Za-z][0-9A-Za-z.+-]{0,63})?$/;
/** An import's key, as `imports` lists it: kind, then the agent's and the item's IDs. */
const IMPORT_KEY = /^(?:skill|library-skill|template|agent|mcp-server|generated):[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)?$/;

function skillFocus(raw: unknown): Record<string, unknown> | null {
  const requested = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  if (!requested) return null;
  const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});
  if ('preview' in requested) {
    const preview = record(requested.preview);
    const reference = preview.reference;
    const as = preview.as === 'agent' || preview.as === 'template' || preview.as === 'mcp-server' ? { as: preview.as } : {};
    return typeof reference === 'string' && reference.length <= MAX_REFERENCE_LENGTH && MARKET_SKILL_REFERENCE.test(reference)
      ? { view: 'library', preview: { reference, replace: preview.replace === true, ...as } } : null;
  }
  if ('agentWorkflow' in requested) {
    const flow = record(requested.agentWorkflow);
    return typeof flow.target === 'string' && MARKETPLACE_AGENT.test(flow.target) ? { view: 'library', agentWorkflow: { target: flow.target, update: flow.update === true } } : null;
  }
  if ('marketWorkflow' in requested) {
    return typeof requested.marketWorkflow === 'string' && requested.marketWorkflow.length <= MAX_REFERENCE_LENGTH && MARKET_SKILL_REFERENCE.test(requested.marketWorkflow)
      ? { view: 'library', marketWorkflow: requested.marketWorkflow } : null;
  }
  if ('marketplaceRead' in requested) {
    return typeof requested.marketplaceRead === 'string' && requested.marketplaceRead.length <= 64 && STUDIO_AGENT_ID.test(requested.marketplaceRead)
      ? { view: 'library', marketplaceRead: requested.marketplaceRead } : null;
  }
  if ('browse' in requested) {
    return typeof requested.browse === 'string' && requested.browse.length <= 64 && STUDIO_AGENT_ID.test(requested.browse) ? { view: 'library', browse: requested.browse } : null;
  }
  if ('removeImport' in requested) {
    return typeof requested.removeImport === 'string' && requested.removeImport.length <= 200 && IMPORT_KEY.test(requested.removeImport)
      ? { view: 'library', removeImport: requested.removeImport } : null;
  }
  if ('retire' in requested) {
    const retire = record(requested.retire);
    return (retire.action === 'archive' || retire.action === 'restore') && typeof retire.selector === 'string' && WORKFLOW_SELECTOR.test(retire.selector)
      ? { retire: { action: retire.action, selector: retire.selector } } : null;
  }
  return typeof requested.skill === 'string' && requested.skill.length <= 64 && STUDIO_AGENT_ID.test(requested.skill)
    ? { view: 'skills', skill: requested.skill, ...(requested.remove === true ? { remove: true } : {}) } : null;
}

function agentFocus(requested: StudioAgentFocus | null): StudioAgentFocus | null {
  if (!requested) return null;
  if ('newAgent' in requested) return requested.newAgent === true ? { newAgent: true } : null;
  return typeof requested.agent === 'string' && requested.agent.length <= 64 && STUDIO_AGENT_ID.test(requested.agent) ? { agent: requested.agent } : null;
}

export class WorkflowStudioPanel implements vscode.Disposable {
  private static current: WorkflowStudioPanel | null = null;
  private readonly subscriptions: vscode.Disposable[] = [];
  private disposed = false;
  private model: StudioModel | null = null;
  /** MCP servers the person allowed this Studio session to start or contact for imports. */
  private readonly mcpConsent = new Set<string>();
  /** The not-yet-uploaded proposals last shown; Retry and sign-in act only on one of these. */
  private uploads: LocalProposalUpload[] = [];

  /** The section to show once the model has loaded, when a screen opened Studio at one. */
  private focus: StudioFocusView | null = null;
  private workflowToOpen: string | null = null;
  private agentToOpen: StudioAgentFocus | null = null;
  private skillToOpen: Record<string, unknown> | null = null;
  /** The last conversion the page previewed: its feedback is what Copy and Open an issue use, never text from the page. */
  private agentPreview: { target: string; answers: unknown; result: Record<string, unknown> } | null = null;
  /** A bundle to import once the page is ready, from the team-import panel; never a webview path. */
  private bundleToImport: string | null = null;
  private build: OpenBuild | null = null;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly client: SingularityFlowClient,
    private readonly output: vscode.OutputChannel,
    private readonly actions: WorkflowStudioActions
  ) {
    panel.webview.onDidReceiveMessage(async (raw: unknown) => {
      const navigation = navigationTarget(raw);
      if (navigation) return void navigateTo(navigation);
      await this.router.route(raw);
    }, null, this.subscriptions);
    panel.onDidDispose(() => this.dispose(), null, this.subscriptions);
    const token = nonce();
    panel.webview.html = page('Workflow Studio', workflowStudioBody(token),
      contentSecurityPolicy(panel.webview, token), token, WORKFLOW_STUDIO_SCRIPT);
  }

  static show(client: SingularityFlowClient, output: vscode.OutputChannel, actions: WorkflowStudioActions, focus: StudioFocusView | null = null, workflowId: string | null = null, importBundle: string | null = null, agent: StudioAgentFocus | null = null, skill: StudioSkillFocus | object | null = null): WorkflowStudioPanel {
    const canvasWorkflow = workflowId && /^(?:initiative:)?[a-z0-9]+(?:-[a-z0-9]+)*$/.test(workflowId) && workflowId.length <= 139 ? workflowId : null;
    const agentToOpen = agentFocus(agent);
    const skillToOpen = skillFocus(skill);
    // An index's workflow is fetched by the engine and opened in Import…, the same review as any bundle.
    const marketWorkflow = typeof skillToOpen?.marketWorkflow === 'string' ? skillToOpen.marketWorkflow : null;
    if (WorkflowStudioPanel.current && marketWorkflow) void WorkflowStudioPanel.current.marketWorkflowImport(marketWorkflow);
    if (WorkflowStudioPanel.current) {
      WorkflowStudioPanel.current.panel.reveal(vscode.ViewColumn.Active);
      if (skillToOpen) {
        if (WorkflowStudioPanel.current.model) WorkflowStudioPanel.current.post({ type: 'studio.focus', ...skillToOpen });
        else WorkflowStudioPanel.current.skillToOpen = skillToOpen;
      } else if (canvasWorkflow) {
        if (WorkflowStudioPanel.current.model) WorkflowStudioPanel.current.post({ type: 'studio.focus', workflowId: canvasWorkflow });
        else WorkflowStudioPanel.current.workflowToOpen = canvasWorkflow;
      } else if (agentToOpen) {
        if (WorkflowStudioPanel.current.model) WorkflowStudioPanel.current.post({ type: 'studio.focus', view: 'agents', ...agentToOpen });
        else WorkflowStudioPanel.current.agentToOpen = agentToOpen;
      } else if (focus) WorkflowStudioPanel.current.post({ type: 'studio.focus', view: focus });
      if (importBundle) WorkflowStudioPanel.current.requestImport(importBundle);
      return WorkflowStudioPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'singularityFlow.workflowStudio', 'Workflow Studio', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    WorkflowStudioPanel.current = new WorkflowStudioPanel(panel, client, output, actions);
    WorkflowStudioPanel.current.focus = focus;
    WorkflowStudioPanel.current.workflowToOpen = canvasWorkflow;
    WorkflowStudioPanel.current.agentToOpen = agentToOpen;
    WorkflowStudioPanel.current.skillToOpen = skillToOpen;
    WorkflowStudioPanel.current.bundleToImport = importBundle;
    if (marketWorkflow) void WorkflowStudioPanel.current.marketWorkflowImport(marketWorkflow);
    return WorkflowStudioPanel.current;
  }

  /**
   * An index marketplace's workflow: `workflow import "market:…" --dry-run --json` fetches its bundle, checks it against the
   * digest the index pins and keeps it in SFlow's private folder; Import… then reviews that bundle as any other, and
   * nothing changes until the person confirms and publishes it.
   */
  private async marketWorkflowImport(reference: string): Promise<void> {
    try {
      const result = await this.client.run<{ bundlePath?: string }>(['workflow', 'import', reference, '--dry-run', '--json']);
      if (!result.bundlePath || !path.isAbsolute(result.bundlePath)) { this.post({ type: 'studio.importFailed', message: 'The workflow bundle was not fetched.' }); return; }
      this.requestImport(result.bundlePath);
    } catch (error) {
      this.post({ type: 'studio.importFailed', message: (error as Error).message });
    }
  }

  /**
   * Ask the page to start Import… with this bundle. The page starts it, so the import carries the
   * page's count of unpublished changes, which decides whether the page may reload afterwards.
   */
  private requestImport(bundle: string): void {
    this.bundleToImport = bundle;
    if (this.model) this.post({ type: 'studio.importRequested', name: bundle.split(/[\\/]/).pop() });
  }

  /** Re-read the proposal lists (waiting for review, and saved but not uploaded) of an open panel. */
  static async refreshProposals(): Promise<void> {
    const current = WorkflowStudioPanel.current;
    if (!current || current.disposed) return;
    await current.proposals();
  }

  /** Refresh an open panel after sync without discarding its unpublished private draft. */
  static async refreshAfterConfigurationSync(): Promise<void> {
    const current = WorkflowStudioPanel.current;
    if (!current || current.disposed) return;
    current.post({ type: 'studio.externalConfigurationChanged' });
    await current.proposals();
  }

  /**
   * The messages the page sends. The change set arrives as JSON text and is bounded here; the
   * engine parses and validates its content, so the host never trusts its shape.
   */
  private router = registerMessageRouter('singularityFlow.workflowStudio', {
    'studio.ready': () => this.load(false),
    'studio.draftSave': (message) => this.saveDraft(stringField(message, 'draft')),
    'studio.draftClear': () => this.clearDraft(),
    'studio.confirm': (message) => this.confirm(stringField(message, 'id'), stringField(message, 'text'),
      stringField(message, 'detail'), stringField(message, 'ok')),
    'studio.reload': () => this.load(true),
    // A newer configuration under unpublished changes: the page keeps them and moves them onto it.
    'studio.refresh': () => this.load(false),
    'studio.preview': (message) => this.preview(stringField(message, 'changeSet')),
    'studio.check': (message) => this.check(stringField(message, 'workflow'), stringField(message, 'changeSet')),
    'studio.publish': (message) => this.publish(stringField(message, 'changeSet'), integerField(message, 'count') ?? 0),
    'studio.importPreview': (message) => this.importPreview(stringField(message, 'reference'), stringField(message, 'as'), (message as { arguments?: unknown }).arguments),
    'studio.mcpSources': (message) => this.mcpSources(stringField(message, 'id')),
    'studio.mcpHostAdd': (message) => this.mcpHostAdd(stringField(message, 'id')),
    'studio.marketplaceBrowse': (message) => this.marketplaceBrowse(stringField(message, 'id')),
    'studio.marketplaceRead': (message) => this.marketplaceRead(stringField(message, 'id'), stringField(message, 'repository'),
      stringField(message, 'ref'), stringField(message, 'label')),
    'studio.agentWorkflowPreview': (message) => this.agentWorkflowPreview(stringField(message, 'target'), (message as { answers?: unknown }).answers, (message as { update?: unknown }).update === true,
      (message as { looked?: unknown }).looked),
    'studio.agentWorkflowMake': (message) => this.agentWorkflowMake(stringField(message, 'target'), (message as { answers?: unknown }).answers, (message as { update?: unknown }).update === true,
      (message as { looked?: unknown }).looked),
    'studio.agentFeedbackSave': (message) => this.agentFeedbackSave(stringField(message, 'target'), (message as { answers?: unknown }).answers),
    'studio.agentFeedbackCopy': (message) => this.agentFeedbackCopy(stringField(message, 'target')),
    'studio.agentFeedbackIssue': (message) => this.agentFeedbackIssue(stringField(message, 'target')),
    'studio.importsCheck': () => this.importsCheck(),
    'studio.secretStatus': (message) => this.secretStatus((message as { names?: unknown }).names),
    'studio.storeSecret': (message) => this.storeSecret(stringField(message, 'name')),
    'studio.clearSecret': (message) => this.clearSecret(stringField(message, 'name')),
    'studio.connectJira': () => this.connectJira(),
    'studio.proposals': () => this.proposals(),
    'studio.reviewProposal': (message) => this.reviewProposal(stringField(message, 'branch'), integerField(message, 'pending') ?? 0),
    'studio.rejectProposal': (message) => this.rejectProposal(stringField(message, 'branch')),
    'studio.exportWorkflows': (message) => this.exportWorkflows((message as { workflowIds?: unknown }).workflowIds),
    'studio.importWorkflows': (message) => this.importWorkflows(integerField(message, 'pending') ?? 0),
    'studio.retryUpload': (message) => this.retryUpload(stringField(message, 'intentId')),
    'studio.discardSavedDraft': (message) => this.discardSavedDraft(stringField(message, 'draftId')),
    'studio.checkSignIn': (message) => this.checkSignIn(stringField(message, 'intentId')),
    'studio.importTeam': () => this.actions.importTeam?.(),
    'studio.allSkills': () => vscode.commands.executeCommand('singularityFlow.allSkills'),
    'studio.marketplace': () => vscode.commands.executeCommand('singularityFlow.marketplace'),
    'studio.addUserAgent': () => this.actions.addUserAgent?.(),
    'studio.markup': async () => {
      // CommonJS cannot split import() automatically; load this editor only on explicit use.
      const { WorkflowMarkupPanel } = require(path.join(__dirname, 'workflow-markup-runtime.cjs')) as typeof import('./workflow-markup-panel.ts');
      WorkflowMarkupPanel.show(this.client, async file => {
        if (!this.actions.importWorkflows) return { outcome: 'failed', error: 'Workflow import is unavailable here.' };
        const outcome = await this.actions.importWorkflows(file);
        if (outcome.outcome !== 'cancelled' && outcome.outcome !== 'failed') {
          this.post({ type: 'studio.externalConfigurationChanged' }); await this.actions.refresh(); await this.proposals();
        }
        return outcome;
      });
    },
    'studio.build.list': () => this.buildList(),
    'studio.build.start': (message) => this.buildStart(message),
    'studio.build.open': (message) => this.buildOpen(stringField(message, 'build')),
    'studio.build.close': () => this.buildClose(),
    'studio.build.add': (message) => this.buildAdd(stringField(message, 'build')),
    'studio.build.export': (message) => this.buildExport(stringField(message, 'build')),
    'studio.build.importFile': () => this.buildImportFile(),
    'studio.build.decide': (message) => this.buildDecide(message),
    'studio.build.answer': (message) => this.buildAnswer(message),
    'studio.build.intents': (message) => this.buildIntents(message),
    'studio.build.mine': (message) => this.buildMine(stringField(message, 'build'), stringField(message, 'proposal')),
    'studio.build.preview': (message) => this.buildPreview(stringField(message, 'build'), stringField(message, 'proposal')),
    'studio.build.source': (message) => this.buildSource(stringField(message, 'build'), stringField(message, 'path'), integerField(message, 'from')),
    'studio.build.finish': (message) => this.buildFinish(stringField(message, 'build'), stringField(message, 'how'), message.activate === true),
    'studio.build.chat': (message) => this.buildChat(stringField(message, 'build')),
    'studio.duplicateWorkflow': (message) => this.duplicateWorkflow(stringField(message, 'selector'), integerField(message, 'pending') ?? 0),
    'studio.retireWorkflow': (message) => this.retireWorkflow(enumField(message, 'action', ['archive', 'restore', 'delete'] as const),
      stringField(message, 'selector'), integerField(message, 'pending') ?? 0),
    'studio.openFile': (message) => this.openFile(stringField(message, 'path'), integerField(message, 'line')),
    'studio.integrationTest': (message) => this.integrationTest(stringField(message, 'target'), stringField(message, 'trigger'),
      stringField(message, 'send'), (message as { sendTest?: unknown }).sendTest === true)
  });

  /**
   * The workflow configuration proposals waiting for review, and those saved on this computer whose
   * upload did not succeed. The second kind is in no remote review list, so without this it could
   * not be found at all. A working-tree authority has neither.
   */
  private async proposals(): Promise<void> {
    if (this.model?.authority?.kind === 'working-tree') { this.post({ type: 'studio.proposals', proposals: [], local: true }); return; }
    // Read first and independently: the remote list fails for the same network or sign-in reason
    // an upload does, and that is exactly when these must still show.
    this.uploads = await this.client.run<unknown>(['push', 'status', '--repository', this.client.repository, '--json'])
      .then(localProposalUploads, () => []);
    try {
      const listed = await this.client.run<unknown>(['workflow', 'proposals', '--json']);
      this.post({ type: 'studio.proposals', proposals: proposalSummaries(listed), uploads: this.uploads });
    } catch (error) {
      this.post({ type: 'studio.proposals', proposals: [], uploads: this.uploads, error: (error as Error).message });
    }
  }

  /**
   * Drop one saved agent, skill or instruction draft, as the person confirmed on the page: the same
   * `configuration discard <DRAFT-ID>` the command line runs. A draft approved from another computer
   * or one that no longer applies otherwise stays in every batch the Studio publishes.
   */
  private async discardSavedDraft(draftId: string | null): Promise<void> {
    if (!draftId || !SAVED_DRAFT_ID.test(draftId)) { this.post({ type: 'studio.failed', message: 'That is not a saved draft.' }); return; }
    const command = ['configuration', 'discard', draftId, '--json'];
    this.output.appendLine(`\n$ singularity-flow ${formatCliArgsForDisplay(command)}`);
    let removed: string[];
    try { removed = ((await this.client.run<{ removed?: unknown }>(command))?.removed as string[] | undefined) ?? []; }
    catch (error) { this.post({ type: 'studio.failed', message: (error as Error).message }); return; }
    await this.load(false);
    this.post({ type: 'studio.savedDraftDiscarded', message: `Discarded the saved draft${removed.length ? `: ${removed.join('; ')}` : ''}.` });
  }

  /** Try a not-yet-uploaded proposal's upload again, as the person asked (one attempt, never automatic). */
  private async retryUpload(intentId: string | null): Promise<void> {
    const upload = this.uploads.find(entry => entry.intentId === intentId);
    if (!upload) { this.post({ type: 'studio.failed', message: 'That upload is no longer waiting. Refresh the list.' }); return; }
    // `sync <INTENT-ID>` is the one retry command; its JSON carries the intent as data.intent.
    const command = ['sync', upload.intentId, '--json'];
    this.output.appendLine(`\n$ singularity-flow ${formatCliArgsForDisplay(command)}`);
    let text: string;
    try {
      const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, title: `Uploading ${reviewBranchName(upload.branch)}`, cancellable: false
      }, () => this.client.run<unknown>(command));
      const intent = localProposalUploads({ data: { intents: [(result as { data?: { intent?: unknown } })?.data?.intent] } })[0];
      text = !intent
        ? `${reviewBranchName(upload.branch)} was uploaded and is waiting for review below.`
        : `${reviewBranchName(upload.branch)} is still not uploaded (${intent.status}). ${intent.advice ?? ''}`.trim();
    } catch (error) {
      text = `${reviewBranchName(upload.branch)} could not be uploaded: ${(error as Error).message}`;
    }
    this.post({ type: 'studio.uploadRetried', intentId: upload.intentId, message: text });
    await this.proposals();
  }

  /**
   * Open a terminal in the proposal's checkout that asks the remote one read-only question, so Git's
   * credential manager can show its sign-in. Background uploads are never allowed to prompt.
   */
  private checkSignIn(intentId: string | null): void {
    const upload = this.uploads.find(entry => entry.intentId === intentId);
    if (!upload || !/^[A-Za-z0-9._-]+$/.test(upload.remote) || !path.isAbsolute(upload.repositoryRoot)) return;
    const terminal = createTerminalIn({ name: 'Git sign-in' }, upload.repositoryRoot);
    terminal.show();
    terminal.sendText(`git ls-remote --exit-code ${upload.remote} HEAD`);
    this.post({ type: 'studio.uploadRetried', intentId: upload.intentId,
      message: 'Sign in if Git asks, in the terminal that opened. When it prints a commit line, choose Retry upload.' });
  }

  /**
   * The approved configuration changed under the page (a proposal activated, a bundle imported). With
   * nothing unpublished the page reloads; otherwise its changes stay and move onto the newer
   * configuration, so they never revert what changed meanwhile [SCF:REQ-013, finding ER-F10].
   */
  private async configurationChanged(pending: number, reason: string): Promise<void> {
    await this.loadKeeping(pending > 0, reason);
    await this.actions.refresh();
  }

  /** Load the newer configuration; with unpublished changes the page keeps them, moved onto it. */
  private async loadKeeping(keep: boolean, reason: string): Promise<void> {
    if (!keep) { await this.load(true); return; }
    try {
      this.model = await this.client.run<StudioModel>([...STUDIO_MODEL_ARGS]);
      this.post({ type: 'studio.model', model: this.model, reset: false, reason });
    } catch (error) {
      this.post({ type: 'studio.failed', message: (error as Error).message });
    }
  }

  private async reviewProposal(branch: string | null, pending: number): Promise<void> {
    if (!branch || !PROPOSAL_BRANCH.test(branch)) { this.post({ type: 'studio.failed', message: 'That is not a configuration proposal.' }); return; }
    const before = this.modelBase();
    const stopped = await this.actions.reviewProposal(branch);
    if (typeof stopped === 'string' && stopped) this.post({ type: 'studio.failed', message: stopped });
    const fresh = await this.client.run<StudioModel>([...STUDIO_MODEL_ARGS]).catch(() => null);
    if (fresh && JSON.stringify(fresh.base ?? null) !== before) {
      // Unpublished changes stay and move onto the newer configuration (finding ER-F10).
      this.model = fresh;
      this.post({ type: 'studio.model', model: fresh, reset: pending === 0, ...(pending > 0 ? { reason: `${branch} was activated` } : {}) });
    }
    await this.proposals();
  }

  private async rejectProposal(branch: string | null): Promise<void> {
    if (!branch || !PROPOSAL_BRANCH.test(branch)) { this.post({ type: 'studio.failed', message: 'That is not a configuration proposal.' }); return; }
    if (!this.actions.rejectProposal) { this.post({ type: 'studio.failed', message: 'Withdrawing or rejecting a proposal is not available here.' }); return; }
    const stopped = await this.actions.rejectProposal(branch);
    if (typeof stopped === 'string' && stopped) this.post({ type: 'studio.failed', message: stopped });
    await this.proposals();
  }

  private async exportWorkflows(raw: unknown): Promise<void> {
    const selectors = Array.isArray(raw)
      ? [...new Set(raw.filter((value): value is string => typeof value === 'string' && WORKFLOW_SELECTOR.test(value)))].slice(0, MAX_EXPORT_WORKFLOWS)
      : [];
    if (!selectors.length) { this.post({ type: 'studio.failed', message: 'Choose at least one workflow to export.' }); return; }
    if (!this.actions.exportWorkflows) { this.post({ type: 'studio.failed', message: 'Exporting workflows is not available here.' }); return; }
    const stopped = await this.actions.exportWorkflows(selectors);
    this.post(stopped ? { type: 'studio.failed', message: stopped } : { type: 'studio.exported' });
  }

  private async importWorkflows(pending: number): Promise<void> {
    if (!this.actions.importWorkflows) { this.post({ type: 'studio.failed', message: 'Importing workflows is not available here.' }); return; }
    const before = this.modelBase();
    const source = this.bundleToImport ?? undefined;
    this.bundleToImport = null;
    const result = await this.actions.importWorkflows(source);
    if (result.outcome === 'failed') { this.post({ type: 'studio.failed', message: result.error ?? 'The import did not complete.' }); return; }
    if (result.outcome !== 'cancelled') {
      const fresh = await this.client.run<StudioModel>([...STUDIO_MODEL_ARGS]).catch(() => null);
      if (fresh && JSON.stringify(fresh.base ?? null) !== before) await this.configurationChanged(pending, 'workflows were imported');
    }
    this.post({ type: 'studio.importDone', outcome: result.outcome, branch: result.branch ?? null, error: result.error,
      // Only a proposal still uploading says so; every other outcome keeps its exact shape.
      ...(result.uploaded === false ? { uploaded: false } : {}) });
    if (result.outcome !== 'cancelled') await this.proposals();
  }

  private async duplicateWorkflow(selector: string | null, pending: number): Promise<void> {
    if (!selector || !WORKFLOW_SELECTOR.test(selector) || !this.actions.duplicateWorkflow) {
      this.post({ type: 'studio.failed', message: 'Choose a published workflow to duplicate.' }); return;
    }
    const before = this.modelBase();
    const result = await this.actions.duplicateWorkflow(selector);
    if (result.outcome === 'failed') { this.post({ type: 'studio.failed', message: result.error ?? 'Duplication failed.' }); return; }
    if (result.outcome !== 'cancelled') {
      const fresh = await this.client.run<StudioModel>([...STUDIO_MODEL_ARGS]).catch(() => null);
      if (fresh && JSON.stringify(fresh.base ?? null) !== before) await this.configurationChanged(pending, 'a workflow was duplicated');
      await this.proposals();
    }
    this.post({ type: 'studio.importDone', outcome: result.outcome, branch: result.branch ?? null, error: result.error,
      // Only a proposal still uploading says so; every other outcome keeps its exact shape.
      ...(result.uploaded === false ? { uploaded: false } : {}) });
  }

  /** Workflow labels by selector, from the model the page shows. */
  private workflowLabels(): Record<string, string> {
    const labels: Record<string, string> = {};
    const model = this.model as { workflows?: Array<{ id: string; label?: string }>; epics?: { workflows?: Array<{ id: string; label?: string }> } } | null;
    for (const workflow of model?.workflows ?? []) labels[`story:${workflow.id}`] = workflow.label ?? workflow.id;
    for (const workflow of model?.epics?.workflows ?? []) labels[`initiative:${workflow.id}`] = workflow.label ?? workflow.id;
    return labels;
  }

  /**
   * Archive, restore or delete a published workflow (docs/SPEC-WORKFLOW-RETIREMENT-v1.md). Archive and
   * restore change only the archive list, as a review proposal like a publish (or the repository's own
   * files where it has no approved configuration authority). Delete… opens the review page of the
   * engine's exact plan. The engine decides what is allowed; the page only offers what it may.
   */
  private async retireWorkflow(action: 'archive' | 'restore' | 'delete' | null, selector: string | null, pending: number): Promise<void> {
    const labels = this.workflowLabels();
    const label = selector && WORKFLOW_SELECTOR.test(selector) ? labels[selector] : undefined;
    if (!action || !selector || !label) { this.post({ type: 'studio.failed', message: 'Choose a published workflow.' }); return; }
    let propose: boolean;
    try { propose = studioPublishArgs(this.model?.authority).includes('--propose'); }
    catch (error) { this.post({ type: 'studio.failed', message: (error as Error).message }); return; }
    const before = this.modelBase();
    const outcome = action === 'delete'
      ? await WorkflowDeletePanel.show({ client: this.client, output: this.output, selector, label, labels,
        review: (branch) => this.reviewProposal(branch, pending) })
      : await this.archiveWorkflow(selector, label, labels, action === 'restore', propose);
    if (outcome.outcome !== 'cancelled' && outcome.outcome !== 'failed') {
      const fresh = await this.client.run<StudioModel>([...STUDIO_MODEL_ARGS]).catch(() => null);
      if (fresh && JSON.stringify(fresh.base ?? null) !== before) await this.configurationChanged(pending, `${label} was ${action === 'restore' ? 'restored' : `${action}d`}`);
      await this.proposals();
    }
    this.post({ type: 'studio.retireDone', text: outcome.text });
    if (outcome.outcome === 'proposed' && outcome.branch && action !== 'delete') {
      const branch = outcome.branch;
      void showCompactInformationMessage(outcome.text, 'Review and approve').then((choice) => {
        if (choice === 'Review and approve') return this.reviewProposal(branch, pending);
      });
    } else if (outcome.outcome === 'written') {
      void showCompactInformationMessage(outcome.text, 'Open Source Control').then((choice) => {
        if (choice === 'Open Source Control') return vscode.commands.executeCommand('workbench.view.scm');
      });
    }
  }

  /** Archive (with an optional reason) or restore; the default workflow first asks for its replacement. */
  private async archiveWorkflow(selector: string, label: string, labels: Record<string, string>, restore: boolean, propose: boolean): Promise<WorkflowRetireOutcome> {
    const work = selector.startsWith('initiative:') ? 'Epics' : 'Stories';
    let reason: string | null = null;
    if (!restore) {
      const typed = await vscode.window.showInputBox({
        title: `Archive ${label}`, ignoreFocusOut: true, placeHolder: 'Optional, for example: replaced by another workflow',
        prompt: `New ${work} are no longer offered it; ${work} already using it keep running, and Restore brings it back. Why is it archived? (optional, shown on its card)`,
        validateInput: (value) => value.trim().length > 500 ? 'Use 500 characters or fewer.' : null
      });
      if (typed === undefined) return { outcome: 'cancelled', text: `${label} was not archived.` };
      reason = typed.trim() || null;
    }
    let newDefault: string | null = null;
    for (;;) {
      const args = workflowArchiveArgs(selector, { restore, reason, newDefault, propose });
      this.output.appendLine(`\n$ singularity-flow ${formatCliArgsForDisplay(args)}`);
      try {
        const result = await vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification, title: `${restore ? 'Restoring' : 'Archiving'} ${label}`, cancellable: false
        }, () => this.client.run<{ status?: string; changed?: boolean; reviewRequired?: boolean; branch?: string | null; files?: unknown }>(args));
        const done = restore ? 'Restored' : 'Archived';
        const defaults = newDefault ? ` New Stories default to ${labels[`story:${newDefault}`] ?? newDefault} instead.` : '';
        if (result.reviewRequired && result.branch) {
          return { outcome: 'proposed', branch: result.branch, text: `${done} ${label} as proposal ${result.branch}; new ${work} ${restore ? 'can choose it' : 'stop being offered it'} once it is reviewed and activated.${defaults}` };
        }
        if (result.changed === false) return { outcome: 'unchanged', text: `${label} is ${restore ? 'not archived' : 'already archived'}; nothing changed.` };
        const files = Array.isArray(result.files) && result.files.length ? result.files.filter((file): file is string => typeof file === 'string') : ['singularity/workflow-archive.yml'];
        return { outcome: 'written', text: `${done} ${label} in this repository's ${files.join(' and ')}; new ${work} ${restore ? 'can choose it again' : 'are no longer offered it'}.${defaults} Review the diff and commit it.` };
      } catch (error) {
        const refusal = refusalOf(error);
        this.output.appendLine(`  refused: ${refusal?.message ?? (error as Error).message}`);
        if (refusal?.code === 'WORKFLOW_DEFAULT_REPLACEMENT_REQUIRED' && !newDefault) {
          newDefault = await chooseNewDefault(label, liveWorkflows(refusal), labels);
          if (newDefault) continue;
          return { outcome: 'cancelled', text: `${label} is the default workflow for new Stories, so it was not archived: choose its replacement to archive it.` };
        }
        return { outcome: 'failed', text: `${label} was not ${restore ? 'restored' : 'archived'}: ${refusal?.message ?? (error as Error).message}` };
      }
    }
  }

  /** Repository files the page may open: the governed workflow and portfolio files, and templates. */
  private openableFile(relative: string): boolean {
    if (relative.split('/').some((part) => part === '..' || part === '' || part === '.')) return false;
    if (relative === 'singularity/workflow.yml' || relative === 'singularity/portfolio.yml') return true;
    // Files a workflow check can point at: skills, instructions, the attachments file and agents.
    if (/^singularity\/(?:skill-library\/[a-z0-9][a-z0-9-]*\/SKILL\.md|instruction-library\/[a-z0-9][a-z0-9-]*\/INSTRUCTIONS\.md|skill-library\/attachments\.yml)$/.test(relative)) return true;
    // Agents live in singularity/agents, or in .github/agents on the legacy layout (SPEC-AGH).
    if (/^(?:\.github|singularity)\/agents\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(relative)) return true;
    const root = typeof this.model?.templatesRoot === 'string' && this.model.templatesRoot ? this.model.templatesRoot : 'singularity/templates';
    return relative.startsWith(`${root}/`) && /^[A-Za-z0-9][A-Za-z0-9._/-]*\.md$/.test(relative.slice(root.length + 1));
  }

  private async openFile(relative: string | null, line: number | null = null): Promise<void> {
    if (!relative || relative.length > 512 || !this.openableFile(relative) || !this.actions.openFile) return;
    // A check finding opens the file at the line it is about.
    await this.actions.openFile(relative, line !== null && line > 0 && line < 1_000_000 ? line : undefined);
  }

  /** Whether each secret is stored through VS Code, inherited from the environment, or missing. Never a value. */
  private async secretStatus(rawNames: unknown): Promise<void> {
    const names = Array.isArray(rawNames)
      ? [...new Set(rawNames.filter((name): name is string => typeof name === 'string' && INTEGRATION_SECRET_NAME.test(name)))].slice(0, MAX_SECRET_NAMES)
      : [];
    const store = this.actions.integrationSecrets;
    const status = store ? await store.status(names) : {};
    const jira = store ? await store.jiraStatus() : null;
    this.post({ type: 'studio.secretStatus', status, jira, canStore: Boolean(store) });
  }

  /**
   * Review removing, replacing or discarding work without a screen-sized native modal.
   * The page runs its action only on an explicit human confirmation.
   */
  private async confirm(id: string | null, text: string | null, detail: string | null, ok: string | null): Promise<void> {
    if (this.disposed || !id || !/^confirm-\d{1,9}$/.test(id) || !text || !ok) return;
    const reviewedRepository = this.client.repository;
    const bounded = (value: string, limit: number) => value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
    const accepted = await collectReviewConfirmation({
      title: 'Review Workflow Studio change', summary: text,
      detail: detail ?? 'Review the exact change before continuing.', confirmLabel: bounded(ok, 60)
    });
    if (this.disposed) return;
    this.post({ type: 'studio.confirmed', id, ok: accepted && this.client.repository === reviewedRepository });
  }

  /** Jira targets use the Jira connection VS Code keeps; connecting is VS Code's own flow. */
  private async connectJira(): Promise<void> {
    await vscode.commands.executeCommand('singularityFlow.connectJira');
    await this.secretStatus([]);
  }

  /** The value is typed into VS Code's own password box, so it never passes through the page. */
  private async storeSecret(name: string | null): Promise<void> {
    const store = this.actions.integrationSecrets;
    if (!store || !name || !INTEGRATION_SECRET_NAME.test(name)) return;
    const value = await vscode.window.showInputBox({
      title: `Store ${name}`,
      prompt: 'Kept in the operating-system keychain and passed only to Singularity Flow commands on this machine. It is never written to Git or shown again.',
      password: true,
      ignoreFocusOut: true,
      validateInput: (text) => text.trim() ? null : 'Enter the secret value.'
    });
    if (!value) return;
    try {
      await store.store(name, value);
      this.post({ type: 'studio.secretStored', name });
      await this.secretStatus([name]);
    } catch (error) {
      this.post({ type: 'studio.failed', message: (error as Error).message });
    }
  }

  private async clearSecret(name: string | null): Promise<void> {
    const store = this.actions.integrationSecrets;
    if (!store || !name || !INTEGRATION_SECRET_NAME.test(name)) return;
    const confirmed = await showCompactWarningMessage(`Remove ${name} from this machine's keychain?`, {
      modal: true,
      detail: 'Deliveries that need it wait and retry until it is stored again or set in the environment.'
    }, 'Remove');
    if (confirmed !== 'Remove') return;
    await store.clear(name);
    await this.secretStatus([name]);
  }

  /**
   * The exact request a published target would receive, secrets redacted; on request, one delivery
   * marked as a test. The engine reads targets from approved configuration, so the page offers this
   * only for targets that are published and unchanged in the draft.
   */
  private async integrationTest(target: string | null, trigger: string | null, send: string | null, sendTest: boolean): Promise<void> {
    if (!target || !TARGET_ID.test(target) || !trigger || !ACTION_TRIGGERS.has(trigger) || !send || !ACTION_SENDS.has(send)) {
      this.post({ type: 'studio.integrationTested', target, failed: 'Choose a published target, when it fires and what it sends.' });
      return;
    }
    // The kind comes from the model this host read, never from the page: a Jira or Git "test" only
    // signs in and reads, so it needs no consent; every other test sends a request somewhere.
    const targets = ((this.model as { integrations?: { targets?: Array<{ id?: string; kind?: string }> } } | null)?.integrations?.targets) ?? [];
    const readOnly = ['jira', 'git', 'confluence', 'onedrive'].includes(targets.find((entry) => entry.id === target)?.kind ?? '');
    if (sendTest && !readOnly) {
      const confirmed = await showCompactWarningMessage(`Send a test delivery to '${target}'?`, {
        modal: true,
        detail: 'One request marked as a test goes to the address the target names, signed or authenticated with its secret. Nothing in the repository changes.'
      }, 'Send test');
      if (confirmed !== 'Send test') { this.post({ type: 'studio.integrationTested', target, cancelled: true }); return; }
    }
    try {
      const result = await this.client.run<{ data?: Record<string, unknown> }>([
        'integrations', 'test', target, '--trigger', trigger, '--send', send, ...(sendTest ? ['--send-test'] : []), '--json'
      ]);
      this.post({ type: 'studio.integrationTested', target, result: result.data ?? null });
    } catch (error) {
      this.post({ type: 'studio.integrationTested', target, failed: (error as Error).message });
    }
  }

  /**
   * The engine fetches, checks and stages what a person wants to import; the page shows the exact
   * text and hash it returns. Nothing in the repository changes until the import is published.
   */
  private async importPreview(reference: string | null, as: string | null, rawArguments?: unknown): Promise<void> {
    if (!reference || reference.length > MAX_REFERENCE_LENGTH
        || !(reference.startsWith('https://') || reference.startsWith('market:') || reference.startsWith('mcp:'))
        || !as || !IMPORT_KINDS.has(as)) {
      this.post({ type: 'studio.importFailed', message: 'Paste a public https:// link, or choose a marketplace entry or an MCP server item.' });
      return;
    }
    const mcpFlags: string[] = [];
    if (reference.startsWith('mcp:')) {
      const serverId = reference.slice(4).split('/')[0] ?? '';
      if (!(await this.mcpConsentFor(serverId))) return;
      mcpFlags.push('--launch');
      for (const [name, value] of Object.entries(rawArguments && typeof rawArguments === 'object' ? rawArguments as Record<string, unknown> : {}).slice(0, 32)) {
        if (/^[A-Za-z0-9_.-]{1,64}$/.test(name) && typeof value === 'string' && value.length <= 4096) mcpFlags.push('--arg', `${name}=${value}`);
      }
    }
    try {
      const preview = await this.client.run<Record<string, unknown>>(['import', 'preview', reference, '--as', as, ...mcpFlags, '--json']);
      this.post({ type: 'studio.importPreviewed', preview });
    } catch (error) {
      this.post({ type: 'studio.importFailed', message: (error as Error).message });
    }
  }

  private async marketplaceBrowse(id: string | null): Promise<void> {
    if (!id || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
      this.post({ type: 'studio.importFailed', message: 'Choose a marketplace this repository trusts.' });
      return;
    }
    try {
      const result = await this.client.run<Record<string, unknown>>(['marketplace', 'browse', id, '--json']);
      this.post({ type: 'studio.marketplaceEntries', result });
    } catch (error) {
      this.post({ type: 'studio.importFailed', message: (error as Error).message });
    }
  }

  /**
   * A Git repository marketplace, read once now with a dry run of `marketplace add --repo`: the engine checks it is a
   * marketplace and names the commit it is read at, and the page queues that exact pin. Nothing is written here.
   */
  private async marketplaceRead(id: string | null, repository: string | null, ref: string | null, label: string | null): Promise<void> {
    const repositoryText = (repository ?? '').trim(); const refText = (ref ?? '').trim(); const labelText = (label ?? '').trim();
    if (!id || !SERVER_ID.test(id) || !repositoryText || repositoryText.length > MAX_REFERENCE_LENGTH || repositoryText.startsWith('-') || /[\0\r\n]/.test(repositoryText)) {
      this.post({ type: 'studio.importFailed', message: 'A marketplace needs an ID and its Git repository: an https or ssh URL, or the folder of a clone on this computer.' });
      return;
    }
    if ((refText && !MARKETPLACE_REF.test(refText)) || labelText.length > 200 || labelText.startsWith('-') || /[\0\r\n]/.test(labelText)) {
      this.post({ type: 'studio.importFailed', message: 'Give a branch or tag name as Git spells it (or leave it empty), and a name of one line.' });
      return;
    }
    try {
      const result = await this.client.run<{ resultType?: string; valid?: boolean; problems?: Array<{ message?: string }>; updates?: unknown[];
        marketplace?: { label?: string | null; repository?: string; ref?: string | null; commit?: string; repin?: boolean; agents?: number; skills?: number } }>(
        ['marketplace', 'add', id, '--repo', repositoryText, ...(refText ? ['--ref', refText] : []), ...(labelText ? ['--label', labelText] : []), '--dry-run', '--json']);
      if (result.resultType === 'marketplace-unchanged') {
        this.post({ type: 'studio.importFailed', message: `This repository already reads ${id} at the commit ${refText || 'its default branch'} is at now. Nothing to add.` });
        return;
      }
      const read = result.marketplace;
      if (result.valid === false || !read?.commit || !read.repository) {
        this.post({ type: 'studio.importFailed', message: (result.problems ?? []).map((problem) => problem.message).filter(Boolean).join(' ') || `Marketplace ${id} could not be read.` });
        return;
      }
      // Reading a trusted marketplace's newest commit also checks the workflows made from it, from the engine's same read.
      if (read.repin === true && Array.isArray(result.updates) && result.updates.length) this.post({ type: 'studio.importsChecked', result: { imports: result.updates } });
      this.post({ type: 'studio.marketplaceRead', id, label: read.label ?? null, repository: read.repository, ref: read.ref ?? null, commit: read.commit,
        repin: read.repin === true, agents: read.agents ?? 0, skills: read.skills ?? 0 });
    } catch (error) {
      this.post({ type: 'studio.importFailed', message: (error as Error).message });
    }
  }

  /** The workflow a marketplace agent becomes, with the person's answers so far: `workflow from-agent`, which writes nothing. */
  private async agentWorkflowPreview(target: string | null, answers: unknown, update = false, looked: unknown = []): Promise<void> {
    if (!target || !MARKETPLACE_AGENT.test(target)) { this.post({ type: 'studio.importFailed', message: 'Choose an agent of a marketplace this repository trusts.' }); return; }
    try {
      // The person's "I looked at these lines" is the engine's --looked: it says whether the review is ready (OMK §7).
      const result = await this.client.run<Record<string, unknown>>(['workflow', 'from-agent', target, ...agentStageAnswers(answers), ...(update ? ['--update'] : []), ...lookedFlags(looked), '--json']);
      this.agentPreview = { target, answers, result };
      this.post({ type: 'studio.agentWorkflowPreviewed', target, result });
    } catch (error) {
      this.post({ type: 'studio.importFailed', message: (error as Error).message });
    }
  }

  /**
   * Make it: `workflow from-agent --propose` keeps the bundle in SFlow's private folder, and the page starts Import… with
   * it, so the person reviews and confirms the import exactly as for any bundle, with the page's own count of changes.
   */
  private async agentWorkflowMake(target: string | null, answers: unknown, update = false, looked: unknown = []): Promise<void> {
    if (!target || !MARKETPLACE_AGENT.test(target)) { this.post({ type: 'studio.importFailed', message: 'Choose an agent of a marketplace this repository trusts.' }); return; }
    try {
      const result = await this.client.run<{ bundlePath?: string; workflow?: { id?: string } }>(['workflow', 'from-agent', target, ...agentStageAnswers(answers), ...(update ? ['--update'] : []), ...lookedFlags(looked), '--propose', '--json']);
      if (!result.bundlePath || !path.isAbsolute(result.bundlePath)) { this.post({ type: 'studio.importFailed', message: 'The workflow bundle was not written.' }); return; }
      this.post({ type: 'studio.agentWorkflowMade', workflowId: result.workflow?.id ?? null });
      this.requestImport(result.bundlePath);
    } catch (error) {
      this.post({ type: 'studio.importFailed', message: (error as Error).message });
    }
  }

  /** The feedback of the conversion the page shows, from the engine's own answer (MCR §6); null when there is none. */
  private agentFeedback(target: string | null): { name: string; markdown: string; issue: { url: string; bodyInUrl: boolean } | null } | null {
    if (!target || this.agentPreview?.target !== target) return null;
    const review = this.agentPreview.result.review as { feedbackDocument?: { name: string; markdown: string; issue: { url: string; bodyInUrl: boolean } | null } } | undefined;
    return review?.feedbackDocument ?? null;
  }

  /** Save the feedback where the person chooses: the engine writes it (workflow from-agent --feedback). */
  private async agentFeedbackSave(target: string | null, answers: unknown): Promise<void> {
    const feedback = this.agentFeedback(target);
    if (!target || !MARKETPLACE_AGENT.test(target) || !feedback) { this.post({ type: 'studio.agentFeedbackDone', status: 'Preview the workflow again; its feedback is not here.' }); return; }
    const chosen = await vscode.window.showSaveDialog({ title: 'Save the feedback for the marketplace', saveLabel: 'Save',
      defaultUri: vscode.Uri.file(path.join(os.homedir(), feedback.name)), filters: { Markdown: ['md'] } });
    if (!chosen) { this.post({ type: 'studio.agentFeedbackDone', status: 'Nothing was saved.' }); return; }
    try {
      await this.client.run(['workflow', 'from-agent', target, ...agentStageAnswers(answers), '--feedback', chosen.fsPath, '--json']);
      this.post({ type: 'studio.agentFeedbackDone', status: `Saved ${path.basename(chosen.fsPath)} for the marketplace's maintainers.` });
    } catch (error) {
      this.post({ type: 'studio.agentFeedbackDone', status: (error as Error).message });
    }
  }

  private async agentFeedbackCopy(target: string | null): Promise<void> {
    const feedback = this.agentFeedback(target);
    if (!feedback) { this.post({ type: 'studio.agentFeedbackDone', status: 'Preview the workflow again; its feedback is not here.' }); return; }
    await vscode.env.clipboard.writeText(feedback.markdown);
    this.post({ type: 'studio.agentFeedbackDone', status: 'Copied the feedback; paste it where the maintainers will read it.' });
  }

  /** A new issue in the person's browser, filled in from the engine's answer; the person submits it, SFlow never posts. */
  private async agentFeedbackIssue(target: string | null): Promise<void> {
    const feedback = this.agentFeedback(target);
    const url = feedback?.issue?.url ?? '';
    if (!feedback || !/^https:\/\/[^\s@]+$/u.test(url)) { this.post({ type: 'studio.agentFeedbackDone', status: 'This marketplace has no issue page SFlow can open; save or copy the feedback instead.' }); return; }
    if (!feedback.issue?.bodyInUrl) await vscode.env.clipboard.writeText(feedback.markdown);
    // The address as written: VS Code encodes a Uri a second time, and the issue body arrived as "%23 Feedback…"
    // (real VS Code, 2026-11-24). Every page the extension opens passes its string (test/vscode-open-external.test.mjs).
    await vscode.env.openExternal(url as unknown as vscode.Uri);
    this.post({ type: 'studio.agentFeedbackDone', status: feedback.issue?.bodyInUrl ? 'Opened a new issue with the feedback filled in; you submit it.'
      : 'Opened a new issue; the feedback is copied, so paste it there and submit it.' });
  }

  /**
   * Starting or contacting an MCP server is the person's decision. The engine refuses without
   * consent and says exactly what it would run or where it would connect; that is what is shown.
   */
  private async mcpConsentFor(serverId: string): Promise<boolean> {
    if (!SERVER_ID.test(serverId)) {
      this.post({ type: 'studio.importFailed', message: 'Choose an MCP server this repository allows imports from.' });
      return false;
    }
    if (this.mcpConsent.has(serverId)) return true;
    let described = '';
    try {
      await this.client.run<Record<string, unknown>>(['mcp', 'sources', serverId, '--json']);
      return true;
    } catch (error) {
      const message = (error as Error).message;
      if (!/Repeat with --launch/.test(message)) { this.post({ type: 'studio.importFailed', message }); return false; }
      described = (message.split(' Nothing was started.')[0] ?? message).replace(/\.$/, '');
    }
    const allowed = await showCompactWarningMessage(`Allow MCP server '${serverId}' for imports?`, {
      modal: true,
      detail: `${described}.\n\nWorkflow Studio stops it as soon as each import is read. Your choice lasts until this Studio closes.`
    }, 'Allow');
    if (allowed !== 'Allow') { this.post({ type: 'studio.importFailed', message: `MCP server '${serverId}' was not started.` }); return false; }
    this.mcpConsent.add(serverId);
    return true;
  }

  private async mcpSources(id: string | null): Promise<void> {
    if (!id || !(await this.mcpConsentFor(id))) return;
    try {
      const result = await this.client.run<Record<string, unknown>>(['mcp', 'sources', id, '--launch', '--json']);
      this.post({ type: 'studio.mcpSourcesListed', result });
    } catch (error) {
      this.post({ type: 'studio.importFailed', message: (error as Error).message });
    }
  }

  /** The host entry of an installed MCP server goes to this workspace's VS Code file, on request. */
  private async mcpHostAdd(id: string | null): Promise<void> {
    if (!id || !SERVER_ID.test(id)) return;
    const confirmed = await showCompactWarningMessage(`Add MCP server '${id}' to this workspace's .vscode/mcp.json?`, {
      modal: true,
      detail: 'The entry comes from the reviewed import. VS Code asks before it starts the server; review and commit the file like any other change.'
    }, 'Add host entry');
    if (confirmed !== 'Add host entry') return;
    try {
      const result = await this.client.run<{ path?: string; host?: { type?: string; command?: string; args?: string[]; url?: string } }>(['mcp', 'host', 'add', id, '--json']);
      const what = result.host?.type === 'stdio' ? `It runs: ${[result.host.command ?? '', ...(result.host.args ?? [])].join(' ')}` : `It connects to: ${result.host?.url ?? ''}`;
      this.post({ type: 'studio.mcpHostAdded', summary: `Added '${id}' to ${result.path ?? '.vscode/mcp.json'}. ${what}` });
    } catch (error) {
      this.post({ type: 'studio.importFailed', message: (error as Error).message });
    }
  }

  private async importsCheck(): Promise<void> {
    try {
      const result = await this.client.run<Record<string, unknown>>(['imports', 'check', '--json']);
      this.post({ type: 'studio.importsChecked', result });
    } catch (error) {
      this.post({ type: 'studio.importFailed', message: (error as Error).message });
    }
  }

  private post(message: Record<string, unknown>): void {
    if (this.disposed) return;
    void this.panel.webview.postMessage(message);
  }

  private async load(reset: boolean): Promise<void> {
    try {
      this.model = await this.client.run<StudioModel>([...STUDIO_MODEL_ARGS]);
      this.post({ type: 'studio.model', model: this.model, reset });
      if (this.skillToOpen) this.post({ type: 'studio.focus', ...this.skillToOpen });
      else if (this.workflowToOpen) {
        this.post({ type: 'studio.focus', workflowId: this.workflowToOpen }); this.workflowToOpen = null;
      } else if (this.agentToOpen) this.post({ type: 'studio.focus', view: 'agents', ...this.agentToOpen });
      else if (this.focus) this.post({ type: 'studio.focus', view: this.focus });
      this.focus = null; this.agentToOpen = null; this.skillToOpen = null;
      if (this.bundleToImport) this.post({ type: 'studio.importRequested', name: this.bundleToImport.split(/[\\/]/).pop() });
      await this.offerSavedDraft();
      await this.proposals();
    } catch (error) {
      this.post({ type: 'studio.failed', message: (error as Error).message });
    }
  }

  /** The configuration revision a draft is made on, as text, or null when the model names none. */
  private modelBase(): string | null {
    const base = this.model?.base;
    return base == null ? null : JSON.stringify(base);
  }

  /**
   * Offer kept changes back. They are kept as edits against the configuration they were read from (schema 2),
   * so the page moves them onto a newer one and names a value both changed: a newer configuration never
   * discards them [SCF:REQ-013, finding ER-F8]. A full copy an earlier build kept (schema 1) can only be offered
   * on the configuration it was made on; elsewhere the person is told it could not be moved.
   */
  private async offerSavedDraft(): Promise<void> {
    const store = this.actions.draftStore;
    if (!store) return;
    const saved = store.get() as Partial<StudioSavedDraft> | undefined;
    if (!saved || (saved.schema !== 1 && saved.schema !== 2) || typeof saved.draft !== 'string') return;
    const moved = saved.base !== this.modelBase();
    if (saved.schema === 1 && moved) {
      await store.set(undefined);
      this.post({ type: 'studio.savedDraftDiscarded', message: 'Changes an earlier version of Workflow Studio kept were made on an older configuration and could not be moved onto this one.' });
      return;
    }
    this.post({ type: 'studio.savedDraft', draft: saved.draft, savedAt: saved.savedAt ?? null, moved });
  }

  private async saveDraft(text: string | null): Promise<void> {
    const store = this.actions.draftStore;
    const base = this.modelBase();
    if (!store || !text || !base || Buffer.byteLength(text, 'utf8') > MAX_CHANGE_SET_BYTES) return;
    await store.set({ schema: 2, base, savedAt: new Date().toISOString(), draft: text });
  }

  private async clearDraft(): Promise<void> {
    await this.actions.draftStore?.set(undefined);
  }

  private changeSet(text: string | null): string | null {
    if (!text || Buffer.byteLength(text, 'utf8') > MAX_CHANGE_SET_BYTES) {
      this.post({ type: 'studio.failed', message: 'That change set is empty or too large to check.' });
      return null;
    }
    return text;
  }

  private async preview(text: string | null): Promise<void> {
    const changeSet = this.changeSet(text);
    if (!changeSet) return;
    try {
      const plan = await this.client.runWithInput<StudioPlan>([...STUDIO_PREVIEW_ARGS], changeSet);
      this.post({ type: 'studio.plan', plan, changeSet });
    } catch (error) {
      this.post({ type: 'studio.failed', message: (error as Error).message });
    }
  }

  /** Explain and check one workflow; with the draft's change set, as publishing it would leave it. */
  private async check(workflow: string | null, text: string | null): Promise<void> {
    if (!workflow || workflow.length > 120 || !/^[a-z0-9][a-z0-9-]*$/.test(workflow)) return;
    const changeSet = text ?? '';
    if (Buffer.byteLength(changeSet, 'utf8') > MAX_CHANGE_SET_BYTES) {
      this.post({ type: 'studio.checkFailed', workflow, changeSet, message: 'These changes are too large to check.' });
      return;
    }
    try {
      const result = changeSet
        ? await this.client.runWithInput<unknown>(studioCheckArgs(workflow, true), changeSet)
        : await this.client.run<unknown>(studioCheckArgs(workflow, false));
      this.post({ type: 'studio.check', workflow, changeSet, result });
    } catch (error) {
      this.post({ type: 'studio.checkFailed', workflow, changeSet, message: (error as Error).message });
    }
  }

  private async publish(text: string | null, count: number): Promise<void> {
    const changeSet = this.changeSet(text);
    if (!changeSet) return;
    let args: string[];
    try { args = studioPublishArgs(this.model?.authority); }
    catch (error) { this.post({ type: 'studio.failed', message: (error as Error).message }); return; }
    const proposal = args.includes('--propose');
    const confirmed = await showCompactWarningMessage(
      `Publish ${count} ${count === 1 ? 'change' : 'changes'} from Workflow Studio?`,
      {
        modal: true,
        detail: proposal
          ? 'They become one review proposal on the approved configuration. Approved configuration and running Stories do not change until it is merged.'
          : 'The files are written to this repository. Review the diff and commit it through your usual review. Running Stories keep the workflow they started with.'
      },
      proposal ? 'Publish for review' : 'Write files'
    );
    if (!confirmed) { this.post({ type: 'studio.cancelled' }); return; }
    this.output.appendLine(`\n$ singularity-flow ${formatCliArgsForDisplay(args)}`);
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Publishing Workflow Studio changes', cancellable: false },
        () => this.client.runWithInput<StudioApplyResult>(args, changeSet)
      );
      for (const line of result.summary ?? []) this.output.appendLine(`  ${line}`);
      // Saved drafts approved elsewhere or no longer applying were left out of the batch: say which.
      const leftOut = (result.warnings ?? []).filter((warning) => warning.code === 'CONFIGURATION_DRAFT_LEFT_OUT').map((warning) => warning.message);
      for (const line of leftOut) this.output.appendLine(`  ${line}`);
      const summary = `${result.reviewRequired && result.branch
        ? `Published for review as ${result.branch}.`
        : `Wrote ${(result.written ?? []).length} file(s) to this repository.`}${leftOut.length ? ` ${leftOut.join(' ')}` : ''}`;
      this.post({ type: 'studio.published', summary });
      await this.clearDraft();
      await this.load(true);
      await this.actions.refresh();
      if (result.reviewRequired && result.branch) {
        const choice = await showCompactInformationMessage(
          `Workflow Studio changes are ready for review: ${result.branch}.`, 'Review and approve', 'Later');
        if (choice === 'Review and approve') await this.actions.reviewProposal(result.branch);
      } else {
        const choice = await showCompactInformationMessage(
          'Workflow Studio wrote the configuration files. Review the diff and commit it.', 'Open Source Control');
        if (choice === 'Open Source Control') await vscode.commands.executeCommand('workbench.view.scm');
      }
    } catch (error) {
      this.output.appendLine(`  refused: ${(error as Error).message}`);
      this.post({ type: 'studio.failed', message: (error as Error).message });
    }
  }


  // ---- Build with Copilot ---------------------------------------------------------------------

  private modelAvailable(): boolean {
    return vscode.workspace.getConfiguration('singularityFlow').get<string>('modelMode', 'auto') !== 'disabled'
      && !vscode.workspace.getConfiguration('chat').get<boolean>('disableAIFeatures', false);
  }

  private buildFailed(message: string): void { this.post({ type: 'studio.buildFailed', message }); }

  /** The build the page names, when it is the one open here; anything else is refused. */
  private openBuildId(raw: string | null): string | null {
    if (raw && BUILD_ID.test(raw) && this.build?.id === raw) return raw;
    this.buildFailed('Open the build first.');
    return null;
  }

  /** This repository's builds, and those not tied to one yet, newest first. */
  private async buildList(): Promise<void> {
    try {
      const result = await this.client.run<{ builds: Array<{ repository?: { root?: string } | null }> }>(['workflow', 'build', 'status', '--json']);
      const here = realPath(this.client.repository);
      this.post({ type: 'studio.builds', builds: buildsForRepository(result.builds ?? [], (root) => realPath(root) === here), modelAvailable: this.modelAvailable() });
    } catch (error) { this.post({ type: 'studio.builds', builds: [], modelAvailable: this.modelAvailable() }); this.buildFailed((error as Error).message); }
  }

  private async buildStart(message: InboundMessage): Promise<void> {
    const from = stringField(message, 'from');
    const workflow = stringField(message, 'workflow');
    const name = stringField(message, 'name')?.trim() ?? '';
    const describe = stringField(message, 'describe')?.trim() ?? '';
    if (name.length > 120) return this.buildFailed('Keep the name to 120 characters.');
    if (workflow && !STUDIO_WORKFLOW_ID.test(workflow)) return this.buildFailed('Choose one of the workflows listed.');
    const args = ['workflow', 'build', 'start', ...(name ? ['--name', name] : [])];
    if (from === 'workflow') {
      if (!workflow) return this.buildFailed('Choose the workflow to start from.');
      args.push('--from-workflow', workflow);
    } else if (from === 'change') {
      if (!workflow) return this.buildFailed('Choose the workflow to change.');
      args.push('--change', workflow);
    } else if (from === 'describe') {
      if (!describe || Buffer.byteLength(describe, 'utf8') > 32 * 1024) return this.buildFailed('Describe how the team works, in at most 32 KiB.');
      args.push('--describe', describe);
    } else if (from === 'material') {
      const picked = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: true, canSelectMany: true, openLabel: 'Use this material',
        title: 'Choose a team\'s folders or files: agents, skills, instructions, runbooks, API collections' });
      if (!picked?.length) { this.post({ type: 'studio.buildCancelled', status: 'Nothing was chosen; no build was started.' }); return; }
      if (workflow) args.push('--from-workflow', workflow);
      for (const uri of picked) args.push((await stat(uri.fsPath).catch(() => null))?.isDirectory() ? '--folder' : '--file', uri.fsPath);
    } else return this.buildFailed('Choose where the build starts from.');
    await this.buildChange(() => this.client.run<StudioBuildView>([...args, '--json']), 'Started the build: here is what was found.', true);
  }

  private async buildOpen(raw: string | null): Promise<void> {
    if (!raw || !BUILD_ID.test(raw)) return this.buildFailed('Choose a build to open.');
    await this.buildChange(() => this.client.run<StudioBuildView>(studioBuildArgs('status', raw)), null, true);
  }

  /** One file to go on with the build on another computer (Build with Copilot there: Continue a build from a file). */
  private async buildExport(raw: string | null): Promise<void> {
    const id = this.openBuildId(raw);
    if (!id) return;
    const target = await vscode.window.showSaveDialog({ title: 'Save the build to continue it on another computer', saveLabel: 'Save',
      defaultUri: vscode.Uri.file(path.join(os.homedir(), `${id}.sflow-build.json`)), filters: { 'Workflow build': ['json'] } });
    if (!target) { this.post({ type: 'studio.buildCancelled' }); return; }
    try {
      const result = await this.client.run<{ path: string; files: number }>(studioBuildArgs('export', id, ['--out', target.fsPath]));
      this.post({ type: 'studio.buildCancelled', status: `Saved ${path.basename(result.path)} with the ${result.files} screened files the build keeps. On the other computer, in this repository: Build with Copilot → Continue a build from a file…` });
    } catch (error) { this.buildFailed((error as Error).message); }
  }

  /** Go on with a build another computer saved: it keeps its proposals, questions and decisions. */
  private async buildImportFile(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectMany: false, openLabel: 'Continue this build',
      title: 'Choose a workflow build saved on another computer', filters: { 'Workflow build': ['json'] } });
    const chosen = picked?.[0];
    if (!chosen) { this.post({ type: 'studio.buildCancelled', status: 'Nothing was chosen.' }); return; }
    await this.buildChange(() => this.client.run<StudioBuildView>(['workflow', 'build', 'import', '--file', chosen.fsPath, '--json']),
      'Continued the build here: its proposals, questions and decisions came with it.', true);
  }

  private async buildAdd(raw: string | null): Promise<void> {
    const id = this.openBuildId(raw);
    if (!id) return;
    const picked = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: true, canSelectMany: true, openLabel: 'Add this material', title: 'Add folders or files to the build' });
    if (!picked?.length) { this.post({ type: 'studio.buildCancelled' }); return; }
    const args: string[] = [];
    for (const uri of picked) args.push((await stat(uri.fsPath).catch(() => null))?.isDirectory() ? '--folder' : '--file', uri.fsPath);
    await this.buildChange(() => this.client.run<StudioBuildView>(studioBuildArgs('add', id, args)), 'Added the material.');
  }

  private async buildDecide(message: InboundMessage): Promise<void> {
    const id = this.openBuildId(stringField(message, 'build'));
    const proposal = stringField(message, 'proposal');
    if (!id) return;
    if (!proposal || !BUILD_PROPOSAL_ID.test(proposal)) return this.buildFailed('Choose a proposal.');
    const accept = booleanField(message, 'accept');
    const reason = stringField(message, 'reason')?.trim().slice(0, 2000) ?? '';
    await this.buildChange(() => this.client.run<StudioBuildView>(studioBuildArgs('decide', id, ['--proposal', proposal, ...(accept ? ['--accept'] : ['--decline', ...(reason ? ['--reason', reason] : [])])])),
      accept ? `Accepted ${proposal}.` : `Declined ${proposal}.`);
  }

  private async buildAnswer(message: InboundMessage): Promise<void> {
    const id = this.openBuildId(stringField(message, 'build'));
    const question = stringField(message, 'question');
    const choice = stringField(message, 'choice');
    if (!id) return;
    if (!question || !BUILD_QUESTION_ID.test(question) || !choice || choice.length > 200) return this.buildFailed('Choose one of the answers offered.');
    await this.buildChange(() => this.client.run<StudioBuildView>(studioBuildArgs('answer', id, ['--question', question, '--choice', choice])), 'Answered.');
  }

  /**
   * What each step is for, from the Build view's Finish tab (step intents §6.4): the person's pick for a step, one way
   * of a workflow rule's question, or the confirmation of the table they see (by its code). The build is then shown
   * again with its check.
   */
  private async buildIntents(message: InboundMessage): Promise<void> {
    const id = this.openBuildId(stringField(message, 'build'));
    if (!id) return;
    const extra = buildIntentsArgs(message as Record<string, unknown>);
    if (!extra) return this.buildFailed('Choose what the step does, one of the ways offered, or confirm the table.');
    await this.buildChange(async () => {
      await this.client.run<unknown>(studioBuildArgs('intents', id, extra));
      return this.client.run<StudioBuildView>(studioBuildArgs('status', id));
    }, extra[0] === '--confirm' ? 'Confirmed what each step is for.' : extra[0] === '--rule' ? 'Done: the workflow has its answer.' : 'Recorded what the step does.');
  }

  /** Your own change from the page: recorded and accepted at once. */
  private async buildMine(raw: string | null, text: string | null): Promise<void> {
    const id = this.openBuildId(raw);
    if (!id) return;
    if (!text || Buffer.byteLength(text, 'utf8') > MAX_CHANGE_SET_BYTES) return this.buildFailed('That change is empty or too large.');
    let title = 'your change';
    try { title = String((JSON.parse(text) as { title?: unknown }).title ?? title); } catch { /* the engine refuses it with its reason */ }
    await this.buildChange(() => this.client.runWithInput<StudioBuildView>(studioBuildArgs('propose', id, ['--proposal', '-', '--by', 'you', '--accept']), text), `Done: ${title}.`);
  }

  private async buildPreview(raw: string | null, proposal: string | null): Promise<void> {
    const id = this.openBuildId(raw);
    if (!id) return;
    if (!proposal || !BUILD_PROPOSAL_ID.test(proposal)) return this.buildFailed('Choose a proposal.');
    try {
      const result = await this.client.run<unknown>(studioBuildArgs('check', id, ['--include', proposal]));
      this.post({ type: 'studio.buildPreview', build: id, proposal, result });
    } catch (error) { this.buildFailed((error as Error).message); }
  }

  private async buildSource(raw: string | null, file: string | null, from: number | null): Promise<void> {
    const id = this.openBuildId(raw);
    if (!id) return;
    if (!file || file.length > 1024 || file.includes('\0')) return this.buildFailed('Choose a file the build captured.');
    try {
      const result = await this.client.run<unknown>(studioBuildArgs('source', id, ['--path', file, ...(from && from > 1 ? ['--from', String(from)] : [])]));
      this.post({ type: 'studio.buildSource', build: id, path: file, result });
    } catch (error) { this.buildFailed((error as Error).message); }
  }

  /**
   * Finish: one reviewed proposal on the approved configuration (or, on a working-tree authority,
   * the files written as Studio's Publish writes them), or a portable file to import elsewhere.
   */
  private async buildFinish(raw: string | null, how: string | null, activate = false): Promise<void> {
    const id = this.openBuildId(raw);
    if (!id) return;
    try {
      if (how === 'file') {
        const check = await this.client.run<{ build: { workflow: string } }>(studioBuildArgs('check', id));
        const target = await vscode.window.showSaveDialog({ title: 'Save the workflow as a portable file', saveLabel: 'Save',
          defaultUri: vscode.Uri.file(path.join(this.client.repository, `${check.build.workflow}.sflow-workflows.json`)), filters: { 'Workflow bundle': ['json'] } });
        if (!target) { this.post({ type: 'studio.buildCancelled' }); return; }
        const result = await this.client.run<{ path: string }>(studioBuildArgs('finish', id, ['--out', target.fsPath]));
        this.post({ type: 'studio.buildFinished', build: id, how: 'file', summary: `Saved ${path.basename(result.path)}. Import it with Import… in Workflow Studio, here or in another repository.` });
        await this.buildRefresh(id);
        return;
      }
      let publishArgs: string[];
      try { publishArgs = studioPublishArgs(this.model?.authority); }
      catch (error) { return this.buildFailed((error as Error).message); }
      const proposal = publishArgs.includes('--propose');
      const check = await this.client.run<{ ready: boolean; changeSet: unknown; build: { workflow: string; label: string }; changes?: BuildChanges | null;
        draft?: { workflow?: { phases?: string[] } } }>(studioBuildArgs('check', id));
      if (!check.ready) return this.buildFailed('The build is not ready to finish. Its check says what is left.');
      // A change build changes the workflow it names; it never creates one. Finishing and approving here
      // proposes it, then asks once more, as an approval: the signed `configuration approve`, which says
      // whether it is a self-approval and refuses one the repository does not allow [SCF:REQ-011, D4].
      const now = activate && proposal && Boolean(this.actions.activateProposal);
      const verb = check.changes?.inPlace ? 'Change' : 'Create';
      const confirmed = await showCompactWarningMessage(now ? `${verb} the workflow ${check.build.label} and approve it now?` : `${verb} the workflow ${check.build.label}?`, {
        modal: true,
        ...(now ? { compactDetail: buildChangeSummary(check) } : {}),
        detail: now
          ? [...buildChangeLines(check), '', 'One proposal is made, then you approve it at its exact commit; server rules still apply. New Stories use it; running Stories keep theirs.'].join('\n')
          : proposal
            ? 'It becomes one review proposal on the approved configuration. Nothing changes for running or new Stories until it is reviewed and approved.'
            : 'The files are written to this repository. Review the diff and commit it through your usual review.'
      }, now ? 'Finish and approve' : proposal ? 'Create the proposal' : 'Write files');
      if (!confirmed) { this.post({ type: 'studio.buildCancelled' }); return; }
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Finishing the workflow build', cancellable: false },
        () => proposal
          ? this.client.run<StudioApplyResult>(studioBuildArgs('finish', id, ['--propose']))
          : this.client.runWithInput<StudioApplyResult>(publishArgs, JSON.stringify(check.changeSet)));
      if (now && result.reviewRequired && result.branch) {
        const activation = await this.actions.activateProposal!(result.branch);
        this.post({ type: 'studio.buildFinished', build: id, how: 'publish', activated: activation.activated, summary: activation.activated
          ? `Approved: ${check.build.label} is in the approved configuration, and new Stories use it now. Stories already running keep theirs.`
          : `Proposed for review as ${result.branch}, not approved: ${activation.message}` });
        await this.buildRefresh(id);
        await this.load(true);
        await this.actions.refresh();
        return;
      }
      const summary = result.reviewRequired && result.branch ? `Proposed for review as ${result.branch}. Review and approve it under Changes.`
        : `Wrote ${(result.written ?? []).length} file(s) to this repository. Review the diff and commit it.`;
      this.post({ type: 'studio.buildFinished', build: id, how: 'publish', summary });
      await this.buildRefresh(id);
      await this.load(true);
      await this.actions.refresh();
      if (result.reviewRequired && result.branch) {
        const choice = await showCompactInformationMessage(`The workflow is ready for review: ${result.branch}.`, 'Review and approve', 'Later');
        if (choice === 'Review and approve') await this.actions.reviewProposal(result.branch);
      }
    } catch (error) {
      this.output.appendLine(`  refused: ${(error as Error).message}`);
      this.buildFailed((error as Error).message);
    }
  }

  private async buildChat(raw: string | null): Promise<void> {
    const id = this.openBuildId(raw);
    if (!id) return;
    if (!this.modelAvailable()) return this.buildFailed('Copilot is off in this window. Add steps yourself, or turn model features on.');
    await vscode.commands.executeCommand('workbench.action.chat.open', { query: buildChatQuery(id, Boolean(this.build?.tool)), isPartialQuery: true });
    this.post({ type: 'studio.buildCancelled', status: 'Copilot Chat is open for this build. Its proposals appear here as it makes them; only you accept them.' });
  }

  /** Run a command that changes or opens a build, then show it and check it. A failure still redraws the build. */
  private async buildChange(command: () => Promise<StudioBuildView>, status: string | null, opening = false): Promise<void> {
    const watched = this.build;
    if (watched) watched.busy += 1;
    try {
      const view = await command();
      await this.buildShow(view, status, opening);
    } catch (error) {
      this.buildFailed((error as Error).message);
      if (this.build && !opening) await this.buildRefresh(this.build.id);
    } finally { if (watched) watched.busy -= 1; }
  }

  private async buildRefresh(id: string, onlyIfChanged = false): Promise<void> {
    try {
      const view = await this.client.run<StudioBuildView>(studioBuildArgs('status', id));
      if (this.build?.id !== id || (onlyIfChanged && view.build.updatedAt === this.build.updatedAt)) return;
      await this.buildShow(view, onlyIfChanged ? 'The build changed: Copilot recorded something new.' : null);
    } catch { /* the next action shows why */ }
  }

  /** Show a build at once, then its check. Opening another build moves the watch and the chat tool to it. */
  private async buildShow(view: StudioBuildView, status: string | null, opening = false): Promise<void> {
    const id = view.build.id;
    if (opening || this.build?.id !== id) this.buildWatch(id, view.proposalPath ?? null);
    const watched = this.build!;
    watched.updatedAt = view.build.updatedAt;
    this.post({ type: 'studio.build', build: id, view, checking: true, modelAvailable: this.modelAvailable(), ...(status ? { status } : {}) });
    const sequence = ++watched.checks;
    watched.busy += 1;
    try {
      const result = await this.client.run<{ build?: { updatedAt?: string } }>(studioBuildArgs('check', id));
      if (this.build !== watched || sequence !== watched.checks) return;
      if (result.build?.updatedAt) watched.updatedAt = result.build.updatedAt;
      this.post({ type: 'studio.buildChecked', build: id, result });
    } catch (error) {
      if (this.build === watched && sequence === watched.checks) this.post({ type: 'studio.buildChecked', build: id, error: (error as Error).message });
    } finally { watched.busy -= 1; }
  }

  /**
   * Watch the open build's record, so a proposal Copilot records (in chat, through the tool or the
   * workflow build commands) shows here without a click. Changes this panel makes are not redrawn twice.
   */
  private buildWatch(id: string, proposalPath: string | null): void {
    this.buildClose();
    const watched: OpenBuild = { id, updatedAt: null, watcher: null, timer: null, busy: 0, checks: 0, tool: null };
    this.build = watched;
    if (proposalPath) {
      try {
        watched.watcher = watch(path.dirname(proposalPath), (_event, file) => {
          if (file && String(file) !== 'build.json') return;
          if (watched.timer) clearTimeout(watched.timer);
          watched.timer = setTimeout(() => { watched.timer = null; if (this.build === watched && !watched.busy) void this.buildRefresh(id, true); }, 400);
        });
        watched.watcher.on('error', () => undefined);
      } catch { watched.watcher = null; }
    }
    if (this.modelAvailable()) {
      try {
        const runtime = require(path.join(__dirname, 'workflow-intent-runtime.cjs')) as typeof import('../workflow-intent-runtime.ts');
        const attached = runtime.attachWorkflowBuilderTool(id, {
          run: (args) => this.client.run(args),
          runWithInput: (args, input) => this.client.runWithInput(args, input),
          model: () => this.model as StudioModelLike | null,
          recorded: (view, status) => { if (this.build === watched) void this.buildShow(view as StudioBuildView, status); }
        });
        watched.tool = attached.available ? attached : null;
      } catch { watched.tool = null; }
    }
  }

  private buildClose(): void {
    const watched = this.build;
    if (!watched) return;
    this.build = null;
    watched.watcher?.close();
    if (watched.timer) clearTimeout(watched.timer);
    watched.tool?.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.buildClose();
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    if (WorkflowStudioPanel.current === this) WorkflowStudioPanel.current = null;
  }
}
