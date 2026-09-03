/**
 * Mapping a git repository to a capability.
 *
 * This screen was "Govern a repository", which had the relationship backwards. What a person is
 * doing here is describing what their organisation builds and saying which repository each part
 * ships from — a capability is the subject, and a repository is one of its properties. Governing a
 * repository is what the platform does about it, not what the person is doing.
 *
 * So there is no folder to choose: nothing is checked out here. The map lives in the lead
 * repository, and the platform borrows it for the length of the edit. Cloning is a workspace's job,
 * and a workspace is made for doing work rather than for describing what exists. There is no state
 * branch either — it is `state`, and it is created when a workspace is initialised.
 */
import { CAPABILITY_KINDS } from './capability-model.ts';
import { escape, icon } from './webview.ts';
import { startWizardProgress, type StartWizardProgress } from './start-wizard.ts';

/** A capability already in the map, offered as a parent. */
export interface ParentChoice { id: string; name: string; depth: number; ships: boolean }

export type RepositoryInspectionStatus =
  | 'idle' | 'checking' | 'not-onboarded' | 'known-repository-unassigned'
  | 'already-mapped' | 'ambiguous' | 'unreachable' | 'inconclusive';

export interface RepositoryInspectionMatch {
  lead?: string;
  repositoryId?: string;
  repositoryUrl?: string;
  capabilities?: string[];
  governed?: boolean;
  sourceBranch?: string | null;
  sourceCommit?: string | null;
  cached?: boolean;
  stale?: boolean;
}

export interface RepositoryInspectionPendingMatch {
  lead?: string;
  repositoryId?: string;
  repositoryUrl?: string;
  capabilities?: string[];
  capabilityMetadataComplete?: boolean;
  proposalBranch?: string;
  proposalCommit?: string;
  proposalStatus?: string;
  proposalValid?: boolean;
}

/** The same closed structural vocabulary used by the engine and schema. */
export { CAPABILITY_KINDS };

export interface MapCapabilityForm {
  lead: string;
  leads: string[];
  capabilityId: string;
  name: string;
  kind: string;
  parent: string;
  parents: ParentChoice[];
  repositoryUrl: string;
  inspectionStatus: RepositoryInspectionStatus;
  inspectionMatches: RepositoryInspectionMatch[];
  inspectionPendingMatches: RepositoryInspectionPendingMatch[];
  inspectionMessage: string | null;
  inspectionFailures: string[];
  inspectionCompleteness: string | null;
  inspectionAuthorityScope: string | null;
  inspectionProposalCoverage: string | null;
  inspectionProposalTotal: number;
  inspectionProposalInspected: number;
  inspectionLeadUrl: string;
  inspectionCheckedLeadCount: number;
  /** Exact repository and authority pair proven by the last successful inspection. */
  inspectionBoundRepositoryUrl: string | null;
  inspectionBoundLeadUrl: string | null;
  inspectionComplete: boolean;
  collectionWithoutRepository: boolean;
  sourceRoots: string;
  sharedRoots: string;
  cloneMode: 'full' | 'blobless' | 'blobless-sparse';
  sparseCone: string;
  cloneFallback: 'refuse' | 'full';
  metadata: Array<{ key: string; value: string }>;
  jiraProject: string;
  teams: string;
  /** Null until the lead has been read; the map is what the parent list is made of. */
  loaded: boolean;
  busy: boolean;
  notice: string | null;
  error: string | null;
}

export const EMPTY_MAP_FORM: MapCapabilityForm = {
  lead: '', leads: [], capabilityId: '', name: '', kind: 'delivery',
  parent: '', parents: [], repositoryUrl: '', sourceRoots: '', sharedRoots: '',
  inspectionStatus: 'idle', inspectionMatches: [], inspectionPendingMatches: [], inspectionMessage: null,
  inspectionFailures: [],
  inspectionCompleteness: null, inspectionAuthorityScope: null, inspectionCheckedLeadCount: 0,
  inspectionProposalCoverage: null,
  inspectionProposalTotal: 0, inspectionProposalInspected: 0,
  inspectionLeadUrl: '',
  inspectionBoundRepositoryUrl: null, inspectionBoundLeadUrl: null,
  inspectionComplete: false, collectionWithoutRepository: false,
  cloneMode: 'full', sparseCone: '', cloneFallback: 'refuse', metadata: [], jiraProject: '', teams: '',
  loaded: false, busy: false, notice: null, error: null
};

