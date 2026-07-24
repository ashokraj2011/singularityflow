import React, { useEffect, useMemo, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import YAML from 'yaml';
import helpMarkdown from '../../../HELP.md?raw';
import {
  addWorldModelView,
  addPhaseToWorkType,
  createPersona,
  createPhase,
  createWorkType,
  deleteUnusedPhase,
  personaPromptRepositoryPath,
  removePhaseFromWorkType,
  removePersona,
  removeWorkType,
  removeWorldModelView,
  repositorySkillPath,
  setWorkTypeInputs,
  templateRepositoryPath
} from './workflow-designer.mjs';
import {
  extractCopilotQuestions,
  parseStoryPlan,
  planningLogEntry
} from './planning-ui.mjs';
import {
  addPortfolioRepository,
  repositoryMetadataFromForm
} from './portfolio-designer.mjs';
import {
  ARTIFACT_SECTION_LIBRARY,
  addArtifactSection,
  moveArtifactSection,
  parseArtifactTemplate,
  removeArtifactSection,
  serializeArtifactTemplate,
  updateArtifactSection
} from './artifact-builder.mjs';
import { workspaceLandingPage } from './workspace-routing.mjs';
import {
  GovernedMedia,
  MediaLightbox,
  PinnedMediaStrip,
  VisualComparisonReview
} from './VisualReview.jsx';

const engineerNavSections = [
  {
    label: 'Delivery',
    items: [
      ['dashboard', 'Overview'],
      ['impact', 'Impact analysis']
    ]
  },
  {
    label: 'Decisions',
    items: [
      ['inbox', 'Approval inbox'],
      ['review', 'Review bundle']
    ]
  },
  {
    label: 'Advanced',
    items: [
      ['workspaces', 'Workspace configuration']
    ]
  },
  {
    label: 'Configuration',
    items: [
      ['workflow', 'Workflow designer'],
      ['personas', 'Personas & approvals'],
      ['resources', 'Prompts & skills'],
      ['world-model', 'Repository model'],
      ['agents', 'Remote agents']
    ]
  },
  {
    label: 'Learn',
    items: [['help', 'Help & guides']]
  }
];

const businessNavSections = [
  {
    label: 'Epic planning',
    items: [
      ['epics', 'Epics'],
      ['business-requirements', 'Requirements'],
      ['business-planning', 'Planning'],
      ['templates', 'Artifact templates'],
      ['business-stories', 'Create Stories']
    ]
  },
  {
    label: 'Decisions',
    items: [['inbox', 'Reviews']]
  },
  {
    label: 'Learn',
    items: [['help', 'Help']]
  }
];

const businessAuxiliaryNavigation = [
  { id: 'planning', label: 'Planning Copilot', section: 'Epic planning' },
  { id: 'workspaces', label: 'Workspace setup', section: 'Project setup' }
];

const onboardingRoles = [
  ['product-owner', 'Product owner'],
  ['business-analyst', 'Business analyst'],
  ['product-designer', 'Product designer'],
  ['architect', 'Architect'],
  ['developer', 'Developer'],
  ['qa', 'Quality engineer'],
  ['security', 'Security / risk'],
  ['delivery-manager', 'Delivery manager'],
  ['operations', 'Operations / SRE'],
  ['other', 'Another role']
];

function preferredPersonaForRole(role, personas) {
  const aliases = {
    'business-analyst': ['product-owner', 'architect'],
    'delivery-manager': ['product-owner', 'architect'],
    operations: ['developer', 'architect'],
    security: ['architect', 'developer'],
    other: []
  };
  return [role, ...(aliases[role] ?? [])].find((candidate) => candidate && personas[candidate]) ?? Object.keys(personas)[0];
}

const navIconPaths = {
  dashboard: ['M4 4h6v6H4z M14 4h6v4h-6z M14 12h6v8h-6z M4 14h6v6H4z'],
  documents: ['M6 3h8l4 4v14H6z M14 3v5h5 M9 12h6 M9 16h6'],
  planning: ['M12 3l1.2 4.1L17 8.3l-3.8 1.2L12 14l-1.2-4.5L7 8.3l3.8-1.2z M18.5 15l.7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7z'],
  studio: ['M12 3l9 5-9 5-9-5z M5 12l7 4 7-4 M5 16l7 4 7-4'],
  impact: ['M12 5v5 M7 19H4v-4 M17 19h3v-4 M4 15l6-4 M20 15l-6-4 M9 3h6v4H9z M2 19h4v3H2z M18 19h4v3h-4z'],
  workspaces: ['M3 6h7l2 2h9v11H3z M7 3h5l2 2h7v3 M7 12h10 M7 16h6'],
  initiatives: ['M5 4h6v5H5z M13 15h6v5h-6z M8 9v3h8v3 M16 9v3'],
  jira: ['M5 3h14v18H5z M8 7h8 M8 11h8 M8 15h5 M18 17l2 2-2 2'],
  inbox: ['M4 5h16v14H4z M4 14h5l2 2h2l2-2h5'],
  review: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M8 12l2.5 2.5L16 9'],
  workflow: ['M5 4h5v4H5z M14 16h5v4h-5z M14 4h5v4h-5z M10 6h4 M8 8v10h6'],
  templates: ['M5 3h14v18H5z M9 7h6 M9 11h6 M9 15h4'],
  personas: ['M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M3 21v-2a6 6 0 0 1 12 0v2 M17 11a3 3 0 0 0 0-6 M18 21v-2a5 5 0 0 0-2-4'],
  resources: ['M5 4h14v16H5z M8 9l2 2-2 2 M12 15h4'],
  'world-model': ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M3 12h18 M12 3a14 14 0 0 1 0 18 M12 3a14 14 0 0 0 0 18'],
  agents: ['M7 8h10a3 3 0 0 1 3 3v7H4v-7a3 3 0 0 1 3-3z M9 13h.01 M15 13h.01 M9 17h6 M12 3v5 M9 3h6'],
  help: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M9.7 9a2.5 2.5 0 1 1 3.2 2.4c-.9.4-.9 1-.9 1.6 M12 17h.01'],
  epics: ['M5 4h14v16H5z M8 8h8 M8 12h8 M8 16h5'],
  collapse: ['M14 5l-7 7 7 7 M20 5v14'],
  expand: ['M10 5l7 7-7 7 M4 5v14'],
  refresh: ['M20 7v5h-5 M4 17v-5h5 M6.1 8A7 7 0 0 1 18 6l2 6 M17.9 16A7 7 0 0 1 6 18l-2-6'],
  download: ['M12 3v12 M7 10l5 5 5-5 M5 21h14'],
  validate: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M8 12l2.5 2.5L16 9'],
  publish: ['M4 20h16 M12 4v12 M7 9l5-5 5 5']
};

function NavIcon({ name }) {
  const aliases = {
    'business-requirements': 'documents',
    'business-planning': 'planning',
    'business-stories': 'epics'
  };
  const paths = navIconPaths[aliases[name] ?? name] ?? navIconPaths.dashboard;
  return <svg className="nav-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths.map((item) => <path d={item} key={item} />)}</svg>;
}

const sequenceGates = [
  ['completion', 'Completed workflow'],
  ['currentPhase', 'Non-current phase'],
  ['phaseStatus', 'Wrong phase status'],
  ['freshGeneration', 'Missing fresh generation'],
  ['generationCommit', 'Missing generation commit'],
  ['remoteGeneration', 'Generation not on remote'],
  ['publicationPending', 'Publication pending'],
  ['documentPhase', 'Document outside intake']
];

function Pill({ children, tone = 'neutral' }) { return <span className={`pill ${tone}`}>{children}</span>; }

function FlowBrand({ context = null, className = '', inverse = false }) {
  const classes = ['flow-brand', inverse ? 'inverse' : '', className].filter(Boolean).join(' ');
  return <div className={classes} aria-label={`Singularity Flow${context ? ` — ${context}` : ''}`}>
    <span className="flow-brand-mark" aria-hidden="true"><b>S</b><i /></span>
    <div className="flow-brand-copy">
      <small className="flow-brand-parent">Singularity</small>
      <strong className="flow-brand-product">Flow</strong>
      {context && <em className="flow-brand-context">{context}</em>}
    </div>
  </div>;
}

function Empty({ title, detail, action }) {
  return <div className="empty"><div className="empty-mark">S</div><h2>{title}</h2><p>{detail}</p>{action}</div>;
}

function RecentWorkspaces({ items, currentPath = null, busy, onOpen, onForget, compact = false }) {
  if (!items.length) return null;
  return <section className={`recent-workspaces recent-repositories ${compact ? 'compact' : ''}`}><header><div><span className="eyebrow">Isolated project contexts</span><h3>Recent workspaces</h3></div><span>{items.length} saved</span></header><div className="recent-repository-list">{items.map((workspace) => <div className={`recent-repository ${workspace.available ? '' : 'unavailable'} ${workspace.path === currentPath ? 'current' : ''}`} key={workspace.path}><button className="recent-repository-open" disabled={busy || !workspace.available} onClick={() => onOpen(workspace.path)}><span className="recent-repository-icon workspace-icon">W</span><span className="recent-repository-copy"><strong>{workspace.name}</strong><small title={workspace.path}>{workspace.path}</small><em>{workspace.available ? `${workspace.anchorType ?? 'Jira'} ${workspace.anchorKey ?? ''} · ${formatRecentTime(workspace.openedAt)}` : 'Workspace manifest is no longer available'}</em></span>{workspace.path === currentPath && <Pill tone="good">Open</Pill>}<span className="recent-repository-arrow">→</span></button><button className="recent-repository-forget" aria-label={`Forget ${workspace.name}`} title="Forget this local workspace; files are not deleted" onClick={(event) => onForget(event, workspace.path)}>×</button></div>)}</div></section>;
}

function WorkspaceSelector({ items, currentWorkspace = null, busy, onOpen }) {
  const currentPath = currentWorkspace?.path ?? '';
  const currentIsSaved = items.some((workspace) => workspace.path === currentPath);
  const choices = currentWorkspace && !currentIsSaved
    ? [{ path: currentPath, name: currentWorkspace.name, anchorKey: currentWorkspace.anchor?.key, available: true }, ...items]
    : items;
  function selectWorkspace(event) {
    const value = event.target.value;
    if (value === '__browse__') onOpen();
    else if (value && value !== currentPath) onOpen(value);
  }
  return <section className="workspace-quick-selector" aria-label="Workspace selection">
    <header><div><span className="eyebrow">Project context</span><h3>Current workspace</h3></div><span>{items.length} saved</span></header>
    <div className="workspace-quick-control">
      <span className="workspace-quick-icon">W</span>
      <label>
        <span>{currentWorkspace ? 'Active workspace' : 'No workspace selected'}</span>
        <select aria-label="Select current workspace" value={currentPath} onChange={selectWorkspace} disabled={busy}>
          {!currentWorkspace && <option value="">No workspace selected — choose one</option>}
          {choices.map((workspace) => <option value={workspace.path} disabled={!workspace.available} key={workspace.path}>{workspace.name}{workspace.anchorKey ? ` · ${workspace.anchorKey}` : ''}{workspace.available ? '' : ' · unavailable'}</option>)}
          <option value="__browse__">＋ Open or create workspace…</option>
        </select>
      </label>
      <button type="button" className="workspace-quick-browse" aria-label="Open or create workspace" title="Open or create workspace" onClick={() => onOpen()} disabled={busy}>＋</button>
    </div>
    <p>{currentWorkspace ? <><strong>{currentWorkspace.name}</strong><span title={currentPath}>{currentPath}</span></> : <>Choose a workspace to load its repositories, Jira routing, and complete project context.</>}</p>
  </section>;
}

function BusinessNavigation({
  page,
  data,
  repoName,
  repositoryMenu,
  setRepositoryMenu,
  recentWorkspaces,
  busy,
  openWorkspace,
  onNavigate,
  onEngineerMode
}) {
  const items = businessNavSections.flatMap((section) => section.items.map(([id, label]) => ({ id, label, section: section.label })));
  const activeId = page === 'planning' ? 'business-planning' : page;
  const workspaceName = data.workspace?.workspace.name ?? repoName;
  const workspaceContext = data.workspace?.workspace.anchor.key ?? data.selectedInitiativeId ?? data.repository.branch;
  return <header className="business-navigation">
    <FlowBrand className="business-brand flow-brand-business" context={workspaceContext} />
    <nav id="primary-navigation" aria-label="Epic planning navigation">
      {items.map(({ id, label, section }) => <button type="button" key={id} className={activeId === id ? 'active' : ''} aria-current={activeId === id ? 'page' : undefined} title={`${section}: ${label}`} onClick={() => onNavigate(id)}>
        <i><NavIcon name={id} /></i>
        <span>{label}</span>
        {id === 'inbox' && data.approvalInbox.count > 0 && <b>{data.approvalInbox.count}</b>}
      </button>)}
    </nav>
    <div className="business-navigation-tools">
      <button className="business-engineer-link" type="button" onClick={onEngineerMode} title="Open workflow engineering and configuration tools">Engineer tools</button>
      <div className="repo-switcher">
        <button className="business-project-switcher" type="button" title="Switch workspace" aria-label="Switch workspace" aria-expanded={repositoryMenu} aria-haspopup="dialog" onClick={() => setRepositoryMenu(!repositoryMenu)}>
          <span className="repo-icon">{workspaceName?.slice(0, 1).toUpperCase()}</span>
          <span><strong>{workspaceName}</strong><small>{data.workspace ? `${repoName} · lead repository` : 'No workspace selected'}</small></span>
          <i>⌄</i>
        </button>
        {repositoryMenu && <div className="repository-menu" role="dialog" aria-label="Switch workspace">
          <WorkspaceSelector items={recentWorkspaces} currentWorkspace={data.workspace?.workspace} busy={busy} onOpen={openWorkspace} />
        </div>}
      </div>
    </div>
  </header>;
}

function OnboardingWizard({ initial, jira, onComplete, onHelp }) {
  const [draft, setDraft] = useState(() => ({
    ...initial,
    step: initial.step ?? 0,
    repositories: initial.repositories ?? [],
    jiraChoice: jira?.connected ? 'connected' : (initial.jiraChoice ?? 'later')
  }));
  const [connection, setConnection] = useState({
    name: 'corporate-jira',
    deployment: 'cloud',
    baseUrl: jira?.connection?.baseUrl ?? '',
    email: jira?.connection?.email ?? '',
    token: '',
    authMode: jira?.connection?.authMode ?? 'user-token'
  });
  const [jiraStatus, setJiraStatus] = useState(jira ?? { connected: false });
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [advancedOpen, setAdvancedOpen] = useState(Boolean(
    initial.workspacePath
    || initial.repositories?.length
    || jira?.connected
    || jira?.recovery?.required
  ));
  const roleLabel = onboardingRoles.find(([id]) => id === draft.role)?.[1] ?? 'Not selected';

  function update(field, value) {
    setDraft((current) => ({ ...current, [field]: value }));
    setError(null);
    setNotice(null);
  }

  async function persist(nextStep = draft.step, complete = false) {
    setWorking(true);
    setError(null);
    try {
      const result = await window.singularity.saveOnboarding({ ...draft, step: nextStep }, complete);
      setDraft(result.profile);
      setNotice(result.notices?.length ? result.notices.map((item) => item.message).join(' ') : null);
      if (complete) await onComplete(result);
      return result;
    } catch (saveError) {
      setError(saveError?.message || String(saveError));
      return null;
    } finally {
      setWorking(false);
    }
  }

  async function chooseWorkspace() {
    setWorking(true);
    setError(null);
    try {
      const selected = await window.singularity.chooseOnboardingWorkspace();
      if (selected) update('workspacePath', selected);
    } catch (chooseError) {
      setError(chooseError?.message || String(chooseError));
    } finally {
      setWorking(false);
    }
  }

  async function addRepositories() {
    setWorking(true);
    setError(null);
    try {
      const selected = await window.singularity.chooseOnboardingRepositories();
      if (!selected?.length) return;
      const repositories = new Map(draft.repositories.map((repository) => [repository.path, repository]));
      selected.forEach((repository) => repositories.set(repository.path, repository));
      update('repositories', [...repositories.values()]);
    } catch (chooseError) {
      setError(chooseError?.message || String(chooseError));
    } finally {
      setWorking(false);
    }
  }

  async function connectJira() {
    setWorking(true);
    setError(null);
    try {
      const result = await window.singularity.connectOnboardingJira({
        ...connection,
        email: connection.deployment === 'data-center' ? null : connection.email,
        authMode: connection.deployment === 'data-center' ? 'pat' : connection.authMode
      });
      setJiraStatus({ connected: true, active: result.active, connection: result.connection });
      setConnection((current) => ({ ...current, token: '' }));
      update('jiraChoice', 'connected');
    } catch (connectError) {
      setError(connectError?.message || String(connectError));
    } finally {
      setWorking(false);
    }
  }

  async function resetJiraCredentials(nextChoice = 'later') {
    setWorking(true);
    setError(null);
    try {
      const result = await window.singularity.resetJiraCredentials();
      setJiraStatus(result);
      update('jiraChoice', nextChoice);
    } catch (resetError) {
      setError(resetError?.message || String(resetError));
    } finally {
      setWorking(false);
    }
  }

  const canFinish = Boolean(draft.name.trim() && draft.role);
  const advancedCount = [
    draft.workspacePath,
    draft.repositories.length,
    jiraStatus.connected || draft.jiraChoice === 'connected'
  ].filter(Boolean).length;
  return <div className="onboarding-shell">
    <aside className="onboarding-rail">
      <FlowBrand className="brand onboarding-brand flow-brand-onboarding" context="Desktop setup" inverse />
      <div className="onboarding-journey">
        <span className="eyebrow">Your first outcome</span>
        <h2>Start with the work.</h2>
        <ol>
          <li className="active"><span>1</span><div><strong>Personalize</strong><small>Name and working role</small></div></li>
          <li><span>2</span><div><strong>Open an Epic</strong><small>Bring requirements and sources</small></div></li>
          <li><span>3</span><div><strong>Plan Stories</strong><small>Review, approve, and publish</small></div></li>
        </ol>
      </div>
      <div className="onboarding-promise"><span>Connections come later</span><p>Local workspaces, GitHub, and Jira are available under Advanced. None of them block this welcome setup.</p></div>
    </aside>
    <main className="onboarding-main">
      <header className="onboarding-topbar"><span>Quick start · about one minute</span><button className="ghost" onClick={onHelp}>Why Flow?</button></header>
      <section className="onboarding-stage">
        {draft.recovery && <div className="onboarding-recovery" role="status"><strong>Local setup recovered</strong><span>{draft.recovery.message}</span></div>}
        <div className="onboarding-card onboarding-quick-card">
          <div className="onboarding-copy"><span className="eyebrow">Welcome to Flow</span><h1>Set your working perspective.</h1><p>Two details personalize the experience. Connections and storage are optional, project-specific tools that can wait until you need them.</p></div>
          <div className="onboarding-core-fields">
            <label className="onboarding-field"><span>Your name</span><input autoFocus value={draft.name} placeholder="Ashok Raj" onChange={(event) => update('name', event.target.value)} /><small>Local display name; Git identity remains the approval authority.</small></label>
            <label className="onboarding-field"><span>Primary role</span><select value={draft.role ?? ''} onChange={(event) => update('role', event.target.value)}><option value="">Choose a role…</option>{onboardingRoles.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select><small>Guidance only—you may use any configured persona.</small></label>
          </div>
          <button type="button" className={`onboarding-advanced-trigger ${advancedOpen ? 'open' : ''}`} aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((current) => !current)}>
            <span className="onboarding-advanced-icon">⌘</span>
            <span><strong>Advanced setup</strong><small>Local workspace, repositories, GitHub, and Jira</small></span>
            {advancedCount > 0 && <Pill tone="good">{advancedCount} configured</Pill>}
            <b>{advancedOpen ? '−' : '+'}</b>
          </button>
          {advancedOpen && <div className="onboarding-advanced-grid">
            <section className="advanced-setup-card workspace">
              <header><span>01</span><div><strong>Local workspace</strong><small>Clone and cache boundary</small></div></header>
              <p>Choose a corporate-approved folder only when you want managed multi-repository workspaces.</p>
              <div className="advanced-setup-value"><code>{draft.workspacePath ?? 'Not configured'}</code><button className="secondary compact" onClick={chooseWorkspace} disabled={working}>{draft.workspacePath ? 'Change' : 'Choose folder'}</button></div>
            </section>
            <section className="advanced-setup-card github">
              <header><span>02</span><div><strong>Workspace repositories</strong><small>Lead and participating repositories</small></div></header>
              <p>Add repositories to the workspace project boundary. Singularity uses each repository’s Git identity and the existing authenticated <code>gh</code> CLI session.</p>
              <div className="onboarding-repositories compact-list">{draft.repositories.map((repository) => <div key={repository.path}><span>{repository.name.slice(0, 1).toUpperCase()}</span><div><strong>{repository.name}</strong><small>{repository.path}</small></div><button className="ghost" aria-label={`Remove ${repository.name}`} onClick={() => update('repositories', draft.repositories.filter((item) => item.path !== repository.path))}>×</button></div>)}<button className="onboarding-add-repository" onClick={addRepositories} disabled={working}><span>＋</span><div><strong>Add repositories</strong><small>Optional · GitHub is detected after opening</small></div></button></div>
            </section>
            <section className="advanced-setup-card jira">
              <header><span>03</span><div><strong>Jira connection</strong><small>Import Epics and publish Stories</small></div></header>
              {jiraStatus.recovery?.required ? <div className="onboarding-jira-recovery" role="alert">
                <span>!</span><div><strong>Saved credentials need attention</strong><small>{jiraStatus.recovery.message}</small></div><button className="secondary compact" disabled={working} onClick={() => resetJiraCredentials('later')}>Reset</button>
              </div> : jiraStatus.connected || draft.jiraChoice === 'connected' ? <div className="onboarding-jira-connected">
                <span>✓</span><div><strong>Connected securely</strong><small>{jiraStatus.connection?.baseUrl ?? 'Credential available in this OS account'}</small></div><Pill tone="good">Ready</Pill>
              </div> : <>
                <div className="onboarding-jira-form">
                  <label><span>Deployment</span><select value={connection.deployment} onChange={(event) => setConnection((current) => ({ ...current, deployment: event.target.value, authMode: event.target.value === 'data-center' ? 'pat' : 'user-token' }))}><option value="cloud">Jira Cloud</option><option value="data-center">Jira Data Center</option></select></label>
                  <label className="wide"><span>Jira HTTPS URL</span><input value={connection.baseUrl} placeholder="https://company.atlassian.net" onChange={(event) => setConnection((current) => ({ ...current, baseUrl: event.target.value }))} /></label>
                  {connection.deployment === 'cloud' && <label><span>Email</span><input type="email" value={connection.email} placeholder="you@company.com" onChange={(event) => setConnection((current) => ({ ...current, email: event.target.value }))} /></label>}
                  <label><span>{connection.deployment === 'cloud' ? 'API token' : 'Personal access token'}</span><input type="password" value={connection.token} placeholder="Stored in OS keychain" onChange={(event) => setConnection((current) => ({ ...current, token: event.target.value }))} /></label>
                </div>
                <div className="onboarding-jira-actions"><button className="primary compact" disabled={working || !connection.baseUrl || !connection.token || (connection.deployment === 'cloud' && !connection.email)} onClick={connectJira}>{working ? 'Verifying…' : 'Verify Jira'}</button><button className="ghost compact" onClick={() => update('jiraChoice', 'not-used')}>Skip</button></div>
              </>}
            </section>
          </div>}
          <div className="onboarding-ready-strip"><span>✓</span><div><strong>{draft.name || 'Your local profile'}</strong><small>{draft.role ? `${roleLabel} · ready to start` : 'Choose a role to continue'}</small></div><em>Advanced setup remains available later</em></div>
        </div>
        {notice && <div className="onboarding-warning" role="status">{notice}</div>}
        {error && <div className="onboarding-error" role="alert">{error}</div>}
      </section>
      <footer className="onboarding-footer"><span /><span>Name and role stay local. Advanced connections are configured only when opened.</span><button className="primary onboarding-finish" disabled={working || !canFinish} onClick={() => persist(4, true)}>{working ? 'Finishing…' : 'Continue to Flow'}</button></footer>
    </main>
  </div>;
}

function OnboardingLoadFailure({ error, retry, help }) {
  return <div className="onboarding-failure">
    <FlowBrand className="brand large flow-brand-welcome" context="Desktop setup" />
    <section>
      <span className="onboarding-failure-mark">!</span>
      <span className="eyebrow">Setup could not be loaded</span>
      <h1>We stopped before opening your workspace.</h1>
      <p>Flow could not safely read the local onboarding profile. No repository, Jira, or Git state was changed.</p>
      <pre>{error}</pre>
      <div><button className="primary" onClick={retry}>Try again</button><button className="secondary" onClick={help}>Open help</button></div>
    </section>
  </div>;
}

function Toast({ toast, onClose }) {
  if (!toast) return null;
  return <div className={`toast ${toast.tone}`} role={toast.tone === 'bad' ? 'alert' : 'status'} aria-live="polite"><span>{toast.text}</span><button type="button" aria-label="Dismiss message" onClick={onClose}>×</button></div>;
}

function CopilotServiceControl({ repository, notify }) {
  const [status, setStatus] = useState({ state: 'loading', running: false, preflight: null });
  const [logs, setLogs] = useState([]);
  const [model, setModel] = useState('');
  const [open, setOpen] = useState(false);
  const [operation, setOperation] = useState(null);
  const [clock, setClock] = useState(Date.now());
  const controlRef = useRef(null);

  useEffect(() => {
    let active = true;
    Promise.all([
      window.singularity.copilotServiceStatus(repository),
      window.singularity.copilotServiceLogs(repository)
    ]).then(([nextStatus, nextLogs]) => {
      if (!active) return;
      setStatus(nextStatus);
      setLogs(nextLogs);
      setModel(nextStatus.model ?? '');
    }).catch((error) => {
      if (active) setStatus({ state: 'error', running: false, preflight: { ready: false, message: error.message } });
    });
    const unsubscribe = window.singularity.onCopilotServiceEvent?.((event) => {
      if (!active || event.repository !== repository) return;
      setStatus((current) => ({ ...current, ...event.service }));
      setLogs((current) => [...current.slice(-299), event]);
      if (['ready', 'model-changed', 'config_option_update'].includes(event.type)) {
        setModel(event.service?.model ?? '');
      }
    });
    return () => { active = false; unsubscribe?.(); };
  }, [repository]);

  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = (event) => { if (!controlRef.current?.contains(event.target)) setOpen(false); };
    const closeEscape = (event) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', closeOutside);
    document.addEventListener('keydown', closeEscape);
    return () => { document.removeEventListener('mousedown', closeOutside); document.removeEventListener('keydown', closeEscape); };
  }, [open]);

  useEffect(() => {
    if (!open || !status.running) return undefined;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [open, status.running]);

  async function start() {
    setOperation('start');
    try {
      const result = await window.singularity.startCopilotService(repository, model);
      setStatus(result);
      setModel(result.model ?? model);
      notify({ tone: 'good', text: 'Copilot backend is ready in native Plan mode.' });
    } catch (error) {
      notify({ tone: 'bad', text: error?.message || String(error) });
    } finally {
      setOperation(null);
    }
  }

  async function applyModel() {
    setOperation('model');
    try {
      const result = await window.singularity.setCopilotServiceModel(repository, model);
      setStatus(result);
      setModel(result.model ?? model);
      notify({ tone: 'good', text: `Copilot model changed to ${result.model}.` });
    } catch (error) {
      notify({ tone: 'bad', text: error?.message || String(error) });
    } finally {
      setOperation(null);
    }
  }

  async function stop() {
    setOperation('stop');
    try {
      const result = await window.singularity.stopCopilotService(repository);
      setStatus(result);
      notify({ tone: 'good', text: 'Copilot backend stopped.' });
    } catch (error) {
      notify({ tone: 'bad', text: error?.message || String(error) });
    } finally {
      setOperation(null);
    }
  }

  const tone = status.state === 'error' || status.preflight?.ready === false ? 'bad' : status.state === 'busy' ? 'busy' : status.running ? 'ready' : 'stopped';
  const canStop = status.running || status.canStop;
  const connectedAt = Date.parse(status.connectedAt ?? status.startedAt);
  const connectedFor = status.running && Number.isFinite(connectedAt) ? Math.max(0, clock - connectedAt) : null;
  const availableModels = status.availableModels ?? [];
  const selectedModelKnown = !model || availableModels.some((candidate) => candidate.value === model);
  const modelChanged = Boolean(model && model !== status.model);
  const usage = status.usage ?? { status: 'unavailable', byModel: [] };
  const working = Boolean(operation);
  const usageTone = usage.status === 'exact' ? 'good' : usage.status === 'partial' ? 'warn' : 'neutral';
  const modelLabel = status.model
    ? availableModels.find((candidate) => candidate.value === status.model)?.label ?? status.model
    : 'Copilot auto';
  return <div className="copilot-service-control" ref={controlRef}>
    <button className={`copilot-service-trigger ${tone}`} type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((current) => !current)} title="Manage the local Copilot ACP backend"><span className="copilot-service-orb">✦</span><span><strong>Copilot</strong><small>{status.state === 'loading' ? 'checking' : status.state}</small></span><i /></button>
    {open && <section className="copilot-service-popover" role="dialog" aria-label="Copilot backend service">
      <header><div><span className="eyebrow">Local ACP process</span><h2>Copilot backend</h2></div><Pill tone={status.running ? 'good' : status.state === 'error' ? 'bad' : 'neutral'}>{status.state}</Pill></header>
      <p>Start Copilot once, then reuse that native Plan-mode process across governed planning turns. Stopping it cancels any active turn; it never changes Git state by itself.</p>
      <div className="copilot-service-facts"><div><span>Model</span><strong title={modelLabel}>{modelLabel}</strong></div><div><span>Connected</span><strong>{connectedFor === null ? '—' : formatDuration(connectedFor)}</strong></div><div><span>Total tokens</span><strong>{formatServiceTokens(usage.totalTokens)}</strong></div><div><span>Planning</span><strong>{status.activePlanningSessionId ? 'attached' : 'idle'}</strong></div></div>
      <div className="copilot-service-meta"><span>Plan mode</span><span>PID {status.processId ?? '—'}</span><span>{status.version ?? status.preflight?.version ?? 'Version unavailable'}</span></div>
      <label className="copilot-model-control"><span>{status.running ? 'Active model' : 'Model for next connection'}</span>{availableModels.length
        ? <select value={selectedModelKnown ? model : ''} disabled={working || (status.running && !status.modelSwitchSupported)} onChange={(event) => setModel(event.target.value)}>
          {!selectedModelKnown && <option value="">{model}</option>}
          {!status.running && <option value="">Copilot auto selection</option>}
          {availableModels.map((candidate) => <option key={candidate.value} value={candidate.value}>{candidate.label}</option>)}
        </select>
        : <input value={model} disabled={working || status.running} onChange={(event) => setModel(event.target.value)} placeholder="Copilot auto selection" />}
        <small>{status.running
          ? status.modelSwitchSupported ? 'Switches this idle ACP session without restarting it.' : 'This Copilot version requires a stop and restart to change models.'
          : 'Leave blank to let Copilot choose. The resolved model appears after connection.'}</small>
      </label>
      <section className="copilot-usage">
        <header><div><span className="eyebrow">This connection</span><strong>Token usage by model</strong></div><Pill tone={usageTone}>{usage.status}</Pill></header>
        {usage.byModel?.length
          ? <div className="copilot-usage-table"><div className="head"><span>Model</span><span>Input</span><span>Output</span><span>Cache</span><span>Total</span></div>{usage.byModel.map((entry) => <div key={entry.model}><strong title={entry.model}>{entry.model}</strong><span>{formatServiceTokens(entry.inputTokens)}</span><span>{formatServiceTokens(entry.outputTokens)}</span><span>{formatServiceTokens(entry.cachedReadTokens)}</span><span>{formatServiceTokens(entry.totalTokens)}</span></div>)}</div>
          : <div className="copilot-usage-empty"><strong>Waiting for exact usage</strong><span>Totals appear after a Copilot turn when ACP returns token counts. Singularity never estimates missing values.</span></div>}
        <footer><span>{usage.exactTurns ?? 0} exact turn{usage.exactTurns === 1 ? '' : 's'}</span>{usage.unavailableTurns > 0 && <span>{usage.unavailableTurns} unavailable</span>}</footer>
      </section>
      {status.preflight?.ready === false && <div className="copilot-service-warning">{status.preflight.message}</div>}
      <div className="copilot-service-actions">{status.running && status.modelSwitchSupported && modelChanged && <button className="primary" disabled={working || status.state === 'busy' || Boolean(status.activePlanningSessionId)} onClick={applyModel}>{operation === 'model' ? 'Applying…' : 'Apply model'}</button>}{operation === 'start' || status.state === 'starting' ? <button className="primary" disabled>Starting…</button> : canStop ? <button className="danger-button" disabled={working} onClick={stop}>{operation === 'stop' ? 'Stopping…' : status.state === 'error' ? 'Retry stop' : 'Stop backend'}</button> : <button className="primary" disabled={working || status.preflight?.ready === false} onClick={start}>Start backend</button>}<button className="ghost" onClick={() => setOpen(false)}>Close</button></div>
      <details className="copilot-service-log"><summary>Service log <span>{logs.length}</span></summary><div>{logs.length ? logs.slice(-80).map((entry, index) => <p key={`${entry.at}:${entry.type}:${index}`}><time>{new Date(entry.at).toLocaleTimeString()}</time><code>{entry.type}</code><span>{entry.message ?? entry.detail ?? entry.state ?? ''}</span></p>) : <p className="empty-log">No backend events yet.</p>}</div></details>
    </section>}
  </div>;
}

function formatServiceTokens(value) {
  return Number.isFinite(value) && value >= 0 ? value.toLocaleString('en-US') : 'Unavailable';
}

function ProgressRing({ value = 0 }) {
  return <div className="ring" style={{ '--progress': `${value * 3.6}deg` }}><div><strong>{value}%</strong><span>complete</span></div></div>;
}

function formatTokens(value) { return Number.isFinite(value) && value > 0 ? value.toLocaleString('en-US') : '—'; }

function formatDuration(value) {
  if (!Number.isFinite(value) || value < 0) return '—';
  const totalMinutes = Math.round(value / 60_000);
  if (totalMinutes < 1) return `${Math.round(value / 1000)}s`;
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) return `${totalHours}h${minutes ? ` ${minutes}m` : ''}`;
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return `${days}d${hours ? ` ${hours}h` : ''}`;
}

function formatRecentTime(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return 'Previously opened';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(time));
}

function formatCost(value) {
  if (!Number.isFinite(value)) return '—';
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(6)}`;
}

function costSource(item) {
  if (item.providerCostRecords && item.configuredPriceRecords) return 'provider + configured pricing';
  if (item.providerCostRecords) return 'provider-reported cost';
  if (item.configuredPriceRecords) return 'configured model pricing';
  return 'cost unavailable';
}

function CostDashboard({ report, pricing = {}, telemetry = null }) {
  const coverage = report.costCoverage;
  const pricedPercent = coverage.usageRecords ? Math.round((coverage.pricedRecords / coverage.usageRecords) * 100) : 0;
  const phaseMaximum = Math.max(...report.phases.map((phase) => phase.cost ?? 0), 0);
  const pricingCount = Object.keys(pricing ?? {}).length;
  const statusTone = report.costStatus === 'exact' ? 'good' : report.costStatus === 'partial' ? 'warn' : 'neutral';
  const captureMissing = telemetry && !telemetry.exists;
  const setupOutdated = telemetry?.setup?.installed && !telemetry.setup.current;
  const setupInstalled = telemetry?.setup?.installed && telemetry.setup.current;
  const guidance = captureMissing && coverage.exactUsageRecords === 0
    ? setupOutdated
      ? 'The installed Copilot telemetry wrapper is outdated, so these generations contain no model or token data. Rerun install.sh, fully exit Copilot, and start a new session inside this repository. Past turns cannot be reconstructed; future generations will be captured.'
      : setupInstalled
        ? 'The telemetry wrapper is installed, but this repository has no telemetry file. The active Copilot process was likely started before setup was installed or from outside this repository. Fully exit Copilot and start a new session from this repository. Past turns cannot be reconstructed.'
        : 'No repository telemetry file exists, so these generations contain no model or token data. Install or enable Singularity Flow Copilot telemetry, fully restart Copilot, and start it inside this repository. Past turns cannot be reconstructed.'
    : coverage.pendingRecords > 0
      ? `${coverage.pendingRecords} generation${coverage.pendingRecords === 1 ? ' is' : 's are'} waiting for Copilot to finish exporting. The next submit or /sflow-next action will reconcile, commit, and push the completed usage automatically.`
    : coverage.usageRecords === 0
    ? 'No generation telemetry has been committed for this work item yet. Publish a phase after starting Copilot with metadata-only telemetry enabled.'
    : coverage.exactUsageRecords === 0
      ? 'Usage records exist, but the provider did not expose exact model/token values. Cost remains unavailable and is never estimated.'
      : report.costStatus === 'unavailable'
        ? `Exact usage is available, but no provider cost or matching model price was found. Add exact model-name rates under tokens.pricing in workflow.yml${coverage.missingModels.length ? ` for ${coverage.missingModels.join(', ')}` : ''}.`
        : report.costStatus === 'partial'
          ? `${coverage.pricedRecords} of ${coverage.usageRecords} usage records are priced. The displayed total is partial; add missing exact model prices or provider cost telemetry.`
          : 'Every committed usage record is priced. Provider-reported cost is preferred; configured exact-model rates are used only as a fallback.';
  return <section className="panel cost-dashboard">
    <header className="panel-heading"><div><span className="eyebrow">Committed AI telemetry</span><h2>Model usage & cost</h2></div><div className="row gap">{telemetry && <Pill tone={telemetry.ready ? 'good' : 'warn'}>{telemetry.ready ? 'Copilot capture ready' : telemetry.exists ? 'Copilot capture waiting' : 'Copilot capture inactive'}</Pill>}{coverage.pendingRecords > 0 && <Pill tone="warn">{coverage.pendingRecords} pending export{coverage.pendingRecords === 1 ? '' : 's'}</Pill>}<span className="pricing-count">{pricingCount} configured model price{pricingCount === 1 ? '' : 's'}</span><Pill tone={statusTone}>{report.costStatus} coverage</Pill></div></header>
    <div className="cost-summary">
      <div className="cost-total-card"><span>Recorded cost</span><strong>{formatCost(report.cost)}</strong><small>{report.cost == null ? 'No estimate shown' : 'Provider cost or configured exact-model rates'}</small><div className="coverage-line"><div><span style={{ width: `${pricedPercent}%` }} /></div><b>{pricedPercent}% priced</b></div></div>
      <div className="cost-kpis">
        <div><span>Exact tokens</span><strong>{formatTokens(report.tokens.total)}</strong><small>{coverage.exactUsageRecords}/{coverage.usageRecords} exact usage records</small></div>
        <div><span>Models used</span><strong>{report.tokens.byModel.length || '—'}</strong><small>{report.tokens.byModel.map((item) => item.model).join(', ') || 'unavailable'}</small></div>
        <div><span>Cost records</span><strong>{coverage.pricedRecords || '—'}</strong><small>{coverage.providerCostRecords} provider · {coverage.configuredPriceRecords} configured</small></div>
      </div>
    </div>
    <div className={`cost-guidance ${report.costStatus}`}><strong>{captureMissing && coverage.exactUsageRecords === 0 ? setupOutdated ? 'Telemetry setup is outdated' : 'Copilot capture was inactive' : coverage.pendingRecords > 0 ? 'Waiting for Copilot export' : report.costStatus === 'exact' ? 'Complete cost coverage' : report.costStatus === 'partial' ? 'Partial cost coverage' : 'Cost needs telemetry or pricing'}</strong><span>{guidance}</span></div>
    <div className="cost-breakdown-grid">
      <div className="cost-breakdown"><header><div><span className="eyebrow">Lifecycle allocation</span><h3>Cost by phase</h3></div><span>Tokens · cost</span></header><div className="cost-rows">
        {report.phases.map((phase) => <div className="cost-row" key={phase.id}><div className="cost-row-copy"><strong>{phase.label}</strong><small>{formatTokens(phase.tokens)} tokens · {phase.costStatus}</small></div><div className="cost-bar" aria-label={`${phase.label} cost ${formatCost(phase.cost)}`}><span style={{ width: phase.cost != null && phaseMaximum ? `${Math.max(3, (phase.cost / phaseMaximum) * 100)}%` : '0%' }} /></div><b>{formatCost(phase.cost)}</b></div>)}
      </div></div>
      <div className="cost-breakdown"><header><div><span className="eyebrow">Provider attribution</span><h3>Cost by model</h3></div><span>Coverage source</span></header><div className="model-cost-rows">
        {!report.tokens.byModel.length && <div className="inline-empty">No provider/model usage has been captured yet.</div>}
        {report.tokens.byModel.map((item) => <div className="model-cost-row" key={`${item.provider}:${item.model}`}><div><span className="model-badge">{item.provider.slice(0, 2).toUpperCase()}</span><span><strong>{item.model}</strong><small>{item.provider} · {item.records} record{item.records === 1 ? '' : 's'} · {formatTokens(item.totalTokens)} tokens</small></span></div><div><strong>{formatCost(item.cost)}</strong><small>{item.pricedRecords}/{item.records} priced · {costSource(item)}</small></div></div>)}
      </div></div>
    </div>
  </section>;
}

function WorkflowTiming({ report }) {
  const maximum = Math.max(...report.phases.map((phase) => phase.elapsedMs ?? 0), 0);
  return <section className="panel timing-dashboard">
    <header className="panel-heading"><div><span className="eyebrow">Wall-clock lifecycle</span><h2>Workflow time</h2></div><Pill tone={report.completedAt ? 'good' : 'accent'}>{report.completedAt ? 'Complete' : 'Live'}</Pill></header>
    <div className="timing-summary">
      <div><span>Total elapsed</span><strong>{formatDuration(report.elapsedMs)}</strong><small>{report.completedAt ? 'Creation to final approval' : 'Creation to now'}</small></div>
      <div><span>Active time</span><strong>{formatDuration(report.activeMs)}</strong><small>Elapsed time outside approval queues</small></div>
      <div><span>Approval waiting</span><strong>{formatDuration(report.waitingMs)}</strong><small>{report.bottleneck ? `Longest: ${report.bottleneck.phase} (${formatDuration(report.bottleneck.waitingMs)})` : 'No approval waiting recorded'}</small></div>
    </div>
    <div className="timing-legend"><span><i className="active" />Active</span><span><i className="waiting" />Awaiting approval</span><em>Wall-clock time includes nights and weekends</em></div>
    <div className="timing-table"><div className="timing-header"><span>Phase</span><span>Lifecycle allocation</span><span>Active</span><span>Review wait</span><span>Total</span></div>{report.phases.map((phase) => {
      const activeWidth = maximum ? ((phase.activeMs ?? 0) / maximum) * 100 : 0;
      const waitingWidth = maximum ? ((phase.waitingMs ?? 0) / maximum) * 100 : 0;
      return <div className="timing-row" key={phase.id}><div><StatusDot status={phase.status} /><span><strong>{phase.label}</strong><small>{phase.status.replaceAll('_', ' ')} · generation {phase.generations}</small></span></div><div className="timing-bar" aria-label={`${phase.label}: ${formatDuration(phase.elapsedMs)} total`}><span className="active" style={{ width: `${activeWidth}%` }} /><span className="waiting" style={{ width: `${waitingWidth}%` }} /></div><b>{formatDuration(phase.activeMs)}</b><b>{formatDuration(phase.waitingMs)}</b><strong>{formatDuration(phase.elapsedMs)}</strong></div>;
    })}</div>
  </section>;
}

function CopilotQuestionCard({ question, disabled, onAnswer, onDismiss }) {
  const properties = question.schema?.properties ?? {
    answer: { type: 'string', title: 'Your answer', description: 'Give Copilot the decision or missing context.' }
  };
  const [values, setValues] = useState(() => Object.fromEntries(Object.entries(properties).map(([id, property]) => [
    id,
    property.default ?? (property.type === 'boolean' ? false : property.type === 'array' ? [] : '')
  ])));
  const required = new Set(question.schema?.required ?? Object.keys(properties));
  const complete = [...required].every((id) => {
    const value = values[id];
    return Array.isArray(value) ? value.length > 0 : typeof value === 'boolean' ? true : String(value ?? '').trim().length > 0;
  });
  function setField(id, value) { setValues((current) => ({ ...current, [id]: value })); }
  return <article className="copilot-question-card">
    <header><span className="ai-orb">?</span><div><span className="eyebrow">Question from Copilot</span><h3>{question.message}</h3></div></header>
    <div className="copilot-question-fields">{Object.entries(properties).map(([id, property]) => {
      const label = property.title ?? id.replaceAll('_', ' ');
      const options = property.oneOf?.map((item) => ({ value: item.const, label: item.title, detail: item.description }))
        ?? property.enum?.map((item) => ({ value: item, label: item }))
        ?? null;
      if (property.type === 'boolean') return <label className="copilot-check" key={id}><input type="checkbox" checked={Boolean(values[id])} onChange={(event) => setField(id, event.target.checked)} /><span><strong>{label}</strong>{property.description && <small>{property.description}</small>}</span></label>;
      if (property.type === 'array' && property.items) {
        const items = property.items.anyOf?.map((item) => ({ value: item.const, label: item.title }))
          ?? property.items.enum?.map((item) => ({ value: item, label: item }))
          ?? [];
        return <fieldset key={id}><legend>{label}</legend>{property.description && <small>{property.description}</small>}<div className="copilot-multiselect">{items.map((item) => <label key={item.value}><input type="checkbox" checked={values[id]?.includes(item.value)} onChange={(event) => setField(id, event.target.checked ? [...values[id], item.value] : values[id].filter((value) => value !== item.value))} />{item.label}</label>)}</div></fieldset>;
      }
      return <label key={id}><span>{label}{required.has(id) ? ' *' : ''}</span>{property.description && <small>{property.description}</small>}{options ? <select value={values[id]} onChange={(event) => setField(id, event.target.value)}><option value="">Choose…</option>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : property.type === 'number' || property.type === 'integer' ? <input type="number" value={values[id]} min={property.minimum} max={property.maximum} onChange={(event) => setField(id, property.type === 'integer' ? Number.parseInt(event.target.value, 10) : Number(event.target.value))} /> : <textarea rows="3" value={values[id]} onChange={(event) => setField(id, event.target.value)} />}</label>;
    })}</div>
    <footer><span>Your answer stays in this Copilot planning session and becomes part of the reviewed decision context.</span><div className="row"><button className="ghost compact" disabled={disabled} onClick={() => onDismiss(question)}>Skip</button><button className="primary compact" disabled={disabled || !complete} onClick={() => onAnswer(question, values)}>Answer Copilot</button></div></footer>
  </article>;
}

function StoryPlanAnalysis({ analysis }) {
  return <section className="panel planning-decomposition">
    <header className="panel-heading"><div><span className="eyebrow">Epic decomposition analysis</span><h2>Planned Jira & Git delivery units</h2></div><Pill tone={analysis.valid ? 'good' : 'warn'}>{analysis.valid ? `${analysis.epics.length} epics · ${analysis.stories.length} stories` : 'needs refinement'}</Pill></header>
    {!analysis.valid ? <div className="planning-warning"><span>⚠ {analysis.error}</span></div> : <>
      <div className="decomposition-kpis"><div><span>Epic IDs</span><strong>{analysis.epics.length}</strong><small>Jira epics after materialization</small></div><div><span>Story Work IDs</span><strong>{analysis.stories.length}</strong><small>Git branch + workflow identity</small></div><div><span>Repositories</span><strong>{analysis.repositories.length}</strong><small>{analysis.repositories.join(', ')}</small></div><div><span>Dependencies</span><strong>{analysis.dependencies}</strong><small>{analysis.blocking} blocking stories</small></div></div>
      <div className="decomposition-epics">{analysis.epics.map((epic) => <section key={epic.id}><header><div><span className="id-pair"><b>Epic ID</b><code>{epic.id}</code></span><h3>{epic.title}</h3></div><span className="id-pair"><b>Jira ID</b><code>{epic.jiraKey ?? 'created later'}</code></span></header><div>{epic.stories.map((story) => <article key={story.id}><div><span className="id-pair"><b>Work ID</b><code>{story.workId}</code></span><Pill tone={story.blocking ? 'accent' : 'neutral'}>{story.blocking ? 'blocking' : 'nonblocking'}</Pill></div><strong>{story.title}</strong><small>{story.repository} · {story.acceptanceCriteria.length} acceptance criteria · Jira {story.jiraKey ?? 'created during materialization'}</small>{story.dependsOn.length > 0 && <em>Depends on {story.dependsOn.map((dependency) => typeof dependency === 'string' ? dependency : dependency.story).join(', ')}</em>}</article>)}</div></section>)}</div>
    </>}
  </section>;
}

function StatusDot({ status }) { return <span className={`status-dot ${String(status).replaceAll('_', '-')}`} title={status} />; }

function SourceEditor({ path, value, onChange, language = 'markdown', dirty, onSave, onDownload, onImport, readOnly = false }) {
  return <section className="editor-panel">
    <header className="editor-header"><div><span className="eyebrow">{readOnly ? 'Repository-owned source' : 'Repository source'}</span><strong>{path}</strong></div><div className="row">{onImport && <button className="ghost compact" onClick={onImport}>Import</button>}{onDownload && <button className="secondary compact" onClick={onDownload}>Download</button>}<Pill tone={readOnly ? 'neutral' : dirty ? 'warn' : 'good'}>{readOnly ? 'Read only' : dirty ? 'Unsaved' : 'Saved'}</Pill>{!readOnly && <button className="primary compact" disabled={!dirty} onClick={onSave}>Save</button>}</div></header>
    <Editor height="calc(100vh - 245px)" language={language} theme="vs-light" value={value} onChange={(next) => !readOnly && onChange(next ?? '')} options={{ readOnly, minimap: { enabled: false }, fontFamily: 'SFMono-Regular, Consolas, Liberation Mono, monospace', fontSize: 14, lineHeight: 23, wordWrap: 'on', padding: { top: 18 }, scrollBeyondLastLine: false, automaticLayout: true }} />
  </section>;
}

function DesignerModal({ title, detail, children, submitLabel, danger = false, error, onCancel, onSubmit }) {
  return <div className="modal-backdrop" onClick={onCancel}><form className="designer-modal" onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
    <header><div><span className="eyebrow">Guided configuration</span><h2>{title}</h2></div><button type="button" onClick={onCancel}>×</button></header>
    <div className="designer-modal-body">{detail && <p>{detail}</p>}{children}{error && <div className="form-error" role="alert">{error}</div>}</div>
    <footer><button type="button" className="secondary" onClick={onCancel}>Cancel</button><button type="submit" className={danger ? 'danger-button' : 'primary'}>{submitLabel}</button></footer>
  </form></div>;
}

function ArtifactStudio({ data, openWorkspace, openDocument }) {
  const storyPhases = data.progress?.phases ?? [];
  const initiativePhases = data.initiative?.progress?.phases ?? [];
  const phases = storyPhases.length ? storyPhases : initiativePhases;
  const [selectedPhase, setSelectedPhase] = useState(phases.find((phase) => ['in_progress', 'awaiting_approval'].includes(phase.status))?.id ?? phases[0]?.id ?? '');
  const selected = phases.find((phase) => phase.id === selectedPhase) ?? phases[0];
  const initiativeDocuments = (data.initiative?.documents ?? []).map((document) => ({
    ...document,
    id: `${document.phase}:${document.id}`,
    path: document.repositoryPath,
    kind: document.kind,
    size: document.content ? new TextEncoder().encode(document.content).length : null
  }));
  const documents = data.documents.length ? data.documents : initiativeDocuments;
  const phaseDocuments = documents.filter((document) => document.phase === selected?.id);
  const completion = data.progress?.percentage ?? data.initiative?.progress?.percentage ?? 0;
  const title = data.workflow?.workItem.title ?? data.initiative?.state.initiative.title ?? 'Governed delivery workspace';
  return <div className="page artifact-studio-page">
    <header className="page-heading row-between"><div><span className="eyebrow">Artifact lifecycle</span><h1>Artifact Studio</h1><p>Follow each governed phase from repository context to approved, Git-backed output.</p></div><div className="studio-heading-actions"><Pill tone="accent">{completion}% complete</Pill><button className="primary" onClick={openWorkspace}>Open requirement workspace</button></div></header>
    {!phases.length ? <Empty title="No active delivery selected" detail="Choose a story work item or initiative to see its artifact lifecycle." /> : <>
      <section className="studio-flow panel">
        <header><div><span className="eyebrow">Active delivery</span><h2>{title}</h2></div><span>{phases.length} governed phases</span></header>
        <div className="studio-flow-track">{phases.map((phase, index) => <React.Fragment key={phase.id}><button className={`${phase.id === selected?.id ? 'active' : ''} ${phase.status.replaceAll('_', '-')}`} onClick={() => setSelectedPhase(phase.id)}><span>{phase.status === 'approved' ? '✓' : index + 1}</span><strong>{phase.label}</strong><small>{phase.status.replaceAll('_', ' ')}</small></button>{index < phases.length - 1 && <i>→</i>}</React.Fragment>)}</div>
      </section>
      <div className="studio-insight-grid">
        <section className="panel phase-insight">
          <header className="panel-heading"><div><span className="eyebrow">Phase insight</span><h2>{selected?.label}</h2></div><Pill tone={selected?.status === 'approved' ? 'good' : selected?.status === 'awaiting_approval' ? 'warn' : 'accent'}>{selected?.status.replaceAll('_', ' ')}</Pill></header>
          <div className="phase-insight-body">
            <div><span>Generation</span><strong>{selected?.generation ?? selected?.generatedOutputs ?? 0}</strong><small>immutable artifact revision</small></div>
            <div><span>Approval</span><strong>{selected?.approvals != null ? `${selected.approvals}/${selected.approvalsRequired}` : selected?.status === 'approved' ? 'Complete' : 'Pending'}</strong><small>exact content hash</small></div>
            <div><span>Outputs</span><strong>{phaseDocuments.length || selected?.outputs || 0}</strong><small>registered documents</small></div>
          </div>
          <div className="phase-deliverables"><strong>Governed deliverables</strong>{phaseDocuments.length ? phaseDocuments.map((document) => <button key={document.id} onClick={() => openDocument(document)}><span className="studio-file-icon">{document.kind === 'artifact' ? 'MD' : 'DOC'}</span><span><b>{document.label}</b><small>{document.path}</small></span><em>Open</em></button>) : <div className="inline-empty">No phase document has been published yet.</div>}</div>
        </section>
        <section className="panel studio-assistant">
          <header className="panel-heading"><div><span className="eyebrow">Singularity intelligence</span><h2>What happens next</h2></div><span className="ai-orb">✦</span></header>
          <div className="studio-assistant-copy"><strong>{selected?.status === 'approved' ? 'This phase is governed and reusable.' : selected?.status === 'awaiting_approval' ? 'The artifact is ready for a hash-bound review.' : 'Build the phase output from governed context.'}</strong><p>{selected?.status === 'approved' ? 'Downstream phases can consume this approved artifact through declared inputs.' : selected?.status === 'awaiting_approval' ? 'Open the review bundle to inspect provenance, evidence, and approval requirements.' : 'Use Planning Copilot to explore options, then promote a reviewed artifact into repository state.'}</p></div>
          <div className="assistant-checks"><span><i className="done">✓</i>Repository context pinned</span><span><i className={phaseDocuments.length ? 'done' : ''}>{phaseDocuments.length ? '✓' : '○'}</i>Artifact generated</span><span><i className={selected?.status === 'approved' ? 'done' : ''}>{selected?.status === 'approved' ? '✓' : '○'}</i>Approval recorded</span></div>
        </section>
      </div>
      <section className="panel artifact-repository">
        <header className="panel-heading"><div><span className="eyebrow">Shared repository</span><h2>Governed artifacts</h2></div><span>{documents.length} registered</span></header>
        <div className="artifact-repository-head"><span>Name</span><span>Phase</span><span>Status</span><span>Repository path</span><span /></div>
        {documents.length ? documents.map((document) => <div className="artifact-repository-row" key={document.id}><div><span className="studio-file-icon">{document.kind === 'artifact' ? 'MD' : document.kind === 'url' ? 'URL' : 'DOC'}</span><strong>{document.label}</strong></div><span>{document.phase ?? 'system'}</span><Pill tone={document.status === 'approved' ? 'good' : 'neutral'}>{document.status ?? document.kind}</Pill><code>{document.path ?? document.url}</code><button className="ghost compact" onClick={() => openDocument(document)}>Open</button></div>) : <div className="inline-empty">Generated and uploaded artifacts will appear here with their repository provenance.</div>}
      </section>
    </>}
  </div>;
}

function ImpactStudio({ data, openPlanning }) {
  const repositories = Object.entries(data.portfolio?.repositories ?? {});
  const graphRepositories = repositories.length ? repositories.slice(0, 5) : [[data.repository.root.split('/').at(-1), { defaultBranch: data.repository.branch, required: true }]];
  const stories = data.initiative?.report?.children?.stories ?? [];
  const staleStories = stories.filter((story) => story.stale);
  const contracts = data.initiative?.contracts ?? [];
  const riskyContracts = contracts.filter((contract) => contract.integrity !== 'verified');
  const subject = data.initiative?.state.initiative.title ?? data.workflow?.workItem.title ?? 'Current repository change';
  const risk = staleStories.length || riskyContracts.length ? 'Medium' : 'Low';
  const nodePositions = [[90, 58], [550, 58], [70, 285], [555, 285], [320, 340]];
  return <div className="impact-page">
    <header className="impact-toolbar"><div><span className="eyebrow">Repository intelligence</span><h1>Impact Analysis Studio</h1><p>{subject}</p></div><div><Pill tone={risk === 'Low' ? 'good' : 'warn'}>{risk} delivery risk</Pill><button className="primary" onClick={openPlanning}>Explore with Planning Copilot</button></div></header>
    <div className="impact-layout">
      <main className="impact-main">
        <section className="impact-canvas panel">
          <header className="panel-heading"><div><span className="eyebrow">Dependency topology</span><h2>Change impact map</h2></div><span>{graphRepositories.length} repositories · {stories.length} stories</span></header>
          <div className="impact-graph">
            <svg viewBox="0 0 640 410" role="img" aria-label="Repository dependency graph">{graphRepositories.map(([id], index) => <line key={id} x1="320" y1="205" x2={nodePositions[index][0]} y2={nodePositions[index][1]} />)}<circle cx="320" cy="205" r="64" /></svg>
            <div className="impact-core"><span>REQ</span><strong>{data.initiative?.state.initiative.id ?? data.workflow?.workItem.id ?? 'LOCAL'}</strong><small>governed change</small></div>
            {graphRepositories.map(([id, repository], index) => <div className="impact-node" key={id} style={{ '--x': `${nodePositions[index][0]}px`, '--y': `${nodePositions[index][1]}px` }}><span>{id.slice(0, 2).toUpperCase()}</span><strong>{repository.metadata?.name ?? id}</strong><small>{repository.metadata?.appId ? `${repository.metadata.appId} · ` : ''}{repository.defaultBranch ?? 'main'} · {repository.required ? 'required' : 'optional'}</small></div>)}
          </div>
        </section>
        <section className="panel affected-repositories">
          <header className="panel-heading"><div><span className="eyebrow">Change surface</span><h2>Affected repositories</h2></div><span>{stories.length || graphRepositories.length} tracked units</span></header>
          <div className="affected-head"><span>Repository</span><span>Branch</span><span>Stories</span><span>State</span></div>
          {graphRepositories.map(([id, repository]) => { const owned = stories.filter((story) => story.repository === id); const stale = owned.some((story) => story.stale); return <div className="affected-row" key={id}><strong>{repository.metadata?.name ?? id}{repository.metadata?.appId && <small> · {repository.metadata.appId}</small>}</strong><code>{repository.defaultBranch ?? 'main'}</code><span>{owned.length || '—'}</span><Pill tone={stale ? 'warn' : 'good'}>{stale ? 'stale context' : 'reachable'}</Pill></div>; })}
        </section>
      </main>
      <aside className="impact-inspector">
        <section className="impact-risk-card"><span className="ai-orb">✦</span><div><span className="eyebrow">Singularity analysis</span><h2>{risk} risk</h2><p>Computed from committed repository reachability, story context freshness, and interface-contract integrity.</p></div></section>
        <section className="impact-kpis"><div><span>Repositories</span><strong>{graphRepositories.length}</strong></div><div><span>Blocking stories</span><strong>{stories.filter((story) => story.blocking).length}</strong></div><div><span>Stale contexts</span><strong>{staleStories.length}</strong></div><div><span>Contract alerts</span><strong>{riskyContracts.length}</strong></div></section>
        <section className="impact-findings"><header><span className="eyebrow">Findings</span><h3>Review before planning</h3></header>{staleStories.length ? <div className="finding warn"><strong>{staleStories.length} stale story context{staleStories.length === 1 ? '' : 's'}</strong><span>Synchronize approved initiative inputs before downstream generation.</span></div> : <div className="finding good"><strong>Child context is current</strong><span>No stale materialized story snapshots were reported.</span></div>}{riskyContracts.length ? <div className="finding warn"><strong>{riskyContracts.length} contract integrity alert{riskyContracts.length === 1 ? '' : 's'}</strong><span>Reconcile producer and consumer hashes before construction.</span></div> : <div className="finding good"><strong>Contracts verified</strong><span>All registered interface contracts match their committed hashes.</span></div>}<div className="finding"><strong>World model remains repository-owned</strong><span>Planning will use the pinned local model plus approved initiative context.</span></div></section>
      </aside>
    </div>
  </div>;
}

function PortfolioSetup({ data, action, onCreated, jiraFirst = false, onCancel = null }) {
  const [values, setValues] = useState({
    approvalName: '',
    approvalEmail: '',
    repositoryId: '',
    repositoryUrl: '',
    repositoryAppId: '',
    repositoryName: '',
    repositoryMetadata: [{ key: '', value: '' }],
    defaultBranch: data.definition.defaultBaseBranch ?? 'main',
    jiraEnabled: jiraFirst,
    jiraDeployment: 'cloud',
    jiraBaseUrl: '',
    jiraProjectKey: '',
    jiraWriteMode: 'off'
  });
  const set = (name, value) => setValues((current) => ({ ...current, [name]: value }));
  const setMetadata = (index, field, value) => setValues((current) => ({
    ...current,
    repositoryMetadata: current.repositoryMetadata.map((entry, entryIndex) => entryIndex === index ? { ...entry, [field]: value } : entry)
  }));
  const repositoryPartial = Boolean(
    values.repositoryId
    || values.repositoryUrl
    || values.repositoryAppId
    || values.repositoryName
    || values.repositoryMetadata.some((entry) => entry.key || entry.value)
  );
  const jiraReady = !values.jiraEnabled || Boolean(values.jiraBaseUrl);
  async function create() {
    const result = await action(() => window.singularity.bootstrapPortfolio(data.repository.root, {
      approvalName: values.approvalName || null,
      approvalEmail: values.approvalEmail || null,
      repository: repositoryPartial ? {
        id: values.repositoryId,
        url: values.repositoryUrl,
        defaultBranch: values.defaultBranch,
        required: true,
        metadata: repositoryMetadataFromForm({
          appId: values.repositoryAppId,
          name: values.repositoryName,
          metadata: values.repositoryMetadata
        })
      } : null,
      jira: {
        enabled: values.jiraEnabled,
        deployment: values.jiraDeployment,
        baseUrl: values.jiraBaseUrl,
        projectKey: values.jiraProjectKey,
        writeMode: values.jiraWriteMode,
        connection: 'corporate-jira'
      }
    }), 'Epic governance created and validated');
    if (result) await onCreated(result, {
      deployment: values.jiraDeployment,
      baseUrl: values.jiraBaseUrl,
      projectKey: values.jiraProjectKey,
      writeMode: values.jiraWriteMode
    });
  }
  return <div className="portfolio-setup">
    <section className="portfolio-setup-intro"><span className="jira-mark">{jiraFirst ? 'J' : 'S'}</span><span className="eyebrow">{jiraFirst ? 'Jira setup' : 'Advanced governance setup'}</span><h1>{jiraFirst ? 'Connect Jira to bring in Epics' : 'Set up your Epic workspace'}</h1><p>{jiraFirst ? <>Define the allowed Jira host and project for this repository. Credentials are entered on the next screen and stay encrypted in the operating-system keychain.</> : <>This creates the governed profiles, approval groups, repository registry, and optional Jira policy under <code>singularity/portfolio.yml</code>. It remains an uncommitted configuration change until you use <strong>Commit & push</strong>.</>}</p><div className="portfolio-setup-steps">{jiraFirst ? <><span><b>1</b>Policy</span><span><b>2</b>Credentials</span><span><b>3</b>Choose Epic</span></> : <><span><b>1</b>Identity</span><span><b>2</b>Repositories</span><span><b>3</b>Jira policy</span></>}</div></section>
    <section className="portfolio-setup-form panel">
      {!jiraFirst && <><header><span className="eyebrow">Approval identity</span><h2>Who owns the initial gates?</h2><p>Leave these blank to use the repository’s configured Git name and email.</p></header>
      <div className="control-grid"><label><span>Display name</span><input value={values.approvalName} placeholder="Use Git user.name" onChange={(event) => set('approvalName', event.target.value)} /></label><label><span>Email</span><input type="email" value={values.approvalEmail} placeholder="Use Git user.email" onChange={(event) => set('approvalEmail', event.target.value)} /></label></div>
      <header><span className="eyebrow">Participating repository</span><h2>Add the first delivery repository</h2><p>Optional now. More repositories can be added later in Advanced governance.</p></header>
      <div className="control-grid expanded"><label><span>Repository ID</span><input value={values.repositoryId} placeholder="mobile" onChange={(event) => set('repositoryId', event.target.value)} /></label><label><span>Application ID</span><input value={values.repositoryAppId} placeholder="APP-1001" onChange={(event) => set('repositoryAppId', event.target.value)} /></label><label className="full"><span>Application name</span><input value={values.repositoryName} placeholder="Mobile application" onChange={(event) => set('repositoryName', event.target.value)} /></label><label className="full"><span>Git URL</span><input value={values.repositoryUrl} placeholder="git@github.com:company/mobile.git" onChange={(event) => set('repositoryUrl', event.target.value)} /></label><label><span>Default branch</span><input value={values.defaultBranch} onChange={(event) => set('defaultBranch', event.target.value)} /></label></div>
      <div className="repository-metadata-fields"><header><div><strong>Additional metadata</strong><span>Optional key/value pairs are committed under this repository in <code>singularity/portfolio.yml</code>.</span></div><button type="button" className="ghost compact" onClick={() => set('repositoryMetadata', [...values.repositoryMetadata, { key: '', value: '' }])}>＋ Add field</button></header>{values.repositoryMetadata.map((entry, index) => <div key={index}><input aria-label={`Metadata key ${index + 1}`} value={entry.key} placeholder="owner" onChange={(event) => setMetadata(index, 'key', event.target.value)} /><input aria-label={`Metadata value ${index + 1}`} value={entry.value} placeholder="Digital Channels" onChange={(event) => setMetadata(index, 'value', event.target.value)} />{values.repositoryMetadata.length > 1 && <button type="button" className="ghost compact" aria-label={`Remove metadata field ${index + 1}`} onClick={() => set('repositoryMetadata', values.repositoryMetadata.filter((_, entryIndex) => entryIndex !== index))}>×</button>}</div>)}</div></>}
      <header className="portfolio-jira-toggle"><div><span className="eyebrow">Corporate integration</span><h2>{jiraFirst ? 'Choose your Jira deployment' : 'Configure Jira now'}</h2></div>{!jiraFirst && <label className="switch"><input type="checkbox" checked={values.jiraEnabled} onChange={(event) => set('jiraEnabled', event.target.checked)} /><span /></label>}</header>
      {values.jiraEnabled && <div className="control-grid expanded"><label><span>Deployment</span><select value={values.jiraDeployment} onChange={(event) => set('jiraDeployment', event.target.value)}><option value="cloud">Jira Cloud</option><option value="data-center">Jira Data Center</option></select></label><label className="full"><span>Jira HTTPS URL</span><input value={values.jiraBaseUrl} placeholder="https://company.atlassian.net" onChange={(event) => set('jiraBaseUrl', event.target.value)} /></label><label><span>Project key</span><input value={values.jiraProjectKey} placeholder="APP" onChange={(event) => set('jiraProjectKey', event.target.value.toUpperCase())} /></label><label><span>Write policy</span><select value={values.jiraWriteMode} onChange={(event) => set('jiraWriteMode', event.target.value)}><option value="off">Off · browse/adopt only</option><option value="preview">Preview · commit plans only</option><option value="approved">Approved · guarded apply</option></select></label></div>}
      <div className="portfolio-setup-action"><div><strong>No credentials are stored in Git</strong><span>The API token/PAT is requested securely on the next screen.</span></div><div className="row gap">{onCancel && <button className="ghost" onClick={onCancel}>Back to Epic</button>}<button className="primary" disabled={(repositoryPartial && (!values.repositoryId || !values.repositoryUrl)) || !jiraReady} onClick={create}>{jiraFirst ? 'Save Jira policy & continue' : 'Create & validate governance'}</button></div></div>
    </section>
  </div>;
}

function workspaceRepositoryDraft(repository) {
  return {
    id: repository.id ?? '',
    localPath: repository.localPath ?? '',
    url: repository.url ?? '',
    defaultBranch: repository.defaultBranch ?? 'main',
    name: repository.metadata?.name ?? repository.id ?? '',
    appId: repository.metadata?.appId ?? '',
    jiraBoard: repository.jira?.board ?? '',
    metadata: Object.entries(repository.metadata ?? {})
      .filter(([key]) => !['name', 'appId'].includes(key))
      .map(([key, value]) => ({ key, value: String(value) }))
  };
}

function WorkspaceStudio({
  data,
  action,
  onOpened,
  defaultBaseDirectory = '',
  recentWorkspaces = [],
  onOpenWorkspace,
  onForgetWorkspace
}) {
  const current = data.workspace;
  const [baseDirectory, setBaseDirectory] = useState(defaultBaseDirectory);
  const [workspaceId, setWorkspaceId] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [repositories, setRepositories] = useState([]);
  const [leadIndex, setLeadIndex] = useState(0);
  const [preview, setPreview] = useState(null);
  const [confirmation, setConfirmation] = useState('');
  const [health, setHealth] = useState(current ?? null);
  const saveActions = useRef(null);

  useEffect(() => {
    let active = true;
    window.singularity.workspaceRepositoryDefaults(data.repository.root)
      .then((repository) => {
        if (!active || repositories.length) return;
        setRepositories([workspaceRepositoryDraft(repository)]);
      })
      .catch(() => {});
    return () => { active = false; };
  }, [data.repository.root]);

  useEffect(() => { setHealth(data.workspace ?? null); }, [data.workspace]);

  function resetPreview() {
    setPreview(null);
    setConfirmation('');
  }

  async function chooseBase() {
    const result = await action(() => window.singularity.chooseWorkspaceBase());
    if (result) { setBaseDirectory(result); resetPreview(); }
  }

  function uniqueRepositoryId(candidate, taken = repositories.map((repository) => repository.id)) {
    const base = candidate || 'repository';
    let next = base;
    let suffix = 2;
    while (taken.includes(next)) next = `${base}-${suffix++}`;
    return next;
  }

  async function addRepositories() {
    const selected = await action(() => window.singularity.chooseWorkspaceRepositories());
    if (!selected?.length) return;
    setRepositories((currentRepositories) => {
      const next = [...currentRepositories];
      for (const repository of selected) {
        if (next.some((entry) => entry.url === repository.url)) continue;
        next.push(workspaceRepositoryDraft({
          ...repository,
          id: uniqueRepositoryId(repository.id, next.map((entry) => entry.id))
        }));
      }
      return next;
    });
    resetPreview();
  }

  function addRepositoryManually() {
    setRepositories((currentRepositories) => [
      ...currentRepositories,
      workspaceRepositoryDraft({
        id: uniqueRepositoryId('repository', currentRepositories.map((repository) => repository.id)),
        defaultBranch: 'main'
      })
    ]);
    resetPreview();
  }

  function updateRepository(index, field, value) {
    setRepositories((currentRepositories) => currentRepositories.map((repository, repositoryIndex) => (
      repositoryIndex === index ? { ...repository, [field]: value } : repository
    )));
    resetPreview();
  }

  function updateMetadata(repositoryIndex, metadataIndex, field, value) {
    setRepositories((currentRepositories) => currentRepositories.map((repository, index) => index === repositoryIndex ? {
      ...repository,
      metadata: repository.metadata.map((entry, entryIndex) => (
        entryIndex === metadataIndex ? { ...entry, [field]: value } : entry
      ))
    } : repository));
    resetPreview();
  }

  function addMetadata(repositoryIndex) {
    setRepositories((currentRepositories) => currentRepositories.map((repository, index) => index === repositoryIndex ? {
      ...repository,
      metadata: [...repository.metadata, { key: '', value: '' }]
    } : repository));
    resetPreview();
  }

  function removeMetadata(repositoryIndex, metadataIndex) {
    setRepositories((currentRepositories) => currentRepositories.map((repository, index) => index === repositoryIndex ? {
      ...repository,
      metadata: repository.metadata.filter((_, entryIndex) => entryIndex !== metadataIndex)
    } : repository));
    resetPreview();
  }

  function removeRepository(index) {
    if (repositories.length === 1) return;
    setRepositories((currentRepositories) => currentRepositories.filter((_, repositoryIndex) => repositoryIndex !== index));
    setLeadIndex((currentLead) => currentLead === index ? 0 : currentLead > index ? currentLead - 1 : currentLead);
    resetPreview();
  }

  function repositoryConfiguration() {
    return Object.fromEntries(repositories.map((repository) => {
      const id = repository.id.trim();
      return [id, {
        url: repository.url.trim(),
        defaultBranch: repository.defaultBranch.trim() || 'main',
        required: true,
        path: `repos/${id}`,
        jira: { board: repository.jiraBoard.trim() },
        metadata: {
          name: repository.name.trim(),
          appId: repository.appId.trim(),
          ...Object.fromEntries(repository.metadata
            .filter((entry) => entry.key.trim() && entry.value.trim())
            .map((entry) => [entry.key.trim(), entry.value.trim()]))
        }
      }];
    }));
  }

  async function buildPreview() {
    const result = await action(() => window.singularity.previewWorkspaceConfiguration(data.repository.root, {
      baseDirectory,
      id: workspaceId.trim(),
      name: workspaceName.trim(),
      repositories: repositoryConfiguration(),
      leadRepository: repositories[leadIndex]?.id.trim()
    }));
    if (result) {
      setPreview(result);
      requestAnimationFrame(() => saveActions.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    }
  }

  async function create() {
    const result = await action(() => window.singularity.createWorkspaceConfiguration(data.repository.root, {
      baseDirectory,
      id: workspaceId.trim(),
      name: workspaceName.trim(),
      repositories: repositoryConfiguration(),
      leadRepository: repositories[leadIndex]?.id.trim(),
      confirmation
    }));
    if (result) onOpened(result, 'workspaces');
  }

  async function refreshHealth() {
    if (!health?.workspace?.path) return;
    const result = await action(() => window.singularity.workspaceStatus(health.workspace.path), 'Workspace health refreshed');
    if (result) setHealth(result);
  }

  async function sync() {
    const result = await action(() => window.singularity.syncWorkspace(health.workspace.path), 'Workspace remotes fetched; no branch was changed');
    if (result) setHealth(result.status);
  }

  async function repair() {
    const result = await action(() => window.singularity.repairWorkspace(health.workspace.path), 'Missing workspace clones repaired');
    if (result?.snapshot) onOpened(result.snapshot, 'workspaces');
    else if (result) setHealth(result.status);
  }

  async function stageDocuments() {
    const result = await action(() => window.singularity.stageWorkspaceDocuments(health.workspace.path));
    if (result && !result.canceled) {
      const refreshed = await window.singularity.workspaceStatus(health.workspace.path);
      setHealth(refreshed);
    }
  }

  async function promoteDocument(document) {
    const workId = data.workflow?.workItem?.id;
    const result = await action(() => window.singularity.promoteWorkspaceDocument(
      data.repository.root,
      health.workspace.path,
      document.path,
      workId
    ), `${document.name} imported, committed, and pushed for ${workId}`);
    if (result?.snapshot) onOpened(result.snapshot, 'workspaces');
  }

  const canPromoteDocuments = Boolean(
    data.workflow?.workItem?.id
    && data.repository.branch === data.workflow.workItem.branch
    && data.session?.workId === data.workflow.workItem.id
  );
  const repositoryIds = repositories.map((repository) => repository.id.trim());
  const validRepositories = repositories.length > 0
    && new Set(repositoryIds).size === repositoryIds.length
    && repositories.every((repository) => {
      const metadataKeys = repository.metadata.map((entry) => entry.key.trim()).filter(Boolean);
      const metadataValid = repository.metadata.every((entry) => (
        (!entry.key.trim() && !entry.value.trim())
        || (
          /^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(entry.key.trim())
          && !['name', 'appId'].includes(entry.key.trim())
          && entry.value.trim()
        )
      )) && new Set(metadataKeys).size === metadataKeys.length;
      return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(repository.id.trim())
        && repository.url.trim()
        && repository.name.trim()
        && repository.appId.trim()
        && repository.jiraBoard.trim()
        && metadataValid;
    });
  const formReady = Boolean(
    baseDirectory
    && workspaceName.trim()
    && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(workspaceId.trim())
    && validRepositories
    && repositories[leadIndex]
  );
  const missingWorkspaceFields = [
    !workspaceName.trim() && 'workspace name',
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(workspaceId.trim()) && 'valid workspace ID',
    !baseDirectory && 'local working directory',
    !validRepositories && 'complete repository details'
  ].filter(Boolean);

  return <div className="page workspace-page">
    <header className="page-heading row-between"><div><span className="eyebrow">One place for project setup</span><h1>Workspace configuration</h1><p>Create as many isolated workspaces as you need. Each workspace has one lead Git repository for Epic-level artifacts and any number of participating repositories.</p></div>{health && <Pill tone={health.healthy ? 'good' : 'warn'}>{health.healthy ? 'Workspace healthy' : 'Needs attention'}</Pill>}</header>

    {data.workspaceSetup?.mode?.startsWith('saved') && <div className={`workspace-save-result ${data.workspaceSetup.mode === 'saved-needs-repair' ? 'warning' : 'success'}`} role="status"><span>{data.workspaceSetup.mode === 'saved-needs-repair' ? '!' : '✓'}</span><div><strong>Workspace configuration saved</strong><small>{data.workspaceSetup.message}</small></div></div>}

    {health && <section className="workspace-current panel">
      <header className="workspace-current-head"><div><span className="workspace-anchor-type">Active workspace</span><h2>{health.workspace.name}</h2><p>{health.workspace.path}</p></div><div className="workspace-actions"><button className="ghost" onClick={refreshHealth}>Refresh health</button><button className="secondary" onClick={sync}>Fetch remotes</button><button className="secondary" onClick={stageDocuments}>Stage documents</button>{!health.healthy && <button className="primary" onClick={repair}>Repair missing clones</button>}</div></header>
      <div className="workspace-health-grid">
        <div><span>Repositories</span><strong>{health.counts.ready}/{health.counts.repositories}</strong><small>ready</small></div>
        <div><span>Dirty clones</span><strong>{health.counts.dirty}</strong><small>never auto-updated</small></div>
        <div><span>Staged documents</span><strong>{health.counts.stagedDocuments}</strong><small>not governed</small></div>
        <div><span>Epic artifact home</span><strong>{health.workspace.leadRepository}</strong><small>{health.leadRepositoryPath}</small></div>
      </div>
      <div className="workspace-repository-list">{health.repositories.map((repository) => <div key={repository.id}><span className={`workspace-state ${repository.state}`} /><div><strong>{repository.metadata?.name ?? repository.id}</strong><small>{repository.metadata?.appId} · Jira {repository.jira?.board ?? 'not set'} · {repository.absolutePath}</small></div><Pill tone={repository.role === 'lead' ? 'accent' : 'neutral'}>{repository.role === 'lead' ? 'Epic lead' : 'participant'}</Pill><span>{repository.branch ?? 'not cloned'}</span><span className={repository.dirty ? 'warning-copy' : ''}>{repository.dirty == null ? '—' : repository.dirty ? 'dirty' : 'clean'}</span><Pill tone={repository.state === 'ready' ? 'good' : 'warn'}>{repository.state}</Pill></div>)}</div>
      {!!health.stagedDocuments.length && <div className="workspace-staged"><header><div><span className="eyebrow">Local document inbox</span><h3>Staged — not governed</h3><p>{canPromoteDocuments ? `Import into checked-out work item ${data.workflow.workItem.id} to commit and push a governed copy.` : 'Resume a work item and select a session persona before importing these files.'}</p></div><Pill tone="warn">{health.stagedDocuments.length} local</Pill></header>{health.stagedDocuments.map((document) => <div key={document.path}><strong>{document.name}</strong><code>{document.sha256.slice(0, 12)}</code><span>{document.bytes.toLocaleString()} bytes</span><button className="secondary compact" disabled={!canPromoteDocuments} onClick={() => promoteDocument(document)}>Import to work item</button></div>)}</div>}
    </section>}

    {!!recentWorkspaces.length && <RecentWorkspaces items={recentWorkspaces} currentPath={health?.workspace?.path} busy={false} onOpen={onOpenWorkspace} onForget={onForgetWorkspace} />}

    <section className="workspace-create panel">
      <header className="panel-heading"><div><span className="eyebrow">New workspace</span><h2>Define the project boundary once</h2><p>Jira connection and initiative governance are not separate setup steps. Repository routing lives here.</p></div><Pill>{repositories.length} repositories</Pill></header>
      <div className={`workspace-save-callout ${formReady ? 'ready' : ''}`}>
        <div><span className="eyebrow">Workspace action</span><strong>Save workspace</strong><small>{formReady ? 'All required details are ready. Review the clone plan, confirm the workspace ID, and save.' : `Complete: ${missingWorkspaceFields.join(', ')}.`}</small></div>
        <button className="primary" disabled={!formReady} onClick={buildPreview}>{preview ? 'Refresh save plan' : 'Review & save workspace'}</button>
      </div>
      <div className="workspace-identity-grid">
        <label><span>Workspace name</span><input value={workspaceName} placeholder="Payments modernization" onChange={(event) => { setWorkspaceName(event.target.value); resetPreview(); }} /></label>
        <label><span>Workspace ID</span><input value={workspaceId} placeholder="payments-modernization" onChange={(event) => { setWorkspaceId(event.target.value); resetPreview(); }} /></label>
        <label className="workspace-directory-field"><span>Local working directory</span><div><input readOnly value={baseDirectory} placeholder="Choose a parent folder" /><button className="secondary" onClick={chooseBase}>{baseDirectory ? 'Change' : 'Choose'}</button></div></label>
      </div>
      <div className="workspace-repository-config">
        <header><div><span className="eyebrow">Repository registry</span><h3>Add delivery repositories</h3><p>Every repository requires its Jira project key, application identity, and exactly one lead designation.</p></div><div className="row"><button className="ghost compact" onClick={addRepositoryManually}>＋ Enter URL</button><button className="secondary compact" onClick={addRepositories}>＋ Add local repos</button></div></header>
        {repositories.map((repository, index) => <article className={`workspace-repository-editor ${leadIndex === index ? 'lead' : ''}`} key={`${index}-${repository.localPath}`}>
          <header><label className="workspace-lead-choice"><input type="radio" name="lead-repository" checked={leadIndex === index} onChange={() => { setLeadIndex(index); resetPreview(); }} /><span><strong>{leadIndex === index ? 'Lead repository' : 'Make lead'}</strong><small>{leadIndex === index ? 'Epic-level artifacts are committed here' : 'Participates in this workspace'}</small></span></label>{repositories.length > 1 && <button className="ghost compact" onClick={() => removeRepository(index)}>Remove</button>}</header>
          <div className="workspace-repository-fields">
            <label><span>Repository ID</span><input value={repository.id} placeholder="mobile" onChange={(event) => updateRepository(index, 'id', event.target.value)} /></label>
            <label><span>Display name</span><input value={repository.name} placeholder="Mobile application" onChange={(event) => updateRepository(index, 'name', event.target.value)} /></label>
            <label className="wide"><span>Git clone URL</span><input value={repository.url} placeholder="git@github.com:company/mobile.git" onChange={(event) => updateRepository(index, 'url', event.target.value)} /></label>
            <label><span>Default branch</span><input value={repository.defaultBranch} placeholder="main" onChange={(event) => updateRepository(index, 'defaultBranch', event.target.value)} /></label>
            <label><span>Jira project key</span><input value={repository.jiraBoard} placeholder="MOB" onChange={(event) => updateRepository(index, 'jiraBoard', event.target.value.toUpperCase())} /><small>For example, KAN from KAN-8—not the board name.</small></label>
            <label><span>Application ID</span><input value={repository.appId} placeholder="APP-1001" onChange={(event) => updateRepository(index, 'appId', event.target.value)} /></label>
          </div>
          <div className="workspace-metadata-editor"><header><div><strong>Additional metadata</strong><span>Optional repository-specific key/value pairs.</span></div><button className="ghost compact" onClick={() => addMetadata(index)}>＋ Add field</button></header>{repository.metadata.map((entry, metadataIndex) => <div key={metadataIndex}><input aria-label={`Repository ${index + 1} metadata key ${metadataIndex + 1}`} value={entry.key} placeholder="owner" onChange={(event) => updateMetadata(index, metadataIndex, 'key', event.target.value)} /><input aria-label={`Repository ${index + 1} metadata value ${metadataIndex + 1}`} value={entry.value} placeholder="Digital Channels" onChange={(event) => updateMetadata(index, metadataIndex, 'value', event.target.value)} /><button className="ghost compact" aria-label={`Remove metadata ${metadataIndex + 1}`} onClick={() => removeMetadata(index, metadataIndex)}>×</button></div>)}</div>
        </article>)}
      </div>
      {!validRepositories && <div className="workspace-form-note">Complete a unique repository ID, display name, Git URL, Jira project key, and Application ID for every repository.</div>}
      <div className="workspace-preview-actions" ref={saveActions}>{preview ? <><div className="workspace-save-plan"><strong>Save plan ready</strong><small>Clones will be created under this workspace only after exact confirmation.</small></div><code>{preview.root}</code><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder={`Type ${workspaceId}`} /><button className="primary" disabled={confirmation !== workspaceId.trim()} onClick={create}>Confirm & save workspace</button></> : <div className="workspace-save-plan"><strong>No save plan yet</strong><small>Complete the required fields, then use Review & save workspace above.</small></div>}</div>
      {preview && <div className="workspace-operation-list">{preview.operations.map((operation) => <div key={operation.repository}><Pill tone={operation.repository === repositories[leadIndex]?.id.trim() ? 'accent' : 'neutral'}>{operation.repository === repositories[leadIndex]?.id.trim() ? 'Epic lead' : 'clone'}</Pill><strong>{operation.repository}</strong><code>{operation.url}</code><span>{operation.target}</span></div>)}</div>}
    </section>
  </div>;
}

function JiraPolicySetup({ data, action, reload, onConfigured, onCancel }) {
  const existing = data.portfolio?.jira ?? {};
  const [values, setValues] = useState({
    deployment: existing.deployment ?? 'cloud',
    baseUrl: '',
    projectKey: existing.projectKey ?? '',
    writeMode: existing.writeMode ?? 'off'
  });
  const set = (name, value) => setValues((current) => ({ ...current, [name]: value }));
  const ready = /^https:\/\//i.test(values.baseUrl) && (!values.projectKey || /^[A-Z][A-Z0-9_-]{0,31}$/.test(values.projectKey));

  async function save() {
    let hostname;
    try {
      const parsed = new URL(values.baseUrl);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error();
      hostname = parsed.hostname.toLowerCase();
    } catch {
      return action(() => Promise.reject(new Error('Enter a Jira HTTPS URL without embedded credentials.')));
    }
    const document = YAML.parseDocument(data.portfolioText);
    document.setIn(['jira', 'enabled'], true);
    document.setIn(['jira', 'connection'], existing.connection ?? 'corporate-jira');
    document.setIn(['jira', 'deployment'], values.deployment);
    document.setIn(['jira', 'allowedHosts'], [hostname]);
    document.setIn(['jira', 'allowedProjects'], values.projectKey ? [values.projectKey] : []);
    document.setIn(['jira', 'authentication', 'permitted'], values.deployment === 'data-center' ? ['pat'] : ['user-token', 'service-account']);
    document.setIn(['jira', 'writeMode'], values.writeMode);
    document.setIn(['jira', 'write'], values.writeMode === 'approved');
    document.setIn(['jira', 'projectKey'], values.projectKey);
    const result = await action(
      () => window.singularity.saveFile(data.repository.root, data.portfolioPath, String(document)),
      'Jira policy saved and validated'
    );
    if (!result) return;
    const published = await action(
      () => window.singularity.publish(data.repository.root, 'Configure governed Jira access'),
      'Jira policy committed and pushed'
    );
    if (!published) return;
    onConfigured(values);
    await reload();
  }

  return <div className="page jira-policy-page">
    <header className="page-heading row-between"><div><span className="eyebrow">Jira setup · Step 1 of 2</span><h1>Enable Jira for this workspace</h1><p>Choose the governed Jira boundary first. Your account token is requested only after this policy validates.</p></div><button className="ghost" onClick={onCancel}>Back to Epic</button></header>
    <section className="jira-connect panel">
      <div className="jira-connect-copy"><span className="jira-mark">J</span><span className="eyebrow">Repository policy</span><h2>Define where Singularity may connect</h2><p>The allowed host and project are committed with the repository. Passwords and tokens never enter this file.</p><ul><li>HTTPS is mandatory.</li><li>Project scope is checked before reads and writes.</li><li>Story creation stays off unless explicitly enabled.</li></ul></div>
      <div className="jira-connect-form">
        <label><span>Deployment</span><select value={values.deployment} onChange={(event) => set('deployment', event.target.value)}><option value="cloud">Jira Cloud</option><option value="data-center">Jira Data Center</option></select></label>
        <label><span>Project key</span><input value={values.projectKey} placeholder="APP" onChange={(event) => set('projectKey', event.target.value.toUpperCase())} /></label>
        <label className="full"><span>Jira HTTPS URL</span><input value={values.baseUrl} placeholder="https://company.atlassian.net" onChange={(event) => set('baseUrl', event.target.value)} /></label>
        <label className="full"><span>Story write policy</span><select value={values.writeMode} onChange={(event) => set('writeMode', event.target.value)}><option value="off">Browse and import only</option><option value="preview">Preview and commit write plans</option><option value="approved">Apply explicitly approved write plans</option></select></label>
        <button className="primary full" disabled={!ready} onClick={save}>Save policy & enter credentials</button>
      </div>
    </section>
  </div>;
}

function JiraWorkspace({ data, action, reload, onConfigure, bootstrapPortfolio, onDone }) {
  const policy = data.portfolio?.jira;
  const repositoryIds = Object.keys(data.portfolio?.repositories ?? {});
  const [status, setStatus] = useState(null);
  const [connection, setConnection] = useState({
    name: policy?.connection ?? 'corporate-jira',
    deployment: policy?.deployment ?? 'cloud',
    baseUrl: '',
    email: '',
    token: '',
    authMode: policy?.deployment === 'data-center' ? 'pat' : 'user-token'
  });
  const [projects, setProjects] = useState([]);
  const [projectKey, setProjectKey] = useState(policy?.projectKey ?? '');
  const [epics, setEpics] = useState([]);
  const [selectedEpic, setSelectedEpic] = useState(null);
  const [stories, setStories] = useState([]);
  const [repositoryMap, setRepositoryMap] = useState({});
  const [initiativeId, setInitiativeId] = useState(data.selectedInitiativeId ?? data.initiatives?.[0]?.id ?? '');
  const [adoption, setAdoption] = useState(null);
  const [writePlan, setWritePlan] = useState(null);
  const [applyConfirmation, setApplyConfirmation] = useState('');

  useEffect(() => {
    let current = true;
    if (!policy?.enabled) return undefined;
    window.singularity.jiraStatus(data.repository.root)
      .then((result) => { if (current) setStatus(result); })
      .catch((error) => { if (current) setStatus({ error: error.message, credentials: { connected: false } }); });
    return () => { current = false; };
  }, [data.repository.root, policy?.enabled]);

  useEffect(() => {
    setInitiativeId(data.selectedInitiativeId ?? data.initiatives?.[0]?.id ?? '');
  }, [data.selectedInitiativeId, data.initiatives]);

  async function loadProjects(refresh = false) {
    const result = await action(() => window.singularity.jiraProjects(data.repository.root, '', refresh), refresh ? 'Jira projects refreshed' : null);
    if (!result) return;
    setProjects(result);
    const next = projectKey || policy.projectKey || result[0]?.key || '';
    setProjectKey(next);
    if (next) await loadEpics(next, refresh);
  }

  async function connect() {
    const result = await action(() => window.singularity.connectJira(data.repository.root, {
      name: connection.name,
      deployment: connection.deployment,
      baseUrl: connection.baseUrl,
      authMode: connection.authMode,
      email: connection.authMode === 'pat' ? null : connection.email,
      token: connection.token
    }), 'Jira connection verified and stored securely');
    if (!result) return;
    setConnection((current) => ({ ...current, token: '' }));
    setStatus({ policy, credentials: { connected: true, active: result.active, connection: result.connection } });
    setProjects(result.discovery.projects ?? []);
    const next = projectKey || policy.projectKey || result.discovery.projects?.[0]?.key || '';
    setProjectKey(next);
    if (next) await loadEpics(next, true);
  }

  async function disconnect() {
    const result = await action(() => window.singularity.disconnectJira(data.repository.root, status?.credentials?.selected), 'Jira credentials removed from this OS account');
    if (result) {
      setStatus({ policy, credentials: result });
      setProjects([]); setEpics([]); setStories([]); setSelectedEpic(null);
    }
  }

  async function resetCredentials() {
    const result = await action(
      () => window.singularity.resetJiraCredentials(data.repository.root),
      'Unreadable Jira credentials removed; reconnect when ready'
    );
    if (result) {
      setStatus({ policy, credentials: result });
      setProjects([]); setEpics([]); setStories([]); setSelectedEpic(null);
    }
  }

  async function loadEpics(key = projectKey, refresh = false) {
    if (!key) return;
    const result = await action(() => window.singularity.jiraEpics(data.repository.root, key, refresh), refresh ? `${key} refreshed` : null);
    if (result) { setProjectKey(key); setEpics(result); setSelectedEpic(null); setStories([]); setAdoption(null); }
  }

  async function chooseEpic(epic) {
    setSelectedEpic(epic);
    setAdoption(null); setWritePlan(null);
    const result = await action(() => window.singularity.jiraChildren(data.repository.root, epic.key));
    if (!result) return;
    setStories(result);
    const fallback = repositoryIds.length === 1 ? repositoryIds[0] : '';
    setRepositoryMap(Object.fromEntries(result.map((story) => [story.key, fallback])));
  }

  async function previewAdoption() {
    if (!initiativeId || !selectedEpic) return;
    const result = await action(() => window.singularity.previewJiraAdoption(data.repository.root, initiativeId, selectedEpic.key, repositoryMap));
    if (result) setAdoption(result);
  }

  async function adopt() {
    const result = await action(() => window.singularity.adoptJiraEpic(data.repository.root, initiativeId, selectedEpic.key, repositoryMap), `${selectedEpic.key} adopted and pushed`);
    if (!result) return;
    setAdoption(result);
    await reload(null, initiativeId);
  }

  async function planWrites() {
    const result = await action(() => window.singularity.createJiraWritePlan(data.repository.root, initiativeId), 'Jira write plan committed and pushed');
    if (result) setWritePlan(result.plan);
  }

  async function applyWrites() {
    if (!writePlan || applyConfirmation !== initiativeId) return;
    const result = await action(() => window.singularity.applyJiraWritePlan(data.repository.root, initiativeId, writePlan.sha256, applyConfirmation), 'Jira write plan applied and receipts pushed');
    if (!result) return;
    setWritePlan(result.plan);
    setApplyConfirmation('');
    await reload(null, initiativeId);
    if (selectedEpic) await chooseEpic(selectedEpic);
  }

  if (!data.portfolio) return <div className="page"><PortfolioSetup data={data} action={action} onCreated={async (snapshot, setup) => {
    const published = await action(
      () => window.singularity.publish(data.repository.root, 'Initialize governed Jira access'),
      'Jira policy committed and pushed'
    );
    if (!published) return;
    setConnection((current) => ({
      ...current,
      deployment: setup.deployment,
      baseUrl: setup.baseUrl,
      authMode: setup.deployment === 'data-center' ? 'pat' : 'user-token'
    }));
    bootstrapPortfolio(await reload() ?? snapshot);
  }} jiraFirst onCancel={onDone} /></div>;
  if (!policy?.enabled) return <JiraPolicySetup data={data} action={action} reload={reload} onConfigured={(setup) => setConnection((current) => ({
    ...current,
    deployment: setup.deployment,
    baseUrl: setup.baseUrl,
    authMode: setup.deployment === 'data-center' ? 'pat' : 'user-token'
  }))} onCancel={onDone} />;

  const connected = status?.credentials?.connected;
  return <div className="page jira-page">
    <header className="page-heading row-between"><div><span className="eyebrow">Secure corporate integration</span><h1>Jira workspace</h1><p>Credentials stay in the operating-system keychain. Every import is hash-snapshotted; every write is previewed, confirmed, committed, and receipted.</p></div><div className="row gap"><button className="ghost compact" onClick={onDone}>Back to Epic</button><button className="ghost compact" onClick={onConfigure}>Policy YAML</button>{connected && <><Pill tone="good">Connected</Pill><button className="secondary compact" onClick={() => loadProjects(true)}>↻ Refresh</button><button className="ghost compact" onClick={disconnect}>Disconnect</button></>}</div></header>
    {!connected ? status?.credentials?.recovery?.required ? <section className="jira-credential-recovery panel" role="alert">
      <span className="jira-mark">!</span>
      <div><span className="eyebrow">Local credential recovery</span><h2>Jira credentials cannot be read</h2><p>{status.credentials.recovery.message}</p><p>Reset removes only the unreadable encrypted Jira file from this operating-system account. Repository configuration and Git state are unchanged.</p></div>
      <button className="primary" onClick={resetCredentials}>Reset Jira credentials</button>
      </section> : <section className="jira-connect panel"><div className="jira-connect-copy"><span className="jira-mark">J</span><span className="eyebrow">One-time setup</span><h2>Connect your Jira account</h2><p>{policy.deployment === 'cloud' ? 'Use an Atlassian API token. The renderer never receives it again after this form is submitted.' : 'Use a Jira Data Center personal access token. Password authentication is not supported.'}</p><ul><li>HTTPS and repository host allowlists are enforced.</li><li>Permissions are discovered before writes.</li><li>Tokens never enter Git, CLI child environments, logs, or planning prompts.</li></ul></div><div className="jira-connect-form"><label><span>Connection name · repository policy</span><input value={connection.name} readOnly /></label><label><span>Deployment</span><select value={connection.deployment} onChange={(event) => { const deployment = event.target.value; setConnection({ ...connection, deployment, authMode: deployment === 'data-center' ? 'pat' : 'user-token' }); }}><option value="cloud">Jira Cloud</option><option value="data-center">Jira Data Center</option></select></label><label className="full"><span>Jira HTTPS URL</span><input placeholder="https://company.atlassian.net" value={connection.baseUrl} onChange={(event) => setConnection({ ...connection, baseUrl: event.target.value })} /></label>{connection.authMode !== 'pat' && <label className="full"><span>Account email</span><input type="email" autoComplete="username" value={connection.email} onChange={(event) => setConnection({ ...connection, email: event.target.value })} /></label>}<label><span>Authentication</span><select value={connection.authMode} onChange={(event) => setConnection({ ...connection, authMode: event.target.value })}>{connection.deployment === 'cloud' ? <><option value="user-token">User API token</option><option value="service-account">Service account token</option></> : <option value="pat">Personal access token</option>}</select></label><label><span>{connection.authMode === 'pat' ? 'PAT' : 'API token'}</span><input type="password" autoComplete="current-password" value={connection.token} onChange={(event) => setConnection({ ...connection, token: event.target.value })} /></label><button className="primary full" disabled={!connection.baseUrl || !connection.token || (connection.authMode !== 'pat' && !connection.email)} onClick={connect}>Test connection & save securely</button>{status?.error && <p className="warning-copy full">{status.error}</p>}</div></section> : <>
      <section className="jira-context-strip"><div><span>Connection</span><strong>{status.credentials.connection?.name}</strong><small>{status.credentials.connection?.baseUrl}</small></div><div><span>Account</span><strong>{status.credentials.connection?.account?.displayName ?? status.credentials.connection?.email}</strong><small>{status.credentials.connection?.authMode}</small></div><div><span>Policy</span><strong>{policy.writeMode} writes</strong><small>{policy.allowedProjects?.length ? `${policy.allowedProjects.length} allowed projects` : 'all visible projects'}</small></div><div><span>Cache</span><strong>{policy.read.cacheMinutes} minutes</strong><small>manual refresh available</small></div></section>
      <div className="jira-browser">
        <aside className="jira-projects panel"><header><span className="eyebrow">Scope</span><h2>Projects</h2></header>{!projects.length && <button className="primary" onClick={() => loadProjects()}>Load permitted projects</button>}{projects.map((project) => <button className={project.key === projectKey ? 'active' : ''} key={project.key} onClick={() => loadEpics(project.key)}><span>{project.key.slice(0, 2)}</span><div><strong>{project.name}</strong><small>{project.key} · {project.projectType ?? 'software'}</small></div></button>)}</aside>
        <section className="jira-epics panel"><header className="panel-heading"><div><span className="eyebrow">Existing Jira hierarchy</span><h2>{projectKey ? `${projectKey} Epics` : 'Choose a project'}</h2></div><span>{epics.length} visible</span></header>{!epics.length && projectKey && <div className="inline-empty">No Epics loaded. Refresh the project to query Jira.</div>}{epics.map((epic) => <button className={selectedEpic?.key === epic.key ? 'active' : ''} key={epic.key} onClick={() => chooseEpic(epic)}><StatusDot status={epic.statusCategory === 'Done' ? 'approved' : 'in_progress'} /><div><strong>{epic.key} — {epic.title}</strong><small>{epic.status ?? 'unknown status'} · updated {formatRecentTime(epic.updatedAt)}</small></div><span>→</span></button>)}</section>
        <aside className="jira-story-panel panel">{selectedEpic ? <><header><span className="eyebrow">Epic children</span><h2>{selectedEpic.key}</h2><p>{selectedEpic.title}</p></header><div className="jira-story-list">{stories.map((story) => <div key={story.key}><div><strong>{story.key}</strong><span>{story.title}</span><small>{story.issueType} · {story.status ?? 'unknown'}</small></div><label><span>Owning repository</span><select value={repositoryMap[story.key] ?? ''} onChange={(event) => setRepositoryMap({ ...repositoryMap, [story.key]: event.target.value })}><option value="">Choose repository…</option>{repositoryIds.map((id) => <option value={id} key={id}>{id}</option>)}</select></label></div>)}</div><label><span>Target Singularity initiative</span><select value={initiativeId} onChange={(event) => { setInitiativeId(event.target.value); setAdoption(null); }}><option value="">Choose initiative…</option>{data.initiatives.map((initiative) => <option value={initiative.id} key={initiative.id}>{initiative.id} — {initiative.title}</option>)}</select></label><div className="jira-actions"><button className="secondary" disabled={!initiativeId || stories.some((story) => !repositoryMap[story.key])} onClick={previewAdoption}>Preview adoption</button><button className="primary" disabled={!adoption?.ready} onClick={adopt}>Adopt into Git</button></div>{adoption && <div className={`jira-adoption ${adoption.ready ? 'ready' : 'warn'}`}><strong>{adoption.ready ? 'Ready to adopt' : 'Mapping incomplete'}</strong><span>{adoption.draft?.epics?.[0]?.stories?.length ?? adoption.breakdown?.stories?.length} stories · source {adoption.sourceSha256?.slice(0, 12)}</span>{adoption.unresolved?.length > 0 && <small>Map: {adoption.unresolved.map((item) => item.jiraKey).join(', ')}</small>}</div>}</> : <Empty title="Choose an Epic" detail="Its child stories, Jira status, and repository ownership controls will appear here." />}</aside>
      </div>
      {initiativeId && <section className="panel jira-write-plan"><header className="panel-heading"><div><span className="eyebrow">Governed outbound synchronization</span><h2>Jira write plan</h2></div><Pill tone={policy.writeMode === 'approved' ? 'warn' : 'neutral'}>{policy.writeMode}</Pill></header><p>Generate a hash-pinned diff from the approved Singularity story plan. No Jira mutation occurs until the plan phase is approved and the exact initiative ID and plan hash are confirmed.</p><div className="jira-plan-actions"><button className="secondary" disabled={policy.writeMode === 'off'} onClick={planWrites}>Generate & commit plan</button>{writePlan && <><code>{writePlan.sha256}</code><input aria-label="Exact initiative confirmation" placeholder={`Type ${initiativeId}`} value={applyConfirmation} onChange={(event) => setApplyConfirmation(event.target.value)} /><button className="primary" disabled={policy.writeMode !== 'approved' || applyConfirmation !== initiativeId} onClick={applyWrites}>Apply reviewed plan</button></>}</div>{writePlan && <div className="jira-operation-list">{writePlan.operations.map((operation) => <div key={operation.id}><Pill tone={operation.action.startsWith('create') ? 'accent' : 'warn'}>{operation.action}</Pill><strong>{operation.subject.jiraKey ?? operation.subject.id}</strong><span>{Object.keys(operation.fields ?? operation.issue ?? {}).join(', ')}</span></div>)}</div>}</section>}
    </>}
  </div>;
}

function Dashboard({ data }) {
  const p = data.progress;
  if (!data.workflow) return <Empty title="No work item selected" detail="Choose a work item above to see progress, approvals, usage, and supporting evidence." />;
  const current = data.workflow.phases[data.workflow.currentPhase];
  const simulation = data.workflowSimulations?.find((item) => item.id === data.workflow.workItem.workType);
  return <div className="page dashboard-page">
    <div className="hero-card">
      <div><div className="row gap"><Pill tone="accent">{data.workflow.workItem.workTypeLabel}</Pill><Pill>{data.workflow.status}</Pill></div><h1>{data.workflow.workItem.title}</h1><p className="muted">{data.workflow.workItem.id} · branch {data.workflow.workItem.branch}</p></div>
      <ProgressRing value={p.percentage} />
    </div>
    <div className="metrics">
      <div className="metric"><span>Current phase</span><strong>{current?.label ?? 'Complete'}</strong><small>{p.currentPosition} of {p.totalPhases}</small></div>
      <div className="metric"><span>Total elapsed</span><strong>{formatDuration(data.report?.elapsedMs)}</strong><small>{data.report?.completedAt ? 'workflow complete' : 'wall-clock so far'}</small></div>
      <div className="metric"><span>Approvals</span><strong>{p.approvedPhases}</strong><small>approved phases</small></div>
      <div className="metric"><span>Documents</span><strong>{p.documents}</strong><small>evidence items</small></div>
      <div className="metric"><span>Token usage</span><strong>{p.tokens.totalTokens || '—'}</strong><small>{p.tokens.totalTokens ? 'exact tokens' : 'unavailable'}</small></div>
    </div>
    {data.report && <WorkflowTiming report={data.report} />}
    {data.report && <CostDashboard report={data.report} pricing={data.definition.tokens?.pricing} telemetry={data.telemetry} />}
    {!!data.workflow.sequenceOverrides?.length && <div className="notice">⚠ {data.workflow.sequenceOverrides.length} confirmed soft sequence override(s) are recorded. Review the work-item report before final approval.</div>}
    {data.diagnostics && <section className={`health-strip ${data.diagnostics.healthy ? 'good' : 'warn'}`}><strong>{data.diagnostics.healthy ? 'Repository ready' : 'Setup needs attention'}</strong><span>{data.diagnostics.counts.pass} checks passed · {data.diagnostics.counts.warn} warnings · {data.diagnostics.counts.fail} failures</span></section>}
    <section className="panel"><header className="panel-heading"><div><span className="eyebrow">Lifecycle</span><h2>Phase progress</h2></div></header><div className="phase-list">
      {p.phases.map((phase) => { const timing = data.report?.phases.find((item) => item.id === phase.id); return <div className={`phase-row ${phase.id === p.currentPhase ? 'active' : ''}`} key={phase.id}><StatusDot status={phase.status} /><div className="phase-copy"><strong>{phase.label}</strong><span>{phase.id}</span></div><Pill>{phase.generation ? `Generation ${phase.generation}` : 'Not generated'}</Pill><span className="approval-count">{phase.approvals}/{phase.approvalsRequired} approvals</span><span className="phase-time">{formatDuration(timing?.elapsedMs)}</span><span className="phase-status">{phase.status.replaceAll('_', ' ')}</span></div>; })}
    </div></section>
    {simulation && <section className="panel contract-preview"><header className="panel-heading"><div><span className="eyebrow">Resolved preflight</span><h2>Workflow contract preview</h2></div><Pill>{simulation.inputsMode} inputs</Pill></header><div className="contract-grid">{simulation.phases.map((phase) => <div key={phase.id}><strong>{phase.label}</strong><code>{phase.template}</code><span>{phase.inputs.length ? `← ${phase.inputs.join(', ')}` : 'No phase inputs'} · {phase.minimumApprovals} approval(s)</span></div>)}</div></section>}
  </div>;
}

function ApprovalInbox({ data, busy, refresh, attach }) {
  const inbox = data.approvalInbox;
  const items = inbox?.items ?? [];
  return <div className="page inbox-page">
    <header className="page-heading row-between"><div><span className="eyebrow">Remote reviewer queue</span><h1>Pending approvals</h1><p>Committed work-item branches awaiting a governed decision, ordered by waiting time.</p></div><button className="secondary" onClick={refresh} disabled={busy}>↻ Fetch remote inbox</button></header>
    <div className="metrics inbox-metrics"><div className="metric"><span>Awaiting review</span><strong>{items.length}</strong><small>committed phases</small></div><div className="metric"><span>Remote</span><strong>{inbox?.remote ?? 'origin'}</strong><small>{inbox?.fetched ? 'freshly fetched' : 'fetch required'}</small></div><div className="metric"><span>Oldest wait</span><strong>{items[0]?.waiting ?? '—'}</strong><small>{items[0]?.id ?? 'nothing pending'}</small></div></div>
    {!items.length ? <Empty title="Inbox clear" detail="No committed remote work-item phase is awaiting approval. Fetch the remote inbox to check for new submissions." /> : <section className="panel inbox-panel"><div className="inbox-header"><span>Work item</span><span>Phase</span><span>Approvals</span><span>Waiting</span><span>Review personas</span><span /></div>{items.map((item) => <div className="inbox-row" key={`${item.id}:${item.phase}:${item.commit}`}><div><StatusDot status={item.status} /><span><strong>{item.id} — {item.title}</strong><small>{item.artifact ?? 'No required artifact'} · {item.commit?.slice(0, 8)}</small></span></div><span>{item.phaseLabel}<small>generation {item.generation}</small></span><span>{item.approvalsReceived}/{item.approvalsRequired}{item.selfApprovalWarning && <small className="warning-copy">self-approval</small>}</span><span>{item.waiting}</span><span>{item.reviewerPersonas.join(', ') || 'Any configured persona'}</span><button className="secondary compact" onClick={() => attach(item.id)} disabled={busy}>Open review</button></div>)}</section>}
  </div>;
}

function PlanningStudio({ data, action, reload, openPlanningPrompt, profileRole = null }) {
  const groups = data.planning?.targets ?? [];
  const defaultGroup = groups.find((item) => item.scope === 'initiative') ?? groups[0] ?? null;
  const [groupKey, setGroupKey] = useState(defaultGroup ? `${defaultGroup.scope}:${defaultGroup.id}` : '');
  const [phaseId, setPhaseId] = useState(defaultGroup?.currentPhase ?? '');
  const initialPhase = defaultGroup?.phases.find((phase) => phase.id === defaultGroup.currentPhase);
  const [targetId, setTargetId] = useState(initialPhase?.targets[0]?.id ?? '');
  const [persona, setPersona] = useState(data.session?.persona && data.definition.personas[data.session.persona]
    ? data.session.persona
    : preferredPersonaForRole(profileRole, data.definition.personas));
  const [objective, setObjective] = useState('');
  const [model, setModel] = useState('');
  const [preflight, setPreflight] = useState(null);
  const [contextPack, setContextPack] = useState(null);
  const [messages, setMessages] = useState([]);
  const [plan, setPlan] = useState('');
  const [followup, setFollowup] = useState('');
  const [running, setRunning] = useState(false);
  const [started, setStarted] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [usage, setUsage] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [logs, setLogs] = useState([]);
  const [activity, setActivity] = useState('Build a governed context pack to begin.');
  const transcriptRef = useRef('');
  const planRef = useRef('');
  const questionsRef = useRef([]);
  const group = groups.find((item) => `${item.scope}:${item.id}` === groupKey) ?? defaultGroup;
  const phase = group?.phases.find((item) => item.id === phaseId) ?? group?.phases.find((item) => item.current) ?? null;
  const target = phase?.targets.find((item) => item.id === targetId) ?? phase?.targets[0] ?? null;
  const currentReady = Boolean(group && phase?.current && phase.status === 'in_progress' && target);
  const storyPlanAnalysis = useMemo(
    () => target?.id === 'story-plan' && plan.trim() ? parseStoryPlan(plan) : null,
    [target?.id, plan]
  );

  useEffect(() => {
    let active = true;
    window.singularity.planningPreflight(data.repository.root)
      .then((result) => { if (active) setPreflight(result); })
      .catch((error) => { if (active) setPreflight({ ready: false, message: error.message }); });
    return () => { active = false; };
  }, [data.repository.root]);

  useEffect(() => {
    const available = data.planning?.targets ?? [];
    const selected = available.find((item) => `${item.scope}:${item.id}` === groupKey)
      ?? available.find((item) => item.scope === 'initiative')
      ?? available[0];
    if (!selected) return;
    if (`${selected.scope}:${selected.id}` !== groupKey) setGroupKey(`${selected.scope}:${selected.id}`);
    const selectedPhase = selected.phases.find((item) => item.id === selected.currentPhase) ?? selected.phases[0];
    setPhaseId(selectedPhase?.id ?? '');
    setTargetId(selectedPhase?.targets[0]?.id ?? '');
    setContextPack(null);
    setStarted(false);
  }, [data.selectedWorkId, data.selectedInitiativeId]);

  useEffect(() => {
    if (!window.singularity.onPlanningEvent) return undefined;
    return window.singularity.onPlanningEvent((event) => {
      if (!contextPack || event.planningSessionId !== contextPack.sessionId) return;
      if (!['agent_message_chunk', 'user_message_chunk', 'plan', 'plan_update'].includes(event.type)) {
        const entry = planningLogEntry(event);
        setLogs((current) => {
          const last = current.at(-1);
          if (last?.type === entry.type && ['agent_thought_chunk', 'tool_call_update', 'diagnostic'].includes(entry.type)) {
            return [...current.slice(0, -1), { ...last, detail: `${last.detail}${entry.detail}`.slice(-4000), at: entry.at }];
          }
          return [...current.slice(-299), entry];
        });
      }
      if (event.type === 'ready') {
        setStarted(true);
        setRunning(true);
        setActivity(`Copilot ${event.version ?? ''} connected in native Plan mode.`);
      } else if (event.type === 'turn-started') {
        setRunning(true);
        setActivity('Copilot is inspecting governed phase context…');
      } else if (event.type === 'agent_message_chunk' && event.text) {
        transcriptRef.current += event.text;
        setMessages((current) => {
          const last = current.at(-1);
          if (last?.role === 'assistant' && last.id === (event.messageId ?? 'assistant')) {
            return [...current.slice(0, -1), { ...last, text: `${last.text}${event.text}` }];
          }
          return [...current, { role: 'assistant', id: event.messageId ?? `assistant-${current.length}`, text: event.text }];
        });
      } else if (event.type === 'user_message_chunk' && event.text) {
        setMessages((current) => [...current, { role: 'user', id: event.messageId ?? `user-${current.length}`, text: event.text }]);
      } else if (event.type === 'question') {
        const question = {
          id: event.questionId,
          native: true,
          message: event.message,
          schema: event.schema,
          status: 'pending'
        };
        questionsRef.current = [...questionsRef.current, question];
        setQuestions(questionsRef.current);
        setActivity('Copilot needs your decision before it can finish the plan.');
      } else if (event.type === 'question-answered') {
        questionsRef.current = questionsRef.current.map((question) => question.id === event.questionId ? { ...question, status: event.action } : question);
        setQuestions(questionsRef.current);
      } else if ((event.type === 'plan' || event.type === 'plan_update') && event.plan) {
        planRef.current = event.plan;
        setPlan(event.plan);
        setActivity('Copilot produced a structured plan. Review and refine it before promotion.');
      } else if (event.type === 'plan_removed') {
        planRef.current = '';
        setPlan('');
        setReviewed(false);
        setActivity('Copilot withdrew its structured plan; continue the conversation to produce a replacement.');
      } else if (event.type === 'tool_call') {
        setActivity(`${event.title} · ${event.status}`);
      } else if (event.type === 'permission-denied') {
        setActivity(`${event.title} was blocked by Planning Studio read-only policy.`);
      } else if (event.type === 'usage_update') {
        setUsage((current) => ({
          ...(current ?? {}),
          contextTokens: event.usage?.used ?? null,
          contextWindow: event.usage?.size ?? null,
          cost: event.usage?.cost ?? current?.cost ?? null
        }));
      } else if (event.type === 'turn-complete') {
        setRunning(false);
        setUsage((current) => ({ ...(current ?? {}), ...(event.usage ?? {}) }));
        const unansweredNative = questionsRef.current.some((question) => question.native && question.status === 'pending');
        const fallbackQuestions = unansweredNative ? [] : extractCopilotQuestions(transcriptRef.current);
        if (fallbackQuestions.length && !planRef.current.trim()) {
          const existing = new Set(questionsRef.current.map((question) => question.message.toLowerCase()));
          const additions = fallbackQuestions.filter((question) => !existing.has(question.toLowerCase())).map((question, index) => ({
            id: `fallback-${Date.now()}-${index}`,
            native: false,
            message: question,
            schema: { type: 'object', properties: { answer: { type: 'string', title: 'Your answer' } }, required: ['answer'] },
            status: 'pending'
          }));
          questionsRef.current = [...questionsRef.current, ...additions];
          setQuestions(questionsRef.current);
          setActivity('Copilot asked for clarification. Answer here to continue the same planning session.');
        } else if (!planRef.current.trim() && transcriptRef.current.trim()) {
          planRef.current = transcriptRef.current.trim();
          setPlan(planRef.current);
          setActivity(`Planning turn completed: ${event.stopReason}.`);
        } else {
          setActivity(`Planning turn completed: ${event.stopReason}.`);
        }
      } else if (event.type === 'error') {
        setRunning(false);
        setActivity(`Copilot error: ${event.message}`);
      } else if (event.type === 'process-exit' && started) {
        setRunning(false);
        setStarted(false);
      }
    });
  }, [contextPack?.sessionId, started]);

  function resetSession() {
    setContextPack(null);
    setMessages([]);
    setPlan('');
    planRef.current = '';
    transcriptRef.current = '';
    setStarted(false);
    setRunning(false);
    setReviewed(false);
    setUsage(null);
    questionsRef.current = [];
    setQuestions([]);
    setLogs([]);
  }

  function selectGroup(value) {
    const selected = groups.find((item) => `${item.scope}:${item.id}` === value);
    setGroupKey(value);
    const selectedPhase = selected?.phases.find((item) => item.current) ?? selected?.phases[0];
    setPhaseId(selectedPhase?.id ?? '');
    setTargetId(selectedPhase?.targets[0]?.id ?? '');
    resetSession();
  }

  function selectPhase(value) {
    setPhaseId(value);
    const selected = group?.phases.find((item) => item.id === value);
    setTargetId(selected?.targets[0]?.id ?? '');
    resetSession();
  }

  async function buildContext() {
    const result = await action(() => window.singularity.buildPlanningContext(data.repository.root, {
      scope: group.scope,
      id: group.id,
      phase: phase.id,
      persona,
      target: target.id,
      objective
    }), 'Governed planning context built');
    if (!result) return;
    setContextPack(result);
    setMessages([]);
    setPlan('');
    planRef.current = '';
    transcriptRef.current = '';
    setReviewed(false);
    questionsRef.current = [];
    setQuestions([]);
    setLogs([]);
    setActivity(`${result.manifest.sources.length} hashed sources ready for Copilot.`);
  }

  async function startCopilot() {
    setRunning(true);
    const result = await action(() => window.singularity.startPlanningSession(data.repository.root, contextPack.sessionId, model), 'Copilot Plan mode connected');
    if (!result) setRunning(false);
  }

  async function sendFollowup() {
    const text = followup.trim();
    if (!text) return;
    setMessages((current) => [...current, { role: 'user', id: `followup-${Date.now()}`, text }]);
    transcriptRef.current = '';
    setFollowup('');
    setRunning(true);
    const result = await action(() => window.singularity.promptPlanningSession(data.repository.root, contextPack.sessionId, text));
    if (!result) setRunning(false);
  }

  async function answerQuestion(question, values) {
    if (question.native) {
      const result = await action(() => window.singularity.answerPlanningQuestion(
        data.repository.root,
        contextPack.sessionId,
        question.id,
        values,
        'accept'
      ), 'Answer sent to Copilot');
      if (!result) return;
      setMessages((current) => [...current, {
        role: 'user',
        id: `answer-${question.id}`,
        text: `${question.message}\n${Object.entries(values).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`).join('\n')}`
      }]);
      return;
    }
    questionsRef.current = questionsRef.current.map((item) => item.id === question.id ? { ...item, status: 'accept' } : item);
    setQuestions(questionsRef.current);
    const text = `Answer to your clarification question "${question.message}": ${values.answer}. Continue the governed planning analysis and produce the complete configured artifact.`;
    setMessages((current) => [...current, { role: 'user', id: `answer-${question.id}`, text }]);
    transcriptRef.current = '';
    setRunning(true);
    const result = await action(() => window.singularity.promptPlanningSession(data.repository.root, contextPack.sessionId, text));
    if (!result) setRunning(false);
  }

  async function dismissQuestion(question) {
    questionsRef.current = questionsRef.current.map((item) => item.id === question.id ? { ...item, status: 'decline' } : item);
    setQuestions(questionsRef.current);
    if (question.native) {
      await action(() => window.singularity.answerPlanningQuestion(
        data.repository.root,
        contextPack.sessionId,
        question.id,
        null,
        'decline'
      ), 'Question skipped');
      return;
    }
    const text = `I am not providing an answer to "${question.message}". Continue by recording the uncertainty and the safest explicit assumption in the governed plan.`;
    setMessages((current) => [...current, { role: 'user', id: `decline-${question.id}`, text }]);
    transcriptRef.current = '';
    setRunning(true);
    const result = await action(() => window.singularity.promptPlanningSession(data.repository.root, contextPack.sessionId, text));
    if (!result) setRunning(false);
  }

  async function stopCopilot() {
    await action(() => window.singularity.stopPlanningSession(data.repository.root, contextPack.sessionId), 'Planning context released; the Copilot backend remains ready');
    setRunning(false);
    setStarted(false);
  }

  async function promote() {
    const result = await action(
      () => window.singularity.promotePlanningArtifact(data.repository.root, contextPack.sessionId, persona, plan),
      `Reviewed plan promoted to ${target.path}, committed, and pushed`
    );
    if (!result) return;
    setReviewed(false);
    await reload(data.selectedWorkId, data.selectedInitiativeId);
  }

  if (!groups.length) return <div className="page"><Empty title="Select governed work first" detail="Choose a story work item or initiative from the top bar. Planning Studio will then expose its current phase, exact outputs, personas, world model, approved inputs, and repository boundaries." /></div>;
  return <div className="page planning-page">
    <header className="page-heading planning-heading"><div><span className="eyebrow">Copilot-native decision workspace</span><h1>Planning Studio</h1><p>Move from business intent to a reviewable, phase-specific plan without allowing the planning session to mutate source or lifecycle state.</p></div><div className="row"><Pill tone={preflight?.ready ? 'good' : 'warn'}>{preflight?.ready ? 'Copilot Plan mode ready' : 'Copilot setup needed'}</Pill><button className="secondary" onClick={openPlanningPrompt}>Edit planning prompt</button></div></header>
    <section className="planning-safety">
      <span>◈</span><div><strong>Read-only reasoning; explicit Git-backed promotion</strong><p>Copilot receives the selected phase context through ACP in native Plan mode. The chat stays local. Only the reviewed artifact you promote is written, audited, committed, and pushed.</p></div>
    </section>
    <div className="planning-layout">
      <aside className="planning-controls">
        <section className="panel">
          <header className="panel-heading"><div><span className="eyebrow">1 · Frame</span><h2>Planning target</h2></div></header>
          <div className="planning-form">
            <label><span>Work</span><select disabled={started || running} value={groupKey} onChange={(event) => selectGroup(event.target.value)}>{groups.map((item) => <option key={`${item.scope}:${item.id}`} value={`${item.scope}:${item.id}`}>{item.scope === 'initiative' ? 'Initiative' : 'Story'} · {item.id}</option>)}</select></label>
            <label><span>Phase</span><select disabled={started || running} value={phase?.id ?? ''} onChange={(event) => selectPhase(event.target.value)}>{group.phases.map((item) => <option key={item.id} value={item.id}>{item.current ? '● ' : item.status === 'approved' ? '✓ ' : '○ '}{item.label} · {item.status.replaceAll('_', ' ')}</option>)}</select></label>
            <label><span>Promotion target</span><select disabled={started || running} value={target?.id ?? ''} onChange={(event) => { setTargetId(event.target.value); resetSession(); }}>{phase?.targets.map((item) => <option key={item.id} value={item.id}>{item.label} · {item.kind}</option>)}</select></label>
            <label><span>Persona for this plan</span><select disabled={started || running} value={persona} onChange={(event) => { setPersona(event.target.value); resetSession(); }}>{Object.entries(data.definition.personas).map(([id, item]) => <option key={id} value={id}>{item.label} · {id}</option>)}</select></label>
            <label><span>Planning objective</span><textarea disabled={started || running} rows="4" value={objective} onChange={(event) => { setObjective(event.target.value); setContextPack(null); }} placeholder={`What decision must ${phase?.label ?? 'this phase'} make?`} /></label>
            <label><span>Copilot model <em>optional</em></span><input disabled={started || running} value={model} onChange={(event) => setModel(event.target.value)} placeholder="auto" /></label>
            {!phase?.current && <div className="planning-blocker"><strong>Sequence protected</strong><span>The active phase is {group.currentPhase}. Future and approved phases are visible for orientation but cannot start a new plan.</span></div>}
            {phase?.current && phase.status !== 'in_progress' && <div className="planning-blocker"><strong>Phase is {phase.status.replaceAll('_', ' ')}</strong><span>Planning requires an in-progress phase. Complete its current lifecycle action first.</span></div>}
            <button className="primary full" disabled={!currentReady || !preflight?.ready || running} onClick={buildContext}>{contextPack ? 'Rebuild governed context' : 'Build governed context'}</button>
          </div>
        </section>
        <section className="panel planning-phase-map"><header className="panel-heading"><div><span className="eyebrow">Phase map</span><h2>{group.title}</h2></div></header>{group.phases.map((item, index) => <button disabled={started || running} key={item.id} className={`${item.id === phase?.id ? 'active' : ''} ${item.current ? 'current' : ''}`} onClick={() => selectPhase(item.id)}><span>{item.status === 'approved' ? '✓' : item.current ? '●' : index + 1}</span><div><strong>{item.label}</strong><small>{item.targets.length} promotable output{item.targets.length === 1 ? '' : 's'}</small></div></button>)}</section>
      </aside>
      <main className="planning-workbench">
        <section className="panel planning-context">
          <header className="panel-heading"><div><span className="eyebrow">2 · Ground</span><h2>Context manifest</h2></div>{contextPack ? <Pill tone={contextPack.warnings.length ? 'warn' : 'good'}>{contextPack.manifest.sources.length} hashed sources</Pill> : <Pill>not built</Pill>}</header>
          {!contextPack ? <div className="inline-empty">Choose the current phase, persona, output, and objective, then build the context. No content is sent to Copilot before this step.</div> : <>
            <div className="context-kpis"><div><span>Repository head</span><strong>{contextPack.manifest.repository.head.slice(0, 10)}</strong></div><div><span>Context</span><strong>{Math.ceil(contextPack.manifest.context.bytes / 1024)} KB</strong></div><div><span>Generation</span><strong>{contextPack.manifest.generation}</strong></div><div><span>Target</span><strong>{contextPack.target.kind}</strong></div></div>
            {!!contextPack.warnings.length && <div className="planning-warning">{contextPack.warnings.map((warning) => <span key={warning}>⚠ {warning}</span>)}</div>}
            <div className="context-source-list">{contextPack.manifest.sources.map((source, index) => <div key={`${source.kind}:${source.path}:${index}`}><span>{source.kind.replaceAll('-', ' ')}</span><strong title={source.path}>{source.path}</strong><code>{source.sha256?.slice(0, 12) ?? 'unavailable'}</code></div>)}</div>
            <details><summary>Inspect complete prompt sent to Copilot</summary><pre>{contextPack.context}</pre></details>
            <div className="planning-context-actions"><span>{contextPack.target.label} → <code>{contextPack.target.path}</code></span><button className="primary" disabled={running || started} onClick={startCopilot}>Start Copilot Plan mode</button></div>
          </>}
        </section>
        {storyPlanAnalysis && <StoryPlanAnalysis analysis={storyPlanAnalysis} />}
        <div className="planning-dual">
          <section className="panel planning-chat">
            <header className="panel-heading"><div><span className="eyebrow">3 · Explore</span><h2>Copilot conversation</h2></div><Pill tone={running ? 'accent' : started ? 'good' : 'neutral'}>{running ? 'thinking' : started ? 'connected' : 'local'}</Pill></header>
            <div className="planning-activity">{activity}</div>
            {questions.some((question) => question.status === 'pending') && <div className="copilot-question-stack">{questions.filter((question) => question.status === 'pending').map((question) => <CopilotQuestionCard key={question.id} question={question} disabled={!started} onAnswer={answerQuestion} onDismiss={dismissQuestion} />)}</div>}
            <div className="planning-messages">{messages.length ? messages.map((message, index) => <div className={message.role} key={`${message.id}:${index}`}><strong>{message.role === 'user' ? 'You' : 'Copilot'}</strong><pre>{message.text}</pre></div>) : <div className="inline-empty">The phase-aware conversation will appear here. Ask Copilot to challenge assumptions, compare options, or refine the decomposition.</div>}</div>
            <div className="planning-followup"><textarea rows="3" value={followup} onChange={(event) => setFollowup(event.target.value)} disabled={!started || running} placeholder="Challenge the plan, add a constraint, or ask for another option…" /><div><span>{usage?.totalTokens ? `${usage.totalTokens.toLocaleString()} session tokens` : usage?.contextTokens ? `${usage.contextTokens.toLocaleString()} / ${usage.contextWindow?.toLocaleString() ?? '—'} context tokens` : 'Exact usage appears here when ACP exposes it.'}{usage?.cost?.amount != null ? ` · ${usage.cost.currency ?? 'USD'} ${Number(usage.cost.amount).toFixed(4)}` : ''}</span><div className="row"><button className="ghost compact" disabled={!started} onClick={stopCopilot}>Stop</button><button className="secondary compact" disabled={!started || running || !followup.trim()} onClick={sendFollowup}>Send follow-up</button></div></div></div>
          </section>
          <section className="panel planning-review">
            <header className="panel-heading"><div><span className="eyebrow">4 · Govern</span><h2>Reviewed artifact</h2></div><Pill tone={plan.trim() ? 'accent' : 'neutral'}>{target?.kind ?? 'artifact'}</Pill></header>
            <textarea className="planning-editor" value={plan} onChange={(event) => { setPlan(event.target.value); planRef.current = event.target.value; setReviewed(false); }} placeholder="Copilot's proposed artifact will appear here. Edit it until it is ready to become governed repository state." />
            <div className="promotion-check"><label><input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} />I reviewed this complete artifact and want to promote it to <code>{target?.path}</code>.</label><small>Promotion does not submit or approve the phase. It creates and pushes an auditable planning commit; the normal phase gate remains next.</small></div>
            <button className="primary full" disabled={!contextPack || running || !reviewed || !plan.trim()} onClick={promote}>Promote, commit & push</button>
          </section>
        </div>
        <details className="panel planning-console">
          <summary><span><b>⌘</b><strong>Copilot logs</strong><small>IDE-style diagnostics, tool activity, thinking status, and session events</small></span><Pill>{logs.length} events</Pill></summary>
          <div className="planning-console-toolbar"><span>Read-only local session diagnostics</span><button className="ghost compact" onClick={() => setLogs([])}>Clear</button></div>
          <div className="planning-console-lines">{logs.length ? logs.map((entry, index) => <div className={entry.level} key={`${entry.id}:${index}`}><time>{new Date(entry.at).toLocaleTimeString()}</time><code>{entry.type}</code><pre>{entry.detail}</pre></div>) : <div className="inline-empty">Copilot events will appear here after the session starts.</div>}</div>
        </details>
      </main>
    </div>
  </div>;
}