/**
 * Reject a remote before the extension can place it in a logged CLI argument vector.
 *
 * The engine repeats this validation at its trust boundary. The webview needs the same guard one
 * layer earlier because extension command logging happens before the engine sees the arguments.
 * Only a display-safe URL is included in the message; user-info, query parameters, and fragments
 * can therefore never be reflected into the panel or output channel.
 */
export function gitRemoteProblem(value: string, label = 'Repository'): string | null {
  const remote = value.trim();
  if (!remote) return null;
  let rejected = /[\0\r\n]/.test(remote) || remote.startsWith('-')
    || /^[a-z][a-z0-9+.-]*::/i.test(remote)
    // Keep the guard fail-closed even when URL parsing rejects malformed percent escapes or host
    // syntax. An HTTP user-info prefix or ephemeral suffix must still never reach command logging.
    || /^https?:\/\/[^/\s@]+@/i.test(remote)
    || (/^https?:\/\//i.test(remote) && /[?#]/.test(remote));
  let safe = '';
  try {
    const parsed = new URL(remote);
    rejected ||= Boolean(parsed.password)
      || (['http:', 'https:'].includes(parsed.protocol) && Boolean(parsed.username))
      || (['http:', 'https:'].includes(parsed.protocol) && Boolean(parsed.search || parsed.hash));
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    safe = parsed.toString();
  } catch {
    // Local paths and SCP-like SSH remotes are valid Git identities. Their diagnostic form drops
    // query/fragment-shaped suffixes, and unsafe control/option/helper forms stay fully redacted.
    safe = rejected ? '' : remote.replace(/[?#].*$/, '');
  }
  if (!rejected) return null;
  const displayed = safe && !/[\0\r\n]/.test(safe) && !safe.startsWith('-') ? ` '${safe}'` : '';
  return `${label}${displayed} was rejected. Use a credential-free Git URL and configure authentication through Git or the operating system; embedded credentials, query parameters, and fragments are not accepted.`;
}

export function capabilityIdentifierProblem(form: MapCapabilityForm): string | null {
  const id = form.capabilityId.trim();
  if (!id) return 'Give the capability an identifier.';
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    return 'The identifier must be lower-case kebab-case, like payments-api.';
  }
  if (form.parents.some((parent) => parent.id === id)) return `'${id}' is already in this map.`;
  return null;
}

export function mapProblems(form: MapCapabilityForm): string[] {
  const problems: string[] = [];
  if (!form.collectionWithoutRepository && !form.repositoryUrl.trim()) {
    problems.push('Enter the Git repository URL and check it first.');
  } else if (!form.collectionWithoutRepository && gitRemoteProblem(form.repositoryUrl, 'Repository')) {
    problems.push(gitRemoteProblem(form.repositoryUrl, 'Repository') as string);
  } else if (!form.collectionWithoutRepository && !form.inspectionComplete) {
    const message = form.inspectionStatus === 'checking'
      ? 'The repository is being checked.'
      : form.inspectionStatus === 'already-mapped'
        ? 'This repository is already mapped. Choose whether to map another capability using it.'
        : form.inspectionStatus === 'ambiguous'
          ? 'Resolve which capability map owns this repository before continuing.'
          : form.inspectionStatus === 'unreachable'
            ? 'The repository could not be reached. Correct access and check it again.'
            : form.inspectionStatus === 'inconclusive'
              ? 'Repository ownership could not be determined safely. Check it again after resolving the reported failures.'
              : 'Check the repository before describing a capability.';
    problems.push(message);
  }
  if (problems.length) return problems;
  if (!form.lead.trim()) problems.push('Choose which repository stores the capability map.');
  else if (gitRemoteProblem(form.lead, 'Capability-map repository')) {
    problems.push(gitRemoteProblem(form.lead, 'Capability-map repository') as string);
  } else if (!form.collectionWithoutRepository
    && (form.inspectionBoundRepositoryUrl !== form.repositoryUrl.trim()
      || form.inspectionBoundLeadUrl !== form.lead.trim())) {
    problems.push('The selected capability-map repository has not been checked for this Git repository. Check that authority again before continuing.');
  }
  else if (!form.loaded) problems.push(form.busy
    ? 'The selected capability map is loading.'
    : 'Select the capability-map repository again so its current map can be loaded.');
  const identifierProblem = capabilityIdentifierProblem(form);
  if (identifierProblem) problems.push(identifierProblem);
  if (!CAPABILITY_KINDS.includes(form.kind as typeof CAPABILITY_KINDS[number])) {
    problems.push('Kind must be Collection or Delivery.');
  }
  if (form.kind === 'delivery' && !form.repositoryUrl.trim()) {
    problems.push('Select or enter the repository this Delivery capability ships from.');
  }
  if (form.kind === 'collection' && form.repositoryUrl.trim()) {
    problems.push('A Collection cannot name a repository. Choose Delivery or clear the clone URL.');
  }
  const paths = [...form.sourceRoots.split(','), ...form.sharedRoots.split(','), ...form.sparseCone.split(',')]
    .map((entry) => entry.trim()).filter(Boolean);
  for (const entry of paths) {
    if (entry === '.' || entry.includes('\\') || /^(?:\/|[A-Za-z]:[\\/])/.test(entry)
      || entry.split(/[\\/]+/).includes('..') || /[*?\[\]{}]/.test(entry)) {
      problems.push(`'${entry}' must be a repository-relative directory without '..' or glob characters.`);
    }
  }
  if (form.cloneMode === 'blobless-sparse' && !form.sparseCone.split(',').some((entry) => entry.trim())) {
    problems.push('Blobless sparse cloning requires at least one sparse checkout directory.');
  }
  for (const [index, entry] of form.metadata.entries()) {
    if (!entry.key.trim() && !entry.value.trim()) continue;
    if (!entry.key.trim() || !entry.value.trim()) {
      problems.push(`Metadata row ${index + 1} requires both a key and a value.`);
    }
  }
  return problems;
}

export function mapCommand(form: MapCapabilityForm): string[] {
  const args = ['capability', 'map', form.capabilityId.trim(),
    '--lead', form.lead.trim(), '--kind', form.kind, '--json'];
  if (form.name.trim()) args.push('--name', form.name.trim());
  if (form.parent) args.push('--parent', form.parent);
  if (form.repositoryUrl.trim()) args.push('--repository', form.repositoryUrl.trim());
  if (form.sourceRoots.trim()) args.push('--source-roots', form.sourceRoots.trim());
  if (form.sharedRoots.trim()) args.push('--shared-roots', form.sharedRoots.trim());
  if (form.cloneMode !== 'full') {
    args.push('--clone-mode', form.cloneMode, '--clone-fallback', form.cloneFallback);
    if (form.sparseCone.trim()) args.push('--sparse-cone', form.sparseCone.trim());
  }
  for (const entry of form.metadata) {
    if (entry.key.trim() && entry.value.trim()) args.push('--metadata', `${entry.key.trim()}=${entry.value.trim()}`);
  }
  if (form.jiraProject.trim()) args.push('--jira-project', form.jiraProject.trim());
  if (form.teams.trim()) args.push('--teams', form.teams.trim());
  return args;
}

export function mapCapabilityHtml(form: MapCapabilityForm, journey: StartWizardProgress | null = null): string {
  const problems = mapProblems(form);
  const detailsVisible = form.collectionWithoutRepository || form.inspectionComplete;
  const identifierProblem = detailsVisible ? capabilityIdentifierProblem(form) : null;
  const staticProblems = problems.filter((problem) => problem !== identifierProblem);
  const parents = form.parents;
  const repository = form.repositoryUrl.trim();
  const lead = form.lead.trim();
  const usesShippingRepository = Boolean(repository && repository === lead);
  const knownLeadSelected = form.leads.includes(lead);
  const inspectionMatches = form.inspectionMatches.map((match) => {
    const capabilities = match.capabilities?.length ? match.capabilities.join(', ') : 'no assigned capability';
    const stale = match.stale ? ' (validated cached result)' : '';
    return `<li>${escape(`${capabilities} in ${match.lead ?? 'an existing capability map'}${stale}`)}</li>`;
  }).join('');
  const ambiguousInspectionMatches = form.inspectionMatches.map((match) => {
    const capabilities = match.capabilities?.length ? match.capabilities.join(', ') : 'no assigned capability';
    const stale = match.stale ? ' (validated cached result)' : '';
    const lead = match.lead?.trim() ?? '';
    return `<li>${escape(`${capabilities} in ${lead || 'an existing capability map'}${stale}`)}${lead
      ? ` <button type="button" class="secondary" data-map-inspect-authority="${escape(lead)}">Check this capability map</button>`
      : ''}</li>`;
  }).join('');
  const pendingInspectionMatches = form.inspectionPendingMatches.map((match) => {
    const capabilities = match.capabilities?.length
      ? ` for ${match.capabilities.join(', ')}` : '';
    const branch = match.proposalBranch ?? 'an unmerged capability proposal';
    const lead = match.lead ? ` in ${match.lead}` : '';
    return `<li><code>${escape(branch)}</code>${escape(`${capabilities}${lead}`)}</li>`;
  }).join('');
  const proposalScope = form.inspectionProposalCoverage === 'complete'
    ? ` Pending review coverage is complete (${form.inspectionProposalInspected}/${form.inspectionProposalTotal} inspected).`
    : form.inspectionProposalCoverage === 'partial'
      ? ` Pending review coverage is incomplete (${form.inspectionProposalInspected}/${form.inspectionProposalTotal} inspected); no new mapping is permitted.`
      : form.inspectionProposalCoverage === 'not-checked'
        ? ' Pending review proposals could not be checked; no new mapping is permitted.'
        : form.inspectionProposalCoverage === 'approved-only'
          ? ' This older engine checked approved maps only; pending review proposals are not included.'
          : '';
  const inspectionScope = form.inspectionStatus !== 'idle' && form.inspectionStatus !== 'checking'
    ? `<p class="muted">Checked ${form.inspectionCheckedLeadCount} capability-map ${form.inspectionCheckedLeadCount === 1 ? 'authority' : 'authorities'} (${escape(form.inspectionCompleteness ?? 'unknown completeness')}, ${escape(form.inspectionAuthorityScope ?? 'unknown scope')}).${escape(proposalScope)}</p>`
    : '';
  const inspectionResult = form.inspectionStatus === 'checking'
    ? `<p class="muted">${icon('waiting')}Checking repository ownership and onboarding…</p>`
    : form.inspectionStatus === 'not-onboarded'
      ? `<p class="ok-text">${icon('ok')}This repository was not found in the capability maps checked. Describe its first capability below.</p>`
      : form.inspectionStatus === 'known-repository-unassigned'
        ? `<p class="ok-text">${icon('ok')}This repository is known, but is not assigned to a capability yet.</p>`
        : form.inspectionStatus === 'already-mapped'
          ? `<div class="warning-text">${icon('warning')}This repository is already onboarded.${inspectionMatches ? `<ul>${inspectionMatches}</ul>` : ''}
              ${form.inspectionCompleteness === 'complete'
                ? '<button type="button" class="secondary" data-map-reuse>Map another capability using this repository</button>'
                : '<p>One or more capability-map authorities were not current. Restore access and check again before changing this mapping.</p>'}</div>`
          : form.inspectionStatus === 'ambiguous'
              ? `<div class="warning-text">${icon('warning')}This repository appears in more than one capability map. Check the intended authority explicitly before continuing.${ambiguousInspectionMatches ? `<ul>${ambiguousInspectionMatches}</ul>` : ''}</div>`
              : form.inspectionStatus === 'unreachable' || form.inspectionStatus === 'inconclusive'
                ? `<div class="blockers">${escape(form.inspectionMessage ?? (form.inspectionStatus === 'unreachable'
                  ? 'The repository could not be reached. Correct access and try again.'
                  : form.inspectionPendingMatches.length
                    ? 'This repository is already present in a capability proposal awaiting review. Review or activate that proposal instead of creating a duplicate.'
                  : form.inspectionCompleteness === 'no-authorities'
                    ? 'No approved capability-map authority is registered on this laptop.'
                    : 'Repository ownership could not be determined safely.'))}${form.inspectionFailures.length
                    ? `<ul>${form.inspectionFailures.map((failure) => `<li>${escape(failure)}</li>`).join('')}</ul>` : ''}
                    ${pendingInspectionMatches ? `<ul>${pendingInspectionMatches}</ul>` : ''}
                    ${form.inspectionStatus === 'inconclusive' && form.inspectionCompleteness === 'no-authorities'
                      ? `<div class="form-grid">
                          <label class="field full"><span>Existing capability-map Git URL</span>
                            <input type="text" value="${escape(form.inspectionLeadUrl)}" data-map="inspectionLeadUrl" placeholder="https://git.example.corp/acme/platform.git">
                            <small>Use this when another repository already owns the organisation map.</small></label>
                        </div>
                        <p><button type="button" class="secondary" data-map-inspect-lead${form.inspectionLeadUrl.trim() ? '' : ' disabled'}>Check existing capability map</button>
                          ${form.inspectionProposalCoverage === 'complete'
                            ? '<button type="button" class="secondary" data-map-first-authority>Use this repository as the first capability map</button>'
                            : ''}</p>` : ''}</div>`
                : '';
  const mapStatus = form.busy && !form.loaded
    ? `<p class="muted">${icon('waiting')}Loading the selected capability map…</p>`
    : form.loaded
      ? `<p class="ok-text">${icon('ok')}${form.parents.length} ${form.parents.length === 1 ? 'capability' : 'capabilities'} available as parents.</p>`
      : '<p class="muted">Choose a repository below. Its current map is loaded automatically.</p>';
  return `
  ${startWizardProgress(journey)}
  <header>
    <h1>${icon('capability', { size: 20 })}Map a capability</h1>
    <p class="meta">What this organisation builds, and which repository each part ships from.
      Repository choices are made together below; no separate setup step is required.</p>
  </header>

  <section>
    <h2>${icon('git')}Git repository</h2>
    <p class="muted">Start with the repository so Flow can tell whether it is already onboarded before another capability is proposed.</p>
    <label class="field full"><span>Clone URL</span><input type="text" value="${escape(form.repositoryUrl)}" data-map="repositoryUrl"
      ${form.collectionWithoutRepository ? 'disabled' : ''} placeholder="https://git.example.corp/acme/payments-api.git"></label>
    <p>
      <button type="button" data-map-inspect ${!form.repositoryUrl.trim() || form.inspectionStatus === 'checking' || form.collectionWithoutRepository ? 'disabled' : ''}>
        ${form.inspectionStatus === 'checking' ? 'Checking…' : 'Check repository'}
      </button>
      <button type="button" class="secondary" data-map-collection>${form.collectionWithoutRepository ? 'Use a repository instead' : 'Map a collection without a repository'}</button>
    </p>
    ${inspectionResult}${inspectionScope}
  </section>

  <div data-map-details${detailsVisible ? '' : ' hidden'}>

  <section>
    <h2>${icon('capability')}The capability</h2>
    <div class="form-grid">
      <label class="field"><span>Identifier</span><input type="text" value="${escape(form.capabilityId)}" data-map="capabilityId"
        data-existing-capability-ids="${escape(form.parents.map((parent) => parent.id).join(','))}"
        placeholder="payments-api"><small>Permanent, lower-case kebab-case.</small></label>
      <label class="field"><span>Display name</span><input type="text" value="${escape(form.name)}" data-map="name"
        placeholder="Payments API"></label>
      <label class="field"><span>Kind</span><select data-map="kind">
        ${CAPABILITY_KINDS.map((kind) => `<option value="${escape(kind)}"${kind === form.kind ? ' selected' : ''}>${kind === 'collection' ? 'Collection' : 'Delivery'}</option>`).join('')}
      </select><small>Collection groups related capabilities; Delivery ships from repositories.</small></label>
      <label class="field"><span>Linked under</span><select data-map="parent"${form.loaded ? '' : ' disabled'}>
        <option value=""${form.parent ? '' : ' selected'}>Top level (no parent)</option>
        ${parents.map((parent) => `<option value="${escape(parent.id)}"${parent.id === form.parent ? ' selected' : ''}>${'&nbsp;&nbsp;'.repeat(parent.depth)}${escape(parent.name)}</option>`).join('')}
      </select><small>Leave this top-level or choose a parent. You can change this relationship later.</small></label>
    </div>
  </section>

  <section>
    <div class="card-head">
      <div><h2>${icon('configuration')}Additional metadata</h2>
        <p class="muted">Organisation-specific key/value pairs such as application ID, cost centre, owner code, or service tier.</p></div>
      <span class="grow"></span>
      <button type="button" class="secondary" data-map-metadata-add>Add key/value pair</button>
    </div>
    <div class="metadata-list">${form.metadata.length ? form.metadata.map((entry, index) => `
      <div class="metadata-row" data-map-metadata-index="${index}">
        <label class="field"><span>Key</span><input type="text" data-map-metadata-field="key" value="${escape(entry.key)}" placeholder="applicationId"></label>
        <label class="field"><span>Value</span><input type="text" data-map-metadata-field="value" value="${escape(entry.value)}" placeholder="APP-1001"></label>
        <button type="button" class="icon-button danger" data-map-metadata-remove="${index}" title="Remove metadata" aria-label="Remove metadata pair">${icon('remove')}</button>
      </div>`).join('') : '<p class="muted">No additional metadata yet.</p>'}</div>
    <p class="remedy">Stored in <code>singularity/capabilities.yml</code> in the lead repository.
      The proposal uses a capability review branch and never writes to the application main branch.</p>
  </section>

  <section>
    <h2>${icon('git')}Repository it ships from</h2>
    ${form.kind === 'delivery' ? `<div class="form-grid">
      <p class="muted full">Repository checked: <code>${escape(form.repositoryUrl)}</code></p>
      <label class="field"><span>Clone strategy</span><select data-map="cloneMode">
        <option value="full"${form.cloneMode === 'full' ? ' selected' : ''}>Full clone</option>
        <option value="blobless"${form.cloneMode === 'blobless' ? ' selected' : ''}>Blobless partial clone</option>
        <option value="blobless-sparse"${form.cloneMode === 'blobless-sparse' ? ' selected' : ''}>Blobless + sparse checkout</option>
      </select><small>Large monorepos should use blobless sparse after selecting the directories below.</small></label>
      <label class="field"><span>Unsupported-server fallback</span><select data-map="cloneFallback">
        <option value="refuse"${form.cloneFallback === 'refuse' ? ' selected' : ''}>Refuse — never silently download everything</option>
        <option value="full"${form.cloneFallback === 'full' ? ' selected' : ''}>Allow an explicit full clone</option>
      </select></label>
      <label class="field full"><span>Sparse checkout directories</span><input type="text" value="${escape(form.sparseCone)}" data-map="sparseCone" placeholder="apps/payments, libs/contracts, singularity"><small>Comma-separated cone-mode directories. Required only for blobless + sparse.</small></label>
      <label class="field full"><span>World-model application roots</span><input type="text" value="${escape(form.sourceRoots)}" data-map="sourceRoots" placeholder="apps/payments"><small>Leave empty for the whole repository.</small></label>
      <label class="field full"><span>World-model shared roots</span><input type="text" value="${escape(form.sharedRoots)}" data-map="sharedRoots" placeholder="libs/contracts, libs/platform"></label>
    </div>` : '<p class="muted">A Collection groups capabilities and does not ship from a repository. To map code, choose Delivery above; the Git clone URL field will appear here.</p>'}

    <div class="editor-card">
      <p class="eyebrow">Capability map</p>
      <h3>${icon('repository')}Where this capability is recorded</h3>
      ${form.leads.length > 1 ? `<label class="field"><span>Repository</span><select data-map="lead">
        <option value=""${knownLeadSelected || usesShippingRepository ? '' : ' selected'}>Choose a repository…</option>
        ${form.leads.map((choice) => `<option value="${escape(choice)}"${choice === lead ? ' selected' : ''}>${escape(choice)}</option>`).join('')}
        ${usesShippingRepository && !knownLeadSelected
    ? `<option value="${escape(lead)}" selected>${escape(lead)} (shipping repository)</option>` : ''}
      </select><small>More than one capability map is available, so choose the one this belongs to.</small></label>` : ''}
      ${form.leads.length === 1 ? `<label class="choice${knownLeadSelected ? ' chosen' : ''}">
        <input type="radio" name="capability-map-repository" value="${escape(form.leads[0])}" data-map="lead"${knownLeadSelected ? ' checked' : ''}
          aria-label="Only available capability-map repository">
        <span class="choice-label">${icon('repository')}${escape(form.leads[0])}</span>
        <span class="choice-detail">${knownLeadSelected
    ? 'Selected automatically because it is the only available capability map.'
    : 'Use the existing capability map instead of the shipping repository.'}</span>
      </label>` : ''}
      ${!form.leads.length && form.kind === 'collection' ? `<label class="field full"><span>Repository</span>
        <input type="text" value="${escape(form.lead)}" data-map="lead" placeholder="https://git.example.corp/acme/platform.git">
        <small>No capability-map repository is registered yet. Enter the repository that should hold it.</small></label>` : ''}
      ${form.kind === 'delivery' ? `<label class="choice${usesShippingRepository ? ' chosen' : ''}">
        <input type="checkbox" data-use-shipping-repository${usesShippingRepository ? ' checked' : ''}${repository ? '' : ' disabled'}>
        <span class="choice-label">Use this repository for the capability map</span>
        <span class="choice-detail">${repository
    ? 'Record the capability map in the same repository entered above.'
    : 'Enter the shipping repository first to make this option available.'}</span>
      </label>` : ''}
      ${!lead && form.leads.length > 1
    ? `<p class="warning-text">${icon('warning')}Choose one of the available capability-map repositories.</p>`
    : !lead && form.kind === 'delivery'
      ? `<p class="warning-text">${icon('warning')}No capability-map repository is selected. Enter the shipping repository and keep the checkbox selected, or choose an existing map.</p>`
      : ''}
      ${mapStatus}
    </div>
  </section>

  <section>
    <h2>${icon('tracker')}Tracking</h2>
    <p>
      <label>Jira <input type="text" value="${escape(form.jiraProject)}" data-map="jiraProject" size="12"
        placeholder="PAY"></label>
      <label>Teams <input type="text" value="${escape(form.teams)}" data-map="teams" size="36"
        placeholder="comma separated"></label>
    </p>
    <p class="muted">Both belong to the capability rather than to a workspace: they stay true
      regardless of who has cloned what.</p>
  </section>
  </div>

  <section>
    <div data-map-blocked${problems.length ? '' : ' hidden'}>
      <h2>${icon('bad')}Before this can be mapped</h2>
      <ul class="blockers">
        <li data-map-identifier-problem${identifierProblem ? '' : ' hidden'}>${escape(identifierProblem ?? '')}</li>
        ${staticProblems.map((problem) => `<li data-map-static-problem>${escape(problem)}</li>`).join('')}
      </ul>
    </div>
    <div data-map-ready${problems.length ? ' hidden' : ''}>
      <h2>${icon('ok')}Ready for review</h2>
      <p class="ok-text">Creates and pushes a dedicated capability review branch in ${escape(form.lead)}.</p>
      <p class="muted">The proposal targets the dedicated <code>sflow/config</code> authority branch.
        Application branches and the capability state projection are not changed. Review and merge the proposal,
        then publish the reviewed projection.</p>
    </div>
    ${form.notice ? `<p class="warning-text">${icon('warning')}${escape(form.notice)}</p>` : ''}
    ${form.error ? `<p class="blockers">${escape(form.error)}</p>` : ''}
    <p>
      <button data-map-submit="1" data-map-busy="${form.busy ? 'true' : 'false'}" ${problems.length || form.busy ? 'disabled' : ''}>
        ${form.busy && form.loaded ? 'Creating proposal…' : 'Create review proposal'}
      </button>
    </p>
  </section>`;
}

export const MAP_CAPABILITY_SCRIPT = `
  const vscode = window.__sfVscode;
  document.addEventListener('click', (event) => {
    const inspect = event.target.closest('[data-map-inspect]');
    if (inspect) return vscode.postMessage({ type: 'inspectRepository' });
    const collection = event.target.closest('[data-map-collection]');
    if (collection) return vscode.postMessage({ type: 'toggleCollectionWithoutRepository' });
    const reuse = event.target.closest('[data-map-reuse]');
    if (reuse) return vscode.postMessage({ type: 'reuseRepository' });
    const firstAuthority = event.target.closest('[data-map-first-authority]');
    if (firstAuthority) return vscode.postMessage({ type: 'useFirstAuthority' });
    const inspectLead = event.target.closest('[data-map-inspect-lead]');
    if (inspectLead) return vscode.postMessage({ type: 'inspectSelectedLead' });
    const inspectAuthority = event.target.closest('[data-map-inspect-authority]');
    if (inspectAuthority) return vscode.postMessage({ type: 'inspectAuthority', value: inspectAuthority.dataset.mapInspectAuthority });
    const addMetadata = event.target.closest('[data-map-metadata-add]');
    if (addMetadata) return vscode.postMessage({ type: 'metadataAdd' });
    const removeMetadata = event.target.closest('[data-map-metadata-remove]');
    if (removeMetadata) return vscode.postMessage({ type: 'metadataRemove', index: Number(removeMetadata.dataset.mapMetadataRemove) });
    const target = event.target.closest('[data-map-submit]');
    if (!target) return;
    vscode.postMessage({ type: 'map' });
  });
  const report = (event) => {
    const field = event.target.dataset?.map;
    if (!field) return;
    vscode.postMessage({ type: 'field', field, value: event.target.value });
  };
  // Typed values are reported without re-rendering, so the caret stays put; selecting a lead or a
  // parent is a data change the panel does redraw for.
  const syncIdentifierValidation = (input) => {
    const value = input.value.trim();
    const existing = (input.dataset.existingCapabilityIds || '').split(',').filter(Boolean);
    const problem = !value
      ? 'Give the capability an identifier.'
      : !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
        ? 'The identifier must be lower-case kebab-case, like payments-api.'
        : existing.includes(value)
          ? "'" + value + "' is already in this map."
          : '';
    const identifierProblem = document.querySelector('[data-map-identifier-problem]');
    const blocked = document.querySelector('[data-map-blocked]');
    const ready = document.querySelector('[data-map-ready]');
    const submit = document.querySelector('[data-map-submit]');
    if (!identifierProblem || !blocked || !ready || !submit) return;
    identifierProblem.textContent = problem;
    identifierProblem.hidden = !problem;
    const hasStaticProblems = Boolean(document.querySelector('[data-map-static-problem]'));
    const hasProblems = Boolean(problem) || hasStaticProblems;
    blocked.hidden = !hasProblems;
    ready.hidden = hasProblems;
    submit.disabled = hasProblems || submit.dataset.mapBusy === 'true';
  };
  document.addEventListener('input', (event) => {
    const row = event.target.closest('[data-map-metadata-index]');
    const metadataField = event.target.dataset?.mapMetadataField;
    if (row && metadataField) {
      vscode.postMessage({ type: 'metadataField', index: Number(row.dataset.mapMetadataIndex), field: metadataField, value: event.target.value });
    }
    report(event);
    if (event.target.dataset?.map === 'capabilityId') syncIdentifierValidation(event.target);
  });
  document.addEventListener('change', (event) => {
    report(event);
    const field = event.target.dataset?.map;
    if (field === 'lead') {
      vscode.postMessage({ type: 'selectLead', value: event.target.value });
    } else if (field === 'repositoryUrl') {
      vscode.postMessage({ type: 'repositoryCommitted', value: event.target.value });
    } else if (field === 'parent' || field === 'kind' || field === 'cloneMode' || field === 'inspectionLeadUrl') {
      vscode.postMessage({ type: 'redraw' });
    }
    if (event.target.matches('[data-use-shipping-repository]')) {
      vscode.postMessage({ type: 'useShippingRepository', checked: event.target.checked });
    }
  });
`;