function EpicSourcesView({ data, selected, action, reload }) {
  const providers = Object.entries(selected.state.resolution.storage?.providers ?? {});
  const [providerId, setProviderId] = useState(selected.state.resolution.storage?.defaultProvider ?? providers[0]?.[0] ?? '');
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [token, setToken] = useState('');
  const [credentials, setCredentials] = useState([]);
  const [verification, setVerification] = useState(null);
  const sources = selected.sources?.sources ?? [];
  const provider = selected.state.resolution.storage?.providers?.[providerId];
  const credential = credentials.find((entry) => entry.providerId === providerId);
  useEffect(() => {
    let active = true;
    window.singularity.epicSources(data.repository.root, selected.state.initiative.id)
      .then((result) => { if (active) setCredentials(result.credentials ?? []); })
      .catch(() => { if (active) setCredentials([]); });
    return () => { active = false; };
  }, [data.repository.root, selected.state.initiative.id]);
  async function upload() {
    const result = await action(
      () => window.singularity.uploadEpicSources(data.repository.root, selected.state.initiative.id, providerId),
      'Pinned source files uploaded and published'
    );
    if (result && !result.canceled) await reload(null, selected.state.initiative.id);
  }
  async function addUrl() {
    const result = await action(
      () => window.singularity.addEpicSourceUrl(data.repository.root, selected.state.initiative.id, providerId, url.trim(), label.trim() || null),
      'Pinned source URL registered and published'
    );
    if (result) {
      setUrl('');
      setLabel('');
      await reload(null, selected.state.initiative.id);
    }
  }
  async function verify() {
    const result = await action(
      () => window.singularity.verifyEpicSources(data.repository.root, selected.state.initiative.id, providerId, true),
      'Every accessible source was downloaded and checked against its pinned hash'
    );
    if (result) setVerification(result);
  }
  async function saveCredential() {
    const result = await action(
      () => window.singularity.saveEpicStorageCredential(data.repository.root, providerId, token),
      `Credential for ${providerId} stored with operating-system encryption`
    );
    if (result) {
      setToken('');
      const status = await window.singularity.epicSources(data.repository.root, selected.state.initiative.id);
      setCredentials(status.credentials ?? []);
    }
  }
  async function connectSharePoint() {
    const result = await action(
      () => window.singularity.connectEpicSharePoint(data.repository.root, selected.state.initiative.id, providerId),
      `Microsoft SharePoint connected through delegated OAuth PKCE`
    );
    if (result) {
      const status = await window.singularity.epicSources(data.repository.root, selected.state.initiative.id);
      setCredentials(status.credentials ?? []);
    }
  }
  async function disconnectStorage() {
    const result = await action(
      () => window.singularity.disconnectEpicStorage(data.repository.root, providerId),
      `${providerId} disconnected from this operating-system account`
    );
    if (result) setCredentials((current) => current.filter((entry) => entry.providerId !== providerId));
  }
  return <div className="epic-workspace-view">
    <section className="panel epic-source-hero"><div><span className="eyebrow">Immutable source lineage</span><h2>Requirements begin with pinned evidence</h2><p>Files stay in approved shared storage. Git records the provider version, SHA-256, size, MIME type, and uploader—not the file bytes.</p></div><div className="source-provider-controls"><label><span>Storage provider</span><select value={providerId} onChange={(event) => setProviderId(event.target.value)}>{providers.map(([id, item]) => <option value={id} key={id}>{id} · {item.type}</option>)}</select></label><button className="primary" onClick={upload} disabled={!providerId || provider?.type === 'https-reference'}>＋ Add source files</button><button className="secondary" onClick={verify} disabled={!sources.length}>Verify all hashes</button></div></section>
    {provider?.type === 'artifactory' && <section className="panel storage-credential-card"><div><span className="eyebrow">OS-protected credential</span><h3>{providerId}</h3><p>The renderer never receives a saved token. It is decrypted only in Electron’s main process for this provider.</p></div><input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Artifactory access token" /><div className="row"><button className="secondary" disabled={!token.trim()} onClick={saveCredential}>Save securely</button>{credential?.connected && <button className="ghost" onClick={disconnectStorage}>Disconnect</button>}</div></section>}
    {provider?.type === 'sharepoint' && <section className="panel storage-credential-card"><div><span className="eyebrow">Microsoft delegated identity</span><h3>{providerId}</h3><p>Sign-in opens in your system browser using OAuth 2.0 PKCE. Access and refresh tokens remain OS-encrypted in Electron’s main process.</p></div><div className="sharepoint-connection-state"><Pill tone={credential?.connected ? 'good' : 'warn'}>{credential?.connected ? 'connected' : 'sign-in required'}</Pill><span>{credential?.expiresAt ? `Access token refreshes after ${new Date(credential.expiresAt).toLocaleString()}` : 'Your administrator supplies the public-client ID in portfolio.yml.'}</span></div><div className="row"><button className="primary" onClick={connectSharePoint}>{credential?.connected ? 'Sign in again' : 'Sign in with Microsoft'}</button>{credential?.connected && <button className="ghost" onClick={disconnectStorage}>Disconnect</button>}</div></section>}
    {provider?.type === 'https-reference' && <section className="panel epic-source-url"><label><span>HTTPS source URL</span><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://approved.example/specification.pdf" /></label><label><span>Label</span><input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Customer journey specification" /></label><button className="primary" disabled={!url.trim()} onClick={addUrl}>Pin URL version</button></section>}
    {verification && <div className={`notice ${verification.valid ? 'good' : 'warn'}`}>{verification.valid ? 'All source bytes match their committed hashes.' : 'One or more sources are unavailable or changed. Blocking planning gates will not pass.'}</div>}
    <section className="panel epic-source-list"><header className="panel-heading"><div><span className="eyebrow">Source catalog</span><h2>Pinned source versions · {sources.length}</h2></div><Pill tone={sources.length ? 'good' : 'warn'}>{sources.length ? 'pinned' : 'source gap'}</Pill></header>
      {sources.length ? <div className="epic-source-table"><div className="epic-source-row head"><span>Source</span><span>Provider</span><span>Type / size</span><span>SHA-256</span><span>Status</span></div>{sources.map((source) => <div className="epic-source-row" key={source.sourceId}><span><strong>{source.name}</strong><small>{source.sourceId}</small></span><span>{source.provider}</span><span>{source.mimeType}<small>{source.bytes?.toLocaleString()} bytes</small></span><code>{source.sha256.slice(0, 16)}…</code><Pill tone="good">{source.status}</Pill></div>)}</div> : <Empty title="No source files pinned" detail="Upload requirements, research, designs, PDFs, screenshots, or spreadsheets before generating the Epic requirements." />}
    </section>
  </div>;
}

function EpicArtifactView({ selected, phases, title, detail, openPlanning, downloadFile }) {
  const documents = selected.documents.filter((document) => phases.includes(document.phase));
  return <div className="epic-workspace-view"><section className="panel epic-artifact-hero"><div><span className="eyebrow">Governed artifact workspace</span><h2>{title}</h2><p>{detail}</p></div>{openPlanning && <button className="primary" onClick={openPlanning}>Open Planning Copilot</button>}</section><section className="panel initiative-documents expanded"><header className="panel-heading"><div><span className="eyebrow">Hash-bound outputs</span><h2>{documents.length} documents</h2></div></header>{documents.map((document) => <div key={`${document.phase}:${document.id}`}><span><strong>{document.label}</strong><small>{document.phase} · generation {document.generation}</small></span><Pill tone={document.status === 'approved' ? 'good' : document.status === 'stale' ? 'warn' : 'neutral'}>{document.status}</Pill><button className="secondary compact" disabled={!document.sha256} onClick={() => downloadFile(document.repositoryPath)}>Open full document</button></div>)}</section></div>;
}

function PhaseGovernance({ data, selected, phaseId, action, reload }) {
  const phase = selected.state.phases[phaseId];
  const [persona, setPersona] = useState(
    selected.state.sessionPersona
      ?? preferredPersonaForRole(data.desktopProfile?.role, data.definition.personas)
      ?? Object.keys(data.definition.personas)[0]
      ?? ''
  );
  const [confirmation, setConfirmation] = useState('');
  const [selfApproval, setSelfApproval] = useState(false);
  if (!phase) return null;
  const outputs = Object.values(phase.outputs ?? {});
  const readyToPublish = phase.status === 'in_progress' && outputs.length > 0
    && outputs.every((output) => output.sha256 && output.status === 'draft');
  const awaitingApproval = phase.status === 'awaiting_approval';
  const approved = phase.status === 'approved';
  async function publish() {
    const result = await action(
      () => window.singularity.publishInitiativePhase(data.repository.root, selected.state.initiative.id, phaseId, persona),
      `${phase.label} generation published, committed, and pushed`
    );
    if (result) await reload(null, selected.state.initiative.id);
  }
  async function approve() {
    const result = await action(
      () => window.singularity.approveInitiativePhase(
        data.repository.root,
        selected.state.initiative.id,
        'phase',
        confirmation,
        persona,
        selfApproval
      ),
      `${phase.label} approved against its exact bundle hash, committed, and pushed`
    );
    if (result) {
      setConfirmation('');
      setSelfApproval(false);
      await reload(null, selected.state.initiative.id);
    }
  }
  return <section className="panel phase-governance">
    <div><span className="eyebrow">Governed stage action</span><h3>{phase.label}</h3><p>{approved ? 'This stage is approved and remains available for review.' : awaitingApproval ? 'Review the generated documents above, then bind your decision to the exact phase bundle.' : readyToPublish ? 'The authored outputs are ready to publish as an immutable generation.' : 'Generate or promote every required output before publishing this stage.'}</p></div>
    <label><span>Session persona</span><select value={persona} onChange={(event) => setPersona(event.target.value)}>{Object.entries(data.definition.personas).map(([id, item]) => <option value={id} key={id}>{item.label}</option>)}</select></label>
    {awaitingApproval && <><label><span>Exact confirmation</span><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder={`${phaseId}:phase`} /></label><label className="self-approval-ack"><input type="checkbox" checked={selfApproval} onChange={(event) => setSelfApproval(event.target.checked)} /><span>I understand that self-approval, when detected, is valid but not independent review.</span></label></>}
    <div className="stage-primary-action">{approved ? <Pill tone="good">Approved</Pill> : awaitingApproval ? <button className="primary" disabled={!persona || confirmation !== `${phaseId}:phase`} onClick={approve}>Approve exact stage</button> : <button className="primary" disabled={!readyToPublish || !persona} onClick={publish}>Publish for approval</button>}</div>
    {selected.state.currentPhase === phaseId && <details className="stage-evidence"><summary>Evidence & governance details <span>{selected.phaseGate?.checklist?.length ?? 0} checks</span></summary><div>{selected.phaseGate?.checklist?.map((check) => <p key={check.id}><Pill tone={['satisfied', 'waived', 'not_applicable', 'optional'].includes(check.status) ? 'good' : 'warn'}>{check.status}</Pill><span><strong>{check.label}</strong><small>{check.acceptedAssurance.join(' / ')} · {check.gate}</small></span></p>)}</div></details>}
  </section>;
}

function epicStageLabel(item) {
  if (item.status === 'complete') return 'Complete';
  if (item.currentPhase === 'epic-intake') return 'Sources';
  if (item.currentPhase === 'epic-requirements') return 'Requirements';
  if (['epic-plan', 'epic-spec'].includes(item.currentPhase)) return 'Planning';
  if (item.currentPhase === 'epic-create') return 'Stories';
  return item.currentPhaseLabel ?? 'Not started';
}

function EpicsHome({ data, action, reload, openEpic, onSetupJira }) {
  const [starting, setStarting] = useState(false);
  const epics = data.initiatives.filter((item) => item.profile === 'epic-planning');
  async function refreshEpics() {
    const result = await action(
      () => window.singularity.refreshInitiatives(data.repository.root),
      'Fetched the latest Epic branches'
    );
    if (result) await reload(null, null);
  }
  if (!epics.length || starting) return <div className="page epics-home"><header className="page-heading"><div><span className="eyebrow">Epic delivery workspace</span><h1>Turn requirements into ready-to-build Stories</h1><p>Bring an Epic from Jira or describe the work, ground it in source evidence, plan with Copilot, and publish governed Stories.</p></div>{epics.length > 0 && <button className="secondary" onClick={() => setStarting(false)}>← Back to Epics</button>}</header><EpicStartWizard data={data} action={action} reload={reload} onSetupJira={onSetupJira} /></div>;
  return <div className="page epics-home">
    <header className="page-heading epics-home-heading"><div><span className="eyebrow">Epic delivery workspace</span><h1>Your Epics</h1><p>One clear view of requirements, planning, Story publication, and downstream delivery readiness.</p></div><div className="row gap"><button className="secondary" onClick={refreshEpics}>↻ Fetch latest</button><button className="primary" onClick={() => setStarting(true)}>＋ Start Epic</button></div></header>
    <section className="epics-summary"><div><strong>{epics.length}</strong><span>Active Epics</span></div><div><strong>{epics.filter((item) => item.currentPhase === 'epic-create').length}</strong><span>Ready for Stories</span></div><div><strong>{epics.filter((item) => item.status === 'complete').length}</strong><span>Completed</span></div></section>
    <section className="epic-card-grid">{epics.map((item) => {
      const waitingMs = item.waitingSince ? Date.now() - Date.parse(item.waitingSince) : null;
      return <button className="epic-home-card" key={item.id} onClick={() => openEpic(item.id)}>
        <header><span><code>{item.id}</code><Pill tone={item.idAuthority === 'jira' ? 'accent' : 'neutral'}>{item.idAuthority}</Pill></span><Pill tone={item.status === 'complete' ? 'good' : item.currentPhaseStatus === 'awaiting_approval' ? 'warn' : 'neutral'}>{epicStageLabel(item)}</Pill></header>
        <h2>{item.title}</h2>
        <p>{item.currentPhaseStatus === 'awaiting_approval' ? `Waiting for approval in ${item.currentPhaseLabel}` : `Currently in ${item.currentPhaseLabel ?? 'setup'}`}{Number.isFinite(waitingMs) ? ` · ${formatDuration(waitingMs)}` : ''}</p>
        <div className="epic-home-progress"><i><b style={{ width: `${item.percentage ?? 0}%` }} /></i><span>{item.percentage ?? 0}%</span></div>
        <footer><span>{item.phasesApproved ?? 0}/{item.phasesTotal ?? 0} stages approved</span><strong>Open Epic →</strong></footer>
      </button>;
    })}</section>
  </div>;
}

function EpicReviewView({ data, selected, action, reload }) {
  const [inbox, setInbox] = useState([]);
  const [review, setReview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [persona, setPersona] = useState('');
  const [rejectTarget, setRejectTarget] = useState('');
  const [reason, setReason] = useState('');
  const initiativeId = selected.state.initiative.id;
  useEffect(() => {
    let active = true;
    setLoading(true);
    window.singularity.epicReviewInbox(data.repository.root, initiativeId)
      .then((items) => { if (active) setInbox(items); })
      .catch(() => { if (active) setInbox([]); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [data.repository.root, initiativeId]);
  async function open(item) {
    const result = await action(() => window.singularity.epicReview(data.repository.root, initiativeId, item.workId, item.packetSha256));
    if (result) {
      setReview(result);
      setPersona(result.approval.personas[0]?.id ?? '');
      setRejectTarget(result.approval.rejectTo[0] ?? result.approval.phase);
      setReason('');
    }
  }
  async function checks() {
    if (!review) return;
    const result = await action(
      () => window.singularity.runEpicChecks(data.repository.root, initiativeId, review.story.workId ?? review.story.id, review.packet.packetSha256),
      'Exact-SHA governance and GitHub Actions evidence recorded and published'
    );
    if (result) {
      await reload(null, initiativeId);
      setReview({ ...review, checks: result.checks.evidence });
    }
  }
  async function decide(decision) {
    if (!review || !persona) return;
    const result = await action(
      () => window.singularity.decideEpicReview(
        data.repository.root,
        initiativeId,
        review.story.workId ?? review.story.id,
        review.packet.packetSha256,
        decision,
        persona,
        decision === 'reject' ? rejectTarget : null,
        decision === 'reject' ? reason : null
      ),
      `${decision === 'approve' ? 'Approval' : 'Rejection'} bound to packet ${review.packet.packetSha256.slice(0, 12)} and published`
    );
    if (result) {
      setReview(null);
      setPersona('');
      setReason('');
      await reload(null, initiativeId);
      setInbox(await window.singularity.epicReviewInbox(data.repository.root, initiativeId));
    }
  }
  const checksReady = Boolean(review?.checks?.ready || review?.approval?.evidence?.ready);
  return <div className="epic-workspace-view review-inbox-workspace">
    <aside className="panel epic-review-list">
      <header><span className="eyebrow">Story review inbox · Cross-repository</span><h2>Submitted stories</h2><p>Review packets are discovered from published canonical and registered child branches.</p></header>
      {loading ? <div className="inline-empty">Refreshing published Story branches…</div> : inbox.length ? inbox.map((item) => <button className={review?.packet?.packetSha256 === item.packetSha256 ? 'active' : ''} key={item.packetSha256} onClick={() => open(item)}><span><strong>{item.workId}</strong><small>{item.repository} · {item.branch}</small></span><Pill tone="accent">{item.phase}</Pill><code>{item.packetSha256.slice(0, 12)}</code></button>) : <Empty title="No submitted stories" detail="Developer submissions will appear here after their hash-bound review packet is committed and pushed." />}
    </aside>
    <main className="panel epic-review-detail">
      {review ? <>
        <header className="panel-heading"><div><span className="eyebrow">Exact review packet</span><h2>{review.story.workId ?? review.story.id}</h2><p>{initiativeId} → {review.story.planId ?? review.story.id} → {review.story.jiraKey ?? 'Jira pending'} → {review.submittedBranch}</p></div><button className="primary" onClick={checks}>Run and record exact-SHA checks</button></header>
        <div className="review-packet-metrics"><div><span>Packet</span><code>{review.packet.packetSha256}</code></div><div><span>Source commit</span><code>{review.packet.sourceCommit}</code></div><div><span>Tree hash</span><code>{review.packet.sourceTreeSha256}</code></div><div><span>GitHub evidence</span><strong>{checksReady ? 'ready' : 'not recorded'}</strong></div></div>
        {review.approval.selfApprovalWarning && <div className="notice warn"><strong>Self-approval warning.</strong> Your Git identity matches this packet’s submitter or generator. The decision remains valid but is not independent review.</div>}
        <section className="epic-review-decision">
          <div><span className="eyebrow">Hash-bound decision</span><h3>Approve or return this exact packet</h3><p>Approval stays disabled until deterministic and required GitHub checks pass for the submitted source SHA.</p></div>
          <label><span>Approval persona</span><select value={persona} onChange={(event) => setPersona(event.target.value)}><option value="">Choose persona…</option>{review.approval.personas.map((entry) => <option value={entry.id} key={entry.id}>{entry.label}</option>)}</select></label>
          <label><span>Return to phase</span><select value={rejectTarget} onChange={(event) => setRejectTarget(event.target.value)}>{review.approval.rejectTo.map((phase) => <option value={phase} key={phase}>{phase}</option>)}</select></label>
          <label className="wide"><span>Rejection reason</span><input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Required only when returning the Story" /></label>
          <div className="epic-review-actions"><button className="secondary danger-text" disabled={!persona || !reason.trim()} onClick={() => decide('reject')}>Return with feedback</button><button className="primary" disabled={!persona || !checksReady} onClick={() => decide('approve')}>Approve exact packet</button></div>
        </section>
        <pre className="review-packet-document">{review.review.markdown}</pre>
      </> : <Empty title="Select a Story packet" detail="You’ll see complete documents, source lineage, Git diff, checks, approvals, tokens, and conformance evidence." />}
    </main>
  </div>;
}

const epicJourneySteps = ['Sources', 'Requirements', 'Planning', 'Stories', 'Complete'];

function EpicJourneyDiagram({ activeStep = 0 }) {
  return <div className="epic-start-flow" aria-label="Epic planning workflow">
    {epicJourneySteps.map((label, index) => <React.Fragment key={label}>
      <span className={index < activeStep ? 'complete' : index === activeStep ? 'active' : ''}>
        <i>{index < activeStep || index === epicJourneySteps.length - 1 ? '✓' : index + 1}</i>
        <small>{label}</small>
      </span>
      {index < epicJourneySteps.length - 1 && <b aria-hidden="true" />}
    </React.Fragment>)}
  </div>;
}

function EpicStartWizard({ data, action, reload, onSetupJira = () => window.dispatchEvent(new Event('singularity:setup-jira')) }) {
  const initiativeProfiles = data.portfolio?.initiativeProfiles ?? {
    'epic-planning': { label: 'Epic planning' }
  };
  const personas = data.definition?.personas ?? {};
  const [source, setSource] = useState(data.portfolio?.jira?.enabled ? 'jira' : 'local');
  const [status, setStatus] = useState(null);
  const [projects, setProjects] = useState([]);
  const [projectKey, setProjectKey] = useState(data.portfolio?.jira?.projectKey ?? '');
  const [epics, setEpics] = useState([]);
  const [epicKey, setEpicKey] = useState('');
  const [localPreview, setLocalPreview] = useState(null);
  const [localTitle, setLocalTitle] = useState('');
  const [localDescription, setLocalDescription] = useState('');
  const [localGoal, setLocalGoal] = useState('');
  const [profile, setProfile] = useState(
    initiativeProfiles['epic-planning'] ? 'epic-planning' : Object.keys(initiativeProfiles)[0] ?? ''
  );
  const [persona, setPersona] = useState(
    preferredPersonaForRole(data.desktopProfile?.role, personas)
      ?? Object.keys(personas)[0]
      ?? ''
  );
  useEffect(() => {
    let active = true;
    if (!data.portfolio?.jira?.enabled) return undefined;
    window.singularity.jiraStatus(data.repository.root)
      .then((result) => { if (active) setStatus(result); })
      .catch((error) => { if (active) setStatus({ error: error.message, credentials: { connected: false } }); });
    return () => { active = false; };
  }, [data.repository.root, data.portfolio?.jira?.enabled]);
  useEffect(() => {
    let active = true;
    if (source !== 'local') return undefined;
    if (!data.portfolio) {
      setLocalPreview({ id: 'Reserved when started' });
      return undefined;
    }
    window.singularity.previewLocalEpicId(data.repository.root)
      .then((result) => { if (active) setLocalPreview(result); })
      .catch((error) => { if (active) setLocalPreview({ error: error.message }); });
    return () => { active = false; };
  }, [data.repository.root, source]);
  async function loadProjects() {
    const result = await action(() => window.singularity.jiraProjects(data.repository.root));
    if (!result) return;
    setProjects(result);
    const next = projectKey || result[0]?.key || '';
    setProjectKey(next);
    if (next) {
      const values = await action(() => window.singularity.jiraEpics(data.repository.root, next));
      if (values) setEpics(values);
    }
  }
  async function chooseProject(key) {
    setProjectKey(key);
    setEpicKey('');
    const result = await action(() => window.singularity.jiraEpics(data.repository.root, key));
    if (result) setEpics(result);
  }
  async function start() {
    if (!data.portfolio) {
      const initialized = await action(
        () => window.singularity.bootstrapPortfolio(data.repository.root, { jira: { enabled: false } }),
        'Epic planning initialized from the repository defaults'
      );
      if (!initialized) return;
      const published = await action(
        () => window.singularity.publish(data.repository.root, 'Initialize governed Epic planning'),
        'Epic planning configuration committed and pushed'
      );
      if (!published) return;
    }
    if (source === 'local') {
      const result = await action(
        () => window.singularity.startLocalEpic(data.repository.root, localTitle, localDescription, localGoal, profile, persona),
        'Local Epic ID reserved, initialized, committed, and pushed'
      );
      if (result) await reload(null, result.initiativeId);
      return;
    }
    const result = await action(
      () => window.singularity.startEpicWizard(data.repository.root, epicKey, profile, persona),
      `Epic ${epicKey} fetched from Jira, initialized, committed, and pushed`
    );
    if (result) await reload(null, epicKey);
  }
  const connected = status?.credentials?.connected;
  const defaultBranch = data.definition.defaultBaseBranch ?? 'main';
  const localStartReady = data.repository.branch === defaultBranch && data.repository.changes.length === 0;
  const canStart = source === 'jira'
    ? connected && epicKey && profile && persona
    : localStartReady && localTitle.trim() && localDescription.trim() && localGoal.trim() && profile && persona && (!data.portfolio || !localPreview?.error);
  return <div className="epic-start-wizard">
    <section className="epic-start-intro">
      <div className="epic-start-intro-copy">
        <span className="ai-orb">S</span>
        <div><span className="eyebrow">Start a governed Epic</span><h2>Turn an Epic into delivery-ready Stories</h2><p>Bring the Epic from Jira or describe it directly; Singularity pins its identity, branch, and workflow before planning.</p></div>
      </div>
      <EpicJourneyDiagram />
    </section>
    <section className="panel epic-start-form">
      <div className="epic-origin-choice" role="group" aria-label="Epic identity source"><button className={`${source === 'jira' ? 'active' : ''} ${data.portfolio?.jira?.enabled ? '' : 'needs-setup'}`} onClick={() => data.portfolio?.jira?.enabled ? setSource('jira') : onSetupJira()}><strong>Bring from Jira</strong><small>{data.portfolio?.jira?.enabled ? 'Use an existing Epic key and Jira identity' : 'Set up Jira, then choose an existing Epic'}</small>{!data.portfolio?.jira?.enabled && <b>Set up Jira →</b>}</button><button className={source === 'local' ? 'active' : ''} onClick={() => setSource('local')}><strong>Describe the work</strong><small>Reserve a local Singularity Epic ID</small></button></div>
      {source === 'jira' ? <>
        <div className="epic-start-step"><b>1</b><div><span className="eyebrow">Connection</span><h3>Use your Jira identity</h3><p>{connected ? `Connected as ${status.credentials.connection?.account?.displayName ?? status.credentials.connection?.email}.` : 'Connect Jira securely, then return here to choose an Epic.'}</p></div>{connected ? <Pill tone="good">ready</Pill> : <button className="secondary" onClick={onSetupJira}>Set up Jira</button>}</div>
        <div className="epic-start-step"><b>2</b><div><span className="eyebrow">Epic intake</span><h3>Choose an Epic</h3><div className="epic-start-controls"><select value={projectKey} disabled={!connected || !projects.length} onChange={(event) => chooseProject(event.target.value)}><option value="">Project…</option>{projects.map((project) => <option value={project.key} key={project.key}>{project.key} — {project.name}</option>)}</select><select value={epicKey} disabled={!epics.length} onChange={(event) => setEpicKey(event.target.value)}><option value="">Epic…</option>{epics.map((epic) => <option value={epic.key} key={epic.key}>{epic.key} — {epic.title}</option>)}</select><button className="secondary" disabled={!connected} onClick={loadProjects}>{projects.length ? 'Refresh Jira' : 'Load Jira Epics'}</button></div></div></div>
      </> : <div className="epic-start-step local-epic-fields"><b>1</b><div><span className="eyebrow">Business intent</span><h3>Describe the Epic</h3><div className="epic-local-id"><span>Next reserved ID</span><code>{localPreview?.id ?? 'Checking…'}</code></div><label><span>Epic title</span><input value={localTitle} onChange={(event) => setLocalTitle(event.target.value)} placeholder="Customer onboarding modernization" /></label><label><span>Problem or opportunity</span><textarea rows="3" value={localDescription} onChange={(event) => setLocalDescription(event.target.value)} placeholder="Describe why this work matters and the boundaries already known." /></label><label><span>Desired outcome</span><textarea rows="2" value={localGoal} onChange={(event) => setLocalGoal(event.target.value)} placeholder="Describe the measurable result." /></label>{localPreview?.error && <div className="notice warn">{localPreview.error}</div>}</div></div>}
      <div className="epic-start-step"><b>3</b><div><span className="eyebrow">Session choices</span><h3>Pin the workflow and choose your working persona</h3><div className="epic-start-controls"><select value={profile} onChange={(event) => setProfile(event.target.value)}>{Object.entries(initiativeProfiles).map(([id, item]) => <option value={id} key={id}>{item.label}</option>)}</select><select value={persona} onChange={(event) => setPersona(event.target.value)}>{Object.entries(personas).map(([id, item]) => <option value={id} key={id}>{item.label}</option>)}</select></div>{!data.portfolio && <p className="epic-defaults-note">The governed Epic defaults will be created when you start. No separate portfolio setup is required.</p>}</div></div>
      {source === 'local' && !localStartReady && <div className="notice warn epic-start-blocker"><strong>Local Epic creation starts from a clean {defaultBranch} branch.</strong><span>{data.repository.changes.length ? `Commit or set aside the ${data.repository.changes.length} current working-tree change(s), then switch to ${defaultBranch}.` : `Switch from ${data.repository.branch} to ${defaultBranch}, then refresh this workspace.`}</span></div>}
      <footer><div><strong>The Epic branch is the shared control plane.</strong><span>No default branch is merged automatically. Jira publication remains a reviewed, explicit action.</span></div><button className="primary" disabled={!canStart} onClick={start}>Start Epic workflow</button></footer>
    </section>
  </div>;
}

function EpicStoryPlanView({ selected, openPlanning, downloadFile }) {
  const epics = selected.report?.children?.epics ?? [];
  return <div className="epic-workspace-view">
    <EpicArtifactView selected={selected} phases={['epic-plan']} title="Plan and review the generated Stories" detail="Planning Copilot decomposes approved REQ and AC identifiers into repository-owned Stories. Review every Story before moving to the high-level specification." downloadFile={downloadFile} openPlanning={openPlanning} />
    <section className="panel planned-story-review">
      <header className="panel-heading"><div><span className="eyebrow">Planning output</span><h2>{selected.report.children.total} generated User Stories</h2><p>This is the exact breakdown that will become Jira Stories and canonical branches after the specification is approved.</p></div><Pill tone={selected.state.phases['epic-plan']?.status === 'approved' ? 'good' : 'warn'}>{selected.state.phases['epic-plan']?.status ?? 'not started'}</Pill></header>
      {!epics.length ? <Empty title="No Stories generated yet" detail="Open Planning Copilot, generate the story-plan output, and promote it into the Epic branch." /> : epics.map((epic) => <div className="planned-epic" key={epic.id}><header><span><small>Epic</small><code>{epic.jiraKey ?? epic.id}</code></span><h3>{epic.title}</h3><strong>{epic.stories.length} Stories</strong></header><div className="planned-story-grid">{epic.stories.map((story) => <article key={story.id}><div><code>{story.planId ?? story.id}</code><Pill tone={story.blocking ? 'accent' : 'neutral'}>{story.blocking ? 'blocking' : 'optional'}</Pill></div><h4>{story.title}</h4><p>{story.description || 'Description will be carried into Jira.'}</p><dl><div><dt>Repository</dt><dd>{story.repository}</dd></div><div><dt>Requirements</dt><dd>{story.requirements?.join(', ') || '—'}</dd></div><div><dt>Acceptance</dt><dd>{story.acceptanceCriteria?.join(', ') || '—'}</dd></div><div><dt>Depends on</dt><dd>{story.dependsOn?.map((item) => item.story ?? item).join(', ') || 'None'}</dd></div></dl></article>)}</div></div>)}
    </section>
  </div>;
}

function EpicCompletionPanel({ data, selected, action, reload, synchronizeStories }) {
  const [confirmation, setConfirmation] = useState('');
  const delivery = selected.delivery;
  const initiativeId = selected.state.initiative.id;
  async function complete() {
    const result = await action(
      () => window.singularity.completeEpicDelivery(data.repository.root, initiativeId, confirmation),
      `Epic ${initiativeId} marked complete against exact Story and conformance hashes`
    );
    if (result) {
      setConfirmation('');
      await reload(null, initiativeId);
    }
  }
  return <section className={`panel epic-completion-panel ${delivery?.status === 'complete' ? 'complete' : ''}`}>
    <header className="panel-heading"><div><span className="eyebrow">Final Product Owner gate</span><h2>Spec-to-code completion</h2><p>Every blocking Story must be complete, conformant, and backed by exact-SHA checks before the Epic can close.</p></div><Pill tone={delivery?.status === 'complete' ? 'good' : delivery?.ready ? 'accent' : 'warn'}>{delivery?.status === 'complete' ? 'Epic complete' : delivery?.ready ? 'Ready to complete' : `${delivery?.readyStories ?? 0}/${delivery?.requiredStories ?? 0} ready`}</Pill></header>
    <div className="epic-completion-stories">{delivery?.stories?.map((story) => <div key={story.planId} className={story.ready ? 'ready' : story.blocking ? 'blocked' : 'optional'}><StatusDot status={story.ready ? 'approved' : 'awaiting_approval'} /><span><strong>{story.workId}</strong><small>{story.repository} · {story.jiraKey ?? 'Jira pending'}</small></span><code>{story.observedCommit?.slice(0, 12) ?? 'not synchronized'}</code><Pill tone={story.ready ? 'good' : 'warn'}>{story.ready ? 'matched' : story.problems[0] ?? 'deferred'}</Pill></div>)}</div>
    {delivery?.status === 'complete' ? <div className="epic-completion-result"><strong>Completion decision {delivery.completion?.sha256?.slice(0, 12)}</strong><span>The committed report is immutable and remains bound to the listed Story commits, packets, checks, and conformance trees.</span></div> : <footer><button className="secondary" onClick={synchronizeStories}>↻ Synchronize Story branches</button><label><span>Exact Epic confirmation</span><input value={confirmation} onChange={(event) => setConfirmation(event.target.value.toUpperCase())} placeholder={`Type ${initiativeId}`} /></label><button className="primary" disabled={!delivery?.ready || confirmation !== initiativeId} onClick={complete}>Mark Epic complete</button></footer>}
  </section>;
}

function InitiativeStudio({ data, editor, setEditor, saveEditor, downloadFile, action, reload, bootstrapPortfolio, openPlanning, setupJira, localRole, jiraAccount, entryTab = null }) {
  const [tab, setTab] = useState('intake');
  const [materializationModal, setMaterializationModal] = useState(null);
  const [repositoryModal, setRepositoryModal] = useState(null);
  const [jiraArtifacts, setJiraArtifacts] = useState({});
  const [artifactDestination, setArtifactDestination] = useState('epic');
  const portfolio = data.portfolio;
  const selected = data.initiative;
  useEffect(() => {
    const defaults = {};
    for (const document of selected?.documents ?? []) {
      if (['requirements-specification', 'requirements-traceability', 'high-level-specification'].includes(document.id) && document.sha256) {
        defaults[`${document.phase}/${document.id}`] = true;
      }
    }
    setJiraArtifacts(defaults);
  }, [selected?.state.initiative.id, selected?.state.history.length]);
  useEffect(() => {
    if (entryTab) {
      setTab(entryTab);
      return;
    }
    const phase = selected?.state.currentPhase;
    const nextTab = phase === 'epic-intake'
      ? 'intake'
      : phase === 'epic-requirements'
        ? 'requirements'
        : ['epic-plan', 'epic-spec'].includes(phase)
          ? 'planning'
          : phase === 'epic-create'
            ? 'publish'
            : selected?.state.status === 'complete'
              ? 'complete'
              : null;
    if (nextTab) setTab(nextTab);
  }, [entryTab, selected?.state.initiative.id, selected?.state.currentPhase, selected?.state.status]);
  if (!portfolio) return <div className="page"><PortfolioSetup data={data} action={action} onCreated={bootstrapPortfolio} /></div>;
  const configValue = editor.path === data.portfolioPath ? editor.content : data.portfolioText;
  const configOriginal = editor.path === data.portfolioPath ? editor.original : data.portfolioText;
  let portfolioDraft = portfolio;
  try {
    const parsed = YAML.parse(configValue);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) portfolioDraft = parsed;
  } catch { /* The source editor reports invalid YAML on save. */ }
  const profiles = Object.entries(portfolio.initiativeProfiles ?? {});
  const repositories = Object.entries(portfolioDraft.repositories ?? {});
  const authorities = Object.entries(portfolio.approvalAuthorities ?? {});
  const state = selected?.state;
  const progress = selected?.progress;
  const report = selected?.report;
  const currentDefinition = state?.resolution.phases.find((phase) => phase.id === state.currentPhase) ?? state?.resolution.phases.at(-1);
  const currentChecks = selected?.phaseGate?.checklist ?? [];
  const children = report?.children.stories ?? [];
  const epics = report?.children.epics ?? [];
  const specificationReady = !state?.phaseOrder.includes('epic-spec') || state.phases['epic-spec']?.status === 'approved';
  const businessStage = entryTab && selected?.state.initiative.profile === 'epic-planning'
    ? {
        requirements: {
          step: 'Business requirements',
          title: 'Turn pinned Epic sources into approved requirements',
          detail: 'Generate and review REQ-nnn and AC-nnn records here. Every item stays linked to its source before Planning can use it.',
          activeStep: 1,
          prerequisite: state.phases['epic-intake']?.status === 'approved',
          prerequisiteLabel: 'Approve Epic intake first'
        },
        planning: {
          step: 'Business planning',
          title: 'Decompose requirements into governed User Stories',
          detail: 'Planning Copilot allocates requirements and acceptance criteria to repository-owned Stories, then produces the high-level specification.',
          activeStep: 2,
          prerequisite: state.phases['epic-requirements']?.status === 'approved',
          prerequisiteLabel: 'Approve requirements first'
        },
        publish: {
          step: 'Jira and Git handoff',
          title: 'Publish the reviewed Story plan',
          detail: 'Review every generated Story and selected artifact, then create or attach the Jira issue and canonical Git branch using the returned Jira key.',
          activeStep: 3,
          prerequisite: state.phases['epic-plan']?.status === 'approved' && specificationReady,
          prerequisiteLabel: 'Approve the Story plan and high-level specification first'
        }
      }[entryTab]
    : null;
  const jiraArtifactCandidates = selected?.documents.filter((document) =>
    ['epic-requirements', 'epic-spec'].includes(document.phase) && document.sha256
  ) ?? [];
  const wizardSteps = selected?.state.initiative.profile === 'epic-planning' ? [
    { id: 'intake', label: 'Sources', phase: 'epic-intake' },
    { id: 'requirements', label: 'Requirements', phase: 'epic-requirements' },
    {
      id: 'planning',
      label: 'Planning',
      complete: state.phases['epic-plan']?.status === 'approved' && (!state.phases['epic-spec'] || state.phases['epic-spec']?.status === 'approved')
    },
    { id: 'publish', label: 'Stories', phase: 'epic-create' },
    { id: 'complete', label: 'Complete', complete: selected?.delivery?.status === 'complete' }
  ].filter((step) => !step.phase || state.phases[step.phase]).map((step) => ({
    ...step,
    status: step.phase ? state.phases[step.phase]?.status ?? 'not_started' : step.complete ? 'approved' : 'in_progress'
  })) : [];
  const leadBaseBranch = data.definition.defaultBaseBranch ?? 'main';
  function openRepositoryModal() {
    setRepositoryModal({
      values: {
        id: '',
        appId: '',
        name: '',
        url: '',
        defaultBranch: leadBaseBranch,
        required: true,
        metadata: [{ key: '', value: '' }]
      },
      error: null
    });
  }
  function repositoryField(field, value) {
    setRepositoryModal((current) => ({ ...current, values: { ...current.values, [field]: value }, error: null }));
  }
  function repositoryMetadataField(index, field, value) {
    setRepositoryModal((current) => ({
      ...current,
      values: {
        ...current.values,
        metadata: current.values.metadata.map((entry, entryIndex) => entryIndex === index ? { ...entry, [field]: value } : entry)
      },
      error: null
    }));
  }
  function addRepository() {
    try {
      const current = YAML.parse(configValue);
      const next = addPortfolioRepository(current, repositoryModal.values);
      setEditor({ path: data.portfolioPath, content: YAML.stringify(next), original: configOriginal, kind: 'portfolio' });
      setRepositoryModal(null);
    } catch (error) {
      setRepositoryModal((current) => ({ ...current, error: error.message }));
    }
  }
  async function previewMaterialization() {
    const result = await action(() => window.singularity.previewInitiativeMaterialization(data.repository.root, state.initiative.id));
    if (!result) return;
    let writePlan = null;
    if (state.initiative.profile === 'epic-planning' && state.lineage?.idAuthority === 'jira' && data.portfolio.jira?.enabled) {
      const targets = artifactDestination === 'both' ? ['epic', 'stories'] : [artifactDestination];
      const artifacts = jiraArtifactCandidates
        .filter((document) => jiraArtifacts[`${document.phase}/${document.id}`])
        .map((document) => ({ phase: document.phase, id: document.id, targets }));
      writePlan = await action(() => window.singularity.createJiraWritePlan(data.repository.root, state.initiative.id, artifacts), 'Exact Jira Story and artifact write plan generated and published');
      if (!writePlan) return;
    }
    setMaterializationModal({ preview: result.review, writePlan: writePlan?.plan ?? null, confirmation: '' });
  }
  async function materializeStories() {
    const initiativeId = state.initiative.id;
    if (materializationModal.confirmation !== initiativeId) return;
    if (materializationModal.writePlan) {
      const applied = await action(
        () => window.singularity.applyJiraWritePlan(data.repository.root, initiativeId, materializationModal.writePlan.sha256, materializationModal.confirmation),
        'Reviewed Jira Story plan applied with append-only receipts'
      );
      if (!applied) return;
    }
    const result = await action(
      () => window.singularity.materializeInitiative(data.repository.root, initiativeId, materializationModal.confirmation),
      `Created or attached ${materializationModal.preview.stories.length} governed Story branches and published the receipts`
    );
    if (!result) return;
    setMaterializationModal(null);
    await reload(null, initiativeId);
  }
  async function synchronizeStories() {
    const initiativeId = state.initiative.id;
    const result = await action(
      () => window.singularity.syncInitiative(data.repository.root, initiativeId),
      'Story branches synchronized and epic progress published'
    );
    if (result) await reload(null, initiativeId);
  }
  return <div className="page initiative-page">
    <header className="page-heading initiative-heading"><div><span className="eyebrow">Cross-repository control plane · Epic planning and delivery lineage</span><h1>{selected?.state.initiative.profile === 'epic-planning' ? 'Epic workspace' : 'Initiative orchestration'}</h1><p>Move from pinned sources to approved requirements, Jira Stories, canonical branches, review packets, and Epic progress.</p></div><div className="epic-identity-strip" title="These identities are recorded separately and are not claimed to be cryptographically equivalent"><span><b>Local role</b>{localRole ?? data.desktopProfile?.role ?? 'not set'}</span><span><b>Jira account</b>{jiraAccount ?? data.jiraSession?.connection?.email ?? data.jiraSession?.connection?.account?.emailAddress ?? 'not connected'}</span><span><b>Git identity</b>{data.identities?.git?.email ?? 'not configured'}</span><span><b>GitHub login</b>{data.identities?.github ?? 'not signed in'}</span></div></header>
    {businessStage && <section className={`business-stage-intro ${businessStage.prerequisite ? 'ready' : 'waiting'}`}>
      <div className="business-stage-copy"><span className="eyebrow">{businessStage.step}</span><h2>{businessStage.title}</h2><p>{businessStage.detail}</p></div>
      <EpicJourneyDiagram activeStep={businessStage.activeStep} />
      <Pill tone={businessStage.prerequisite ? 'good' : 'warn'}>{businessStage.prerequisite ? 'Ready to work' : businessStage.prerequisiteLabel}</Pill>
      {entryTab === 'publish' && <div className="business-lineage-handoff"><span><b>1</b>Approved Story plan</span><i>→</i><span><b>2</b>Jira Story key</span><i>→</i><span><b>3</b>Canonical Git branch</span><i>→</i><span><b>4</b>Governed seed & receipts</span></div>}
    </section>}
    {selected?.state.initiative.profile === 'epic-planning' ? !entryTab && <nav className="epic-lifecycle-wizard" aria-label="Epic lifecycle wizard">{wizardSteps.map((step, index) => <React.Fragment key={step.id}><button className={`${tab === step.id ? 'active' : ''} ${step.status === 'approved' ? 'complete' : ''}`} onClick={() => setTab(step.id)}><span>{step.status === 'approved' ? '✓' : index + 1}</span><small>Step {index + 1}</small><strong>{step.label}</strong></button>{index < wizardSteps.length - 1 && <i>→</i>}</React.Fragment>)}<button className={`wizard-config ${tab === 'configuration' ? 'active' : ''}`} onClick={() => setTab('configuration')}><span>⚙</span><small>Manage</small><strong>Configuration</strong></button></nav> : <nav className="epic-workspace-nav" aria-label="Initiative workspace">{[['delivery', 'Overview'], ['requirements', 'Documents'], ['configuration', 'Configuration']].map(([id, label]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}</nav>}
    {['delivery', 'publish'].includes(tab) && selected && <div className="branch-baseline-note"><span>⑂</span><div><strong>Branches stay isolated</strong><p><code>{leadBaseBranch}</code> supplies the starting source and configuration baseline. Epic and Story branches receive their own commits; Singularity never merges them into a default branch automatically. Accepted canonical Story results alone advance Epic progress.</p></div></div>}
    {tab === 'configuration' ? <div className="initiative-config-layout">
      <aside className="initiative-config-summary">
        <section className="panel"><header className="panel-heading"><div><span className="eyebrow">Profiles</span><h2>{profiles.length} delivery models</h2></div></header><div className="initiative-mini-list">{profiles.map(([id, profile]) => <div key={id}><strong>{profile.label}</strong><span>{profile.phases.length} phases</span><small>{profile.phases.join(' → ')}</small></div>)}</div></section>
        <section className="panel"><header className="panel-heading"><div><span className="eyebrow">Repository registry</span><h2>{repositories.length} repositories</h2></div><button className="primary compact" onClick={openRepositoryModal}>＋ Add repository</button></header><div className="initiative-mini-list repository-registry-list">{repositories.length ? repositories.map(([id, repository]) => <div key={id}><strong>{repository.metadata?.name ?? id}</strong><span>{repository.metadata?.appId ?? (repository.required ? 'Required' : 'Optional')}</span><small>{id} · {repository.defaultBranch} · {repository.url}</small>{Object.entries(repository.metadata ?? {}).filter(([key]) => !['appId', 'name'].includes(key)).length > 0 && <em>{Object.entries(repository.metadata).filter(([key]) => !['appId', 'name'].includes(key)).map(([key, value]) => `${key}: ${value}`).join(' · ')}</em>}</div>) : <div><strong>No repositories yet</strong><small>Add a repository with application identity and organization metadata.</small></div>}</div></section>
        <section className="panel"><header className="panel-heading"><div><span className="eyebrow">Issue materialization</span><h2>Jira {portfolio.jira?.enabled ? portfolio.jira.writeMode : 'off'}</h2></div><Pill tone={portfolio.jira?.writeMode === 'approved' ? 'good' : 'neutral'}>{portfolio.jira?.projectKey || 'Git only'}</Pill></header><div className="initiative-mini-list"><div><strong>Epic → Story hierarchy</strong><span>{portfolio.jira?.writeMode === 'approved' ? 'Guarded apply' : portfolio.jira?.writeMode === 'preview' ? 'Plan only' : 'Git only'}</span><small>{portfolio.jira?.writeMode === 'approved' ? `${portfolio.jira.epicIssueType ?? 'Epic'} / ${portfolio.jira.storyIssueType ?? 'Story'} · exact approved write plan required` : portfolio.jira?.writeMode === 'preview' ? 'Create and commit Jira write plans without mutating Jira.' : 'Enable Jira policy and choose a write mode in portfolio.yml; no network is used while off.'}</small></div></div></section>
        <section className="panel"><header className="panel-heading"><div><span className="eyebrow">Approval authorities</span><h2>{authorities.length} groups</h2></div></header><div className="initiative-mini-list">{authorities.map(([id, authority]) => <div key={id}><strong>{id}</strong><span>{authority.members.length} identities</span><small>{authority.members.map((member) => member.email).join(', ') || 'Configure members before starting.'}</small></div>)}</div></section>
      </aside>
      <SourceEditor path={data.portfolioPath} value={configValue} dirty={configValue !== configOriginal} onChange={(content) => setEditor({ path: data.portfolioPath, content, original: configOriginal, kind: 'portfolio' })} onSave={saveEditor} onDownload={() => downloadFile(data.portfolioPath)} language="yaml" />
    </div> : !selected ? <EpicStartWizard data={data} action={action} reload={reload} onSetupJira={setupJira} /> : tab === 'intake' ? <div className="epic-workspace-view"><EpicSourcesView data={data} selected={selected} action={action} reload={reload} /><EpicArtifactView selected={selected} phases={['epic-intake']} title="Epic intake artifacts" detail="The Epic identity, source catalog, gaps, assumptions, and intake summary remain hash-bound to this Epic branch." downloadFile={downloadFile} openPlanning={openPlanning} /><PhaseGovernance data={data} selected={selected} phaseId="epic-intake" action={action} reload={reload} /></div> : tab === 'requirements' ? <div className="epic-workspace-view"><EpicArtifactView selected={selected} phases={['epic-requirements']} title="Requirements and traceability" detail="Every REQ-nnn and AC-nnn must cite a pinned source, page, frame, or section before approval." downloadFile={downloadFile} openPlanning={openPlanning} /><PhaseGovernance data={data} selected={selected} phaseId="epic-requirements" action={action} reload={reload} /></div> : tab === 'planning' ? <div className="epic-workspace-view"><EpicStoryPlanView selected={selected} openPlanning={openPlanning} downloadFile={downloadFile} /><PhaseGovernance data={data} selected={selected} phaseId="epic-plan" action={action} reload={reload} />{selected.state.phases['epic-spec'] && <><EpicArtifactView selected={selected} phases={['epic-spec']} title="High-level solution specification" detail="Define repository boundaries, interfaces, security, observability, tests, and the contracts that later spec-to-code review will evaluate." downloadFile={downloadFile} openPlanning={openPlanning} /><PhaseGovernance data={data} selected={selected} phaseId="epic-spec" action={action} reload={reload} /></>}</div> : tab === 'publish' ? <div className="epic-workspace-view">
      <section className="panel jira-artifact-publish">
        <header className="panel-heading"><div><span className="eyebrow">Reviewed outbound package</span><h2>Select what Jira receives</h2><p>The exact file hashes become part of the Jira write plan. Selected Markdown/YAML files are attached with hash-stamped filenames; retries reuse matching attachments.</p></div><Pill tone={specificationReady ? 'good' : 'warn'}>{specificationReady ? 'Specification approved' : 'Approve specification first'}</Pill></header>
        <div className="jira-artifact-options">{jiraArtifactCandidates.map((document) => { const reference = `${document.phase}/${document.id}`; return <label key={reference} className={jiraArtifacts[reference] ? 'selected' : ''}><input type="checkbox" checked={Boolean(jiraArtifacts[reference])} onChange={(event) => setJiraArtifacts((current) => ({ ...current, [reference]: event.target.checked }))} /><span><strong>{document.label}</strong><small>{reference} · {document.sha256.slice(0, 12)}</small></span><Pill tone={document.status === 'approved' ? 'good' : 'neutral'}>{document.status}</Pill></label>; })}</div>
        <footer>{state.lineage?.idAuthority === 'jira' && <label><span>Attach selected documents to</span><select value={artifactDestination} onChange={(event) => setArtifactDestination(event.target.value)}><option value="epic">Epic only · recommended</option><option value="stories">Every generated Story</option><option value="both">Epic and every Story</option></select></label>}<button className="primary" onClick={previewMaterialization} disabled={selected.materialization.phaseStatus !== 'approved'}>Review {state.lineage?.idAuthority === 'jira' ? 'Jira & Git' : 'Git'} publication</button></footer>
      </section>
      <EpicArtifactView selected={selected} phases={['epic-create']} title="Publication records" detail="After Jira and Git materialization, generate the final write-plan and receipt report, then complete the planning governance gate." downloadFile={downloadFile} openPlanning={openPlanning} />
      <PhaseGovernance data={data} selected={selected} phaseId="epic-create" action={action} reload={reload} />
    </div> : tab === 'complete' ? <div className="epic-workspace-view"><section className="panel epic-delivery-summary"><header className="panel-heading"><div><span className="eyebrow">Read-only downstream view</span><h2>Story delivery progress</h2><p>Developers continue in their own tools. Singularity aggregates the canonical Story branches and returns review packets here.</p></div><button className="secondary" onClick={synchronizeStories}>↻ Synchronize Story branches</button></header></section><EpicReviewView data={data} selected={selected} action={action} reload={reload} /><EpicCompletionPanel data={data} selected={selected} action={action} reload={reload} synchronizeStories={synchronizeStories} /></div> : <>
      <section className="initiative-hero">
        <div><div className="row gap"><Pill tone="accent">{state.initiative.profileLabel}</Pill><Pill tone={state.status === 'complete' ? 'good' : 'neutral'}>{state.status}</Pill><Pill>configured-local identity</Pill></div><h2>{state.initiative.title}</h2><p>{state.initiative.id} · branch {state.initiative.branch} · current phase {state.currentPhase ?? 'complete'}</p></div><ProgressRing value={progress.percentage} />
      </section>
      <div className="initiative-metrics"><div><span>Total elapsed</span><strong>{report.duration}</strong><small>wall-clock lifecycle</small></div><div><span>Blocking stories</span><strong>{report.children.blocking}</strong><small>{report.children.stale} stale</small></div><div><span>Evidence</span><strong>{report.evidence.records}</strong><small>{report.evidence.stale} stale checks</small></div><div><span>Models</span><strong>{report.telemetry.models.length || '—'}</strong><small>{report.telemetry.models.join(', ') || 'unavailable'}</small></div><div><span>Tokens</span><strong>{formatTokens(report.telemetry.totalTokens)}</strong><small>committed usage</small></div><div><span>Cost</span><strong>{formatCost(report.telemetry.providerCost)}</strong><small>{report.telemetry.costStatus}</small></div></div>
      {!!report.approvals.selfApprovals.length && <div className="notice warn">⚠ {report.approvals.selfApprovals.length} self-approval{report.approvals.selfApprovals.length === 1 ? '' : 's'} recorded. These decisions are valid under the configured policy but are not independent review.</div>}
      <section className="panel initiative-flow-panel"><header className="panel-heading"><div><span className="eyebrow">Phase gates</span><h2>{state.initiative.profileLabel}</h2></div><span>{progress.percentage}% complete</span></header><div className={`initiative-flow ${state.phaseOrder.length > 4 ? 'enterprise' : 'lite'}`}>{progress.phases.map((phase, index) => <React.Fragment key={phase.id}><div className={`initiative-phase ${phase.status.replaceAll('_', '-')} ${phase.id === state.currentPhase ? 'current' : ''}`}><StatusDot status={phase.status} /><span><strong>{phase.label}</strong><small>{phase.generatedOutputs}/{phase.outputs} outputs · {phase.checklist} checks</small></span></div>{index < progress.phases.length - 1 && <i>→</i>}</React.Fragment>)}</div></section>
      <div className="initiative-lanes">{[['business-product', 'Business / Product'], ['design-architecture', 'Design / Architecture'], ['engineering', 'Engineering']].map(([laneId, laneLabel]) => <section className="panel" key={laneId}><header><span>{laneLabel}</span></header><div>{state.resolution.phases.filter((phase) => phase.lanes.includes(laneId)).map((phase) => <div key={phase.id}><StatusDot status={state.phases[phase.id].status} /><span><strong>{phase.label}</strong><small>{phase.outputs.map((output) => output.label).join(' · ')}</small></span></div>)}</div></section>)}</div>
      <div className="initiative-grid">
        <section className="panel initiative-checks"><header className="panel-heading"><div><span className="eyebrow">Assurance & freshness</span><h2>{currentDefinition?.label} checklist</h2></div><Pill tone={selected.phaseGate?.ready ? 'good' : 'warn'}>{selected.phaseGate?.ready ? 'Gate ready' : 'Action needed'}</Pill></header><div className="initiative-table-head"><span>Check</span><span>Requirement</span><span>Assurance</span><span>Status</span></div>{currentChecks.map((check) => <div className="initiative-table-row" key={check.id}><span><strong>{check.label}</strong><small>{check.id}</small></span><Pill>{check.requirement} · {check.gate}</Pill><span>{check.evidence.length ? check.evidence.map((entry) => entry.assurance).join(', ') : check.acceptedAssurance.join(' / ')}</span><Pill tone={['satisfied', 'waived', 'not_applicable', 'optional'].includes(check.status) ? 'good' : check.status === 'stale' ? 'warn' : 'bad'}>{check.status}</Pill></div>)}</section>
        <section className="panel initiative-next"><header className="panel-heading"><div><span className="eyebrow">Deterministic guidance</span><h2>Next actions</h2></div></header>{selected.nextActions.map((action, index) => <div key={`${action.action}:${index}`}><span>{index + 1}</span><section><strong>{action.action.replaceAll('-', ' ')}</strong><code>{action.command}</code><small>{action.reason}</small></section></div>)}</section>
      </div>
      <section className="panel initiative-stories">
        <header className="panel-heading"><div><span className="eyebrow">Repository delivery graph</span><h2>Epic-level story progress</h2></div><div className="row gap"><span>{report.children.materialized}/{children.length} materialized</span><button className="secondary compact" onClick={synchronizeStories} disabled={!report.children.materialized}>↻ Sync story branches</button><button className="primary compact" onClick={previewMaterialization} disabled={selected.materialization.phaseStatus !== 'approved'}>Create Jira & Git stories</button></div></header>
        {!epics.length ? <div className="inline-empty">The story plan has no epics yet. Use Planning Copilot on the story-plan output, review its Epic IDs and Story Work IDs, then promote it.</div> : <div className="epic-progress-list">{epics.map((epic) => <section key={epic.id} className={epic.stale ? 'stale' : ''}>
          <header><div><span className="id-pair"><b>Epic ID</b><code>{epic.id}</code></span><span className="id-pair"><b>Jira ID</b><code>{epic.jiraKey ?? 'not created'}</code></span><h3>{epic.title}</h3></div><div className="epic-progress-summary"><strong>{epic.percentage}%</strong><span>{epic.complete}/{epic.total} complete</span><div><i style={{ width: `${epic.percentage}%` }} /></div></div></header>
          <div className="epic-story-table"><div className="epic-story-head"><span>Story Work ID / Jira ID</span><span>Repository</span><span>Phase</span><span>Progress</span><span>State</span></div>{epic.stories.map((story) => <article key={story.id} className={`${story.stale ? 'stale' : ''} ${story.blocked ? 'blocked' : ''}`}><span><strong>{story.workId}</strong><small>Jira: {story.jiraKey ?? 'not created'}</small></span><span>{story.repository}</span><span>{story.currentPhase ?? (story.materialized ? 'seeded' : 'planned')}</span><span className="story-progress"><i><b style={{ width: `${story.progress?.percentage ?? 0}%` }} /></i><em>{story.progress?.percentage ?? 0}%</em></span><span><Pill tone={story.stale || story.blocked ? 'warn' : story.status === 'complete' ? 'good' : story.materialized ? 'accent' : 'neutral'}>{story.stale ? 'stale' : story.blocked ? 'blocked' : story.status}</Pill>{story.blocking && <small>blocking</small>}</span></article>)}</div>
        </section>)}</div>}
      </section>
      <div className="initiative-grid">
        <section className="panel initiative-contracts"><header className="panel-heading"><div><span className="eyebrow">Producer / consumer graph</span><h2>Interface contracts</h2></div><span>{selected.contracts.length}</span></header>{selected.contracts.length ? selected.contracts.map((contract) => <div key={contract.key}><div><strong>{contract.key}</strong><Pill tone={contract.integrity === 'verified' ? 'good' : 'warn'}>{contract.integrity}</Pill></div><span>{contract.format} · {contract.sha256.slice(0, 12)}</span><small>{contract.producers.join(', ') || 'external'} → {contract.consumers.join(', ') || 'no consumers'}</small></div>) : <div className="inline-empty">No interface contracts registered yet.</div>}</section>
        <section className="panel initiative-documents"><header className="panel-heading"><div><span className="eyebrow">Governed outputs</span><h2>Initiative documents</h2></div><span>{selected.documents.length}</span></header>{selected.documents.map((document) => <div key={`${document.phase}:${document.id}`}><span><strong>{document.label}</strong><small>{document.phase} · generation {document.generation}</small></span><Pill tone={document.status === 'approved' ? 'good' : document.status === 'stale' ? 'warn' : 'neutral'}>{document.status}</Pill><button className="ghost compact" disabled={!document.sha256} onClick={() => downloadFile(document.repositoryPath)}>Download</button></div>)}</section>
      </div>
    </>}
    {repositoryModal && <DesignerModal title="Add a participating repository" detail="Application identity and custom key/value pairs are stored as governed Git metadata under repositories.<id>.metadata in singularity/portfolio.yml." submitLabel="Add to YAML draft" error={repositoryModal.error} onCancel={() => setRepositoryModal(null)} onSubmit={addRepository}><div className="modal-grid"><label><span>Repository ID</span><input autoFocus value={repositoryModal.values.id} placeholder="mobile" onChange={(event) => repositoryField('id', event.target.value)} /></label><label><span>Application ID</span><input value={repositoryModal.values.appId} placeholder="APP-1001" onChange={(event) => repositoryField('appId', event.target.value)} /></label><label className="full"><span>Application name</span><input value={repositoryModal.values.name} placeholder="Mobile application" onChange={(event) => repositoryField('name', event.target.value)} /></label><label className="full"><span>Git URL</span><input value={repositoryModal.values.url} placeholder="git@github.com:company/mobile.git" onChange={(event) => repositoryField('url', event.target.value)} /></label><label><span>Default branch</span><input value={repositoryModal.values.defaultBranch} onChange={(event) => repositoryField('defaultBranch', event.target.value)} /></label><label className="check-row"><input type="checkbox" checked={repositoryModal.values.required} onChange={(event) => repositoryField('required', event.target.checked)} />Required for initiative delivery</label></div><div className="repository-metadata-fields"><header><div><strong>Custom metadata</strong><span>Examples: owner, businessUnit, costCenter, criticality.</span></div><button type="button" className="ghost compact" onClick={() => repositoryField('metadata', [...repositoryModal.values.metadata, { key: '', value: '' }])}>＋ Add field</button></header>{repositoryModal.values.metadata.map((entry, index) => <div key={index}><input aria-label={`Repository metadata key ${index + 1}`} value={entry.key} placeholder="owner" onChange={(event) => repositoryMetadataField(index, 'key', event.target.value)} /><input aria-label={`Repository metadata value ${index + 1}`} value={entry.value} placeholder="Digital Channels" onChange={(event) => repositoryMetadataField(index, 'value', event.target.value)} /><button type="button" className="ghost compact" aria-label={`Remove repository metadata ${index + 1}`} onClick={() => repositoryField('metadata', repositoryModal.values.metadata.filter((_, entryIndex) => entryIndex !== index))}>×</button></div>)}</div></DesignerModal>}
    {materializationModal && <DesignerModal title={`Create stories for ${state.initiative.id}?`} detail="This applies the exact reviewed Jira plan, uploads the selected hash-bound artifacts, adopts returned Jira keys as immutable Work IDs, creates one canonical branch per Story, writes governed seeds and approved Epic inputs, and publishes every receipt. It is resumable and never force-pushes." submitLabel="Create Jira & Git stories" onCancel={() => setMaterializationModal(null)} onSubmit={materializeStories}><div className="materialization-preview"><div><span>Epics</span><strong>{materializationModal.preview.epics}</strong></div><div><span>Stories</span><strong>{materializationModal.preview.stories.length}</strong></div><div><span>Repositories</span><strong>{Object.keys(materializationModal.preview.repositories).length}</strong></div><div><span>Selected artifacts</span><strong>{materializationModal.writePlan?.artifacts?.length ?? 0}</strong></div></div>{materializationModal.writePlan && <><div className="notice neutral"><strong>Exact Jira Story and artifact plan</strong><br />Plan hash: <code>{materializationModal.writePlan.sha256}</code><br />Source breakdown: <code>{materializationModal.writePlan.source.breakdownSha256}</code></div>{materializationModal.writePlan.artifacts?.length > 0 && <div className="jira-modal-artifacts">{materializationModal.writePlan.artifacts.map((artifact) => <div key={artifact.reference}><span><strong>{artifact.label}</strong><small>{artifact.filename}</small></span><code>{artifact.sha256.slice(0, 12)}</code><Pill>{artifact.targets.join(' + ')}</Pill></div>)}</div>}</>}<label><span>Type the Epic ID to confirm the exact plan</span><input autoFocus value={materializationModal.confirmation} placeholder={state.initiative.id} onChange={(event) => setMaterializationModal({ ...materializationModal, confirmation: event.target.value })} /></label>{materializationModal.confirmation !== state.initiative.id && <div className="notice warn">Exact confirmation required: <code>{state.initiative.id}</code></div>}</DesignerModal>}
  </div>;
}

function Review({ data, downloadFile }) {
  if (!data.workflow || !data.review) return <div className="page"><Empty title="Choose a work item" detail="The review bundle combines the current artifact, provenance, checks, approvals, usage, source changes, and supporting evidence." /></div>;
  const phase = data.review.phase;
  return <div className="page review-page"><header className="page-heading row-between"><div><span className="eyebrow">Unified reviewer handoff</span><h1>{phase.label} review bundle</h1><p>{data.workflow.workItem.id} · generation {phase.generation} · {phase.status.replaceAll('_', ' ')}</p></div>{data.review.artifact && <button className="secondary" onClick={() => downloadFile(data.review.artifact.path)}>Download artifact</button>}</header>
    {data.review.selfApprovalWarning && <div className="notice warn">⚠ This phase contains self-approval and must not be presented as independent review.</div>}
    {phase.id === 'visual-verification' && <VisualComparisonReview repository={data.repository.root} workId={data.selectedWorkId} records={data.review.documents} artifactContent={data.review.artifact?.content ?? ''} />}
    <div className="review-grid"><section className="panel review-summary"><header className="panel-heading"><h2>Decision context</h2><Pill tone="accent">{phase.status}</Pill></header><dl><div><dt>Required artifact</dt><dd>{data.review.artifact?.path ?? 'Not generated'}</dd></div><div><dt>Inputs</dt><dd>{data.review.inputs.length}</dd></div><div><dt>Checks</dt><dd>{data.review.checks.length}</dd></div><div><dt>Approvals</dt><dd>{data.review.approvals.length}/{phase.approvalMinimum}</dd></div><div><dt>Evidence</dt><dd>{data.review.documents.length}</dd></div><div><dt>Usage records</dt><dd>{data.review.usage.length}</dd></div></dl></section><section className="panel review-source"><header className="panel-heading"><h2>Source changes</h2></header><pre>{data.review.changeSummary || 'No source changes.'}</pre></section></div>
    <section className="panel review-document"><header className="panel-heading"><div><span className="eyebrow">Complete portable bundle</span><h2>Reviewer document</h2></div></header><pre>{data.review.markdown}</pre></section>
  </div>;
}

function Workflow({ data, editor, setEditor, saveEditor, downloadFile, importWorkflow }) {
  const draft = useMemo(() => { try { return YAML.parse(editor.content); } catch { return data.definition; } }, [editor.content, data.definition]);
  const [workType, setWorkType] = useState(Object.keys(draft.workTypes)[0]);
  const [phaseId, setPhaseId] = useState(draft.workTypes[workType]?.phases[0]);
  const [modal, setModal] = useState(null);
  useEffect(() => { if (!draft.workTypes[workType]) setWorkType(Object.keys(draft.workTypes)[0]); }, [draft, workType]);
  useEffect(() => { const first = draft.workTypes[workType]?.phases[0]; if (!draft.workTypes[workType]?.phases.includes(phaseId)) setPhaseId(first); }, [workType, draft, phaseId]);
  const profile = draft.workTypes[workType];
  const phase = draft.phases[phaseId];
  function replace(next) { setEditor({ ...editor, content: YAML.stringify(next) }); }
  function change(mutator) { const next = structuredClone(draft); mutator(next); replace(next); }
  function openModal(kind, values = {}) { setModal({ kind, error: null, values }); }
  function field(name, value) { setModal((current) => ({ ...current, error: null, values: { ...current.values, [name]: value } })); }
  function submitModal() {
    try {
      let next = draft;
      if (modal.kind === 'new-workflow') {
        next = createWorkType(draft, { ...modal.values, copyFrom: workType });
        setWorkType(modal.values.id.trim());
      } else if (modal.kind === 'delete-workflow') {
        next = removeWorkType(draft, workType);
        setWorkType(Object.keys(next.workTypes)[0]);
      } else if (modal.kind === 'add-stage') {
        next = addPhaseToWorkType(draft, workType, modal.values.phaseId);
        setPhaseId(modal.values.phaseId);
      } else if (modal.kind === 'new-stage') {
        next = createPhase(draft, workType, modal.values);
        setPhaseId(modal.values.id.trim());
      } else if (modal.kind === 'remove-stage') {
        next = removePhaseFromWorkType(draft, workType, phaseId);
        if (modal.values.deleteDefinition && !Object.values(next.workTypes).some((item) => item.phases.includes(phaseId))) next = deleteUnusedPhase(next, phaseId);
        setPhaseId(next.workTypes[workType].phases[Math.min(phaseIndex, next.workTypes[workType].phases.length - 1)]);
      }
      replace(next);
      setModal(null);
    } catch (error) {
      setModal((current) => ({ ...current, error: error.message }));
    }
  }
  function toggleApprovalPersona(personaId) { change((next) => { const values = next.phases[phaseId].approval.personas ??= []; const index = values.indexOf(personaId); if (index >= 0) values.splice(index, 1); else { values.push(personaId); const capability = next.personas[personaId].mayApprove ??= []; if (!capability.includes(phaseId)) capability.push(phaseId); } }); }
  function toggleSuggestedPersona(personaId) { change((next) => { const values = next.phases[phaseId].suggestedPersonas ??= []; const index = values.indexOf(personaId); if (index >= 0) values.splice(index, 1); else values.push(personaId); }); }
  function toggleRejectTarget(target) { change((next) => { const values = next.phases[phaseId].approval.rejectTo ??= []; const index = values.indexOf(target); if (index >= 0) values.splice(index, 1); else values.push(target); }); }
  function toggleInput(target) { const current = profile.phaseOverrides?.[phaseId]?.inputs ?? phase.inputs ?? []; const selected = current.map((entry) => typeof entry === 'string' ? entry : entry.phase); replace(setWorkTypeInputs(draft, workType, phaseId, selected.includes(target) ? selected.filter((id) => id !== target) : [...selected, target])); }
  function movePhase(offset) { change((next) => { const targetProfile = next.workTypes[workType]; const phases = targetProfile.phases; const index = phases.indexOf(phaseId); const target = index + offset; if (target < 0 || target >= phases.length) return; [phases[index], phases[target]] = [phases[target], phases[index]]; for (const [consumerIndex, consumerId] of phases.entries()) { const earlier = new Set(phases.slice(0, consumerIndex)); const inherited = targetProfile.phaseOverrides?.[consumerId]?.inputs ?? next.phases[consumerId]?.inputs ?? []; const valid = inherited.filter((entry) => earlier.has(typeof entry === 'string' ? entry : entry.phase)); if (valid.length === inherited.length) continue; targetProfile.phaseOverrides ??= {}; targetProfile.phaseOverrides[consumerId] = { ...(targetProfile.phaseOverrides[consumerId] ?? {}), inputs: valid }; } }); }
  function setGlobalGate(gate, mode) { change((next) => { next.sequenceGates ??= {}; if (mode) next.sequenceGates[gate] = mode; else delete next.sequenceGates[gate]; }); }
  function setProfileGate(gate, mode) { change((next) => { next.workTypes[workType].sequenceGates ??= {}; if (mode) next.workTypes[workType].sequenceGates[gate] = mode; else delete next.workTypes[workType].sequenceGates[gate]; }); }
  const phaseIndex = profile.phases.indexOf(phaseId);
  const templateNames = data.templates.map((item) => item.name);
  const inactivePhases = Object.keys(draft.phases).filter((id) => !profile.phases.includes(id));
  const effectiveInputs = (profile.phaseOverrides?.[phaseId]?.inputs ?? phase?.inputs ?? []).map((entry) => typeof entry === 'string' ? entry : entry.phase);
  const defaults = { persona: Object.keys(draft.personas)[0], template: templateNames[0], writeScope: 'artifact-only', minimumBytes: 200 };
  return <div className="split-page workflow-layout">
    <div className="design-pane"><header className="page-heading"><span className="eyebrow">Visual configuration</span><h1>Workflow designer</h1><p>Inspect phase order, approval authority, rejection paths, and template resolution.</p></header>
      <div className="designer-toolbar"><div className="segmented">{Object.entries(draft.workTypes).map(([id, item]) => <button className={id === workType ? 'active' : ''} key={id} onClick={() => setWorkType(id)}>{item.label}</button>)}</div><div className="row"><button className="secondary compact" onClick={() => openModal('new-workflow', { id: '', label: '' })}>＋ Workflow</button><button className="ghost compact" disabled={Object.keys(draft.workTypes).length === 1} onClick={() => openModal('delete-workflow')}>Delete</button></div></div>
      <section className="profile-card"><label><span>Workflow name</span><input value={profile.label} onChange={(event) => change((next) => { next.workTypes[workType].label = event.target.value; })} /></label><code>{workType}</code><div className="row"><button className="secondary compact" disabled={!inactivePhases.length} onClick={() => openModal('add-stage', { phaseId: inactivePhases[0] })}>＋ Existing stage</button><button className="primary compact" onClick={() => openModal('new-stage', { ...defaults, id: '', label: '', artifactFile: '', kind: '' })}>＋ New stage</button></div></section>
      <section className="gate-panel"><header><div><span className="eyebrow">Copilot session policy</span><h2>Work item & persona binding</h2></div></header><p>Select durable remote work-item state before binding the contributor's declared persona. Workflow actions audit both the persona and Git identity.</p><div className="control-grid"><label><span>Work-item selection</span><select value={draft.session?.workItemSelection ?? 'off'} onChange={(event) => change((next) => { next.session ??= {}; next.session.workItemSelection = event.target.value; })}><option value="off">Off · legacy behavior</option><option value="reuse">Reuse active branch</option><option value="prompt">Prompt and sync remote</option></select></label><label><span>Persona selection</span><select value={draft.session?.personaSelection ?? 'off'} onChange={(event) => change((next) => { next.session ??= {}; next.session.personaSelection = event.target.value; })}><option value="off">Off · legacy behavior</option><option value="reuse">Reuse valid persona</option><option value="prompt">Prompt contributor</option></select></label></div><div className="choice-group"><span>Session controls</span><div><label className={draft.session?.promptOnNewSession ? 'checked' : ''}><input type="checkbox" checked={draft.session?.promptOnNewSession ?? false} onChange={(event) => change((next) => { next.session ??= {}; next.session.promptOnNewSession = event.target.checked; })} />Ask persona in every new Copilot session</label><label className={draft.session?.promptOnResume ? 'checked' : ''}><input type="checkbox" checked={draft.session?.promptOnResume ?? false} onChange={(event) => change((next) => { next.session ??= {}; next.session.promptOnResume = event.target.checked; })} />Ask persona again when Copilot resumes</label><label className={draft.session?.requireBeforeTools ? 'checked' : ''}><input type="checkbox" checked={draft.session?.requireBeforeTools ?? false} onChange={(event) => change((next) => { next.session ??= {}; next.session.requireBeforeTools = event.target.checked; })} />Block mutating tools until both selections complete</label></div></div></section>
      <section className="gate-panel"><header><div><span className="eyebrow">Exception policy</span><h2>Sequence gates</h2></div><label><span>Global default</span><select value={draft.sequenceGates?.default ?? 'hard'} onChange={(event) => setGlobalGate('default', event.target.value)}><option value="hard">Hard · block</option><option value="soft">Soft · ask</option></select></label></header><p>Hard gates stop immediately. Soft gates require a human to type <code>continue</code> and record an audited override.</p><div className="gate-grid"><strong>Gate</strong><strong>Global</strong><strong>{profile.label}</strong>{sequenceGates.map(([id, label]) => <React.Fragment key={id}><label title={id}>{label}<small>{id}</small></label><select value={draft.sequenceGates?.[id] ?? ''} onChange={(event) => setGlobalGate(id, event.target.value)}><option value="">Use default</option><option value="hard">Hard</option><option value="soft">Soft</option></select><select value={profile.sequenceGates?.[id] ?? ''} onChange={(event) => setProfileGate(id, event.target.value)}><option value="">Use global</option><option value="hard">Hard</option><option value="soft">Soft</option></select></React.Fragment>)}</div></section>
      <div className="flow-canvas">{profile.phases.map((id, index) => <React.Fragment key={id}><button className={`phase-node ${id === phaseId ? 'selected' : ''}`} onClick={() => setPhaseId(id)}><span>{String(index + 1).padStart(2, '0')}</span><strong>{draft.phases[id].label}</strong><small>{draft.workTypes[workType].templateOverrides?.[id] ?? draft.phases[id].defaultTemplate}</small></button>{index < profile.phases.length - 1 && <div className="connector">↓</div>}</React.Fragment>)}</div>
      {phase && <section className="inspector"><div className="inspector-title"><div><span className="eyebrow">Selected stage</span><h2>{phase.label}</h2></div><div className="row"><button className="icon-button" disabled={phaseIndex === 0} onClick={() => movePhase(-1)}>↑</button><button className="icon-button" disabled={phaseIndex === profile.phases.length - 1} onClick={() => movePhase(1)}>↓</button><button className="ghost compact" disabled={profile.phases.length === 1} onClick={() => openModal('remove-stage', { deleteDefinition: false })}>Remove</button></div></div>
        <div className="control-grid expanded"><label><span>Stage name</span><input value={phase.label} onChange={(event) => change((next) => { next.phases[phaseId].label = event.target.value; })} /></label><label><span>Write scope</span><select value={phase.writeScope} onChange={(event) => change((next) => { next.phases[phaseId].writeScope = event.target.value; })}><option value="artifact-only">Artifact only</option><option value="source-and-artifact">Source and artifact</option></select></label><label className="full"><span>Artifact path</span><input value={phase.artifact.path} onChange={(event) => change((next) => { next.phases[phaseId].artifact.path = event.target.value; })} /></label><label><span>Artifact kind</span><input value={phase.artifact.kind ?? ''} onChange={(event) => change((next) => { next.phases[phaseId].artifact.kind = event.target.value; })} /></label><label><span>Minimum bytes</span><input type="number" min="1" value={phase.artifact.minimumBytes ?? 1} onChange={(event) => change((next) => { next.phases[phaseId].artifact.minimumBytes = Number(event.target.value); })} /></label><label><span>Approval threshold</span><input type="number" min="0" max="10" value={phase.approval?.minimum ?? 0} onChange={(event) => change((next) => { next.phases[phaseId].approval.minimum = Number(event.target.value); })} /></label><label><span>Artifact template</span><select value={profile.templateOverrides?.[phaseId] ?? phase.defaultTemplate} onChange={(event) => change((next) => { next.workTypes[workType].templateOverrides ??= {}; next.workTypes[workType].templateOverrides[phaseId] = event.target.value; })}>{templateNames.map((name) => <option value={name} key={name}>{name}</option>)}</select></label><label className="full"><span>World-model views</span><input value={phase.worldModel?.views?.join(', ') ?? ''} onChange={(event) => change((next) => { next.phases[phaseId].worldModel ??= {}; next.phases[phaseId].worldModel.views = event.target.value.split(',').map((item) => item.trim()).filter(Boolean); })} /></label><label className="full"><span>Quality commands (one per line)</span><textarea value={phase.qualityCommands?.join('\n') ?? ''} onChange={(event) => change((next) => { next.phases[phaseId].qualityCommands = event.target.value.split('\n').map((item) => item.trim()).filter(Boolean); })} /></label></div>
        <div className="choice-group"><span>Inputs from earlier stages</span><div>{profile.phases.slice(0, phaseIndex).map((id) => <label key={id} className={effectiveInputs.includes(id) ? 'checked' : ''}><input type="checkbox" checked={effectiveInputs.includes(id)} onChange={() => toggleInput(id)} />{draft.phases[id].label}</label>)}{phaseIndex === 0 && <small className="choice-empty">First stage has no earlier inputs.</small>}</div></div>
        <div className="choice-group"><span>Suggested personas</span><div>{Object.entries(draft.personas).map(([id, persona]) => <label key={id} className={phase.suggestedPersonas?.includes(id) ? 'checked' : ''}><input type="checkbox" checked={phase.suggestedPersonas?.includes(id)} onChange={() => toggleSuggestedPersona(id)} />{persona.label}</label>)}</div></div>
        <div className="choice-group"><span>Approval personas</span><div>{Object.entries(draft.personas).map(([id, persona]) => <label key={id} className={phase.approval?.personas?.includes(id) ? 'checked' : ''}><input type="checkbox" checked={phase.approval?.personas?.includes(id)} onChange={() => toggleApprovalPersona(id)} />{persona.label}</label>)}</div></div>
        <div className="choice-group"><span>Allowed rejection targets</span><div>{profile.phases.slice(0, phaseIndex + 1).map((id) => <label key={id} className={phase.approval?.rejectTo?.includes(id) ? 'checked' : ''}><input type="checkbox" checked={phase.approval?.rejectTo?.includes(id)} onChange={() => toggleRejectTarget(id)} />{draft.phases[id].label}</label>)}</div></div>
      </section>}
    </div>
    <SourceEditor path={data.definitionPath} value={editor.content} dirty={editor.content !== editor.original} onChange={(content) => setEditor({ ...editor, content })} language="yaml" onSave={saveEditor} onDownload={() => downloadFile(data.definitionPath)} onImport={importWorkflow} />
    {modal?.kind === 'new-workflow' && <DesignerModal title="Create workflow" detail={`Create a new profile by copying ${profile.label}, then adjust its stages.`} submitLabel="Create workflow" error={modal.error} onCancel={() => setModal(null)} onSubmit={submitModal}><label><span>Workflow ID</span><input autoFocus value={modal.values.id} placeholder="security-review" onChange={(event) => field('id', event.target.value)} /></label><label><span>Display name</span><input value={modal.values.label} placeholder="Security review" onChange={(event) => field('label', event.target.value)} /></label></DesignerModal>}
    {modal?.kind === 'delete-workflow' && <DesignerModal title={`Delete ${profile.label}?`} detail="The workflow profile will be removed from the YAML draft. Shared stage definitions and templates remain available." submitLabel="Delete workflow" danger error={modal.error} onCancel={() => setModal(null)} onSubmit={submitModal} />}
    {modal?.kind === 'add-stage' && <DesignerModal title="Add an existing stage" detail="The stage is appended and receives the current last stage as its initial input." submitLabel="Add stage" error={modal.error} onCancel={() => setModal(null)} onSubmit={submitModal}><label><span>Available stage</span><select value={modal.values.phaseId} onChange={(event) => field('phaseId', event.target.value)}>{inactivePhases.map((id) => <option key={id} value={id}>{draft.phases[id].label} · {id}</option>)}</select></label></DesignerModal>}
    {modal?.kind === 'new-stage' && <DesignerModal title="Create a stage and artifact contract" detail="The stage is added to this workflow. Its ID, artifact location, approval authority, and template become governed YAML." submitLabel="Create stage" error={modal.error} onCancel={() => setModal(null)} onSubmit={submitModal}><div className="modal-grid"><label><span>Stage ID</span><input autoFocus value={modal.values.id} placeholder="security-review" onChange={(event) => field('id', event.target.value)} /></label><label><span>Stage name</span><input value={modal.values.label} placeholder="Security review" onChange={(event) => field('label', event.target.value)} /></label><label><span>Artifact filename</span><input value={modal.values.artifactFile} placeholder="security-review.md" onChange={(event) => field('artifactFile', event.target.value)} /></label><label><span>Artifact kind</span><input value={modal.values.kind} placeholder="security-review" onChange={(event) => field('kind', event.target.value)} /></label><label><span>Template</span><select value={modal.values.template} onChange={(event) => field('template', event.target.value)}>{templateNames.map((name) => <option key={name} value={name}>{name}</option>)}</select></label><label><span>Approval persona</span><select value={modal.values.persona} onChange={(event) => field('persona', event.target.value)}>{Object.entries(draft.personas).map(([id, persona]) => <option key={id} value={id}>{persona.label}</option>)}</select></label><label><span>Write scope</span><select value={modal.values.writeScope} onChange={(event) => field('writeScope', event.target.value)}><option value="artifact-only">Artifact only</option><option value="source-and-artifact">Source and artifact</option></select></label><label><span>Minimum bytes</span><input type="number" min="1" value={modal.values.minimumBytes} onChange={(event) => field('minimumBytes', event.target.value)} /></label></div></DesignerModal>}
    {modal?.kind === 'remove-stage' && <DesignerModal title={`Remove ${phase.label}?`} detail={`This removes the stage from ${profile.label} and cleans its profile-specific inputs.`} submitLabel="Remove stage" danger error={modal.error} onCancel={() => setModal(null)} onSubmit={submitModal}><label className="check-row"><input type="checkbox" checked={modal.values.deleteDefinition} onChange={(event) => field('deleteDefinition', event.target.checked)} /><span>Also delete the global stage definition if no other workflow uses it. Templates are never deleted automatically.</span></label></DesignerModal>}
  </div>;
}

function Personas({ data, openPrompt, savePersona, createPersonaConfig, deletePersonaConfig, downloadFile }) {
  const [selected, setSelected] = useState(Object.keys(data.definition.personas)[0]);
  const [draft, setDraft] = useState(structuredClone(data.definition.personas[selected]));
  const [modal, setModal] = useState(null);
  useEffect(() => { if (!data.definition.personas[selected]) setSelected(Object.keys(data.definition.personas)[0]); }, [data, selected]);
  useEffect(() => { setDraft(structuredClone(data.definition.personas[selected] ?? Object.values(data.definition.personas)[0])); }, [data, selected]);
  const personaId = data.definition.personas[selected] ? selected : Object.keys(data.definition.personas)[0];
  const persona = data.definition.personas[personaId];
  const prompt = data.personaPrompts.find((item) => item.name === persona?.prompt);
  const dirty = JSON.stringify(draft) !== JSON.stringify(persona);
  function field(name, value) { setDraft((current) => ({ ...current, [name]: value })); }
  function toggle(name, value) { const values = draft[name] ?? []; field(name, values.includes(value) ? values.filter((item) => item !== value) : [...values, value]); }
  async function submitNew() { const result = await createPersonaConfig(modal.values); if (result) { setSelected(modal.values.id.trim()); setModal(null); } }
  async function submitDelete() { const result = await deletePersonaConfig(personaId, modal.replacement); if (result) { setSelected(modal.replacement); setModal(null); } }
  return <div className="page"><header className="page-heading row-between"><div><span className="eyebrow">Identity, prompt, and authority</span><h1>Personas & approvals</h1><p>Create personas, edit their prompt perspective, and configure phase and approval coverage.</p></div><div className="row"><button className="secondary" disabled={Object.keys(data.definition.personas).length === 1} onClick={() => setModal({ kind: 'delete', replacement: Object.keys(data.definition.personas).find((id) => id !== selected) })}>Delete persona</button><button className="primary" onClick={() => setModal({ kind: 'new', error: null, values: { id: '', label: '', description: '', prompt: '' } })}>＋ Persona</button></div></header>
    <div className="persona-grid">{Object.entries(data.definition.personas).map(([id, item]) => <button key={id} className={`persona-card ${personaId === id ? 'selected' : ''}`} onClick={() => setSelected(id)}><span className="avatar">{item.label.slice(0, 2).toUpperCase()}</span><strong>{item.label}</strong><small>{item.description}</small><div className="tags">{item.worldModelViews?.map((view) => <Pill key={view}>{view}</Pill>)}</div></button>)}</div>
    <div className="two-column"><section className="panel persona-detail"><header className="panel-heading"><div><span className="eyebrow">Persona contract</span><h2>{persona.label}</h2></div><div className="row">{prompt && <button className="ghost compact" onClick={() => downloadFile(prompt.path)}>Download prompt</button>}{prompt && <button className="secondary compact" onClick={() => openPrompt(prompt)}>Edit prompt</button>}<button className="primary compact" disabled={!dirty} onClick={() => savePersona(personaId, draft)}>Save persona</button></div></header><div className="persona-form"><label><span>Display name</span><input value={draft.label} onChange={(event) => field('label', event.target.value)} /></label><label><span>Description</span><textarea value={draft.description ?? ''} onChange={(event) => field('description', event.target.value)} /></label><label><span>Prompt file</span><select value={draft.prompt} onChange={(event) => field('prompt', event.target.value)}>{data.personaPrompts.map((file) => <option key={file.name} value={file.name}>{file.name}</option>)}</select></label><label><span>Repository world-model views</span><input value={draft.worldModelViews?.join(', ') ?? ''} onChange={(event) => field('worldModelViews', event.target.value.split(',').map((item) => item.trim()).filter(Boolean))} placeholder="architecture, security" /></label></div><div className="choice-group persona-choices"><span>Suggested stages</span><div>{Object.entries(data.definition.phases).map(([id, phase]) => <label key={id} className={draft.suggestedPhases?.includes(id) ? 'checked' : ''}><input type="checkbox" checked={draft.suggestedPhases?.includes(id)} onChange={() => toggle('suggestedPhases', id)} />{phase.label}</label>)}</div></div><div className="choice-group persona-choices"><span>May approve</span><div>{Object.entries(data.definition.phases).map(([id, phase]) => <label key={id} className={draft.mayApprove?.includes(id) ? 'checked' : ''}><input type="checkbox" checked={draft.mayApprove?.includes(id)} onChange={() => toggle('mayApprove', id)} />{phase.label}</label>)}</div></div></section>
      <section className="panel"><header className="panel-heading"><div><span className="eyebrow">Approval coverage</span><h2>Configured rules</h2></div></header><div className="rule-list">{Object.entries(data.definition.phases).filter(([, phase]) => phase.approval?.personas?.includes(personaId)).map(([id, phase]) => <div key={id}><StatusDot status="approved" /><span><strong>{phase.label}</strong><small>{phase.approval.minimum} required · reject to {phase.approval.rejectTo?.join(', ')}</small></span></div>)}</div></section></div>
    {modal?.kind === 'new' && <DesignerModal title="Create persona and prompt" detail="A configurable Markdown prompt is created in the repository and linked from workflow.yml." submitLabel="Create persona" error={modal.error} onCancel={() => setModal(null)} onSubmit={submitNew}><div className="modal-grid"><label><span>Persona ID</span><input autoFocus value={modal.values.id} placeholder="security-reviewer" onChange={(event) => setModal({ ...modal, values: { ...modal.values, id: event.target.value, prompt: modal.values.prompt || `${event.target.value}.md` } })} /></label><label><span>Display name</span><input value={modal.values.label} placeholder="Security reviewer" onChange={(event) => setModal({ ...modal, values: { ...modal.values, label: event.target.value } })} /></label><label className="full"><span>Description</span><input value={modal.values.description} placeholder="Review threats, controls, and evidence." onChange={(event) => setModal({ ...modal, values: { ...modal.values, description: event.target.value } })} /></label><label className="full"><span>Prompt filename</span><input value={modal.values.prompt} placeholder="security-reviewer.md" onChange={(event) => setModal({ ...modal, values: { ...modal.values, prompt: event.target.value } })} /></label></div></DesignerModal>}
    {modal?.kind === 'delete' && <DesignerModal title={`Delete ${persona.label}?`} detail="Every stage reference will move to the replacement persona. The old prompt is removed only when nothing else references it." submitLabel="Delete persona" danger onCancel={() => setModal(null)} onSubmit={submitDelete}><label><span>Replacement persona</span><select value={modal.replacement} onChange={(event) => setModal({ ...modal, replacement: event.target.value })}>{Object.entries(data.definition.personas).filter(([id]) => id !== selected).map(([id, item]) => <option key={id} value={id}>{item.label}</option>)}</select></label></DesignerModal>}
  </div>;
}

function InlineMarkdown({ text }) {
  const pieces = String(text).split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)]+\))/g).filter(Boolean);
  return pieces.map((piece, index) => {
    if (piece.startsWith('**') && piece.endsWith('**')) return <strong key={index}>{piece.slice(2, -2)}</strong>;
    if (piece.startsWith('`') && piece.endsWith('`')) return <code key={index}>{piece.slice(1, -1)}</code>;
    const link = piece.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/);
    if (link) return <a key={index} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>;
    return <React.Fragment key={index}>{piece}</React.Fragment>;
  });
}

function markdownBlocks(content) {
  const lines = content.split('\n');
  const blocks = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (line.startsWith('```')) {
      const language = line.slice(3).trim(); const code = []; index += 1;
      while (index < lines.length && !lines[index].startsWith('```')) { code.push(lines[index]); index += 1; }
      blocks.push(<pre className="preview-code" key={`code-${index}`}><code data-language={language}>{code.join('\n')}</code></pre>); index += 1; continue;
    }
    if (line.startsWith('|')) {
      const rows = []; while (index < lines.length && lines[index].startsWith('|')) { rows.push(lines[index].split('|').slice(1, -1).map((cell) => cell.trim())); index += 1; }
      const dataRows = rows.filter((row) => !row.every((cell) => /^:?-+:?$/.test(cell)));
      const [header, ...body] = dataRows;
      blocks.push(<div className="preview-table-wrap" key={`table-${index}`}><table className="preview-table"><thead><tr>{header?.map((cell, cellIndex) => <th key={cellIndex}><InlineMarkdown text={cell} /></th>)}</tr></thead><tbody>{body.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}><InlineMarkdown text={cell} /></td>)}</tr>)}</tbody></table></div>); continue;
    }
    if (line.startsWith('# ')) blocks.push(<h1 key={index}><InlineMarkdown text={line.slice(2)} /></h1>);
    else if (line.startsWith('## ')) blocks.push(<h2 key={index}><InlineMarkdown text={line.slice(3)} /></h2>);
    else if (line.startsWith('### ')) blocks.push(<h3 key={index}><InlineMarkdown text={line.slice(4)} /></h3>);
    else if (line.startsWith('- ')) blocks.push(<div className="preview-list" key={index}>• <InlineMarkdown text={line.slice(2)} /></div>);
    else if (/^\d+\.\s/.test(line)) blocks.push(<div className="preview-list numbered" key={index}><InlineMarkdown text={line} /></div>);
    else if (line.startsWith('> ')) blocks.push(<blockquote key={index}><InlineMarkdown text={line.slice(2)} /></blockquote>);
    else if (line) blocks.push(<p key={index}><InlineMarkdown text={line} /></p>);
    index += 1;
  }
  return blocks;
}

function TemplatePreview({ content, className = '' }) {
  return <div className={`markdown-preview ${className}`}>{markdownBlocks(content)}</div>;
}

const helpMatches = [...helpMarkdown.matchAll(/^##\s+(.+)$/gm)];
const helpTopics = helpMatches.map((match, index) => ({
  id: match[1].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
  title: match[1].trim(),
  content: helpMarkdown.slice(match.index + match[0].length, helpMatches[index + 1]?.index ?? helpMarkdown.length).trim()
}));

function Help() {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(helpTopics[0]?.id);
  const filtered = helpTopics.filter((topic) => `${topic.title}\n${topic.content}`.toLowerCase().includes(query.trim().toLowerCase()));
  const topic = helpTopics.find((item) => item.id === selected && filtered.includes(item)) ?? filtered[0];
  return <div className="help-layout">
    <aside className="help-toc"><header><span className="eyebrow">Built-in manual</span><h2>Help</h2><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search help…" /></header><div className="help-topic-list">{filtered.map((item) => <button key={item.id} className={topic?.id === item.id ? 'active' : ''} onClick={() => setSelected(item.id)}>{item.title}</button>)}</div>{!filtered.length && <p className="help-empty">No help topic matches “{query}”.</p>}</aside>
    <main className="help-main"><header className="help-header"><div><span className="eyebrow">Singularity Flow manual</span><h1>{topic?.title ?? 'No results'}</h1></div>{topic && <code>singularity-flow help {topic.id}</code>}</header>{topic && <TemplatePreview className="help-preview" content={`## ${topic.title}\n\n${topic.content}`} />}</main>
  </div>;
}

function Templates({ data, editor, setEditor, chooseTemplate, saveEditor, createTemplate, deleteTemplate, downloadFile, importTemplate }) {
  const [search, setSearch] = useState('');
  const [view, setView] = useState('builder');
  const [modal, setModal] = useState(null);
  const [artifact, setArtifact] = useState(() => parseArtifactTemplate(editor.content));
  const [selectedSection, setSelectedSection] = useState(null);
  const files = data.templates.filter((item) => item.name.toLowerCase().includes(search.toLowerCase()));
  const current = data.templates.find((file) => file.path === editor.path) ?? null;
  const groups = [...new Set(ARTIFACT_SECTION_LIBRARY.map((item) => item.group))];
  useEffect(() => {
    const parsed = parseArtifactTemplate(editor.content);
    setArtifact(parsed);
    setSelectedSection(parsed.sections[0]?.id ?? null);
  }, [editor.path]);
  async function submitCreate() { if (!modal.name.trim()) return setModal({ ...modal, error: 'Enter a relative Markdown filename.' }); const result = await createTemplate(modal.name.trim()); if (result) setModal(null); }
  async function submitDelete() { const result = await deleteTemplate(current); if (result) setModal(null); }
  function applyArtifact(next) {
    setArtifact(next);
    setEditor({ ...editor, content: serializeArtifactTemplate(next) });
  }
  function switchView(next) {
    if (next === 'builder') {
      const parsed = parseArtifactTemplate(editor.content);
      setArtifact(parsed);
      setSelectedSection(parsed.sections[0]?.id ?? null);
    }
    setView(next);
  }
  function insertSection(type, targetIndex = artifact.sections.length) {
    const next = addArtifactSection(artifact, type, targetIndex);
    applyArtifact(next);
    setSelectedSection(next.sections[targetIndex]?.id ?? next.sections.at(-1)?.id ?? null);
  }
  function moveSection(sectionId, targetIndex) {
    applyArtifact(moveArtifactSection(artifact, sectionId, targetIndex));
  }
  function dropSection(event, targetIndex) {
    event.preventDefault();
    const type = event.dataTransfer.getData('application/x-singularity-section-type');
    const sectionId = event.dataTransfer.getData('application/x-singularity-section-id');
    if (type) insertSection(type, targetIndex);
    else if (sectionId) moveSection(sectionId, targetIndex);
  }
  async function submitRemoteTemplate() {
    if (!modal.url?.trim()) return setModal({ ...modal, error: 'Enter a public HTTPS Markdown URL.' });
    if (!modal.fetched) {
      setModal({ ...modal, fetching: true, error: null });
      try {
        const fetched = await window.singularity.previewTemplateUrl(data.repository.root, modal.url.trim());
        let filename = 'remote-template.md';
        try {
          const candidate = new URL(fetched.resolvedUrl).pathname.split('/').filter(Boolean).at(-1);
          if (candidate) filename = candidate.replace(/[^a-zA-Z0-9._-]/g, '-');
        } catch { /* The main process already validated the URL. */ }
        if (!filename.toLowerCase().endsWith('.md')) filename = `${filename}.md`;
        setModal({ ...modal, fetching: false, fetched, name: modal.name || `imports/${filename}`, error: null });
      } catch (error) {
        setModal({ ...modal, fetching: false, error: error?.message || String(error) });
      }
      return;
    }
    if (modal.destination === 'current' && current) {
      setEditor({ ...editor, content: modal.fetched.content });
      const parsed = parseArtifactTemplate(modal.fetched.content);
      setArtifact(parsed);
      setSelectedSection(parsed.sections[0]?.id ?? null);
      setView('builder');
      setModal(null);
      return;
    }
    if (!modal.name?.trim()) return setModal({ ...modal, error: 'Enter a repository template path.' });
    const result = await createTemplate(modal.name.trim(), modal.fetched.content);
    if (result) {
      setView('builder');
      setModal(null);
    }
  }
  return <div className="template-layout"><aside className="file-list"><header><div className="row-between"><div><span className="eyebrow">Artifact library</span><h2>Templates</h2></div><div className="row"><button className="icon-button" title="Import template from this computer" onClick={importTemplate}>⇧</button><button className="icon-button" title="Create template" onClick={() => setModal({ kind: 'create', name: '', error: null })}>＋</button></div></div><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Filter templates…" /></header>{files.map((file) => <button key={file.path} className={editor.path === file.path ? 'active' : ''} onClick={() => chooseTemplate(file)}><span>MD</span><div><strong>{file.name.split('/').at(-1)}</strong><small>{file.name.includes('/') ? file.name.slice(0, file.name.lastIndexOf('/')) : 'root'}</small></div></button>)}</aside>
    <main className="template-main"><header className="template-toolbar"><div><span className="eyebrow">Artifact builder</span><h1>{editor.path?.split('/').at(-1)}</h1></div><div className="row"><div className="segmented small"><button className={view === 'builder' ? 'active' : ''} onClick={() => switchView('builder')}>Builder</button><button className={view === 'source' ? 'active' : ''} onClick={() => switchView('source')}>Source</button><button className={view === 'preview' ? 'active' : ''} onClick={() => switchView('preview')}>Preview</button></div><button className="secondary compact" disabled={!current} onClick={() => downloadFile(current.path)}>Download</button><Pill tone={editor.content !== editor.original ? 'warn' : 'good'}>{editor.content !== editor.original ? 'Unsaved' : 'Saved'}</Pill><button className="primary compact" disabled={editor.content === editor.original} onClick={saveEditor}>Save</button></div></header>
      <div className="template-contract-bar"><span>Drag reusable sections into the canvas. The builder writes standard Markdown with <code>{'{{work.id}}'}</code>, <code>{'{{phase.label}}'}</code>, and <code>{'{{inputs}}'}</code>.</span><div className="row"><button className="ghost compact" onClick={() => setModal({ kind: 'url', url: '', name: '', destination: 'new', fetched: null, error: null })}>Import from URL</button><button className="ghost compact" onClick={importTemplate}>Import file</button><button className="ghost compact" disabled={!current} onClick={() => setModal({ kind: 'delete', error: null })}>Delete template</button></div></div>
      {view === 'builder' ? <div className="artifact-builder">
        <aside className="artifact-section-palette"><header><span className="eyebrow">Section library</span><h2>Drag into artifact</h2><p>Click also adds a section at the end.</p></header>{groups.map((group) => <section key={group}><strong>{group}</strong>{ARTIFACT_SECTION_LIBRARY.filter((item) => item.group === group).map((item) => <button key={item.type} draggable onDragStart={(event) => { event.dataTransfer.effectAllowed = 'copy'; event.dataTransfer.setData('application/x-singularity-section-type', item.type); }} onClick={() => insertSection(item.type)}><span>＋</span><div><b>{item.label}</b><small>{item.description}</small></div></button>)}</section>)}</aside>
        <section className="artifact-builder-canvas"><header><div><span className="eyebrow">Artifact structure</span><h2>{artifact.sections.length} sections</h2></div><div className="template-token-tray"><code>{'{{work.id}}'}</code><code>{'{{phase.label}}'}</code><code>{'{{inputs}}'}</code></div></header>
          <article className="artifact-preamble-card"><div><span>DOC</span><strong>Document header</strong><small>Title, managed metadata placeholders, and opening guidance</small></div><textarea value={artifact.preamble} onChange={(event) => applyArtifact({ ...artifact, preamble: event.target.value })} rows="5" placeholder={'# {{work.id}} — {{phase.label}}'} /></article>
          <div className="artifact-drop-zone" onDragOver={(event) => event.preventDefault()} onDrop={(event) => dropSection(event, 0)}><span>Drop a section here</span></div>
          {artifact.sections.map((section, index) => <React.Fragment key={section.id}><article className={`artifact-section-card ${selectedSection === section.id ? 'selected' : ''}`} draggable onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-singularity-section-id', section.id); }} onClick={() => setSelectedSection(section.id)}>
            <header><button className="artifact-drag-handle" type="button" aria-label={`Drag ${section.title}`}>⠿</button><span>{String(index + 1).padStart(2, '0')}</span><input value={section.title} aria-label="Section title" onChange={(event) => applyArtifact(updateArtifactSection(artifact, section.id, { title: event.target.value }))} /><Pill>{section.type}</Pill><div><button type="button" title="Move section up" disabled={index === 0} onClick={(event) => { event.stopPropagation(); moveSection(section.id, index - 1); }}>↑</button><button type="button" title="Move section down" disabled={index === artifact.sections.length - 1} onClick={(event) => { event.stopPropagation(); moveSection(section.id, index + 2); }}>↓</button><button type="button" className="danger-text" title="Remove section" onClick={(event) => { event.stopPropagation(); applyArtifact(removeArtifactSection(artifact, section.id)); }}>×</button></div></header>
            <textarea value={section.body} onChange={(event) => applyArtifact(updateArtifactSection(artifact, section.id, { body: event.target.value }))} rows={Math.max(4, Math.min(10, section.body.split('\n').length + 2))} />
          </article><div className="artifact-drop-zone" onDragOver={(event) => event.preventDefault()} onDrop={(event) => dropSection(event, index + 1)}><span>Drop between sections</span></div></React.Fragment>)}
          {!artifact.sections.length && <div className="artifact-canvas-empty"><span>↙</span><strong>Build the artifact structure</strong><p>Drag sections from the library or click a section to add it.</p></div>}
        </section>
        <aside className="artifact-live-preview"><header><div><span className="eyebrow">Live output</span><h2>Markdown preview</h2></div><Pill tone="accent">Live</Pill></header><TemplatePreview content={editor.content} /></aside>
      </div> : view === 'preview' ? <TemplatePreview content={editor.content} /> : <Editor height="calc(100vh - 186px)" language="markdown" theme="vs-dark" value={editor.content} onChange={(content) => setEditor({ ...editor, content: content ?? '' })} options={{ minimap: { enabled: false }, fontSize: 13, lineHeight: 21, wordWrap: 'on', padding: { top: 20 }, scrollBeyondLastLine: false, automaticLayout: true }} />}
    </main>
    {modal?.kind === 'create' && <DesignerModal title="Create artifact template" detail="Create repository Markdown under the configured templates root. You can assign it to a stage from the Workflow page." submitLabel="Create template" error={modal.error} onCancel={() => setModal(null)} onSubmit={submitCreate}><label><span>Relative template path</span><input autoFocus value={modal.name} placeholder="security/security-review.md" onChange={(event) => setModal({ ...modal, name: event.target.value, error: null })} /></label></DesignerModal>}
    {modal?.kind === 'url' && <DesignerModal title="Import a template from URL" detail="Singularity fetches non-empty UTF-8 Markdown from a public HTTPS URL, follows at most three HTTPS redirects, and enforces a 1 MiB limit. No credentials or cookies are sent." submitLabel={modal.fetching ? 'Fetching…' : modal.fetched ? 'Use this template' : 'Fetch & preview'} error={modal.error} onCancel={() => setModal(null)} onSubmit={submitRemoteTemplate}><label><span>Public Markdown URL</span><input autoFocus type="url" value={modal.url} disabled={modal.fetching || modal.fetched} placeholder="https://raw.githubusercontent.com/org/templates/main/requirements.md" onChange={(event) => setModal({ ...modal, url: event.target.value, error: null })} /></label>{modal.fetched && <><div className="remote-template-receipt"><span><b>Verified Markdown</b><small>{modal.fetched.size.toLocaleString()} bytes · SHA-256 {modal.fetched.sha256.slice(0, 16)}…</small></span><code>{modal.fetched.resolvedUrl}</code></div><div className="remote-template-preview"><TemplatePreview content={modal.fetched.content} /></div><div className="choice-group remote-template-destination"><span>Destination</span><div><label className={modal.destination === 'new' ? 'checked' : ''}><input type="radio" checked={modal.destination === 'new'} onChange={() => setModal({ ...modal, destination: 'new' })} />Create a new repository template</label>{current && <label className={modal.destination === 'current' ? 'checked' : ''}><input type="radio" checked={modal.destination === 'current'} onChange={() => setModal({ ...modal, destination: 'current' })} />Replace the current editor draft</label>}</div></div>{modal.destination === 'new' && <label><span>Relative template path</span><input value={modal.name} placeholder="imports/requirements.md" onChange={(event) => setModal({ ...modal, name: event.target.value, error: null })} /></label>}</>}</DesignerModal>}
    {modal?.kind === 'delete' && <DesignerModal title={`Delete ${current?.name}?`} detail="Deletion is allowed only when no stage or workflow profile references this template." submitLabel="Delete template" danger error={modal.error} onCancel={() => setModal(null)} onSubmit={submitDelete} />}
  </div>;
}

function Resources({ data, editor, setEditor, chooseResource, saveEditor, createSkill, deleteFile, downloadFile, importResource, materializeWorldModelPrompt, materializePlanningPrompt }) {
  const [category, setCategory] = useState(editor.kind === 'skill' ? 'skills' : 'prompts');
  const [modal, setModal] = useState(null);
  const promptFiles = [
    ...data.personaPrompts,
    { ...data.worldModelPrompt, name: `world-model/${data.worldModelPrompt.name}`, worldModelBuilder: true },
    { ...data.planning.prompt, name: `planning/${data.planning.prompt.name}`, planningPrompt: true }
  ];
  const files = category === 'skills' ? data.repositorySkills : promptFiles;
  const current = files.find((file) => file.path === editor.path) ?? files[0];
  useEffect(() => { if (current && editor.path !== current.path) chooseResource(current, category === 'skills' ? 'skill' : 'prompt'); }, [category]);
  async function submitSkill() { const result = await createSkill(modal.id.trim()); if (result) setModal(null); }
  return <div className="template-layout"><aside className="file-list"><header><div className="row-between"><div><span className="eyebrow">Repository Markdown</span><h2>Prompts & skills</h2></div><button className="icon-button" title={category === 'skills' ? 'Create skill' : 'Import prompt'} onClick={() => category === 'skills' ? setModal({ kind: 'skill', id: '', error: null }) : importResource('prompt')}>＋</button></div><div className="segmented resource-tabs"><button className={category === 'prompts' ? 'active' : ''} onClick={() => setCategory('prompts')}>Prompts</button><button className={category === 'skills' ? 'active' : ''} onClick={() => setCategory('skills')}>Skills</button></div></header>{files.map((file) => <button key={file.path} className={current?.path === file.path ? 'active' : ''} onClick={() => chooseResource(file, category === 'skills' ? 'skill' : 'prompt')}><span>{category === 'skills' ? 'SK' : 'PR'}</span><div><strong>{file.name.split('/').at(-1)}</strong><small>{file.worldModelBuilder ? 'world-model builder' : file.planningPrompt ? 'Copilot planning contract' : file.name.includes('/') ? file.name.slice(0, file.name.lastIndexOf('/')) : category === 'skills' ? 'repository skill' : 'persona prompt'}</small></div></button>)}</aside>
    <main className="template-main">{current ? <><div className="resource-summary"><div><Pill tone="accent">{current.worldModelBuilder ? 'Builder prompt' : current.planningPrompt ? 'Planning contract' : category === 'skills' ? 'Repository skill' : 'Persona prompt'}</Pill><span>{current.worldModelBuilder ? 'Controls repository world-model generation.' : current.planningPrompt ? 'Controls phase-aware Copilot Plan-mode behavior and promotion output.' : category === 'skills' ? 'Discovered by Copilot from .github/skills.' : 'Combined with phase and world-model context.'}</span></div><div className="row"><button className="ghost compact" onClick={() => importResource(current.worldModelBuilder ? 'world-prompt' : current.planningPrompt ? 'planner-prompt' : category === 'skills' ? 'skill' : 'prompt')}>Import</button>{!current.missing && <button className="secondary compact" onClick={() => downloadFile(current.path)}>Download</button>}{category === 'skills' && <button className="ghost compact" onClick={() => deleteFile(current)}>Delete</button>}{current.worldModelBuilder && current.missing && <button className="primary compact" onClick={() => materializeWorldModelPrompt(editor.path === current.path ? editor.content : current.content)}>Create repository copy</button>}{current.planningPrompt && current.missing && <button className="primary compact" onClick={() => materializePlanningPrompt(editor.path === current.path ? editor.content : current.content)}>Create repository copy</button>}</div></div><SourceEditor path={current.path} value={editor.path === current.path ? editor.content : current.content} dirty={editor.path === current.path && editor.content !== editor.original} onChange={(content) => setEditor({ path: current.path, content, original: current.content, kind: category === 'skills' ? 'skill' : 'prompt' })} onSave={current.worldModelBuilder && current.missing ? () => materializeWorldModelPrompt(editor.content) : current.planningPrompt && current.missing ? () => materializePlanningPrompt(editor.content) : saveEditor} onDownload={current.missing ? null : () => downloadFile(current.path)} onImport={() => importResource(current.worldModelBuilder ? 'world-prompt' : current.planningPrompt ? 'planner-prompt' : category === 'skills' ? 'skill' : 'prompt')} /></> : <Empty title={category === 'skills' ? 'No repository skills yet' : 'No prompts found'} detail={category === 'skills' ? 'Create or import Markdown skills under .github/skills.' : 'Persona, world-model, and planning prompts live in the repository.'} action={category === 'skills' && <button className="primary" onClick={() => setModal({ kind: 'skill', id: '', error: null })}>Create first skill</button>} />}</main>
    {modal?.kind === 'skill' && <DesignerModal title="Create repository skill" detail="The skill is stored as .github/skills/<id>/SKILL.md and is loaded by Copilot for this repository." submitLabel="Create skill" error={modal.error} onCancel={() => setModal(null)} onSubmit={submitSkill}><label><span>Skill ID</span><input autoFocus value={modal.id} placeholder="security-review" onChange={(event) => setModal({ ...modal, id: event.target.value, error: null })} /></label></DesignerModal>}
  </div>;
}

function WorldModel({ data, editor, setEditor, saveEditor, downloadFile, importResource, materializeWorldModelPrompt, addView, removeView }) {
  const [selected, setSelected] = useState('registry');
  const [modal, setModal] = useState(null);
  const current = data.worldModel.files.find((file) => file.path === selected) ?? null;
  const prompt = data.worldModelPrompt;
  function selectPrompt() {
    setSelected('prompt');
    setEditor({ path: prompt.path, content: prompt.content, original: prompt.content, kind: 'prompt' });
  }
  async function submitView() {
    const result = await addView(modal.id.trim());
    if (result) setModal(null);
  }
  return <div className="template-layout"><aside className="file-list world-model-list"><header><span className="eyebrow">Repository grounding</span><h2>World model</h2><div className="repo-only"><StatusDot status="approved" /><span>Repository only</span></div></header><button className={selected === 'registry' ? 'active' : ''} onClick={() => setSelected('registry')}><span>VW</span><div><strong>View registry</strong><small>{data.worldModel.views.length} governed views</small></div></button><button className={selected === 'prompt' ? 'active' : ''} onClick={selectPrompt}><span>PR</span><div><strong>Builder prompt</strong><small>{prompt.missing ? 'create repository copy' : 'editable repository source'}</small></div></button><div className="file-list-divider"><span>Generated outputs</span></div>{data.worldModel.files.map((file) => <button key={file.path} className={current?.path === file.path ? 'active' : ''} onClick={() => setSelected(file.path)}><span>{file.name.endsWith('.md') ? 'MD' : 'JS'}</span><div><strong>{file.name.split('/').at(-1)}</strong><small>{file.name.includes('/') ? file.name.slice(0, file.name.lastIndexOf('/')) : 'root'}</small></div></button>)}</aside>
    <main className="template-main">{selected === 'registry' ? <><div className="world-model-banner"><div><span className="eyebrow">Governed repository context</span><h1>Repository-owned world model</h1><p>Define the approved views that prompts, personas, stages, workflow overrides, and injection rules may consume. A referenced view cannot be removed until every dependency is cleared.</p></div><dl><div><dt>Output</dt><dd>{data.worldModel.root}</dd></div><div><dt>Grounding</dt><dd>{data.definition.worldModel?.grounding ?? 'off'}</dd></div><div><dt>Builder</dt><dd>{data.definition.worldModel?.promptSource ?? 'builtin'}</dd></div></dl><button className="primary compact" onClick={() => setModal({ id: '', error: null })}>＋ Add view</button></div><section className="view-registry"><header><div><span className="eyebrow">Dependency-safe catalog</span><h2>World-model views</h2></div><Pill tone="accent">Validated on every save</Pill></header><div className="view-table"><div className="view-table-head"><span>View</span><span>Structured use</span><span>Markdown prompt use</span><span>Action</span></div>{data.worldModel.views.map((view) => <div className="view-row" key={view.id}><div><span className="view-glyph">{view.id.slice(0, 2).toUpperCase()}</span><strong>{view.id}</strong></div><div className="dependency-list">{view.structuredReferences.length ? view.structuredReferences.map((item) => <code key={item}>{item}</code>) : <span>Not referenced</span>}</div><div className="dependency-list">{view.promptReferences.length ? view.promptReferences.map((item) => <code key={item}>{item}</code>) : <span>Not referenced</span>}</div><button className="ghost compact danger-text" disabled={view.references.length > 0} title={view.references.length ? `Used by ${view.references.join(', ')}` : 'Remove unused view'} onClick={() => removeView(view)}>Remove</button></div>)}</div><div className="dependency-note"><strong>Safe deletion policy</strong><span>Update stage, persona, workflow, injection-rule, and Markdown references first. Invalid YAML or prompt edits are rejected and rolled back atomically.</span></div></section></> : selected === 'prompt' ? <><div className="resource-summary"><div><Pill tone="accent">Editable builder prompt</Pill><span>This prompt controls how repository evidence becomes the governed views above.</span></div><div className="row"><button className="ghost compact" onClick={() => importResource('world-prompt')}>Import</button>{!prompt.missing && <button className="secondary compact" onClick={() => downloadFile(prompt.path)}>Download</button>}{prompt.missing && <button className="primary compact" onClick={() => materializeWorldModelPrompt(editor.path === prompt.path ? editor.content : prompt.content)}>Create repository copy</button>}</div></div><SourceEditor path={prompt.path} value={editor.path === prompt.path ? editor.content : prompt.content} dirty={editor.path === prompt.path && editor.content !== editor.original} onChange={(content) => setEditor({ path: prompt.path, content, original: prompt.content, kind: 'prompt' })} onSave={prompt.missing ? () => materializeWorldModelPrompt(editor.content) : saveEditor} onDownload={prompt.missing ? null : () => downloadFile(prompt.path)} onImport={() => importResource('world-prompt')} /></> : current ? <><div className="resource-summary"><div><Pill>Generated view</Pill><span>Read-only repository snapshot; regenerate it through the world-model lifecycle.</span></div><button className="secondary compact" onClick={() => downloadFile(current.path)}>Download</button></div><SourceEditor path={current.path} value={current.content} readOnly onChange={() => {}} onDownload={() => downloadFile(current.path)} /></> : <Empty title="World model output not found" detail="Run singularity-flow wm build to generate repository-grounded Markdown and evidence." />}</main>
    {modal && <DesignerModal title="Add world-model view" detail="Use a stable lower-case kebab-case ID. Once referenced by a stage, persona, rule, or prompt, the view is protected from deletion." submitLabel="Add view" error={modal.error} onCancel={() => setModal(null)} onSubmit={submitView}><label><span>View ID</span><input autoFocus value={modal.id} placeholder="data-governance" onChange={(event) => setModal({ ...modal, id: event.target.value, error: null })} /></label></DesignerModal>}
  </div>;
}

function Agents({ data, editor, setEditor, chooseAgent, saveEditor, createAgent, deleteFile, downloadFile, importAgent }) {
  const [lockView, setLockView] = useState(false);
  const [modal, setModal] = useState(null);
  const current = data.agents.find((agent) => agent.path === editor.path) ?? data.agents[0];
  const status = data.agentStatus.find((entry) => entry.id === current?.id);
  async function submitAgent() { const result = await createAgent(modal.id.trim()); if (result) setModal(null); }
  return <div className="template-layout"><aside className="file-list"><header><div className="row-between"><div><span className="eyebrow">Agent registry</span><h2>Agents</h2></div><div className="row"><button className="icon-button" title="Import agent" onClick={importAgent}>⇧</button><button className="icon-button" title="Create agent" onClick={() => setModal({ id: '', error: null })}>＋</button></div></div><p className="muted">Remote links are inert until explicitly locked.</p></header>{data.agents.map((agent) => <button key={`${agent.scope}:${agent.path}`} className={!lockView && current?.path === agent.path ? 'active' : ''} onClick={() => { setLockView(false); chooseAgent(agent); }}><span>AG</span><div><strong>{agent.id}</strong><small>{agent.scope} · {agent.remoteResources} remote</small></div></button>)}<button className={lockView ? 'active' : ''} onClick={() => setLockView(true)}><span>RO</span><div><strong>agents.lock.yml</strong><small>read-only · refresh with CLI</small></div></button></aside>
    <main className="template-main">{lockView ? <><header className="template-toolbar"><div><span className="eyebrow">Pinned trust state</span><h1>{data.agentsLock.path}</h1></div><div className="row"><button className="secondary compact" disabled={!data.agentsLock.exists} onClick={() => downloadFile(data.agentsLock.path)}>Download</button><Pill>Read only</Pill></div></header><pre className="lock-preview">{data.agentsLock.content}</pre></> : current ? <><header className="agent-summary"><span><Pill tone={status?.status === 'ready' || status?.status === 'local-only' ? 'good' : 'warn'}>{status?.status ?? 'unknown'}</Pill><small>{current.sha256.slice(0, 12)} · {current.editable ? 'repository Markdown' : 'bundled plugin agent'}</small></span><span className="row"><button className="secondary compact" onClick={() => downloadFile(current.path)}>Download</button>{current.editable && <button className="ghost compact" onClick={() => deleteFile(current)}>Delete</button>}<code>singularity-flow agents {status?.locked ? 'sync' : 'lock'} {current.id}</code></span></header><SourceEditor path={current.path} value={editor.path === current.path ? editor.content : current.content} dirty={current.editable && editor.content !== editor.original} onChange={(content) => current.editable && setEditor({ ...editor, content })} onSave={saveEditor} onDownload={() => downloadFile(current.path)} onImport={current.editable ? importAgent : null} readOnly={!current.editable} /></> : <Empty title="No agents found" detail="Create or import agent Markdown under .github/agents." action={<button className="primary" onClick={() => setModal({ id: '', error: null })}>Create first agent</button>} />}</main>
    {modal && <DesignerModal title="Create repository agent" detail="Create editable agent Markdown with remote-skill, remote-template, and generated-output dependency tables." submitLabel="Create agent" error={modal.error} onCancel={() => setModal(null)} onSubmit={submitAgent}><label><span>Agent ID</span><input autoFocus value={modal.id} placeholder="architecture" onChange={(event) => setModal({ ...modal, id: event.target.value, error: null })} /></label></DesignerModal>}
  </div>;
}

function Documents({ data, action, reload, downloadFile, focusDocumentId = null }) {
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [preview, setPreview] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  const [selectedId, setSelectedId] = useState(data.documents[0]?.id ?? '');
  const [openingId, setOpeningId] = useState(null);
  const storageProviders = Object.entries(data.definition?.storage?.providers ?? {}).filter(([, item]) => item.type === 'sharepoint');
  const [remoteProvider, setRemoteProvider] = useState(storageProviders[0]?.[0] ?? '');
  const [remoteEntries, setRemoteEntries] = useState(null);
  const handledFocus = useRef(null);
  const currentBranch = data.repository.branch;
  const activeBranch = data.workflow?.workItem.branch;
  const canMutate = data.workflow && currentBranch === activeBranch;
  const selectedRecord = data.documents.find((record) => record.id === selectedId) ?? data.documents[0] ?? null;
  const headings = (preview?.content ?? '').split('\n').filter((line) => /^#{1,3}\s+/.test(line)).map((line) => ({ depth: line.match(/^#+/)[0].length, label: line.replace(/^#+\s+/, '') })).slice(0, 12);
  useEffect(() => {
    if (!selectedId && data.documents[0]) setSelectedId(data.documents[0].id);
    if (selectedId && !data.documents.some((record) => record.id === selectedId)) {
      setSelectedId(data.documents[0]?.id ?? '');
      setPreview(null);
    }
  }, [data.documents, selectedId]);
  useEffect(() => {
    if (!focusDocumentId || handledFocus.current === focusDocumentId) return;
    const record = data.documents.find((item) => item.id === focusDocumentId);
    if (!record) return;
    handledFocus.current = focusDocumentId;
    void inspect(record);
  }, [focusDocumentId, data.documents, data.selectedWorkId]);
  async function selectPersona(event) { await action(() => window.singularity.selectPersona(data.repository.root, data.selectedWorkId, event.target.value), 'Persona selected'); await reload(); }
  async function upload() { const result = await action(() => window.singularity.uploadDocuments(data.repository.root), 'Documents uploaded'); if (result && !result.canceled) await reload(); }
  async function uploadDirectory() { const result = await action(() => window.singularity.uploadDocumentDirectory(data.repository.root), 'Design package imported and indexed'); if (result && !result.canceled) await reload(); }
  async function addUrl() { if (!url.trim()) return; await action(() => window.singularity.addDocumentUrl(data.repository.root, url.trim(), label.trim()), 'Document link added'); setUrl(''); setLabel(''); await reload(); }
  async function connectOneDrive() { await action(() => window.singularity.connectDocumentSharePoint(data.repository.root, remoteProvider), 'OneDrive connected through delegated OAuth'); }
  async function browseOneDrive() { const result = await action(() => window.singularity.listSharePointDocuments(data.repository.root, remoteProvider, '')); if (result) setRemoteEntries(result.entries ?? []); }
  async function fetchOneDrive(entry) { const result = await action(() => window.singularity.fetchSharePointDocument(data.repository.root, remoteProvider, entry.id, entry.name, entry.name), `Fetched ${entry.name} into the work item`); if (result) { setRemoteEntries(null); await reload(); } }
  async function inspect(record) {
    setSelectedId(record.id);
    setPreview(null);
    setOpeningId(record.id);
    const result = await action(() => window.singularity.previewDocument(data.repository.root, data.selectedWorkId, record.id));
    setOpeningId(null);
    if (result) setPreview(result);
  }
  async function openSelected() { await action(() => window.singularity.openDocument(data.repository.root, data.selectedWorkId, selectedRecord)); }
  if (!data.workflow) return <div className="page"><Empty title="Choose a work item" detail="Documents are cataloged per work item and branch." /></div>;
  return <div className="requirement-workspace"><header className="requirement-toolbar"><div><span className="eyebrow">Requirement workspace</span><h1>{data.workflow.workItem.title}</h1><p>{data.workflow.workItem.id} · {data.workflow.workItem.branch}</p></div><div className="session-control"><label>Session persona</label><select value={data.session?.workId === data.selectedWorkId ? data.session.persona : ''} onChange={selectPersona} disabled={!canMutate}><option value="">Choose persona</option>{Object.entries(data.definition.personas).map(([id, persona]) => <option value={id} key={id}>{persona.label}</option>)}</select></div></header>
    {!canMutate && <div className="notice warn">Work item {data.selectedWorkId} is on branch <strong>{activeBranch}</strong>. Resume that branch before uploading documents.</div>}
    <section className="workspace-uploadbar"><button className="primary" onClick={upload} disabled={!canMutate || data.session?.workId !== data.selectedWorkId}>＋ Upload files</button><button className="secondary" onClick={uploadDirectory} disabled={!canMutate || data.session?.workId !== data.selectedWorkId}>Import design folder</button><div className="workspace-url"><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="Figma or reference URL" disabled={!canMutate} /><input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Label" disabled={!canMutate} /><button className="secondary" onClick={addUrl} disabled={!canMutate || !url.trim()}>Add</button></div>{storageProviders.length > 0 && <div className="workspace-url"><select value={remoteProvider} onChange={(event) => setRemoteProvider(event.target.value)} disabled={!canMutate}>{storageProviders.map(([id, item]) => <option value={id} key={id}>{id} · {item.type}</option>)}</select><button className="secondary" onClick={connectOneDrive} disabled={!canMutate || !remoteProvider}>Connect OneDrive</button><button className="secondary" onClick={browseOneDrive} disabled={!canMutate || !remoteProvider}>Browse OneDrive</button></div>}</section>
    {remoteEntries && <section className="workspace-onedrive-list panel">{remoteEntries.length ? remoteEntries.map((entry) => <div className="artifact-repository-row" key={entry.id}><div><span className="studio-file-icon">{entry.folder ? 'DIR' : 'DOC'}</span><strong>{entry.name}</strong></div><code>{entry.folder ? 'folder' : `${entry.size ?? 0} bytes`}</code>{!entry.folder && <button className="ghost compact" onClick={() => fetchOneDrive(entry)} disabled={!canMutate || data.session?.workId !== data.selectedWorkId}>Fetch</button>}</div>) : <div className="inline-empty">No items in this OneDrive drive.</div>}</section>}
    <div className="requirement-layout">
      <aside className="requirement-tree">
        <header><span className="eyebrow">Artifacts</span><h2>Repository documents</h2><small>{data.documents.length} registered</small></header>
        {data.progress.phases.map((phase) => { const records = data.documents.filter((record) => record.phase === phase.id); return <section key={phase.id}><div className="tree-phase"><StatusDot status={phase.status} /><strong>{phase.label}</strong><span>{records.length}</span></div>{records.map((record) => <button className={selectedRecord?.id === record.id ? 'active' : ''} key={record.id} onClick={() => inspect(record)}><span className="doc-icon">{record.mimeType?.startsWith('image/') ? 'IMG' : record.type === 'url' ? 'URL' : 'MD'}</span><span><strong>{record.label}</strong><small>{record.kind}</small></span></button>)}</section>; })}
        {data.documents.filter((record) => !record.phase).map((record) => <button className={selectedRecord?.id === record.id ? 'active' : ''} key={record.id} onClick={() => inspect(record)}><span className="doc-icon">DOC</span><span><strong>{record.label}</strong><small>supporting evidence</small></span></button>)}
      </aside>
      <main className="requirement-document">
        {selectedRecord ? <><header><div><span className="eyebrow">{selectedRecord.id}</span><h2>{selectedRecord.label}</h2><p>{selectedRecord.path ?? selectedRecord.url}</p></div><div className="row"><Pill>{selectedRecord.kind}</Pill>{selectedRecord.path && <button className="secondary compact" onClick={() => downloadFile(selectedRecord.path)}>Download</button>}</div></header><PinnedMediaStrip repository={data.repository.root} workId={data.selectedWorkId} records={data.documents} selectedId={selectedRecord.id} onSelect={inspect} />{preview?.record?.id === selectedRecord.id && preview.dataUrl ? <div className="requirement-media-preview"><GovernedMedia record={selectedRecord} preview={preview} onZoom={(record, media) => setLightbox({ record, preview: media })} /></div> : preview?.record?.id === selectedRecord.id && preview.content != null ? <TemplatePreview className="requirement-preview" content={preview.content} /> : preview?.record?.id === selectedRecord.id && selectedRecord.type === 'url' ? <div className="live-design-card"><span className="live-design-mark">↗</span><h3>{selectedRecord.kind === 'figma' ? 'Open in Figma' : 'Open external reference'}</h3><p><strong>Live design — may differ from the pinned intake.</strong> Use committed image exports for approval; open this link only as current-design context.</p><code>{selectedRecord.url}</code><button className="primary" onClick={openSelected}>{selectedRecord.kind === 'figma' ? 'Open in Figma' : 'Open HTTPS link'}</button></div> : preview?.record?.id === selectedRecord.id && preview.previewable === false ? <div className="native-document-card"><span>DOC</span><h3>Use the desktop viewer</h3><p>This governed binary file cannot render safely inside Singularity. Its catalog record was resolved successfully; open it with the operating system’s default application.</p><code>{selectedRecord.sha256?.slice(0, 12)} · {selectedRecord.mimeType}</code><button className="primary" onClick={openSelected}>Open in default app</button></div> : <div className="document-placeholder"><span>{selectedRecord.mimeType?.startsWith('image/') ? 'IMG' : selectedRecord.type === 'url' ? 'URL' : 'MD'}</span><h3>{openingId === selectedRecord.id ? 'Opening governed document…' : 'Open the governed document'}</h3><p>Markdown, source, images, and PDFs preview inside Singularity with their committed SHA. Other binary files use their native viewer.</p><button className="primary" disabled={openingId === selectedRecord.id} onClick={() => inspect(selectedRecord)}>{openingId === selectedRecord.id ? 'Loading…' : 'Open document'}</button></div>}<MediaLightbox item={lightbox} onClose={() => setLightbox(null)} /></> : <Empty title="No documents yet" detail="Upload source material or generate the current phase artifact to populate this workspace." />}
      </main>
      <aside className="requirement-inspector">
        <section><span className="eyebrow">Git status</span><dl><div><dt>Branch</dt><dd>{data.repository.branch}</dd></div><div><dt>Workflow</dt><dd>{data.workflow.status}</dd></div><div><dt>Phase</dt><dd>{selectedRecord?.phase ?? 'supporting'}</dd></div><div><dt>Persona</dt><dd>{data.session?.persona ?? 'not selected'}</dd></div></dl></section>
        <section><span className="eyebrow">Document metadata</span><dl><div><dt>Kind</dt><dd>{selectedRecord?.kind ?? '—'}</dd></div><div><dt>Size</dt><dd>{selectedRecord?.size ? `${Math.ceil(selectedRecord.size / 1024)} KB` : '—'}</dd></div><div><dt>Reference</dt><dd>{selectedRecord?.id ?? '—'}</dd></div><div><dt>SHA-256</dt><dd>{selectedRecord?.sha256?.slice(0, 12) ?? '—'}</dd></div><div><dt>Integrity</dt><dd>{preview?.record?.id === selectedRecord?.id && (preview.integrity === 'verified' || preview.binary === false) ? 'matches record ✓' : 'verify on preview'}</dd></div></dl></section>
        <section className="document-outline"><span className="eyebrow">Outline</span>{headings.length ? headings.map((heading, index) => <span style={{ paddingLeft: `${(heading.depth - 1) * 12}px` }} key={`${heading.label}:${index}`}>{heading.label}</span>) : <p>Open a Markdown artifact to see its governed section outline.</p>}</section>
      </aside>
    </div>
    <div className="workspace-command"><span className="ai-orb">✦</span><div><strong>Ask Singularity</strong><small>Use Planning Copilot to refine this requirement with its complete governed context.</small></div><code>/sflow-next</code></div>
  </div>;
}

export default function App() {
  const [data, setData] = useState(null);
  const [onboarding, setOnboarding] = useState(null);
  const [onboardingLoading, setOnboardingLoading] = useState(true);
  const [onboardingError, setOnboardingError] = useState(null);
  const [onboardingAttempt, setOnboardingAttempt] = useState(0);
  const [page, setPage] = useState('dashboard');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [standaloneHelp, setStandaloneHelp] = useState(false);
  const [recentWorkspaces, setRecentWorkspaces] = useState([]);
  const [repositoryMenu, setRepositoryMenu] = useState(false);
  const [jiraSetupOpen, setJiraSetupOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.localStorage.getItem('singularity.sidebar.collapsed') === 'true');
  const [editor, setEditor] = useState({ path: '', content: '', original: '', kind: 'workflow' });
  const [focusedDocumentId, setFocusedDocumentId] = useState(null);

  useEffect(() => {
    let current = true;
    setOnboardingLoading(true);
    setOnboardingError(null);
    Promise.resolve()
      .then(() => {
        if (!window.singularity?.onboarding) throw new Error('The secure desktop bridge is unavailable. Restart Singularity Desktop.');
        return window.singularity.onboarding();
      })
      .then((result) => { if (current) setOnboarding(result); })
      .catch((error) => {
        if (!current) return;
        setOnboarding(null);
        setOnboardingError(error?.message || String(error));
      })
      .finally(() => { if (current) setOnboardingLoading(false); });
    return () => { current = false; };
  }, [onboardingAttempt]);
  useEffect(() => { if (data && !editor.path) setEditor({ path: data.definitionPath, content: data.definitionText, original: data.definitionText, kind: 'workflow' }); }, [data, editor.path]);
  useEffect(() => { if (toast?.tone !== 'good') return undefined; const timer = setTimeout(() => setToast(null), 5000); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => {
    const openJiraSetup = () => setJiraSetupOpen(true);
    window.addEventListener('singularity:setup-jira', openJiraSetup);
    return () => window.removeEventListener('singularity:setup-jira', openJiraSetup);
  }, []);
  useEffect(() => {
    if (!window.singularity?.recentWorkspaces) return undefined;
    let current = true;
    window.singularity.recentWorkspaces().then((items) => { if (current) setRecentWorkspaces(items); }).catch((error) => { if (current) setToast({ tone: 'bad', text: `Could not load recent workspaces: ${error.message}` }); });
    return () => { current = false; };
  }, []);
  useEffect(() => {
    if (!repositoryMenu) return undefined;
    const closeOutside = (event) => { if (!event.target.closest?.('.repo-switcher')) setRepositoryMenu(false); };
    const closeEscape = (event) => { if (event.key === 'Escape') setRepositoryMenu(false); };
    document.addEventListener('mousedown', closeOutside); document.addEventListener('keydown', closeEscape);
    return () => { document.removeEventListener('mousedown', closeOutside); document.removeEventListener('keydown', closeEscape); };
  }, [repositoryMenu]);
  useEffect(() => {
    window.localStorage.setItem('singularity.sidebar.collapsed', String(sidebarCollapsed));
  }, [sidebarCollapsed]);
  const experienceMode = onboarding?.profile?.experienceMode ?? 'engineer';
  const activeNavSections = experienceMode === 'business' ? businessNavSections : engineerNavSections;
  useEffect(() => {
    if (!data || experienceMode !== 'business') return;
    const allowed = new Set([
      ...businessNavSections.flatMap((section) => section.items.map(([id]) => id)),
      ...businessAuxiliaryNavigation.map((item) => item.id)
    ]);
    if (!allowed.has(page)) setPage('epics');
  }, [data, experienceMode, page]);
  useEffect(() => {
    if (experienceMode === 'business') return undefined;
    const toggleNavigation = (event) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'b') return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName))) return;
      event.preventDefault();
      setSidebarCollapsed((current) => !current);
    };
    window.addEventListener('keydown', toggleNavigation);
    return () => window.removeEventListener('keydown', toggleNavigation);
  }, [experienceMode]);
  const repoName = useMemo(() => data?.repository.root.split('/').at(-1), [data]);
  const activeNavigation = useMemo(() => [
    ...activeNavSections.flatMap((section) => section.items.map(([id, label]) => ({ id, label, section: section.label }))),
    ...(experienceMode === 'business' ? businessAuxiliaryNavigation : [])
  ].find((item) => item.id === page) ?? { id: page, label: 'Workspace', section: 'Singularity' }, [activeNavSections, experienceMode, page]);
  const configurationChanges = data?.repository.configurationChanges ?? [];
  const unrelatedChanges = data?.repository.unrelatedChanges ?? [];
  const publishReady = data?.repository.publishReady === true;
  const publishHint = !configurationChanges.length ? 'No workflow, template, persona, prompt, skill, or agent changes are ready to publish.' : unrelatedChanges.length ? `Blocked by ${unrelatedChanges.length} non-configuration working-tree change(s).` : 'Commit and push desktop configuration changes.';
  async function action(task, success) { setBusy(true); setToast(null); try { const result = await task(); if (success && result != null) setToast({ tone: 'good', text: success }); return result; } catch (error) { setToast({ tone: 'bad', text: error?.message || String(error) }); return null; } finally { setBusy(false); } }
  async function refreshRecentWorkspaces() {
    try { const items = await window.singularity.recentWorkspaces(); setRecentWorkspaces(items); return items; }
    catch (error) { setToast({ tone: 'bad', text: `Could not load recent workspaces: ${error.message}` }); return []; }
  }
  function acceptOpened(result, nextPage = null) {
    setData(result);
    setEditor({ path: result.definitionPath, content: result.definitionText, original: result.definitionText, kind: 'workflow' });
    setRepositoryMenu(false);
    if (nextPage) setPage(nextPage);
  }
  async function openWorkspace(workspacePath = null) {
    const result = await action(() => workspacePath ? window.singularity.openWorkspace(workspacePath) : window.singularity.chooseWorkspace());
    if (!result) return;
    acceptOpened(result, workspaceLandingPage(result, experienceMode));
    await refreshRecentWorkspaces();
    if (result.workspaceSetup?.message) setToast({ tone: 'good', text: result.workspaceSetup.message });
  }
  function openRequirementWorkspace(document = null) {
    if (!data?.workflow) {
      setPage('documents');
      return;
    }
    setFocusedDocumentId(document?.id ?? null);
    setPage('documents');
  }
  async function completeOnboarding(result) {
    setOnboarding(result);
    await refreshRecentWorkspaces();
    if (result.profile.workspacePath) await openWorkspace(result.profile.workspacePath);
    if (result.notices?.length) {
      setToast({ tone: 'warning', text: result.notices.map((notice) => notice.message).join(' ') });
    }
  }
  async function forgetWorkspace(event, workspacePath) {
    event.stopPropagation();
    const items = await action(() => window.singularity.forgetWorkspace(workspacePath), 'Workspace forgotten; no local files were deleted');
    if (items) setRecentWorkspaces(items);
  }
  async function reload(workId = data?.selectedWorkId, initiativeId = data?.selectedInitiativeId) { if (!data) return null; const result = await action(() => window.singularity.snapshot(data.repository.root, workId, initiativeId)); if (result) setData(result); return result; }
  async function refreshInbox() { const result = await action(() => window.singularity.refreshInbox(data.repository.root), 'Remote approval inbox refreshed'); if (result) setData(result); return result; }
  async function attachInboxItem(workId) { const result = await action(() => window.singularity.attachInboxItem(data.repository.root, workId), `Attached to ${workId} at the latest remote commit`); if (result) { setData(result); setPage('review'); } return result; }
  async function selectWorkItem(event) { await reload(event.target.value || null); }
  async function selectInitiative(event) {
    const initiativeId = event.target.value || null;
    const result = initiativeId
      ? await action(() => window.singularity.openInitiative(data.repository.root, initiativeId), `Opened latest ${initiativeId} branch`)
      : await reload(null, null);
    if (result) setData(result);
    if (result && initiativeId) setPage(experienceMode === 'business' ? 'epics' : 'dashboard');
  }
  async function switchExperienceMode(nextMode) {
    if (!['business', 'engineer'].includes(nextMode) || nextMode === experienceMode) return;
    const result = await action(
      () => window.singularity.setExperienceMode(nextMode),
      `${nextMode === 'business' ? 'Business' : 'Engineer'} experience enabled`
    );
    if (!result) return;
    setOnboarding((current) => ({ ...current, ...result, profile: result.profile }));
    setPage(nextMode === 'business' ? 'epics' : 'dashboard');
  }
  async function openEpic(initiativeId) {
    const result = await action(
      () => window.singularity.openInitiative(data.repository.root, initiativeId),
      `Opened latest ${initiativeId} branch`
    );
    if (result) setData(result);
    if (result) setPage('epics');
  }
  async function saveEditor() { const result = await action(() => window.singularity.saveFile(data.repository.root, editor.path, editor.content), `${editor.path} saved and validated`); if (result) { setEditor({ ...editor, original: editor.content }); await reload(); } }
  async function validate() { await action(() => window.singularity.validate(data.repository.root), 'Configuration is valid'); }
  async function publish() { if (!publishReady) return setToast({ tone: 'bad', text: publishHint }); const result = await action(() => window.singularity.publish(data.repository.root, 'Configure Singularity Flow desktop workflow'), 'Configuration committed and published'); if (result) await reload(); }
  function workflowPage() { setPage('workflow'); setEditor({ path: data.definitionPath, content: data.definitionText, original: data.definitionText, kind: 'workflow' }); }
  function initiativePage() { setPage('initiatives'); if (data.portfolioText) setEditor({ path: data.portfolioPath, content: data.portfolioText, original: data.portfolioText, kind: 'portfolio' }); }
  function acceptPortfolioBootstrap(snapshot) {
    setData(snapshot);
    setEditor({ path: snapshot.portfolioPath, content: snapshot.portfolioText, original: snapshot.portfolioText, kind: 'portfolio' });
  }
  function openPlanningPrompt() {
    const prompt = data.planning.prompt;
    setEditor({ path: prompt.path, content: prompt.content, original: prompt.content, kind: 'prompt' });
    setPage('resources');
  }
  async function downloadFile(filePath) {
    if (!filePath) return null;
    const result = await action(() => window.singularity.downloadFile(data.repository.root, filePath));
    if (result && !result.canceled) setToast({ tone: 'good', text: `Downloaded ${filePath} to ${result.path}` });
    return result;
  }
  async function exportBundle() {
    const result = await action(() => window.singularity.exportBundle(data.repository.root));
    if (result && !result.canceled) setToast({ tone: 'good', text: `Exported ${result.files} YAML/Markdown files to ${result.path}. World-model files remain repository-owned snapshots.` });
    return result;
  }
  async function importFile(options, success) {
    const result = await action(() => window.singularity.importFile(data.repository.root, options), success);
    if (!result || result.canceled) return null;
    const snapshot = await reload();
    return { result, snapshot };
  }
  async function importWorkflow() {
    const imported = await importFile({ targetPath: data.definitionPath }, 'Workflow YAML imported and validated');
    if (imported) setEditor({ path: imported.snapshot.definitionPath, content: imported.snapshot.definitionText, original: imported.snapshot.definitionText, kind: 'workflow' });
  }
  function chooseTemplate(file) { setEditor({ path: file.path, content: file.content, original: file.content, kind: 'template' }); }
  async function createTemplate(name, suppliedContent = null) {
    const content = suppliedContent ?? '# {{work.id}} — {{phase.label}}\n\n## Purpose\n\nDescribe the artifact outcome.\n\n{{inputs}}\n\n## Evidence\n\nAdd traceable evidence here.\n';
    const result = await action(() => window.singularity.saveFile(data.repository.root, templateRepositoryPath(data.definition, name), content), 'Artifact template created');
    if (!result) return null;
    const snapshot = await reload();
    const file = snapshot?.templates.find((item) => item.path === result.path);
    if (file) chooseTemplate(file);
    return result;
  }
  async function deleteTemplate(file) {
    const result = await action(() => window.singularity.deleteTemplate(data.repository.root, file.path), 'Artifact template deleted');
    if (!result) return null;
    const snapshot = await reload();
    const replacement = snapshot?.templates[0];
    setEditor(replacement ? { path: replacement.path, content: replacement.content, original: replacement.content, kind: 'template' } : { path: '', content: '', original: '', kind: 'template' });
    return result;
  }
  async function importTemplate() {
    const imported = await importFile({ targetDirectory: data.definition.templatesRoot, kind: 'template' }, 'Artifact template imported');
    if (!imported) return null;
    const file = imported.snapshot.templates.find((item) => item.path === imported.result.path);
    if (file) chooseTemplate(file);
    return imported.result;
  }
  async function savePersona(personaId, persona) {
    const next = structuredClone(data.definition);
    next.personas[personaId] = persona;
    const result = await action(() => window.singularity.saveFile(data.repository.root, data.definitionPath, YAML.stringify(next)), `Persona '${personaId}' saved and validated`);
    if (result) await reload();
    return result;
  }
  async function createPersonaConfig(values) {
    let next;
    try { next = createPersona(data.definition, values); }
    catch (error) { setToast({ tone: 'bad', text: error.message }); return null; }
    const id = values.id.trim();
    const persona = next.personas[id];
    const promptPath = personaPromptRepositoryPath(next, persona.prompt);
    const prompt = `# ${persona.label}\n\n${persona.description}\n\n## Perspective\n\nAct as the **${persona.label}** persona. Apply this perspective to the current phase while preserving its governed contract, required repository world-model views, approved inputs, and evidence requirements.\n`;
    const promptResult = await action(() => window.singularity.saveFile(data.repository.root, promptPath, prompt));
    if (!promptResult) return null;
    const result = await action(() => window.singularity.saveFile(data.repository.root, data.definitionPath, YAML.stringify(next)), `Persona '${id}' and prompt created`);
    if (result) await reload();
    return result;
  }
  async function deletePersonaConfig(personaId, replacementId) {
    let next;
    try { next = removePersona(data.definition, personaId, replacementId); }
    catch (error) { setToast({ tone: 'bad', text: error.message }); return null; }
    const oldPrompt = data.definition.personas[personaId].prompt;
    const promptStillUsed = Object.values(next.personas).some((persona) => persona.prompt === oldPrompt);
    const result = await action(() => window.singularity.saveFile(data.repository.root, data.definitionPath, YAML.stringify(next)), `Persona '${personaId}' removed; references moved to '${replacementId}'`);
    if (!result) return null;
    if (!promptStillUsed && data.personaPrompts.some((file) => file.name === oldPrompt)) await action(() => window.singularity.deleteFile(data.repository.root, personaPromptRepositoryPath(data.definition, oldPrompt)));
    await reload();
    return result;
  }
  function chooseResource(file, kind) { setEditor({ path: file.path, content: file.content, original: file.content, kind }); }
  function resourcesPage() {
    setPage('resources');
    const file = data.personaPrompts[0] ?? data.worldModelPrompt ?? data.repositorySkills[0];
    if (file) chooseResource(file, data.repositorySkills.includes(file) ? 'skill' : 'prompt');
  }
  async function importResource(kind) {
    const options = kind === 'skill'
      ? { targetDirectory: '.github/skills', kind: 'skill' }
      : kind === 'world-prompt'
        ? { targetPath: data.worldModelPrompt.path, kind: 'prompt' }
        : kind === 'planner-prompt'
          ? { targetPath: data.planning.prompt.path, kind: 'prompt' }
        : { targetDirectory: data.definition.personaPromptsRoot, kind: 'prompt' };
    const imported = await importFile(options, `${kind === 'skill' ? 'Repository skill' : 'Prompt'} imported`);
    if (!imported) return null;
    let snapshot = imported.snapshot;
    if (kind === 'world-prompt' && (data.definition.worldModel?.promptSource ?? 'builtin') === 'builtin') {
      const next = structuredClone(data.definition);
      next.worldModel ??= {};
      next.worldModel.promptSource = data.worldModelPrompt.path;
      const configured = await action(() => window.singularity.saveFile(data.repository.root, data.definitionPath, YAML.stringify(next)), 'World-model builder prompt imported and configured');
      if (!configured) return null;
      snapshot = await reload();
    }
    const files = kind === 'skill' ? snapshot.repositorySkills : [...snapshot.personaPrompts, snapshot.worldModelPrompt, snapshot.planning.prompt];
    const file = files.find((item) => item.path === imported.result.path);
    if (file) chooseResource(file, kind === 'skill' ? 'skill' : 'prompt');
    return imported.result;
  }
  async function createSkill(skillId) {
    let skillPath;
    try { skillPath = repositorySkillPath(skillId); }
    catch (error) { setToast({ tone: 'bad', text: error.message }); return null; }
    const content = `---\nname: ${skillId}\ndescription: Repository-specific ${skillId.replaceAll('-', ' ')} guidance.\n---\n\n# ${skillId.replaceAll('-', ' ')}\n\nUse this skill when its repository-specific guidance applies.\n\n## Instructions\n\n- Ground decisions in the current repository and approved Singularity Flow artifacts.\n- Preserve phase boundaries, traceability, and configured approval rules.\n`;
    const result = await action(() => window.singularity.saveFile(data.repository.root, skillPath, content), `Repository skill '${skillId}' created`);
    if (!result) return null;
    const snapshot = await reload();
    const file = snapshot?.repositorySkills.find((item) => item.path === skillPath);
    if (file) chooseResource(file, 'skill');
    return result;
  }
  async function deleteFile(file) {
    if (!file?.path) return null;
    const result = await action(() => window.singularity.deleteFile(data.repository.root, file.path), `${file.path} deleted`);
    if (!result) return null;
    const snapshot = await reload();
    const candidates = page === 'agents' ? snapshot?.agents.filter((item) => item.editable) : snapshot?.repositorySkills;
    const replacement = candidates?.[0];
    setEditor(replacement ? { path: replacement.path, content: replacement.content, original: replacement.content, kind: page === 'agents' ? 'agent' : 'skill' } : { path: '', content: '', original: '', kind: page === 'agents' ? 'agent' : 'skill' });
    return result;
  }
  async function materializeWorldModelPrompt(content = data.worldModelPrompt.content) {
    const prompt = data.worldModelPrompt;
    const result = await action(() => window.singularity.saveFile(data.repository.root, prompt.path, content));
    if (!result) return null;
    if ((data.definition.worldModel?.promptSource ?? 'builtin') === 'builtin') {
      const next = structuredClone(data.definition);
      next.worldModel ??= {};
      next.worldModel.promptSource = prompt.path;
      const definitionResult = await action(() => window.singularity.saveFile(data.repository.root, data.definitionPath, YAML.stringify(next)), 'Repository world-model builder prompt created and configured');
      if (!definitionResult) return null;
    }
    const snapshot = await reload();
    chooseResource(snapshot.worldModelPrompt, 'prompt');
    return result;
  }
  async function materializePlanningPrompt(content = data.planning.prompt.content) {
    const prompt = data.planning.prompt;
    const result = await action(() => window.singularity.saveFile(data.repository.root, prompt.path, content), 'Repository Copilot planning prompt created');
    if (!result) return null;
    const snapshot = await reload();
    chooseResource(snapshot.planning.prompt, 'prompt');
    return result;
  }
  async function addWorldModelViewConfig(viewId) {
    let next;
    try { next = addWorldModelView(data.definition, viewId); }
    catch (error) { setToast({ tone: 'bad', text: error.message }); return null; }
    const result = await action(() => window.singularity.saveFile(data.repository.root, data.definitionPath, YAML.stringify(next)), `World-model view '${viewId}' added and validated`);
    if (result) await reload();
    return result;
  }
  async function removeWorldModelViewConfig(view) {
    let next;
    try { next = removeWorldModelView(data.definition, view.id, view.promptReferences.map((file) => `Markdown '${file}'`)); }
    catch (error) { setToast({ tone: 'bad', text: error.message }); return null; }
    const result = await action(() => window.singularity.saveFile(data.repository.root, data.definitionPath, YAML.stringify(next)), `Unused world-model view '${view.id}' removed`);
    if (result) await reload();
    return result;
  }
  function chooseAgent(agent) { setEditor({ path: agent.path, content: agent.content, original: agent.content, kind: 'agent' }); }
  async function createAgent(agentId) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(agentId)) { setToast({ tone: 'bad', text: 'Agent ID must be lower-case kebab-case.' }); return null; }
    const agentPath = `.github/agents/${agentId}.agent.md`;
    const title = agentId.replaceAll('-', ' ');
    const content = `---\nname: ${agentId}\ndescription: Repository agent for ${title}.\n---\n\n# ${title}\n\nActivate the relevant Singularity Flow session and use approved repository artifacts as governed context.\n\n## Remote skills\n\n| ID | URL | Phases | Personas | Optional | Max bytes |\n| --- | --- | --- | --- | --- | --- |\n\n## Remote artifact templates\n\n| ID | URL | Phases | Optional | Max bytes |\n| --- | --- | --- | --- | --- |\n\n## Remote generated artifacts\n\n| ID | URL template | Phase | Target | Optional | Max bytes |\n| --- | --- | --- | --- | --- | --- |\n`;
    const result = await action(() => window.singularity.saveFile(data.repository.root, agentPath, content), `Repository agent '${agentId}' created`);
    if (!result) return null;
    const snapshot = await reload();
    const agent = snapshot?.agents.find((item) => item.path === agentPath);
    if (agent) chooseAgent(agent);
    return result;
  }
  async function importAgent() {
    const imported = await importFile({ targetDirectory: '.github/agents', kind: 'agent' }, 'Repository agent imported and validated');
    if (!imported) return null;
    const agent = imported.snapshot.agents.find((item) => item.path === imported.result.path);
    if (agent) chooseAgent(agent);
    return imported.result;
  }
  function openPrompt(file) { setEditor({ path: file.path, content: file.content, original: file.content, kind: 'prompt' }); setPage('resources'); }
  function agentsPage() { setPage('agents'); if (data.agents[0]) chooseAgent(data.agents[0]); }

  if (onboardingLoading) return <div className="onboarding-loading"><FlowBrand className="brand large flow-brand-welcome" context="Preparing desktop setup" /><span className="onboarding-loading-orb">✦</span></div>;
  if (!data && standaloneHelp) return <div className="standalone-help"><button className="ghost help-back" onClick={() => setStandaloneHelp(false)}>← Back</button><Help /></div>;
  if (onboardingError) return <OnboardingLoadFailure error={onboardingError} retry={() => setOnboardingAttempt((current) => current + 1)} help={() => setStandaloneHelp(true)} />;
  if (!onboarding?.profile?.completed) return <><OnboardingWizard initial={onboarding.profile} jira={onboarding.jira} onComplete={completeOnboarding} onHelp={() => setStandaloneHelp(true)} /><Toast toast={toast} onClose={() => setToast(null)} /></>;
  if (!data) return <div className={`welcome ${busy ? 'busy' : ''}`}>
    <header className="welcome-nav">
      <FlowBrand className="brand large flow-brand-welcome" context="Git-native delivery" />
      <nav><button onClick={() => setStandaloneHelp(true)}>How it works</button><button onClick={() => setStandaloneHelp(true)}>Documentation</button><button className="primary" onClick={() => openWorkspace()} disabled={busy}>Open workspace</button></nav>
    </header>
    <main className="welcome-hero">
      <section>
        <Pill tone="accent">Plan · govern · deliver</Pill>
        <h1>Start with your<br /><em>Epic and requirements.</em></h1>
        <p>Open a project workspace, bring in the Epic and source documents, then move through requirements, Story planning, specification, and governed publication. The workspace carries every repository and its Jira routing.</p>
        <div className="welcome-actions"><button className="primary large-button" onClick={() => openWorkspace()} disabled={busy}>{busy ? 'Opening workspace…' : 'Open project workspace'}</button><button className="ghost large-button" onClick={() => setStandaloneHelp(true)} disabled={busy}>See the workflow</button></div>
        <details className="welcome-advanced">
          <summary><span><strong>Workspace configuration</strong><small>Local directory · repositories · Jira boards · App IDs</small></span><b>＋</b></summary>
          <div><p>Create an isolated project workspace with exactly one lead Git repository for Epic artifacts. Repository-specific Jira routing and metadata are configured together.</p><button className="secondary" onClick={() => openWorkspace()} disabled={busy}>Open or create workspace</button></div>
        </details>
        {busy && <p className="opening-state" role="status">Opening the selected project context…</p>}
      </section>
      <section className="welcome-visual" aria-label="Singularity Flow workflow preview"><div className="visual-glow" /><div className="visual-window"><header><span>SINGULARITY · FLOW</span><i /><i /><i /></header><div className="visual-body"><aside><span className="active">Epic intake</span><span>Requirements</span><span>Story plan</span><span>Specification</span></aside><main><span className="eyebrow">Governed planning</span><h3>Epic to approved Stories</h3><div className="visual-flow"><b className="done">✓</b><i /><b className="done">✓</b><i /><b>3</b><i /><b>4</b></div><div className="visual-cards"><span /><span /><span /></div></main></div></div></section>
    </main>
    <section className="welcome-recent"><RecentWorkspaces items={recentWorkspaces} busy={busy} onOpen={openWorkspace} onForget={forgetWorkspace} /></section>
    <Toast toast={toast} onClose={() => setToast(null)} />
  </div>;
  return <div className={`shell ${experienceMode === 'business' ? 'business-shell' : sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
    {experienceMode === 'engineer' && <aside className="sidebar"><FlowBrand className="brand flow-brand-sidebar" context={data.workspace ? data.workspace.workspace.anchor.key : 'Workspace'} /><button className="sidebar-edge-toggle" type="button" title={`${sidebarCollapsed ? 'Expand' : 'Collapse'} navigation (⌘/Ctrl+B)`} aria-label={sidebarCollapsed ? 'Expand navigation' : 'Collapse navigation'} aria-expanded={!sidebarCollapsed} aria-controls="primary-navigation" onClick={() => setSidebarCollapsed((current) => !current)}><NavIcon name={sidebarCollapsed ? 'expand' : 'collapse'} /></button><nav id="primary-navigation" aria-label="Primary navigation">{activeNavSections.map((section) => <section key={section.label} className={`nav-section nav-section-${section.label.toLowerCase().replaceAll(' ', '-')}`}><span className="nav-section-label">{section.label}</span>{section.items.map(([id, label]) => <button key={id} title={sidebarCollapsed ? label : undefined} aria-label={label} className={page === id ? 'active' : ''} onClick={() => id === 'workflow' ? workflowPage() : id === 'initiatives' ? initiativePage() : id === 'resources' ? resourcesPage() : id === 'agents' ? agentsPage() : setPage(id)}><i><NavIcon name={id} /></i><span className="nav-label">{label}</span>{id === 'inbox' && data.approvalInbox.count > 0 && <span className="nav-badge">{data.approvalInbox.count}</span>}</button>)}</section>)}</nav><div className="sidebar-bottom"><div className="experience-switcher"><span>Experience</span><div><button className={experienceMode === 'business' ? 'active' : ''} onClick={() => switchExperienceMode('business')}>Business</button><button className={experienceMode === 'engineer' ? 'active' : ''} onClick={() => switchExperienceMode('engineer')}>Engineer</button></div></div><div className="repo-switcher"><div className="repo-card"><span className="repo-icon">{data.workspace?.workspace.name?.slice(0, 1).toUpperCase() ?? 'W'}</span><div><strong>{data.workspace?.workspace.name ?? 'No workspace selected'}</strong><small>{data.workspace ? `${repoName} · ${data.repository.branch} · lead repository` : 'Choose a workspace to continue'}</small></div><button title="Switch workspace" aria-label="Switch workspace" onClick={() => setRepositoryMenu(!repositoryMenu)}>⋯</button></div>{repositoryMenu && <div className="repository-menu" role="dialog" aria-label="Switch workspace"><WorkspaceSelector items={recentWorkspaces} currentWorkspace={data.workspace?.workspace} busy={busy} onOpen={openWorkspace} /></div>}</div><div className={`connection ${data.repository.changes.length ? 'dirty' : ''}`}><span /><em>{data.repository.changes.length ? `${data.repository.changes.length} uncommitted change(s)` : data.workspace ? `${data.workspace.counts.ready}/${data.workspace.counts.repositories} repositories ready` : 'Workspace required'}</em></div></div></aside>}
    <main className="content">{experienceMode === 'business' && <BusinessNavigation page={page} data={data} repoName={repoName} repositoryMenu={repositoryMenu} setRepositoryMenu={setRepositoryMenu} recentWorkspaces={recentWorkspaces} busy={busy} openWorkspace={openWorkspace} onNavigate={setPage} onEngineerMode={() => switchExperienceMode('engineer')} />}<header className="topbar"><div className="topbar-leading"><div className="page-context"><span>{activeNavigation.section}</span><strong>{activeNavigation.label}</strong></div><div className="context-selectors">{experienceMode === 'engineer' && <select aria-label="Work item" value={data.selectedWorkId ?? ''} onChange={selectWorkItem}><option value="">Story work item</option>{data.workItems.map((item) => <option value={item.id} key={item.id}>{item.id} — {item.title}</option>)}</select>}{data.portfolio && <select aria-label="Epic" value={data.selectedInitiativeId ?? ''} onChange={selectInitiative}><option value="">Choose Epic</option>{data.initiatives.filter((item) => item.profile === 'epic-planning').map((item) => <option value={item.id} key={item.id}>{item.id} — {item.title}</option>)}</select>}{experienceMode === 'engineer' && data.workflow && <Pill tone="accent">{data.workflow.currentPhase ?? 'complete'}</Pill>}{data.initiative && <Pill tone="accent">{data.initiative.state.currentPhase ?? 'complete'}</Pill>}</div></div><div className="topbar-title" aria-live="polite"><span>{activeNavigation.section}</span><strong>{activeNavigation.label}</strong></div><div className="topbar-actions"><CopilotServiceControl repository={data.repository.root} notify={setToast} /><button className="ghost icon-action" onClick={() => reload()} disabled={busy} title="Refresh workspace"><NavIcon name="refresh" /><span>Refresh</span></button>{experienceMode === 'engineer' && <button className="ghost icon-action" onClick={exportBundle} disabled={busy} title="Download configuration"><NavIcon name="download" /><span>Download config</span></button>}{(experienceMode === 'engineer' || page === 'templates') && <><button className="secondary icon-action" onClick={validate} disabled={busy}><NavIcon name="validate" /><span>Validate</span></button><button className="primary icon-action" onClick={publish} disabled={busy || !publishReady} title={publishHint}><NavIcon name="publish" /><span>{experienceMode === 'business' ? 'Commit templates' : 'Commit & push'}</span></button></>}</div></header>
      <div className={busy ? 'busy view' : 'view'}><div className="page-stage" key={page}>{page === 'epics' && (data.initiative ? <InitiativeStudio data={data} editor={editor} setEditor={setEditor} saveEditor={saveEditor} downloadFile={downloadFile} action={action} reload={reload} bootstrapPortfolio={acceptPortfolioBootstrap} openPlanning={() => setPage('planning')} localRole={onboarding?.profile?.role} /> : <EpicsHome data={data} action={action} reload={reload} openEpic={openEpic} startEpic={() => setData((current) => ({ ...current, initiative: null, selectedInitiativeId: null }))} />)}{page === 'business-requirements' && <InitiativeStudio data={data} editor={editor} setEditor={setEditor} saveEditor={saveEditor} downloadFile={downloadFile} action={action} reload={reload} bootstrapPortfolio={acceptPortfolioBootstrap} openPlanning={() => setPage('planning')} localRole={onboarding?.profile?.role} entryTab="requirements" />}{page === 'business-planning' && <InitiativeStudio data={data} editor={editor} setEditor={setEditor} saveEditor={saveEditor} downloadFile={downloadFile} action={action} reload={reload} bootstrapPortfolio={acceptPortfolioBootstrap} openPlanning={() => setPage('planning')} localRole={onboarding?.profile?.role} entryTab="planning" />}{page === 'business-stories' && <InitiativeStudio data={data} editor={editor} setEditor={setEditor} saveEditor={saveEditor} downloadFile={downloadFile} action={action} reload={reload} bootstrapPortfolio={acceptPortfolioBootstrap} openPlanning={() => setPage('planning')} localRole={onboarding?.profile?.role} entryTab="publish" />}{page === 'initiatives' && <InitiativeStudio data={data} editor={editor} setEditor={setEditor} saveEditor={saveEditor} downloadFile={downloadFile} action={action} reload={reload} bootstrapPortfolio={acceptPortfolioBootstrap} openPlanning={() => setPage('planning')} localRole={onboarding?.profile?.role} />}{page === 'dashboard' && <Dashboard data={data} />}{page === 'studio' && <ArtifactStudio data={data} openWorkspace={() => openRequirementWorkspace()} openDocument={openRequirementWorkspace} />}{page === 'impact' && <ImpactStudio data={data} openPlanning={() => setPage('planning')} />}{page === 'workspaces' && <WorkspaceStudio data={data} action={action} defaultBaseDirectory={data.workspaceSetup?.baseDirectory ?? onboarding?.profile?.workspacePath ?? ''} recentWorkspaces={recentWorkspaces} onOpenWorkspace={openWorkspace} onForgetWorkspace={forgetWorkspace} onOpened={(result, nextPage) => { acceptOpened(result, nextPage); void refreshRecentWorkspaces(); }} />}{page === 'planning' && <PlanningStudio data={data} action={action} reload={reload} openPlanningPrompt={openPlanningPrompt} profileRole={onboarding?.profile?.role} />}{page === 'inbox' && <ApprovalInbox data={data} busy={busy} refresh={refreshInbox} attach={attachInboxItem} />}{page === 'workflow' && <Workflow data={data} editor={editor} setEditor={setEditor} saveEditor={saveEditor} downloadFile={downloadFile} importWorkflow={importWorkflow} />}{page === 'personas' && <Personas data={data} openPrompt={openPrompt} savePersona={savePersona} createPersonaConfig={createPersonaConfig} deletePersonaConfig={deletePersonaConfig} downloadFile={downloadFile} />}{page === 'templates' && <Templates data={data} editor={editor.kind !== 'template' ? { path: data.templates[0]?.path, content: data.templates[0]?.content ?? '', original: data.templates[0]?.content ?? '', kind: 'template' } : editor} setEditor={setEditor} chooseTemplate={chooseTemplate} saveEditor={saveEditor} createTemplate={createTemplate} deleteTemplate={deleteTemplate} downloadFile={downloadFile} importTemplate={importTemplate} />}{page === 'resources' && <Resources data={data} editor={editor} setEditor={setEditor} chooseResource={chooseResource} saveEditor={saveEditor} createSkill={createSkill} deleteFile={deleteFile} downloadFile={downloadFile} importResource={importResource} materializeWorldModelPrompt={materializeWorldModelPrompt} materializePlanningPrompt={materializePlanningPrompt} />}{page === 'agents' && <Agents data={data} editor={editor} setEditor={setEditor} chooseAgent={chooseAgent} saveEditor={saveEditor} createAgent={createAgent} deleteFile={deleteFile} downloadFile={downloadFile} importAgent={importAgent} />}{page === 'world-model' && <WorldModel data={data} editor={editor} setEditor={setEditor} saveEditor={saveEditor} downloadFile={downloadFile} importResource={importResource} materializeWorldModelPrompt={materializeWorldModelPrompt} addView={addWorldModelViewConfig} removeView={removeWorldModelViewConfig} />}{page === 'review' && <Review data={data} downloadFile={downloadFile} />}{page === 'documents' && <Documents data={data} action={action} reload={reload} downloadFile={downloadFile} focusDocumentId={focusedDocumentId} />}{page === 'help' && <Help />}</div></div>
    </main>{jiraSetupOpen && <div className="jira-setup-overlay" role="dialog" aria-modal="true" aria-label="Set up Jira"><JiraWorkspace data={data} action={action} reload={reload} bootstrapPortfolio={acceptPortfolioBootstrap} onConfigure={() => { setJiraSetupOpen(false); initiativePage(); }} onDone={() => setJiraSetupOpen(false)} /></div>}<Toast toast={toast} onClose={() => setToast(null)} />
  </div>;
}
